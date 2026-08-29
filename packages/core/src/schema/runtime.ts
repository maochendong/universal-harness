import { Type, type Static } from "@sinclair/typebox";

import {
  DigestSchema,
  ExtensionsSchema,
  IdentifierSchema,
  ProtocolVersionSchema,
  TimestampSchema,
  enumerated,
  persistedRecordProperties,
  strictObject,
} from "./common.js";

export const RUN_OUTCOMES = [
  "success",
  "correct_block",
  "clarification_required",
  "handoff",
  "partial",
  "failed",
] as const;

export const TERMINATION_REASONS = [
  "completion",
  "gate_failure",
  "policy_denial",
  "budget_ceiling",
  "repeat_detection",
  "timeout",
  "adapter_failure",
  "user_cancellation",
  "manual_stop",
  "process_interruption",
] as const;

const runRecordBase = {
  protocol_version: ProtocolVersionSchema,
  run_id: IdentifierSchema,
  task_id: IdentifierSchema,
  workflow_operation_id: IdentifierSchema,
  attempt_id: IdentifierSchema,
  sequence: Type.Integer({ minimum: 1 }),
  timestamp: TimestampSchema,
  extensions: Type.Optional(ExtensionsSchema),
};

export const RunStartedSchema = strictObject({
  ...runRecordBase,
  record_kind: Type.Literal("run_started"),
  context_bundle_id: IdentifierSchema,
});

export const RunProgressSchema = strictObject({
  ...runRecordBase,
  record_kind: Type.Literal("run_progress"),
  step: Type.Integer({ minimum: 0 }),
  message: Type.String({ minLength: 1, maxLength: 2000 }),
  evidence_id: Type.Optional(IdentifierSchema),
});

export const RunTerminatedSchema = strictObject({
  ...runRecordBase,
  record_kind: Type.Literal("run_terminated"),
  outcome: enumerated(RUN_OUTCOMES),
  termination_reason: enumerated(TERMINATION_REASONS),
});

export const RunInterruptedSchema = strictObject({
  ...runRecordBase,
  record_kind: Type.Literal("run_interrupted"),
  outcome: enumerated(["partial", "failed", "handoff"] as const),
  termination_reason: Type.Literal("process_interruption"),
  partial_evidence_ids: Type.Array(IdentifierSchema, { uniqueItems: true }),
});

export const ContextBundleRecordSchema = strictObject({
  ...persistedRecordProperties("context_bundle"),
  context_bundle_id: IdentifierSchema,
  task_id: IdentifierSchema,
  source_digests: Type.Array(DigestSchema, { minItems: 1, uniqueItems: true }),
  digest: DigestSchema,
  stale: Type.Boolean(),
  extensions: Type.Optional(ExtensionsSchema),
});

const GitCommitSchema = Type.String({ pattern: "^[0-9a-f]{7,40}$" });
const DigestSetSchema = Type.Array(DigestSchema, { minItems: 1, uniqueItems: true });
const StringSetSchema = Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true });

export const ExecutionAuthorizationRecordSchema = strictObject({
  ...persistedRecordProperties("execution_authorization"),
  authorization_id: IdentifierSchema,
  iteration_id: IdentifierSchema,
  plan_digest: DigestSchema,
  task_digests: DigestSetSchema,
  impact_set_digest: DigestSchema,
  impact_coverage_digest: DigestSchema,
  context_bundle_digests: DigestSetSchema,
  grant_spec_digests: DigestSetSchema,
  policy_digest: DigestSchema,
  adapter_profile_digest: Type.Optional(DigestSchema),
  /** Bound only when design_governance is active for the operation (T14). */
  design_set_digest: Type.Optional(DigestSchema),
  baseline_commit: GitCommitSchema,
  effective_risk: enumerated(["low", "medium", "high", "critical"] as const),
  approval_digest: DigestSchema,
  digest: DigestSchema,
  extensions: Type.Optional(ExtensionsSchema),
});

const GrantedToolSchema = strictObject({
  name: Type.String({ minLength: 1 }),
  parameter_bounds: Type.Optional(
    Type.Record(
      Type.String({ minLength: 1 }),
      Type.Array(Type.Union([Type.String(), Type.Number(), Type.Boolean()]), { uniqueItems: true }),
    ),
  ),
});

const CapabilityGrantSpecSchema = strictObject({
  grant_id: IdentifierSchema,
  task_id: IdentifierSchema,
  issued_by: Type.Literal("harness"),
  capabilities: StringSetSchema,
  read_paths: StringSetSchema,
  write_paths: StringSetSchema,
  state_fields: StringSetSchema,
  tools: Type.Array(GrantedToolSchema),
  phase: Type.String({ minLength: 1 }),
  budget: strictObject({
    steps: Type.Integer({ minimum: 0 }),
    tokens: Type.Integer({ minimum: 0 }),
  }),
  approval_digests: Type.Array(DigestSchema, { uniqueItems: true }),
  effective_policy_digest: DigestSchema,
  plan_digest: DigestSchema,
  context_bundle_digest: DigestSchema,
  adapter_profile_digest: Type.Optional(DigestSchema),
  baseline_commit: GitCommitSchema,
  spec_digest: DigestSchema,
});

