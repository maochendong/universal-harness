import { describe, expect, it } from "vitest";

import type { Protocol13TaskSpecification } from "../../src/planning/task.js";
import { PlanningError } from "../../src/planning/validator.js";
import {
  assertParallelWaves,
  compileParallelWaves,
  writePathsOverlap,
} from "../../src/planning/waves.js";

/**
 * Deterministic wave compilation (M4 design 6.2, plan Task 3). Waves are a
 * pure function of the approved Task list: stable Kahn order with Plan
 * declaration order as the only tie-break, earliest-wave placement displaced
 * forward by write/write and exclusive-resource conflicts.
 */
function task(
  id: string,
  dependencies: readonly string[] = [],
  writePaths: readonly string[] = [],
  resources: readonly string[] = [],
): Protocol13TaskSpecification {
  return {
    id,
    objective: `deliver ${id}`,
    impact_paths: [["edge-1"]],
    expected_outputs: [`code_${id}`],
    capabilities: [],
    tools: [],
    dependencies,
    risk: "low",
    budget: { steps: 4, tokens: 1_000, duration_ms: 60_000 },
    write_paths: writePaths,
    exclusive_resources: resources,
    acceptance: [{ description: "the output verifies", verification: "gate:test" }],
    required_gates: ["gate:test"],
  };
}

function expectCompilerError(tasks: readonly Protocol13TaskSpecification[], kind: string): void {
  try {
    compileParallelWaves(tasks);
    expect.unreachable(`expected a PlanningError of kind ${kind}`);
  } catch (error) {
    expect(error).toBeInstanceOf(PlanningError);
    expect((error as PlanningError).kind).toBe(kind);
  }
}

describe("compileParallelWaves", () => {
  it("pins stable Kahn order and earliest-wave displacement", () => {
    const waves = compileParallelWaves([
      task("task_a", [], ["src/a"], []),
      task("task_b", [], ["src/b"], []),
      task("task_c", [], ["src/a/x"], []),
      task("task_d", ["task_c"], ["src/d"], []),
    ]);
    expect(waves).toEqual([
      { wave_index: 0, task_ids: ["task_a", "task_b"] },
      { wave_index: 1, task_ids: ["task_c"] },
      { wave_index: 2, task_ids: ["task_d"] },
    ]);
  });

  it("displaces exclusive-resource conflicts behind independent tasks", () => {
    const waves = compileParallelWaves([
      task("task_a", [], [], ["generated-client"]),
      task("task_b", [], ["src/b"], []),
      task("task_c", [], ["src/c"], ["generated-client"]),
    ]);
    expect(waves).toEqual([
      { wave_index: 0, task_ids: ["task_a", "task_b"] },
      { wave_index: 1, task_ids: ["task_c"] },
    ]);
  });

  it("computes earliest waves from actual dependency placement", () => {
    // task_c conflicts with task_a and is displaced to wave 1; its dependent
    // task_d must recompute from the actual wave, not the theoretical one.
    const waves = compileParallelWaves([
      task("task_a", [], ["src/a"], []),
      task("task_c", [], ["src/a/x"], []),
      task("task_d", ["task_c"], ["src/d"], []),
    ]);
    expect(waves).toEqual([
      { wave_index: 0, task_ids: ["task_a"] },
      { wave_index: 1, task_ids: ["task_c"] },
      { wave_index: 2, task_ids: ["task_d"] },
    ]);
  });

  it("uses Plan declaration order as the stable tie-break", () => {
    const waves = compileParallelWaves([
      task("task_b", [], ["src/b"], []),
      task("task_a", [], ["src/a"], []),
    ]);
    expect(waves).toEqual([{ wave_index: 0, task_ids: ["task_b", "task_a"] }]);
  });

  it("keeps ancestor and descendant write paths apart in both directions", () => {
    expect(writePathsOverlap("src/a", "src/a")).toBe(true);
    expect(writePathsOverlap("src/a", "src/a/x")).toBe(true);
    expect(writePathsOverlap("src/a/x", "src/a")).toBe(true);
    expect(writePathsOverlap("src/a", "src/ab")).toBe(false);
    expect(writePathsOverlap("src/a", "src/b")).toBe(false);
    const waves = compileParallelWaves([
      task("task_a", [], ["src/a/x"], []),
      task("task_b", [], ["src/a"], []),
    ]);
    expect(waves).toEqual([
      { wave_index: 0, task_ids: ["task_a"] },
      { wave_index: 1, task_ids: ["task_b"] },
    ]);
  });

  it("rejects unknown dependencies, cycles and duplicate tasks", () => {
    expectCompilerError([task("task_a", ["task_missing"])], "invalid_specification");
    expectCompilerError(
      [task("task_a", ["task_b"], ["src/a"]), task("task_b", ["task_a"], ["src/b"])],
      "dependency_cycle",
    );
    expectCompilerError(
      [task("task_a", [], ["src/a"]), task("task_a", [], ["src/b"])],
      "invalid_specification",
    );
  });

  it("rejects non-canonical write paths and invalid resource keys", () => {
    expectCompilerError([task("task_a", [], ["src//a"])], "invalid_specification");
    expectCompilerError([task("task_a", [], ["src/../a"])], "invalid_specification");
    expectCompilerError([task("task_a", [], [".harness/x"])], "invalid_specification");
    expectCompilerError([task("task_a", [], [], ["Not A Key"])], "invalid_specification");
  });

  it("rejects legacy tasks that lack protocol 1.3 claims", () => {
    const legacy = task("task_a") as unknown as Protocol13TaskSpecification;
    const withoutPaths = { ...legacy, write_paths: undefined } as never;
    expectCompilerError([withoutPaths], "invalid_specification");
  });
});

describe("assertParallelWaves", () => {
  const tasks = [
    task("task_a", [], ["src/a"], []),
    task("task_b", [], ["src/b"], []),
    task("task_c", ["task_a"], ["src/c"], []),
  ];

  it("accepts a persisted wave layout identical to a fresh compile", () => {
    expect(assertParallelWaves(tasks, compileParallelWaves(tasks))).toBeUndefined();
  });

  it("rejects persisted wave drift", () => {
    const drifted = [{ wave_index: 0, task_ids: ["task_a", "task_b", "task_c"] }] as const;
    try {
      assertParallelWaves(tasks, drifted);
      expect.unreachable("expected wave drift to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(PlanningError);
      expect((error as PlanningError).kind).toBe("wave_drift");
    }
  });
});
