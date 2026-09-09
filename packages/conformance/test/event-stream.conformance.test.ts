import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it } from "vitest";

import {
  LedgerRepository,
  canonicalizeJson,
  contentDigest,
  harnessRootFor,
  readCommittedOperations,
  sha256Hex,
  transactionRequiredReaderVersion,
} from "@universal-harness-internal/core";
import type { LifecycleEvent, ObservationEvent } from "@universal-harness-internal/core";

import { EventStreamHub } from "../../dashboard/src/event-hub.js";
import {
  FileEventStream,
  FileLiveSpool,
  type EventStreamItem,
  type EventStreamPage,
  type EventStreamPort,
  type EventStreamQuery,
} from "../../runtime/src/index.js";

import {
  assertConformance,
  eventStreamHubConformanceCases,
  eventStreamPortConformanceCases,
  incrementalEventStreamConformanceCases,
  runConformanceSuite,
  type CommittedEventSpec,
  type EventStreamHubFactory,
  type EventStreamSubject,
  type LiveObservationInput,
} from "../src/index.js";

/**
 * Transparency/SSE conformance entry (plan Task 6 Step 1): the shared named
 * cases from `src/event-stream.ts` run through the generic runner against the
 * production FileEventStream, a legacy Port-fallback Adapter (v1 contract
 * only — it never fabricates v2 per-item cursors) and the production
 * Dashboard Hub over the real file-backed source.
 */

const BASELINE = "abcdef0123456789";

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), "harness-event-stream-conformance-"));
}

function liveObservation(input: LiveObservationInput, sequence: number): ObservationEvent {
  return {
    stream_version: 1,
    stream_id: input.streamId ?? "stream_conf",
    sequence,
    observation_key: input.observationKey,
    event_type: input.eventType as ObservationEvent["event_type"],
    project_id: "project_conf",
    iteration_id: input.iterationId ?? "iteration_conf",
    workflow_operation_id: input.workflowOperationId ?? "workflow_conf",
    timestamp: input.timestamp,
    payload: input.payload ?? {},
  };
}

