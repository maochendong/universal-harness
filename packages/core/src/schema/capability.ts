import { Type, type Static } from "@sinclair/typebox";

import { DigestSchema, IdentifierSchema, enumerated, strictObject } from "./common.js";
import { recordEnvelopeSchema } from "./envelope.js";
import { CAPABILITY_IDS, ModelProviderBindingSchema, ProfileIdSchema } from "./profile.js";

/**
 * Protocol 1.1 capability plan schemas (slim-profiles design 6, 8.4 and 9).
 * The CapabilityPlanRecord is the authoritative, append-only output of the
 * Capability Compiler: the resolved capability closure with per-capability
 * resolution, provider closure, approval object policy, the Operation DAG,
 * the invalidation graph and the operation-scope ModelProviderBindings.
 */
export const COMPILATION_STAGES = ["provisional", "final"] as const;
export type CompilationStage = (typeof COMPILATION_STAGES)[number];

export const CAPABILITY_RESOLUTIONS = ["active", "inactive_by_profile", "deferred"] as const;
export type CapabilityResolution = (typeof CAPABILITY_RESOLUTIONS)[number];

export const CAPABILITY_RESOLUTION_SOURCES = [
  "profile_required",
  "policy_required",
  "policy_denied",
  "user_activation",
  "risk_activation",
  "dependency_closure",
  "awaiting_design_set",
  "design_set_finalization",
  "conditional_inactive",
] as const;
export type CapabilityResolutionSource = (typeof CAPABILITY_RESOLUTION_SOURCES)[number];

/** Non-model provider capabilities modules may require (design 6.3). */
export const PROVIDER_CAPABILITIES = [
  "isolated_workspace_provider",
  "structured_gate_provider",
] as const;
export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

/** Authoritative artifacts flowing between DAG nodes and modules. */
export const BINDING_KINDS = [
  "audit_report",
  "context_bundle",
  "design_set",
  "evaluation_report",
  "execution_plan",
  "gate_evidence",
  "impact_set",
  "requirement_baseline",
  "snapshot",
  "tdd_contract",
] as const;
export type BindingKind = (typeof BINDING_KINDS)[number];

export const APPROVAL_OBJECT_KINDS = [
  "design_set",
  "impact_set",
  "project_profile",
  "requirement_baseline",
] as const;
export type ApprovalObjectKind = (typeof APPROVAL_OBJECT_KINDS)[number];

const DAG_NODE_ID_PATTERN = "^[a-z][a-z0-9_]*$";

export const OperationDagNodeSchema = strictObject({
  node_id: Type.String({ minLength: 1, pattern: DAG_NODE_ID_PATTERN }),
  node_kind: enumerated(["kernel", "module"] as const),
  capability_id: Type.Optional(enumerated(CAPABILITY_IDS)),
  depends_on: Type.Array(Type.String({ minLength: 1, pattern: DAG_NODE_ID_PATTERN })),
  consumes: Type.Array(enumerated(BINDING_KINDS)),
  produces: Type.Array(enumerated(BINDING_KINDS)),
  checkpoint: Type.Boolean(),
  subgraph: Type.Optional(Type.Literal("strict_tdd")),
});
export type OperationDagNodeRecord = Static<typeof OperationDagNodeSchema>;

export const CapabilityResolutionEntrySchema = strictObject({
  capability_id: enumerated(CAPABILITY_IDS),
  resolution: enumerated(CAPABILITY_RESOLUTIONS),
  resolution_source: enumerated(CAPABILITY_RESOLUTION_SOURCES),
  module_version: Type.String({ minLength: 1 }),
  module_digest: DigestSchema,
  binding_digest: DigestSchema,
});
export type CapabilityResolutionEntry = Static<typeof CapabilityResolutionEntrySchema>;

export const InvalidationEdgeSchema = strictObject({
  binding_kind: enumerated(BINDING_KINDS),
  invalidates: Type.Array(enumerated(CAPABILITY_IDS), { minItems: 1 }),
});
export type InvalidationEdge = Static<typeof InvalidationEdgeSchema>;

/**
 * Slim-profiles design 8.4: one record per capability plan revision. The
 * provisional → final transition (Standard strict_tdd) supersedes the
 * provisional revision; `model_provider_bindings` holds only operation-scope
 * bindings — capture-scope slots never appear here (model advisory 11.1).
 */
export const CapabilityPlanRecordSchema = recordEnvelopeSchema("capability_plan", {
  capability_plan_id: IdentifierSchema,
  operation_id: IdentifierSchema,
  revision: Type.Integer({ minimum: 1 }),
  compilation_stage: enumerated(COMPILATION_STAGES),
  profile_id: ProfileIdSchema,
  project_profile_digest: DigestSchema,
  profile_decision_digest: DigestSchema,
  requirement_digest: DigestSchema,
  risk_digest: DigestSchema,
  policy_digest: DigestSchema,
  baseline_digest: DigestSchema,
  capabilities: Type.Array(CapabilityResolutionEntrySchema, {
    minItems: CAPABILITY_IDS.length,
  }),
  providers: Type.Array(enumerated(PROVIDER_CAPABILITIES)),
  approval_policy_id: Type.String({ minLength: 1 }),
  approval_objects: Type.Array(enumerated(APPROVAL_OBJECT_KINDS)),
  operation_dag: strictObject({
    nodes: Type.Array(OperationDagNodeSchema, { minItems: 1 }),
  }),
  invalidation_graph: Type.Array(InvalidationEdgeSchema),
  model_provider_bindings: Type.Array(ModelProviderBindingSchema),
  design_set_digest: Type.Optional(DigestSchema),
  test_strategy_digest: Type.Optional(DigestSchema),
  supersedes_digest: Type.Optional(DigestSchema),
});
export type CapabilityPlanRecord = Static<typeof CapabilityPlanRecordSchema>;
