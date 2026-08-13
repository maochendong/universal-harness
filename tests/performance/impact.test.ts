import { describe, expect, it } from "vitest";

import { contentDigest } from "../../packages/core/src/index.js";
import {
  generateImpactSet,
  propagateImpact,
  type PropagationReach,
} from "../../packages/graph/src/index.js";

import { loadDataset, measure, summarizeSamples } from "./helpers.js";

/**
 * Warm Impact query gate (design 16.2, plan Task 27 step 4): on the 20k/100k
 * dataset a warm-cache impact propagation must stay below the two-second p95
 * hard threshold, and identical input must produce identical reach sets,
 * entry orders and ImpactSet digests.
 */
const WARM_RUNS = 25;
const P95_HARD_THRESHOLD_MS = 2_000;
const SEED_NODE_ID = "requirement_r00000";

describe("warm impact query performance", () => {
  it("keeps warm propagation p95 below two seconds on the 20k/100k dataset", () => {
    const { nodes, edges } = loadDataset();

    // Warm the cache: indexes and runtime code paths are hot before measuring.
    const warmup = propagateImpact(SEED_NODE_ID, nodes, edges);
    expect(warmup.length).toBeGreaterThan(1);

    const samples: number[] = [];
    let reference: PropagationReach[] = warmup;
    for (let run = 0; run < WARM_RUNS; run += 1) {
      const { result, elapsedMs } = measure(() => propagateImpact(SEED_NODE_ID, nodes, edges));
      samples.push(elapsedMs);
      // Determinism: every warm run reproduces the reference reach set exactly.
      expect(result).toEqual(reference);
      reference = result;
    }

    const summary = summarizeSamples(samples);
    expect(
      summary.p95_ms,
      `warm impact p95 ${String(summary.p95_ms)}ms exceeds ${String(P95_HARD_THRESHOLD_MS)}ms`,
    ).toBeLessThan(P95_HARD_THRESHOLD_MS);
  }, 120_000);

  it("produces a stable ImpactSet digest for identical input", () => {
    const { nodes, edges } = loadDataset();
    const context = {
      iterationId: "iteration_perf",
      actor: "performance-gate",
      timestamp: "2026-08-01T00:00:00.000Z",
    };
    const seed = {
      id: "seed_perf01",
      nodeId: SEED_NODE_ID,
      kind: "content-change" as const,
      iterationKind: "feature" as const,
      reason: "changed requirement",
    };
    const first = generateImpactSet([seed], nodes, edges, context);
    const second = generateImpactSet([seed], nodes, edges, context);
    expect(second).toEqual(first);
    const rest: Record<string, unknown> = { ...second };
    delete rest.digest;
    expect(contentDigest(rest)).toBe(second.digest);
  }, 120_000);
});
