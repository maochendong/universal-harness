import { Type, type Static } from "@sinclair/typebox";

import { PROTOCOL_1_2_VERSION } from "../protocol.js";
import {
  DigestSchema,
  IdentifierSchema,
  TimestampSchema,
  enumerated,
  strictObject,
} from "./common.js";
import { recordEnvelopeSchemaFor } from "./envelope.js";

/**
 * Protocol 1.2 collaboration records (M3 remote collaboration design). Only
 * five authoritative record kinds exist: the project Ledger holds
 * CollaborationConnectionRecord and IntegrationRecord; the protected Control
 * Ref holds PrincipalSnapshot, LeaseRecord and RemoteApprovalDecision. Every
 * record is a sealed record envelope pinned to protocol 1.2.0; no derived
 * state gets a record of its own.
 */
export const COLLABORATION_PROVIDERS = ["github", "gitlab", "gitee"] as const;
export type CollaborationProvider = (typeof COLLABORATION_PROVIDERS)[number];

export const COLLABORATION_PERMISSIONS = ["read", "write", "maintain", "admin"] as const;
export type CollaborationPermission = (typeof COLLABORATION_PERMISSIONS)[number];

/**
 * Shared Control Ref envelope fields. The three Control Ref records carry
 * these directly — there is no sixth domain record. The first record of the
 * chain has no previous digest; every later record links the exact prior
 * `record_digest` (see `assertControlChain` in collaboration/records.ts).
 */
const ControlRecordFields = {
  control_sequence: Type.Integer({ minimum: 1 }),
  previous_control_record_digest: Type.Optional(DigestSchema),
};

const GitCommitSchema = Type.String({ minLength: 7, maxLength: 64, pattern: "^[a-f0-9]+$" });

export const COLLABORATION_CONNECTION_STATUSES = ["active", "disconnected"] as const;

export const CollaborationConnectionRecordSchema = recordEnvelopeSchemaFor(
  PROTOCOL_1_2_VERSION,
  "collaboration_connection",
  {
    connection_id: IdentifierSchema,
    project_id: IdentifierSchema,
    revision: Type.Integer({ minimum: 1 }),
    status: enumerated(COLLABORATION_CONNECTION_STATUSES),
    provider: enumerated(COLLABORATION_PROVIDERS),
    repository_id: Type.String({ minLength: 1 }),
    canonical_remote: Type.String({ minLength: 1 }),
    canonical_remote_digest: DigestSchema,
    coordinator_origin: Type.String({ minLength: 1 }),
    target_ref: Type.String({ minLength: 1 }),
    control_ref: Type.String({ minLength: 1 }),
    policy_digest: DigestSchema,
    actor_principal_id: IdentifierSchema,
    principal_snapshot_digest: DigestSchema,
    command_id: IdentifierSchema,
    effective_at: TimestampSchema,
    supersedes_digest: Type.Optional(DigestSchema),
  },
);
export type CollaborationConnectionRecord = Static<typeof CollaborationConnectionRecordSchema>;

export const PrincipalSnapshotRecordSchema = recordEnvelopeSchemaFor(
  PROTOCOL_1_2_VERSION,
  "principal_snapshot",
  {
    ...ControlRecordFields,
    snapshot_id: IdentifierSchema,
    principal_id: IdentifierSchema,
    provider: enumerated(COLLABORATION_PROVIDERS),
    host: Type.String({ minLength: 1 }),
    subject_id: Type.String({ minLength: 1 }),
    repository_id: Type.String({ minLength: 1 }),
    permission: enumerated(COLLABORATION_PERMISSIONS),
    observed_at: TimestampSchema,
    expires_at: TimestampSchema,
    source_response_digest: DigestSchema,
  },
);
export type PrincipalSnapshotRecord = Static<typeof PrincipalSnapshotRecordSchema>;

export const LEASE_RESOURCE_KINDS = ["operation", "integration"] as const;
export const LEASE_STATES = ["granted", "renewed", "released", "expired", "revoked"] as const;

export const LeaseRecordSchema = recordEnvelopeSchemaFor(PROTOCOL_1_2_VERSION, "lease", {
  ...ControlRecordFields,
  lease_record_id: IdentifierSchema,
  lease_id: IdentifierSchema,
  /** Per-resource lease chain, independent of the Control Ref chain. */
  previous_lease_record_digest: Type.Optional(DigestSchema),
  resource_kind: enumerated(LEASE_RESOURCE_KINDS),
  resource_id: IdentifierSchema,
  holder_principal_snapshot_digest: DigestSchema,
  client_instance_id: IdentifierSchema,
  fencing_token: Type.Integer({ minimum: 1 }),
  issued_at: TimestampSchema,
  expires_at: TimestampSchema,
  state: enumerated(LEASE_STATES),
  command_id: IdentifierSchema,
});
export type LeaseRecord = Static<typeof LeaseRecordSchema>;

export const REMOTE_APPROVAL_DECISIONS = ["approve", "reject", "defer"] as const;
export const REMOTE_REQUIRED_PERMISSIONS = ["write", "maintain", "admin"] as const;

export const RemoteApprovalDecisionRecordSchema = recordEnvelopeSchemaFor(
  PROTOCOL_1_2_VERSION,
  "remote_approval_decision",
  {
    ...ControlRecordFields,
    remote_decision_id: IdentifierSchema,
    request_id: IdentifierSchema,
    operation_id: IdentifierSchema,
    object_id: IdentifierSchema,
    object_digest: DigestSchema,
    policy_digest: DigestSchema,
    decision: enumerated(REMOTE_APPROVAL_DECISIONS),
    principal_snapshot_digest: DigestSchema,
    required_permission: enumerated(REMOTE_REQUIRED_PERMISSIONS),
    decided_at: TimestampSchema,
    command_id: IdentifierSchema,
  },
);
export type RemoteApprovalDecisionRecord = Static<typeof RemoteApprovalDecisionRecordSchema>;

const LedgerSequenceRewriteSchema = strictObject({
  ledger_operation_id: IdentifierSchema,
  old_sequence: Type.Integer({ minimum: 1 }),
  old_manifest_digest: DigestSchema,
  new_sequence: Type.Integer({ minimum: 1 }),
  new_manifest_digest: DigestSchema,
});

export const IntegrationRecordSchema = recordEnvelopeSchemaFor(
  PROTOCOL_1_2_VERSION,
  "integration",
  {
    integration_id: IdentifierSchema,
    operation_id: IdentifierSchema,
    expected_target_commit: GitCommitSchema,
    operation_commit: GitCommitSchema,
    lease_fencing_token: Type.Integer({ minimum: 1 }),
    ledger_sequence_rewrites: Type.Array(LedgerSequenceRewriteSchema),
    evidence_digests: Type.Array(DigestSchema, { uniqueItems: true }),
    approval_decision_digests: Type.Array(DigestSchema, { uniqueItems: true }),
    command_id: IdentifierSchema,
  },
);
export type IntegrationRecord = Static<typeof IntegrationRecordSchema>;

/** Record kinds persisted on the protected Control Ref (never on the Ledger). */
export const CONTROL_RECORD_KINDS = [
  "principal_snapshot",
  "lease",
  "remote_approval_decision",
] as const;
export type ControlRecordKind = (typeof CONTROL_RECORD_KINDS)[number];

export type ControlRecord = PrincipalSnapshotRecord | LeaseRecord | RemoteApprovalDecisionRecord;

export type CollaborationRecord =
  | CollaborationConnectionRecord
  | PrincipalSnapshotRecord
  | LeaseRecord
  | RemoteApprovalDecisionRecord
  | IntegrationRecord;
