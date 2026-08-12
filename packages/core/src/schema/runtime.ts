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

export const ApprovalRequestRecordSchema = strictObject({
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
  extensions: Type.Optional(ExtensionsSchema),
});

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
