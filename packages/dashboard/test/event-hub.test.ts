import { describe, expect, it } from "vitest";

import type {
  EventStreamItem,
  EventStreamPage,
  EventStreamQuery,
  EventStreamReadView,
} from "@universal-harness-internal/runtime";

import {
  EventStreamHub,
  HUB_DRAIN_TIMEOUT_MS,
  HUB_MAX_BUFFERED_BYTES,
  HUB_MAX_BUFFERED_ITEMS,
  type HubDelivery,
} from "../src/event-hub.js";

/**
 * Fake append-only source that mirrors the Task 1 EventIndex semantics the Hub
 * relies on: v2 generation cursors, filtered paged reads with per-item cursors,
 * untilCursor as an exclusive upper bound, and reset on generation mismatch.
 */
interface FakeState {
  items: EventStreamItem[];
  generation: string;
}

interface ReadCall {
  readonly limit?: number;
  readonly cursor?: string;
  readonly untilCursor?: string;
}

function cursorOf(generation: string, position: number): string {
  return `cursor_${Buffer.from(JSON.stringify({ version: 2, generation, position })).toString("base64url")}`;
}

function decodeCursor(cursor: string): { generation: string; position: number } {
  return JSON.parse(Buffer.from(cursor.slice(7), "base64url").toString("utf8")) as {
    generation: string;
    position: number;
  };
}

function item(sequence: number, workflow = "workflow_a"): EventStreamItem {
  return {
    id: `live:stream_01:${String(sequence)}`,
    source: "live",
    authoritative: false,
    event: {
      stream_version: 1,
      stream_id: "stream_01",
      sequence,
      observation_key: `observation_${String(sequence)}`,
      event_type: "RunHeartbeat",
      project_id: "project_01",
      iteration_id: "iteration_01",
      workflow_operation_id: workflow,
      timestamp: `2026-08-16T00:00:${String(sequence).padStart(2, "0")}.000Z`,
      payload: { run_id: "run_01" },
    },
  };
}

function makeView(state: FakeState, capturedHead: string, readCalls?: ReadCall[]) {
  return {
    headCursor: capturedHead,
    read(query: EventStreamQuery = {}): EventStreamPage {
      readCalls?.push({
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.untilCursor === undefined ? {} : { untilCursor: query.untilCursor }),
      });
      const head = decodeCursor(capturedHead);
      const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
      const until = query.untilCursor === undefined ? head : decodeCursor(query.untilCursor);
      const valid = (cursor: { generation: string; position: number }): boolean =>
        cursor.generation === state.generation && cursor.position <= state.items.length;
      if (!valid(head) || !valid(until) || (after !== undefined && !valid(after))) {
        return { items: [], itemCursors: [], headCursor: capturedHead, reset: true };
      }
      const limit = query.limit ?? 50;
      const upper = Math.min(until.position, head.position);
      const items: EventStreamItem[] = [];
      const itemCursors: string[] = [];
      let hasMore = false;
      for (let index = after?.position ?? 0; index < upper; index += 1) {
        const candidate = state.items[index]!;
        if (
          (query.iterationId !== undefined && candidate.event.iteration_id !== query.iterationId) ||
          (query.workflowOperationId !== undefined &&
            candidate.event.workflow_operation_id !== query.workflowOperationId) ||
          (query.eventTypes !== undefined && !query.eventTypes.includes(candidate.event.event_type))
        )
          continue;
        if (items.length === limit) {
          hasMore = true;
          break;
        }
        items.push(candidate);
        itemCursors.push(cursorOf(state.generation, index + 1));
      }
      const cursor = itemCursors.at(-1);
      return {
        items,
        itemCursors,
        headCursor: capturedHead,
        ...(cursor === undefined ? {} : { cursor }),
        ...(hasMore && cursor !== undefined ? { nextCursor: cursor } : {}),
      };
    },
  } satisfies EventStreamReadView;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeSource {
  readonly state: FakeState = { items: [], generation: "generation_01" };
  refreshes = 0;
  readCalls: ReadCall[] = [];
  private gate: Promise<void> | undefined;
  private failure: Error | undefined;

  append(...items: EventStreamItem[]): void {
    this.state.items.push(...items);
  }

  rotateGeneration(): void {
    this.state.generation = `generation_${String(this.refreshes + 100)}`;
    this.state.items = [];
  }

  blockRefresh(): ReturnType<typeof deferred> {
    const gate = deferred();
    this.gate = gate.promise;
    return gate;
  }

  failRefresh(error: Error): void {
    this.failure = error;
  }

  async refreshView(): Promise<EventStreamReadView> {
    const gate = this.gate;
    this.gate = undefined;
    if (gate !== undefined) await gate;
    if (this.failure !== undefined) {
      const failure = this.failure;
      this.failure = undefined;
      throw failure;
    }
    this.refreshes += 1;
    const head = cursorOf(this.state.generation, this.state.items.length);
    return makeView(this.state, head, this.readCalls);
  }
}

