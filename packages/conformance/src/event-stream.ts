import type {
  EventStreamItem,
  EventStreamPort,
  EventStreamReadView,
} from "@universal-harness-internal/runtime";

import type { ConformanceCase } from "./runner.js";

/*
 * Transparency/SSE conformance (spec §3/§6/§8, plan Task 6 Step 1). The named
 * cases below encode the EventStreamPort contract once; every subject — the
 * production FileEventStream and any legacy Port-fallback Adapter — proves
 * the same contract through the shared runner. Arrangement enters through
 * the subject hooks, so this file never touches the filesystem and never
 * imports adapter internals.
 */

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function assertRejects(
  run: () => Promise<unknown>,
  pattern: RegExp,
  message: string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (pattern.test(text)) return;
    throw new Error(`${message}: rejected with an unexpected error: ${text}`, { cause: error });
  }
  throw new Error(`${message}: expected a rejection matching ${String(pattern)}`);
}

/** One live observation the subject must append through its real write path. */
export interface LiveObservationInput {
  readonly streamId?: string;
  readonly observationKey: string;
  readonly eventType: string;
  readonly workflowOperationId?: string;
  readonly iterationId?: string;
  readonly timestamp: string;
  readonly payload?: Record<string, unknown>;
}

/** One authoritative event the subject must commit through its real Ledger. */
export interface CommittedEventSpec {
  readonly eventType: string;
  /** Binds the committed event to a previously appended live observation. */
  readonly observationKey?: string;
  readonly protocolVersion?: string;
  readonly workflowOperationId?: string;
  readonly iterationId?: string;
  readonly timestamp: string;
  readonly payload?: Record<string, unknown>;
}

/**
 * The arrangement surface of one event-stream subject under test. Hooks that
 * a subject cannot honestly implement stay absent, and the cases that need
 * them live only in the matching suite — a legacy Adapter is never asked to
 * fabricate v2 fields it does not have.
 */
export interface EventStreamSubject {
  readonly port: EventStreamPort;
  /** Present only when the subject implements the v2 incremental contract. */
  readonly incremental?: { refreshView(): Promise<EventStreamReadView> };
  appendLive(input: LiveObservationInput): void;
  /** Commit all specs in one atomic transaction; resolves to the event ids. */
  commitEvents(specs: readonly CommittedEventSpec[]): Promise<readonly string[]>;
  /** Write a committed event shard without a manifest (orphan). */
  writeOrphanEventShard?(specs: readonly CommittedEventSpec[]): Promise<void>;
  /** Write a manifest-bound shard directly, bypassing writer-side validation. */
  writeRawCommittedEvents?(specs: readonly CommittedEventSpec[]): Promise<void>;
  /** Corrupt an already committed event shard's bytes. */
  corruptCommittedShard?(): void;
  /** Replace the live history so previously issued cursors lose their generation. */
  evictLiveHistory?(): void;
  /**
   * Re-read the authoritative history with an explicit protocol reader
   * version; must throw when a committed manifest requires a newer reader.
   */
  readCommittedWithReader?(readerVersion: string): void;
  dispose(): void | Promise<void>;
}

export type EventStreamSubjectFactory = () => EventStreamSubject | Promise<EventStreamSubject>;

async function withSubject(
  factory: EventStreamSubjectFactory,
  run: (subject: EventStreamSubject) => Promise<void>,
): Promise<void> {
  const subject = await factory();
  try {
    await run(subject);
  } finally {
    await subject.dispose();
  }
}

const BASE_TIME = Date.parse("2026-09-08T00:00:00.000Z");

function timestamp(offsetSeconds: number): string {
  return new Date(BASE_TIME + offsetSeconds * 1000).toISOString();
}

async function readAll(
  port: EventStreamPort,
  query: Parameters<EventStreamPort["read"]>[0] = {},
): Promise<EventStreamItem[]> {
  const items: EventStreamItem[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = await port.read({
      ...query,
      limit: 1,
      ...(cursor === undefined ? {} : { cursor }),
    });
    assert(page.reset !== true, "a same-generation read must not reset");
    items.push(...page.items);
    if (page.nextCursor === undefined) break;
    cursor = page.nextCursor;
  }
  return items;
}

/**
 * The v1 contract every EventStreamPort must satisfy (spec §3/§6): committed
 * batches are visible in full, cursor paging never replays, filters hold and
 * a committed event supersedes its live observation. These cases make no v2
 * assumptions, so the legacy Port-fallback Adapter runs them unchanged.
 */
