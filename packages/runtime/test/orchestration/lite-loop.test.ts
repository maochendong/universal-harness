import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";

import {
  collectProjectStatus,
  createDirectExecutor,
  createGenericInterpreter,
  createNewProject,
  resolveApproval,
  resumeIteration,
  runIteration,
  type OrchestrationOutcome,
  type OrchestratorDependencies,
} from "../../src/index.js";
import { projectIdFor } from "../../src/bootstrap/staging.js";
import {
  appendProjectProfileRecord,
  createProjectProfileRecord,
  harnessRootFor,
} from "../../../core/src/index.js";
import { FIXED_NOW, headOf, makeTempDir, sequentialIds } from "../bootstrap/helpers.js";

/**
 * T9: the Lite kernel-only vertical loop. A project with an explicit Lite
 * profile runs capture → plan → context → execute → verify → snapshot with
 * zero module artifacts: no ImpactSet, no Evaluation, no audit contribution,
 * no model binding or invocation — mechanically proven by the absence of
 * every artifact directory the modules would have written.
 */
const INTENT = "Ship a CSV export for the monthly report.";

function liteDeps(projectRoot: string, newId: (kind: string) => string): OrchestratorDependencies {
  return {
    projectRoot,
    readBaseline: () => headOf(projectRoot),
    now: () => FIXED_NOW,
    newId,
    vcs: createGitVcsAdapter(),
    interpret: createGenericInterpreter(),
    execution: {
      kind: "workflow",
      name: "test-explicit-direct-workflow",
      deterministic: true,
      execute: createDirectExecutor(),
    },
  };
}

async function bootstrapLiteProject(
  name: string,
  newId: (kind: string) => string,
): Promise<string> {
  const outcome = await createNewProject(
    { parentDirectory: makeTempDir("harness-lite-loop-"), name, intent: INTENT },
    { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId },
  );
  if (!outcome.ok) throw new Error(outcome.error.message);
  const projectRoot = outcome.value.projectRoot;
  appendProjectProfileRecord(
    projectRoot,
    createProjectProfileRecord({
      project_id: projectIdFor(name),
      revision: 1,
      profile_id: "lite",
      policy_digest: "0".repeat(64),
      actor: "human:tester",
      effective_from: FIXED_NOW,
    }),
  );
  return projectRoot;
}

async function driveToCompletion(
  deps: OrchestratorDependencies,
  first: OrchestrationOutcome,
): Promise<{ outcome: OrchestrationOutcome; approvals: string[] }> {
  let outcome = first;
  const approvals: string[] = [];
  let guard = 0;
  while (outcome.status === "approval_required") {
    guard += 1;
    if (guard > 10) throw new Error("approval loop did not terminate");
    approvals.push(outcome.required.object_type);
    await resolveApproval(deps, {
      requestId: outcome.required.request_id,
      decision: "approve",
      actor: "human:reviewer",
    });
    outcome = await resumeIteration(deps, outcome.required.workflow_operation_id, undefined);
  }
  return { outcome, approvals };
}

describe("lite kernel-only vertical loop", { timeout: 60000 }, () => {
  it("fails closed when implementation work has no explicit execution binding", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrapLiteProject("lite-executor-required", newId);
    const deps: OrchestratorDependencies = {
      projectRoot,
      readBaseline: () => headOf(projectRoot),
      now: () => FIXED_NOW,
      newId,
      vcs: createGitVcsAdapter(),
      interpret: createGenericInterpreter(),
    };

    const first = await runIteration(deps, { intent: INTENT, intentShape: "pack-converted" });
    expect(first.status).toBe("approval_required");
    if (first.status !== "approval_required") return;
    await resolveApproval(deps, {
      requestId: first.required.request_id,
      decision: "approve",
      actor: "human:reviewer",
    });

    await expect(
      resumeIteration(deps, first.required.workflow_operation_id, undefined),
    ).rejects.toMatchObject({
      kind: "configuration",
      message: expect.stringContaining("executor_required"),
    });
  });

  it("runs capture to snapshot with zero module or model artifacts", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrapLiteProject("lite-loop", newId);
    const deps = liteDeps(projectRoot, newId);

    const first = await runIteration(deps, { intent: INTENT, intentShape: "pack-converted" });
    const { outcome, approvals } = await driveToCompletion(deps, first);

    expect(outcome.status).toBe("completed");
    // Lite approves only the kernel-owned requirement baseline; the direct
    // executor self-authorizes and no module object (ImpactSet) exists.
    expect(approvals).toEqual(["RequirementBaseline"]);

    const harnessRoot = harnessRootFor(projectRoot);
    for (const absent of [
      "artifacts/impact-sets",
      "artifacts/evaluations",
      "artifacts/model-invocations",
      "artifacts/model-provider-bindings",
    ]) {
      expect(existsSync(join(harnessRoot, absent)), `${absent} must not exist`).toBe(false);
    }
  });

  it("keeps the module-rich behavior for projects without a profile record", async () => {
    const newId = sequentialIds();
    const outcome0 = await createNewProject(
      {
        parentDirectory: makeTempDir("harness-lite-legacy-"),
        name: "lite-legacy",
        intent: INTENT,
      },
      { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId },
    );
    if (!outcome0.ok) throw new Error(outcome0.error.message);
    const projectRoot = outcome0.value.projectRoot;
    const deps = liteDeps(projectRoot, newId);

    const first = await runIteration(deps, { intent: INTENT, intentShape: "pack-converted" });
    const { approvals } = await driveToCompletion(deps, first);
    // Legacy projects keep the full module pipeline, including ImpactSet.
    expect(approvals).toContain("ImpactSet");
  });

  it("exposes inactive_by_profile capability resolutions through the status Read API", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrapLiteProject("lite-status", newId);
    const deps = liteDeps(projectRoot, newId);
    const first = await runIteration(deps, { intent: INTENT, intentShape: "pack-converted" });
    const { outcome } = await driveToCompletion(deps, first);
    expect(outcome.status).toBe("completed");

    const capabilities = collectProjectStatus(projectRoot).capabilities;
    expect(capabilities).toHaveLength(5);
    for (const entry of capabilities) {
      expect(entry.resolution).toBe("inactive_by_profile");
      expect(entry.generic_status).toBe("not_enabled_by_profile");
    }
    expect(capabilities.map((entry) => entry.capability_id).sort()).toEqual([
      "advanced_audit",
      "design_governance",
      "impact_analysis",
      "independent_evaluation",
      "strict_tdd",
    ]);
  });
});
