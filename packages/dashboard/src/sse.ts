import type { EventStreamItem, EventStreamPort } from "@universal-harness-internal/runtime";

import type { EventStreamHubInterface, HubDelivery } from "./event-hub.js";
import { presentApproval, presentEvent, presentationMap } from "./presentation.js";
import { DASHBOARD_SECURITY_HEADERS } from "./problem.js";

const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

export interface SseResponse {
  statusCode: number;
  setHeader(name: string, value: string | number): void;
  flushHeaders?(): void;
  write(chunk: string): boolean;
  end(): void;
  once(event: "drain", listener: () => void): unknown;
  off(event: "drain", listener: () => void): unknown;
}

export interface StreamDashboardEventsOptions {
  readonly response: SseResponse;
  /** Legacy injected-Adapter path; ignored when eventHub is provided. */
  readonly eventStream?: EventStreamPort;
  /** Bounded shared fanout path; takes precedence over eventStream. */
  readonly eventHub?: EventStreamHubInterface;
  readonly cursor?: string;
  readonly iterationId?: string;
  readonly workflowOperationId?: string;
  readonly signal: AbortSignal;
  readonly heartbeatMs?: number;
  readonly pollIntervalMs?: number;
  /** Slow-socket budget for the Hub path; the connection closes afterwards. */
  readonly drainTimeoutMs?: number;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

function positive(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function defaultWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function drain(response: SseResponse, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    function done(): void {
      response.off("drain", done);
      signal.removeEventListener("abort", done);
      resolve();
    }
    response.once("drain", done);
    signal.addEventListener("abort", done, { once: true });
  });
}

