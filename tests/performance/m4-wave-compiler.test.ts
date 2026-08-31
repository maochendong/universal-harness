import { describe, expect, it } from "vitest";

import { contentDigest } from "../../packages/core/src/index.js";
import type { Protocol13TaskSpecification } from "../../packages/runtime/src/planning/task.js";
import { compileParallelWaves } from "../../packages/runtime/src/planning/waves.js";

import { measure, summarizeSamples } from "./helpers.js";

/**
 * M4 wave compiler performance gate (design 25, plan Task 3 step 6): a fixed
 * 1,000-Task fixture with mixed dependencies, write/write overlaps and
 * exclusive-resource conflicts must compile in p95 < 500ms over 20 warm
 * runs, and two compilations of the same fixture must digest identically.
 */
const TASK_COUNT = 1_000;
const WARM_RUNS = 20;

function buildFixture(): readonly Protocol13TaskSpecification[] {
  return Array.from({ length: TASK_COUNT }, (_, index) => {
    const dependencies: string[] = [];
    if (index > 0 && index % 4 === 0) {
      dependencies.push(`task_${String(index - 1).padStart(4, "0")}`);
    }
    if (index >= 8 && index % 16 === 0) {
      dependencies.push(`task_${String(index - 8).padStart(4, "0")}`);
    }
    const module = `src/module-${String(index % 100)}`;
    const writePaths = [module];
    if (index % 100 < 10) writePaths.push(`${module}/inner`);
    return {
      id: `task_${String(index).padStart(4, "0")}`,
      objective: `deliver slice ${String(index)}`,
      impact_paths: [["edge-1"]],
      expected_outputs: [`code_${String(index)}`],
      capabilities: [],
      tools: [],
      dependencies,
      risk: "low" as const,
      budget: { steps: 8, tokens: 4_000, duration_ms: 60_000 },
      write_paths: writePaths,
      exclusive_resources: index % 5 === 0 ? [`resource-${String(index % 17)}`] : [],
      acceptance: [{ description: "the output verifies", verification: "gate:test" }],
      required_gates: ["gate:test"],
    };
  });
}

describe("m4 wave compiler performance gate", () => {
  it("compiles 1,000 mixed tasks below the p95 threshold and deterministically", () => {
    const tasks = buildFixture();
    expect(tasks).toHaveLength(TASK_COUNT);
    // Warm up before measuring.
    const reference = compileParallelWaves(tasks);
    expect(contentDigest(compileParallelWaves(tasks))).toBe(contentDigest(reference));
    const samples: number[] = [];
    for (let run = 0; run < WARM_RUNS; run += 1) {
      const { result, elapsedMs } = measure(() => compileParallelWaves(tasks));
      expect(contentDigest(result)).toBe(contentDigest(reference));
      samples.push(elapsedMs);
    }
    const summary = summarizeSamples(samples);
    expect(summary.samples).toBe(WARM_RUNS);
    expect(summary.p95_ms).toBeLessThan(500);
  });
});
