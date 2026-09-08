import {
  renderApprovalPreview,
  type ApprovalDecision,
  type ApprovalRequestRecord,
} from "./request.js";

/**
 * Interactive approval prompt contract (design 11.3, transparency spec §5.3).
 * The interaction layer never owns I/O: the caller injects a prompter, so
 * non-interactive mode provably never reads stdin. Only an explicit
 * approve/reject/defer is a decision — Ctrl-C, EOF, terminal disconnect and
 * unparseable input are `no_decision` outcomes that merely keep the proposal
 * blocked and resumable; nothing is ever inferred as approval or rejection.
 */
export interface ApprovalPrompter {
  /** Render the preview and return the raw human input; may throw on Ctrl-C. */
  readonly prompt: (
    preview: string,
    allowedDecisions: readonly ApprovalDecision[],
  ) => Promise<string | null>;
}

/**
 * The truthful outcome of one prompt: either an explicit decision the caller
 * may commit, or a reasoned absence of one that must only block and wait.
 */
export type ApprovalPromptOutcome =
  | { readonly kind: "decision"; readonly decision: ApprovalDecision }
  | { readonly kind: "no_decision"; readonly reason: "eof" | "interrupted" | "invalid_input" };

/**
 * Normalize raw input into an explicit decision outcome. `null` (EOF or
 * disconnect) is `eof`; empty input and anything outside the request's
 * allowed decisions is `invalid_input` — notably a "defer" the request does
 * not allow is invalid input, never an implicit defer decision.
 */
export function parseApprovalOutcome(
  input: string | null | undefined,
  allowedDecisions: readonly ApprovalDecision[],
): ApprovalPromptOutcome {
  if (input === null || input === undefined) return { kind: "no_decision", reason: "eof" };
  const normalized = input.trim().toLowerCase();
  if (normalized === "approve" && allowedDecisions.includes("approve")) {
    return { kind: "decision", decision: "approve" };
  }
  if (normalized === "reject" && allowedDecisions.includes("reject")) {
    return { kind: "decision", decision: "reject" };
  }
  if (normalized === "defer" && allowedDecisions.includes("defer")) {
    return { kind: "decision", decision: "defer" };
  }
  return { kind: "no_decision", reason: "invalid_input" };
}

/**
 * Compatibility wrapper over parseApprovalOutcome: every no_decision outcome
 * collapses to `defer`, preserving the pre-1.4 signature.
 */
export function parseApprovalDecision(
  input: string | null | undefined,
  allowedDecisions: readonly ApprovalDecision[],
): ApprovalDecision {
  const outcome = parseApprovalOutcome(input, allowedDecisions);
  return outcome.kind === "decision" ? outcome.decision : "defer";
}

/**
 * Prompt once for one exact request, preserving why no decision was made. A
 * prompter failure (Ctrl-C, disconnect) is `interrupted`; the caller persists
 * the outcome, this function never does.
 */
export async function promptForApprovalOutcome(
  request: ApprovalRequestRecord,
  prompter: ApprovalPrompter,
): Promise<ApprovalPromptOutcome> {
  let raw: string | null;
  try {
    raw = await prompter.prompt(renderApprovalPreview(request), request.allowed_decisions);
  } catch {
    return { kind: "no_decision", reason: "interrupted" };
  }
  return parseApprovalOutcome(raw, request.allowed_decisions);
}

/**
 * Compatibility wrapper over promptForApprovalOutcome: every no_decision
 * outcome collapses to `defer`, preserving the pre-1.4 signature.
 */
export async function promptForApprovalDecision(
  request: ApprovalRequestRecord,
  prompter: ApprovalPrompter,
): Promise<ApprovalDecision> {
  const outcome = await promptForApprovalOutcome(request, prompter);
  return outcome.kind === "decision" ? outcome.decision : "defer";
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
