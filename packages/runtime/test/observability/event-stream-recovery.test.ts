import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  renameSync,
  utimesSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalizeJson,
  LedgerRepository,
  type LifecycleEvent,
} from "@universal-harness-internal/core";

import { FileEventStream, FileLiveSpool, readLiveObservations } from "../../src/index.js";

const roots: string[] = [];
const timestamp = "2026-09-08T00:00:00.000Z";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "harness-stream-recovery-"));
  roots.push(root);
  return { root, stream: new FileEventStream(root), spool: new FileLiveSpool(root) };
}
const livePath = (root: string): string =>
  join(root, ".harness/cache/event-stream/stream_test/segment-000001.jsonl");
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

  it("pages a committed batch by numeric sequence even when event ids sort in reverse", async () => {
    const { root, stream } = fixture();
    const repository = new LedgerRepository({
      projectRoot: root,
      readBaseline: () => "abcdef0123456789",
      now: () => timestamp,
    });
    await repository.commit({
      ledger_operation_id: "ledger_reverse_ids",
      workflow_operation_id: "workflow_test",
      attempt_id: "attempt_test",
      expected_baseline: "abcdef0123456789",
      artifacts: [],
      edges: [],
      events: Array.from({ length: 12 }, (_, index): LifecycleEvent => {
        const sequence = index + 1;
        return {
          protocol_version: "1.0.0",
          record_kind: "event",
          // Descending ids: lexicographic order is the reverse of sequence order.
          event_id: `event_${String(12 - index).padStart(3, "0")}`,
          event_type: "OperationStarted",
          project_id: "project_test",
          iteration_id: "iteration_test",
          workflow_operation_id: "workflow_test",
          ledger_operation_id: "ledger_reverse_ids",
          sequence,
          timestamp,
          payload: {},
        };
      }),
    });
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

  it("exposes a committed batch atomically and exactly once after a retried commit", async () => {
    const { root, stream } = fixture();
    let fail = true;
    const repository = new LedgerRepository({
      projectRoot: root,
      readBaseline: () => "abcdef0123456789",
      now: () => timestamp,
      hooks: {
        atBoundary(boundary) {
          if (fail && boundary === "shards.renamed") throw new Error("fault_before_manifest");
        },
      },
    });
    const makeInput = () => ({
      ledger_operation_id: "ledger_atomic",
      workflow_operation_id: "workflow_test",
      attempt_id: "attempt_test",
      expected_baseline: "abcdef0123456789",
      artifacts: [],
      edges: [],
      events: [1, 2, 3].map((sequence): LifecycleEvent => ({
        protocol_version: "1.0.0",
        record_kind: "event",
        event_id: `event_atomic_${String(sequence)}`,
        event_type: "OperationStarted",
        project_id: "project_test",
        iteration_id: "iteration_test",
        workflow_operation_id: "workflow_test",
        ledger_operation_id: "ledger_atomic",
        sequence,
        timestamp,
        payload: {},
      })),
    });
    await expect(repository.commit(makeInput())).rejects.toThrow("fault_before_manifest");
    expect(repository.operations()).toEqual([]);
    expect((await stream.read()).items.filter((item) => item.authoritative)).toEqual([]);
    fail = false;
    await repository.commit(makeInput());
    const page = await stream.read({ limit: 500 });
    const ids = page.items.filter((item) => item.authoritative).map((item) => item.id);
    expect(ids).toEqual([
      "ledger:event_atomic_1",
      "ledger:event_atomic_2",
      "ledger:event_atomic_3",
    ]);
  });

  it("pages a captured view precisely from its first item cursor to its head", async () => {
    const { stream, spool } = fixture();
    for (let index = 1; index <= 3; index += 1) append(spool, `key_${String(index)}`);
    const view = await stream.refreshView();
    const first = view.read({ limit: 1, untilCursor: view.headCursor });
    expect(first.itemCursors?.[0]).toBe(first.cursor);
    const rest = view.read({ cursor: first.cursor, untilCursor: view.headCursor, limit: 500 });
    expect(rest.reset).toBeUndefined();
    expect(rest.items.map((item) => item.event.sequence)).toEqual([2, 3]);
  });

  it("treats a larger rename replacement as a rewrite, not an append", async () => {
    const { root, stream, spool } = fixture();
    const first = append(spool, "key_first");
    const warm = await stream.read();
    const path = livePath(root);
    writeFileSync(
      `${path}.replacement`,
      `${canonicalizeJson(first)}\n${canonicalizeJson({ ...first, sequence: 2, observation_key: "key_second" })}\n`,
    );
    renameSync(`${path}.replacement`, path);
    const page = await stream.read({ cursor: warm.cursor });
    expect(page.reset).toBeUndefined();
    expect(page.items.map((item) => item.event.sequence)).toEqual([2]);
    expect((await stream.read()).items).toHaveLength(2);
  });

  it("rereads a shrunk live file and resets readers anchored past the truncation", async () => {
    const { root, stream, spool } = fixture();
    const first = append(spool, "key_first");
    append(spool, "key_second");
    const warm = await stream.read();
    writeFileSync(livePath(root), `${canonicalizeJson(first)}\n`);
    const page = await stream.read({ cursor: warm.cursor });
    expect(page.reset).toBe(true);
    expect(page.items.map((item) => item.event.sequence)).toEqual([1]);
  });

  it("drops a deleted live file instead of replaying cached records", async () => {
    const { root, stream, spool } = fixture();
    append(spool, "key_first");
    const warm = await stream.read();
    rmSync(livePath(root));
    const page = await stream.read({ cursor: warm.cursor });
    expect(page.reset).toBe(true);
    expect(page.items).toEqual([]);
    expect((await stream.read()).items).toEqual([]);
  });

  it("rereads a live file whose mtime moved backward instead of trusting the byte offset", async () => {
    const { root, stream, spool } = fixture();
    const first = append(spool, "key_first");
    const warm = await stream.read();
    const path = livePath(root);
    appendFileSync(
      path,
      `${JSON.stringify({ ...first, sequence: 2, observation_key: "key_second" })}\n`,
    );
    const past = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(path, past, past);
    const page = await stream.read({ cursor: warm.cursor });
    expect(page.items.map((item) => item.event.sequence)).toEqual([2]);
    expect((await stream.read()).items).toHaveLength(2);
  });

  it("rereads a live file rotated between stat and open instead of trusting stale metadata", async () => {
    const { root, stream, spool } = fixture();
    const first = append(spool, "key_first");
    const warm = await stream.read();
    const path = livePath(root);
    appendFileSync(
      path,
      `${JSON.stringify({ ...first, sequence: 2, observation_key: "key_second" })}\n`,
    );
    let swapped = false;
    const realOpenSync = fs.openSync.bind(fs);
    vi.spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (!swapped && String(args[0]) === path) {
        swapped = true;
        writeFileSync(
          `${path}.rotated`,
          `${canonicalizeJson(first)}\n${canonicalizeJson({ ...first, sequence: 3, observation_key: "key_third" })}\n`,
        );
        renameSync(`${path}.rotated`, path);
      }
      return realOpenSync(...args);
    });
    syncBuiltinESMExports();
    const page = await stream.read({ cursor: warm.cursor });
    expect(swapped).toBe(true);
    expect(page.items.map((item) => item.event.sequence)).toEqual([3]);
    expect((await stream.read()).items.map((item) => item.event.sequence)).toEqual([1, 3]);
  });

  it("skips corrupt complete live lines without hiding later valid lines", async () => {
    const { root, stream, spool } = fixture();
    append(spool, "key_valid");
    const path = livePath(root);
    const valid = readFileSync(path);
    writeFileSync(
      path,
      Buffer.concat([Buffer.from("not json at all\n"), Buffer.from('{"broken":true}\n'), valid]),
    );
    const page = await stream.read();
    expect(page.items.map((item) => item.id)).toEqual(["live:stream_test:1"]);
  });
});
