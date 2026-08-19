import { Type, type Static } from "@sinclair/typebox";

import { CAPTURE_QUESTION_TARGET_KINDS } from "./capture.js";
import { DigestSchema, IdentifierSchema, enumerated, strictObject } from "./common.js";
import { recordEnvelopeSchema } from "./envelope.js";

/**
 * Protocol 1.1 PRD Proposal schemas (intent-to-prd design 6.4/6.5/6.6). The
 * structured `PrdProposal` is the single authoritative source of PRD content;
 * adapters only ever return a `PrdProposalDraft` keyed by per-call
 * `draft_key` plus a declared lineage. Both shapes are strict
 * (`additionalProperties: false`), so adapter metadata, telemetry, times,
 * tokens and conversation ids can never leak into the content digest.
 */
export const PRD_PROPOSAL_SCHEMA_VERSION = "1.1.0" as const;

export const PRD_SOURCE_BINDING_KINDS = [
  "intent",
  "clarification_answer",
  "project_context",
  "accepted_prd",
  "validation_finding",
  "review_finding",
] as const;
export type PrdSourceBindingKind = (typeof PRD_SOURCE_BINDING_KINDS)[number];
export const PrdSourceBindingKindSchema = enumerated(PRD_SOURCE_BINDING_KINDS);

export const PRD_SCENARIO_KINDS = [
  "primary",
  "failure",
  "boundary",
  "security",
  "compatibility",
] as const;
export type PrdScenarioKind = (typeof PRD_SCENARIO_KINDS)[number];
export const PrdScenarioKindSchema = enumerated(PRD_SCENARIO_KINDS);

export const PRD_REQUIREMENT_PRIORITIES = ["must", "should", "could"] as const;
export type PrdRequirementPriority = (typeof PRD_REQUIREMENT_PRIORITIES)[number];

export const PRD_CHANGE_KINDS = ["must_change", "preserve"] as const;
export type PrdChangeKind = (typeof PRD_CHANGE_KINDS)[number];

export const PRD_CONSTRAINT_CATEGORIES = [
  "business",
  "technical",
  "security",
  "compliance",
  "compatibility",
  "operational",
] as const;
export type PrdConstraintCategory = (typeof PRD_CONSTRAINT_CATEGORIES)[number];

export const PRD_DEPENDENCY_KINDS = ["internal", "external"] as const;
export type PrdDependencyKind = (typeof PRD_DEPENDENCY_KINDS)[number];

export const PRD_RISK_CATEGORIES = [
  "security",
  "privacy",
  "compliance",
  "financial",
  "data_integrity",
  "availability",
  "compatibility",
  "migration",
  "operational",
  "delivery",
  "other",
] as const;
export type PrdRiskCategory = (typeof PRD_RISK_CATEGORIES)[number];

export const PRD_RISK_LIKELIHOODS = ["low", "medium", "high", "unknown"] as const;
export type PrdRiskLikelihood = (typeof PRD_RISK_LIKELIHOODS)[number];

export const PRD_RISK_IMPACTS = ["low", "medium", "high", "critical", "unknown"] as const;
export type PrdRiskImpact = (typeof PRD_RISK_IMPACTS)[number];

export const PRD_PROPOSAL_STATUSES = ["proposed", "superseded", "rejected", "accepted"] as const;
export type PrdProposalStatus = (typeof PRD_PROPOSAL_STATUSES)[number];

export const PRD_ENTITY_KINDS = [
  "goal",
  "non_goal",
  "actor",
  "scenario",
  "requirement",
  "constraint",
  "acceptance_criterion",
  "assumption",
  "dependency",
  "risk",
  "open_question",
  "glossary_term",
] as const;
export type PrdEntityKind = (typeof PRD_ENTITY_KINDS)[number];
export const PrdEntityKindSchema = enumerated(PRD_ENTITY_KINDS);

export const PRD_LINEAGE_KINDS = ["new", "continues"] as const;
export type PrdLineageKind = (typeof PRD_LINEAGE_KINDS)[number];