export function eventStreamPortConformanceCases(
  factory: EventStreamSubjectFactory,
): ConformanceCase[] {
  return [
    {
      name: "publishes a committed batch in full as authoritative items",
      run: () =>
        withSubject(factory, async (subject) => {
          const ids = await subject.commitEvents([
            { eventType: "OperationStarted", timestamp: timestamp(1), payload: { nonce: "a" } },
            { eventType: "OperationStarted", timestamp: timestamp(2), payload: { nonce: "b" } },
            { eventType: "OperationStarted", timestamp: timestamp(3), payload: { nonce: "c" } },
          ]);
          assertEqual(ids.length, 3, "the transaction committed three events");
          const page = await subject.port.read({ limit: 10 });
          const committed = page.items.filter((item) => item.authoritative);
          assertEqual(
            committed.map((item) => item.id),
            ids.map((id) => `ledger:${id}`),
            "one committed batch is visible in full, never as a prefix",
          );
        }),
    },
    {
      name: "pages through a cursor without replaying items",
      run: () =>
        withSubject(factory, async (subject) => {
          for (let sequence = 1; sequence <= 5; sequence += 1) {
            subject.appendLive({
              observationKey: `observation_page_${String(sequence)}`,
              eventType: "RunHeartbeat",
              timestamp: timestamp(sequence),
              payload: { heartbeat: sequence },
            });
          }
          const items = await readAll(subject.port);
          assertEqual(
            items.map((item) => item.event.sequence),
            [1, 2, 3, 4, 5],
            "limit-1 paging walks every item exactly once",
          );
        }),
    },
    {
      name: "applies iteration, workflow and event-type filters",
      run: () =>
        withSubject(factory, async (subject) => {
          const combinations = [
            ["iteration_a", "workflow_a", "PhaseStarted"],
            ["iteration_a", "workflow_b", "GateStarted"],
            ["iteration_b", "workflow_a", "GateStarted"],
          ] as const;
          for (const [
            index,
            [iterationId, workflowOperationId, eventType],
          ] of combinations.entries()) {
            subject.appendLive({
              observationKey: `observation_filter_${String(index)}`,
              eventType,
              iterationId,
              workflowOperationId,
              timestamp: timestamp(index + 1),
            });
          }
          const page = await subject.port.read({
            iterationId: "iteration_a",
            workflowOperationId: "workflow_b",
            eventTypes: ["GateStarted"],
          });
          assertEqual(page.items.length, 1, "exactly one item matches every filter dimension");
          assertEqual(
            page.items.map(
              (item) =>
                `${item.event.iteration_id}/${item.event.workflow_operation_id}/${item.event.event_type}`,
            ),
            ["iteration_a/workflow_b/GateStarted"],
            "only the item matching every filter dimension is returned",
          );
        }),
    },
    {
      name: "replaces a live observation with its committed authoritative event",
      run: () =>
        withSubject(factory, async (subject) => {
          subject.appendLive({
            observationKey: "observation_promoted",
            eventType: "GateCompleted",
            timestamp: timestamp(1),
            payload: { gate_id: "gate_conf", passed: true },
          });
          await subject.commitEvents([
            {
              eventType: "GateCompleted",
              observationKey: "observation_promoted",
              timestamp: timestamp(2),
              payload: { gate_id: "gate_conf", passed: true },
            },
          ]);
          const page = await subject.port.read({ limit: 10 });
          assertEqual(
            page.items.map((item) => `${item.source}:${String(item.authoritative)}`),
            ["ledger:true"],
            "the committed event supersedes the live observation with the same key",
          );
        }),
    },
  ];
}

/**
 * The v2 incremental contract (spec §6/§7) plus the committed-visibility and
 * reader-version rules (spec §3/§4): only subjects with a real
 * `refreshView()` and the supporting hooks run these cases.
 */
