import { randomUUID } from "node:crypto";

import type { EventStreamItem, EventStreamPage, EventStreamQuery } from "./event-stream.js";

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

interface PositionCursor {
  readonly version: 2;
  readonly generation: string;
  readonly position: number;
}
interface LegacyCursor {
  readonly timestamp: string;
  readonly id: string;
}

function decodeCursor(value: string): PositionCursor | LegacyCursor {
  try {
    if (!value.startsWith("cursor_")) throw new Error();
    const encoded = value.slice(7);
    if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new Error();
    const decoded: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (decoded === null || typeof decoded !== "object") throw new Error();
    if (
      "version" in decoded &&
      decoded.version === 2 &&
      "generation" in decoded &&
      typeof decoded.generation === "string" &&
      "position" in decoded &&
      typeof decoded.position === "number" &&
      Number.isSafeInteger(decoded.position) &&
      decoded.position >= 0
    ) {
      return decoded as PositionCursor;
    }
    if (
      !("version" in decoded) &&
      "timestamp" in decoded &&
      typeof decoded.timestamp === "string" &&
      "id" in decoded &&
      typeof decoded.id === "string"
    )
      return decoded as LegacyCursor;
    throw new Error();
  } catch {
    throw new EventStreamError("invalid_cursor", "invalid event stream cursor");
  }
}

function matches(item: EventStreamItem, query: EventStreamQuery): boolean {
  return (
    (query.iterationId === undefined || item.event.iteration_id === query.iterationId) &&
    (query.workflowOperationId === undefined ||
      item.event.workflow_operation_id === query.workflowOperationId) &&
    (query.eventTypes === undefined || query.eventTypes.includes(item.event.event_type))
  );
}

/** Delivery position is separate from the business timestamp. Private to the reader. */
export class EventIndex {
  private generation = randomUUID();
  private entries: (EventStreamItem | undefined)[] = [];
  private positions = new Map<string, number>();

  reset(): void {
    this.generation = randomUUID();
    this.entries = [];
    this.positions.clear();
  }

  get headCursor(): string {
    return this.cursorAt(this.entries.length);
  }

  private cursorAt(position: number): string {
    return `cursor_${Buffer.from(JSON.stringify({ version: 2, generation: this.generation, position })).toString("base64url")}`;
  }

  add(items: readonly EventStreamItem[]): void {
    for (const item of items) {
      if (this.positions.has(item.id)) continue;
      this.entries.push(item);
      this.positions.set(item.id, this.entries.length);
    }
  }

  remove(id: string): void {
    const position = this.positions.get(id);
    if (position !== undefined) this.entries[position - 1] = undefined;
    // Keep the position as a valid resume anchor after live -> ledger promotion.
  }

  read(query: EventStreamQuery = {}, capturedHead = this.headCursor): EventStreamPage {
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new EventStreamError(
        "invalid_query",
        "event stream limit must be an integer in 1..500",
      );
    }
    const head = decodeCursor(capturedHead);
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    const until = query.untilCursor === undefined ? head : decodeCursor(query.untilCursor);
    const valid = (cursor: PositionCursor | LegacyCursor): cursor is PositionCursor =>
      "version" in cursor &&
      cursor.generation === this.generation &&
      cursor.position <= this.entries.length;
    if (!valid(head) || !valid(until) || (after !== undefined && !valid(after))) {
      const { cursor: _cursor, untilCursor: _until, ...filters } = query;
      void _cursor;
      void _until;
      return { ...this.read(filters), reset: true };
    }
    const upper = Math.min(until.position, head.position);
    const items: EventStreamItem[] = [];
    const itemCursors: string[] = [];
    let hasMore = false;
    for (let index = after?.position ?? 0; index < upper; index += 1) {
      const item = this.entries[index];
      if (item === undefined || !matches(item, query)) continue;
      if (items.length === limit) {
        hasMore = true;
        break;
      }
      items.push(item);
      itemCursors.push(this.cursorAt(index + 1));
    }
    const cursor = itemCursors.at(-1);
    return {
      items,
      itemCursors,
      headCursor: capturedHead,
      ...(cursor === undefined ? {} : { cursor }),
      ...(hasMore && cursor !== undefined ? { nextCursor: cursor } : {}),
    };
  }
}