/**
 * Text fields deliberately allow the empty string: blank required fields are
 * semantic defects the deterministic hard gates turn into typed clarification
 * questions (design 12), not schema errors the Coordinator cannot route.
 * Length ceilings still apply, so malformed or hostile oversize output fails
 * schema validation.
 */
const Text = Type.String({ maxLength: 4000 });
const LongText = Type.String({ maxLength: 16000 });
const DraftKeySchema = Type.String({ minLength: 1, maxLength: 160 });

export const PrdSourceBindingSchema = strictObject({
  source_kind: PrdSourceBindingKindSchema,
  source_id: Type.String({ minLength: 1, maxLength: 400 }),
  source_digest: DigestSchema,
});
export type PrdSourceBinding = Static<typeof PrdSourceBindingSchema>;

// --- Canonical entities (Coordinator-issued ids) --------------------------

export const PrdStatementSchema = strictObject({
  id: IdentifierSchema,
  statement: Text,
  source_bindings: Type.Array(PrdSourceBindingSchema, { minItems: 1 }),
});
export type PrdStatement = Static<typeof PrdStatementSchema>;

export const PrdActorSchema = strictObject({
  id: IdentifierSchema,
  name: Type.String({ maxLength: 400 }),
  description: Text,
  source_bindings: Type.Array(PrdSourceBindingSchema, { minItems: 1 }),
});
export type PrdActor = Static<typeof PrdActorSchema>;

export const PrdScenarioSchema = strictObject({
  id: IdentifierSchema,
  actor_id: IdentifierSchema,
  precondition: Text,
  action: Text,
  observable_outcome: Text,
  scenario_kind: PrdScenarioKindSchema,
  source_bindings: Type.Array(PrdSourceBindingSchema, { minItems: 1 }),
});
export type PrdScenario = Static<typeof PrdScenarioSchema>;

export const PrdRequirementSchema = strictObject({
  id: IdentifierSchema,
  statement: Text,
  priority: enumerated(PRD_REQUIREMENT_PRIORITIES),
  change_kind: enumerated(PRD_CHANGE_KINDS),
  scenario_ids: Type.Array(IdentifierSchema, { uniqueItems: true }),
  acceptance_criterion_ids: Type.Array(IdentifierSchema, { uniqueItems: true }),
  source_bindings: Type.Array(PrdSourceBindingSchema, { minItems: 1 }),
});
export type PrdRequirement = Static<typeof PrdRequirementSchema>;

export const PrdConstraintSchema = strictObject({
  id: IdentifierSchema,
  statement: Text,
  category: enumerated(PRD_CONSTRAINT_CATEGORIES),
  verification_intent: Text,
  source_bindings: Type.Array(PrdSourceBindingSchema, { minItems: 1 }),
});
export type PrdConstraint = Static<typeof PrdConstraintSchema>;

export const PrdDependencySchema = strictObject({
  id: IdentifierSchema,
  dependency_kind: enumerated(PRD_DEPENDENCY_KINDS),
  description: Text,
  required_by_ids: Type.Array(IdentifierSchema, { uniqueItems: true }),
  source_bindings: Type.Array(PrdSourceBindingSchema, { minItems: 1 }),
});
export type PrdDependency = Static<typeof PrdDependencySchema>;

export const PrdRiskSchema = strictObject({
  id: IdentifierSchema,
  category: enumerated(PRD_RISK_CATEGORIES),
  description: Text,
  likelihood: enumerated(PRD_RISK_LIKELIHOODS),
  impact: enumerated(PRD_RISK_IMPACTS),
  mitigation: Text,
  source_bindings: Type.Array(PrdSourceBindingSchema, { minItems: 1 }),
});
export type PrdRisk = Static<typeof PrdRiskSchema>;

export const PrdOpenQuestionSchema = strictObject({
  id: IdentifierSchema,
  question: Text,
  blocking: Type.Boolean(),
  owner: Type.String({ maxLength: 400 }),
  source_bindings: Type.Array(PrdSourceBindingSchema, { minItems: 1 }),
});
export type PrdOpenQuestion = Static<typeof PrdOpenQuestionSchema>;

