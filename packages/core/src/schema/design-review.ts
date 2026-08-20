import { Type, type Static } from "@sinclair/typebox";

import { DigestSchema, IdentifierSchema, enumerated, strictObject } from "./common.js";
import { recordEnvelopeSchema } from "./envelope.js";

/**
 * Design review schemas (model advisory design 7, plan T12). The draft is
 * the only thing a DesignReviewPort may return: one of three verdicts plus
 * structured findings, a per-requirement coverage assessment and residual
 * risks. Every finding carries severity, category, an affected asset or
 * criterion, cited sources, the observed problem, a recommended revision
 * and a suggested verification — a finding without all facets is rejected
 * at the schema boundary.
 */
export const DESIGN_REVIEW_SCHEMA_VERSION = "design_review.v1" as const;

export const DESIGN_REVIEW_VERDICTS = [
  "accept_recommended",
  "revision_required",
  "blocked",
] as const;
export type DesignReviewVerdict = (typeof DESIGN_REVIEW_VERDICTS)[number];

export const DESIGN_REVIEW_SEVERITIES = ["info", "warning", "critical"] as const;
export type DesignReviewSeverity = (typeof DESIGN_REVIEW_SEVERITIES)[number];

export const DESIGN_REVIEW_FINDING_CATEGORIES = [
  "coverage_gap",
  "contract_conflict",
  "traceability_gap",
  "risk_omission",
  "oracle_gap",
  "feasibility_risk",
] as const;
export type DesignReviewFindingCategory = (typeof DESIGN_REVIEW_FINDING_CATEGORIES)[number];

/** A citation into the independent review bundle or the proposal content. */
export const DesignReviewSourceRefSchema = strictObject({
  kind: enumerated(["bundle_source", "proposal_content"] as const),
  ref: Type.String({ minLength: 1, maxLength: 400 }),
  digest: DigestSchema,
});
export type DesignReviewSourceRef = Static<typeof DesignReviewSourceRefSchema>;

export const DesignReviewFindingSchema = strictObject({
  finding_id: IdentifierSchema,
  severity: enumerated(DESIGN_REVIEW_SEVERITIES),
  category: enumerated(DESIGN_REVIEW_FINDING_CATEGORIES),
  affected_asset_id: Type.Optional(IdentifierSchema),
  affected_criterion_id: Type.Optional(IdentifierSchema),
  source_refs: Type.Array(DesignReviewSourceRefSchema, { minItems: 1 }),
  observed_problem: Type.String({ minLength: 1 }),
  recommended_revision: Type.String({ minLength: 1 }),
  suggested_verification: Type.String({ minLength: 1 }),
});
export type DesignReviewFinding = Static<typeof DesignReviewFindingSchema>;

export const DesignCoverageAssessmentSchema = strictObject({
  requirement_id: IdentifierSchema,
  status: enumerated(["covered", "deficient"] as const),
  notes: Type.Optional(Type.String({ minLength: 1 })),
});
export type DesignCoverageAssessment = Static<typeof DesignCoverageAssessmentSchema>;

export const DesignResidualRiskSchema = strictObject({
  description: Type.String({ minLength: 1 }),
  level: enumerated(["low", "medium", "high", "critical"] as const),
  mitigation: Type.Optional(Type.String({ minLength: 1 })),
});
export type DesignResidualRisk = Static<typeof DesignResidualRiskSchema>;

const reviewDraftProperties = {
  verdict: enumerated(DESIGN_REVIEW_VERDICTS),
  findings: Type.Array(DesignReviewFindingSchema),
  coverage_assessment: Type.Array(DesignCoverageAssessmentSchema),
  residual_risks: Type.Array(DesignResidualRiskSchema),
  summary: Type.String({ minLength: 1 }),
} as const;

/** The structured payload a review returns; the harness assigns identity. */
export const DesignReviewDraftSchema = strictObject(reviewDraftProperties);
export type DesignReviewDraft = Static<typeof DesignReviewDraftSchema>;

/** The raw port output: purpose and schema version pin the payload shape. */
export const DesignReviewOutputSchema = strictObject({
  purpose: Type.Literal("design_review"),
  schema_version: Type.Literal(DESIGN_REVIEW_SCHEMA_VERSION),
  ...reviewDraftProperties,
});
export type DesignReviewOutput = Static<typeof DesignReviewOutputSchema>;

/**
 * The domain result record: binds the reviewed proposal, the deterministic
 * validation outcome, the independent review bundle and the reviewer run
 * identity. Run provenance stays evidence; it never enters the semantic
 * content digest of the DesignSet.
 */
export const DesignReviewRecordSchema = recordEnvelopeSchema("design_review", {
  review_id: IdentifierSchema,
  workflow_operation_id: IdentifierSchema,
  iteration_id: IdentifierSchema,
  proposal_digest: DigestSchema,
  proposal_content_digest: DigestSchema,
  validation_digest: DigestSchema,
  review_bundle_digest: DigestSchema,
  reviewer_port: Type.String({ minLength: 1, maxLength: 120 }),
  conversation_id: IdentifierSchema,
  run_id: IdentifierSchema,
  output: DesignReviewDraftSchema,
});
export type DesignReviewRecord = Static<typeof DesignReviewRecordSchema>;
