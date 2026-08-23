import {
  PROTOCOL_1_1_VERSION,
  deriveCaptureIntentNodeId,
  domainRecordId,
  harnessRootFor,
  intentDigestOf,
  readCommittedOperations,
  sha256Hex,
  type CaptureApprovalDecisionView,
  type CaptureSessionRecord,
  type ClarificationQuestionRecord,
  type PrdCaptureCoordinator,
  type PrdProposalRecord,
  type StartCaptureCommand,
} from "@universal-harness-internal/core";

import {
  approvalDecisionArtifact,
  readApprovalDecisions,
  readApprovalRequests,
  type ApprovalDecisionRecord,
  type ApprovalRequestRecord,
} from "../approval/request.js";
import type { ClarificationQuestion, RequirementProposal } from "../requirements/capture.js";

/**
 * Coordinated capture seam (protocol-1.1 slice 2): the thin, CLI-independent
 * surface through which the orchestrator drives a PrdCaptureCoordinator
 * instead of the legacy interpreter/baseline path. Everything here is a pure
 * convention — deterministic session identity derived from the intent, the
 * PrdProposalRecord → RequirementProposal view the downstream phases consume,
 * and the approval bridge between the coordinator's approval request and the
 * engine's approval ledger. The pipeline behavior lives in the Kernel
 * Coordinator; this module only keeps both sides speaking of the same facts.
 */

export interface CaptureCoordinatorSessionContext {
  readonly project_profile_digest: string;
  readonly profile_decision_digest: string;
  readonly capture_policy_digest: string;
  readonly project_baseline_digest: string;
}

export interface CaptureCoordinatorSeam {
  readonly coordinator: PrdCaptureCoordinator;
  /** The digests a freshly started capture session binds; supplied by the host, never invented. */
  readonly session_context: CaptureCoordinatorSessionContext;
}

/** Object type the bridged approval request carries on the engine surface. */
export const CAPTURE_APPROVAL_OBJECT_TYPE = "CapturePrdProposal" as const;

/**
 * The capture session binds the real workflow operation id (intent-to-prd
 * design 16.1): the orchestrator opens the Operation before capture runs, so
 * the session and every Invocation record share the Operation identity and a
 * crash or clarification pause never splits them. The id pair — never the
 * intent alone — re-derives the session on any resume.
 */
export function captureSessionIdFor(intent: string, workflowOperationId: string): string {
  return domainRecordId({
    domain_tag: "capture_session",
    id_prefix: "capture-session",
    protocol_version: PROTOCOL_1_1_VERSION,
    canonical_input: {
      workflow_operation_id: workflowOperationId,
      intent_digest: intentDigestOf(intent),
    },
  });
}

/** The start command for a fresh session; re-issuing it resolves to the same session. */
export function startCaptureCommandFor(
  seam: CaptureCoordinatorSeam,
  intent: string,
  iterationId: string,
  workflowOperationId: string,
): StartCaptureCommand {
  return {
    command: "start_capture",
    workflow_operation_id: workflowOperationId,
    iteration_id: iterationId,
    intent_text: intent,
    ...seam.session_context,
  };
}

/**
 * The legacy proposal view over the committed PRD content: the Intent node id
 * is the one the accepted transaction wrote, requirement/constraint ids are
 * the Coordinator-issued canonical ids, and each criterion maps to the
 * description/verification pair the downstream phases consume.
 */
export function requirementProposalViewOf(
  session: CaptureSessionRecord,
  proposal: PrdProposalRecord,
): RequirementProposal {
  const content = proposal.content;
  return {
    intent: {
      id: deriveCaptureIntentNodeId(session.session_id),
      text: content.intent.text,
    },
    requirements: content.requirements.map((requirement) => ({
      id: requirement.id,
      statement: requirement.statement,
      acceptance: content.acceptance_criteria
        .filter((criterion) => criterion.requirement_id === requirement.id)
        .map((criterion) => ({
          description: `${criterion.action} → ${criterion.observable_outcome}`,
          verification: criterion.verification_intent,
        })),
    })),
    constraints: content.constraints.map((constraint) => ({
      id: constraint.id,
      statement: constraint.statement,
      verification: constraint.verification_intent,
    })),
  };
}

function clarificationSubjectOf(
  record: ClarificationQuestionRecord,
): ClarificationQuestion["subject"] {
  switch (record.target_kind) {
    case "requirement":
    case "constraint":
      return record.target_kind;
    case "acceptance_criterion":
      return "acceptance";
    default:
      return "intent";
  }
}