export function incrementalEventStreamConformanceCases(
  factory: EventStreamSubjectFactory,
): ConformanceCase[] {
  const requireSubject = (subject: EventStreamSubject): void => {
    assert(subject.incremental !== undefined, "the subject must implement refreshView()");
    assert(subject.writeOrphanEventShard !== undefined, "the subject must write orphan shards");
    assert(
      subject.writeRawCommittedEvents !== undefined,
      "the subject must write raw committed shards",
    );
    assert(subject.corruptCommittedShard !== undefined, "the subject must corrupt a shard");
    assert(subject.evictLiveHistory !== undefined, "the subject must evict live history");
    assert(
      subject.readCommittedWithReader !== undefined,
      "the subject must re-read with an explicit reader version",
    );
  };
  return [
    {
      name: "keeps orphan event shards invisible while committed events stay visible",
      run: () =>
        withSubject(factory, async (subject) => {
          requireSubject(subject);
          const ids = await subject.commitEvents([
            { eventType: "OperationStarted", timestamp: timestamp(1), payload: { nonce: "kept" } },
          ]);
          await subject.writeOrphanEventShard!([
            {
              eventType: "OperationStarted",
              timestamp: timestamp(2),
              payload: { nonce: "orphan" },
            },
          ]);
          const items = await readAll(subject.port);
          assertEqual(
            items.map((item) => item.id),
            ids.map((id) => `ledger:${id}`),
            "an event shard without a manifest never becomes visible",
          );
        }),
    },
    {
      name: "enforces protocol reader-version semantics for 1.4 records",
      run: () =>
        withSubject(factory, async (subject) => {
          requireSubject(subject);
          const ids = await subject.commitEvents([
            {
              eventType: "ArtifactAvailable",
              protocolVersion: "1.4.0",
              timestamp: timestamp(1),
              payload: {
                artifact_kind: "plan",
                record_digest: "a".repeat(64),
                summary: "conformance 1.4 record",
              },
            },
          ]);
          const items = await readAll(subject.port);
          assertEqual(
            items.map((item) => item.id),
            ids.map((id) => `ledger:${id}`),
            "the current reader projects a committed 1.4 record",
          );
          let blocked = false;
          try {
            subject.readCommittedWithReader!("1.3.0");
          } catch (error) {
            blocked = error instanceof Error && /protocol_upgrade_required/u.test(error.message);
          }
          assert(blocked, "an older authoritative reader must fail closed with upgrade_required");
          subject.readCommittedWithReader!("1.4.0");
        }),
    },
    {
      name: "skips unknown event types but rejects a corrupt committed shard",
      run: () =>
        withSubject(factory, async (subject) => {
          requireSubject(subject);
          await subject.writeRawCommittedEvents!([
            { eventType: "OperationStarted", timestamp: timestamp(1), payload: { nonce: "known" } },
            {
              eventType: "FutureEvent2099",
              timestamp: timestamp(2),
              payload: { nonce: "unknown" },
            },
          ]);
          const items = await readAll(subject.port);
          assertEqual(
            items.map((item) => item.event.event_type),
            ["OperationStarted"],
            "an unknown but well-formed committed event type is skipped, not fatal",
          );
          subject.corruptCommittedShard!();
          await assertRejects(
            () => subject.port.read(),
            /corrupt|digest|invalid/iu,
            "a corrupt committed shard must fail the read, never silently skip",
          );
        }),
    },
    {
      name: "exposes a stable per-item cursor on a fixed read view",
      run: () =>
        withSubject(factory, async (subject) => {
          requireSubject(subject);
          for (let sequence = 1; sequence <= 3; sequence += 1) {
            subject.appendLive({
              observationKey: `observation_cursor_${String(sequence)}`,
              eventType: "RunHeartbeat",
              timestamp: timestamp(sequence),
              payload: { heartbeat: sequence },
            });
          }
          const view = await subject.incremental!.refreshView();
          const first = view.read({ limit: 1, untilCursor: view.headCursor });
          assertEqual(first.items.length, 1, "the first page has one item");
          assertEqual(
            first.itemCursors?.[0],
            first.cursor,
            "the per-item cursor is the resume anchor for that item",
          );
          const firstCursor = first.itemCursors?.[0];
          assert(firstCursor !== undefined, "the first page must carry a per-item cursor");
          const rest = view.read({
            cursor: firstCursor,
            untilCursor: view.headCursor,
            limit: 500,
          });
          assert(rest.reset !== true, "a same-view resume must not reset");
          assertEqual(
            rest.items.map((item) => item.event.sequence),
            [2, 3],
            "the remainder of the captured head is readable without replay",
          );
          // A fixed view never chases events appended after its head.
          subject.appendLive({
            observationKey: "observation_cursor_late",
            eventType: "RunHeartbeat",
            timestamp: timestamp(4),
            payload: { heartbeat: 4 },
          });
          const late = view.read({
            ...(rest.cursor === undefined ? {} : { cursor: rest.cursor }),
            untilCursor: view.headCursor,
            limit: 500,
          });
          assertEqual(late.items.length, 0, "a captured view does not chase later appends");
        }),
    },
    {
      name: "resets a cursor whose live generation was replaced",
      run: () =>
        withSubject(factory, async (subject) => {
          requireSubject(subject);
          subject.appendLive({
            observationKey: "observation_evicted",
            eventType: "RunHeartbeat",
            timestamp: timestamp(1),
          });
          const cursor = (await subject.port.read({ limit: 1 })).cursor;
          assert(cursor !== undefined, "the subject issued a cursor");
          subject.evictLiveHistory!();
          const resumed = await subject.port.read({ cursor, limit: 10 });
          assertEqual(
            resumed.reset,
            true,
            "a stale-generation cursor must reset, not silently gap",
          );
        }),
    },
    {
      name: "delivers a late item with an earlier timestamp in total order",
      run: () =>
        withSubject(factory, async (subject) => {
          requireSubject(subject);
          subject.appendLive({
            observationKey: "observation_ontime",
            eventType: "RunHeartbeat",
            timestamp: timestamp(20),
            payload: { marker: "ontime" },
          });
          subject.appendLive({
            observationKey: "observation_late",
            eventType: "RunHeartbeat",
            timestamp: timestamp(10),
            payload: { marker: "late" },
          });
          const items = await readAll(subject.port);
          assertEqual(
            items.map((item) => item.event.payload["marker"]),
            ["late", "ontime"],
            "display order follows the total order, not the arrival order",
          );
        }),
    },
  ];
}

