import { Type, type Static } from "@sinclair/typebox";

import { DigestSchema, IdentifierSchema, enumerated, strictObject } from "./common.js";
import { ProjectContextBundleRecordSchema } from "./context.js";
import { recordEnvelopeSchema } from "./envelope.js";
import { GROUNDED_SYNTHESIS_PURPOSES } from "./profile.js";

/**
 * Protocol 1.1 grounded synthesis schemas (model advisory design 10). The
 * port is fixed to four purposes; each purpose owns a versioned input/output
 * schema pair. Dynamic purposes or dynamic schemas are rejected by the
 * literal pins below, never negotiated at runtime.
 */
export const GROUNDED_SYNTHESIS_SCHEMA_VERSIONS = {
  project_discovery: "project-discovery.v1",
  context_enrichment: "context-enrichment.v1",
  approval_brief: "approval-brief.v1",
  iteration_narrative: "iteration-narrative.v1",
} as const;
export type GroundedSynthesisSchemaVersion =
  (typeof GROUNDED_SYNTHESIS_SCHEMA_VERSIONS)[keyof typeof GROUNDED_SYNTHESIS_SCHEMA_VERSIONS];

export const GROUNDED_CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
export type GroundedConfidence = (typeof GROUNDED_CONFIDENCE_LEVELS)[number];
export const GroundedConfidenceSchema = enumerated(GROUNDED_CONFIDENCE_LEVELS);

/** A citation into the current bundle: locator plus the digest the model saw. */
export const GroundedSourceRefSchema = strictObject({
  locator: Type.String({ minLength: 1, maxLength: 400 }),
  source_digest: DigestSchema,
});
export type GroundedSourceRef = Static<typeof GroundedSourceRefSchema>;

const cited = <T extends Parameters<typeof strictObject>[0]>(properties: T) =>
  strictObject({
    ...properties,
    source_refs: Type.Array(GroundedSourceRefSchema, { minItems: 1 }),
  });

const SummaryClaimSchema = cited({ summary: Type.String({ minLength: 1 }) });

export const ProjectDiscoveryFactSchema = cited({
  fact: Type.String({ minLength: 1 }),
  confidence: GroundedConfidenceSchema,
});
export type ProjectDiscoveryFact = Static<typeof ProjectDiscoveryFactSchema>;

export const ProjectDiscoveryCapabilityCandidateSchema = cited({
  capability_id: Type.String({ minLength: 1 }),
  rationale: Type.String({ minLength: 1 }),
  confidence: GroundedConfidenceSchema,
});
export type ProjectDiscoveryCapabilityCandidate = Static<
  typeof ProjectDiscoveryCapabilityCandidateSchema
>;

export const ProjectDiscoveryGateCandidateSchema = cited({
  gate_id: Type.String({ minLength: 1 }),
  rationale: Type.String({ minLength: 1 }),
  confidence: GroundedConfidenceSchema,
});
export type ProjectDiscoveryGateCandidate = Static<typeof ProjectDiscoveryGateCandidateSchema>;

/**
 * Discovery returns sourced project facts, candidate capabilities/gates and
 * confidence only. The strict shape is the mechanical proof that it cannot
 * write Graph/Profile/CapabilityPlan.
 */
export const ProjectDiscoveryOutputSchema = strictObject({
  purpose: Type.Literal("project_discovery"),
  schema_version: Type.Literal(GROUNDED_SYNTHESIS_SCHEMA_VERSIONS.project_discovery),
  bundle_digest: DigestSchema,
  facts: Type.Array(ProjectDiscoveryFactSchema),
  capability_candidates: Type.Array(ProjectDiscoveryCapabilityCandidateSchema),
  gate_candidates: Type.Array(ProjectDiscoveryGateCandidateSchema),
});
export type ProjectDiscoveryOutput = Static<typeof ProjectDiscoveryOutputSchema>;

