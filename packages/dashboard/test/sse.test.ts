import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import type {
  EventStreamItem,
  EventStreamPage,
  EventStreamPort,
  EventStreamQuery,
} from "@universal-harness-internal/runtime";

import type { HubDelivery } from "../src/event-hub.js";
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
    const dataLine = response.writes.join("").match(/^data: (.+)$/mu)?.[1];
    if (dataLine === undefined) throw new Error("SSE data frame missing");
    const frame = JSON.parse(dataLine) as {
      id: string;
      event: { event_type: string };
      presentations: Record<string, unknown>;
    };
    expect(frame).toMatchObject({
      id: "live:stream_01:2",
      event: { event_type: "RunHeartbeat" },
    });
    expect(frame.presentations["live:stream_01:2@live"]).toMatchObject({
      entity_id: "live:stream_01:2",
      binding_digest: null,
      technical_type: "RunHeartbeat",
    });
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

  it("adds a digest-bound Approval presentation without changing the event payload", async () => {
    const digest = "a".repeat(64);
    const approval = item(1, "ApprovalRequired");
    const approvalItem = {
      ...approval,
      event: {
        ...approval.event,
        event_type: "ApprovalRequired" as const,
        payload: {
          request_id: "approval_request_01",
          object_id: "impact_set_01",
          object_type: "ImpactSet",
          object_digest: digest,
          reason: "确认影响范围。",
          risk: "high",
          allowed_decisions: ["approve", "reject", "defer"],
        },
      },
    };
    const response = new ResponseDouble();
    const abort = new AbortController();
    let reads = 0;
    const port: EventStreamPort = {
      read: () => {
        reads += 1;
        if (reads === 1) return Promise.resolve({ items: [approvalItem], cursor: "cursor_01" });
        abort.abort();
        return Promise.resolve({ items: [] });
      },
      subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }),
    };

    await streamDashboardEvents({ response, eventStream: port, signal: abort.signal });
    const dataLine = response.writes.join("").match(/^data: (.+)$/mu)?.[1];
    if (dataLine === undefined) throw new Error("Approval SSE data frame missing");
    const frame = JSON.parse(dataLine) as {
      event: { payload: { object_digest: string } };
      presentations: Record<string, unknown>;
    };

    expect(frame.event.payload.object_digest).toBe(digest);
    expect(frame.presentations[`approval_request_01@${digest}`]).toMatchObject({
      entity_id: "approval_request_01",
      binding_digest: digest,
      title_zh: "批准影响范围",
      technical_type: "ImpactSet",
    });
    expect(frame.presentations["live:stream_01:1@live"]).toMatchObject({
      technical_type: "ApprovalRequired",
    });
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

/** Controllable in-memory Hub double; deliveries are pushed by the test. */
class HubDouble {
  readonly subscriptions: {
    cursor?: string;
    iterationId?: string;
    workflowOperationId?: string;
  }[] = [];
  private readonly queues: ((result: IteratorResult<HubDelivery>) => void)[] = [];

  subscribeClient(options: {
    cursor?: string;
    iterationId?: string;
    workflowOperationId?: string;
    signal: AbortSignal;
  }): AsyncIterable<HubDelivery> {
    this.subscriptions.push({
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      ...(options.iterationId === undefined ? {} : { iterationId: options.iterationId }),
      ...(options.workflowOperationId === undefined
        ? {}
        : { workflowOperationId: options.workflowOperationId }),
    });
    const pending: HubDelivery[] = [];
    const waiters: ((result: IteratorResult<HubDelivery>) => void)[] = [];
    this.queues.push((result) => {
      if (result.done === true) {
        while (waiters.length > 0) waiters.shift()!({ done: true, value: undefined });
        return;
      }
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter(result);
      else pending.push(result.value);
    });
    options.signal.addEventListener("abort", () => {
      while (waiters.length > 0) waiters.shift()!({ done: true, value: undefined });
    });
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const queued = pending.shift();
          if (queued !== undefined) return Promise.resolve({ done: false, value: queued });
          return new Promise<IteratorResult<HubDelivery>>((resolve) => waiters.push(resolve));
        },
      }),
    };
  }

  push(delivery: HubDelivery): void {
    for (const enqueue of this.queues) enqueue({ done: false, value: delivery });
  }

  finish(): void {
    for (const enqueue of this.queues) enqueue({ done: true, value: undefined });
  }
}