/** Design §8.1 delivery shape; the Dashboard Hub satisfies it structurally. */
export type HubConformanceDelivery =
  | { readonly kind: "item"; readonly item: EventStreamItem; readonly cursor: string }
  | { readonly kind: "reset"; readonly reason: string }
  | { readonly kind: "error"; readonly code: string };

export interface HubConformanceSubscribeOptions {
  readonly cursor?: string;
  readonly iterationId?: string;
  readonly workflowOperationId?: string;
  readonly eventTypes?: readonly string[];
  readonly signal: AbortSignal;
}

export interface EventStreamHubSubject {
  subscribeClient(options: HubConformanceSubscribeOptions): AsyncIterable<HubConformanceDelivery>;
  close(): Promise<void>;
}

export interface EventStreamHubFactory {
  create(
    source: { refreshView(): Promise<EventStreamReadView> },
    options?: {
      readonly pollIntervalMs?: number;
      readonly maxBufferedItems?: number;
      readonly drainTimeoutMs?: number;
    },
  ): EventStreamHubSubject;
}

async function collectUntil(
  iterable: AsyncIterable<HubConformanceDelivery>,
  predicate: (deliveries: readonly HubConformanceDelivery[]) => boolean,
  timeoutMs: number,
  label: string,
): Promise<HubConformanceDelivery[]> {
  const deliveries: HubConformanceDelivery[] = [];
  const iterator = iterable[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  while (!predicate(deliveries)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `${label}: timed out after ${String(timeoutMs)}ms with ${JSON.stringify(deliveries.map((delivery) => delivery.kind))}`,
      );
    }
    const result = await Promise.race([
      iterator.next(),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), remaining)),
    ]);
    if (result === "timeout") {
      throw new Error(`${label}: timed out waiting for the next delivery`);
    }
    if (result.done === true) break;
    deliveries.push(result.value);
  }
  return deliveries;
}

/**
 * The shared-Hub contract (spec §8): gap-free catch-up handoff with a
 * per-item cursor on every delivery, per-client filter isolation, and a
 * stalled client never slowing the other subscribers.
 */
