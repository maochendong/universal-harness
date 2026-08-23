import { describe, expect, it, vi } from "vitest";

import type { AgentRunResult } from "@universal-harness-internal/plugin-sdk";
import {
  classifyRunFailure,
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
});
