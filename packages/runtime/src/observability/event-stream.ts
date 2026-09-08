import { join } from "node:path";
import type { LifecycleEvent, ObservationEvent } from "@universal-harness-internal/core";
import { EventIndex, EventStreamError } from "./event-index.js";
import { EventFileCache } from "./event-file-cache.js";

export { EventStreamError, type EventStreamErrorKind } from "./event-index.js";

export interface EventStreamQuery {
  readonly limit?: number;
  readonly cursor?: string;
  readonly untilCursor?: string;
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
  readonly cursor?: string;
  readonly nextCursor?: string;
  readonly reset?: true;
  readonly itemCursors?: readonly string[];
  readonly headCursor?: string;
}
export interface EventStreamPort {
  read(query?: EventStreamQuery): Promise<EventStreamPage>;
  subscribe(query?: EventStreamQuery): AsyncIterable<EventStreamItem>;
}
export interface EventStreamReadView {
  readonly headCursor: string;
  read(query?: EventStreamQuery): EventStreamPage;
}
export interface FileEventStreamOptions {
  readonly pollIntervalMs?: number;
}
function observationKey(item: EventStreamItem): string | undefined {
  if (item.source === "live") return (item.event as ObservationEvent).observation_key;
  const key = item.event.payload["observation_key"];
  return typeof key === "string" ? key : undefined;
}
function compare(left: EventStreamItem, right: EventStreamItem): number {
  const identity = (item: EventStreamItem): string =>
    item.source === "live"
      ? (item.event as ObservationEvent).stream_id
      : item.event.workflow_operation_id;
  const strings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return (
    strings(left.event.timestamp, right.event.timestamp) ||
    strings(left.source, right.source) ||
    strings(identity(left), identity(right)) ||
    left.event.sequence - right.event.sequence ||
    strings(left.id, right.id)
  );
}

/** Validated source cache and delivery index are private; callers share one read view. */
export class FileEventStream implements EventStreamPort {
  private readonly index = new EventIndex();
  private readonly cache: EventFileCache;
  private previous = new Map<string, EventStreamItem>();

  constructor(
    projectRoot: string,
    private readonly options: FileEventStreamOptions = {},
  ) {
    this.cache = new EventFileCache(join(projectRoot, ".harness"));
  }

  async refreshView(): Promise<EventStreamReadView> {
    try {
      const snapshot = this.cache.refresh();
      if (snapshot !== undefined) {
        const ledger = snapshot.ledger.map((event): EventStreamItem => ({
          id: `ledger:${event.event_id}`,
          source: "ledger",
          authoritative: true,
          event,
        }));
        const keys = new Set(
          ledger.map(observationKey).filter((key): key is string => key !== undefined),
        );
        const live = snapshot.live
          .filter((event) => !keys.has(event.observation_key))
          .map((event): EventStreamItem => ({
            id: `live:${event.stream_id}:${String(event.sequence)}`,
            source: "live",
            authoritative: false,
            event,
          }));
        const all = [...ledger, ...live];
        const current = new Map(all.map((item) => [item.id, item]));
        let reset = snapshot.historyReplaced;
        for (const [id, item] of this.previous) {
          const replacement = current.get(id);
          if (replacement !== undefined) {
            if (
              replacement.event !== item.event &&
              JSON.stringify(replacement.event) !== JSON.stringify(item.event)
            )
              reset = true;
            continue;
          }
          if (item.source === "live" && keys.has(observationKey(item)!)) this.index.remove(id);
          else reset = true;
        }
        if (reset) this.index.reset();
        const additions = reset ? all : all.filter((item) => !this.previous.has(item.id));
        this.index.add(additions.sort(compare));
        this.previous = current;
      }
      const headCursor = this.index.headCursor;
      return { headCursor, read: (query = {}) => this.index.read(query, headCursor) };
    } catch (error) {
      this.cache.clear();
      this.index.reset();
      this.previous.clear();
      throw error;
    }
  }

  async read(query: EventStreamQuery = {}): Promise<EventStreamPage> {
    return (await this.refreshView()).read(query);
  }

  async *subscribe(query: EventStreamQuery = {}): AsyncIterable<EventStreamItem> {
    const interval = this.options.pollIntervalMs ?? 250;
    if (!Number.isInteger(interval) || interval < 1) {
      throw new EventStreamError(
        "invalid_query",
        "event stream pollIntervalMs must be a positive integer",
      );
    }
    const { cursor: initialCursor, ...filters } = query;
    let cursor = initialCursor;
    while (true) {
      const page = await this.read({ ...filters, ...(cursor === undefined ? {} : { cursor }) });
      if (page.reset) {
        cursor = undefined;
        delete filters.untilCursor;
        continue;
      }
      for (const [index, item] of page.items.entries()) {
        cursor = page.itemCursors?.[index] ?? page.cursor;
        yield item;
      }
      cursor = page.cursor ?? page.headCursor ?? cursor;
      await new Promise<void>((resolve) => setTimeout(resolve, interval));
    }
  }
}
