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
    assertions: [
      {
        assertion_id: "assertion_health",
        test_ids: ["test_01"],
        required_gate_ids: ["gate:test"],
        evidence_requirements: ["test_result"],
      },
    ],
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

  it("validates atomic assertion bindings", () => {
    expectPlanningError(
      [validTask({ assertions: [{ assertion_id: "assertion_health", test_ids: [] }] })],
      "invalid_specification",
    );
    expectPlanningError(
      [
        validTask({
          assertions: [
            {
              assertion_id: "assertion_health",
              test_ids: ["test_01"],
              required_gate_ids: ["gate:build"],
              evidence_requirements: ["test_result"],
            },
          ],
        }),
      ],
      "missing_gate",
    );
  });

  it("rejects unknown gates", () => {
    expectPlanningError(
      [
        validTask({
          required_gates: ["gate:deploy"],
          assertions: [
            {
              assertion_id: "assertion_health",
              test_ids: ["test_01"],
              required_gate_ids: ["gate:deploy"],
              evidence_requirements: ["test_result"],
            },
          ],
        }),
      ],
      "unknown_gate",
    );
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

describe("validatePlanProposal protocol 1.3 mode", () => {
  function protocol13Task(overrides?: Record<string, unknown>): Record<string, unknown> {
    return validTask({
      write_paths: ["packages/runtime/src/scheduling"],
      exclusive_resources: ["generated-client"],
      budget: { steps: 12, tokens: 8_000, duration_ms: 300_000 },
      ...overrides,
    });
  }

  function expectProtocol13Error(
    proposal: readonly unknown[],
    kind: string,
    mode: "legacy" | "protocol13" = "protocol13",
  ): void {
    try {
      validatePlanProposal(proposal, CONSTRAINTS, mode);
      expect.unreachable(`expected a PlanningError of kind ${kind}`);
    } catch (error) {
      expect(error).toBeInstanceOf(PlanningError);
      expect((error as PlanningError).kind).toBe(kind);
    }
  }

  it("accepts a fully declared protocol 1.3 task", () => {
    const tasks = validatePlanProposal([protocol13Task()], CONSTRAINTS, "protocol13");
    const task = tasks[0];
    expect(task?.write_paths).toEqual(["packages/runtime/src/scheduling"]);
    expect(task?.exclusive_resources).toEqual(["generated-client"]);
    expect(task?.budget).toEqual({ steps: 12, tokens: 8_000, duration_ms: 300_000 });
  });

  it("accepts empty write paths and resource claims when declared explicitly", () => {
    const tasks = validatePlanProposal(
      [protocol13Task({ write_paths: [], exclusive_resources: [] })],
      CONSTRAINTS,
      "protocol13",
    );
    expect(tasks[0]?.write_paths).toEqual([]);
    expect(tasks[0]?.exclusive_resources).toEqual([]);
  });

  it("requires duration, write paths and resource claims in protocol 1.3 mode", () => {
    expectProtocol13Error(
      [validTask({ write_paths: ["src/a"], exclusive_resources: [] })],
      "invalid_specification",
    ); // no duration_ms
    expectProtocol13Error([protocol13Task({ write_paths: undefined })], "invalid_specification");
    expectProtocol13Error(
      [protocol13Task({ exclusive_resources: undefined })],
      "invalid_specification",
    );
  });

  it("rejects non-positive or non-integer duration", () => {
    expectProtocol13Error(
      [protocol13Task({ budget: { steps: 4, tokens: 100, duration_ms: 0 } })],
      "invalid_specification",
    );
    expectProtocol13Error(
      [protocol13Task({ budget: { steps: 4, tokens: 100, duration_ms: -5 } })],
      "invalid_specification",
    );
    expectProtocol13Error(
      [protocol13Task({ budget: { steps: 4, tokens: 100, duration_ms: 1.5 } })],
      "invalid_specification",
    );
  });

  it("rejects absolute paths and dot segments", () => {
    expectProtocol13Error(
      [protocol13Task({ write_paths: ["/etc/passwd"] })],
      "invalid_specification",
    );
    expectProtocol13Error(
      [protocol13Task({ write_paths: ["C:/repo/src"] })],
      "invalid_specification",
    );
    expectProtocol13Error(
      [protocol13Task({ write_paths: ["src/../secret"] })],
      "invalid_specification",
    );
    expectProtocol13Error([protocol13Task({ write_paths: ["./src/a"] })], "invalid_specification");
    expectProtocol13Error([protocol13Task({ write_paths: ["src//a"] })], "invalid_specification");
  });

  it("rejects .git and .harness authoritative directories", () => {
    expectProtocol13Error([protocol13Task({ write_paths: [".git"] })], "invalid_specification");
    expectProtocol13Error(
      [protocol13Task({ write_paths: [".git/refs"] })],
      "invalid_specification",
    );
    expectProtocol13Error(
      [protocol13Task({ write_paths: ["packages/.git"] })],
      "invalid_specification",
    );
    expectProtocol13Error([protocol13Task({ write_paths: [".harness"] })], "invalid_specification");
    expectProtocol13Error(
      [protocol13Task({ write_paths: [".harness/ledger"] })],
      "invalid_specification",
    );
  });

  it("rejects empty and root-masking write path declarations", () => {
    expectProtocol13Error([protocol13Task({ write_paths: [""] })], "invalid_specification");
    expectProtocol13Error([protocol13Task({ write_paths: ["."] })], "invalid_specification");
    expectProtocol13Error([protocol13Task({ write_paths: ["/"] })], "invalid_specification");
  });

  it("rejects duplicate and non-canonical write paths", () => {
    expectProtocol13Error(
      [protocol13Task({ write_paths: ["src/a", "src/a"] })],
      "invalid_specification",
    );
    expectProtocol13Error([protocol13Task({ write_paths: ["src\\a"] })], "invalid_specification");
    expectProtocol13Error([protocol13Task({ write_paths: ["src/a/"] })], "invalid_specification");
  });

  it("rejects invalid and duplicate exclusive resource keys", () => {
    expectProtocol13Error(
      [protocol13Task({ exclusive_resources: ["Database Schema"] })],
      "invalid_specification",
    );
    expectProtocol13Error(
      [protocol13Task({ exclusive_resources: ["db::schema"] })],
      "invalid_specification",
    );
    expectProtocol13Error([protocol13Task({ exclusive_resources: [""] })], "invalid_specification");
    expectProtocol13Error(
      [protocol13Task({ exclusive_resources: ["generated-client", "generated-client"] })],
      "invalid_specification",
    );
    // valid keys keep working
    expect(
      validatePlanProposal(
        [protocol13Task({ exclusive_resources: ["database-schema", "service-port:8080"] })],
        CONSTRAINTS,
        "protocol13",
      )[0]?.exclusive_resources,
    ).toEqual(["database-schema", "service-port:8080"]);
  });

  it("legacy mode keeps accepting the old two-field budget as sequential-only", () => {
    const tasks = validatePlanProposal([validTask()], CONSTRAINTS, "legacy");
    expect(tasks[0]?.budget).toEqual({ steps: 8, tokens: 4000 });
    expect(tasks[0]?.write_paths).toBeUndefined();
    expect(tasks[0]?.exclusive_resources).toBeUndefined();
  });

  it("legacy mode still validates declared duration when present", () => {
    expect(
      validatePlanProposal(
        [validTask({ budget: { steps: 8, tokens: 4000, duration_ms: 60_000 } })],
        CONSTRAINTS,
        "legacy",
      )[0]?.budget,
    ).toEqual({ steps: 8, tokens: 4000, duration_ms: 60_000 });
    expectProtocol13Error(
      [validTask({ budget: { steps: 8, tokens: 4000, duration_ms: 0 } })],
      "invalid_specification",
      "legacy",
    );
  });
});
