import { describe, expect, it, vi } from "vitest";

import {
  PROTOCOL_1_1_VERSION,
  contentDigest,
  sealRecordEnvelope,
  type TaskTddContract,
  type TddEvidenceBinding,
} from "@universal-harness-internal/core";
import type { AgentRunResult } from "@universal-harness-internal/plugin-sdk";
import {
  classifyRunFailure,
  executeRequiredTddTask,
  finalizeSnapshotLedger,
  orderExecutionTasks,
  verificationBindingsEqual,
} from "../../src/index.js";
import type { TaskSpecification } from "../../src/planning/task.js";

const task = (id: string, dependencies: readonly string[] = []): TaskSpecification => ({
  id,
  objective: id,
  impact_paths: [],
  expected_outputs: [`component_${id}`],
  capabilities: [],
  tools: [],
  dependencies,
  risk: "low",
  budget: { steps: 1, tokens: 1 },
  acceptance: [{ description: id, verification: "gate" }],
  required_gates: ["gate_test"],
});

describe("coordinator facade modules", () => {
  it("preserves deterministic execution ordering and recovery classification", () => {
    expect(
      orderExecutionTasks([task("task_c", ["task_b"]), task("task_b"), task("task_a")]),
    ).toEqual([task("task_a"), task("task_b"), task("task_c", ["task_b"])]);
    expect(classifyRunFailure({ outcome: "partial" } as AgentRunResult)).toEqual({
      reason: "budget_ceiling",
      resumePhase: "execute",
    });
  });

  it("keeps verification replay exact and finalizes post-snapshot artifacts once", async () => {
    const bindings = {
      artifact_digests: ["a"],
      code_digests: ["b"],
      evaluation_case_digests: [],
      policy_digest: "c",
    };
    expect(verificationBindingsEqual(bindings, { ...bindings })).toBe(true);
    expect(verificationBindingsEqual(bindings, { ...bindings, code_digests: ["drift"] })).toBe(
      false,
    );

    const commit = vi.fn().mockResolvedValue({ ok: true, value: "ledger-final" });
    const outcome = await finalizeSnapshotLedger({
      project_root: "/fixture",
      iteration_id: "iteration_01",
      vcs: { commit } as never,
      read_baseline: () => "repository-final",
      prior_ledger_commit: "ledger-snapshot",
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      ledger_commit: "ledger-final",
      repository_head: "repository-final",
    });
  });

  it("invokes required TDD through the production execution facade and emits ledger artifacts", async () => {
    const requiredTask = task("task_required");
    const logicalCycleId = "cycle_required";
    const contract = {
      contract_mode: "required",
      capability_plan_digest: "a".repeat(64),
      contract_digest: "b".repeat(64),
      assertion_clusters: [{ logical_cycle_id: logicalCycleId }],
    } as TaskTddContract;
    const evidence = (
      ["baseline_test_result", "red_test_result", "green_test_result"] as const
    ).map(
      (evidenceType) =>
        ({
          evidence_type: evidenceType,
          task_id: requiredTask.id,
          logical_cycle_id: logicalCycleId,
          attempt_ordinal: 1,
          contract_digest: contract.contract_digest,
          repository_baseline: "repository-head",
          ...(evidenceType === "baseline_test_result" ? {} : { test_patch_digest: "c".repeat(64) }),
          target_gate_binding_digest: "d".repeat(64),
          framework_profile_digest: "e".repeat(64),
          executor_environment_digest: "f".repeat(64),
          selector_ids: ["test_required"],
          assertion_ids: ["assertion_required"],
          ...(evidenceType === "red_test_result" ? { failure_kind: "assertion_failure" } : {}),
          grant_digest: "1".repeat(64),
          observed_write_set_digest: "2".repeat(64),
          output_artifact: { locator: `memory://${evidenceType}`, digest: "3".repeat(64) },
        }) satisfies TddEvidenceBinding,
    );
    const cycle = sealRecordEnvelope({
      protocol_version: PROTOCOL_1_1_VERSION,
      record_kind: "tdd_cycle" as const,
      logical_cycle_id: logicalCycleId,
      attempt_ordinal: 1,
      task_id: requiredTask.id,
      assertion_ids: ["assertion_required"],
      contract_digest: contract.contract_digest,
      repository_baseline: "repository-head",
      baseline_evidence_digest: contentDigest(evidence[0]),
      test_patch_digest: "c".repeat(64),
      target_gate_binding_digest: "d".repeat(64),
      executor_environment_digest: "f".repeat(64),
      red_evidence_digest: contentDigest(evidence[1]),
      green_evidence_digest: contentDigest(evidence[2]),
      implementation_revision: "implementation-head",
      status: "completed" as const,
    });
    const runTask = vi.fn().mockResolvedValue({
      status: "completed",
      task_id: requiredTask.id,
      tdd_verdict: "tdd_proven",
      cycle,
      evidence,
      grants: [],
      implementation_revision: "implementation-head",
    });

    const execution = await executeRequiredTddTask({
      port: { runTask },
      task: requiredTask,
      contract,
      capabilityPlanDigest: contract.capability_plan_digest,
    });

    expect(runTask).toHaveBeenCalledTimes(1);
    expect(execution.result).toMatchObject({
      outcome: "handoff",
      completion_claimed: true,
      summary: expect.stringContaining("strict TDD proven"),
    });
    expect(execution.artifacts.map((artifact) => artifact.path)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^artifacts\/tdd-cycles\//u),
        expect.stringMatching(/^artifacts\/tdd-evidence\//u),
      ]),
    );
  });
});
