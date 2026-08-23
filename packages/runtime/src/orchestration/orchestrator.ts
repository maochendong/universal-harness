import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  canonicalizeJson,
  contentDigest,
  harnessRootFor,
  readCommittedOperations,
  readManagedManifest,
  resolveHarnessPath,
  sha256Hex,
  validateSchema,
  type EdgeRecord,
  type NodeRecord,
} from "@universal-harness-internal/core";
import {
  generateImpactSet,
  readImpactSetContent,
  type ChangeSeed,
} from "@universal-harness-internal/graph";
import {
  approvalDecisionArtifact,
  buildApprovalDecision,
  proposedByOf,
  readApprovalRequests,
  type ApprovalDecision,
  type ApprovalRequestRecord,
} from "../approval/request.js";
import { resumeCommandFor } from "../approval/interaction.js";
import { evidenceBindingsOf, type GateEvidenceRecord } from "../gates/evidence.js";
import { hashWorktreeCode } from "../snapshot/anchor.js";
import { readExecutionPlanContent } from "../planning/execution-plan.js";
import { type SnapshotRecord } from "../snapshot/builder.js";
import {
  WorkflowEngine,
  readCurrentOperation,
  readRunStreams,
  streamTerminalRecord,
} from "../workflow/operation.js";
import { resumeWorkflowOperation } from "../workflow/resume.js";
import { isOrchestrationPhase, type OrchestrationPhase } from "./phases.js";
import {
  approvalDigestOf,
  approvalService,
  artifactExists,
  buildPipelineContext,
  captureProposal,
  commitArtifacts,
  commitRunNode,
  currentAttemptId,
  drivePipeline,
  effectivePolicy,
  harnessRoot,
  materializeProjectGraph,
  newIdOf,
  nowOf,
  PENDING_REQUIREMENT_BASELINE_DIGEST,
  readJsonArtifact,
  runNodeArtifactPath,
  runNodeRecord,
  submitCaptureAnswers,
  workflowDeps,
} from "./kernel-coordinator.js";
import { OrchestrationError } from "./pipeline-types.js";
import type {
  OrchestrationOutcome,
  OrchestratorDependencies,
  RunIterationInput,
} from "./pipeline-types.js";
import {
  moduleContributionsForCapabilityPlan,
  moduleContributionsForProfile,
} from "./profile-modules.js";

function contributionsForOperation(
  deps: OrchestratorDependencies,
  projectId: string,
  operationId: string,
) {
  if (deps.capabilityPlan !== undefined) {
    if (deps.capabilityPlan.operation_id !== operationId) {
      throw new OrchestrationError(
        "binding_drift",
        "accepted CapabilityPlan belongs to a different workflow operation",
      );
    }
    return moduleContributionsForCapabilityPlan(deps.capabilityPlan, {
      ...(deps.design === undefined ? {} : { design: deps.design }),
      ...(deps.impactAdvisory === undefined ? {} : { impact: { advisory: deps.impactAdvisory } }),
    });
  }
  return moduleContributionsForProfile(deps.projectRoot, projectId, {
    ...(deps.design === undefined ? {} : { design: deps.design }),
    ...(deps.impactAdvisory === undefined ? {} : { impact: { advisory: deps.impactAdvisory } }),
  });
}

/**
 * Compatibility facade (plan Task 8-A). The pipeline implementation lives in
 * the Kernel Coordinator (kernel-coordinator.ts) plus the capability Module
 * contributors under contributors/; this module owns the public entry
 * commands and wires the built-in contributors per the persisted project
 * profile (profile-modules.ts), so the pre-split import surface keeps
 * working unchanged.
 */

// Re-export the public surface the split moved into the deep modules, so
// existing consumers of this facade keep working unchanged.
export {
  ORCHESTRATION_ERROR_KINDS,
  OrchestrationError,
  type ClarificationOffer,
  type EvaluationPort,
  type EvaluationPortInput,
  type EvaluationPortResult,
  type IntentInterpreter,
  type InterpretedIntent,
  type OrchestrationErrorKind,
  type OrchestrationOutcome,
  type OrchestratorDependencies,
  type PhaseProgressEvent,
  type PlanTasksPort,
  type RunIterationInput,
  type TaskEnvelopeScopePort,
} from "./pipeline-types.js";
export {
  CAPTURE_APPROVAL_OBJECT_TYPE,
  captureSessionIdFor,
  findBridgedCaptureApprovalDecision,
  readBridgedCaptureApprovalDecision,
  requirementProposalViewOf,
  startCaptureCommandFor,
  type CaptureCoordinatorSeam,
  type CaptureCoordinatorSessionContext,
} from "./capture-coordinator.js";
export {
  createDefaultGateSuite,
  createDirectExecutor,
  createGenericInterpreter,
  materializeProjectGraph,
  submitCaptureAnswers,
} from "./kernel-coordinator.js";
export { createDefaultEvaluationPort } from "./contributors/evaluation-contributor.js";
export { provenQualityTaskIds } from "./contributors/audit-contributor.js";

