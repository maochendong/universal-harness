import type { EventStreamItem, EventStreamPort } from "@universal-harness-internal/runtime";

import { DASHBOARD_SECURITY_HEADERS } from "./problem.js";

const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

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
  readonly eventStream: EventStreamPort;
  readonly cursor?: string;
  readonly iterationId?: string;
  readonly workflowOperationId?: string;
  readonly signal: AbortSignal;
  readonly heartbeatMs?: number;
  readonly pollIntervalMs?: number;
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

function eventFrame(item: EventStreamItem, cursor: string): string {
  return `id: ${cursor}\nevent: ${item.event.event_type}\ndata: ${JSON.stringify(item)}\n\n`;
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
    while (!options.signal.aborted) {
      const page = await options.eventStream.read({
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