export const ContextEnrichmentOutputSchema = strictObject({
  purpose: Type.Literal("context_enrichment"),
  schema_version: Type.Literal(GROUNDED_SYNTHESIS_SCHEMA_VERSIONS.context_enrichment),
  bundle_digest: DigestSchema,
  terms: Type.Array(cited({ term: Type.String({ minLength: 1 }), definition: Type.String() })),
  segment_summaries: Type.Array(
    cited({ locator: Type.String({ minLength: 1, maxLength: 400 }), summary: Type.String() }),
  ),
  relevance_explanations: Type.Array(
    cited({
      locator: Type.String({ minLength: 1, maxLength: 400 }),
      explanation: Type.String({ minLength: 1 }),
    }),
  ),
});
export type ContextEnrichmentOutput = Static<typeof ContextEnrichmentOutputSchema>;

export const ApprovalBriefOutputSchema = strictObject({
  purpose: Type.Literal("approval_brief"),
  schema_version: Type.Literal(GROUNDED_SYNTHESIS_SCHEMA_VERSIONS.approval_brief),
  bundle_digest: DigestSchema,
  changes: Type.Array(SummaryClaimSchema),
  risks: Type.Array(SummaryClaimSchema),
  tradeoffs: Type.Array(SummaryClaimSchema),
  open_questions: Type.Array(cited({ question: Type.String({ minLength: 1 }) })),
});
export type ApprovalBriefOutput = Static<typeof ApprovalBriefOutputSchema>;

export const IterationNarrativeOutputSchema = strictObject({
  purpose: Type.Literal("iteration_narrative"),
  schema_version: Type.Literal(GROUNDED_SYNTHESIS_SCHEMA_VERSIONS.iteration_narrative),
  bundle_digest: DigestSchema,
  outcomes: Type.Array(SummaryClaimSchema),
  residual_risks: Type.Array(SummaryClaimSchema),
  follow_ups: Type.Array(SummaryClaimSchema),
});
export type IterationNarrativeOutput = Static<typeof IterationNarrativeOutputSchema>;

/** The closed union of the four purpose outputs; the discriminator is literal. */
export const GroundedSynthesisOutputSchema = Type.Union([
  ProjectDiscoveryOutputSchema,
  ContextEnrichmentOutputSchema,
  ApprovalBriefOutputSchema,
  IterationNarrativeOutputSchema,
]);
export type GroundedSynthesisOutput = Static<typeof GroundedSynthesisOutputSchema>;

/**
 * Versioned discovery input (model advisory 10): the provider receives the
 * compiled bundle as data, the pinned schema version and the Harness-derived
 * conversation/run identity. It never receives filesystem or Ledger access.
 */
export const ProjectDiscoveryInputSchema = strictObject({
  purpose: Type.Literal("project_discovery"),
  schema_version: Type.Literal(GROUNDED_SYNTHESIS_SCHEMA_VERSIONS.project_discovery),
  binding_digest: DigestSchema,
  conversation_id: IdentifierSchema,
  run_id: IdentifierSchema,
  bundle: ProjectContextBundleRecordSchema,
  operator_intent: Type.Optional(Type.String({ minLength: 1 })),
});
export type ProjectDiscoveryInput = Static<typeof ProjectDiscoveryInputSchema>;

/**
 * The domain result record (model advisory 5.3). Run provenance — tokens,
 * duration, raw artifacts — belongs to the Task 8 invocation record and never
 * enters this semantic digest.
 */
export const GroundedSynthesisRecordSchema = recordEnvelopeSchema("grounded_synthesis", {
  grounded_synthesis_id: IdentifierSchema,
  purpose: enumerated(GROUNDED_SYNTHESIS_PURPOSES),
  session_id: Type.Optional(IdentifierSchema),
  profile_decision_digest: Type.Optional(DigestSchema),
  binding_digest: DigestSchema,
  bundle_digest: DigestSchema,
  conversation_id: IdentifierSchema,
  run_id: IdentifierSchema,
  input_digest: DigestSchema,
  output: GroundedSynthesisOutputSchema,
});
export type GroundedSynthesisRecord = Static<typeof GroundedSynthesisRecordSchema>;
