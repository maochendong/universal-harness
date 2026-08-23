import type { TaskTddContract } from "@universal-harness-internal/core";
import { describe, expect, it, vi } from "vitest";

import { createStrictTddExecuteDagRunner } from "../../src/orchestration/capability-dag-runners.js";
import type { TaskSpecification } from "../../src/planning/task.js";
import type { StrictTddTaskOutcome } from "../../src/tdd/execution-runner.js";

const digest = (letter: string): string => letter.repeat(64);
const task = (id: string): TaskSpecification => ({
  id,
  objective: id,
  impact_paths: [],
  expected_outputs: [`component_${id}`],
  capabilities: [],
  tools: [],
  dependencies: [],
  risk: "low",
  budget: { steps: 1, tokens: 1 },
  acceptance: [{ description: id, verification: "gate" }],
  assertions: [
    {
      assertion_id: `assertion_${id}`,
      test_ids: [`test_${id}`],
      required_gate_ids: ["gate_01"],
      evidence_requirements: ["gate_evidence"],
    },
  ],
  required_gates: ["gate_01"],
});

function contract(taskId: string, mode: TaskTddContract["contract_mode"]): TaskTddContract {
  return {
    contract_id: `tdd-contract_${taskId}`,
    task_id: taskId,
    contract_mode: mode,
    accepted_prd_digest: digest("1"),
    requirement_baseline_digest: digest("2"),
    impact_set_digest: digest("3"),
    design_set_digest: digest("4"),
    capability_plan_digest: digest("5"),
    test_strategy_asset_id: "design-artifact_tests",
    test_strategy_digest: digest("6"),
    plan_digest: digest("7"),
    assertion_clusters: mode === "required" ? [{} as never] : [],
    ...(mode === "not_applicable"
      ? {
          not_applicable_binding: {
            category: "documentation_only" as const,
            reason: "no executable behavior",
          },
        }
      : {}),
    phase_budgets: {
      test_authoring: { max_runs: 1, max_duration_ms: 1 },
      implementation: { max_runs: 1, max_duration_ms: 1 },
    },
    contract_digest: digest(taskId === "task_required" ? "8" : "9"),
  } as TaskTddContract;
}

const context = (strict: boolean) => ({
  operation_id: "operation_01",
  plan_digest: digest("5"),
  node: {
    node_id: "execute",
    node_kind: "kernel" as const,
    depends_on: ["context"],
    consumes: strict ? (["context_bundle", "design_set"] as const) : (["context_bundle"] as const),
    produces: strict ? (["tdd_contract"] as const) : [],
    checkpoint: true,
    ...(strict ? { subgraph: "strict_tdd" as const } : {}),
  },
  inputs: strict
    ? { context_bundle: digest("a"), design_set: digest("4") }
    : { context_bundle: digest("a") },
});

describe("strict TDD execute DAG routing", () => {
  it("uses strict execution for required tasks and explicit normal execution for accepted exemptions", async () => {
    const required = task("task_required");
    const exempt = task("task_exempt");
    const strictOutcome: StrictTddTaskOutcome = {
      status: "completed",
      task_id: required.id,
      tdd_verdict: "tdd_proven",
      cycle: {} as never,
      evidence: [],
      grants: [],
      implementation_revision: "cafe01",
    };
    const runTask = vi.fn().mockResolvedValue(strictOutcome);
    const normal = vi.fn().mockResolvedValue(undefined);
    const outcomes: unknown[] = [];
    const runner = createStrictTddExecuteDagRunner({
      tasks: () => [required, exempt],
      contract: (value) =>
        contract(value.id, value.id === required.id ? "required" : "not_applicable"),
      strictTdd: { runTask },
      executeNormally: normal,
      acceptedDesignBinding: () => true,
      onTaskOutcome: (outcome) => outcomes.push(outcome),
    });

    const result = await runner(context(true));

    expect(result.status).toBe("committed");
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(normal).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ task_id: required.id, tdd_verdict: "tdd_proven" }),
        expect.objectContaining({ task_id: exempt.id, tdd_verdict: "controlled_not_applicable" }),
      ]),
    );
  });

  it("fails closed when an exemption is not bound to the accepted DesignSet/test strategy", async () => {
    const exempt = task("task_exempt");
    const normal = vi.fn();
    const runner = createStrictTddExecuteDagRunner({
      tasks: () => [exempt],
      contract: () => contract(exempt.id, "not_applicable"),
      strictTdd: { runTask: vi.fn() },
      executeNormally: normal,
      acceptedDesignBinding: () => false,
    });

    await expect(runner(context(true))).resolves.toMatchObject({
      status: "blocked",
      reason: "tdd_binding_not_accepted",
    });
    expect(normal).not.toHaveBeenCalled();
  });

  it("uses explicit normal execution and emits no TDD artifacts when the subgraph is inactive", async () => {
    const plain = task("task_plain");
    const runTask = vi.fn();
    const normal = vi.fn().mockResolvedValue(undefined);
    const outcomes: unknown[] = [];
    const runner = createStrictTddExecuteDagRunner({
      tasks: () => [plain],
      contract: () => undefined,
      strictTdd: { runTask },
      executeNormally: normal,
      acceptedDesignBinding: () => false,
      onTaskOutcome: (outcome) => outcomes.push(outcome),
    });

    const result = await runner(context(false));

    expect(result).toEqual({ status: "committed" });
    expect(normal).toHaveBeenCalledTimes(1);
    expect(runTask).not.toHaveBeenCalled();
    expect(outcomes).toEqual([{ task_id: plain.id, tdd_verdict: "not_enabled_by_profile" }]);
  });
});
