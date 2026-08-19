import { Type, type Static } from "@sinclair/typebox";

import { PROTOCOL_1_1_VERSION } from "../protocol.js";
import {
  DigestSchema,
  IdentifierSchema,
  TimestampSchema,
  enumerated,
  strictObject,
} from "./common.js";
import { recordEnvelopeSchema } from "./envelope.js";

/**
 * Protocol 1.1 project profile schemas (slim-profiles design 7/8 and model
 * advisory design 11). ProfileDefinitions are protocol registry data (not
 * ledger records), while ProjectProfile/ProfileRecommendation/ProfileDecision
 * and the Capture-scope ModelProviderBinding are append-only authoritative
 * records built on the shared record envelope.
 */
export const PROFILE_IDS = ["lite", "standard", "governed"] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];
export const ProfileIdSchema = enumerated(PROFILE_IDS);

export const CAPABILITY_IDS = [
  "impact_analysis",
  "design_governance",
  "independent_evaluation",
  "strict_tdd",
  "advanced_audit",
] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export const CAPABILITY_MODES = ["required", "conditional", "disabled"] as const;
export type CapabilityMode = (typeof CAPABILITY_MODES)[number];
export const CapabilityModeSchema = enumerated(CAPABILITY_MODES);

/** Registry data for one tier; the digest seals the whole definition. */
export const ProfileDefinitionSchema = strictObject({
  profile_id: ProfileIdSchema,
  protocol_version: Type.Literal(PROTOCOL_1_1_VERSION),
  capabilities: strictObject({
    impact_analysis: CapabilityModeSchema,
    design_governance: CapabilityModeSchema,
    independent_evaluation: CapabilityModeSchema,
    strict_tdd: CapabilityModeSchema,
    advanced_audit: CapabilityModeSchema,
  }),
  approval_policy_id: Type.String({ minLength: 1 }),
  dashboard_presentation_id: Type.String({ minLength: 1 }),
  cli_presentation_id: Type.String({ minLength: 1 }),
  definition_digest: DigestSchema,
});
export type ProfileDefinition = Static<typeof ProfileDefinitionSchema>;

export const MODEL_SLOT_IDS = [
  "impact_advisory",
  "design_review",
  "plan_proposal",
  "feedback_analysis",
  "grounded_synthesis",
] as const;
export type ModelSlotId = (typeof MODEL_SLOT_IDS)[number];

export const GROUNDED_SYNTHESIS_PURPOSES = [
  "project_discovery",
  "context_enrichment",
  "approval_brief",
  "iteration_narrative",
] as const;
export type GroundedSynthesisPurpose = (typeof GROUNDED_SYNTHESIS_PURPOSES)[number];

export const MODEL_BINDING_FAILURE_MODES = ["block", "projection_finding"] as const;
export type ModelBindingFailureMode = (typeof MODEL_BINDING_FAILURE_MODES)[number];

/**
 * One provider binding for one slot/purpose (model advisory design 11.1). The
 * same shape is held by the Capture-scope record (this task) and by the
 * CapabilityPlan's operation-scope list (Task 3); the two scopes never hold
 * the same slot/purpose at once.
 */
export const ModelProviderBindingSchema = strictObject({
  slot_id: enumerated(MODEL_SLOT_IDS),
  purpose: Type.Optional(enumerated(GROUNDED_SYNTHESIS_PURPOSES)),
  required: Type.Boolean(),
  provider_identity: Type.String({ minLength: 1 }),
  config_digest: DigestSchema,
  prompt_version: Type.String({ minLength: 1 }),
  schema_version: Type.String({ minLength: 1 }),
  budget_profile: Type.String({ minLength: 1 }),
  failure_mode: enumerated(MODEL_BINDING_FAILURE_MODES),
});
export type ModelProviderBinding = Static<typeof ModelProviderBindingSchema>;

/** Versioned risk triggers that may raise the recommended minimum profile. */
export const PROFILE_RECOMMENDATION_TRIGGER_IDS = [
  "cross_component_change",
  "public_api_change",
  "data_schema_or_migration_change",
  "security_or_supply_chain_surface",
  "medium_high_impact_uncertainty",
  "independent_evaluation_or_design_contract_required",
  "insufficient_gate_foundation",
  "critical_risk",
  "regulatory_or_audit_constraint",
  "irreversible_external_effect",
  "production_or_sensitive_data_access",
  "policy_mandated_governance",
] as const;
export type ProfileRecommendationTriggerId = (typeof PROFILE_RECOMMENDATION_TRIGGER_IDS)[number];

