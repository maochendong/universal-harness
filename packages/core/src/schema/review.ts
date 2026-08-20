import { Type, type Static } from "@sinclair/typebox";

import { CAPTURE_QUESTION_TARGET_KINDS, ClarificationOptionSchema } from "./capture.js";
import { DigestSchema, IdentifierSchema, enumerated, strictObject } from "./common.js";
import { recordEnvelopeSchema } from "./envelope.js";

/**
 * Protocol 1.1 PRD review schemas (intent-to-prd design 6.6, 10). The review
 * report is quality Evidence, never an ApprovalDecision: the Coordinator
 * re-verifies finding severities, mandatory dimensions and the independence
 * binding before it routes the verdict. Strict shapes keep adapter metadata,
 * telemetry and conversation internals out of the report digest.
 */
export const PRD_REVIEW_VERDICTS = ["accept", "revise", "clarify", "blocked"] as const;
export type PrdReviewVerdict = (typeof PRD_REVIEW_VERDICTS)[number];

export const PRD_REVIEW_SEVERITIES = ["info", "warning", "critical"] as const;
export type PrdReviewSeverity = (typeof PRD_REVIEW_SEVERITIES)[number];

export const PRD_REVIEW_DIMENSION_STATUSES = ["satisfied", "deficient"] as const;
export type PrdReviewDimensionStatus = (typeof PRD_REVIEW_DIMENSION_STATUSES)[number];

export const PrdReviewDimensionSchema = strictObject({
  dimension_id: Type.String({ minLength: 1, maxLength: 120 }),
  status: enumerated(PRD_REVIEW_DIMENSION_STATUSES),
  notes: Type.String({ maxLength: 4000 }),
});
export type PrdReviewDimension = Static<typeof PrdReviewDimensionSchema>;

export const PrdReviewFindingSchema = strictObject({
  finding_id: Type.String({ minLength: 1, maxLength: 160 }),
  severity: enumerated(PRD_REVIEW_SEVERITIES),
  target_kind: enumerated(CAPTURE_QUESTION_TARGET_KINDS),
  target_id: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
  message: Type.String({ minLength: 1, maxLength: 4000 }),
  recommended_revision: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
});
export type PrdReviewFinding = Static<typeof PrdReviewFindingSchema>;

/**
 * A review-suggested clarification question (design 6.6). The source is fixed
 * to `review` by the Coordinator when it materializes question records, so the
 * draft schema does not carry a source field at all.
 */
export const PrdReviewQuestionDraftSchema = strictObject({
  target_kind: enumerated(CAPTURE_QUESTION_TARGET_KINDS),
  target_id: Type.Optional(Type.String({ minLength: 1 })),
  missing_dimension: Type.String({ minLength: 1 }),
  question: Type.String({ minLength: 1 }),
  options: Type.Optional(Type.Array(ClarificationOptionSchema, { minItems: 1 })),
  required: Type.Boolean(),
});
export type PrdReviewQuestionDraft = Static<typeof PrdReviewQuestionDraftSchema>;

/**
 * The only thing a review adapter may return: a verdict plus typed content.
 * No canonical report ids, no approval, no next state.
 */
export const PrdReviewReportDraftSchema = strictObject({
  verdict: enumerated(PRD_REVIEW_VERDICTS),
  dimensions: Type.Array(PrdReviewDimensionSchema),
  findings: Type.Array(PrdReviewFindingSchema),
  suggested_questions: Type.Array(PrdReviewQuestionDraftSchema),
});
export type PrdReviewReportDraft = Static<typeof PrdReviewReportDraftSchema>;

/** Canonical review report (design 6.6), bound to the exact reviewed facts. */
export const PrdReviewReportRecordSchema = recordEnvelopeSchema("prd_review_report", {
  review_report_id: IdentifierSchema,
  session_id: IdentifierSchema,
  proposal_digest: DigestSchema,
  review_context_bundle_digest: DigestSchema,
  validation_digest: DigestSchema,
  reviewer_adapter_profile_digest: DigestSchema,
  reviewer_identity: Type.String({ minLength: 1, maxLength: 200 }),
  prompt_version_digest: DigestSchema,
  invocation_id: IdentifierSchema,
  conversation_id: IdentifierSchema,
  evidence_locator: Type.String({ minLength: 1, maxLength: 400 }),
  verdict: enumerated(PRD_REVIEW_VERDICTS),
  dimensions: Type.Array(PrdReviewDimensionSchema),
  findings: Type.Array(PrdReviewFindingSchema),
  suggested_questions: Type.Array(PrdReviewQuestionDraftSchema),
  report_digest: DigestSchema,
});
export type PrdReviewReportRecord = Static<typeof PrdReviewReportRecordSchema>;

/** One human rubric input for one review dimension (design 6.6). */
export const PrdReviewDimensionInputSchema = strictObject({
  dimension_id: Type.String({ minLength: 1, maxLength: 120 }),
  status: enumerated(PRD_REVIEW_DIMENSION_STATUSES),
  notes: Type.String({ maxLength: 4000 }),
  severity: Type.Optional(enumerated(PRD_REVIEW_SEVERITIES)),
});
export type PrdReviewDimensionInput = Static<typeof PrdReviewDimensionInputSchema>;

/**
 * Manual review input (design 6.6): stored independently from clarification
 * answers, bound to the review invocation that requested it and to the session
 * revision the reviewer saw.
 */
export const ManualReviewInputRecordSchema = recordEnvelopeSchema("manual_review_input", {
  manual_review_input_id: IdentifierSchema,
  session_id: IdentifierSchema,
  review_invocation_id: IdentifierSchema,
  reviewer_actor: Type.String({ minLength: 1, maxLength: 200 }),
  rubric_digest: DigestSchema,
  dimension_inputs: Type.Array(PrdReviewDimensionInputSchema, { minItems: 1 }),
  expected_session_digest: DigestSchema,
});
export type ManualReviewInputRecord = Static<typeof ManualReviewInputRecordSchema>;
