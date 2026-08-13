import { readFileSync } from "node:fs";

import {
  LedgerError,
  PROTOCOL_VERSION,
  canonicalizeJson,
  contentDigest,
  harnessRootFor,
  resolveHarnessPath,
  sha256Hex,
  ulid,
  validateSchema,
  type EdgeRecord,
  type LifecycleEvent,
  type RunRecord,
} from "@universal-harness-internal/core";

import {
  artifactDigestAllowlist,
  latestValidCheckpoint,
  listArtifactFiles,
  readVerifiedJsonArtifact,
} from "./checkpoint.js";
import {
  WorkflowError,
  buildRunInterruptedRecord,
  buildRunStartedRecord,
  ledgerRepositoryFor,
  nextEventSequence,
  operationRecordArtifactPath,
  readCurrentOperation,
  readOperationHistory,
  readRunStreams,
  runRecordArtifactPath,
  streamTerminalRecord,
  type WorkflowDependencies,
  type WorkflowIdKind,
} from "./operation.js";
import { resumeTargetFor, type ResumableOperationState } from "./state-machine.js";
import type { WorkingState } from "./working-state.js";

/**
 * Resume protocol (design 10.3 and 15.3): reopen a blocked workflow
 * operation with a new `attempt_id` from the latest valid checkpoint.
 * Baseline, approval and ContextBundle bindings are re-verified first;
 * runs without a terminal record are closed with exactly one
 * `RunInterrupted` and replaced by one successor Run linked `RESUMES`, so a
 * resume never duplicates nodes, runs, evidence, commits or completed steps.
 */
export interface ResumedRun {
  readonly interruptedRunId: string;
  readonly interruptedSequence: number;
  readonly successorRunId: string;
}

export interface ResumeOutcome {
  readonly workflowOperationId: string;
  readonly attemptId: string;
  readonly resumedState: ResumableOperationState;
  readonly checkpointId: string;
  readonly resumedRuns: readonly ResumedRun[];
  readonly ledgerOperationId: string;
}

interface ApprovalDecisionShape {
  readonly record_kind: string;
  readonly decision: string;
}

