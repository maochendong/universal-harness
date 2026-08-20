import { Type, type Static } from "@sinclair/typebox";

import { DigestSchema, IdentifierSchema, strictObject } from "./common.js";
import { recordEnvelopeSchema } from "./envelope.js";

/**
 * Protocol 1.1 accepted PRD schemas (intent-to-prd design 6.8, 7.5). The
 * accepted record never duplicates PRD content; it seals the unique proposal
 * content digest plus every binding that authorized acceptance. The
 * requirement baseline record materializes the stable Criterion → Test seed
 * mapping so later DesignSet/TDD compilation can verify it mechanically.
 */
export const RequirementBaselineCriterionSeedSchema = strictObject({
  criterion_id: IdentifierSchema,
  requirement_id: IdentifierSchema,
  criterion_semantic_digest: DigestSchema,
  test_id: IdentifierSchema,
  test_revision: Type.Integer({ minimum: 1 }),
});
export type RequirementBaselineCriterionSeed = Static<
  typeof RequirementBaselineCriterionSeedSchema
>;

/**
 * Requirement baseline document (design 7.5 step 3). It references — never
 * copies — the accepted proposal content, so its digest always reverse-verifies
 * to the same proposal content digest.
 */
export const RequirementBaselineRecordSchema = recordEnvelopeSchema("requirement_baseline", {
  baseline_id: IdentifierSchema,
  session_id: IdentifierSchema,
  prd_id: IdentifierSchema,
  prd_revision: Type.Integer({ minimum: 1 }),
  proposal_content_digest: DigestSchema,
  requirement_ids: Type.Array(IdentifierSchema, { uniqueItems: true }),
  constraint_ids: Type.Array(IdentifierSchema, { uniqueItems: true }),
  criterion_test_seeds: Type.Array(RequirementBaselineCriterionSeedSchema),
  baseline_document_digest: DigestSchema,
});
export type RequirementBaselineRecord = Static<typeof RequirementBaselineRecordSchema>;

/** Immutable accepted PRD record (design 6.8); revisions chain by supersedes. */
export const AcceptedPrdRecordSchema = recordEnvelopeSchema("accepted_prd", {
  prd_id: IdentifierSchema,
  revision: Type.Integer({ minimum: 1 }),
  session_id: IdentifierSchema,
  workflow_operation_id: IdentifierSchema,
  proposal_id: IdentifierSchema,
  proposal_content_digest: DigestSchema,
  proposal_context_bundle_digest: DigestSchema,
  review_context_bundle_digest: DigestSchema,
  validation_report_digest: DigestSchema,
  review_report_digest: DigestSchema,
  risk_assessment_digest: DigestSchema,
  project_profile_digest: DigestSchema,
  profile_decision_digest: DigestSchema,
  capture_policy_digest: DigestSchema,
  policy_digest: DigestSchema,
  approval_digest: DigestSchema,
  requirement_baseline_digest: DigestSchema,
  supersedes_digest: Type.Optional(DigestSchema),
});
export type AcceptedPrdRecord = Static<typeof AcceptedPrdRecordSchema>;
