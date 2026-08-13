import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LedgerRepository } from "../../packages/core/src/index.js";
import { BASELINE, FIXED_NOW, makeInput } from "../../packages/core/test/ledger/fixtures.js";

import { recordBaseline, summarizeSamples } from "./helpers.js";

/**
 * Ledger transaction commit baseline (design 16.2, plan Task 27 step 5): M1
 * defines no invented hard threshold for commit latency; the gate instead
 * requires a recorded, reproducible p50/p95/max baseline with the operation
 * scale and CI environment. A missing baseline blocks release.
 */
const COMMIT_RUNS = 40;

const created: string[] = [];

afterEach(() => {
  while (created.length > 0) {
    const directory = created.pop();
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

describe("ledger commit baseline", () => {
  it("records p50/p95/max over real commits with scale and environment", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "harness-perf-commit-"));
    created.push(projectRoot);
    const repository = new LedgerRepository({
      projectRoot,
      readBaseline: () => BASELINE,
      now: () => FIXED_NOW,
    });

    const samples: number[] = [];
    for (let index = 0; index < COMMIT_RUNS; index += 1) {
      const input = makeInput(`ledger-op_perf${String(index).padStart(3, "0")}`);
      const started = performance.now();
      const outcome = await repository.commit(input);
      samples.push(performance.now() - started);
      expect(outcome.status).toBe("committed");
    }

    const summary = summarizeSamples(samples);
    const path = recordBaseline("ledger-commit", {
      metric: "ledger_transaction_commit",
      timing: summary,
      operation_scale: {
        operations: COMMIT_RUNS,
        artifacts_per_operation: 1,
        edges_per_operation: 1,
        events_per_operation: 1,
      },
    });
    const recorded = JSON.parse(readFileSync(path, "utf8")) as {
      timing: { p50_ms: number; p95_ms: number; max_ms: number };
      operation_scale: { operations: number };
      environment: { platform: string; ci: boolean };
    };
    expect(recorded.timing.p50_ms).toBeGreaterThanOrEqual(0);
    expect(recorded.timing.p95_ms).toBeGreaterThanOrEqual(recorded.timing.p50_ms);
    expect(recorded.timing.max_ms).toBeGreaterThanOrEqual(recorded.timing.p95_ms);
    expect(recorded.operation_scale.operations).toBe(COMMIT_RUNS);
    expect(typeof recorded.environment.platform).toBe("string");

    // The committed ledger replays every operation exactly once.
    expect(repository.operations()).toHaveLength(COMMIT_RUNS);
  }, 120_000);
});
