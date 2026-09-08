import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  renameSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LedgerRepository } from "@universal-harness-internal/core";

import { FileEventStream, FileLiveSpool, readLiveObservations } from "../../src/index.js";

const roots: string[] = [];
const timestamp = "2026-09-08T00:00:00.000Z";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "harness-stream-recovery-"));
  roots.push(root);
  return { root, stream: new FileEventStream(root), spool: new FileLiveSpool(root) };
}
function append(spool: FileLiveSpool, key: string, at = timestamp) {
  return spool.append({
    streamId: "stream_test",
    observationKey: key,
    eventType: "RunHeartbeat",
    projectId: "project_test",
    iterationId: "iteration_test",
    workflowOperationId: "workflow_test",
    timestamp: at,
    payload: {},
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("event stream recovery", () => {
  it("delivers every numeric sequence when twelve same-time events are paged one at a time", async () => {
    const { stream, spool } = fixture();
    for (let index = 1; index <= 12; index += 1) append(spool, `key_${String(index)}`);
    const seen: number[] = [];
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
      const page = await stream.read({ limit: 1, ...(cursor ? { cursor } : {}) });
      if (page.items.length === 0) break;
      seen.push(page.items[0]!.event.sequence);
      cursor = page.cursor;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("does not expose a published shard before its manifest is committed", async () => {
    const { root, stream } = fixture();
    const repository = new LedgerRepository({
      projectRoot: root,
      readBaseline: () => "abcdef0123456789",
      now: () => timestamp,
      hooks: {
        atBoundary(boundary) {
          if (boundary === "shards.renamed") throw new Error("before_manifest");
        },
      },
    });
    await expect(
      repository.commit({
        ledger_operation_id: "ledger_test",
        workflow_operation_id: "workflow_test",
        attempt_id: "attempt_test",
        expected_baseline: "abcdef0123456789",
        artifacts: [],
        edges: [],
        events: [
          {
            protocol_version: "1.0.0",
            record_kind: "event",
            event_id: "event_test",
            event_type: "OperationStarted",
            project_id: "project_test",
            iteration_id: "iteration_test",
            workflow_operation_id: "workflow_test",
            ledger_operation_id: "ledger_test",
            sequence: 1,
            timestamp,
            payload: {},
          },
        ],
      }),
    ).rejects.toThrow("before_manifest");
    expect(repository.operations()).toEqual([]);
    expect((await stream.read()).items).toEqual([]);
  });

  it("does not reread unchanged historical bytes after warming the stream", async () => {
    const { stream, spool } = fixture();
    append(spool, "key_first");
    await stream.read();
    const wholeReads = vi.spyOn(fs, "readFileSync");
    const rangeReads = vi.spyOn(fs, "readSync");
    syncBuiltinESMExports();
    await stream.read();
    await stream.read();
    expect(wholeReads).not.toHaveBeenCalled();
    expect(rangeReads).not.toHaveBeenCalled();
  });

  it("appends a live heartbeat without rereading all retained records", () => {
    const { spool } = fixture();
    append(spool, "key_first");
    const reads = vi.spyOn(fs, "readFileSync");
    syncBuiltinESMExports();
    append(spool, "key_second");
    expect(reads).not.toHaveBeenCalled();
  });

  it("delivers late timestamps after the last delivered position", async () => {
    const { stream, spool } = fixture();
    append(spool, "key_first");
    const first = await stream.read();
    append(spool, "key_late", "2026-09-07T00:00:00.000Z");
    expect((await stream.read({ cursor: first.cursor })).items.map((item) => item.id)).toEqual([
      "live:stream_test:2",
    ]);
  });

  it("waits for the complete UTF-8 tail before exposing an observation", async () => {
    const { root, stream, spool } = fixture();
    const event = append(spool, "key_first");
    const path = join(root, ".harness/cache/event-stream/stream_test/segment-000001.jsonl");
    const bytes = Buffer.from(
      `${JSON.stringify({ ...event, sequence: 2, observation_key: "key_tail", payload: { summary: "中文" } })}\n`,
    );
    const split = bytes.indexOf(Buffer.from("中文")) + 1;
    appendFileSync(path, bytes.subarray(0, split));
    const first = await stream.read();
    expect(first.items).toHaveLength(1);
    appendFileSync(path, bytes.subarray(split));
    const next = await stream.read({ cursor: first.cursor });
    expect(next.items[0]?.event.payload).toEqual({ summary: "中文" });
  });

  it("resets old generations on restart, including subscribers with a legacy cursor", async () => {
    const { root, stream, spool } = fixture();
    append(spool, "key_first");
    const page = await stream.read();
    const restarted = new FileEventStream(root);
    expect((await restarted.read({ cursor: page.cursor })).reset).toBe(true);
    const cursor = `cursor_${Buffer.from(JSON.stringify({ timestamp, id: "live:stream_test:1" })).toString("base64url")}`;
    const subscription = restarted.subscribe({ cursor })[Symbol.asyncIterator]();
    expect((await subscription.next()).value?.id).toBe("live:stream_test:1");
    await subscription.return?.();
  });

  it("holds a captured read view at its head without doing more file I/O", async () => {
    const { stream, spool } = fixture();
    append(spool, "key_first");
    const view = await stream.refreshView();
    append(spool, "key_second");
    await stream.refreshView();
    expect(view.read().items).toHaveLength(1);
    expect((await stream.read({ untilCursor: view.headCursor })).items).toHaveLength(1);
    expect((await stream.read({ cursor: view.headCursor })).items[0]?.event.sequence).toBe(2);
  });

  it("resets after an atomic same-length live replacement instead of trusting the old byte offset", async () => {
    const { root, stream, spool } = fixture();
    const event = append(spool, "key_first");
    const first = await stream.read();
    const path = join(root, ".harness/cache/event-stream/stream_test/segment-000001.jsonl");
    writeFileSync(`${path}.replacement`, `${JSON.stringify({ ...event, sequence: 2 })}\n`);
    renameSync(`${path}.replacement`, path);
    const page = await stream.read({ cursor: first.cursor });
    expect(page.reset).toBe(true);
    expect(page.items.map((item) => item.event.sequence)).toEqual([2]);
  });

  it("keeps byte and record limits after a writer restart or another writer append", () => {
    const { root } = fixture();
    const spool = new FileLiveSpool(root, { maxRecords: 2, maxBytes: 900 });
    append(spool, "key_first");
    const restarted = new FileLiveSpool(root, { maxRecords: 2, maxBytes: 900 });
    expect(append(restarted, "key_second").sequence).toBe(2);
    expect(append(spool, "key_third").sequence).toBe(3);
    expect(readLiveObservations(root).map((event) => event.sequence)).toEqual([2, 3]);
    const path = join(root, ".harness/cache/event-stream/stream_test/segment-000001.jsonl");
    expect(readFileSync(path).length).toBeLessThanOrEqual(900);
    writeFileSync(`${path}.replacement`, readFileSync(path));
    renameSync(`${path}.replacement`, path);
    expect(append(spool, "key_fourth").sequence).toBe(4);
    expect(readLiveObservations(root).map((event) => event.sequence)).toEqual([3, 4]);
  });

  it("preserves a live resume anchor after promotion and fails closed on warm ledger corruption", async () => {
    const { root, stream, spool } = fixture();
    append(spool, "key_promoted");
    const first = await stream.read();
    const repository = new LedgerRepository({
      projectRoot: root,
      readBaseline: () => "abcdef0123456789",
      now: () => timestamp,
    });
    await repository.commit({
      ledger_operation_id: "ledger_promoted",
      workflow_operation_id: "workflow_test",
      attempt_id: "attempt_test",
      expected_baseline: "abcdef0123456789",
      events: [
        {
          protocol_version: "1.0.0",
          record_kind: "event",
          event_id: "event_promoted",
          event_type: "GateCompleted",
          project_id: "project_test",
          iteration_id: "iteration_test",
          workflow_operation_id: "workflow_test",
          ledger_operation_id: "ledger_promoted",
          sequence: 1,
          timestamp,
          payload: { observation_key: "key_promoted" },
        },
      ],
    });
    const promoted = await stream.read({ cursor: first.cursor });
    expect(promoted.reset).toBeUndefined();
    expect(promoted.items.map((item) => item.id)).toEqual(["ledger:event_promoted"]);
    const view = await stream.refreshView();
    const operation = repository.operations()[0]!;
    const shard = join(root, ".harness", operation.manifest.event_file);
    const original = readFileSync(shard);
    appendFileSync(shard, "{}\n");
    await expect(stream.read({ cursor: promoted.cursor })).rejects.toThrow("digest mismatch");
    writeFileSync(shard, original);
    expect((await stream.read({ cursor: promoted.cursor })).reset).toBe(true);
    expect(view.read().reset).toBe(true);
    rmSync(operation.manifestPath);
    const removed = await stream.read({ cursor: promoted.cursor });
    expect(removed.reset).toBe(true);
    expect(removed.items.every((item) => item.source === "live")).toBe(true);
  });
});
