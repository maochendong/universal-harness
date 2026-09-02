import { existsSync, writeFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";

import {
  compileCapabilityPlan,
  contentDigest,
  createProjectProfileRecord,
  createProfileDecisionRecord,
  readManagedManifest,
  type CapabilityPlanRecord,
} from "@universal-harness-internal/core";

import {
  createDirectExecutor,
  createNewProject,
  LedgerDagCheckpointStore,
  ToolRegistry,
  materializeProjectGraph,
  normalizeGateDefinition,
  readCurrentOperation,
  readExecutionPlanContent,
  resolveApproval,
  resumeIteration,
  runIteration,
  type OrchestrationOutcome,
  type OrchestratorDependencies,
  type GateDefinition,
  type ParallelExecutionBinding,
  type ParallelTaskExecutionOutcome,
  type ParallelTaskExecutionPort,
} from "../../src/index.js";
import type { DriverLockHandle } from "../../src/scheduling/driver-lock.js";
import {
  FIXED_NOW,
  cleanupDirectories,
  git,
  headOf,
  makeTempDir,
  sequentialIds,
} from "../bootstrap/helpers.js";
import { completingCaptureSeam } from "./coordinated-capture-fixture.js";

/**
 * Kernel parallel-execute branch coverage (M4 plan Task 11 review): the
 * `parallel_task_execution` execute arm of driveCapabilityPipeline is driven
 * end-to-end through the real orchestrator entries (runIteration → approval →
 * resumeIteration → CapabilityPlan DAG runtime), never through a rewired
 * runner registry. The capture side runs the real PrdCaptureCoordinator seam
 * so the accepted PRD the DAG capture node imports is genuinely committed.
 */
afterEach(cleanupDirectories);

const TEST_TIMEOUT_SCALE = process.platform === "win32" ? 4 : 1;

const INTENT = "add the first capability";
const POLICY_DIGEST = "9".repeat(64);

const WAVE_INTEGRATION_DIGESTS = ["1".repeat(64)];
const SCHEDULER_STATE_DIGEST = "2".repeat(64);

/**
 * The accepted routing authority for the operation: a real Protocol 1.3
 * compile over the Lite profile with the parallel module policy-required, so
 * the accepted DAG marks execute with the parallel_task_execution subgraph and
 * the wave_integration output. Protocol 1.3 revisions ride the 1.1 static type
 * at this seam (see capabilityPlanActivatesParallel).
 */
function compileParallelPlan(operationId: string): CapabilityPlanRecord {
  const profile = createProjectProfileRecord({
    project_id: "project_parallel-execute",
    revision: 1,
    profile_id: "lite",
    policy_digest: POLICY_DIGEST,
    actor: "human:test",
    effective_from: FIXED_NOW,
  });
  const decision = createProfileDecisionRecord({
    decision_kind: "project_profile_change",
    project_id: "project_parallel-execute",
    actor: "human:test",
    idempotency_key: `profile-decision:parallel-execute:${operationId}`,
    current_profile_id: "lite",
    decided_profile_id: "lite",
    policy_digest: POLICY_DIGEST,
    decided_at: FIXED_NOW,
  });
  return compileCapabilityPlan({
    operation_id: operationId,
    stage: "final",
    protocol_version: "1.3.0",
    project_profile: profile,
    profile_decision: decision,
    requirement_digest: "b".repeat(64),
    risk_digest: "c".repeat(64),
    policy_digest: POLICY_DIGEST,
    baseline_digest: "d".repeat(64),
    policy: { required_capabilities: ["parallel_task_execution"] },
    providers: ["isolated_workspace_provider", "structured_gate_provider"],
  }) as CapabilityPlanRecord;
}

interface ParallelHarness {
  readonly deps: OrchestratorDependencies;
  readonly projectRoot: string;
  readonly workflowOperationId: string;
  readonly iterationId: string;
  readonly plan: CapabilityPlanRecord;
  readonly lock: DriverLockHandle;
  readonly runCalls: Parameters<ParallelTaskExecutionPort["run"]>[0][];
}

/**
 * Drive a fresh project through coordinated capture approval so the resumed
 * pipeline enters the accepted CapabilityPlan DAG with the parallel execute
 * subgraph. The CapabilityPlan and Driver Lock bind the real operation id,
 * which exists only after the first drive opens the operation — hence the
 * late-bound holder rather than a predicted id.
 */
async function driveToParallelExecute(
  name: string,
  options: {
    readonly outcome: (input: { readonly operation_id: string }) => ParallelTaskExecutionOutcome;
    readonly withBinding?: boolean;
    readonly untilPhase?: "execute" | "verify";
    readonly prepareSourceView?: (projectRoot: string) => string;
    readonly gates?: readonly GateDefinition[];
    readonly toolRegistry?: ToolRegistry;
    readonly gateSuiteForWorkspace?: (workspaceRoot: string) => {
      readonly gates: readonly GateDefinition[];
      readonly registry: ToolRegistry;
    };
  },
): Promise<ParallelHarness & { readonly outcome: OrchestrationOutcome }> {
  const newId = sequentialIds();
  const outcome0 = await createNewProject(
    { parentDirectory: makeTempDir("harness-parallel-exec-"), name, intent: INTENT },
    { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId },
  );
  if (!outcome0.ok) throw new Error(outcome0.error.message);
  const projectRoot = outcome0.value.projectRoot;
  const sourceViewRoot = options.prepareSourceView?.(projectRoot);

  const holder: { plan?: CapabilityPlanRecord; lock?: DriverLockHandle } = {};
  const runCalls: Parameters<ParallelTaskExecutionPort["run"]>[0][] = [];
  const port: ParallelTaskExecutionPort = {
    run: (input) => {
      runCalls.push(input);
      return Promise.resolve(options.outcome({ operation_id: input.operation_id }));
    },
  };
  const parallelExecution: ParallelExecutionBinding = {
    port,
    driverLock: () => {
      const lock = holder.lock;
      if (lock === undefined) {
        throw new Error("driver lock requested before the operation id exists");
      }
      return lock;
    },
    ...(sourceViewRoot === undefined
      ? {}
      : {
          openSourceView: () =>
            Promise.resolve({
              root: sourceViewRoot,
              commit: headOf(sourceViewRoot),
              release: () => Promise.resolve(),
            }),
        }),
  };
  const deps: OrchestratorDependencies = {
    projectRoot,
    readBaseline: () => headOf(projectRoot),
    now: () => FIXED_NOW,
    newId,
    vcs: createGitVcsAdapter(),
    capture: completingCaptureSeam(projectRoot),
    // The plan phase binds an execution authority into the ExecutionPlan even
    // though the parallel subgraph, not phaseExecute, consumes it.
    execution: {
      kind: "workflow",
      name: "test-parallel-execute-workflow",
      deterministic: true,
      execute: createDirectExecutor(),
    },
    ...(options.withBinding === false ? {} : { parallelExecution }),
    // The embedder seam is resolved lazily: the plan binds the operation id
    // minted by the first drive, so it exists only from the resume on.
    get capabilityPlan() {
      return holder.plan;
    },
    ...(options.gates === undefined ? {} : { gates: options.gates }),
    ...(options.toolRegistry === undefined ? {} : { toolRegistry: options.toolRegistry }),
    ...(options.gateSuiteForWorkspace === undefined
      ? {}
      : { gateSuiteForWorkspace: options.gateSuiteForWorkspace }),
  };

  const first = await runIteration(deps, { intent: INTENT });
  if (first.status !== "approval_required") {
    throw new Error(`expected capture approval_required, got ${first.status}`);
  }
  const workflowOperationId = first.required.workflow_operation_id;
  holder.plan = compileParallelPlan(workflowOperationId);
  holder.lock = {
    operation_id: workflowOperationId,
    owner_token: "owner_parallel_execute_test",
    path: `${projectRoot}/.harness/locks/driver`,
    release: () => Promise.resolve(),
  };
  await resolveApproval(deps, {
    requestId: first.required.request_id,
    decision: "approve",
    actor: "human:reviewer",
  });
  const outcome = await resumeIteration(deps, workflowOperationId, {
    intent: "",
    ...(options.untilPhase === undefined ? {} : { untilPhase: options.untilPhase }),
  });
  return {
    deps,
    projectRoot,
    workflowOperationId,
    iterationId:
      "iterationId" in outcome
        ? outcome.iterationId
        : (() => {
            throw new Error(`outcome ${outcome.status} carries no iterationId`);
          })(),
    plan: holder.plan,
    lock: holder.lock,
    runCalls,
    outcome,
  };
}

function currentOperationState(harness: ParallelHarness): string | undefined {
  return readCurrentOperation(
    { projectRoot: harness.projectRoot, readBaseline: () => headOf(harness.projectRoot) },
    harness.workflowOperationId,
  )?.state;
}

describe("kernel parallel execute branch", { timeout: 30000 * TEST_TIMEOUT_SCALE }, () => {
  it("fails closed with missing_input when the execute node has no ParallelExecutionBinding", async () => {
    const harness = await driveToParallelExecute("parallel-no-binding", {
      withBinding: false,
      outcome: ({ operation_id }) => ({
        status: "completed",
        operation_id,
        wave_integration_digests: WAVE_INTEGRATION_DIGESTS,
        scheduler_state_digest: SCHEDULER_STATE_DIGEST,
      }),
    });

    expect(harness.outcome).toMatchObject({
      status: "blocked",
      workflowOperationId: harness.workflowOperationId,
      reason: "missing_input",
    });
    if (harness.outcome.status !== "blocked") return;
    expect(harness.outcome.detail).toContain("ParallelExecutionBinding");
    expect(harness.outcome.resumeCommand).toBe(`harness resume ${harness.workflowOperationId}`);
    expect(harness.runCalls).toHaveLength(0);
    expect(currentOperationState(harness)).toBe("blocked");
  });

  it("runs the parallel port exactly once and journals the wave_integration binding", async () => {
    const harness = await driveToParallelExecute("parallel-completed", {
      untilPhase: "execute",
      outcome: ({ operation_id }) => ({
        status: "completed",
        operation_id,
        wave_integration_digests: WAVE_INTEGRATION_DIGESTS,
        scheduler_state_digest: SCHEDULER_STATE_DIGEST,
      }),
    });

    expect(harness.outcome).toMatchObject({
      status: "advanced",
      workflowOperationId: harness.workflowOperationId,
      completedPhase: "execute",
    });

    expect(harness.runCalls).toHaveLength(1);
    const call = harness.runCalls[0];
    if (call === undefined) throw new Error("parallel port never ran");
    const graph = materializeProjectGraph(harness.projectRoot);
    let expectedPlanDigest: string | undefined;
    try {
      const planNode = graph.nodes.find(
        (node) =>
          node.type === "ExecutionPlan" && node.provenance.iteration_id === harness.iterationId,
      );
      if (planNode === undefined) throw new Error("no ExecutionPlan committed for the iteration");
      expectedPlanDigest = readExecutionPlanContent(planNode).content_digest;
    } finally {
      graph.close();
    }
    expect(call).toEqual({
      operation_id: harness.workflowOperationId,
      iteration_id: harness.iterationId,
      capability_plan_digest: harness.plan.record_digest,
      expected_plan_digest: expectedPlanDigest,
      driver_lock: harness.lock,
    });

    // The paused until_phase node still journals its declared outputs: exactly
    // one execute checkpoint carrying the wave_integration binding of the
    // driver outcome (design §10.2).
    const expectedWaveDigest = contentDigest({
      operation_id: harness.workflowOperationId,
      wave_integration_digests: WAVE_INTEGRATION_DIGESTS,
      scheduler_state_digest: SCHEDULER_STATE_DIGEST,
    });
    const store = new LedgerDagCheckpointStore({
      projectRoot: harness.projectRoot,
      project_id: `project_${readManagedManifest(harness.projectRoot).name}`,
      iteration_id: harness.iterationId,
      attempt_id: "attempt_journal_read",
      readBaseline: () => headOf(harness.projectRoot),
    });
    const executeEntries = store
      .load(harness.workflowOperationId)
      .filter((entry) => entry.node_id === "execute");
    expect(executeEntries).toHaveLength(1);
    expect(executeEntries[0]?.plan_digest).toBe(harness.plan.record_digest);
    expect(executeEntries[0]?.output_digests["wave_integration"]).toBe(expectedWaveDigest);
    expect(currentOperationState(harness)).not.toBe("blocked");
  });

  it("rebinds configured generic verify gates to the accepted operation source view", async () => {
    let sourceRoot: string | undefined;
    const gate = normalizeGateDefinition({
      gate_id: "gate_operation_source",
      layer: "project",
      name: "operation source gate",
      mandatory: true,
      subject_id: "project_operation_source",
      tool: "check_operation_source",
      parameters: {},
    });
    const registryFor = (root: string): ToolRegistry => {
      const registry = new ToolRegistry();
      registry.register(
        {
          name: "check_operation_source",
          version: "1.0.0",
          description: "verify the exact operation source view",
          input_schema: { type: "object", properties: {}, additionalProperties: false },
          output_schema: {
            type: "object",
            properties: { exit_code: { type: "integer" }, summary: { type: "string" } },
            required: ["exit_code", "summary"],
            additionalProperties: false,
          },
          allowed_phases: ["verification"],
          resource_patterns: [],
          risk: "low",
          side_effect_class: "none",
          requires_approval: false,
          timeout_ms: 1_000,
          retry_class: "none",
          max_retries: 0,
          max_invocations_per_run: 10,
          idempotent: true,
          reconciliation: "provider",
        },
        () => ({
          exit_code: existsSync(`${root}/operation-only.txt`) ? 0 : 1,
          summary: root,
        }),
      );
      return registry;
    };
    const workspaceFactory = vi.fn((root: string) => ({
      gates: [gate],
      registry: registryFor(root),
    }));

    const harness = await driveToParallelExecute("parallel-operation-gates", {
      untilPhase: "verify",
      outcome: ({ operation_id }) => ({
        status: "completed",
        operation_id,
        wave_integration_digests: WAVE_INTEGRATION_DIGESTS,
        scheduler_state_digest: SCHEDULER_STATE_DIGEST,
      }),
      prepareSourceView: (projectRoot) => {
        sourceRoot = makeTempDir("harness-operation-source-");
        git(projectRoot, "worktree", "add", "--detach", sourceRoot, "HEAD");
        writeFileSync(`${sourceRoot}/operation-only.txt`, "accepted candidate\n", "utf8");
        git(sourceRoot, "add", "operation-only.txt");
        git(sourceRoot, "commit", "-m", "operation-only candidate");
        return sourceRoot;
      },
      gates: [gate],
      toolRegistry: registryFor("/path/that-is-not-the-operation-source"),
      gateSuiteForWorkspace: workspaceFactory,
    });

    expect(harness.outcome).toMatchObject({ status: "advanced", completedPhase: "verify" });
    expect(sourceRoot).toBeDefined();
    expect(workspaceFactory).toHaveBeenCalledWith(sourceRoot);
  });

  it("maps a paused drive to an awaiting_approval block with the resume command", async () => {
    const harness = await driveToParallelExecute("parallel-paused", {
      outcome: ({ operation_id }) => ({
        status: "paused",
        operation_id,
        wave_integration_digests: [],
        scheduler_state_digest: SCHEDULER_STATE_DIGEST,
      }),
    });

    expect(harness.outcome).toMatchObject({
      status: "blocked",
      workflowOperationId: harness.workflowOperationId,
      reason: "awaiting_approval",
    });
    if (harness.outcome.status !== "blocked") return;
    expect(harness.outcome.detail).toBe(
      `parallel execution paused for approval on ${harness.workflowOperationId}`,
    );
    expect(harness.outcome.resumeCommand).toBe(`harness resume ${harness.workflowOperationId}`);
    expect(harness.runCalls).toHaveLength(1);
    expect(currentOperationState(harness)).toBe("blocked");
  });

  it("maps a cancelled drive to a user_cancellation abort", async () => {
    const harness = await driveToParallelExecute("parallel-cancelled", {
      outcome: ({ operation_id }) => ({
        status: "cancelled",
        operation_id,
        wave_integration_digests: [],
        scheduler_state_digest: SCHEDULER_STATE_DIGEST,
      }),
    });

    expect(harness.outcome).toMatchObject({
      status: "aborted",
      workflowOperationId: harness.workflowOperationId,
      reason: "user_cancellation",
    });
    if (harness.outcome.status !== "aborted") return;
    expect(harness.outcome.detail).toBe(
      `parallel execution cancelled for ${harness.workflowOperationId}`,
    );
    expect(harness.runCalls).toHaveLength(1);
    expect(currentOperationState(harness)).toBe("aborted");
  });

  it("maps a blocked drive to a repairable_gate_failure block", async () => {
    const harness = await driveToParallelExecute("parallel-blocked", {
      outcome: ({ operation_id }) => ({
        status: "blocked",
        operation_id,
        wave_integration_digests: [],
        scheduler_state_digest: SCHEDULER_STATE_DIGEST,
      }),
    });

    expect(harness.outcome).toMatchObject({
      status: "blocked",
      workflowOperationId: harness.workflowOperationId,
      reason: "repairable_gate_failure",
    });
    if (harness.outcome.status !== "blocked") return;
    expect(harness.outcome.detail).toBe(
      `parallel execution blocked for ${harness.workflowOperationId} (scheduler state ${SCHEDULER_STATE_DIGEST})`,
    );
    expect(harness.outcome.resumeCommand).toBe(`harness resume ${harness.workflowOperationId}`);
    expect(harness.runCalls).toHaveLength(1);
    expect(currentOperationState(harness)).toBe("blocked");
  });
});
