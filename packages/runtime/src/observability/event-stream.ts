import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  validateSchema,
  type LifecycleEvent,
  type ObservationEvent,
} from "@universal-harness-internal/core";

export interface EventStreamQuery {
  readonly limit?: number;
  readonly cursor?: string;
  readonly iterationId?: string;
  readonly workflowOperationId?: string;
  readonly eventTypes?: readonly (LifecycleEvent["event_type"] | ObservationEvent["event_type"])[];
}

export interface EventStreamItem {
  readonly id: string;
  readonly source: "ledger" | "live";
  readonly authoritative: boolean;
  readonly event: LifecycleEvent | ObservationEvent;
}

export interface EventStreamPage {
  readonly items: readonly EventStreamItem[];
  /** Cursor after the last returned item, even when the page has no successor. */
  readonly cursor?: string;
  readonly nextCursor?: string;
  readonly reset?: true;
}

export interface EventStreamPort {
  read(query?: EventStreamQuery): Promise<EventStreamPage>;
  subscribe(query?: EventStreamQuery): AsyncIterable<EventStreamItem>;
}

export interface FileEventStreamOptions {
  readonly pollIntervalMs?: number;
}

export type EventStreamErrorKind = "invalid_cursor" | "invalid_query";

export class EventStreamError extends Error {
  constructor(
    readonly kind: EventStreamErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "EventStreamError";
  }
}

function jsonlFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".jsonl")) files.push(path);
    }
  };
  visit(root);
  return files.sort();
}

function records(paths: readonly string[]): unknown[] {
  const parsed: unknown[] = [];
  for (const path of paths) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line === "") continue;
      try {
        parsed.push(JSON.parse(line) as unknown);
      } catch {
        // An incomplete live tail is not observable until a later complete read.
      }
    }
  }
  return parsed;
}

function observationKeyOf(event: LifecycleEvent): string | undefined {
  const key = event.payload["observation_key"];
  return typeof key === "string" ? key : undefined;
}

function compareItems(left: EventStreamItem, right: EventStreamItem): number {
  if (left.event.timestamp !== right.event.timestamp) {
    return left.event.timestamp < right.event.timestamp ? -1 : 1;
  }
  if (
    "stream_id" in left.event &&
    "stream_id" in right.event &&
    left.event.stream_id === right.event.stream_id &&
    left.event.sequence !== right.event.sequence
  ) {
    return left.event.sequence - right.event.sequence;
  }
  if (
    "ledger_operation_id" in left.event &&
    "ledger_operation_id" in right.event &&
    left.event.workflow_operation_id === right.event.workflow_operation_id &&
    left.event.sequence !== right.event.sequence
  ) {
    return left.event.sequence - right.event.sequence;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

interface CursorValue {
  readonly timestamp: string;
  readonly id: string;
}

function encodeCursor(item: EventStreamItem): string {
  return `cursor_${Buffer.from(
    JSON.stringify({ timestamp: item.event.timestamp, id: item.id } satisfies CursorValue),
  ).toString("base64url")}`;
}

function decodeCursor(cursor: string): CursorValue {
  if (!cursor.startsWith("cursor_")) {
    throw new EventStreamError("invalid_cursor", "invalid event stream cursor");
  }
  try {
    const value = JSON.parse(
      Buffer.from(cursor.slice("cursor_".length), "base64url").toString(),
    ) as {
      timestamp?: unknown;
      id?: unknown;
    };
    if (typeof value.timestamp !== "string" || typeof value.id !== "string") {
      throw new Error("invalid cursor fields");
    }
    return { timestamp: value.timestamp, id: value.id };
  } catch {
    throw new EventStreamError("invalid_cursor", "invalid event stream cursor");
  }
}

function followsCursor(item: EventStreamItem, cursor: CursorValue): boolean {
  return (
    item.event.timestamp > cursor.timestamp ||
    (item.event.timestamp === cursor.timestamp && item.id > cursor.id)
  );
}

function matchesQuery(item: EventStreamItem, query: EventStreamQuery): boolean {
  if (query.iterationId !== undefined && item.event.iteration_id !== query.iterationId)
    return false;
  if (
    query.workflowOperationId !== undefined &&
    item.event.workflow_operation_id !== query.workflowOperationId
  ) {
    return false;
  }
  return (
    query.eventTypes === undefined ||
    query.eventTypes.some((eventType) => eventType === item.event.event_type)
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export class FileEventStream implements EventStreamPort {
  constructor(
    private readonly projectRoot: string,
    private readonly options: FileEventStreamOptions = {},
  ) {}

  async read(query: EventStreamQuery = {}): Promise<EventStreamPage> {
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new EventStreamError(
        "invalid_query",
        "event stream limit must be an integer in 1..500",
      );
    }

    const ledger = records(jsonlFiles(join(this.projectRoot, ".harness", "events")))
      .filter((record): record is LifecycleEvent => validateSchema("event", record).valid)
      .map((event): EventStreamItem => ({
        id: `ledger:${event.event_id}`,
        source: "ledger",
        authoritative: true,
        event,
      }));
    const authoritativeKeys = new Set(
      ledger
        .map((item) => observationKeyOf(item.event as LifecycleEvent))
        .filter((key): key is string => key !== undefined),
    );
    const live = records(jsonlFiles(join(this.projectRoot, ".harness", "cache", "event-stream")))
      .filter((record): record is ObservationEvent => validateSchema("observation", record).valid)
      .filter((event) => !authoritativeKeys.has(event.observation_key))
      .map((event): EventStreamItem => ({
        id: `live:${event.stream_id}:${String(event.sequence)}`,
        source: "live",
        authoritative: false,
        event,
      }));

    const all = [...live, ...ledger].sort(compareItems);
    const sorted = all.filter((item) => matchesQuery(item, query));
    const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    const reset =
      cursor?.id.startsWith("live:") === true && !all.some((item) => item.id === cursor.id);
    const remaining =
      cursor === undefined || reset ? sorted : sorted.filter((item) => followsCursor(item, cursor));
    const items = remaining.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      ...(last === undefined ? {} : { cursor: encodeCursor(last) }),
      ...(remaining.length > limit && last !== undefined ? { nextCursor: encodeCursor(last) } : {}),
      ...(reset ? { reset: true as const } : {}),
    };
  }

  async *subscribe(query: EventStreamQuery = {}): AsyncIterable<EventStreamItem> {
    const pollIntervalMs = this.options.pollIntervalMs ?? 250;
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) {
      throw new EventStreamError(
        "invalid_query",
        "event stream pollIntervalMs must be a positive integer",
      );
    }
    let cursor = query.cursor;
    while (true) {
      const page = await this.read({ ...query, ...(cursor === undefined ? {} : { cursor }) });
      for (const item of page.items) {
        cursor = encodeCursor(item);
        yield item;
      }
      await sleep(pollIntervalMs);
    }
  }
}
