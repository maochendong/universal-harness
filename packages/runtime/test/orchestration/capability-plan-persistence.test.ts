import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";

import {
  compileCapabilityPlan,
  createProjectProfileRecord,
  createProfileDecisionRecord,
  harnessRootFor,
  recordDigestOf,
  type CapabilityPlanCompilationRequest,
  type CapabilityPlanRecord,
} from "@universal-harness-internal/core";

import {
  createDirectExecutor,
  createNewProject,
  OrchestrationError,
  resolveApproval,
  resumeIteration,
  runIteration,
  type OrchestrationOutcome,
  type OrchestratorDependencies,
  type ParallelExecutionBinding,
  type ParallelTaskExecutionPort,
} from "../../src/index.js";
import {
  loadCapabilityPlans,
  type PipelineContext,
} from "../../src/orchestration/kernel-coordinator.js";
import type { DriverLockHandle } from "../../src/scheduling/driver-lock.js";
import {
  FIXED_NOW,
  cleanupDirectories,
  headOf,
  makeTempDir,
  sequentialIds,
} from "../bootstrap/helpers.js";
import { CAPTURE_POLICY_DIGEST, completingCaptureSeam } from "./coordinated-capture-fixture.js";

/**
 * CapabilityPlan persistence (M4 plan Task 11 review P1): the write/read path
 * (persistCapabilityPlan / loadCapabilityPlans via assertCapabilityPlanRecord)
 * must dispatch on the record's protocol_version — a real Protocol 1.3 plan
 * revision persists and reads back for resume, Protocol 1.1 behavior stays
 * byte-identical, and an unknown protocol version fails closed.
 */
afterEach(cleanupDirectories);

const TEST_TIMEOUT_SCALE = process.platform === "win32" ? 4 : 1;

const INTENT = "add the first capability";

/** Compile the accepted routing authority the kernel compiler port is asked for. */
function compileForRequest(
  request: CapabilityPlanCompilationRequest,
  parallel: boolean,
): CapabilityPlanRecord {
  const profile = createProjectProfileRecord({
    project_id: "project_plan-persistence",
    revision: 1,
    profile_id: "lite",
    policy_digest: CAPTURE_POLICY_DIGEST,
    actor: "human:test",
    effective_from: FIXED_NOW,
  });
  const decision = createProfileDecisionRecord({
    decision_kind: "project_profile_change",
    project_id: "project_plan-persistence",
    actor: "human:test",
    idempotency_key: `profile-decision:plan-persistence:${request.operation_id}`,
    current_profile_id: "lite",
    decided_profile_id: "lite",
    policy_digest: CAPTURE_POLICY_DIGEST,
    decided_at: FIXED_NOW,
  });
  if (!parallel) {
    // Protocol 1.1 revision: the legacy byte shape, no protocol_version input.
    return compileCapabilityPlan({
      operation_id: request.operation_id,
      stage: "final",
      project_profile: profile,
      profile_decision: decision,
      requirement_digest: request.requirement_digest,
      risk_digest: request.risk_digest,
      policy_digest: request.policy_digest,
      baseline_digest: request.baseline_digest,
    });
  }
  // Protocol 1.3 revisions ride the 1.1 static type at this seam (see
  // capabilityPlanActivatesParallel).
  return compileCapabilityPlan({
    operation_id: request.operation_id,
    stage: "final",
    protocol_version: "1.3.0",
    project_profile: profile,
    profile_decision: decision,
    requirement_digest: request.requirement_digest,
    risk_digest: request.risk_digest,
    policy_digest: request.policy_digest,
    baseline_digest: request.baseline_digest,
    policy: { required_capabilities: ["parallel_task_execution"] },
    providers: ["isolated_workspace_provider", "structured_gate_provider"],
  }) as CapabilityPlanRecord;
}

interface PersistenceHarness {
  readonly deps: OrchestratorDependencies;
  readonly projectRoot: string;
  readonly workflowOperationId: string;
  readonly compilerCalls: CapabilityPlanCompilationRequest[];
  readonly compiledPlans: CapabilityPlanRecord[];
  readonly runCalls: Parameters<ParallelTaskExecutionPort["run"]>[0][];
  readonly sourceViewCalls: string[];
}

