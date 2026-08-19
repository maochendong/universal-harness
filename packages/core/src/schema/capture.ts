import { Type, type Static } from "@sinclair/typebox";

import { DigestSchema, IdentifierSchema, enumerated, strictObject } from "./common.js";
import { recordEnvelopeSchema } from "./envelope.js";

/**
 * Protocol 1.1 managed capture schemas (intent-to-prd design 6/7). The
 * Capture Session, Clarification Question/Answer, Invocation, Checkpoint and
 * typed Blocker records are append-only authoritative records built on the
 * shared record envelope; the Coordinator owns every transition and no
 * Adapter ever writes them.
 */

/**
 * The fifteen lifecycle states (design 7.1). `review_provider_required` is
 * deliberately absent: it is a typed block reason, never a state.
 */
export const CAPTURE_STATES = [
  "intent_received",
  "context_compiling",
  "proposing",
  "validating",
  "clarification_required",
  "reviewing",
  "review_input_required",
  "risk_assessing",
  "revision_required",
  "profile_decision_required",
  "approval_required",
  "approval_deferred",
  "accepted",
  "blocked",
  "cancelled",
] as const;
export type CaptureState = (typeof CAPTURE_STATES)[number];
export const CaptureStateSchema = enumerated(CAPTURE_STATES);

export const CAPTURE_BLOCK_REASONS = [
  "review_provider_required",
  "capture_budget_exhausted",
  "review_blocked",
  "risk_policy_denied",
] as const;
export type CaptureBlockReason = (typeof CAPTURE_BLOCK_REASONS)[number];
export const CaptureBlockReasonSchema = enumerated(CAPTURE_BLOCK_REASONS);

/** Invocation purposes committed before any Capture-stage model call. */
export const CAPTURE_INVOCATION_PURPOSES = [
  "context_proposal",
  "context_review",
  "proposal",
  "review",
  "project_discovery",
  "approval_brief",
] as const;
export type CaptureInvocationPurpose = (typeof CAPTURE_INVOCATION_PURPOSES)[number];

export const CAPTURE_QUESTION_SOURCES = [
  "deterministic_gate",
  "proposal",
  "review",
  "human",
] as const;
export type CaptureQuestionSource = (typeof CAPTURE_QUESTION_SOURCES)[number];

export const CAPTURE_QUESTION_TARGET_KINDS = [
  "intent",
  "prd_section",
  "requirement",
  "constraint",
  "acceptance_criterion",
  "risk",
  "glossary",
] as const;
export type CaptureQuestionTargetKind = (typeof CAPTURE_QUESTION_TARGET_KINDS)[number];

export const CAPTURE_ANSWER_KINDS = ["selected_option", "free_text", "structured"] as const;
export type CaptureAnswerKind = (typeof CAPTURE_ANSWER_KINDS)[number];

export const CAPTURE_QUESTION_STATUSES = ["open", "answered", "superseded"] as const;
export type CaptureQuestionStatus = (typeof CAPTURE_QUESTION_STATUSES)[number];

/**
 * Deterministic budget accounting (design 6.1). Timestamps, live tokens and
 * step counts are telemetry and never enter the semantic digest; only these
 * replayable counters do.
 */
export const CaptureBudgetUseSchema = strictObject({
  clarification_rounds: Type.Integer({ minimum: 0 }),
  proposal_invocations: Type.Integer({ minimum: 0 }),
  review_invocations: Type.Integer({ minimum: 0 }),
});
export type CaptureBudgetUse = Static<typeof CaptureBudgetUseSchema>;

export const ClarificationOptionSchema = strictObject({
  option_id: Type.String({ minLength: 1, maxLength: 120 }),
  label: Type.String({ minLength: 1 }),
});
export type ClarificationOption = Static<typeof ClarificationOptionSchema>;

/**
 * Capture Session record (design 6.1). One record per revision; revisions are
 * append-only and linked through `supersedes_digest`. `blocked_reason` must be
 * present exactly when `state` is `blocked` — the conditional invariant is
 * enforced by the capture constructors/store on top of this schema.
 */