export const PrdGlossaryTermSchema = strictObject({
  id: IdentifierSchema,
  term: Type.String({ maxLength: 400 }),
  definition: Text,
  source_bindings: Type.Array(PrdSourceBindingSchema, { minItems: 1 }),
});
export type PrdGlossaryTerm = Static<typeof PrdGlossaryTermSchema>;

/**
 * Acceptance criterion (design 6.5). `criterion_semantic_digest` is derived by
 * the Coordinator from the business fields alone; it never includes the
 * criterion id, source bindings, timestamps or the digest field itself.
 */
export const PrdAcceptanceCriterionSchema = strictObject({
  criterion_id: IdentifierSchema,
  requirement_id: IdentifierSchema,
  precondition: Text,
  action: Text,
  observable_outcome: Text,
  verification_intent: Text,
  test_first_example: Type.Optional(Text),
  scenario_kind: PrdScenarioKindSchema,
  criterion_semantic_digest: DigestSchema,
  source_bindings: Type.Array(PrdSourceBindingSchema, { minItems: 1 }),
});
export type PrdAcceptanceCriterion = Static<typeof PrdAcceptanceCriterionSchema>;

/** The canonical, content-addressed PRD proposal body (design 6.4). */
export const PrdProposalContentSchema = strictObject({
  schema_version: Type.Literal(PRD_PROPOSAL_SCHEMA_VERSION),
  intent: strictObject({ text: LongText, digest: DigestSchema }),
  problem_statement: LongText,
  goals: Type.Array(PrdStatementSchema),
  non_goals: Type.Array(PrdStatementSchema),
  actors: Type.Array(PrdActorSchema),
  scenarios: Type.Array(PrdScenarioSchema),
  requirements: Type.Array(PrdRequirementSchema),
  constraints: Type.Array(PrdConstraintSchema),
  acceptance_criteria: Type.Array(PrdAcceptanceCriterionSchema),
  assumptions: Type.Array(PrdStatementSchema),
  dependencies: Type.Array(PrdDependencySchema),
  risks: Type.Array(PrdRiskSchema),
  open_questions: Type.Array(PrdOpenQuestionSchema),
  glossary: Type.Array(PrdGlossaryTermSchema),
  context_source_refs: Type.Array(Type.String({ minLength: 1, maxLength: 400 }), {
    uniqueItems: true,
  }),
});
export type PrdProposal = Static<typeof PrdProposalContentSchema>;

// --- Adapter draft (no canonical ids, declared lineage) -------------------

export const PrdDraftLineageSchema = Type.Union([
  strictObject({ kind: Type.Literal("new") }),
  strictObject({ kind: Type.Literal("continues"), previous_entity_id: IdentifierSchema }),
]);
export type PrdDraftLineage = Static<typeof PrdDraftLineageSchema>;

const draftEntityBase = {
  draft_key: DraftKeySchema,
  lineage: PrdDraftLineageSchema,
  proposed_source_bindings: Type.Array(PrdSourceBindingSchema, { minItems: 1 }),
};

export const PrdDraftStatementSchema = strictObject({ ...draftEntityBase, statement: Text });
export type PrdDraftStatement = Static<typeof PrdDraftStatementSchema>;

export const PrdDraftActorSchema = strictObject({
  ...draftEntityBase,
  name: Type.String({ maxLength: 400 }),
  description: Text,
});
export type PrdDraftActor = Static<typeof PrdDraftActorSchema>;

export const PrdDraftScenarioSchema = strictObject({
  ...draftEntityBase,
  actor_id: Type.String({ minLength: 1, maxLength: 160 }),
  precondition: Text,
  action: Text,
  observable_outcome: Text,
  scenario_kind: PrdScenarioKindSchema,
});
export type PrdDraftScenario = Static<typeof PrdDraftScenarioSchema>;