/**
 * Drive a fresh project through coordinated capture approval with a real
 * capabilityPlanCompiler port, so ensureInitialCapabilityPlan compiles and
 * persists the plan revision through the production write path.
 */
async function driveCompiledPipeline(
  name: string,
  options: { readonly parallel: boolean; readonly bindParallelForLegacy?: boolean },
): Promise<PersistenceHarness & { readonly first: OrchestrationOutcome }> {
  const newId = sequentialIds();
  const created = await createNewProject(
    { parentDirectory: makeTempDir("harness-plan-persist-"), name, intent: INTENT },
    { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId },
  );
  if (!created.ok) throw new Error(created.error.message);
  const projectRoot = created.value.projectRoot;

  const compilerCalls: CapabilityPlanCompilationRequest[] = [];
  const compiledPlans: CapabilityPlanRecord[] = [];
  const runCalls: Parameters<ParallelTaskExecutionPort["run"]>[0][] = [];
  const sourceViewCalls: string[] = [];
  const lockHolder: { lock?: DriverLockHandle } = {};
  const parallelExecution: ParallelExecutionBinding = {
    port: {
      run: (input) => {
        runCalls.push(input);
        return Promise.resolve({
          status: "completed" as const,
          operation_id: input.operation_id,
          wave_integration_digests: ["1".repeat(64)],
          scheduler_state_digest: "2".repeat(64),
        });
      },
    },
    driverLock: () => {
      const lock = lockHolder.lock;
      if (lock === undefined) {
        throw new Error("driver lock requested before the operation id exists");
      }
      return lock;
    },
    openSourceView: (operationId) => {
      sourceViewCalls.push(operationId);
      return Promise.resolve({
        root: projectRoot,
        commit: headOf(projectRoot),
        release: () => Promise.resolve(),
      });
    },
  };
  const deps: OrchestratorDependencies = {
    projectRoot,
    readBaseline: () => headOf(projectRoot),
    now: () => FIXED_NOW,
    newId,
    vcs: createGitVcsAdapter(),
    capture: completingCaptureSeam(projectRoot),
    capabilityPlanCompiler: (request) => {
      compilerCalls.push(request);
      const plan = compileForRequest(request, options.parallel);
      compiledPlans.push(plan);
      return plan;
    },
    // The plan phase binds an execution authority into the ExecutionPlan; the
    // 1.1 DAG also runs phaseExecute through it.
    execution: {
      kind: "workflow",
      name: "test-plan-persistence-workflow",
      deterministic: true,
      execute: createDirectExecutor(),
    },
    ...(options.parallel || options.bindParallelForLegacy ? { parallelExecution } : {}),
  };

  const first = await runIteration(deps, { intent: INTENT });
  if (first.status !== "approval_required") {
    throw new Error(`expected capture approval_required, got ${first.status}`);
  }
  const workflowOperationId = first.required.workflow_operation_id;
  lockHolder.lock = {
    operation_id: workflowOperationId,
    owner_token: "owner_plan_persistence_test",
    path: `${projectRoot}/.harness/locks/driver`,
    release: () => Promise.resolve(),
  };
  await resolveApproval(deps, {
    requestId: first.required.request_id,
    decision: "approve",
    actor: "human:reviewer",
  });
  const executed = await resumeIteration(deps, workflowOperationId, {
    intent: "",
    untilPhase: "execute",
  });
  return {
    deps,
    projectRoot,
    workflowOperationId,
    compilerCalls,
    compiledPlans,
    runCalls,
    sourceViewCalls,
    first: executed,
  };
}

