import { describe, expect, it } from "vitest";

import {
  PlanningError,
  validatePlanProposal,
  type PlannerConstraints,
} from "../../src/planning/validator.js";

const CONSTRAINTS: PlannerConstraints = {
  allowedCapabilities: ["fs.read", "fs.write"],
  knownTools: ["tool:fs"],
  knownGates: ["gate:build", "gate:test"],
};

function validTask(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "task_alpha",
    objective: "implement the health endpoint",
    impact_paths: [["edge-alpha"]],
    expected_outputs: ["code_01"],
    capabilities: ["fs.read", "fs.write"],
    tools: ["tool:fs"],
    dependencies: [],
    risk: "medium",
    budget: { steps: 8, tokens: 4000 },
    acceptance: [{ description: "GET /health returns 200", verification: "gate:test" }],
    required_gates: ["gate:test"],
    ...overrides,
  };
}

function expectPlanningError(
  proposal: readonly unknown[],
  kind: string,
  constraints: PlannerConstraints = CONSTRAINTS,
): void {
  try {
    validatePlanProposal(proposal, constraints);
    expect.unreachable(`expected a PlanningError of kind ${kind}`);
  } catch (error) {
    expect(error).toBeInstanceOf(PlanningError);
    expect((error as PlanningError).kind).toBe(kind);
  }
}

describe("validatePlanProposal", () => {
  it("accepts a declarative proposal and returns specs sorted by id", () => {
    const beta = validTask({
      id: "task_beta",
      objective: "wire the route",
      dependencies: ["task_alpha"],
    });
    const tasks = validatePlanProposal([beta, validTask()], CONSTRAINTS);
    expect(tasks.map((task) => task.id)).toEqual(["task_alpha", "task_beta"]);
  });

  it("rejects a proposal that embeds a command", () => {
    expectPlanningError([validTask({ command: "npm run build" })], "embedded_command");
  });

  it("rejects raw shell and direct tool invocations, even nested", () => {
    expectPlanningError([validTask({ shell: "rm -rf build" })], "embedded_command");
    expectPlanningError([validTask({ script: "echo hi" })], "embedded_command");
    expectPlanningError(
      [
        validTask({
          acceptance: [
            { description: "x", verification: "gate:test", tool_invocation: { tool: "tool:fs" } },
          ],
        }),
      ],
      "embedded_command",
    );
  });

  it("rejects unknown tools", () => {
    expectPlanningError([validTask({ tools: ["tool:shell"] })], "unknown_tool");
  });

  it("rejects capability expansion beyond the authorized set", () => {
    expectPlanningError(
      [validTask({ capabilities: ["fs.read", "network.egress"] })],
      "capability_expansion",
    );
  });

  it("rejects a task without a required gate", () => {
    expectPlanningError([validTask({ required_gates: [] })], "missing_gate");
  });

  it("rejects unknown gates", () => {
    expectPlanningError([validTask({ required_gates: ["gate:deploy"] })], "unknown_gate");
  });

  it("rejects dependency cycles and self dependencies", () => {
    const first = validTask({ id: "task_a1", dependencies: ["task_a2"] });
    const second = validTask({
      id: "task_a2",
      objective: "verify the endpoint",
      expected_outputs: ["test_01"],
      dependencies: ["task_a1"],
    });
    expectPlanningError([first, second], "dependency_cycle");
    expectPlanningError([validTask({ dependencies: ["task_alpha"] })], "dependency_cycle");
  });

  it("rejects unknown and duplicate dependency references", () => {
    expectPlanningError([validTask({ dependencies: ["task_missing"] })], "invalid_specification");
    expectPlanningError([validTask(), validTask()], "invalid_specification");
  });

  it("enforces the independent value rule before multiple tasks are created", () => {
    const duplicate = validTask({ id: "task_beta" });
    expectPlanningError([validTask(), duplicate], "no_independent_value");
    const noOutput = validTask({ id: "task_beta", objective: "polish", expected_outputs: [] });
    expectPlanningError([validTask(), noOutput], "invalid_specification");
  });

  it("rejects structurally invalid specifications", () => {
    expectPlanningError([], "invalid_specification");
    expectPlanningError([{ id: "task_alpha" }], "invalid_specification");
    expectPlanningError([validTask({ id: "Task Alpha" })], "invalid_specification");
    expectPlanningError([validTask({ risk: "extreme" })], "invalid_specification");
    expectPlanningError(
      [validTask({ budget: { steps: 0, tokens: 100 } })],
      "invalid_specification",
    );
    expectPlanningError([validTask({ impact_paths: [] })], "invalid_specification");
    expectPlanningError(
      [validTask({ acceptance: [{ description: "x", verification: "" }] })],
      "invalid_specification",
    );
  });
});
