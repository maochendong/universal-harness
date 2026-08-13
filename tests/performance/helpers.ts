import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildManifest,
  canonicalizeJson,
  edgeShardRelativePath,
  eventShardRelativePath,
  harnessRootFor,
  operationManifestRelativePath,
  resolveHarnessPath,
  sha256Hex,
  type EdgeRecord,
  type LedgerOperation,
  type NodeRecord,
} from "../../packages/core/src/index.js";

/**
 * Shared plumbing for the M1 performance release gate (design 16.2, plan
 * Task 27): dataset loading through the deterministic generator script,
 * timing statistics, baseline summary persistence and a synthetic ledger
 * builder that lays down the 20k/100k dataset as a valid `.harness` ledger
 * so the real materializer can be measured end to end.
 */
export interface PerformanceDataset {
  readonly nodes: NodeRecord[];
  readonly edges: EdgeRecord[];
  readonly manifest: DatasetManifest;
}

export interface DatasetManifest {
  readonly name: string;
  readonly version: number;
  readonly node_count: number;
  readonly edge_count: number;
  readonly nodes_digest: string;
  readonly edges_digest: string;
  readonly dataset_digest: string;
}

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CACHE_ROOT = join(REPO_ROOT, "node_modules", ".cache", "universal-harness");
const DATASET_DIR = join(CACHE_ROOT, "performance-dataset");
const BASELINE_DIR = join(CACHE_ROOT, "performance-baseline");
const GENERATOR_SCRIPT = join(REPO_ROOT, "scripts", "generate-performance-dataset.mjs");

/** Generate the dataset when missing, then load it. Content is deterministic. */
export function loadDataset(): PerformanceDataset {
  if (!existsSync(join(DATASET_DIR, "manifest.json"))) {
    execFileSync(process.execPath, [GENERATOR_SCRIPT, "--out", DATASET_DIR], { stdio: "pipe" });
  }
  const nodes = JSON.parse(readFileSync(join(DATASET_DIR, "nodes.json"), "utf8")) as NodeRecord[];
  const edges = JSON.parse(readFileSync(join(DATASET_DIR, "edges.json"), "utf8")) as EdgeRecord[];
  const manifest = JSON.parse(
    readFileSync(join(DATASET_DIR, "manifest.json"), "utf8"),
  ) as DatasetManifest;
  return { nodes, edges, manifest };
}

export interface TimingSummary {
  readonly samples: number;
  readonly min_ms: number;
  readonly p50_ms: number;
  readonly p95_ms: number;
  readonly max_ms: number;
  readonly total_ms: number;
}

/** Nearest-rank percentiles over wall-clock millisecond samples. */
export function summarizeSamples(samples: readonly number[]): TimingSummary {
  if (samples.length === 0) throw new Error("cannot summarize zero samples");
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (rank: number): number => {
    const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1),
    );
    return sorted[index] as number;
  };
  return {
    samples: sorted.length,
    min_ms: sorted[0] as number,
    p50_ms: percentile(50),
    p95_ms: percentile(95),
    max_ms: sorted[sorted.length - 1] as number,
    total_ms: sorted.reduce((sum, sample) => sum + sample, 0),
  };
}

export function measure<T>(run: () => T): { readonly result: T; readonly elapsedMs: number } {
  const started = performance.now();
  const result = run();
  return { result, elapsedMs: performance.now() - started };
}

/** CI environment recorded with every baseline so numbers stay comparable. */
export function environmentInfo(): Record<string, string | boolean> {
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    ci: process.env["CI"] === "true",
  };
}

/**
 * Persist a baseline summary for the release gate. A missing baseline blocks
 * release (design 16.2), so recording is part of the measured operation and
 * the written path is returned for assertions.
 */
export function recordBaseline(name: string, payload: Record<string, unknown>): string {
  mkdirSync(BASELINE_DIR, { recursive: true });
  const path = join(BASELINE_DIR, `${name}.json`);
  writeFileSync(
    path,
    `${JSON.stringify({ ...payload, environment: environmentInfo() }, null, 2)}\n`,
    "utf8",
  );
  return path;
}

const LEDGER_OPERATION_ID = "ledger-op_perfdata";
const LEDGER_BASELINE = "0123456789abcdef0123456789abcdef01234567";
const LEDGER_TIMESTAMP = "2026-08-01T00:00:00.000Z";
const LEDGER_MONTH = "2026-08";

/**
 * Lay down the dataset as a valid authoritative ledger: one node artifact
 * file per node, one edge shard with every edge, an empty event shard and a
 * digest-correct commit manifest. This is the same byte layout the
 * transaction engine publishes, so `materializeLedger` reads it unchanged.
 */
export function buildSyntheticLedger(
  projectRoot: string,
  dataset: PerformanceDataset,
): LedgerOperation {
  const harnessRoot = harnessRootFor(projectRoot);
  const artifactDigests: string[] = [];
  for (const node of dataset.nodes) {
    const content = `${canonicalizeJson(node)}\n`;
    artifactDigests.push(sha256Hex(content));
    const absolute = resolveHarnessPath(harnessRoot, `artifacts/nodes/${node.id}.json`);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
  const edgeContent =
    dataset.edges.length === 0
      ? ""
      : `${dataset.edges.map((edge) => canonicalizeJson(edge)).join("\n")}\n`;
  const eventContent = "";
  const edgeFile = edgeShardRelativePath(LEDGER_MONTH, LEDGER_OPERATION_ID);
  const eventFile = eventShardRelativePath(LEDGER_MONTH, LEDGER_OPERATION_ID);
  const edgeAbsolute = resolveHarnessPath(harnessRoot, edgeFile);
  mkdirSync(join(edgeAbsolute, ".."), { recursive: true });
  writeFileSync(edgeAbsolute, edgeContent, "utf8");
  const eventAbsolute = resolveHarnessPath(harnessRoot, eventFile);
  mkdirSync(join(eventAbsolute, ".."), { recursive: true });
  writeFileSync(eventAbsolute, eventContent, "utf8");

  const manifest = buildManifest({
    ledger_operation_id: LEDGER_OPERATION_ID,
    workflow_operation_id: "workflow-op_perfdata",
    attempt_id: "attempt_perfdata",
    baseline_commit: LEDGER_BASELINE,
    sequence: 1,
    artifact_digests: artifactDigests,
    edge_file: edgeFile,
    event_file: eventFile,
    edge_file_digest: sha256Hex(edgeContent),
    event_file_digest: sha256Hex(eventContent),
    committed_at: LEDGER_TIMESTAMP,
  });
  const manifestAbsolute = resolveHarnessPath(
    harnessRoot,
    operationManifestRelativePath(LEDGER_OPERATION_ID),
  );
  mkdirSync(join(manifestAbsolute, ".."), { recursive: true });
  writeFileSync(manifestAbsolute, `${canonicalizeJson(manifest)}\n`, "utf8");
  return manifest;
}

export { DATASET_DIR, GENERATOR_SCRIPT, LEDGER_BASELINE };