/**
 * Open a new workflow operation for one intent and drive the phase pipeline
 * until completion, a phase limit, or a mandatory pause (input, approval or
 * external authorization).
 */
export async function runIteration(
  deps: OrchestratorDependencies,
  input: RunIterationInput,
): Promise<OrchestrationOutcome> {
  const open = findOpenWorkflowOperation(deps.projectRoot, deps.readBaseline);
  if (open !== undefined) {
    throw new OrchestrationError(
      "operation_already_open",
      `workflow operation ${open} is still open; resume or abort it before starting a new iteration`,
    );
  }
  const iterationId =
    input.iterationId ??
    `iteration_${sha256Hex(`${input.intent}:${String(readCommittedOperations(harnessRoot(deps)).length)}`).slice(0, 16)}`;
  // Coordinated capture binds the session and every invocation to the real
  // workflow operation (intent-to-prd design 16.1), so the Operation opens
  // first — phase capture — and capture runs inside the pipeline; the
  // requirement baseline digest stays the pending sentinel until the capture
  // phase seals the accepted baseline into its closing checkpoint. The legacy
  // interpreter path has no session to bind and keeps its historical order:
  // capture first, then the operation opens with the real digest.
  let requirementBaselineDigest: string;
  if (deps.capture !== undefined) {
    requirementBaselineDigest = PENDING_REQUIREMENT_BASELINE_DIGEST;
  } else {
    const captured = await captureProposal(deps, input.intent, iterationId);
    if (captured.status === "clarification_required") {
      return { status: "input_required", questions: captured.questions };
    }
    requirementBaselineDigest = captured.baselineDigest;
  }
  const policy = effectivePolicy();
  const engine = new WorkflowEngine(workflowDeps(deps));
  const projectId = `project_${readManagedManifest(deps.projectRoot).name}`;
  const started = await engine.startOperation({
    projectId,
    iterationId,
    goal: input.intent,
    baselineCommit: deps.readBaseline(),
    requirementBaselineDigest,
    policyDigest: policy.digest,
    phase: "capture",
    budgetCeiling: { steps: 30, tokens: 120000 },
  });
  const context = await buildPipelineContext(
    deps,
    started.operation.workflow_operation_id,
    started.operation.iteration_id,
    input,
    contributionsForOperation(deps, projectId, started.operation.workflow_operation_id),
  );
  if ("outcome" in context) return context.outcome;
  return drivePipeline(context, "capture", input.untilPhase);
}
/**
 * Resume a paused or interrupted workflow operation from its last committed
 * checkpoint. Bindings are re-verified by the resume protocol first; every
 * phase output is then reloaded or deterministically re-derived, never
 * duplicated. An operation left in a resumable state by a process crash is
 * first blocked as a typed recovery, then reopened, so interrupted runs get
 * exactly one RunInterrupted record and one successor run.
 */
