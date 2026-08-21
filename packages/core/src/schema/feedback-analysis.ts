import { Type, type Static } from "@sinclair/typebox";

import { DigestSchema, IdentifierSchema, enumerated, strictObject } from "./common.js";
import { ProjectContextBundleRecordSchema } from "./context.js";
import { recordEnvelopeSchema } from "./envelope.js";

/**
 * FeedbackAnalysis schemas (model advisory design 9, PG-7, plan T17). The
 * port is called only when the deterministic RCA is unclassified, signals
 * conflict, or policy requires a cited semantic explanation. The output
 * carries candidates with confidence and source references only — there is
 * no field for target layers, capability/profile upgrades, invalidation
 * scope or privileged routes, so the model can never decide them. The
 * deterministic RCA result is never overwritten.
 */
export const FEEDBACK_ANALYSIS_SCHEMA_VERSION = "feedback_analysis.v1" as const;

export const FEEDBACK_ANALYSIS_RISKS = ["low", "medium", "high"] as const;

export const FeedbackAnalysisSourceRefSchema = strictObject({
  kind: enumerated(["finding", "evidence", "graph_node", "bundle_source"] as const),
  ref: Type.String({ minLength: 1, maxLength: 400 }),
  digest: DigestSchema,
});
export type FeedbackAnalysisSourceRef = Static<typeof FeedbackAnalysisSourceRefSchema>;

const cited = <T extends Parameters<typeof strictObject>[0]>(properties: T) =>
  strictObject({
    ...properties,
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    risk: enumerated(FEEDBACK_ANALYSIS_RISKS),
    source_refs: Type.Array(FeedbackAnalysisSourceRefSchema, { minItems: 1 }),
  });

export const FeedbackDiagnosisCandidateSchema = cited({
  summary: Type.String({ minLength: 1 }),
});
export type FeedbackDiagnosisCandidate = Static<typeof FeedbackDiagnosisCandidateSchema>;

export const FeedbackChangeSeedCandidateSchema = cited({
  summary: Type.String({ minLength: 1 }),
  seed_kind: enumerated([
    "content-change",
    "rename-with-change",
    "pure-rename",
    "finding",
    "improvement",
  ] as const),
});
export type FeedbackChangeSeedCandidate = Static<typeof FeedbackChangeSeedCandidateSchema>;

export const FeedbackVerificationSuggestionSchema = cited({
  summary: Type.String({ minLength: 1 }),
});
export type FeedbackVerificationSuggestion = Static<typeof FeedbackVerificationSuggestionSchema>;

export const FeedbackAnalysisOutputSchema = strictObject({
  purpose: Type.Literal("feedback_analysis"),
  schema_version: Type.Literal(FEEDBACK_ANALYSIS_SCHEMA_VERSION),
  finding_digest: DigestSchema,
  diagnoses: Type.Array(FeedbackDiagnosisCandidateSchema),
  change_seed_candidates: Type.Array(FeedbackChangeSeedCandidateSchema),
  verification_suggestions: Type.Array(FeedbackVerificationSuggestionSchema),
});
export type FeedbackAnalysisOutput = Static<typeof FeedbackAnalysisOutputSchema>;

/** The deterministic RCA snapshot the analysis is bound to. */
export const FeedbackAnalysisRcaSchema = strictObject({
  rule: Type.String({ minLength: 1 }),
  category: Type.String({ minLength: 1 }),
  layer: Type.String({ minLength: 1 }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
});
export type FeedbackAnalysisRca = Static<typeof FeedbackAnalysisRcaSchema>;

export const FeedbackAnalysisInputSchema = strictObject({
  purpose: Type.Literal("feedback_analysis"),
  schema_version: Type.Literal(FEEDBACK_ANALYSIS_SCHEMA_VERSION),
  binding_digest: DigestSchema,
  conversation_id: IdentifierSchema,
  run_id: IdentifierSchema,
  finding_digest: DigestSchema,
  deterministic_rca: FeedbackAnalysisRcaSchema,
  bundle: ProjectContextBundleRecordSchema,
});
export type FeedbackAnalysisInput = Static<typeof FeedbackAnalysisInputSchema>;

export const FeedbackAnalysisRecordSchema = recordEnvelopeSchema("feedback_analysis", {
  analysis_id: IdentifierSchema,
  workflow_operation_id: IdentifierSchema,
  iteration_id: IdentifierSchema,
  finding_digest: DigestSchema,
  binding_digest: DigestSchema,
  conversation_id: IdentifierSchema,
  run_id: IdentifierSchema,
  input_digest: DigestSchema,
  output: FeedbackAnalysisOutputSchema,
});
export type FeedbackAnalysisRecord = Static<typeof FeedbackAnalysisRecordSchema>;