/** Re-verify every approval digest the WorkingState still relies on. */
function verifyApprovalBindings(
  harnessRoot: string,
  allowedDigests: ReadonlySet<string>,
  workingState: WorkingState,
): void {
  if (workingState.approval_digests.length === 0) return;
  const decisions = new Map<string, ApprovalDecisionShape>();
  for (const relative of listArtifactFiles(harnessRoot, "artifacts/approvals")) {
    let parsed: unknown;
    try {
      parsed = readVerifiedJsonArtifact(harnessRoot, relative, allowedDigests);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const candidate = parsed as ApprovalDecisionShape;
    if (candidate.record_kind !== "approval_decision") continue;
    decisions.set(
      sha256Hex(readFileSync(resolveHarnessPath(harnessRoot, relative), "utf8")),
      candidate,
    );
  }
  for (const digest of workingState.approval_digests) {
    const decision = decisions.get(digest);
    if (decision === undefined) {
      throw new WorkflowError(
        "approval_invalid",
        `approval binding ${digest} has no committed approval decision artifact`,
      );
    }
    if (decision.decision !== "approve") {
      throw new WorkflowError(
        "approval_invalid",
        `approval binding ${digest} no longer resolves to approve`,
      );
    }
  }
}

/** Re-verify the ContextBundle binding: it must exist and not be stale. */
function verifyContextBundleBinding(
  harnessRoot: string,
  allowedDigests: ReadonlySet<string>,
  workingState: WorkingState,
): void {
  const digest = workingState.context_bundle_digest;
  if (digest === undefined) return;
  for (const relative of listArtifactFiles(harnessRoot, "artifacts/context-bundles")) {
    let parsed: unknown;
    try {
      parsed = readVerifiedJsonArtifact(harnessRoot, relative, allowedDigests);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const bundle = parsed as { record_kind?: unknown; digest?: unknown; stale?: unknown };
    if (bundle.record_kind !== "context_bundle" || bundle.digest !== digest) continue;
    if (bundle.stale === true) {
      throw new WorkflowError(
        "context_bundle_invalid",
        `context bundle ${digest} is stale; recompile context before resuming`,
      );
    }
    return;
  }
  throw new WorkflowError(
    "context_bundle_invalid",
    `context bundle ${digest} has no committed artifact`,
  );
}

export async function resumeWorkflowOperation(
  deps: WorkflowDependencies,
  workflowOperationId: string,
): Promise<ResumeOutcome> {
  const repository = ledgerRepositoryFor(deps);
  const harnessRoot = harnessRootFor(deps.projectRoot);
  const operations = repository.operations();

  const current = readCurrentOperation(deps, workflowOperationId);
  if (current === undefined) {
    throw new WorkflowError(
      "operation_not_found",
      `unknown workflow operation: ${workflowOperationId}`,
    );
  }
  if (current.state === "completed" || current.state === "aborted") {
    throw new WorkflowError(
      "operation_terminal",
      `workflow operation ${workflowOperationId} is terminal (${current.state}) and cannot resume`,
    );
  }
  const resumedState = resumeTargetFor(current.state, current.resume_state);

  const committed = latestValidCheckpoint(harnessRoot, operations, workflowOperationId);
  if (committed === undefined) {
    throw new WorkflowError(
      "checkpoint_not_found",
      `workflow operation ${workflowOperationId} has no valid checkpoint to resume from`,
    );
  }
  const { workingState } = committed;

  // Re-verify bindings recorded in the checkpoint before any new commit.
  const baseline = deps.readBaseline();
  if (baseline !== workingState.baseline_commit) {
    throw new WorkflowError(
      "baseline_mismatch",
      `baseline drifted since the checkpoint: expected ${workingState.baseline_commit}, current ${baseline}`,
    );
  }
  const allowedDigests = artifactDigestAllowlist(operations, workflowOperationId);
  verifyApprovalBindings(harnessRoot, allowedDigests, workingState);
  verifyContextBundleBinding(harnessRoot, allowedDigests, workingState);

  // Reconcile runs that never reached a terminal record.
  const newId = deps.newId ?? ((kind: WorkflowIdKind) => `${kind}_${ulid()}`);
  const timestamp = (deps.now ?? (() => new Date().toISOString()))();
  const attemptId = newId("attempt");
  const interrupted = readRunStreams(deps, workflowOperationId).filter(
    (stream) => streamTerminalRecord(stream) === undefined,
  );

  const artifacts: { readonly path: string; readonly content: string }[] = [];
  const edges: EdgeRecord[] = [];
  const resumedRuns: ResumedRun[] = [];
  for (const stream of interrupted) {
    const started = stream.records[0];
    if (started === undefined || started.record_kind !== "run_started") {
      throw new WorkflowError(
        "operation_corrupt",
        `run ${stream.runId} has no RunStarted record and cannot be reconciled`,
      );
    }
    const partialEvidenceIds = stream.records
      .filter(
        (record): record is RunRecord & { readonly evidence_id: string } =>
          record.record_kind === "run_progress" && "evidence_id" in record,
      )
      .map((record) => record.evidence_id);
    const interruptedSequence =
      stream.records.reduce((maximum, record) => Math.max(maximum, record.sequence), 0) + 1;
    const interruptedRecord = buildRunInterruptedRecord({
      runId: stream.runId,
      taskId: started.task_id,
      workflowOperationId,
      attemptId: started.attempt_id,
      sequence: interruptedSequence,
      timestamp,
      outcome: partialEvidenceIds.length > 0 ? "partial" : "failed",
      partialEvidenceIds: [...new Set(partialEvidenceIds)],
    });
    artifacts.push({
      path: runRecordArtifactPath(stream.runId, interruptedSequence, "run_interrupted"),
      content: `${canonicalizeJson(interruptedRecord)}\n`,
    });

    const successorRunId = newId("run");
    const successor = buildRunStartedRecord({
      runId: successorRunId,
      taskId: started.task_id,
      workflowOperationId,
      attemptId,
      sequence: 1,
      timestamp,
      contextBundleId: started.context_bundle_id,
    });
    artifacts.push({
      path: runRecordArtifactPath(successorRunId, 1, "run_started"),
      content: `${canonicalizeJson(successor)}\n`,
    });

    const edgeDraft: Record<string, unknown> = {
      protocol_version: PROTOCOL_VERSION,
      record_kind: "edge",
      id: newId("edge"),
      type: "RESUMES",
      source_id: successorRunId,
      target_id: stream.runId,
      status: "accepted",
      source: "workflow",
      provenance: {
        iteration_id: current.iteration_id,
        actor: "workflow-engine",
        timestamp,
      },
      confidence: 1,
    };
    const edge = { ...edgeDraft, digest: contentDigest(edgeDraft) };
    const edgeValidation = validateSchema("edge", edge);
    if (!edgeValidation.valid) {
      throw new WorkflowError(
        "operation_corrupt",
        `invalid RESUMES edge: ${edgeValidation.errors.map((issue) => issue.message).join("; ")}`,
      );
    }
    edges.push(edge as unknown as EdgeRecord);
    resumedRuns.push({ interruptedRunId: stream.runId, interruptedSequence, successorRunId });
  }

  const ledgerOperationId = newId("ledger");
  const history = readOperationHistory(deps, workflowOperationId);
  const projectExtension = current.extensions?.["harness.workflow"];
  const projectId =
    typeof projectExtension === "object" && projectExtension !== null
      ? (projectExtension as { project_id?: unknown }).project_id
      : undefined;
  if (typeof projectId !== "string") {
    throw new WorkflowError(
      "operation_corrupt",
      `workflow operation ${workflowOperationId} is missing its project binding`,
    );
  }
  const operationDraft: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "workflow_operation",
    workflow_operation_id: workflowOperationId,
    attempt_id: attemptId,
    iteration_id: current.iteration_id,
    state: resumedState,
    updated_at: timestamp,
    extensions: current.extensions ?? { "harness.workflow": { project_id: projectId } },
  };
  const operationValidation = validateSchema("workflow-operation", operationDraft);
  if (!operationValidation.valid) {
    throw new WorkflowError(
      "operation_corrupt",
      `invalid resumed operation record: ${operationValidation.errors
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }
  artifacts.push({
    path: operationRecordArtifactPath(workflowOperationId, history.length + 1, resumedState),
    content: `${canonicalizeJson(operationDraft)}\n`,
  });

  const eventDraft: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "event",
    event_id: newId("event"),
    event_type: "OperationStarted",
    project_id: projectId,
    iteration_id: current.iteration_id,
    workflow_operation_id: workflowOperationId,
    ledger_operation_id: ledgerOperationId,
    sequence: nextEventSequence(deps, workflowOperationId),
    timestamp,
    payload: {
      resumes_attempt_id: current.attempt_id,
      checkpoint_id: committed.record.checkpoint_id,
      interrupted_run_ids: resumedRuns.map((run) => run.interruptedRunId),
    },
  };
  const eventValidation = validateSchema("event", eventDraft);
  if (!eventValidation.valid) {
    throw new WorkflowError(
      "operation_corrupt",
      `invalid resume event: ${eventValidation.errors.map((issue) => issue.message).join("; ")}`,
    );
  }
  const event = eventDraft as unknown as LifecycleEvent;

  try {
    await repository.commit({
      ledger_operation_id: ledgerOperationId,
      workflow_operation_id: workflowOperationId,
      attempt_id: attemptId,
      expected_baseline: baseline,
      artifacts,
      edges,
      events: [event],
    });
  } catch (error) {
    if (error instanceof LedgerError) {
      throw new WorkflowError("ledger_failure", error.message);
    }
    throw error;
  }

  return {
    workflowOperationId,
    attemptId,
    resumedState,
    checkpointId: committed.record.checkpoint_id,
    resumedRuns,
    ledgerOperationId,
  };
}