describe("Dashboard SSE over the shared EventStreamHub", () => {
  it("renders Hub item deliveries with the legacy frame shape and per-item cursors", async () => {
    const hub = new HubDouble();
    const response = new ResponseDouble();
    const abort = new AbortController();
    const running = streamDashboardEvents({
      response,
      eventHub: hub,
      cursor: "cursor_00",
      workflowOperationId: "workflow_01",
      signal: abort.signal,
    });
    await Promise.resolve();
    expect(hub.subscriptions).toEqual([
      { cursor: "cursor_00", workflowOperationId: "workflow_01" },
    ]);

    hub.push({ kind: "item", item: item(1), cursor: "cursor_01" });
    hub.push({ kind: "item", item: item(2), cursor: "cursor_02" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const body = response.writes.join("");
    expect(body).toContain("id: cursor_01\nevent: RunHeartbeat\n");
    expect(body).toContain("id: cursor_02\nevent: RunHeartbeat\n");
    const dataLines = [...body.matchAll(/^data: (.+)$/gmu)].map((match) => match[1]);
    expect(dataLines.map((line) => (JSON.parse(line ?? "{}") as { id: string }).id)).toEqual([
      "live:stream_01:1",
      "live:stream_01:2",
    ]);

    abort.abort();
    hub.finish();
    await running;
    expect(response.ended).toBe(true);
  });

  it("writes the exact stream_reset frame for Hub reset deliveries and closes", async () => {
    const hub = new HubDouble();
    const response = new ResponseDouble();
    const running = streamDashboardEvents({
      response,
      eventHub: hub,
      signal: new AbortController().signal,
    });
    await Promise.resolve();
    hub.push({ kind: "reset", reason: "cursor_evicted" });
    await running;
    expect(response.writes).toContain(
      `event: stream_reset\ndata: ${JSON.stringify({ reason: "cursor_evicted" })}\n\n`,
    );
    expect(response.ended).toBe(true);
  });

  it("writes the exact stream_error frame for Hub error deliveries and closes", async () => {
    const hub = new HubDouble();
    const response = new ResponseDouble();
    const running = streamDashboardEvents({
      response,
      eventHub: hub,
      signal: new AbortController().signal,
    });
    await Promise.resolve();
    hub.push({ kind: "error", code: "event_stream_unavailable" });
    await running;
    expect(response.writes).toContain(
      `event: stream_error\ndata: ${JSON.stringify({ code: "event_stream_unavailable" })}\n\n`,
    );
    expect(response.ended).toBe(true);
  });

  it("sends heartbeat comments while a Hub subscription stays idle", async () => {
    const hub = new HubDouble();
    const response = new ResponseDouble();
    const abort = new AbortController();
    const waits: ReturnType<typeof deferred>[] = [];
    let now = 0;
    const heartbeatWritten = new Promise<void>((resolve) => {
      response.once("write", () => resolve());
    });
    const running = streamDashboardEvents({
      response,
      eventHub: hub,
      signal: abort.signal,
      heartbeatMs: 10,
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
    hub.finish();
    await running;
    expect(response.ended).toBe(true);
  });

  it("closes a socket that never drains after the drain budget while other clients continue", async () => {
    const hub = new HubDouble();
    const slow = new ResponseDouble();
    const fast = new ResponseDouble();
    const abort = new AbortController();
    // The slow socket accepts one frame into its kernel buffer and then applies
    // permanent backpressure without ever emitting drain.
    slow.backpressure = true;
    const slowDone = streamDashboardEvents({
      response: slow,
      eventHub: hub,
      signal: abort.signal,
      drainTimeoutMs: 30,
    });
    const fastDone = streamDashboardEvents({
      response: fast,
      eventHub: hub,
      signal: abort.signal,
      drainTimeoutMs: 30,
    });
    await Promise.resolve();
    hub.push({ kind: "item", item: item(1), cursor: "cursor_01" });
    hub.push({ kind: "item", item: item(2), cursor: "cursor_02" });
    await slowDone;
    expect(slow.ended).toBe(true);
    expect(fast.ended).toBe(false);

    hub.push({ kind: "item", item: item(3), cursor: "cursor_03" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fast.writes.join("")).toContain("id: cursor_03");
    abort.abort();
    hub.finish();
    await fastDone;
    expect(fast.ended).toBe(true);
  });

  it("never delivers an oversize business frame; it sends a bounded stream_error and closes", async () => {
    const response = new ResponseDouble();
    const oversize = item(1, "RunOutputSummary");
    (oversize.event as { payload: Record<string, unknown> }).payload = {
      run_id: "run_01",
      summary: "长".repeat(40 * 1024),
    };
    const port: EventStreamPort = {
      read: () => Promise.resolve({ items: [oversize], cursor: "cursor_big" }),
      subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }),
    };

    await streamDashboardEvents({
      response,
      eventStream: port,
      signal: new AbortController().signal,
    });

    const output = response.writes.join("");
    expect(output).not.toContain("event: RunOutputSummary");
    expect(output).toContain('event: stream_error\ndata: {"code":"event_frame_too_large"}');
    expect(response.ended).toBe(true);
  });

  it("applies the same frame guard on the Hub fanout path", async () => {
    const hub = new HubDouble();
    const response = new ResponseDouble();
    const abort = new AbortController();
    const oversize = item(1, "RunOutputSummary");
    (oversize.event as { payload: Record<string, unknown> }).payload = {
      run_id: "run_01",
      summary: "长".repeat(40 * 1024),
    };

    const running = streamDashboardEvents({
      response,
      eventHub: hub,
      signal: abort.signal,
    });
    await Promise.resolve();
    hub.push({ kind: "item", item: oversize, cursor: "cursor_big" });
    await running;

    const output = response.writes.join("");
    expect(output).not.toContain("event: RunOutputSummary");
    expect(output).toContain('event: stream_error\ndata: {"code":"event_frame_too_large"}');
    expect(response.ended).toBe(true);
  });
});

describe("Dashboard SSE artifact links and frame guardrails (spec §9.3/§10)", () => {
  const link = (seed: number) => ({
    label_zh: "查看对应版本产出",
    ref: {
      kind: "approval_decision" as const,
      scope: "artifact" as const,
      digest: `${String(seed).padStart(2, "0")}${"f".repeat(62)}`,
    },
    href: `/api/v1/artifacts/${String(seed).padStart(2, "0")}${"f".repeat(62)}?kind=approval_decision&scope=artifact`,
  });

  const singlePagePort = (entry: EventStreamItem): EventStreamPort => ({
    read: () => Promise.resolve({ items: [entry], cursor: "cursor_link" }),
    subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }),
  });

  it("merges resolved artifact links into the event frame presentation", async () => {
    const response = new ResponseDouble();
    const abort = new AbortController();
    // The port re-serves the same page forever; stop after the first frame.
    response.once("write", () => abort.abort());
    const entry = item(1, "ApprovalDecided");
    const links = [link(1), link(2)];

    await streamDashboardEvents({
      response,
      eventStream: singlePagePort(entry),
      signal: abort.signal,
      artifactLinks: () => links,
      pollIntervalMs: 5,
      heartbeatMs: 5,
    });

    const output = response.writes.join("");
    expect(output).toContain("event: ApprovalDecided");
    expect(output).toContain(links[0]!.href);
    expect(output).toContain(links[1]!.href);
    expect(output).toContain("查看对应版本产出");
  });

  it("a failing link resolver never breaks event delivery", async () => {
    const response = new ResponseDouble();
    const abort = new AbortController();
    response.once("write", () => abort.abort());
    await streamDashboardEvents({
      response,
      eventStream: singlePagePort(item(1)),
      signal: abort.signal,
      artifactLinks: () => {
        throw new Error("ledger unavailable");
      },
      pollIntervalMs: 5,
      heartbeatMs: 5,
    });
    const output = response.writes.join("");
    expect(output).toContain("event: RunHeartbeat");
    expect(output).not.toContain("artifact_links");
  });

  it("fails closed with one bounded stream_error when links push the frame over 32 KiB", async () => {
    const response = new ResponseDouble();
    const entry = item(1, "ApprovalDecided");
    // Eight maximally long link labels push the serialized frame past the
    // 32 KiB guard; the business frame must never be partially written.
    const oversizedLinks = Array.from({ length: 8 }, (_, index) => ({
      ...link(index + 1),
      label_zh: `查看对应版本产出${"长".repeat(1500)}`,
    }));

    await streamDashboardEvents({
      response,
      eventStream: singlePagePort(entry),
      signal: new AbortController().signal,
      artifactLinks: () => oversizedLinks,
    });

    const output = response.writes.join("");
    expect(output).not.toContain("event: ApprovalDecided");
    expect(output).toContain('event: stream_error\ndata: {"code":"event_frame_too_large"}');
    expect(response.ended).toBe(true);
  });

  it("keeps Chinese/emoji frames byte-safe at the 32 KiB boundary", async () => {
    let delivered = 0;
    let rejected = 0;
    for (const length of [2500, 2900, 3400, 4000]) {
      const response = new ResponseDouble();
      const abort = new AbortController();
      // Delivered frames loop forever on the static port; stop after the
      // first write. The oversize path closes on its own.
      response.once("write", () => abort.abort());
      const entry = item(1, "RunOutputSummary");
      (entry.event as { payload: Record<string, unknown> }).payload = {
        run_id: "run_01",
        summary: "摘要🔧".repeat(length),
      };

      await streamDashboardEvents({
        response,
        eventStream: singlePagePort(entry),
        signal: abort.signal,
      });

      const output = response.writes.join("");
      const businessFrame = response.writes.find((frame) =>
        frame.includes("event: RunOutputSummary"),
      );
      if (businessFrame === undefined) {
        // Over the limit: exactly one bounded error frame, no partial frame.
        rejected += 1;
        expect(output).toContain('event: stream_error\ndata: {"code":"event_frame_too_large"}');
        expect(output).not.toContain("摘要🔧");
      } else {
        // Under the limit: the complete frame lands within the byte budget.
        delivered += 1;
        expect(Buffer.byteLength(businessFrame, "utf8")).toBeLessThanOrEqual(32 * 1024);
        expect(businessFrame.endsWith("\n\n")).toBe(true);
        expect(businessFrame).toContain("摘要🔧");
      }
      expect(response.ended).toBe(true);
    }
    // The sweep must actually straddle the boundary.
    expect(delivered).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
  });

  it("delivers nothing further after the oversize guard closes the stream", async () => {
    const response = new ResponseDouble();
    const oversize = item(1, "RunOutputSummary");
    (oversize.event as { payload: Record<string, unknown> }).payload = {
      run_id: "run_01",
      summary: "长".repeat(40 * 1024),
    };
    let reads = 0;
    const port: EventStreamPort = {
      read: () => {
        reads += 1;
        return Promise.resolve({ items: [oversize], cursor: "cursor_big" });
      },
      subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }),
    };

    await streamDashboardEvents({
      response,
      eventStream: port,
      signal: new AbortController().signal,
    });

    expect(reads).toBe(1);
    expect(response.writes).toHaveLength(1);
    expect(response.writes[0]).toContain("event_frame_too_large");
    expect(response.ended).toBe(true);
  });
});