export const CaptureSessionRecordSchema = recordEnvelopeSchema("capture_session", {
  session_id: IdentifierSchema,
  revision: Type.Integer({ minimum: 1 }),
  workflow_operation_id: IdentifierSchema,
  iteration_id: IdentifierSchema,
  state: CaptureStateSchema,
  blocked_reason: Type.Optional(CaptureBlockReasonSchema),
  intent_text: Type.String({ minLength: 1 }),
  intent_digest: DigestSchema,
  project_profile_digest: DigestSchema,
  profile_decision_digest: DigestSchema,
  capture_policy_digest: DigestSchema,
  project_baseline_digest: DigestSchema,
  proposal_context_bundle_digest: Type.Optional(DigestSchema),
  review_context_bundle_digest: Type.Optional(DigestSchema),
  current_proposal_digest: Type.Optional(DigestSchema),
  current_validation_digest: Type.Optional(DigestSchema),
  current_review_digest: Type.Optional(DigestSchema),
  current_risk_assessment_digest: Type.Optional(DigestSchema),
  current_approval_request_id: Type.Optional(IdentifierSchema),
  applied_approval_decision_id: Type.Optional(IdentifierSchema),
  pending_question_ids: Type.Array(IdentifierSchema, { uniqueItems: true }),
  round: Type.Integer({ minimum: 0 }),
  budget_use: CaptureBudgetUseSchema,
  supersedes_digest: Type.Optional(DigestSchema),
});
export type CaptureSessionRecord = Static<typeof CaptureSessionRecordSchema>;

/** Clarification question (design 6.2): always references an exact target and dimension. */
export const ClarificationQuestionRecordSchema = recordEnvelopeSchema("clarification_question", {
  question_id: IdentifierSchema,
  session_id: IdentifierSchema,
  round: Type.Integer({ minimum: 1 }),
  source: enumerated(CAPTURE_QUESTION_SOURCES),
  target_kind: enumerated(CAPTURE_QUESTION_TARGET_KINDS),
  target_id: Type.Optional(Type.String({ minLength: 1 })),
  missing_dimension: Type.String({ minLength: 1 }),
  question: Type.String({ minLength: 1 }),
  options: Type.Optional(Type.Array(ClarificationOptionSchema, { minItems: 1 })),
  required: Type.Boolean(),
  status: enumerated(CAPTURE_QUESTION_STATUSES),
  content_digest: DigestSchema,
});
export type ClarificationQuestionRecord = Static<typeof ClarificationQuestionRecordSchema>;

/**
 * Clarification answer (design 6.2). Re-answering appends a new record bound
 * to `expected_session_digest`; old answers are never overwritten.
 */
export const ClarificationAnswerRecordSchema = recordEnvelopeSchema("clarification_answer", {
  answer_id: IdentifierSchema,
  session_id: IdentifierSchema,
  question_id: IdentifierSchema,
  answer_kind: enumerated(CAPTURE_ANSWER_KINDS),
  value: Type.Unknown(),
  actor: Type.String({ minLength: 1, maxLength: 200 }),
  expected_session_digest: DigestSchema,
  content_digest: DigestSchema,
});
export type ClarificationAnswerRecord = Static<typeof ClarificationAnswerRecordSchema>;

/**
 * Invocation intent (design 7.2, 11.3): committed before the corresponding
 * model call so a crash never leaves an untraceable invocation. The record
 * binds the workflow operation, the exact session revision and every
 * Capture-scope binding digest; resume reuses it via the stable identity
 * instead of minting a duplicate.
 */
export const CaptureInvocationRecordSchema = recordEnvelopeSchema("capture_invocation", {
  invocation_id: IdentifierSchema,
  session_id: IdentifierSchema,
  session_revision: Type.Integer({ minimum: 1 }),
  session_digest: DigestSchema,
  workflow_operation_id: IdentifierSchema,
  purpose: enumerated(CAPTURE_INVOCATION_PURPOSES),
  invocation_key: DigestSchema,
  binding_digests: Type.Array(DigestSchema, { uniqueItems: true }),
});
export type CaptureInvocationRecord = Static<typeof CaptureInvocationRecordSchema>;

/** Recovery marker sealed with each committed session revision (design 7.5). */
export const CaptureCheckpointRecordSchema = recordEnvelopeSchema("capture_checkpoint", {
  checkpoint_id: IdentifierSchema,
  session_id: IdentifierSchema,
  session_revision: Type.Integer({ minimum: 1 }),
  state: CaptureStateSchema,
  session_digest: DigestSchema,
});
export type CaptureCheckpointRecord = Static<typeof CaptureCheckpointRecordSchema>;

/**
 * Typed blocker (design 7.1): the only place `CaptureBlockReason` may appear.
 * `resume_state` records where an explicit resume re-enters once the blocking
 * condition is cleared; old blockers are never rewritten.
 */
export const CaptureBlockerRecordSchema = recordEnvelopeSchema("capture_blocker", {
  blocker_id: IdentifierSchema,
  session_id: IdentifierSchema,
  session_revision: Type.Integer({ minimum: 1 }),
  session_digest: DigestSchema,
  reason: CaptureBlockReasonSchema,
  resume_state: CaptureStateSchema,
  detail: Type.String({ minLength: 1 }),
});
export type CaptureBlockerRecord = Static<typeof CaptureBlockerRecordSchema>;
