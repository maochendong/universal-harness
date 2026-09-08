import type {
  EventStreamItem,
  EventStreamQuery,
  EventStreamReadView,
} from "@universal-harness-internal/runtime";

/**
 * Bounded shared fanout for the Dashboard event stream (design §8). One Hub
 * per serve instance refreshes the source once per poll and replays that view
 * to every subscriber; clients never trigger their own source scans.
 */

export type HubDelivery =
  | { kind: "item"; item: EventStreamItem; cursor: string }
  | { kind: "reset"; reason: "cursor_evicted" }
  | { kind: "error"; code: "event_stream_unavailable" };

export interface HubSubscriptionOptions {
  readonly cursor?: string;
  readonly iterationId?: string;
  readonly workflowOperationId?: string;
  readonly eventTypes?: EventStreamQuery["eventTypes"];
  readonly signal: AbortSignal;
}

/** Minimal source contract; FileEventStream satisfies it structurally. */
export interface EventStreamSource {
  refreshView(): Promise<EventStreamReadView>;
}

export interface EventStreamHubInterface {
  subscribeClient(options: HubSubscriptionOptions): AsyncIterable<HubDelivery>;
  close(): Promise<void>;
}

export interface EventStreamHubOptions {
  readonly pollIntervalMs?: number;
  readonly maxBufferedItems?: number;
  readonly maxBufferedBytes?: number;
  /** Slow-client budget: a non-draining backlog closes the connection. */
  readonly drainTimeoutMs?: number;
  /** Test hooks for deterministic scheduling; default to setTimeout/Date.now. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

export const HUB_MAX_BUFFERED_ITEMS = 256;
export const HUB_MAX_BUFFERED_BYTES = 1024 * 1024;
export const HUB_DRAIN_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const PAGE_LIMIT = 500;

type ClientState = "pending" | "catching-up" | "live" | "done";

interface HubClient {
  state: ClientState;
  readonly filters: Readonly<
    Pick<EventStreamQuery, "iterationId" | "workflowOperationId" | "eventTypes">
  >;
  cursor?: string;
  catchUpView: EventStreamReadView | undefined;
  catchUpHead: string | undefined;
  readonly queue: HubDelivery[];
  queuedBytes: number;
  blockedSince: number | undefined;
  readonly waiters: ((result: IteratorResult<HubDelivery>) => void)[];
  terminated: boolean;
  readonly releaseSignal: () => void;
}

function deliveryBytes(delivery: HubDelivery): number {
  return Buffer.byteLength(JSON.stringify(delivery));
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class EventStreamHub implements EventStreamHubInterface {
  private readonly source: EventStreamSource;
  private readonly pollIntervalMs: number;
  private readonly maxBufferedItems: number;
  private readonly maxBufferedBytes: number;
  private readonly drainTimeoutMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly clients = new Set<HubClient>();
  private closed = false;
  private running = false;
  private loopFinished: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(source: EventStreamSource, options: EventStreamHubOptions = {}) {
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) {
      throw new Error("event stream hub pollIntervalMs must be a positive integer");
    }
    this.source = source;
    this.pollIntervalMs = pollIntervalMs;
    this.maxBufferedItems = options.maxBufferedItems ?? HUB_MAX_BUFFERED_ITEMS;
    this.maxBufferedBytes = options.maxBufferedBytes ?? HUB_MAX_BUFFERED_BYTES;
    this.drainTimeoutMs = options.drainTimeoutMs ?? HUB_DRAIN_TIMEOUT_MS;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  subscribeClient(options: HubSubscriptionOptions): AsyncIterable<HubDelivery> {
    if (this.closed) {
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ done: true, value: undefined }),
        }),
      };
    }
    const client: HubClient = {
      state: "pending",
      filters: {
        ...(options.iterationId === undefined ? {} : { iterationId: options.iterationId }),
        ...(options.workflowOperationId === undefined
          ? {}
          : { workflowOperationId: options.workflowOperationId }),
        ...(options.eventTypes === undefined ? {} : { eventTypes: options.eventTypes }),
      },
      catchUpView: undefined,
      catchUpHead: undefined,
      queue: [],
      queuedBytes: 0,
      blockedSince: undefined,
      waiters: [],
      terminated: false,
      releaseSignal: () => options.signal.removeEventListener("abort", onAbort),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    };
    const onAbort = (): void => {
      this.terminate(client);
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
    this.clients.add(client);
    if (options.signal.aborted) this.terminate(client);
    this.ensureLoop();
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => this.pull(client),
        return: () => {
          this.terminate(client);
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.wake?.();
    for (const client of [...this.clients]) this.terminate(client);
    await this.loopFinished;
  }

  private pull(client: HubClient): Promise<IteratorResult<HubDelivery>> {
    const queued = client.queue.shift();
    if (queued !== undefined) {
      client.queuedBytes -= deliveryBytes(queued);
      return Promise.resolve({ done: false, value: queued });
    }
    if (client.terminated || this.closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve) => client.waiters.push(resolve));
  }

  private flush(client: HubClient): void {
    while (client.waiters.length > 0) {
      const waiter = client.waiters.shift()!;
      const queued = client.queue.shift();
      if (queued !== undefined) {
        client.queuedBytes -= deliveryBytes(queued);
        waiter({ done: false, value: queued });
        continue;
      }
      if (client.terminated || this.closed) {
        waiter({ done: true, value: undefined });
        continue;
      }
      client.waiters.unshift(waiter);
      return;
    }
  }

  private enqueue(client: HubClient, delivery: HubDelivery): boolean {
    const bytes = deliveryBytes(delivery);
    if (
      client.queue.length + 1 > this.maxBufferedItems ||
      client.queuedBytes + bytes > this.maxBufferedBytes
    ) {
      return false;
    }
    client.queue.push(delivery);
    client.queuedBytes += bytes;
    return true;
  }

  private terminate(client: HubClient, final?: HubDelivery): void {
    if (!this.clients.has(client)) return;
    client.terminated = true;
    client.state = "done";
    client.releaseSignal();
    client.queue.length = 0;
    client.queuedBytes = 0;
    if (final !== undefined) client.queue.push(final);
    this.flush(client);
    this.clients.delete(client);
    if (this.clients.size === 0) this.wake?.();
  }

  private ensureLoop(): void {
    if (this.running || this.closed) return;
    this.running = true;
    this.loopFinished = this.run().finally(() => {
      this.running = false;
    });
  }

  private async run(): Promise<void> {
    while (!this.closed && this.clients.size > 0) {
      let view: EventStreamReadView;
      try {
        view = await this.source.refreshView();
      } catch {
        for (const client of [...this.clients]) {
          this.terminate(client, { kind: "error", code: "event_stream_unavailable" });
        }
        return;
      }
      // Serial region: head capture, catch-up paging and live fanout for this
      // tick all run synchronously against the single refreshed view.
      this.tick(view);
      await Promise.race([
        this.sleep(this.pollIntervalMs),
        new Promise<void>((resolve) => {
          this.wake = resolve;
        }),
      ]);
      this.wake = undefined;
    }
  }

  private tick(view: EventStreamReadView): void {
    for (const client of [...this.clients]) {
      if (client.state === "pending") {
        // Registered before this refresh resolved, so the captured head H
        // already covers every event the client could have missed.
        client.state = "catching-up";
        client.catchUpView = view;
        client.catchUpHead = view.headCursor;
      }
      if (client.state === "catching-up") this.pumpCatchUp(client);
      if (client.state === "live") this.pumpLive(client, view);
      this.checkStall(client);
    }
  }

  /** A backlog that stops draining for the drain budget closes this client only. */
  private checkStall(client: HubClient): void {
    if (!this.clients.has(client)) return;
    if (client.queue.length === 0) {
      client.blockedSince = undefined;
      return;
    }
    client.blockedSince ??= this.now();
    if (this.now() - client.blockedSince >= this.drainTimeoutMs) this.terminate(client);
  }

