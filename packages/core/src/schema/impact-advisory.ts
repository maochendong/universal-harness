import { Type, type Static } from "@sinclair/typebox";

import { DigestSchema, IdentifierSchema, enumerated, strictObject } from "./common.js";
import { recordEnvelopeSchema } from "./envelope.js";

/**
 * Impact advisory schemas (model advisory design 6, prompt governance
 * addendum PG-3). The advisory output only ever ADDS candidates to the
 * deterministic ImpactSet: there is no field that could delete an entry,
 * lower a risk or rewrite a propagation direction, and every candidate must
 * cite the current graph, the accepted PRD or a context source.
 */
export const IMPACT_ADVISORY_SCHEMA_VERSION = "impact-advisory.v1" as const;

export const IMPACT_ADVISORY_CLASSIFICATIONS = ["must-change", "inspect", "informational"] as const;
export const IMPACT_ADVISORY_RISKS = ["low", "medium", "high"] as const;

/** A citation into the current graph, the accepted PRD or a context source. */
export const ImpactAdvisorySourceRefSchema = strictObject({
  kind: enumerated(["graph_node", "requirement", "context_source"]),
  ref: Type.String({ minLength: 1, maxLength: 400 }),
  digest: DigestSchema,
});
export type ImpactAdvisorySourceRef = Static<typeof ImpactAdvisorySourceRefSchema>;

const cited = <T extends Parameters<typeof strictObject>[0]>(properties: T) =>
  strictObject({
    ...properties,
    source_refs: Type.Array(ImpactAdvisorySourceRefSchema, { minItems: 1 }),
  });

/** A candidate entry the deterministic propagation missed. */
export const ImpactCandidateSchema = cited({
  node_id: IdentifierSchema,
  node_type: Type.String({ minLength: 1 }),
  classification: enumerated(IMPACT_ADVISORY_CLASSIFICATIONS),
  risk: enumerated(IMPACT_ADVISORY_RISKS),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  reason: Type.String({ minLength: 1 }),
});
export type ImpactCandidate = Static<typeof ImpactCandidateSchema>;

/** A candidate inferred edge; the relation registry rules still apply. */
export const ImpactEdgeCandidateSchema = cited({
  source_id: IdentifierSchema,
  target_id: IdentifierSchema,
  relation: Type.String({ minLength: 1 }),
  rationale: Type.String({ minLength: 1 }),
});
export type ImpactEdgeCandidate = Static<typeof ImpactEdgeCandidateSchema>;

/** A risk signal attached to an existing node; signals never lower risk. */
export const ImpactRiskSignalSchema = cited({
  node_id: IdentifierSchema,
  signal: Type.String({ minLength: 1 }),
  risk: enumerated(IMPACT_ADVISORY_RISKS),
  rationale: Type.String({ minLength: 1 }),
});
export type ImpactRiskSignal = Static<typeof ImpactRiskSignalSchema>;

/** A fact the advisor could not establish from the cited sources. */
export const ImpactMissingFactSchema = cited({
  subject_id: Type.String({ minLength: 1, maxLength: 400 }),
  fact: Type.String({ minLength: 1 }),
  why_it_matters: Type.String({ minLength: 1 }),
});
export type ImpactMissingFact = Static<typeof ImpactMissingFactSchema>;

export const ImpactClarificationQuestionSchema = strictObject({
  question: Type.String({ minLength: 1 }),
  target_id: Type.Optional(Type.String({ minLength: 1, maxLength: 400 })),
});
export type ImpactClarificationQuestion = Static<typeof ImpactClarificationQuestionSchema>;

export const ImpactAdvisoryOutputSchema = strictObject({
  purpose: Type.Literal("impact_advisory"),
  schema_version: Type.Literal(IMPACT_ADVISORY_SCHEMA_VERSION),
  impact_set_digest: DigestSchema,
  additions: Type.Array(ImpactCandidateSchema),
  edge_candidates: Type.Array(ImpactEdgeCandidateSchema),
  risk_signals: Type.Array(ImpactRiskSignalSchema),
  missing_facts: Type.Array(ImpactMissingFactSchema),
  questions: Type.Array(ImpactClarificationQuestionSchema),
});
export type ImpactAdvisoryOutput = Static<typeof ImpactAdvisoryOutputSchema>;

/**
 * The domain result record (model advisory design 5.3): run provenance stays
 * in the invocation record; this record pins the advised set, the relation
 * rule registry version/digest and the binding/conversation/run identity.
 */
export const ImpactAdvisoryRecordSchema = recordEnvelopeSchema("impact_advisory", {
  impact_advisory_id: IdentifierSchema,
  workflow_operation_id: IdentifierSchema,
  iteration_id: IdentifierSchema,
  impact_set_digest: DigestSchema,
  relation_rule_registry_version: Type.String({ minLength: 1, maxLength: 120 }),
  relation_rule_registry_digest: DigestSchema,
  binding_digest: DigestSchema,
  conversation_id: IdentifierSchema,
  run_id: IdentifierSchema,
  input_digest: DigestSchema,
  output: ImpactAdvisoryOutputSchema,
});
export type ImpactAdvisoryRecord = Static<typeof ImpactAdvisoryRecordSchema>;
