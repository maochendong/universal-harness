import { Type, type Static } from "@sinclair/typebox";

import { DigestSchema, IdentifierSchema, enumerated, strictObject } from "./common.js";
import { recordEnvelopeSchema } from "./envelope.js";

/**
 * Protocol 1.1 controlled project context schemas (intent-to-prd design 6.3
 * and 8). A bundle stores only what the model actually saw — canonical
 * summaries, source digests, classification and the recorded exclusions — and
 * never raw unauthorized files or secrets.
 */
export const PROJECT_CONTEXT_SOURCE_KINDS = [
  "manifest",
  "readme",
  "gate",
  "graph",
  "adr",
  "api",
  "schema",
  "policy",
] as const;
export type ProjectContextSourceKind = (typeof PROJECT_CONTEXT_SOURCE_KINDS)[number];
export const ProjectContextSourceKindSchema = enumerated(PROJECT_CONTEXT_SOURCE_KINDS);

export const PROJECT_CONTEXT_PURPOSES = [
  "proposal",
  "review",
  "approval_brief",
  "context_enrichment",
] as const;
export type ProjectContextPurpose = (typeof PROJECT_CONTEXT_PURPOSES)[number];
export const ProjectContextPurposeSchema = enumerated(PROJECT_CONTEXT_PURPOSES);

export const PROJECT_CONTEXT_CLASSIFICATIONS = [
  "public_project",
  "internal_project",
  "restricted",
] as const;
export type ProjectContextClassification = (typeof PROJECT_CONTEXT_CLASSIFICATIONS)[number];

/**
 * Why a candidate never entered the bundle (the redaction record). Every
 * exclusion is auditable; nothing is silently skipped once a candidate matched
 * an existing path.
 */
export const PROJECT_CONTEXT_EXCLUSION_REASONS = [
  "path_policy_denied",
  "secret_pattern",
  "symlink_escape",
  "untracked",
  "binary",
  "oversize",
  "budget_exceeded",
  "unreadable",
] as const;
export type ProjectContextExclusionReason = (typeof PROJECT_CONTEXT_EXCLUSION_REASONS)[number];

/** Why a compiled bundle stopped being usable (design 18). */
export const PROJECT_CONTEXT_INVALIDATION_REASONS = [
  "baseline_drift",
  "profile_drift",
  "policy_drift",
] as const;
export type ProjectContextInvalidationReason =
  (typeof PROJECT_CONTEXT_INVALIDATION_REASONS)[number];

/** Deterministic selection budget; live tokens and timing never enter it. */
export const ProjectContextBudgetSchema = strictObject({
  max_files: Type.Integer({ minimum: 1 }),
  max_bytes_per_source: Type.Integer({ minimum: 1 }),
  max_total_bytes: Type.Integer({ minimum: 1 }),
  max_summary_chars: Type.Integer({ minimum: 1 }),
});
export type ProjectContextBudget = Static<typeof ProjectContextBudgetSchema>;

export const ProjectContextSourceSchema = strictObject({
  locator: Type.String({ minLength: 1, maxLength: 400 }),
  source_kind: ProjectContextSourceKindSchema,
  source_digest: DigestSchema,
  selection_reason: Type.String({ minLength: 1 }),
  classification: enumerated(PROJECT_CONTEXT_CLASSIFICATIONS),
  summary: Type.String(),
  truncated: Type.Boolean(),
});
export type ProjectContextSource = Static<typeof ProjectContextSourceSchema>;

export const ProjectContextExclusionSchema = strictObject({
  locator: Type.String({ minLength: 1, maxLength: 400 }),
  reason: enumerated(PROJECT_CONTEXT_EXCLUSION_REASONS),
});
export type ProjectContextExclusion = Static<typeof ProjectContextExclusionSchema>;

/**
 * Bundle record (design 6.3) plus the recorded exclusions. The bundle
 * identity binds the session, the purpose and the content digest, so a
 * proposal-purpose and a review-purpose bundle never share an identity even
 * when their source files overlap.
 */
export const ProjectContextBundleRecordSchema = recordEnvelopeSchema("project_context_bundle", {
  bundle_id: IdentifierSchema,
  session_id: IdentifierSchema,
  purpose: ProjectContextPurposeSchema,
  project_baseline_digest: DigestSchema,
  profile_digest: DigestSchema,
  policy_digest: DigestSchema,
  budget: ProjectContextBudgetSchema,
  sources: Type.Array(ProjectContextSourceSchema, { uniqueItems: true }),
  exclusions: Type.Array(ProjectContextExclusionSchema, { uniqueItems: true }),
  content_digest: DigestSchema,
});
export type ProjectContextBundleRecord = Static<typeof ProjectContextBundleRecordSchema>;

/** Append-only invalidation fact (design 14.2/18): drift never rewrites a bundle. */
export const ProjectContextBundleInvalidationRecordSchema = recordEnvelopeSchema(
  "project_context_bundle_invalidation",
  {
    invalidation_id: IdentifierSchema,
    bundle_id: IdentifierSchema,
    bundle_digest: DigestSchema,
    reasons: Type.Array(enumerated(PROJECT_CONTEXT_INVALIDATION_REASONS), {
      minItems: 1,
      uniqueItems: true,
    }),
  },
);
export type ProjectContextBundleInvalidationRecord = Static<
  typeof ProjectContextBundleInvalidationRecordSchema
>;