  private capacity(client: HubClient): number {
    return Math.max(0, Math.min(PAGE_LIMIT, this.maxBufferedItems - client.queue.length));
  }

  private pumpCatchUp(client: HubClient): void {
    const view = client.catchUpView;
    const head = client.catchUpHead;
    if (view === undefined || head === undefined) return;
    const limit = this.capacity(client);
    if (limit === 0) return;
    const page = view.read(
      client.cursor === undefined
        ? { ...client.filters, limit, untilCursor: head }
        : { ...client.filters, limit, cursor: client.cursor, untilCursor: head },
    );
    if (page.reset === true) {
      this.terminate(client, { kind: "reset", reason: "cursor_evicted" });
      return;
    }
    if (!this.deliver(client, page.items, page)) return;
    if (page.items.length < limit) {
      // Fewer items than requested: everything up to H has been delivered.
      client.cursor = head;
      client.catchUpView = undefined;
      client.catchUpHead = undefined;
      client.state = "live";
    }
  }

  private pumpLive(client: HubClient, view: EventStreamReadView): void {
    const limit = this.capacity(client);
    if (limit === 0) return;
    const page = view.read(
      client.cursor === undefined
        ? { ...client.filters, limit, untilCursor: view.headCursor }
        : { ...client.filters, limit, cursor: client.cursor, untilCursor: view.headCursor },
    );
    if (page.reset === true) {
      this.terminate(client, { kind: "reset", reason: "cursor_evicted" });
      return;
    }
    if (!this.deliver(client, page.items, page)) return;
    if (page.items.length === 0) client.cursor = view.headCursor;
  }

  private offer(client: HubClient, delivery: HubDelivery): boolean {
    // A parked consumer takes the delivery immediately; only a genuine
    // backlog counts against the bounded per-client buffer.
    const waiter = client.waiters.shift();
    if (waiter !== undefined) {
      waiter({ done: false, value: delivery });
      return true;
    }
    return this.enqueue(client, delivery);
  }

  private deliver(
    client: HubClient,
    items: readonly EventStreamItem[],
    page: { readonly itemCursors?: readonly string[]; readonly cursor?: string },
  ): boolean {
    for (const [index, item] of items.entries()) {
      const cursor =
        page.itemCursors?.[index] ?? (index === items.length - 1 ? page.cursor : undefined);
      if (cursor === undefined) {
        // The source violated its per-item cursor contract; never fabricate one.
        this.terminate(client, { kind: "error", code: "event_stream_unavailable" });
        return false;
      }
      if (!this.offer(client, { kind: "item", item, cursor })) {
        this.terminate(client);
        return false;
      }
      client.cursor = cursor;
    }
    return true;
  }
}