/**
 * Map a committed clarification question onto the legacy question surface.
 * Optioned questions keep their choices only when they satisfy the optioned
 * form (2-4 distinct non-blank labels); anything else degrades to the plain
 * free-text form, never to a malformed option list.
 */
export function clarificationQuestionViewOf(
  record: ClarificationQuestionRecord,
): ClarificationQuestion {
  const labels = [
    ...new Set(
      (record.options ?? [])
        .map((option) => option.label.trim())
        .filter((label) => label.length > 0 && label !== "other"),
    ),
  ];
  return {
    subject: clarificationSubjectOf(record),
    question: record.question,
    // The coordinator-issued id the answer-submission command surface binds.
    questionId: record.question_id,
    ...(labels.length >= 2 && labels.length <= 4 ? { options: labels } : {}),
  };
}

/**
 * The approval bridge convention (single decision surface): the coordinator's
 * deterministic approval request id travels as the engine request's
 * `object_id`, the proposal content digest as its `object_digest`, and the
 * engine decision's own `approval_id` becomes the coordinator-side
 * `decision_id`. Replay therefore re-derives the same view and the
 * coordinator's consumption stays idempotent.
 */
export function captureApprovalDecisionViewOf(
  request: ApprovalRequestRecord,
  decision: ApprovalDecisionRecord,
): CaptureApprovalDecisionView {
  return {
    decision_id: decision.approval_id,
    request_id: request.object_id,
    decision: decision.decision,
    object_digest: decision.object_digest,
    actor: decision.actor,
    // The coordinator refuses a reasonless reject; the engine surface records
    // no free-text reason, so the bridge binds the decision identity as one.
    ...(decision.decision === "reject"
      ? { reason: `reject decision ${decision.approval_id} recorded through the approval surface` }
      : {}),
    decision_digest: sha256Hex(approvalDecisionArtifact(decision).content),
  };
}

function bridgedDecisionView(
  request: ApprovalRequestRecord | undefined,
  decisions: readonly ApprovalDecisionRecord[],
  decisionId?: string,
): CaptureApprovalDecisionView | undefined {
  if (request === undefined) return undefined;
  const terminal = decisions.find(
    (decision) =>
      decision.request_id === request.request_id &&
      decision.decision !== "defer" &&
      (decisionId === undefined || decision.approval_id === decisionId),
  );
  return terminal === undefined ? undefined : captureApprovalDecisionViewOf(request, terminal);
}

/**
 * The bridge read side for one engine operation: the latest request carrying
 * the coordinator's request id and proposal digest, plus its terminal
 * decision. Used by the capture phase right after the approval surface
 * resolves.
 */
export function findBridgedCaptureApprovalDecision(
  projectRoot: string,
  workflowOperationId: string,
  coordinatorRequestId: string,
  objectDigest: string,
): CaptureApprovalDecisionView | undefined {
  const harnessRoot = harnessRootFor(projectRoot);
  const operations = readCommittedOperations(harnessRoot);
  const request = readApprovalRequests(harnessRoot, operations, workflowOperationId)
    .filter(
      (candidate) =>
        candidate.object_id === coordinatorRequestId && candidate.object_digest === objectDigest,
    )
    .at(-1);
  return bridgedDecisionView(
    request,
    readApprovalDecisions(harnessRoot, operations, workflowOperationId),
  );
}

/**
 * The bridge read side for the coordinator's `readApprovalDecision` dependency
 * (wired by the host at assembly time): scans every committed operation for
 * the bridged request, then matches the exact decision id. Unknown pairs
 * resolve to undefined and the coordinator fails closed.
 */
export function readBridgedCaptureApprovalDecision(
  projectRoot: string,
  coordinatorRequestId: string,
  decisionId: string,
): CaptureApprovalDecisionView | undefined {
  const harnessRoot = harnessRootFor(projectRoot);
  const operations = readCommittedOperations(harnessRoot);
  const workflowOperationIds = [
    ...new Set(operations.map((operation) => operation.manifest.workflow_operation_id)),
  ].sort();
  for (const workflowOperationId of workflowOperationIds) {
    const request = readApprovalRequests(harnessRoot, operations, workflowOperationId)
      .filter((candidate) => candidate.object_id === coordinatorRequestId)
      .at(-1);
    const view = bridgedDecisionView(
      request,
      readApprovalDecisions(harnessRoot, operations, workflowOperationId),
      decisionId,
    );
    if (view !== undefined) return view;
  }
  return undefined;
}
