import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkGraphCache, materializeLedger } from "../../packages/graph/src/index.js";

import { buildSyntheticLedger, loadDataset, measure } from "./helpers.js";

/**
 * Full SQLite rebuild gate (design 16.2, plan Task 27 step 4): rebuilding the
 * complete projection from the authoritative ledger on the 20k/100k dataset
 * must stay below the 30-second hard threshold, and two rebuilds of the same
 * ledger must produce the identical projection digest (AC5/AC22).
 */
const REBUILD_HARD_THRESHOLD_MS = 30_000;

const created: string[] = [];

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "harness-perf-rebuild-"));
  created.push(directory);
  return directory;
}

afterEach(() => {
  while (created.length > 0) {
    const directory = created.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
}, 300_000);

describe("full sqlite rebuild performance", () => {
  it("rebuilds the 20k/100k projection within 30 seconds, deterministically", () => {
    const projectRoot = makeTempDir();
    buildSyntheticLedger(projectRoot, loadDataset());

    const databasePath = join(projectRoot, "graph-cache.sqlite");
    const first = measure(() => materializeLedger({ projectRoot, databasePath }));
    expect(first.result.report.nodeCount).toBe(20_000);
    expect(first.result.report.edgeCount).toBe(100_000);
    expect(
      first.elapsedMs,
      `full rebuild took ${String(Math.round(first.elapsedMs))}ms, threshold ${String(REBUILD_HARD_THRESHOLD_MS)}ms`,
    ).toBeLessThan(REBUILD_HARD_THRESHOLD_MS);
    first.result.database.close();
    expect(checkGraphCache(databasePath).status).toBe("ok");

    // A second rebuild of the same ledger must project the identical state.
    const second = measure(() => materializeLedger({ projectRoot, databasePath }));
    expect(second.result.report.projectionDigest).toBe(first.result.report.projectionDigest);
    second.result.database.close();
  }, 300_000);
});
