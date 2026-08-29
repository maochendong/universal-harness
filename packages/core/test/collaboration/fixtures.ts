import { contentDigest } from "../../src/identity/digest.js";

/**
 * Shared drafts for the five Protocol 1.2 authoritative records. Digests are
 * deterministic stand-ins; the record envelope digest is always (re)computed
 * by the builder under test, never supplied by a fixture.
 */
export const FIXED_NOW = "2026-08-29T00:00:00.000Z";
export const FIXED_LATER = "2026-08-29T00:05:00.000Z";

export const digestOf = (seed: string): string => contentDigest({ seed });

export function collaborationConnectionDraft() {
  return {
    record_kind: "collaboration_connection" as const,
    connection_id: "connection_01",
    project_id: "project_demo",
    revision: 1,
    status: "active" as const,
    provider: "github" as const,
    repository_id: "acme/demo",
    canonical_remote: "https://github.com/acme/demo.git",
    canonical_remote_digest: digestOf("canonical-remote"),
    coordinator_origin: "https://harness.example.com",
    target_ref: "refs/heads/main",
    control_ref: "refs/heads/harness/control",
    policy_digest: digestOf("policy"),
    actor_principal_id: "principal_alice",
    principal_snapshot_digest: digestOf("snapshot"),
    command_id: "command_connect_1",
    effective_at: FIXED_NOW,
  };
}

export function principalSnapshotDraft() {
  return {
    record_kind: "principal_snapshot" as const,
    control_sequence: 1,
    snapshot_id: "snapshot_01",
    principal_id: "principal_alice",
    provider: "github" as const,
    host: "github.com",
    subject_id: "1234567",
    repository_id: "acme/demo",
    permission: "maintain" as const,
    observed_at: FIXED_NOW,
    expires_at: FIXED_LATER,
    source_response_digest: digestOf("source-response"),
  };
}

export function leaseDraft(previousControlRecordDigest: string) {
  return {
    record_kind: "lease" as const,
    control_sequence: 2,
    previous_control_record_digest: previousControlRecordDigest,
    lease_record_id: "lease-record_01",
    lease_id: "lease_01",
    resource_kind: "operation" as const,
    resource_id: "operation_01",
    holder_principal_snapshot_digest: digestOf("snapshot"),
    client_instance_id: "instance_01",
    fencing_token: 1,
    issued_at: FIXED_NOW,
    expires_at: FIXED_LATER,
    state: "granted" as const,
    command_id: "command_lease_1",
  };
}

export function remoteApprovalDecisionDraft(previousControlRecordDigest: string) {
  return {
    record_kind: "remote_approval_decision" as const,
    control_sequence: 3,
    previous_control_record_digest: previousControlRecordDigest,
    remote_decision_id: "remote-decision_01",
    request_id: "request_01",
    operation_id: "operation_01",
    object_id: "object_01",
    object_digest: digestOf("object"),
    policy_digest: digestOf("policy"),
    decision: "approve" as const,
    principal_snapshot_digest: digestOf("snapshot"),
    required_permission: "maintain" as const,
    decided_at: FIXED_NOW,
    command_id: "command_decide_1",
  };
}

export function integrationDraft() {
  return {
    record_kind: "integration" as const,
    integration_id: "integration_01",
    operation_id: "operation_01",
    expected_target_commit: "0123456789abcdef",
    operation_commit: "fedcba9876543210",
    lease_fencing_token: 2,
    ledger_sequence_rewrites: [
      {
        ledger_operation_id: "ledger-op_01",
        old_sequence: 3,
        old_manifest_digest: digestOf("old-manifest"),
        new_sequence: 5,
        new_manifest_digest: digestOf("new-manifest"),
      },
    ],
    evidence_digests: [digestOf("evidence")],
    approval_decision_digests: [digestOf("approval-decision")],
    command_id: "command_integrate_1",
  };
}
