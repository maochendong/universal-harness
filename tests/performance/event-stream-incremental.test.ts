import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { FileEventStream } from "../../packages/runtime/src/index.js";

/**
 * Transparency/SSE performance gate (design §7.3, plan Task 1 Step 5).
 *
 * Datasets are real temporary Ledgers produced by
 * `scripts/generate-performance-dataset.mjs --mode=event-stream` at a fixed
 * seed. Every scenario warms 20 rounds and samples 200, matching the spec's
 * measurement definition. Machine-readable samples are written to
 * `docs/evidence/<date>-event-stream-perf.json` only when
 * `HARNESS_PERF_EVIDENCE=1` is set, so routine local/CI runs never overwrite
 * the committed reference sample that Task 6 references.
 *
 * The "4 caught-up clients share one scan" budget is not asserted here: the
 * EventStreamHub is Task 2 and does not exist yet.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const GENERATOR = join(repoRoot, "scripts/generate-performance-dataset.mjs");
const WARMUP_ROUNDS = 20;
const SAMPLE_ROUNDS = 200;
const MIB = 1024 * 1024;

interface ScenarioRecord {
  readonly name: string;
  readonly layout: "e" | "f";
  readonly files: number;
  readonly events: number;
  readonly [metric: string]: unknown;
}
const scenarios: ScenarioRecord[] = [];

const roots: string[] = [];
function root() {
  const path = mkdtempSync(join(tmpdir(), "harness-event-stream-perf-"));
  roots.push(path);
  return path;
}
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
afterAll(() => {
  const report = {
    name: "event-stream-incremental-performance",
    spec: "docs/superpowers/specs/2026-09-05-harness-transparency-sse-design.md#7.3",
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    method: {
      dataset_generator: "scripts/generate-performance-dataset.mjs --mode=event-stream",
      seed: 1,
      warmup_rounds: WARMUP_ROUNDS,
      sample_rounds: SAMPLE_ROUNDS,
      rss: "process.memoryUsage().rss delta over the 100k-event index build, measured in-process after global.gc() when --expose-gc is available",
      zero_reread:
        "fs.readFileSync/readSync spies count historical content bytes; JSON.parse spy excludes v2/legacy cursor decodes",
    },
    scenarios,
    skipped: [
      {
        name: "shared-scan-4-caught-up-clients",
        reason:
          "同布局空轮询 4 个已追平客户端共享扫描属于 Task 2；EventStreamHub 尚不存在，本任务不实现。",
      },
    ],
  };
  if (process.env.HARNESS_PERF_EVIDENCE !== "1") return;
  const date = new Date().toISOString().slice(0, 10);
  const path = join(repoRoot, "docs/evidence", `${date}-event-stream-perf.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
});

function generateDataset(
  out: string,
  options: { events: number; files: number; layout: "e" | "f" },
): void {
  execFileSync(
    process.execPath,
    [
      GENERATOR,
      "--mode=event-stream",
      "--out",
      out,
      "--events",
      String(options.events),
      "--files",
      String(options.files),
      "--layout",
      options.layout,
      "--seed",
      "1",
    ],
    { stdio: "pipe" },
  );
}

function percentile(samples: number[], ratio: number): number {
  return [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * ratio) - 1]!;
}

async function sampleWarmEmptyPolls(
  stream: FileEventStream,
  headCursor: string,
): Promise<number[]> {
  const samples: number[] = [];
  for (let round = 0; round < WARMUP_ROUNDS + SAMPLE_ROUNDS; round += 1) {
    const start = performance.now();
    const page = await stream.read({ cursor: headCursor });
    const elapsed = performance.now() - start;
    expect(page.items).toEqual([]);
    if (round >= WARMUP_ROUNDS) samples.push(elapsed);
  }
  return samples;
}

describe("event stream incremental cost", () => {
  it("keeps F-layout discovery polling at or below 200ms p95 for 1k and 10k manifest-shard pairs", async () => {
    for (const files of [1_000, 10_000]) {
      const projectRoot = root();
      generateDataset(projectRoot, { events: files, files, layout: "f" });
      const stream = new FileEventStream(projectRoot);
      const view = await stream.refreshView();
      const samples = await sampleWarmEmptyPolls(stream, view.headCursor);
      const record: ScenarioRecord = {
        name: "f-layout-discovery-poll",
        layout: "f",
        files,
        events: files,
        p50_ms: percentile(samples, 0.5),
        p95_ms: percentile(samples, 0.95),
        max_ms: Math.max(...samples),
        threshold_ms: 200,
      };
      scenarios.push(record);
      console.info(`F-layout discovery poll (files=${String(files)}):`, JSON.stringify(record));
      expect(record.p95_ms).toBeLessThanOrEqual(200);
    }
  }, 300_000);

  it("builds the 100k-event index within a 256 MiB RSS delta over the warmed empty index", async () => {
    const gc = (globalThis as { gc?: () => void }).gc;
    const emptyStream = new FileEventStream(root());
    await emptyStream.refreshView();
    gc?.();
    gc?.();
    const baseline = process.memoryUsage().rss;
    const projectRoot = root();
    generateDataset(projectRoot, { events: 100_000, files: 100, layout: "e" });
    const stream = new FileEventStream(projectRoot);
    const view = await stream.refreshView();
    expect(view.read({ limit: 1 }).items).toHaveLength(1);
    gc?.();
    gc?.();
    const after = process.memoryUsage().rss;
    const record: ScenarioRecord = {
      name: "e-layout-index-rss",
      layout: "e",
      files: 100,
      events: 100_000,
      rss_baseline_bytes: baseline,
      rss_after_bytes: after,
      rss_delta_bytes: after - baseline,
      rss_delta_mib: (after - baseline) / MIB,
      gc_available: gc !== undefined,
      threshold_mib: 256,
    };
    scenarios.push(record);
    console.info("100k-event index RSS:", JSON.stringify(record));
    expect(after - baseline).toBeLessThanOrEqual(256 * MIB);
  }, 180_000);

  it("reads zero historical bytes and parses zero historical records after warmup", async () => {
    const projectRoot = root();
    generateDataset(projectRoot, { events: 1_000, files: 1_000, layout: "f" });
    const stream = new FileEventStream(projectRoot);
    const view = await stream.refreshView();
    let contentBytes = 0;
    const readFileSyncOriginal = fs.readFileSync;
    const wholeReads = vi.spyOn(fs, "readFileSync").mockImplementation(((
      ...args: Parameters<typeof fs.readFileSync>
    ) => {
      const result = readFileSyncOriginal(...args);
      contentBytes += typeof result === "string" ? Buffer.byteLength(result) : result.byteLength;
      return result;
    }) as typeof fs.readFileSync);
    const readSyncOriginal = fs.readSync;
    const rangeReads = vi.spyOn(fs, "readSync").mockImplementation(((
      ...args: Parameters<typeof fs.readSync>
    ) => {
      const read = readSyncOriginal(...args);
      contentBytes += read;
      return read;
    }) as typeof fs.readSync);
    // v2/legacy cursor decodes are not historical content parses.
    let historyParses = 0;
    const parseOriginal = JSON.parse;
    vi.spyOn(JSON, "parse").mockImplementation(((text: string, reviver?: never) => {
      if (
        typeof text === "string" &&
        !text.startsWith('{"version":2') &&
        !text.startsWith('{"timestamp"')
      )
        historyParses += 1;
      return parseOriginal(text, reviver);
    }) as typeof JSON.parse);
    syncBuiltinESMExports();
    const page = await stream.read({ cursor: view.headCursor });
    expect(page.items).toEqual([]);
    // A fixed-upper-bound view serves the whole captured history from memory.
    expect(view.read({ untilCursor: view.headCursor, limit: 500 }).items).toHaveLength(500);
    expect(wholeReads).not.toHaveBeenCalled();
    expect(rangeReads).not.toHaveBeenCalled();
    expect(contentBytes).toBe(0);
    expect(historyParses).toBe(0);
    scenarios.push({
      name: "warm-poll-zero-history-reread",
      layout: "f",
      files: 1_000,
      events: 1_000,
      read_file_sync_calls: wholeReads.mock.calls.length,
      read_sync_calls: rangeReads.mock.calls.length,
      history_content_bytes: contentBytes,
      history_parse_count: historyParses,
    });
  }, 120_000);
});