export async function resumeIteration(
  deps: OrchestratorDependencies,
  workflowOperationId: string,
  input: RunIterationInput | undefined,
): Promise<OrchestrationOutcome> {
  const engine = new WorkflowEngine(workflowDeps(deps));
  const current = engine.getOperation(workflowOperationId);
  if (current === undefined) {
    throw new OrchestrationError(
      "operation_not_found",
      `unknown workflow operation: ${workflowOperationId}`,
    );
  }
  if (current.state === "completed" || current.state === "aborted") {
    throw new OrchestrationError(
      "operation_not_found",
      `workflow operation ${workflowOperationId} is terminal (${current.state}) and cannot resume`,
    );
  }
  const intent = input?.intent ?? engine.getWorkingState(workflowOperationId)?.goal;
  if (intent === undefined) {
    throw new OrchestrationError(
      "operation_not_found",
      `workflow operation ${workflowOperationId} has no working state goal`,
    );
  }
  if (input?.answers !== undefined && input.answers.length > 0) {
    if (deps.capture === undefined) {
      throw new OrchestrationError(
        "configuration",
        "clarification answers require a coordinated capture session; this operation has none",
      );
    }
    // The session binds the working-state goal, never the (possibly empty)
    // resume-input intent; submission happens before the operation reopens so
    // a rejected answer set leaves the block untouched.
    const goal = engine.getWorkingState(workflowOperationId)?.goal ?? intent;
    await submitCaptureAnswers(deps, deps.capture, goal, workflowOperationId, input.answers);
  }
  let resumedRuns: readonly {
    readonly interruptedRunId: string;
    readonly successorRunId: string;
  }[] = [];
  if (current.state === "blocked") {
    const resumed = await resumeWorkflowOperation(workflowDeps(deps), workflowOperationId);
    resumedRuns = resumed.resumedRuns;
  } else {
    // The operation is live but not blocked: either a decision was committed
    // while it was paused (nothing to reconcile -- drive on), or a process
    // died mid-attempt. A crash is first blocked with the typed recovery
    // reason, then reopened so interrupted runs get exactly one
    // RunInterrupted record and one successor run.
    const openRuns = readRunStreams(workflowDeps(deps), workflowOperationId).filter(
      (stream) => streamTerminalRecord(stream) === undefined,
    );
    if (openRuns.length > 0) {
      const state = engine.getWorkingState(workflowOperationId);
      await engine.block(workflowOperationId, {
        reason: "transient_environment_failure",
        detail:
          "recovered from an interrupted process; resuming from the last committed checkpoint",
        proposal: {
          ...(state === undefined ? {} : { phase: state.phase }),
          set_next_action: resumeCommandFor(workflowOperationId),
        },
      });
      const resumed = await resumeWorkflowOperation(workflowDeps(deps), workflowOperationId);
      resumedRuns = resumed.resumedRuns;
    }
  }
  const context = await buildPipelineContext(
    deps,
    workflowOperationId,
    current.iteration_id,
    {
      intent,
      ...(input?.iterationKind === undefined ? {} : { iterationKind: input.iterationKind }),
      ...(input?.intentShape === undefined ? {} : { intentShape: input.intentShape }),
      ...(input?.deterministicWork === undefined
        ? {}
        : { deterministicWork: input.deterministicWork }),
      ...(input?.untilPhase === undefined ? {} : { untilPhase: input.untilPhase }),
    },
    contributionsForOperation(
      deps,
      `project_${readManagedManifest(deps.projectRoot).name}`,
      workflowOperationId,
    ),
  );
  if ("outcome" in context) return context.outcome;
  // RESUMES edges bind run ids; both the interrupted run and its successor
  // must exist as Execution-Graph nodes before anything materializes.
  const resumedStreams = readRunStreams(workflowDeps(deps), workflowOperationId);
  const resumedRunBindings: Array<{ readonly runId: string; readonly taskId: string }> = [];
  for (const resumed of resumedRuns) {
    for (const runId of [resumed.interruptedRunId, resumed.successorRunId]) {
      const started = resumedStreams
        .find((stream) => stream.runId === runId)
        ?.records.find((record) => record.record_kind === "run_started");
      if (started === undefined) {
        throw new OrchestrationError("binding_drift", `resumed run ${runId} has no start fact`);
      }
      resumedRunBindings.push({ runId, taskId: started.task_id });
    }
  }
  const missingRunNodes = resumedRunBindings.filter(
    ({ runId }) => !artifactExists(deps, runNodeArtifactPath(runId)),
  );
  if (missingRunNodes.length > 0) {
    await commitArtifacts(
      deps,
      workflowOperationId,
      currentAttemptId(context),
      missingRunNodes.map(({ runId }) => ({
        path: runNodeArtifactPath(runId),
        content: `${canonicalizeJson(runNodeRecord(context, runId))}\n`,
      })),
    );
  }
  for (const binding of resumedRunBindings) {
    await commitRunNode(context, binding.runId, binding.taskId);
  }
  const phase = context.workingState.phase;
  if (!isOrchestrationPhase(phase)) {
    throw new OrchestrationError("invalid_phase", `checkpoint recorded unknown phase ${phase}`);
  }
  return drivePipeline(context, phase, input?.untilPhase);
}
/** The newest non-terminal workflow operation of a project, if any. */
export function findOpenWorkflowOperation(
  projectRoot: string,
  readBaseline: () => string,
): string | undefined {
  const operations = readCommittedOperations(harnessRootFor(projectRoot));
  const ids = [...new Set(operations.map((operation) => operation.manifest.workflow_operation_id))];
  for (const id of [...ids].reverse()) {
    const current = readCurrentOperation({ projectRoot, readBaseline }, id);
    if (current === undefined) continue;
    if (current.state !== "completed" && current.state !== "aborted") return id;
  }
  return undefined;
}
/** Drive the open workflow operation forward; the automation form of resume. */
export async function driveOpenOperation(
  deps: OrchestratorDependencies,
  untilPhase?: OrchestrationPhase,
): Promise<OrchestrationOutcome> {
  const workflowOperationId = findOpenWorkflowOperation(deps.projectRoot, deps.readBaseline);
  if (workflowOperationId === undefined) {
    throw new OrchestrationError(
      "no_open_operation",
      "no open workflow operation; start one with harness iterate",
    );
  }
  return resumeIteration(deps, workflowOperationId, {
    intent: "",
    ...(untilPhase === undefined ? {} : { untilPhase }),
  });
}
/** Resolve one pending approval request (design 11.3; never batch, never wildcard). */
export async function resolveApproval(
  deps: OrchestratorDependencies,
  input: {
    readonly requestId: string;
    readonly decision: ApprovalDecision;
    readonly actor: string;
    /** Optional caller-held binding used by conflict-aware HTTP clients. */
    readonly expectedObjectDigest?: string;
  },
): Promise<{
  readonly requestId: string;
  readonly decision: ApprovalDecision;
  readonly approvalDigest: string;
  readonly workflowOperationId: string;
}> {
  const operations = readCommittedOperations(harnessRoot(deps));
  const workflowIds = [
    ...new Set(operations.map((operation) => operation.manifest.workflow_operation_id)),
  ].sort();
  let request: ApprovalRequestRecord | undefined;
  for (const workflowId of workflowIds) {
    const found = readApprovalRequests(harnessRoot(deps), operations, workflowId).find(
      (candidate) => candidate.request_id === input.requestId,
    );
    if (found !== undefined) request = found;
  }
  if (request === undefined) {
    throw new OrchestrationError(
      "operation_not_found",
      `unknown approval request: ${input.requestId}`,
    );
  }
  if (
    input.expectedObjectDigest !== undefined &&
    input.expectedObjectDigest !== request.object_digest
  ) {
    throw new OrchestrationError(
      "binding_drift",
      `approval request ${request.request_id} changed; expected ${input.expectedObjectDigest}, current ${request.object_digest}`,
    );
  }
  const engine = new WorkflowEngine(workflowDeps(deps));
  const current = engine.getOperation(request.workflow_operation_id);
  if (input.decision === "reject") {
    // A reject never applies the proposal, so baseline or binding drift must
    // not block it (drift only matters for an approve that would bind stale
    // digests). The decision commits directly, without reopening the paused
    // operation -- this stays the escape hatch when resume can no longer run.
    if (!request.allowed_decisions.includes("reject")) {
      throw new OrchestrationError(
        "invalid_phase",
        `decision reject is not allowed for request ${request.request_id}`,
      );
    }
    if (input.actor === proposedByOf(request)) {
      throw new OrchestrationError(
        "invalid_phase",
        `actor ${input.actor} may not resolve its own approval request ${request.request_id}`,
      );
    }
    const stillPending = approvalService(deps)
      .pendingRequests(request.workflow_operation_id)
      .some((candidate) => candidate.request_id === request.request_id);
    if (!stillPending) {
      throw new OrchestrationError(
        "operation_not_found",
        `approval request ${request.request_id} is already decided or superseded`,
      );
    }
    const rejected = buildApprovalDecision({
      approvalId: newIdOf(deps, "approval_decision"),
      requestId: request.request_id,
      actor: input.actor,
      decision: "reject",
      objectDigest: request.object_digest,
      decidedAt: nowOf(deps),
    });
    await commitArtifacts(
      deps,
      request.workflow_operation_id,
      current?.attempt_id ?? "attempt_abort",
      [approvalDecisionArtifact(rejected)],
    );
    return {
      requestId: rejected.request_id,
      decision: rejected.decision,
      approvalDigest: approvalDigestOf(rejected),
      workflowOperationId: request.workflow_operation_id,
    };
  }
  // A paused operation cannot accept the decision checkpoint; reopen it
  // first (the resume protocol re-verifies every binding) and leave it live
  // for the follow-up `resume` that continues the pipeline.
  if (current !== undefined && current.state === "blocked") {
    await resumeWorkflowOperation(workflowDeps(deps), request.workflow_operation_id);
  }
  const record = await approvalService(deps).resolveDecision({
    requestId: request.request_id,
    decision: input.decision,
    objectDigest: request.object_digest,
    actor: input.actor,
  });
  if (input.decision === "defer") {
    const afterDecision = engine.getOperation(request.workflow_operation_id);
    if (afterDecision !== undefined && afterDecision.state !== "blocked") {
      await engine.block(request.workflow_operation_id, {
        reason: "awaiting_approval",
        detail: `approval request ${request.request_id} remains deferred`,
        proposal: {
          phase: request.resume_phase,
          set_next_action: resumeCommandFor(request.workflow_operation_id),
        },
      });
    }
  }
  return {
    requestId: record.request_id,
    decision: record.decision,
    approvalDigest: approvalDigestOf(record),
    workflowOperationId: request.workflow_operation_id,
  };
}
export interface AbortIterationInput {
  readonly workflowOperationId: string;
  /** Actor recorded for the abort and its rejection decisions. */
  readonly actor: string;
  readonly reason?: string;
}
export const FINDING_ACTIONS = ["accept", "close", "supersede"] as const;
export type FindingAction = (typeof FINDING_ACTIONS)[number];
export interface ResolveFindingInput {
  readonly findingId: string;
  readonly action: FindingAction;
  readonly actor: string;
  /** Required for close: the repair evidence vouching for the fix. */
  readonly evidenceId?: string;
}
export interface ResolvedFinding {
  readonly findingId: string;
  readonly action: FindingAction;
  /** Feedback status after the transition. */
  readonly status: "accepted" | "closed" | "superseded";
}
/**
 * Drive one Finding through its lifecycle (design 9.1). The transition
 * reseals the feedback record at `<action-status>.json` and, when the
 * finding has a graph node, commits the matching revision; closing or
 * superseding also retires the finding's active BLOCKS edges so resolved
 * findings drop out of status blockers and warnings. Close requires repair
 * evidence that exists, passed, is non-provisional and is still bound to the
 * current worktree -- the full digest-binding check stays with the phase
 * machinery. The graph vocabulary has no `closed` node status, so a closed
 * finding's node reads `superseded`; the exact resolution (including the
 * evidence id) lives in the feedback record.
 */
