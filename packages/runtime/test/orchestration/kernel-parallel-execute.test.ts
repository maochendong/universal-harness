import { afterEach, describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";

import {
  appendProjectContextBundleRecord,
  compileCapabilityPlan,
  contentDigest,
  createCaptureAcceptanceStageHandler,
  createCaptureProposalStageHandlers,
  createCaptureReviewStageHandlers,
  createCaptureRiskStageHandlers,
  createInMemoryPrdProposalAdapter,
  createInMemoryPrdReviewAdapter,
  createPrdCaptureCoordinator,
  createProjectContextBundleRecord,
  createProjectProfileRecord,
  createProfileDecisionRecord,
  readManagedManifest,
  type CaptureSessionRecord,
  type CaptureStageRequest,
  type CapabilityPlanRecord,
  type PrdProposalDraft,
  type PrdReviewReportDraft,
  type PrdReviewRubric,
} from "@universal-harness-internal/core";

import {
  createDirectExecutor,
  createNewProject,
  LedgerDagCheckpointStore,
  materializeProjectGraph,
  readBridgedCaptureApprovalDecision,
  readCurrentOperation,
  readExecutionPlanContent,
  resolveApproval,
  resumeIteration,
  runIteration,
  type CaptureCoordinatorSeam,
  type OrchestrationOutcome,
  type OrchestratorDependencies,
  type ParallelExecutionBinding,
  type ParallelTaskExecutionOutcome,
  type ParallelTaskExecutionPort,
} from "../../src/index.js";
import type { DriverLockHandle } from "../../src/scheduling/driver-lock.js";
import {
  FIXED_NOW,
  cleanupDirectories,
  headOf,
  makeTempDir,
  sequentialIds,
} from "../bootstrap/helpers.js";

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
const PROPOSAL_ADAPTER_PROFILE_DIGEST = "e".repeat(64);
const PROPOSAL_PROMPT_VERSION_DIGEST = "f".repeat(64);
const REVIEW_ADAPTER_PROFILE_DIGEST = "7".repeat(64);
const REVIEW_PROMPT_VERSION_DIGEST = "8".repeat(64);

const WAVE_INTEGRATION_DIGESTS = ["1".repeat(64)];
const SCHEDULER_STATE_DIGEST = "2".repeat(64);

const REVIEW_RUBRIC: PrdReviewRubric = {
  rubric_id: "capture-review-rubric",
  dimensions: [
    { dimension_id: "clarity", prompt: "Is every requirement unambiguous?" },
    { dimension_id: "completeness", prompt: "Does the PRD cover the intent?" },
    { dimension_id: "testability", prompt: "Is every criterion observable?" },
  ],
  mandatory_dimension_ids: ["clarity", "completeness", "testability"],
};

/** A draft that passes every hard gate: one must-change requirement, one atomic criterion. */
function validDraft(session: CaptureSessionRecord): PrdProposalDraft {
  const binding = {
    source_kind: "intent" as const,
    source_id: "intent",
    source_digest: session.intent_digest,
  };
  return {
    schema_version: "1.1.0",
    intent: { text: session.intent_text, digest: session.intent_digest },
    problem_statement: "Users cannot archive monthly reports outside the application.",
    goals: [
      {
        draft_key: "goal-1",
        lineage: { kind: "new" },
        proposed_source_bindings: [binding],
        statement: "Users can export the monthly report as a CSV file.",
      },
    ],
    non_goals: [],
    actors: [],
    scenarios: [],
    requirements: [
      {
        draft_key: "req-1",
        lineage: { kind: "new" },
        proposed_source_bindings: [binding],
        statement: "The user can export the monthly report as a CSV file.",
        priority: "must",
        change_kind: "must_change",
        scenario_ids: [],
        acceptance_criterion_ids: ["criterion-1"],
      },
    ],
    constraints: [],
    acceptance_criteria: [
      {
        draft_key: "criterion-1",
        lineage: { kind: "new" },
        proposed_source_bindings: [binding],
        requirement_id: "req-1",
        precondition: "a monthly report exists for the user",
        action: "the user exports the report as CSV",
        observable_outcome: "a CSV file containing the report rows is produced",
        verification_intent: "compare the exported CSV rows with the report data",
        test_first_example:
          "given an existing report, exporting produces a CSV whose rows match the report",
        scenario_kind: "primary",
      },
    ],
    assumptions: [],
    dependencies: [],
    risks: [],
    open_questions: [],
    glossary: [],
    context_source_refs: [],
  };
}

function acceptDraft(): PrdReviewReportDraft {
  return {
    verdict: "accept",
    dimensions: REVIEW_RUBRIC.dimensions.map((dimension) => ({
      dimension_id: dimension.dimension_id,
      status: "satisfied" as const,
      notes: "ok",
    })),
    findings: [],
    suggested_questions: [],
  };
}

/**
 * A capture seam whose coordinator drives a session from start to the human
 * approval route with the real proposal/review/risk/acceptance stages; the
 * approval decision is consumed through the engine bridge on resume.
 */
function completingCaptureSeam(projectRoot: string): CaptureCoordinatorSeam {
  const proposalStages = createCaptureProposalStageHandlers({
    projectRoot,
    proposal: createInMemoryPrdProposalAdapter((input) => ({
      status: "proposed" as const,
      draft: validDraft(input.session),
    })),
    adapter_profile: {
      backing: "in_memory",
      adapter_profile_digest: PROPOSAL_ADAPTER_PROFILE_DIGEST,
      prompt_version_digest: PROPOSAL_PROMPT_VERSION_DIGEST,
      producer_identity: "in-memory-proposal",
    },
  });
  const reviewStages = createCaptureReviewStageHandlers({
    projectRoot,
    review: createInMemoryPrdReviewAdapter(() => ({
      status: "completed" as const,
      report: acceptDraft(),
    })),
    rubric: REVIEW_RUBRIC,
    adapter_profile: {
      backing: "in_memory",
      adapter_profile_digest: REVIEW_ADAPTER_PROFILE_DIGEST,
      prompt_version_digest: REVIEW_PROMPT_VERSION_DIGEST,
      reviewer_identity: "in-memory-review",
    },
  });
  const risk = createCaptureRiskStageHandlers({
    projectRoot,
    policy: {
      project_id: `project_${readManagedManifest(projectRoot).name}`,
      profile_id: "standard",
      allow_policy_auto_approval: false,
      policy_actor: "policy:capture-standard@1",
    },
    policy_digest: POLICY_DIGEST,
  });
  const accept = createCaptureAcceptanceStageHandler({
    projectRoot,
    readBaseline: () => headOf(projectRoot),
    policy_digest: POLICY_DIGEST,
    now: () => FIXED_NOW,
  });
  const compileContext = (request: CaptureStageRequest) => {
    const purpose = request.invocation?.purpose === "context_review" ? "review" : "proposal";
    const bundle = createProjectContextBundleRecord({
      session_id: request.session.session_id,
      purpose,
      project_baseline_digest: request.session.project_baseline_digest,
      profile_digest: request.session.project_profile_digest,
      policy_digest: request.session.capture_policy_digest,
      budget: {
        max_files: 10,
        max_bytes_per_source: 4096,
        max_total_bytes: 16384,
        max_summary_chars: 500,
      },
      sources: [],
      exclusions: [],
    });
    appendProjectContextBundleRecord(projectRoot, bundle);
    return { kind: "context_compiled" as const, bundle_digest: bundle.content_digest };
  };
  return {
    coordinator: createPrdCaptureCoordinator({
      projectRoot,
      handlers: {
        compileContext,
        propose: proposalStages.propose,
        validate: proposalStages.validate,
        review: reviewStages.review,
        assessRisk: risk.assessRisk,
        accept,
      },
      readApprovalDecision: (requestId, decisionId) =>
        readBridgedCaptureApprovalDecision(projectRoot, requestId, decisionId),
    }),
    session_context: {
      project_profile_digest: "a".repeat(64),
      profile_decision_digest: "b".repeat(64),
      capture_policy_digest: "c".repeat(64),
      project_baseline_digest: "d".repeat(64),
    },
  };
}

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
    readonly untilPhase?: "execute";
  },
): Promise<ParallelHarness & { readonly outcome: OrchestrationOutcome }> {
  const newId = sequentialIds();
  const outcome0 = await createNewProject(
    { parentDirectory: makeTempDir("harness-parallel-exec-"), name, intent: INTENT },
    { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId },
  );
  if (!outcome0.ok) throw new Error(outcome0.error.message);
  const projectRoot = outcome0.value.projectRoot;

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
