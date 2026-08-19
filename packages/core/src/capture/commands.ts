import type {
  CaptureBlockerRecord,
  CaptureInvocationRecord,
  CaptureSessionRecord,
  ClarificationAnswerRecord,
  ClarificationQuestionRecord,
} from "../schema/capture.js";
import type { ClarificationQuestionDraft } from "./records.js";

/**
 * Capture command surface (intent-to-prd design 5.1). Commands express the
 * domain action that triggers the Coordinator — never a target state. The
 * Coordinator is the only way CLI, Dashboard and Orchestrator advance a
 * capture; callers cannot skip validation/review or mark anything accepted.
 */
export interface StartCaptureCommand {
  readonly command: "start_capture";
  readonly workflow_operation_id: string;
  readonly iteration_id: string;
  readonly intent_text: string;
  readonly project_profile_digest: string;
  readonly profile_decision_digest: string;
  readonly capture_policy_digest: string;
  readonly project_baseline_digest: string;
}

export interface CaptureAnswerInput {
  readonly question_id: string;
  readonly answer_kind: ClarificationAnswerRecord["answer_kind"];
  readonly value: unknown;
}

export interface SubmitClarificationAnswersCommand {
  readonly command: "submit_clarification_answers";
  readonly session_id: string;
  readonly expected_session_digest: string;
  readonly actor: string;
  readonly answers: readonly CaptureAnswerInput[];
}

export interface RequestPrdRevisionCommand {
  readonly command: "request_prd_revision";
  readonly session_id: string;
  readonly expected_session_digest: string;
  readonly updated_intent_text?: string;
}

/**
 * Carries only the identity of a decision the unified ApprovalService already
 * committed plus the expected session digest (design 5.1): the caller can
 * never fabricate decision content through this command.
 */
export interface ApplyApprovalDecisionCommand {
  readonly command: "apply_approval_decision";
  readonly session_id: string;
  readonly expected_session_digest: string;
  readonly request_id: string;
  readonly decision_id: string;
}

export interface ResumeCaptureCommand {
  readonly command: "resume_capture";
  readonly session_id: string;
}

export interface CancelCaptureCommand {
  readonly command: "cancel_capture";
  readonly session_id: string;
}

export type CaptureCommand =
  | StartCaptureCommand
  | SubmitClarificationAnswersCommand
  | RequestPrdRevisionCommand
  | ApplyApprovalDecisionCommand
  | ResumeCaptureCommand
  | CancelCaptureCommand;

/** The Coordinator's read-only view of a committed approval decision. */
export interface CaptureApprovalDecisionView {
  readonly decision_id: string;
  readonly request_id: string;
  readonly decision: "approve" | "reject" | "defer";
  readonly object_digest: string;
  readonly actor: string;
  readonly reason?: string;
}

/**
 * Stage handler seam (T4 kernel). Later tasks wrap the real ports
 * (ProjectContext T5, Proposal T6, Review T7, deterministic gates and the
 * risk engine) into these handlers; the Coordinator owns persistence,
 * transition legality and the invocation barrier, handlers own only the
 * stage-local result.
 */
export interface CaptureStageRequest {
  readonly session: CaptureSessionRecord;
  /** Persisted before the handler runs for every model-call stage. */
  readonly invocation?: CaptureInvocationRecord;
  readonly questions?: readonly ClarificationQuestionRecord[];
  readonly answers?: readonly ClarificationAnswerRecord[];
}

export interface CaptureStageFailure {
  readonly code: string;
  readonly summary: string;
  readonly retryable: boolean;
}

export type CaptureStageResult =
  | { readonly kind: "context_compiled"; readonly bundle_digest: string }
  | { readonly kind: "proposal_ready"; readonly proposal_digest: string }
  | {
      readonly kind: "clarification_required";
      readonly questions: readonly ClarificationQuestionDraft[];
    }
  | { readonly kind: "validation_passed"; readonly validation_digest: string }
  | { readonly kind: "validation_revision_required" }
  | {
      readonly kind: "review_completed";
      readonly verdict: "accept" | "revise" | "clarify" | "blocked";
      readonly review_digest: string;
      readonly questions?: readonly ClarificationQuestionDraft[];
    }
  | { readonly kind: "review_input_required" }
  | { readonly kind: "risk_stable"; readonly risk_assessment_digest: string }
  | { readonly kind: "risk_upgrade_required" }
  | { readonly kind: "risk_denied" }
  | { readonly kind: "stage_failed"; readonly failure: CaptureStageFailure };

export type CaptureStageHandler = (
  request: CaptureStageRequest,
) => Promise<CaptureStageResult> | CaptureStageResult;

export interface CaptureStageHandlers {
  readonly compileContext?: CaptureStageHandler;
  readonly propose?: CaptureStageHandler;
  readonly validate?: CaptureStageHandler;
  readonly review?: CaptureStageHandler;
  readonly assessRisk?: CaptureStageHandler;
}

export type CaptureFailureKind =
  | "session_not_found"
  | "invalid_command"
  | "invalid_transition"
  | "stage_unavailable"
  | "stage_failed"
  | "invalid_stage_result"
  | "binding_missing"
  | "binding_drift"
  | "unknown_question"
  | "answer_conflict"
  | "missing_approval_object"
  | "approval_decision_not_found"
  | "approval_request_mismatch"
  | "approval_binding_mismatch"
  | "reject_reason_required"
  | "profile_resolution_unavailable";

export type CaptureOutcome =
  | { readonly status: "advanced"; readonly session: CaptureSessionRecord }
  | { readonly status: "already_applied"; readonly session: CaptureSessionRecord }
  | {
      readonly status: "awaiting_answers";
      readonly session: CaptureSessionRecord;
      readonly questions: readonly ClarificationQuestionRecord[];
    }
  | {
      readonly status: "awaiting_approval";
      readonly session: CaptureSessionRecord;
      readonly approval_request_id: string;
      readonly approval_object_digest: string;
    }
  | { readonly status: "awaiting_profile_decision"; readonly session: CaptureSessionRecord }
  | { readonly status: "review_input_required"; readonly session: CaptureSessionRecord }
  | { readonly status: "revision_required"; readonly session: CaptureSessionRecord }
  | { readonly status: "approval_deferred"; readonly session: CaptureSessionRecord }
  | {
      readonly status: "blocked";
      readonly session: CaptureSessionRecord;
      readonly blocker: CaptureBlockerRecord;
    }
  | { readonly status: "accepted"; readonly session: CaptureSessionRecord }
  | { readonly status: "cancelled"; readonly session: CaptureSessionRecord }
  | {
      readonly status: "conflict";
      readonly session: CaptureSessionRecord;
      readonly expected_session_digest: string;
      readonly actual_session_digest: string;
    }
  | {
      readonly status: "failed";
      readonly session?: CaptureSessionRecord;
      readonly kind: CaptureFailureKind;
      readonly message: string;
    };
