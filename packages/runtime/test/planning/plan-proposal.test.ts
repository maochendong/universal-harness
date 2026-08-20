import { describe, expect, it } from "vitest";

import { compileCriterionAssertions } from "../../../core/src/index.js";

import {
  createInMemoryPlanProposalPort,
  createLegacyPlanTasksAdapter,
  validatePlanProposalAllocation,
  type PlanProposalInput,
  type PlanProposalTaskCandidate,
} from "../../src/planning/plan-proposal.js";
import type { TaskSpecification } from "../../src/planning/task.js";

/**
 * T13/PG-5 plan proposal seam (model advisory design 8, provable TDD design
 * 7.1): the model allocates only Harness-compiled canonical assertions; the
 * deterministic validator rejects created/merged/omitted assertions, path
 * widening, gate weakening and unknown design bindings. The legacy adapter
 * maps PlanTasksPort output into the same chain with a deprecation warning.
 */
const digest = (letter: string) => letter.repeat(64);

const CRITERIA = [
  {
    criterion_id: "criterion_01K1AC1",
    criterion_semantic_digest: digest("a"),
    requirement_id: "requirement_01K1REQ",
    test_node_id: "test_01K1T01",
  },
];

function canonicalAssertions() {
  return compileCriterionAssertions(CRITERIA);
}

function candidate(overrides: Partial<PlanProposalTaskCandidate> = {}): PlanProposalTaskCandidate {
  return {
    task_key: "task-export",
    goal: "implement the CSV export",
    atomicity_rationale: "single output",
    assertion_ids: [canonicalAssertions()[0]?.assertion_id ?? ""],
    requirement_ids: ["requirement_01K1REQ"],
    decision_ids: [],
    design_artifact_ids: [],
    depends_on: [],
    suggested_gate_ids: ["gate_target"],
    suggested_write_paths: ["src/export/**"],
    ...overrides,
  };
}

function allocation(overrides: Partial<Parameters<typeof validatePlanProposalAllocation>[0]> = {}) {
  return {
    tasks: [candidate()],
    canonical_assertions: canonicalAssertions(),
    known_gate_ids: ["gate_target"],
    allowed_write_paths: ["src/**", "tests/**"],
    known_requirement_ids: ["requirement_01K1REQ"],
    known_decision_ids: ["decision_01K1DEC"],
    known_design_artifact_ids: ["designartifact_01K1TST"],
    max_tasks: 24,
    ...overrides,
  };
}

function codes(input: Parameters<typeof validatePlanProposalAllocation>[0]): string[] {
  return validatePlanProposalAllocation(input).map((issue) => issue.code);
}

describe("validatePlanProposalAllocation", () => {
  it("accepts an exact allocation of the canonical assertions", () => {
    expect(validatePlanProposalAllocation(allocation())).toEqual([]);
  });

  it("rejects forged, omitted or shared assertions", () => {
    expect(
      codes(allocation({ tasks: [candidate({ assertion_ids: ["criterion-assertion_forged"] })] })),
    ).toContain("unknown_assertion");
    expect(codes(allocation({ tasks: [candidate({ assertion_ids: [] })] }))).toContain(
      "unowned_assertion",
    );
    expect(
      codes(
        allocation({
          tasks: [
            candidate(),
            candidate({ task_key: "task-two", goal: "second independent output" }),
          ],
        }),
      ),
    ).toContain("multiple_owners");
  });

  it("rejects unknown gates, widened paths and unknown bindings", () => {
    expect(
      codes(allocation({ tasks: [candidate({ suggested_gate_ids: ["gate_root"] })] })),
    ).toContain("unknown_gate");
    expect(
      codes(allocation({ tasks: [candidate({ suggested_write_paths: ["etc/**"] })] })),
    ).toContain("path_widening");
    expect(
      codes(allocation({ tasks: [candidate({ decision_ids: ["decision_01K1MIA"] })] })),
    ).toContain("unknown_design_binding");
  });

  it("rejects dependency cycles and unknown keys", () => {
    const cycled = allocation({
      tasks: [
        candidate({ depends_on: ["task-two"] }),
        candidate({
          task_key: "task-two",
          goal: "second output",
          assertion_ids: [],
          depends_on: ["task-export"],
        }),
      ],
      canonical_assertions: [],
    });
    // assertion_ids empty on both — drop the canonical set so only the cycle is flagged.
    expect(codes(cycled)).toContain("dependency_cycle");
    expect(codes(allocation({ tasks: [candidate({ depends_on: ["task-missing"] })] }))).toContain(
      "unknown_dependency",
    );
  });
});

describe("plan proposal ports", () => {
  function portInput(): PlanProposalInput {
    return {
      workflow_operation_id: "operation_01K1OP1",
      iteration_id: "iteration_01K1IT1",
      requirement_baseline_digest: digest("b"),
      impact_set_digest: digest("1"),
      policy_digest: digest("2"),
      canonical_assertions: canonicalAssertions(),
      known_requirement_ids: ["requirement_01K1REQ"],
      known_decision_ids: [],
      known_design_artifact_ids: [],
      known_gate_ids: ["gate_target"],
      allowed_write_paths: ["src/**"],
      max_tasks: 24,
      bundle_digest: digest("7"),
      conversation_id: "conversation_01K1CV1",
      run_id: "run_01K1RN1",
    };
  }

  it("runs the in-memory port through output parsing and allocation validation", async () => {
    const clean = createInMemoryPlanProposalPort(() => ({ tasks: [candidate()], questions: [] }));
    const result = await clean.propose(portInput());
    expect(result.status).toBe("proposed");

    const forged = createInMemoryPlanProposalPort(() => ({
      tasks: [candidate({ assertion_ids: ["criterion-assertion_forged"] })],
      questions: [],
    }));
    expect((await forged.propose(portInput())).status).toBe("failed");
  });

  it("maps legacy PlanTasksPort output into the same validated chain with a warning", async () => {
    const spec: TaskSpecification = {
      id: "task_legacy",
      objective: "implement the CSV export",
      impact_paths: [],
      expected_outputs: ["codeartifact_01K1OUT"],
      capabilities: [],
      tools: [],
      dependencies: [],
      risk: "medium",
      budget: { steps: 10, tokens: 1000 },
      acceptance: [{ description: "d", verification: "v" }],
      assertions: [
        {
          assertion_id: canonicalAssertions()[0]?.assertion_id ?? "",
          test_ids: ["test_01K1T01"],
          required_gate_ids: ["gate_target"],
          evidence_requirements: [],
        },
      ],
      required_gates: ["gate_target"],
    };
    const port = createLegacyPlanTasksAdapter(() => [spec], {
      goal: "ship the export",
      requirements: [],
      impactPaths: [],
      acceptedTestIds: ["test_01K1T01"],
      gateIds: ["gate_target"],
    });
    const result = await port.propose(portInput());
    expect(result.status).toBe("proposed");
    if (result.status !== "proposed") return;
    expect(result.warnings?.[0]).toContain("deprecated");
    expect(result.tasks[0]?.task_key).toBe("task_legacy");
    expect(result.tasks[0]?.assertion_ids).toEqual([canonicalAssertions()[0]?.assertion_id]);
  });
});
