import { describe, expect, it } from "vitest";

import { assessTaskSize, assertAgentPlanSize } from "../../src/planning/task-sizing.js";
import type { TaskSpecification } from "../../src/planning/task.js";

function task(overrides: Partial<TaskSpecification> = {}): TaskSpecification {
  return {
    id: "task_alpha",
    objective: "deliver one reviewable slice",
    impact_paths: [[]],
    expected_outputs: ["code_01", "test_01"],
    capabilities: [],
    tools: [],
    dependencies: [],
    risk: "low",
    budget: { steps: 8, tokens: 4000 },
    acceptance: [{ description: "verified", verification: "gate:test" }],
    assertions: [
      {
        assertion_id: "assertion_alpha",
        test_ids: ["test_01"],
        required_gate_ids: ["gate:test"],
        evidence_requirements: ["test_result"],
      },
    ],
    required_gates: ["gate:test"],
    ...overrides,
  };
}

describe("task sizing", () => {
  it("classifies bounded reviewable work without lowering risk", () => {
    expect(assessTaskSize(task())).toMatchObject({ class: "small" });
  });

  it("rejects an omnibus agent task and excessive DAG width", () => {
    const omnibus = task({
      expected_outputs: Array.from({ length: 12 }, (_, index) => `code_${String(index)}`),
      assertions: Array.from({ length: 5 }, (_, index) => ({
        assertion_id: `assertion_${String(index)}`,
        test_ids: [`test_${String(index)}`],
        required_gate_ids: ["gate:test"],
        evidence_requirements: ["test_result"],
      })),
    });
    expect(assessTaskSize(omnibus).class).toBe("large");
    expect(() => assertAgentPlanSize([omnibus])).toThrowError(
      expect.objectContaining({ kind: "task_too_large" }),
    );
    expect(() =>
      assertAgentPlanSize(
        Array.from({ length: 25 }, (_, index) =>
          task({ id: `task_${String(index)}`, expected_outputs: [`code_${String(index)}`] }),
        ),
      ),
    ).toThrowError(expect.objectContaining({ kind: "dag_limit_exceeded" }));
  });
});