async function abortableWait(
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>,
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  let onAbort!: () => void;
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([wait(milliseconds, signal), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function write(response: SseResponse, signal: AbortSignal, frame: string): Promise<void> {
  if (signal.aborted) return;
  if (!response.write(frame)) await drain(response, signal);
}

/** Hub-path write: returns false when the socket cannot drain in budget. */
async function writeBounded(
  response: SseResponse,
  signal: AbortSignal,
  frame: string,
  drainTimeoutMs: number,
): Promise<boolean> {
  if (signal.aborted) return false;
  if (response.write(frame)) return true;
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => done(false), drainTimeoutMs);
    function done(result: boolean): void {
      clearTimeout(timer);
      response.off("drain", onDrained);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    }
    function onDrained(): void {
      done(true);
    }
    function onAbort(): void {
      done(false);
    }
    response.once("drain", onDrained);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function eventFrame(item: EventStreamItem, cursor: string): string {
  const presentations = [presentEvent(item)];
  if (
    item.event.event_type === "ApprovalRequired" &&
    typeof item.event.payload === "object" &&
    item.event.payload !== null
  ) {
    presentations.push(presentApproval(item.event.payload));
  }
  return `id: ${cursor}\nevent: ${item.event.event_type}\ndata: ${JSON.stringify({
    ...item,
    presentations: presentationMap(presentations),
  })}\n\n`;
}

const RESET_FRAME = `event: stream_reset\ndata: ${JSON.stringify({ reason: "cursor_evicted" })}\n\n`;
const ERROR_FRAME = `event: stream_error\ndata: ${JSON.stringify({ code: "event_stream_unavailable" })}\n\n`;
const HEARTBEAT_FRAME = ": heartbeat\n\n";

/**
 * Hub path: deliveries arrive from the shared bounded fanout. The heartbeat
 * timer is per connection and never waits for data; a socket that cannot
 * drain within the budget is closed without touching other subscribers.
 */
async function streamHubEvents(
  options: StreamDashboardEventsOptions,
  heartbeatMs: number,
  drainTimeoutMs: number,
): Promise<void> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? defaultWait;
  const { response, signal } = options;
  const subscription = options.eventHub!.subscribeClient({
    signal,
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    ...(options.iterationId === undefined ? {} : { iterationId: options.iterationId }),
    ...(options.workflowOperationId === undefined
      ? {}
      : { workflowOperationId: options.workflowOperationId }),
  });
  const iterator = subscription[Symbol.asyncIterator]();
  let pending: Promise<IteratorResult<HubDelivery>> | undefined;
  let lastWrite = now();
  try {
    while (!signal.aborted) {
      pending ??= iterator.next();
      const remaining = Math.max(1, heartbeatMs - (now() - lastWrite));
      const outcome = await Promise.race([
        pending.then((result) => ({ result })),
        abortableWait(wait, remaining, signal).then(() => undefined),
      ]);
      if (outcome === undefined) {
        if (signal.aborted) return;
        if (!(await writeBounded(response, signal, HEARTBEAT_FRAME, drainTimeoutMs))) return;
        lastWrite = now();
        continue;
      }
      pending = undefined;
      if (outcome.result.done === true) return;
      const delivery = outcome.result.value;
      if (delivery.kind === "reset") {
        await writeBounded(response, signal, RESET_FRAME, drainTimeoutMs);
        return;
      }
      if (delivery.kind === "error") {
        await writeBounded(response, signal, ERROR_FRAME, drainTimeoutMs);
        return;
      }
      if (
        !(await writeBounded(
          response,
          signal,
          eventFrame(delivery.item, delivery.cursor),
          drainTimeoutMs,
        ))
      )
        return;
      lastWrite = now();
    }
  } finally {
    await iterator.return?.();
  }
}

/**
 * Stream the unified EventStreamPort as resumable SSE. Reading one item per
 * cursor step makes every emitted SSE id an exact restart point.
 */
export async function streamDashboardEvents(options: StreamDashboardEventsOptions): Promise<void> {
  const heartbeatMs = positive(options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS, "heartbeatMs");
  const pollIntervalMs = positive(
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    "pollIntervalMs",
  );
  const drainTimeoutMs = positive(
    options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
    "drainTimeoutMs",
  );
  const now = options.now ?? Date.now;
  const wait = options.wait ?? defaultWait;
  let cursor = options.cursor;
  let lastWrite = now();
  const { response } = options;
  response.statusCode = 200;
  for (const [name, value] of Object.entries(DASHBOARD_SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("connection", "keep-alive");
  response.flushHeaders?.();
  try {
    if (options.eventHub !== undefined) {
      await streamHubEvents(options, heartbeatMs, drainTimeoutMs);
      return;
    }
    const eventStream = options.eventStream;
    if (eventStream === undefined) {
      throw new Error("streamDashboardEvents requires an eventStream or an eventHub");
    }
    while (!options.signal.aborted) {
      const page = await eventStream.read({
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
        ...(options.iterationId === undefined ? {} : { iterationId: options.iterationId }),
        ...(options.workflowOperationId === undefined
          ? {}
          : { workflowOperationId: options.workflowOperationId }),
      });
      if (page.reset === true) {
        await write(
          response,
          options.signal,
          `event: stream_reset\ndata: ${JSON.stringify({ reason: "cursor_evicted" })}\n\n`,
        );
        return;
      }
      const next = page.items[0];
      if (next !== undefined && page.cursor !== undefined) {
        cursor = page.cursor;
        await write(response, options.signal, eventFrame(next, cursor));
        lastWrite = now();
        // Yield to the socket and disconnect handlers before scanning the
        // next page. Without this fairness point a large historical stream
        // can monopolize the microtask queue until TCP backpressure engages,
        // delaying the client's first visible frame and abort signal.
        await abortableWait(wait, 1, options.signal);
        continue;
      }
      if (now() - lastWrite >= heartbeatMs) {
        await write(response, options.signal, ": heartbeat\n\n");
        lastWrite = now();
      }
      await abortableWait(wait, pollIntervalMs, options.signal);
    }
  } catch {
    if (!options.signal.aborted) {
      await write(
        response,
        options.signal,
        `event: stream_error\ndata: ${JSON.stringify({ code: "event_stream_unavailable" })}\n\n`,
      );
    }
  } finally {
    response.end();
  }
}