export const PrdDraftRequirementSchema = strictObject({
  ...draftEntityBase,
  statement: Text,
  priority: enumerated(PRD_REQUIREMENT_PRIORITIES),
  change_kind: enumerated(PRD_CHANGE_KINDS),
  scenario_ids: Type.Array(Type.String({ minLength: 1, maxLength: 160 })),
  acceptance_criterion_ids: Type.Array(Type.String({ minLength: 1, maxLength: 160 })),
});
export type PrdDraftRequirement = Static<typeof PrdDraftRequirementSchema>;

export const PrdDraftConstraintSchema = strictObject({
  ...draftEntityBase,
  statement: Text,
  category: enumerated(PRD_CONSTRAINT_CATEGORIES),
  verification_intent: Text,
});
export type PrdDraftConstraint = Static<typeof PrdDraftConstraintSchema>;

export const PrdDraftDependencySchema = strictObject({
  ...draftEntityBase,
  dependency_kind: enumerated(PRD_DEPENDENCY_KINDS),
  description: Text,
  required_by_ids: Type.Array(Type.String({ minLength: 1, maxLength: 160 })),
});
export type PrdDraftDependency = Static<typeof PrdDraftDependencySchema>;

export const PrdDraftRiskSchema = strictObject({
  ...draftEntityBase,
  category: enumerated(PRD_RISK_CATEGORIES),
  description: Text,
  likelihood: enumerated(PRD_RISK_LIKELIHOODS),
  impact: enumerated(PRD_RISK_IMPACTS),
  mitigation: Text,
});
export type PrdDraftRisk = Static<typeof PrdDraftRiskSchema>;

export const PrdDraftOpenQuestionSchema = strictObject({
  ...draftEntityBase,
  question: Text,
  blocking: Type.Boolean(),
  owner: Type.String({ maxLength: 400 }),
});
export type PrdDraftOpenQuestion = Static<typeof PrdDraftOpenQuestionSchema>;

export const PrdDraftGlossaryTermSchema = strictObject({
  ...draftEntityBase,
  term: Type.String({ maxLength: 400 }),
  definition: Text,
});
export type PrdDraftGlossaryTerm = Static<typeof PrdDraftGlossaryTermSchema>;

/**
 * Draft criterion (design 6.4/6.5). References use draft keys (or canonical
 * ids of a previous proposal). An adapter may carry its own
 * `criterion_semantic_digest`, but the Coordinator recomputes the digest after
 * id resolution and a mismatch fails deterministically — the adapter never
 * owns the value.
 */
export const PrdDraftAcceptanceCriterionSchema = strictObject({
  ...draftEntityBase,
  requirement_id: Type.String({ minLength: 1, maxLength: 160 }),
  precondition: Text,
  action: Text,
  observable_outcome: Text,
  verification_intent: Text,
  test_first_example: Type.Optional(Text),
  scenario_kind: PrdScenarioKindSchema,
  criterion_semantic_digest: Type.Optional(DigestSchema),
});
export type PrdDraftAcceptanceCriterion = Static<typeof PrdDraftAcceptanceCriterionSchema>;

export const PrdProposalDraftSchema = strictObject({
  schema_version: Type.Literal(PRD_PROPOSAL_SCHEMA_VERSION),
  intent: strictObject({ text: LongText, digest: DigestSchema }),
  problem_statement: LongText,
  goals: Type.Array(PrdDraftStatementSchema),
  non_goals: Type.Array(PrdDraftStatementSchema),
  actors: Type.Array(PrdDraftActorSchema),
  scenarios: Type.Array(PrdDraftScenarioSchema),
  requirements: Type.Array(PrdDraftRequirementSchema),
  constraints: Type.Array(PrdDraftConstraintSchema),
  acceptance_criteria: Type.Array(PrdDraftAcceptanceCriterionSchema),
  assumptions: Type.Array(PrdDraftStatementSchema),
  dependencies: Type.Array(PrdDraftDependencySchema),
  risks: Type.Array(PrdDraftRiskSchema),
  open_questions: Type.Array(PrdDraftOpenQuestionSchema),
  glossary: Type.Array(PrdDraftGlossaryTermSchema),
  context_source_refs: Type.Array(Type.String({ minLength: 1, maxLength: 400 })),
});
export type PrdProposalDraft = Static<typeof PrdProposalDraftSchema>;

