import { Type, type Static } from "@sinclair/typebox";

import { PROTOCOL_1_3_VERSION } from "../protocol.js";
import { DigestSchema, IdentifierSchema, enumerated, strictObject } from "./common.js";
import { recordEnvelopeSchema, recordEnvelopeSchemaFor } from "./envelope.js";
import {
  CAPABILITY_IDS,
  CAPABILITY_IDS_1_3,
  ModelProviderBindingSchema,
  ProfileIdSchema,
} from "./profile.js";

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

/**
 * Protocol 1.3 binding kinds (M4 design 10.2): the 1.1 vocabulary plus
 * `wave_integration`, the sole new output of the parallel_task_execution
 * module. The 1.1 list above stays untouched so legacy schemas never drift.
 */
export const BINDING_KINDS_1_3 = [...BINDING_KINDS, "wave_integration"] as const;
export type BindingKindV13 = (typeof BINDING_KINDS_1_3)[number];

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

/**
 * Protocol 1.3 DAG node (M4 design 10.2): the execute `subgraph` discriminator
 * gains `parallel_task_execution`, and nodes may consume/produce the
 * `wave_integration` binding. The 1.1 node schema above stays byte-identical.
 */
export const OperationDagNodeV13Schema = strictObject({
  node_id: Type.String({ minLength: 1, pattern: DAG_NODE_ID_PATTERN }),
  node_kind: enumerated(["kernel", "module"] as const),
  capability_id: Type.Optional(enumerated(CAPABILITY_IDS_1_3)),
  depends_on: Type.Array(Type.String({ minLength: 1, pattern: DAG_NODE_ID_PATTERN })),
  consumes: Type.Array(enumerated(BINDING_KINDS_1_3)),
  produces: Type.Array(enumerated(BINDING_KINDS_1_3)),
  checkpoint: Type.Boolean(),
  subgraph: Type.Optional(enumerated(["strict_tdd", "parallel_task_execution"] as const)),
});
export type OperationDagNodeV13Record = Static<typeof OperationDagNodeV13Schema>;

export const CapabilityResolutionEntrySchema = strictObject({
  capability_id: enumerated(CAPABILITY_IDS),
  resolution: enumerated(CAPABILITY_RESOLUTIONS),
  resolution_source: enumerated(CAPABILITY_RESOLUTION_SOURCES),
  module_version: Type.String({ minLength: 1 }),
  module_digest: DigestSchema,
  binding_digest: DigestSchema,
});
export type CapabilityResolutionEntry = Static<typeof CapabilityResolutionEntrySchema>;

/** Protocol 1.3 resolution entry: the capability id union gains the parallel module. */
export const CapabilityResolutionEntryV13Schema = strictObject({
  capability_id: enumerated(CAPABILITY_IDS_1_3),
  resolution: enumerated(CAPABILITY_RESOLUTIONS),
  resolution_source: enumerated(CAPABILITY_RESOLUTION_SOURCES),
  module_version: Type.String({ minLength: 1 }),
  module_digest: DigestSchema,
  binding_digest: DigestSchema,
});
export type CapabilityResolutionEntryV13 = Static<typeof CapabilityResolutionEntryV13Schema>;

export const InvalidationEdgeSchema = strictObject({
  binding_kind: enumerated(BINDING_KINDS),
  invalidates: Type.Array(enumerated(CAPABILITY_IDS), { minItems: 1 }),
});
export type InvalidationEdge = Static<typeof InvalidationEdgeSchema>;

/** Protocol 1.3 invalidation edge over the extended binding/capability vocabulary. */
export const InvalidationEdgeV13Schema = strictObject({
  binding_kind: enumerated(BINDING_KINDS_1_3),
  invalidates: Type.Array(enumerated(CAPABILITY_IDS_1_3), { minItems: 1 }),
});
export type InvalidationEdgeV13 = Static<typeof InvalidationEdgeV13Schema>;

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

/**
 * Protocol 1.3 capability plan revision (M4 design 10.2): identical record
 * shape over the extended vocabulary — six resolution entries, the
 * `wave_integration` binding kind and the `parallel_task_execution` execute
 * subgraph. Emitted only when the parallel module actually participates; a
 * 1.3 operation with the module disabled keeps emitting the 1.1 record above.
 */
export const CapabilityPlanRecordV13Schema = recordEnvelopeSchemaFor(
  PROTOCOL_1_3_VERSION,
  "capability_plan",
  {
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
    capabilities: Type.Array(CapabilityResolutionEntryV13Schema, {
      minItems: CAPABILITY_IDS_1_3.length,
    }),
    providers: Type.Array(enumerated(PROVIDER_CAPABILITIES)),
    approval_policy_id: Type.String({ minLength: 1 }),
    approval_objects: Type.Array(enumerated(APPROVAL_OBJECT_KINDS)),
    operation_dag: strictObject({
      nodes: Type.Array(OperationDagNodeV13Schema, { minItems: 1 }),
    }),
    invalidation_graph: Type.Array(InvalidationEdgeV13Schema),
    model_provider_bindings: Type.Array(ModelProviderBindingSchema),
    design_set_digest: Type.Optional(DigestSchema),
    test_strategy_digest: Type.Optional(DigestSchema),
    supersedes_digest: Type.Optional(DigestSchema),
  },
);
export type CapabilityPlanRecordV13 = Static<typeof CapabilityPlanRecordV13Schema>;

/** Reader union over every capability plan revision a current reader accepts. */
export type AnyCapabilityPlanRecord = CapabilityPlanRecord | CapabilityPlanRecordV13;