export function eventStreamHubConformanceCases(
  subjectFactory: EventStreamSubjectFactory,
  hubFactory: EventStreamHubFactory,
): ConformanceCase[] {
  const withHub = async (
    options: Parameters<EventStreamHubFactory["create"]>[1],
    run: (hub: EventStreamHubSubject, subject: EventStreamSubject) => Promise<void>,
  ): Promise<void> =>
    withSubject(subjectFactory, async (subject) => {
      assert(subject.incremental !== undefined, "the Hub source must implement refreshView()");
      const hub = hubFactory.create(subject.incremental, options);
      try {
        await run(hub, subject);
      } finally {
        await hub.close();
      }
    });

  return [
    {
      name: "hands a subscriber from catch-up to live delivery without a gap or replay",
      run: () =>
        withHub({ pollIntervalMs: 5 }, async (hub, subject) => {
          const history = await subject.commitEvents([
            { eventType: "OperationStarted", timestamp: timestamp(1), payload: { nonce: "h1" } },
            { eventType: "OperationStarted", timestamp: timestamp(2), payload: { nonce: "h2" } },
          ]);
          const controller = new AbortController();
          const iterable = hub.subscribeClient({ signal: controller.signal });
          const expected = [...history];
          // New events committed while the subscriber is catching up must
          // arrive exactly once, after the history, through the same cursor chain.
          expected.push(
            ...(await subject.commitEvents([
              { eventType: "OperationStarted", timestamp: timestamp(3), payload: { nonce: "h3" } },
            ])),
          );
          const deliveries = await collectUntil(
            iterable,
            (seen) => seen.filter((delivery) => delivery.kind === "item").length >= 3,
            10_000,
            "catch-up handoff",
          );
          controller.abort();
          const items = deliveries.filter(
            (delivery): delivery is Extract<HubConformanceDelivery, { readonly kind: "item" }> =>
              delivery.kind === "item",
          );
          assertEqual(
            items.map((delivery) => delivery.item.id),
            expected.map((id) => `ledger:${id}`),
            "catch-up and live deliveries together cover the history exactly once, in order",
          );
          for (const delivery of items) {
            assert(
              typeof delivery.cursor === "string" && delivery.cursor.length > 0,
              "every Hub delivery carries its per-item cursor",
            );
          }
        }),
    },
    {
      name: "keeps per-client filters isolated on the shared source",
      run: () =>
        withHub({ pollIntervalMs: 5 }, async (hub, subject) => {
          // Each transaction carries exactly one workflow's events.
          await subject.commitEvents([
            {
              eventType: "OperationStarted",
              workflowOperationId: "workflow_a",
              timestamp: timestamp(1),
              payload: { nonce: "a" },
            },
          ]);
          await subject.commitEvents([
            {
              eventType: "OperationStarted",
              workflowOperationId: "workflow_b",
              timestamp: timestamp(2),
              payload: { nonce: "b" },
            },
          ]);
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
          const [deliveriesA, deliveriesB] = await Promise.all([
            collectUntil(clientA, (seen) => seen.length >= 1, 10_000, "client A"),
            collectUntil(clientB, (seen) => seen.length >= 1, 10_000, "client B"),
          ]);
          controllerA.abort();
          controllerB.abort();
          assertEqual(
            deliveriesA.map((delivery) =>
              delivery.kind === "item" ? delivery.item.event.workflow_operation_id : "other",
            ),
            ["workflow_a"],
            "client A never observes workflow B",
          );
          assertEqual(
            deliveriesB.map((delivery) =>
              delivery.kind === "item" ? delivery.item.event.workflow_operation_id : "other",
            ),
            ["workflow_b"],
            "client B never observes workflow A",
          );
        }),
    },
    {
      name: "closes a stalled client without delaying the other subscribers",
      run: () =>
        withHub(
          { pollIntervalMs: 5, maxBufferedItems: 2, drainTimeoutMs: 50 },
          async (hub, subject) => {
            const stalledController = new AbortController();
            const fastController = new AbortController();
            // The stalled client never pulls once; its bounded buffer fills and
            // the Hub must close only this subscription.
            const stalled = hub.subscribeClient({ signal: stalledController.signal });
            const fast = hub.subscribeClient({ signal: fastController.signal });
            const ids = await subject.commitEvents(
              [1, 2, 3, 4, 5].map((offset) => ({
                eventType: "OperationStarted",
                timestamp: timestamp(offset),
                payload: { nonce: `s${String(offset)}` },
              })),
            );
            const fastDeliveries = await collectUntil(
              fast,
              (seen) => seen.filter((delivery) => delivery.kind === "item").length >= ids.length,
              10_000,
              "fast client",
            );
            // Pulling the stalled backlog would reset its drain budget, so the
            // closure is observed passively: wait well beyond the drain budget
            // without touching the iterator, then the first pull must be done.
            await new Promise((resolve) => setTimeout(resolve, 10 * 50));
            const stalledIterator = stalled[Symbol.asyncIterator]();
            const first = await stalledIterator.next();
            const stalledClosed = first.done === true;
            fastController.abort();
            stalledController.abort();
            assert(stalledClosed, "the stalled subscription must be closed by the Hub");
            assertEqual(
              fastDeliveries.map((delivery) =>
                delivery.kind === "item" ? delivery.item.id : "other",
              ),
              ids.map((id) => `ledger:${id}`),
              "the fast subscriber still receives every event, in order",
            );
          },
        ),
    },
  ];
}