export const CapabilityGrantRecordSchema = strictObject({
  ...persistedRecordProperties("capability_grant"),
  grant_record_id: IdentifierSchema,
  iteration_id: IdentifierSchema,
  spec: CapabilityGrantSpecSchema,
  authorization_digest: DigestSchema,
  issued_at: TimestampSchema,
  digest: DigestSchema,
  extensions: Type.Optional(ExtensionsSchema),
});

const AssertionVerdictSchema = strictObject({
  assertion_id: IdentifierSchema,
  passed: Type.Boolean(),
  test_ids: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
  evidence_ids: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
});

export const TaskVerdictRecordSchema = strictObject({
  ...persistedRecordProperties("task_verdict"),
  verdict_id: IdentifierSchema,
  iteration_id: IdentifierSchema,
  task_id: IdentifierSchema,
  run_ids: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
  verdict: enumerated(["passed", "failed", "blocked"] as const),
  assertion_verdicts: Type.Array(AssertionVerdictSchema, { minItems: 1 }),
  gate_evidence_ids: Type.Array(IdentifierSchema, { uniqueItems: true }),
  evaluation_evidence_ids: Type.Array(IdentifierSchema, { uniqueItems: true }),
  created_at: TimestampSchema,
  digest: DigestSchema,
  extensions: Type.Optional(ExtensionsSchema),
});

export const CheckpointRecordSchema = strictObject({
  ...persistedRecordProperties("checkpoint"),
  checkpoint_id: IdentifierSchema,
  workflow_operation_id: IdentifierSchema,
  attempt_id: IdentifierSchema,
  phase: Type.String({ minLength: 1 }),
  state_digest: DigestSchema,
  timestamp: TimestampSchema,
  extensions: Type.Optional(ExtensionsSchema),
});

export const EvidenceRecordSchema = strictObject({
  ...persistedRecordProperties("evidence"),
  evidence_id: IdentifierSchema,
  evidence_type: Type.String({ minLength: 1 }),
  subject_id: IdentifierSchema,
  digest: DigestSchema,
  provisional: Type.Boolean(),
  created_at: TimestampSchema,
  extensions: Type.Optional(ExtensionsSchema),
});

export const APPROVAL_DECISIONS = ["approve", "reject", "defer"] as const;

/**
 * Protocol 1.2 adds two optional first-class requester principal fields for
 * remote approval (design §9.3). Both are present or absent together;
 * requests without them keep the existing local `proposed_by` semantics and
 * can never be remotely approved.
 */
export const ApprovalRequestRecordSchema = Type.Object(
  {
    ...persistedRecordProperties("approval_request"),
    request_id: IdentifierSchema,
    workflow_operation_id: IdentifierSchema,
    object_id: IdentifierSchema,
    object_type: Type.String({ minLength: 1 }),
    object_digest: DigestSchema,
    baseline_digest: DigestSchema,
    policy_digest: DigestSchema,
    preview_digest: DigestSchema,
    impact_path: Type.Array(IdentifierSchema),
    risk: enumerated(["low", "medium", "high", "critical"] as const),
    reason: Type.String({ minLength: 1 }),
    allowed_decisions: Type.Array(enumerated(APPROVAL_DECISIONS), {
      minItems: 1,
      uniqueItems: true,
    }),
    created_at: TimestampSchema,
    resume_phase: Type.String({ minLength: 1 }),
    requester_principal_id: Type.Optional(IdentifierSchema),
    requester_principal_snapshot_digest: Type.Optional(DigestSchema),
    extensions: Type.Optional(ExtensionsSchema),
  },
  {
    additionalProperties: false,
    allOf: [
      {
        if: {
          properties: { requester_principal_id: {} },
          required: ["requester_principal_id"],
        },
        then: {
          properties: { requester_principal_snapshot_digest: {} },
          required: ["requester_principal_snapshot_digest"],
        },
        else: {
          not: {
            properties: { requester_principal_snapshot_digest: {} },
            required: ["requester_principal_snapshot_digest"],
          },
        },
      },
    ],
  },
);

export const ApprovalDecisionRecordSchema = strictObject({
  ...persistedRecordProperties("approval_decision"),
  approval_id: IdentifierSchema,
  request_id: IdentifierSchema,
  actor: Type.String({ minLength: 1 }),
  decision: enumerated(APPROVAL_DECISIONS),
  object_digest: DigestSchema,
  decided_at: TimestampSchema,
  extensions: Type.Optional(ExtensionsSchema),
});

export const RuntimeSchema = Type.Union([
  RunStartedSchema,
  RunProgressSchema,
  RunTerminatedSchema,
  RunInterruptedSchema,
  ContextBundleRecordSchema,
  ExecutionAuthorizationRecordSchema,
  CapabilityGrantRecordSchema,
  TaskVerdictRecordSchema,
  CheckpointRecordSchema,
  EvidenceRecordSchema,
  ApprovalRequestRecordSchema,
  ApprovalDecisionRecordSchema,
]);

export type RunRecord = Static<
  | typeof RunStartedSchema
  | typeof RunProgressSchema
  | typeof RunTerminatedSchema
  | typeof RunInterruptedSchema
>;