// --- Records ----------------------------------------------------------------

/** The bound inputs the proposal was produced from (design 6.4). */
export const PrdProposalInputBindingSchema = strictObject({
  session_digest: DigestSchema,
  proposal_context_bundle_digest: DigestSchema,
  answers_digest: DigestSchema,
  adapter_profile_digest: DigestSchema,
  prompt_version_digest: DigestSchema,
  producer_identity: Type.String({ minLength: 1, maxLength: 200 }),
  invocation_id: IdentifierSchema,
  conversation_id: IdentifierSchema,
  evidence_locator: Type.String({ minLength: 1, maxLength: 400 }),
});
export type PrdProposalInputBinding = Static<typeof PrdProposalInputBindingSchema>;

/**
 * Canonical proposal record (design 6.4). One revision per proposal round of
 * the session; the approval object is `proposal_id + content_digest`.
 */
export const PrdProposalRecordSchema = recordEnvelopeSchema("prd_proposal", {
  proposal_id: IdentifierSchema,
  session_id: IdentifierSchema,
  revision: Type.Integer({ minimum: 1 }),
  status: enumerated(PRD_PROPOSAL_STATUSES),
  input_binding: PrdProposalInputBindingSchema,
  content: PrdProposalContentSchema,
  content_digest: DigestSchema,
  supersedes_digest: Type.Optional(DigestSchema),
});
export type PrdProposalRecord = Static<typeof PrdProposalRecordSchema>;

/**
 * Per-entity lineage index (design 6.4). It accelerates source tracing; the
 * proposal content remains the only content authority.
 */
export const PrdEntityLineageRecordSchema = recordEnvelopeSchema("prd_entity_lineage", {
  lineage_record_id: IdentifierSchema,
  session_id: IdentifierSchema,
  proposal_content_digest: DigestSchema,
  entity_kind: PrdEntityKindSchema,
  entity_id: IdentifierSchema,
  lineage_kind: enumerated(PRD_LINEAGE_KINDS),
  source_bindings: Type.Array(PrdSourceBindingSchema, { minItems: 1 }),
  previous_proposal_content_digest: Type.Optional(DigestSchema),
});
export type PrdEntityLineageRecord = Static<typeof PrdEntityLineageRecordSchema>;

// --- Deterministic validation report (design 6.6) ---------------------------

export const PRD_VALIDATION_SEVERITIES = ["critical", "warning"] as const;
export type PrdValidationSeverity = (typeof PRD_VALIDATION_SEVERITIES)[number];

export const PrdValidationFindingSchema = strictObject({
  severity: enumerated(PRD_VALIDATION_SEVERITIES),
  target_kind: enumerated(CAPTURE_QUESTION_TARGET_KINDS),
  target_id: Type.Optional(Type.String({ minLength: 1 })),
  message: Type.String({ minLength: 1 }),
});
export type PrdValidationFinding = Static<typeof PrdValidationFindingSchema>;

export const PrdValidationRuleResultSchema = strictObject({
  rule_id: Type.String({ minLength: 1, maxLength: 80 }),
  passed: Type.Boolean(),
  findings: Type.Array(PrdValidationFindingSchema),
});
export type PrdValidationRuleResult = Static<typeof PrdValidationRuleResultSchema>;

/**
 * Hard-gate outcome for one proposal (design 6.6). The report binds the exact
 * proposal digest and the versioned rule set, so the same proposal and rules
 * always reproduce the same report digest.
 */
export const PrdValidationReportRecordSchema = recordEnvelopeSchema("prd_validation_report", {
  validation_report_id: IdentifierSchema,
  session_id: IdentifierSchema,
  proposal_digest: DigestSchema,
  rule_set_digest: DigestSchema,
  passed: Type.Boolean(),
  results: Type.Array(PrdValidationRuleResultSchema),
  blocking_question_ids: Type.Array(IdentifierSchema, { uniqueItems: true }),
  report_digest: DigestSchema,
});
export type PrdValidationReportRecord = Static<typeof PrdValidationReportRecordSchema>;
