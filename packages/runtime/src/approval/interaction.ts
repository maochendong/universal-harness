import {
  renderApprovalPreview,
  type ApprovalDecision,
  type ApprovalRequestRecord,
} from "./request.js";

/**
 * Interactive approval prompt contract (design 11.3). The interaction layer
 * never owns I/O: the caller injects a prompter, so non-interactive mode
 * provably never reads stdin. Only an explicit approve/reject/defer is a
 * decision — Ctrl-C, EOF, terminal disconnect and unparseable input all
 * collapse to `defer`, keeping the proposal resumable; nothing is ever
 * inferred as approval or rejection.
 */
export interface ApprovalPrompter {
  /** Render the preview and return the raw human input; may throw on Ctrl-C. */
  readonly prompt: (
    preview: string,
    allowedDecisions: readonly ApprovalDecision[],
  ) => Promise<string | null>;
}

/**
 * Normalize raw input into an explicit decision. `null` (EOF/disconnect),
 * empty input and anything outside the request's allowed decisions parse as
 * `defer`.
 */
export function parseApprovalDecision(
  input: string | null | undefined,
  allowedDecisions: readonly ApprovalDecision[],
): ApprovalDecision {
  if (input === null || input === undefined) return "defer";
  const normalized = input.trim().toLowerCase();
  if (normalized === "approve" && allowedDecisions.includes("approve")) return "approve";
  if (normalized === "reject" && allowedDecisions.includes("reject")) return "reject";
  if (normalized === "defer" && allowedDecisions.includes("defer")) return "defer";
  return "defer";
}

/**
 * Prompt once for one exact request. A prompter failure (Ctrl-C, disconnect)
 * is a defer; the caller persists the outcome, this function never does.
 */
export async function promptForApprovalDecision(
  request: ApprovalRequestRecord,
  prompter: ApprovalPrompter,
): Promise<ApprovalDecision> {
  let raw: string | null;
  try {
    raw = await prompter.prompt(renderApprovalPreview(request), request.allowed_decisions);
  } catch {
    return "defer";
  }
  return parseApprovalDecision(raw, request.allowed_decisions);
}

export const APPROVAL_REQUIRED_CATEGORY = "approval_required" as const;

/** Structured `--json` outcome for a request awaiting a human decision. */
export interface ApprovalRequiredOutcome {
  readonly status: typeof APPROVAL_REQUIRED_CATEGORY;
  readonly error_category: typeof APPROVAL_REQUIRED_CATEGORY;
  readonly request_id: string;
  readonly object_id: string;
  readonly object_type: string;
  readonly object_digest: string;
  readonly workflow_operation_id: string;
  readonly resume_phase: string;
  readonly resume_command: string;
  readonly allowed_decisions: readonly ApprovalDecision[];
}

export function resumeCommandFor(workflowOperationId: string): string {
  return `harness resume ${workflowOperationId}`;
}

/**
 * The non-interactive outcome: typed, stable, and never accompanied by a
 * read of stdin or an implicit decision.
 */
export function approvalRequiredOutcome(request: ApprovalRequestRecord): ApprovalRequiredOutcome {
  return {
    status: APPROVAL_REQUIRED_CATEGORY,
    error_category: APPROVAL_REQUIRED_CATEGORY,
    request_id: request.request_id,
    object_id: request.object_id,
    object_type: request.object_type,
    object_digest: request.object_digest,
    workflow_operation_id: request.workflow_operation_id,
    resume_phase: request.resume_phase,
    resume_command: resumeCommandFor(request.workflow_operation_id),
    allowed_decisions: [...request.allowed_decisions],
  };
}