export async function resolveFinding(
  deps: OrchestratorDependencies,
  input: ResolveFindingInput,
): Promise<ResolvedFinding> {
  const feedbackPath = `artifacts/findings/${input.findingId}/proposed.json`;
  const feedback = readJsonArtifact<Record<string, unknown>>(deps, feedbackPath);
  if (feedback === undefined) {
    throw new OrchestrationError("operation_not_found", `unknown finding: ${input.findingId}`);
  }
  const existing = (status: string): boolean =>
    artifactExists(deps, `artifacts/findings/${input.findingId}/${status}.json`);
  if (existing("superseded") || existing("closed")) {
    throw new OrchestrationError(
      "operation_not_found",
      `finding ${input.findingId} is already resolved`,
    );
  }

  const targetStatus =
    input.action === "accept" ? "accepted" : input.action === "close" ? "closed" : "superseded";
  const fromStatus = existing("accepted") ? "accepted" : "proposed";
  if (input.action === "close") {
    if (input.evidenceId === undefined) {
      throw new OrchestrationError(
        "configuration",
        `closing finding ${input.findingId} requires --evidence <evidence-id>`,
      );
    }
    const evidence = readEvidenceArtifact(deps, input.evidenceId);
    if (evidence === undefined) {
      throw new OrchestrationError(
        "operation_not_found",
        `unknown or unusable repair evidence: ${input.evidenceId}`,
      );
    }
  }

  const content: Record<string, unknown> = { ...feedback, status: targetStatus };
  delete content["digest"];
  if (input.action === "close") {
    content.extensions = {
      ...(typeof feedback.extensions === "object" && feedback.extensions !== null
        ? (feedback.extensions as Record<string, unknown>)
        : {}),
      "harness.closure": {
        evidence_id: input.evidenceId,
        actor: input.actor,
        closed_at: nowOf(deps),
      },
    };
  }
  const record = { ...content, digest: contentDigest(content) };
  const validation = validateSchema("feedback", record);
  if (!validation.valid) {
    throw new OrchestrationError(
      "configuration",
      `invalid finding transition record: ${validation.errors
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }

  const operations = readCommittedOperations(harnessRoot(deps));
  const lastOperation = operations.at(-1);
  if (lastOperation === undefined) {
    throw new OrchestrationError("operation_not_found", "no committed ledger operation");
  }
  const commitContext = {
    workflowOperationId: lastOperation.manifest.workflow_operation_id,
    attemptId: lastOperation.manifest.attempt_id,
  };

  const artifacts: { readonly path: string; readonly content: string }[] = [
    {
      path: `artifacts/findings/${input.findingId}/${targetStatus}.json`,
      content: `${canonicalizeJson(record)}\n`,
    },
  ];
  const edges: EdgeRecord[] = [];

  const graph = materializeProjectGraph(deps.projectRoot);
  let findingNode: NodeRecord | undefined;
  let activeBlocksEdges: readonly EdgeRecord[];
  try {
    findingNode = graph.nodes
      .filter((node) => node.id === input.findingId && node.type === "Finding")
      .sort((left, right) => left.revision - right.revision)
      .at(-1);
    activeBlocksEdges = graph.edges.filter(
      (edge) =>
        edge.type === "BLOCKS" &&
        edge.source_id === input.findingId &&
        (edge.status === "proposed" || edge.status === "accepted"),
    );
  } finally {
    graph.close();
  }
  if (findingNode !== undefined) {
    const nodeStatus = input.action === "accept" ? "accepted" : "superseded";
    if (findingNode.status !== nodeStatus) {
      const revision = findingNode.revision + 1;
      const base: Record<string, unknown> = Object.fromEntries(
        Object.entries(findingNode).filter(([key]) => key !== "digest"),
      );
      base.revision = revision;
      base.status = nodeStatus;
      base.provenance = {
        iteration_id: findingNode.provenance.iteration_id,
        actor: input.actor,
        timestamp: nowOf(deps),
      };
      const node = { ...base, digest: contentDigest(base) };
      const nodeValidation = validateSchema("node", node);
      if (!nodeValidation.valid) {
        throw new OrchestrationError(
          "configuration",
          `invalid finding node revision: ${nodeValidation.errors
            .map((issue) => issue.message)
            .join("; ")}`,
        );
      }
      artifacts.push({
        path: `artifacts/finding-nodes/${input.findingId}/${String(revision)}.json`,
        content: `${canonicalizeJson(node)}\n`,
      });
    }
  }
  if (input.action !== "accept") {
    for (const edge of activeBlocksEdges) {
      const retiredContent: Record<string, unknown> = Object.fromEntries(
        Object.entries(edge).filter(([key]) => key !== "digest"),
      );
      retiredContent.status = "superseded";
      retiredContent.provenance = {
        iteration_id: edge.provenance.iteration_id,
        actor: input.actor,
        timestamp: nowOf(deps),
      };
      const retired = { ...retiredContent, digest: contentDigest(retiredContent) };
      const edgeValidation = validateSchema("edge", retired);
      if (!edgeValidation.valid) {
        throw new OrchestrationError(
          "configuration",
          `invalid retired edge: ${edgeValidation.errors.map((issue) => issue.message).join("; ")}`,
        );
      }
      edges.push(retired as unknown as EdgeRecord);
    }
  }
  await commitArtifacts(
    deps,
    commitContext.workflowOperationId,
    commitContext.attemptId,
    artifacts,
    edges,
    [
      {
        eventType:
          input.action === "accept"
            ? "FindingAccepted"
            : input.action === "close"
              ? "FindingClosed"
              : "FindingSuperseded",
        iterationId:
          findingNode?.provenance.iteration_id ??
          String(feedback["iteration_id"] ?? "iteration_unknown"),
        payload: {
          finding_id: input.findingId,
          from: fromStatus,
          to: targetStatus,
          actor: input.actor,
          cause: `single_${input.action}`,
          ...(input.evidenceId === undefined ? {} : { evidence_id: input.evidenceId }),
        },
      },
    ],
  );
  return { findingId: input.findingId, action: input.action, status: targetStatus };
}
/** Passed, non-provisional evidence bound to the current worktree, if any. */
function readEvidenceArtifact(
  deps: OrchestratorDependencies,
  evidenceId: string,
): GateEvidenceRecord | undefined {
  const directory = resolveHarnessPath(harnessRoot(deps), `artifacts/evidence/${evidenceId}`);
  if (!existsSync(directory)) return undefined;
  const codeHash = hashWorktreeCode(deps.projectRoot);
  for (const name of readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .sort()) {
    const record = readJsonArtifact<GateEvidenceRecord>(
      deps,
      `artifacts/evidence/${evidenceId}/${name}`,
    );
    if (record === undefined || record.provisional) continue;
    const extension = record.extensions?.["harness.gate"];
    if (typeof extension !== "object" || extension === null) continue;
    const passed = (extension as Record<string, unknown>).passed === true;
    const bindings = evidenceBindingsOf(record);
    if (!passed || bindings === undefined) continue;
    if (!bindings.code_digests.includes(codeHash)) continue;
    return record;
  }
  return undefined;
}
export interface AbortedIteration {
  readonly workflowOperationId: string;
  readonly iterationId: string;
  /** Pending approval requests closed by the abort, in request order. */
  readonly rejectedRequests: readonly string[];
}
/**
 * Abort an open workflow operation (design 10: explicit cancellation is the
 * only user-driven path to `aborted`). This is the escape hatch when every
 * recovery path is sealed -- for example when the Git baseline drifted after
 * the checkpoint, so resume and approve both refuse to run. The abort never
 * re-verifies checkpoint bindings: it closes every pending approval request
 * with an explicit reject decision by the aborting actor (a reject applies
 * nothing, so drift cannot make it unsafe), commits the terminal `aborted`
 * operation record with its OperationCompleted event, and marks a committed
 * Iteration node aborted so status stops treating it as open. Everything is
 * ledger-backed; nothing is deleted.
 */
export async function abortIteration(
  deps: OrchestratorDependencies,
  input: AbortIterationInput,
): Promise<AbortedIteration> {
  const engine = new WorkflowEngine(workflowDeps(deps));
  const current = engine.getOperation(input.workflowOperationId);
  if (current === undefined) {
    throw new OrchestrationError(
      "operation_not_found",
      `unknown workflow operation: ${input.workflowOperationId}`,
    );
  }
  if (current.state === "completed" || current.state === "aborted") {
    throw new OrchestrationError(
      "operation_not_found",
      `workflow operation ${input.workflowOperationId} is terminal (${current.state}) and cannot abort`,
    );
  }

  const pending = approvalService(deps).pendingRequests(input.workflowOperationId);
  if (pending.length > 0) {
    await commitArtifacts(
      deps,
      input.workflowOperationId,
      current.attempt_id,
      pending.map((request) => {
        const record = buildApprovalDecision({
          approvalId: newIdOf(deps, "approval_decision"),
          requestId: request.request_id,
          actor: input.actor,
          decision: "reject",
          objectDigest: request.object_digest,
          decidedAt: nowOf(deps),
        });
        return approvalDecisionArtifact(record);
      }),
    );
  }

  await engine.abort(input.workflowOperationId, {
    reason: "user_cancellation",
    detail: input.reason ?? `aborted by ${input.actor}`,
  });

  const graph = materializeProjectGraph(deps.projectRoot);
  let iterationNode: NodeRecord | undefined;
  try {
    iterationNode = graph.nodes
      .filter((node) => node.id === current.iteration_id && node.type === "Iteration")
      .sort((left, right) => left.revision - right.revision)
      .at(-1);
  } finally {
    graph.close();
  }
  if (
    iterationNode !== undefined &&
    iterationNode.iteration_state !== "completed" &&
    iterationNode.iteration_state !== "aborted"
  ) {
    const revision = iterationNode.revision + 1;
    const base: Record<string, unknown> = Object.fromEntries(
      Object.entries(iterationNode).filter(([key]) => key !== "digest"),
    );
    base.revision = revision;
    base.iteration_state = "aborted";
    base.provenance = {
      iteration_id: current.iteration_id,
      actor: input.actor,
      timestamp: nowOf(deps),
    };
    const node = { ...base, digest: contentDigest(base) };
    const validation = validateSchema("node", node);
    if (!validation.valid) {
      throw new OrchestrationError(
        "configuration",
        `invalid aborted iteration node: ${validation.errors
          .map((issue) => issue.message)
          .join("; ")}`,
      );
    }
    await commitArtifacts(deps, input.workflowOperationId, current.attempt_id, [
      {
        path: `artifacts/iterations/${current.iteration_id}/${String(revision)}.json`,
        content: `${canonicalizeJson(node)}\n`,
      },
    ]);
  }

  return {
    workflowOperationId: input.workflowOperationId,
    iterationId: current.iteration_id,
    rejectedRequests: pending.map((request) => request.request_id),
  };
}
/** Read-only impact preview over the current materialized graph. */
export function previewImpactSet(
  projectRoot: string,
  target?: string,
): {
  readonly impactSetId: string;
  readonly contentDigest: string;
  readonly seedNodeId: string;
  readonly entries: readonly {
    readonly node_id: string;
    readonly classification: string;
    readonly risk: string;
  }[];
} {
  const graph = materializeProjectGraph(projectRoot);
  try {
    let seedNodeId = target;
    if (seedNodeId === undefined) {
      const candidate = [...graph.nodes]
        .filter((node) => node.type === "Requirement" || node.type === "Intent")
        .sort((left, right) => (left.id < right.id ? -1 : 1))
        .at(-1);
      if (candidate === undefined) {
        throw new OrchestrationError(
          "operation_not_found",
          "no Intent or Requirement node to seed an impact preview",
        );
      }
      seedNodeId = candidate.id;
    }
    if (!graph.nodes.some((node) => node.id === seedNodeId)) {
      throw new OrchestrationError(
        "operation_not_found",
        `unknown impact seed node: ${seedNodeId}`,
      );
    }
    const seed: ChangeSeed = {
      id: `seed_${sha256Hex(`${seedNodeId}:preview`).slice(0, 16)}`,
      nodeId: seedNodeId,
      kind: "content-change",
      iterationKind: "feature",
      reason: "impact preview seed",
    };
    const impactSet = generateImpactSet([seed], [...graph.nodes], [...graph.edges], {
      iterationId: "iteration_preview",
      actor: "workflow-engine",
      timestamp: "1970-01-01T00:00:00.000Z",
    });
    const content = readImpactSetContent(impactSet);
    return {
      impactSetId: impactSet.id,
      contentDigest: content.content_digest,
      seedNodeId,
      entries: content.entries.map((entry) => ({
        node_id: entry.node_id,
        classification: entry.classification,
        risk: entry.risk,
      })),
    };
  } finally {
    graph.close();
  }
}
/** The latest committed ExecutionPlan of the project, if any. */
export function readLatestExecutionPlan(projectRoot: string):
  | {
      readonly planId: string;
      readonly mode: string;
      readonly impactSetId: string;
      readonly iterationId: string;
      readonly tasks: readonly {
        readonly id: string;
        readonly objective: string;
        readonly required_gates: readonly string[];
      }[];
    }
  | undefined {
  const graph = materializeProjectGraph(projectRoot);
  try {
    const node = [...graph.nodes]
      .filter((candidate) => candidate.type === "ExecutionPlan")
      .sort((left, right) => (left.id < right.id ? -1 : 1))
      .at(-1);
    if (node === undefined) return undefined;
    const content = readExecutionPlanContent(node);
    return {
      planId: node.id,
      mode: content.mode,
      impactSetId: content.impact_set_id,
      iterationId: node.provenance.iteration_id,
      tasks: content.tasks.map((task) => ({
        id: task.id,
        objective: task.objective,
        required_gates: task.required_gates,
      })),
    };
  } finally {
    graph.close();
  }
}
/** The latest committed snapshot record of the project, if any. */
export function readLatestSnapshot(projectRoot: string): SnapshotRecord | undefined {
  const directory = resolveHarnessPath(harnessRootFor(projectRoot), "artifacts/snapshots");
  if (!existsSync(directory)) return undefined;
  let latest: SnapshotRecord | undefined;
  for (const name of readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .sort()) {
    const parsed = JSON.parse(
      readFileSync(
        resolveHarnessPath(harnessRootFor(projectRoot), `artifacts/snapshots/${name}`),
        "utf8",
      ),
    ) as SnapshotRecord;
    if (latest === undefined || parsed.created_at > latest.created_at) latest = parsed;
  }
  return latest;
}