export const PROFILE_DECISION_KINDS = [
  "keep",
  "temporary_upgrade",
  "project_profile_change",
  "override_recommendation",
] as const;
export type ProfileDecisionKind = (typeof PROFILE_DECISION_KINDS)[number];

/** Slim-profiles design 8.1: the project's base profile, one record per revision. */
export const ProjectProfileRecordSchema = recordEnvelopeSchema("project_profile", {
  project_profile_id: IdentifierSchema,
  project_id: IdentifierSchema,
  revision: Type.Integer({ minimum: 1 }),
  profile_id: ProfileIdSchema,
  profile_definition_digest: DigestSchema,
  policy_digest: DigestSchema,
  approval_request_id: IdentifierSchema,
  approval_digest: DigestSchema,
  effective_from: TimestampSchema,
  supersedes_digest: Type.Optional(DigestSchema),
});
export type ProjectProfileRecord = Static<typeof ProjectProfileRecordSchema>;

/** Slim-profiles design 8.2: a risk-engine suggestion; it grants nothing. */
export const ProfileRecommendationRecordSchema = recordEnvelopeSchema("profile_recommendation", {
  profile_recommendation_id: IdentifierSchema,
  project_id: IdentifierSchema,
  iteration_id: IdentifierSchema,
  current_profile_id: ProfileIdSchema,
  recommended_profile_id: ProfileIdSchema,
  triggers: Type.Array(enumerated(PROFILE_RECOMMENDATION_TRIGGER_IDS), {
    minItems: 1,
    uniqueItems: true,
  }),
  risk_object_digest: DigestSchema,
  requirement_digest: DigestSchema,
  scope_digest: DigestSchema,
  policy_digest: DigestSchema,
  rationale: Type.String({ minLength: 1 }),
  scope_reduction_hint: Type.Optional(Type.String({ minLength: 1 })),
});
export type ProfileRecommendationRecord = Static<typeof ProfileRecommendationRecordSchema>;

/**
 * Slim-profiles design 8.3: the auditable human/system decision. Overrides
 * bind the recommendation, iteration, risk object and scope digests; any
 * drift invalidates them (the domain check lives in profile/decisions).
 */
export const ProfileDecisionRecordSchema = recordEnvelopeSchema("profile_decision", {
  profile_decision_id: IdentifierSchema,
  idempotency_key: Type.String({ minLength: 1, maxLength: 200 }),
  decision_kind: enumerated(PROFILE_DECISION_KINDS),
  project_id: IdentifierSchema,
  iteration_id: Type.Optional(IdentifierSchema),
  actor: Type.String({ minLength: 1, maxLength: 200 }),
  reason: Type.Optional(Type.String({ minLength: 1 })),
  recommendation_id: Type.Optional(IdentifierSchema),
  recommendation_digest: Type.Optional(DigestSchema),
  current_profile_id: ProfileIdSchema,
  decided_profile_id: ProfileIdSchema,
  requirement_digest: Type.Optional(DigestSchema),
  risk_digest: Type.Optional(DigestSchema),
  scope_digest: Type.Optional(DigestSchema),
  policy_digest: DigestSchema,
  approval_digest: DigestSchema,
  decided_at: TimestampSchema,
});
export type ProfileDecisionRecord = Static<typeof ProfileDecisionRecordSchema>;

/**
 * Capture-scope model provider bindings (model advisory design 11.1):
 * `project_discovery` and the Capture-stage `approval_brief` run before the
 * CapabilityPlan exists, so a ProfileDecision-scoped record — committed before
 * Capture starts — holds them, bound to the decision, policy, config, baseline
 * and prompt/schema version summaries.
 */
export const CaptureModelProviderBindingRecordSchema = recordEnvelopeSchema(
  "model_provider_binding",
  {
    model_provider_binding_id: IdentifierSchema,
    scope: Type.Literal("capture"),
    project_id: IdentifierSchema,
    profile_decision_id: IdentifierSchema,
    profile_decision_digest: DigestSchema,
    policy_digest: DigestSchema,
    config_digest: DigestSchema,
    baseline_digest: DigestSchema,
    bindings: Type.Array(ModelProviderBindingSchema, { minItems: 1 }),
  },
);
export type CaptureModelProviderBindingRecord = Static<
  typeof CaptureModelProviderBindingRecordSchema
>;