function persistedPlanRecord(
  harness: PersistenceHarness,
  plan: CapabilityPlanRecord,
): Record<string, unknown> {
  const path = join(
    harnessRootFor(harness.projectRoot),
    "artifacts/capability-plans",
    plan.capability_plan_id,
    `${String(plan.revision)}.json`,
  );
  expect(existsSync(path), `persisted CapabilityPlan artifact missing: ${path}`).toBe(true);
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("capability plan persistence", { timeout: 30000 * TEST_TIMEOUT_SCALE }, () => {
  it("persists a real Protocol 1.3 plan and reads it back on the next resume", async () => {
    const harness = await driveCompiledPipeline("plan-persist-13", { parallel: true });

    expect(harness.first).toMatchObject({
      status: "advanced",
      completedPhase: "execute",
    });
    expect(harness.compilerCalls).toHaveLength(1);
    expect(harness.compilerCalls[0]).toMatchObject({
      operation_id: harness.workflowOperationId,
      stage: "initial",
    });
    expect(harness.runCalls).toHaveLength(1);

    const plan = harness.compiledPlans[0];
    if (plan === undefined) throw new Error("compiler returned no plan");
    const persisted = persistedPlanRecord(harness, plan);
    expect(persisted["protocol_version"]).toBe("1.3.0");
    expect(persisted["record_digest"]).toBe(plan.record_digest);

    // The next resume must read the 1.3 revision back (not recompile it) and
    // replay the journaled execute node instead of re-running the driver.
    const continued = await resumeIteration(harness.deps, harness.workflowOperationId, {
      intent: "",
      untilPhase: "verify",
    });
    expect(continued).toMatchObject({ status: "advanced", completedPhase: "verify" });
    expect(harness.compilerCalls).toHaveLength(1);
    expect(harness.runCalls).toHaveLength(1);
  });

  it("keeps the Protocol 1.1 write/read path byte-identical", async () => {
    const harness = await driveCompiledPipeline("plan-persist-11", { parallel: false });

    expect(harness.first).toMatchObject({
      status: "advanced",
      completedPhase: "execute",
    });
    expect(harness.compilerCalls).toHaveLength(1);

    const plan = harness.compiledPlans[0];
    if (plan === undefined) throw new Error("compiler returned no plan");
    const persisted = persistedPlanRecord(harness, plan);
    expect(persisted["protocol_version"]).toBe("1.1.0");
    expect(persisted["record_digest"]).toBe(plan.record_digest);

    const continued = await resumeIteration(harness.deps, harness.workflowOperationId, {
      intent: "",
      untilPhase: "verify",
    });
    expect(continued).toMatchObject({ status: "advanced", completedPhase: "verify" });
    expect(harness.compilerCalls).toHaveLength(1);
  });

  it("does not open an M4 source view when a Protocol 1.1 operation resumes at verify", async () => {
    const harness = await driveCompiledPipeline("plan-persist-11-source-view", {
      parallel: false,
      bindParallelForLegacy: true,
    });

    const continued = await resumeIteration(harness.deps, harness.workflowOperationId, {
      intent: "",
      untilPhase: "verify",
    });

    expect(continued).toMatchObject({ status: "advanced", completedPhase: "verify" });
    expect(harness.sourceViewCalls).toEqual([]);
  });

  it("fails closed on a persisted plan with an unknown protocol version", () => {
    const projectRoot = makeTempDir("harness-plan-unknown-");
    const request: CapabilityPlanCompilationRequest = {
      operation_id: "operation_plan-persistence-unknown",
      stage: "initial",
      requirement_digest: "b".repeat(64),
      risk_digest: "c".repeat(64),
      policy_digest: CAPTURE_POLICY_DIGEST,
      baseline_digest: "d".repeat(64),
    };
    const plan = compileForRequest(request, false);
    // A correctly sealed record on an unknown protocol version: the envelope
    // is intact, so only the versioned schema gate can reject it.
    const forged = { ...plan, protocol_version: "9.9.9" };
    const sealed = { ...forged, record_digest: recordDigestOf(forged) };
    const directory = join(
      harnessRootFor(projectRoot),
      "artifacts/capability-plans",
      plan.capability_plan_id,
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "1.json"), `${JSON.stringify(sealed)}\n`, "utf8");

    const ctx = {
      deps: { projectRoot, readBaseline: () => "0".repeat(64) },
      workflowOperationId: plan.operation_id,
    } as unknown as PipelineContext;
    expect(() => loadCapabilityPlans(ctx)).toThrowError(OrchestrationError);
    expect(() => loadCapabilityPlans(ctx)).toThrowError(/binding_drift|failed validation/iu);
  });
});