function hubOptions(source: FakeSource, ticks?: { target: number; onTick: () => void }) {
  let sleeps = 0;
  return {
    pollIntervalMs: 1,
    sleep: () => {
      sleeps += 1;
      if (ticks !== undefined && sleeps >= ticks.target) ticks.onTick();
      // setImmediate keeps the loop on macrotasks so real timers still fire.
      return new Promise<void>((resolve) => setImmediate(resolve));
    },
    _sleeps: () => sleeps,
  };
}

async function collect(
  iterable: AsyncIterable<HubDelivery>,
  count: number,
): Promise<HubDelivery[]> {
  const deliveries: HubDelivery[] = [];
  const iterator = iterable[Symbol.asyncIterator]();
  while (deliveries.length < count) {
    const next = await iterator.next();
    if (next.done === true) break;
    deliveries.push(next.value);
  }
  return deliveries;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition not reached");
}

describe("EventStreamHub", () => {
  it("hands off catch-up without gaps while events land behind a refresh barrier", async () => {
    const source = new FakeSource();
    source.append(item(1), item(2), item(3));
    const hub = new EventStreamHub(source, hubOptions(source));
    const controller = new AbortController();

    const gate = source.blockRefresh();
    const client = hub.subscribeClient({ signal: controller.signal });
    const iterator = client[Symbol.asyncIterator]();
    // The client registered before the shared refresh resolves; the head upper
    // bound H is captured inside the Hub serial region, after registration.
    gate.resolve();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    const second = await iterator.next();
    expect(second.done).toBe(false);

    // Event 4 lands while the client is still catching up to H. It must be
    // delivered only after every position up to H, exactly once, in order.
    source.append(item(4));
    const third = await iterator.next();
    const fourth = await iterator.next();
    const received = [first.value, second.value, third.value, fourth.value];
    expect(received.map((delivery) => delivery.kind)).toEqual(["item", "item", "item", "item"]);
    expect(received.map((delivery) => (delivery.kind === "item" ? delivery.item.id : ""))).toEqual([
      "live:stream_01:1",
      "live:stream_01:2",
      "live:stream_01:3",
      "live:stream_01:4",
    ]);
    const positions = received.map((delivery) =>
      delivery.kind === "item" ? decodeCursor(delivery.cursor).position : -1,
    );
    expect(positions).toEqual([1, 2, 3, 4]);

    controller.abort();
    await hub.close();
  });

  it("isolates per-client workflow filters across a shared source view", async () => {
    const source = new FakeSource();
    source.append(item(1, "workflow_a"), item(2, "workflow_b"), item(3, "workflow_a"));
    const hub = new EventStreamHub(source, hubOptions(source));
    const controllerA = new AbortController();
    const controllerB = new AbortController();

    const clientA = hub.subscribeClient({
      workflowOperationId: "workflow_a",
      signal: controllerA.signal,
    });
    const clientB = hub.subscribeClient({
      workflowOperationId: "workflow_b",
      signal: controllerB.signal,
    });
    const deliveriesA = await collect(clientA, 2);
    const deliveriesB = await collect(clientB, 1);

    expect(
      deliveriesA.map((delivery) =>
        delivery.kind === "item" ? delivery.item.event.workflow_operation_id : "",
      ),
    ).toEqual(["workflow_a", "workflow_a"]);
    expect(
      deliveriesB.map((delivery) =>
        delivery.kind === "item" ? delivery.item.event.workflow_operation_id : "",
      ),
    ).toEqual(["workflow_b"]);
    const idsA = deliveriesA.map((delivery) => (delivery.kind === "item" ? delivery.item.id : ""));
    const idsB = deliveriesB.map((delivery) => (delivery.kind === "item" ? delivery.item.id : ""));
    expect(idsA).toEqual(["live:stream_01:1", "live:stream_01:3"]);
    expect(idsB).toEqual(["live:stream_01:2"]);

    controllerA.abort();
    controllerB.abort();
    await hub.close();
  });

  it("catches up more than 500 historical items in bounded pages without losing any", async () => {
    const source = new FakeSource();
    const history = Array.from({ length: 620 }, (_, index) => item(index + 1));
    source.append(...history);
    const hub = new EventStreamHub(source, hubOptions(source));
    const controller = new AbortController();

    const client = hub.subscribeClient({ signal: controller.signal });
    const deliveries = await collect(client, 620);

    expect(deliveries).toHaveLength(620);
    expect(deliveries.every((delivery) => delivery.kind === "item")).toBe(true);
    expect(
      deliveries.map((delivery) => (delivery.kind === "item" ? delivery.item.id : "")),
    ).toEqual(history.map((entry) => entry.id));
    const positions = deliveries.map((delivery) =>
      delivery.kind === "item" ? decodeCursor(delivery.cursor).position : -1,
    );
    expect(positions).toEqual(history.map((_, index) => index + 1));
    // Catch-up is paged: no single read may exceed the 500-item page limit.
    expect(source.readCalls.length).toBeGreaterThan(1);
    for (const call of source.readCalls) {
      expect(call.limit).toBeLessThanOrEqual(500);
    }

    controller.abort();
    await hub.close();
  });

  it("keeps delivering to one client when another disconnects mid-stream", async () => {
    const source = new FakeSource();
    source.append(item(1));
    const hub = new EventStreamHub(source, hubOptions(source));
    const controllerA = new AbortController();
    const controllerB = new AbortController();

    const clientA = hub.subscribeClient({ signal: controllerA.signal });
    const clientB = hub.subscribeClient({ signal: controllerB.signal });
    const iteratorA = clientA[Symbol.asyncIterator]();
    await iteratorA.next();
    await collect(clientB, 1);

    controllerA.abort();
    const closedA = await iteratorA.next();
    expect(closedA.done).toBe(true);

    source.append(item(2));
    const iteratorB = clientB[Symbol.asyncIterator]();
    const afterDisconnect = await iteratorB.next();
    expect(afterDisconnect.done).toBe(false);
    expect(afterDisconnect.value).toMatchObject({
      kind: "item",
      item: { id: "live:stream_01:2" },
    });

    controllerB.abort();
    await hub.close();
  });

  it("resets a client whose cursor belongs to an unknown generation", async () => {
    const source = new FakeSource();
    source.append(item(1), item(2));
    const hub = new EventStreamHub(source, hubOptions(source));
    const controller = new AbortController();

    const client = hub.subscribeClient({
      cursor: cursorOf("generation_unknown", 1),
      signal: controller.signal,
    });
    const iterator = client[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual({ kind: "reset", reason: "cursor_evicted" });
    const after = await iterator.next();
    expect(after.done).toBe(true);

    controller.abort();
    await hub.close();
  });

  it("resets a client when the generation rotates during catch-up", async () => {
    const source = new FakeSource();
    // 300 items force catch-up to span multiple ticks at the default 256-item
    // buffer bound, so the rotation lands while the old view is still owed reads.
    source.append(...Array.from({ length: 300 }, (_, index) => item(index + 1)));
    const hub = new EventStreamHub(source, hubOptions(source));
    const controller = new AbortController();

    const client = hub.subscribeClient({ signal: controller.signal });
    const iterator = client[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    // Rotate while the client still owes catch-up reads against the old view.
    source.rotateGeneration();
    source.append(item(999));
    const seen: HubDelivery[] = [first.value];
    // The buffered old-generation page must be drained before the Hub's next
    // tick observes the rotation and terminates the catch-up with a reset.
    for (let index = 0; index < 300; index += 1) {
      const next = await iterator.next();
      if (next.done === true) break;
      seen.push(next.value);
      if (next.value.kind === "reset") break;
    }
    const reset = seen.find((delivery) => delivery.kind === "reset");
    expect(reset).toEqual({ kind: "reset", reason: "cursor_evicted" });
    // Data from two generations is never spliced into one stream.
    const ids = seen.map((delivery) => (delivery.kind === "item" ? delivery.item.id : ""));
    expect(ids).not.toContain("live:stream_01:999");
    expect((await iterator.next()).done).toBe(true);

    controller.abort();
    await hub.close();
  });

  it("delivers a typed error and ends subscriptions when the source refresh fails", async () => {
    const source = new FakeSource();
    source.append(item(1));
    const hub = new EventStreamHub(source, hubOptions(source));
    const controller = new AbortController();

    const client = hub.subscribeClient({ signal: controller.signal });
    const iterator = client[Symbol.asyncIterator]();
    await iterator.next();
    source.failRefresh(new Error("ledger unreadable"));
    const failure = await iterator.next();
    expect(failure.done).toBe(false);
    expect(failure.value).toEqual({ kind: "error", code: "event_stream_unavailable" });
    expect((await iterator.next()).done).toBe(true);

    controller.abort();
    await hub.close();
  });

  it("does not multiply shared source refreshes when clients multiply", async () => {
    const run = async (clientCount: number): Promise<number> => {
      const source = new FakeSource();
      source.append(item(1));
      const controllers = Array.from({ length: clientCount }, () => new AbortController());
      const options = hubOptions(source, {
        target: 30,
        onTick: () => {
          for (const controller of controllers) controller.abort();
        },
      });
      const hub = new EventStreamHub(source, options);
      const consumers = controllers.map((controller) =>
        collect(hub.subscribeClient({ signal: controller.signal }), 1),
      );
      await Promise.all(consumers);
      await waitFor(() => controllers.every((controller) => controller.signal.aborted));
      await hub.close();
      return source.refreshes;
    };

    const refreshesWithOneClient = await run(1);
    const refreshesWithFourClients = await run(4);
    expect(refreshesWithFourClients).toBe(refreshesWithOneClient);
    expect(refreshesWithOneClient).toBeGreaterThan(0);
  });

  it("stops polling when the last client leaves and resumes on a new subscription", async () => {
    const source = new FakeSource();
    source.append(item(1));
    const hub = new EventStreamHub(source, {
      pollIntervalMs: 1,
      sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 1)),
    });
    const controller = new AbortController();

    const client = hub.subscribeClient({ signal: controller.signal });
    await collect(client, 1);
    controller.abort();
    await waitFor(() => source.refreshes > 0);
    await waitFor(() => true);
    const quiescent = source.refreshes;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(source.refreshes).toBeLessThanOrEqual(quiescent + 1);

    const second = new AbortController();
    const resumed = hub.subscribeClient({ signal: second.signal });
    const deliveries = await collect(resumed, 1);
    expect(deliveries[0]).toMatchObject({ kind: "item", item: { id: "live:stream_01:1" } });
    second.abort();
    await hub.close();
  });

  it("closes a client whose backlog stops draining past the drain budget while others continue", async () => {
    const source = new FakeSource();
    source.append(...Array.from({ length: 10 }, (_, index) => item(index + 1)));
    const hub = new EventStreamHub(source, {
      pollIntervalMs: 1,
      maxBufferedItems: 4,
      drainTimeoutMs: 30,
      sleep: () => new Promise<void>((resolve) => setImmediate(resolve)),
    });
    const slow = new AbortController();
    const fast = new AbortController();

    const slowClient = hub.subscribeClient({ signal: slow.signal });
    const fastClient = hub.subscribeClient({ signal: fast.signal });
    const fastPromise = collect(fastClient, 10);
    const slowIterator = slowClient[Symbol.asyncIterator]();
    const first = await slowIterator.next();
    expect(first.done).toBe(false);
    // The slow client never drains its 4-item backlog; the Hub must close it
    // after the drain budget without disturbing the fast client.
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    const closed = await slowIterator.next();
    expect(closed.done).toBe(true);

    const fastDeliveries = await fastPromise;
    expect(fastDeliveries).toHaveLength(10);
    expect(fastDeliveries.at(-1)).toMatchObject({
      kind: "item",
      item: { id: "live:stream_01:10" },
    });

    slow.abort();
    fast.abort();
    await hub.close();
  });

  it("closes a client whose pending buffer exceeds the byte bound while others continue", async () => {
    const source = new FakeSource();
    source.append(...Array.from({ length: 5 }, (_, index) => item(index + 1)));
    // Two deliveries never fit in 700 bytes; one always does. A stalled client
    // overflows on the next page while a draining client stays under the bound.
    const hub = new EventStreamHub(source, {
      pollIntervalMs: 1,
      maxBufferedItems: 2,
      maxBufferedBytes: 700,
      sleep: () => new Promise<void>((resolve) => setImmediate(resolve)),
    });
    const slow = new AbortController();
    const fast = new AbortController();

    const slowIterator = hub.subscribeClient({ signal: slow.signal })[Symbol.asyncIterator]();
    const first = await slowIterator.next();
    expect(first.done).toBe(false);
    // One delivery is buffered behind the stalled consumer; the next page no
    // longer fits the byte bound, so the Hub closes this client only.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect((await slowIterator.next()).done).toBe(true);

    const fastDeliveries = await collect(hub.subscribeClient({ signal: fast.signal }), 5);
    expect(fastDeliveries).toHaveLength(5);

    slow.abort();
    fast.abort();
    await hub.close();
  });

  it("documents the bounded fanout defaults from the design", () => {
    expect(HUB_MAX_BUFFERED_ITEMS).toBe(256);
    expect(HUB_MAX_BUFFERED_BYTES).toBe(1024 * 1024);
    expect(HUB_DRAIN_TIMEOUT_MS).toBe(10_000);
  });
});
