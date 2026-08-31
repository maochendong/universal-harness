import { Type, type Static } from "@sinclair/typebox";

import { PROTOCOL_1_3_VERSION } from "../protocol.js";
import {
  DigestSchema,
  IdentifierSchema,
  TimestampSchema,
  enumerated,
  strictObject,
} from "./common.js";
import { recordEnvelopeSchemaFor } from "./envelope.js";

/**
 * Protocol 1.3 scheduling records (M4 local multi-agent scheduling design
 * §8.2/§14). M4 adds exactly two authoritative record kinds: TaskLeaseRecord
 * and WaveIntegrationRecord. There is deliberately no TaskState,
 * SchedulerState, ParallelGroup or DriverLock record — those stay derived
 * projections. Every record is a sealed record envelope pinned to protocol
 * 1.3.0 and carries a `command_id` for idempotent replay identity.
 */
export const TASK_LEASE_STATES = ["granted", "released", "expired", "revoked"] as const;
export type TaskLeaseState = (typeof TASK_LEASE_STATES)[number];

export const TASK_RETRY_KINDS = ["executor_retry", "integration_retry"] as const;
export type TaskRetryKind = (typeof TASK_RETRY_KINDS)[number];

export const TaskLeaseStateSchema = enumerated(TASK_LEASE_STATES);
export const TaskRetryKindSchema = enumerated(TASK_RETRY_KINDS);

// Same SHA-1 commit shape as schema/collaboration.ts: 7-40 lowercase hex,
// never the looser 64-char digest length.
const GitCommitSchema = Type.String({ pattern: "^[0-9a-f]{7,40}$" });

const LeaseBudgetSchema = strictObject({
  steps: Type.Integer({ minimum: 0 }),
  tokens: Type.Integer({ minimum: 0 }),
});

export const TaskLeaseRecordSchema = recordEnvelopeSchemaFor(PROTOCOL_1_3_VERSION, "task_lease", {
  operation_id: IdentifierSchema,
  iteration_id: IdentifierSchema,
  plan_digest: DigestSchema,
  task_id: IdentifierSchema,
  task_digest: DigestSchema,
  run_id: IdentifierSchema,
  slot_id: IdentifierSchema,
  baseline_commit: GitCommitSchema,
  agent_adapter_digest: DigestSchema,
  policy_digest: DigestSchema,
  approval_digests: Type.Array(DigestSchema, { uniqueItems: true }),
  /** Per-transition record identity; a new value on every state migration. */
  task_lease_record_id: IdentifierSchema,
  /** Resource lease identity, stable across the whole state chain. */
  lease_id: IdentifierSchema,
  /** Links the exact prior record_digest of the same lease_id chain. */
  previous_lease_record_digest: Type.Optional(DigestSchema),
  fencing_token: Type.Integer({ minimum: 1 }),
  state: TaskLeaseStateSchema,
  attempt_number: Type.Integer({ minimum: 1 }),
  retry_kind: Type.Optional(TaskRetryKindSchema),
  reserved_budget: LeaseBudgetSchema,
  consumed_budget: LeaseBudgetSchema,
  issued_at: TimestampSchema,
  expires_at: TimestampSchema,
  /** Command idempotence identity; never interchangeable with lease_id. */
  command_id: IdentifierSchema,
});
export type TaskLeaseRecord = Static<typeof TaskLeaseRecordSchema>;

export const WaveIntegrationRecordSchema = recordEnvelopeSchemaFor(
  PROTOCOL_1_3_VERSION,
  "wave_integration",
  {
    wave_integration_id: IdentifierSchema,
    operation_id: IdentifierSchema,
    iteration_id: IdentifierSchema,
    plan_digest: DigestSchema,
    wave_index: Type.Integer({ minimum: 0 }),
    /** Plan-ordered task ids of the wave; order is part of the record. */
    task_ids: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
    base_commit: GitCommitSchema,
    candidate_commit: GitCommitSchema,
    /**
     * Digest of the accepted project source tree only — never of the Ledger
     * content carrying this record, so the record never references a commit
     * that contains itself.
     */
    accepted_source_tree_digest: DigestSchema,
    task_lease_digests: Type.Array(DigestSchema, { uniqueItems: true }),
    task_evidence_digests: Type.Array(DigestSchema, { uniqueItems: true }),
    candidate_gate_evidence_digests: Type.Array(DigestSchema, { uniqueItems: true }),
    wave_gate_evidence_digests: Type.Array(DigestSchema, { uniqueItems: true }),
    policy_digest: DigestSchema,
    approval_digests: Type.Array(DigestSchema, { uniqueItems: true }),
    command_id: IdentifierSchema,
    integrated_at: TimestampSchema,
  },
);
export type WaveIntegrationRecord = Static<typeof WaveIntegrationRecordSchema>;

/** The only two authoritative scheduling record kinds M4 introduces. */
export type SchedulingRecord = TaskLeaseRecord | WaveIntegrationRecord;
