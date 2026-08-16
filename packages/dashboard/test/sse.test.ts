import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import type {
  EventStreamItem,
  EventStreamPage,
  EventStreamPort,
  EventStreamQuery,
} from "@universal-harness-internal/runtime";

import { streamDashboardEvents, type SseResponse } from "../src/sse.js";

function item(sequence: number, eventType = "RunHeartbeat"): EventStreamItem {
  return {
    id: `live:stream_01:${String(sequence)}`,
    source: "live",
    authoritative: false,
    event: {
      stream_version: 1,
      stream_id: "stream_01",
      sequence,
      observation_key: `observation_${String(sequence)}`,
      event_type: eventType as "RunHeartbeat",
      project_id: "project_01",
      iteration_id: "iteration_01",
      workflow_operation_id: "workflow_01",
      timestamp: `2026-08-16T00:00:0${String(sequence)}.000Z`,
      payload: { run_id: "run_01" },
    },
  };
}

class ResponseDouble extends EventEmitter implements SseResponse {
  readonly headers = new Map<string, string>();
  readonly writes: string[] = [];
  statusCode = 0;
  ended = false;
  backpressure = false;

  setHeader(name: string, value: string | number): void {
    this.headers.set(name.toLowerCase(), String(value));
  }

  flushHeaders(): void {}

  write(chunk: string): boolean {
    this.writes.push(chunk);
    this.emit("write", chunk);
    if (this.backpressure) {
      this.backpressure = false;
      return false;
    }
    return true;
  }

  end(): void {
    this.ended = true;
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Dashboard SSE", () => {
  it("resumes from Last-Event-ID and waits for drain before reading another item", async () => {
    const queries: EventStreamQuery[] = [];
    const abort = new AbortController();
    const response = new ResponseDouble();
    response.backpressure = true;
    let reads = 0;
    const port: EventStreamPort = {
      read: (query = {}) => {
        queries.push(query);
        reads += 1;
        if (reads === 1) return Promise.resolve({ items: [item(2)], cursor: "cursor_02" });
        abort.abort();
        return Promise.resolve({ items: [] });
      },
      subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }),
    };

    const running = streamDashboardEvents({
      response,
      eventStream: port,
      cursor: "cursor_01",
      signal: abort.signal,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(reads).toBe(1);
    expect(response.writes.join("")).toContain("id: cursor_02");
    expect(response.writes.join("")).toContain("event: RunHeartbeat");
    response.emit("drain");
    await running;

    expect(queries[0]).toMatchObject({ cursor: "cursor_01", limit: 1 });
    expect(queries[1]).toMatchObject({ cursor: "cursor_02", limit: 1 });
    expect(response.ended).toBe(true);
  });

  it("emits a stream_reset control event and closes when a live cursor was rotated", async () => {
    const response = new ResponseDouble();
    const port: EventStreamPort = {
      read: () => Promise.resolve({ items: [item(1)], cursor: "cursor_new", reset: true }),
      subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }),
    };

    await streamDashboardEvents({
      response,
      eventStream: port,
      cursor: "cursor_evicted",
      signal: new AbortController().signal,
    });

    expect(response.writes.join("")).toContain("event: stream_reset");
    expect(response.writes.join("")).toContain('"reason":"cursor_evicted"');
    expect(response.ended).toBe(true);
  });

  it("sends heartbeat comments while idle and cleans up immediately on disconnect", async () => {
    const response = new ResponseDouble();
    const abort = new AbortController();
    const waits: ReturnType<typeof deferred>[] = [];
    let now = 0;
    const port: EventStreamPort = {
      read: () => Promise.resolve({ items: [] } satisfies EventStreamPage),
      subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }),
    };
    const heartbeatWritten = new Promise<void>((resolve) => {
      response.once("write", () => resolve());
    });
    const running = streamDashboardEvents({
      response,
      eventStream: port,
      signal: abort.signal,
      heartbeatMs: 10,
      pollIntervalMs: 5,
      now: () => now,
      wait: () => {
        const pending = deferred();
        waits.push(pending);
        return pending.promise;
      },
    });
    await Promise.resolve();
    now = 10;
    waits.shift()?.resolve();
    await heartbeatWritten;
    expect(response.writes).toContain(": heartbeat\n\n");

    abort.abort();
    waits.shift()?.resolve();
    await running;
    expect(response.ended).toBe(true);
  });
});
