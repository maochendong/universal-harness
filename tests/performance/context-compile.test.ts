import { describe, expect, it } from "vitest";

import {
  compileContextBundle,
  type BundleBindings,
  type ContextCandidate,
  type SourceTier,
} from "../../packages/runtime/src/index.js";

import { loadDataset, measure, summarizeSamples } from "./helpers.js";

/**
 * Single-task ContextBundle compile gate (design 16.2, plan Task 27 step 4):
 * compiling one task's bundle against dataset-scale sources must stay below
 * the three-second p95 hard threshold, and identical input must reproduce the
 * identical manifest and digest.
 */
const COMPILE_RUNS = 25;
const P95_HARD_THRESHOLD_MS = 3_000;
const CANDIDATE_COUNT = 400;
const TOKEN_BUDGET = 200_000;

/** Deterministic pseudo-content, ~2 KB per candidate, ASCII only. */
function sourceContent(nodeId: string, index: number): string {
  const line = `section ${String(index)} of ${nodeId}: deterministic performance gate content.`;
  return new Array(24).fill(line).join("\n");
}

function candidates(): ContextCandidate[] {
  const { nodes } = loadDataset();
  return nodes.slice(0, CANDIDATE_COUNT).map((node, index) => ({
    node,
    content: sourceContent(node.id, index),
    tier: ((index % 5) + 1) as SourceTier,
    reason: `candidate ${String(index)} for the measured task`,
  }));
}

const BINDINGS = {
  requirement_baseline_digest: "a".repeat(64),
  policy_digest: "b".repeat(64),
  plan_digest: "c".repeat(64),
  impact_coverage_digest: "e".repeat(64),
  task_digest: "f".repeat(64),
  approval_digests: ["d".repeat(64)],
} satisfies BundleBindings;

describe("single-task context bundle compile performance", () => {
  it("keeps compile p95 below three seconds and reproduces the exact manifest", () => {
    const input = {
      taskId: "task_perf01",
      goal: "measure context compilation at dataset scale",
      bindings: BINDINGS,
      tokenBudget: TOKEN_BUDGET,
      candidates: candidates(),
    };

    const warmup = compileContextBundle(input);
    expect(warmup.manifest.entries.length).toBeGreaterThan(0);

    const samples: number[] = [];
    for (let run = 0; run < COMPILE_RUNS; run += 1) {
      const { result, elapsedMs } = measure(() => compileContextBundle(input));
      samples.push(elapsedMs);
      // Determinism: identical input reproduces the identical bundle identity.
      expect(result.manifest).toEqual(warmup.manifest);
      expect(result.record.digest).toBe(warmup.record.digest);
    }

    const summary = summarizeSamples(samples);
    expect(
      summary.p95_ms,
      `context compile p95 ${String(summary.p95_ms)}ms exceeds ${String(P95_HARD_THRESHOLD_MS)}ms`,
    ).toBeLessThan(P95_HARD_THRESHOLD_MS);
  }, 120_000);
});