/** Real file-backed subject: production FileEventStream over a temp project. */
async function createFileSubject(): Promise<EventStreamSubject> {
  const projectRoot = temporaryRoot();
  const stream = new FileEventStream(projectRoot);
  const spool = new FileLiveSpool(projectRoot);
  const repository = new LedgerRepository({
    projectRoot,
    readBaseline: () => BASELINE,
  });
  let commitCounter = 0;
  let eventSequence = 0;
  let lastShardPath: string | undefined;

  const buildEvents = (
    specs: readonly CommittedEventSpec[],
    ledgerOperationId: string,
  ): LifecycleEvent[] =>
    specs.map((spec) => {
      eventSequence += 1;
      return {
        protocol_version: spec.protocolVersion ?? "1.0.0",
        record_kind: "event",
        event_id: `event_conf_${String(eventSequence).padStart(5, "0")}`,
        event_type: spec.eventType,
        project_id: "project_conf",
        iteration_id: spec.iterationId ?? "iteration_conf",
        workflow_operation_id: spec.workflowOperationId ?? "workflow_conf",
        ledger_operation_id: ledgerOperationId,
        sequence: eventSequence,
        timestamp: spec.timestamp,
        payload: {
          ...(spec.payload ?? {}),
          ...(spec.observationKey === undefined ? {} : { observation_key: spec.observationKey }),
        },
      } as LifecycleEvent;
    });

  const writeRawShard = (specs: readonly CommittedEventSpec[], orphan: boolean): void => {
    commitCounter += 1;
    const operationId = `ledger_conf_raw_${String(commitCounter).padStart(4, "0")}`;
    const month = (specs[0]?.timestamp ?? "2026-09-08T00:00:00.000Z").slice(0, 7);
    const events = buildEvents(specs, operationId);
    const eventContent = `${events.map((event) => canonicalizeJson(event)).join("\n")}\n`;
    const eventsDirectory = join(projectRoot, ".harness", "events", month);
    mkdirSync(eventsDirectory, { recursive: true });
    const shardPath = join(
      eventsDirectory,
      `${orphan ? `orphan_conf_${String(commitCounter)}` : operationId}.jsonl`,
    );
    writeFileSync(shardPath, eventContent, "utf8");
    if (orphan) return;
    const edgeRelative = `ledger/edges/${month}/${operationId}.jsonl`;
    mkdirSync(join(projectRoot, ".harness", "ledger", "edges", month), { recursive: true });
    writeFileSync(join(projectRoot, ".harness", edgeRelative), "", "utf8");
    const draft = {
      protocol_version: "1.0.0",
      record_kind: "ledger_operation",
      ledger_operation_id: operationId,
      workflow_operation_id: "workflow_conf",
      attempt_id: `attempt_conf_raw_${String(commitCounter)}`,
      baseline_commit: BASELINE,
      sequence: 10_000 + commitCounter,
      artifact_digests: [],
      edge_file: edgeRelative,
      event_file: `events/${month}/${operationId}.jsonl`,
      edge_file_digest: sha256Hex(""),
      event_file_digest: sha256Hex(eventContent),
    };
    const manifest = {
      ...draft,
      committed_at: specs[0]?.timestamp ?? "2026-09-08T00:00:00.000Z",
      digest: contentDigest(draft),
    };
    mkdirSync(join(projectRoot, ".harness", "ledger", "operations"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".harness", "ledger", "operations", `${operationId}.json`),
      `${JSON.stringify(manifest)}\n`,
      "utf8",
    );
    lastShardPath = shardPath;
  };

  return {
    port: stream,
    incremental: stream,
    appendLive(input) {
      spool.append({
        streamId: input.streamId ?? "stream_conf",
        observationKey: input.observationKey,
        eventType: input.eventType,
        projectId: "project_conf",
        iterationId: input.iterationId ?? "iteration_conf",
        workflowOperationId: input.workflowOperationId ?? "workflow_conf",
        timestamp: input.timestamp,
        payload: input.payload ?? {},
      });
    },
    async commitEvents(specs) {
      commitCounter += 1;
      const ledgerOperationId = `ledger_conf_${String(commitCounter).padStart(4, "0")}`;
      const events = buildEvents(specs, ledgerOperationId);
      const transaction = {
        ledger_operation_id: ledgerOperationId,
        workflow_operation_id: specs[0]?.workflowOperationId ?? "workflow_conf",
        attempt_id: `attempt_conf_${String(commitCounter)}`,
        expected_baseline: BASELINE,
        events,
      };
      const pin = transactionRequiredReaderVersion(transaction);
      const result = await repository.commit({
        ...transaction,
        ...(pin === undefined ? {} : { required_reader_version: pin }),
      });
      if (result.status !== "committed") {
        throw new Error("conformance commit was not committed");
      }
      const operation = repository
        .operations()
        .find((candidate) => candidate.manifest.ledger_operation_id === ledgerOperationId);
      if (operation !== undefined) {
        lastShardPath = join(projectRoot, ".harness", operation.manifest.event_file);
      }
      return events.map((event) => event.event_id);
    },
    writeOrphanEventShard: (specs) => {
      writeRawShard(specs, true);
      return Promise.resolve();
    },
    writeRawCommittedEvents: (specs) => {
      writeRawShard(specs, false);
      return Promise.resolve();
    },
    corruptCommittedShard() {
      if (lastShardPath === undefined) throw new Error("no committed shard to corrupt");
      appendFileSync(lastShardPath, "corrupted-bytes\n", "utf8");
    },
    evictLiveHistory() {
      rmSync(join(projectRoot, ".harness", "cache", "event-stream", "stream_conf"), {
        recursive: true,
        force: true,
      });
    },
    readCommittedWithReader(readerVersion) {
      readCommittedOperations(harnessRootFor(projectRoot), { readerVersion });
    },
    dispose() {
      rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}

/**
 * Legacy Port-fallback Adapter (spec §8: the SSE fallback path accepts sources
 * without `refreshView`). In-memory and v1 only: `read` returns page-level
 * cursors and never fabricates per-item cursors or a head cursor.
 */
class LegacyInMemoryEventStream implements EventStreamPort {
  private items: EventStreamItem[] = [];
  private eventSequence = 0;
  private liveSequence = 0;

  appendLive(input: LiveObservationInput): void {
    this.liveSequence += 1;
    this.items.push({
      id: `live:legacy:${String(this.liveSequence)}`,
      source: "live",
      authoritative: false,
      event: liveObservation(input, this.liveSequence),
    });
  }

  commitEvents(specs: readonly CommittedEventSpec[]): readonly string[] {
    const ids: string[] = [];
    for (const spec of specs) {
      this.eventSequence += 1;
      const eventId = `event_legacy_${String(this.eventSequence)}`;
      if (spec.observationKey !== undefined) {
        this.items = this.items.filter((item) => {
          if (item.source !== "live") return true;
          return (item.event as ObservationEvent).observation_key !== spec.observationKey;
        });
      }
      this.items.push({
        id: `ledger:${eventId}`,
        source: "ledger",
        authoritative: true,
        event: {
          protocol_version: spec.protocolVersion ?? "1.0.0",
          record_kind: "event",
          event_id: eventId,
          event_type: spec.eventType,
          project_id: "project_conf",
          iteration_id: spec.iterationId ?? "iteration_conf",
          workflow_operation_id: spec.workflowOperationId ?? "workflow_conf",
          ledger_operation_id: "ledger_legacy",
          sequence: this.eventSequence,
          timestamp: spec.timestamp,
          payload: {
            ...(spec.payload ?? {}),
            ...(spec.observationKey === undefined ? {} : { observation_key: spec.observationKey }),
          },
        } as LifecycleEvent,
      });
      ids.push(eventId);
    }
    return ids;
  }

  private sorted(): EventStreamItem[] {
    return [...this.items].sort(
      (left, right) =>
        left.event.timestamp.localeCompare(right.event.timestamp) ||
        left.id.localeCompare(right.id),
    );
  }

  read(query: EventStreamQuery = {}): Promise<EventStreamPage> {
    const limit = query.limit ?? 50;
    const sorted = this.sorted();
    let start = 0;
    if (query.cursor !== undefined) {
      const decoded = JSON.parse(
        Buffer.from(query.cursor.slice("cursor_".length), "base64url").toString("utf8"),
      ) as { id: string };
      const index = sorted.findIndex((item) => item.id === decoded.id);
      start = index === -1 ? 0 : index + 1;
    }
    const rest = sorted
      .slice(start)
      .filter(
        (item) =>
          (query.iterationId === undefined || item.event.iteration_id === query.iterationId) &&
          (query.workflowOperationId === undefined ||
            item.event.workflow_operation_id === query.workflowOperationId) &&
          (query.eventTypes === undefined ||
            (query.eventTypes as readonly string[]).includes(item.event.event_type)),
      );
    const pageItems = rest.slice(0, limit);
    const last = pageItems.at(-1);
    const cursor =
      last === undefined
        ? undefined
        : `cursor_${Buffer.from(JSON.stringify({ timestamp: last.event.timestamp, id: last.id })).toString("base64url")}`;
    return Promise.resolve({
      items: pageItems,
      ...(cursor === undefined ? {} : { cursor }),
      ...(rest.length > limit && cursor !== undefined ? { nextCursor: cursor } : {}),
    });
  }

  async *subscribe(query: EventStreamQuery = {}): AsyncIterable<EventStreamItem> {
    let cursor: string | undefined;
    while (true) {
      const page = await this.read({ ...query, ...(cursor === undefined ? {} : { cursor }) });
      for (const item of page.items) yield item;
      cursor = page.cursor ?? cursor;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }
}

function createLegacySubject(): EventStreamSubject {
  const adapter = new LegacyInMemoryEventStream();
  return {
    port: adapter,
    appendLive: (input) => {
      adapter.appendLive(input);
    },
    commitEvents: (specs) => Promise.resolve(adapter.commitEvents(specs)),
    dispose: () => undefined,
  };
}

const hubFactory: EventStreamHubFactory = {
  create: (source, options) => new EventStreamHub(source, options ?? {}),
};

describe("EventStreamPort conformance (v1 contract)", () => {
  it("passes the shared suite with the production FileEventStream", async () => {
    assertConformance(
      await runConformanceSuite({
        plugin: "runtime-file-event-stream",
        kind: "agent",
        cases: eventStreamPortConformanceCases(createFileSubject),
      }),
    );
  });

  it("passes the shared suite with a legacy Port-fallback Adapter", async () => {
    assertConformance(
      await runConformanceSuite({
        plugin: "legacy-in-memory-event-stream",
        kind: "agent",
        cases: eventStreamPortConformanceCases(createLegacySubject),
      }),
    );
  });
});

describe("IncrementalEventReader conformance (v2 contract)", () => {
  it("passes the incremental suite with the production FileEventStream", async () => {
    assertConformance(
      await runConformanceSuite({
        plugin: "runtime-file-event-stream-incremental",
        kind: "agent",
        cases: incrementalEventStreamConformanceCases(createFileSubject),
      }),
    );
  });
});

describe("EventStreamHub conformance", () => {
  it("passes the hub suite with the production Hub over the file-backed source", async () => {
    assertConformance(
      await runConformanceSuite({
        plugin: "dashboard-event-hub",
        kind: "agent",
        cases: eventStreamHubConformanceCases(createFileSubject, hubFactory),
      }),
    );
  }, 60_000);
});
