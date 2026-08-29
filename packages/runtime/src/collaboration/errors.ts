/**
 * Typed collaboration failures. The code union is exactly the set frozen in
 * spec §16; transport and adapter code must return these codes and never parse
 * exception messages for protocol semantics.
 */
export const COLLABORATION_ERROR_CODES = [
  "coordinator_unavailable",
  "git_remote_unavailable",
  "unsupported_remote",
  "invalid_coordinator_origin",
  "authentication_required",
  "permission_denied",
  "permission_snapshot_stale",
  "approval_binding_mismatch",
  "approval_self_approval",
  "lease_unavailable",
  "lease_expired",
  "lease_fenced",
  "operation_ref_drift",
  "control_ref_invalid",
  "control_ref_unprotected",
  "remote_identity_drift",
  "baseline_drift",
  "integration_conflict",
  "ledger_resequence_failed",
  "integration_gate_failed",
  "target_cas_failed",
  "projection_rebuild_required",
  "protocol_upgrade_required",
] as const;
export type CollaborationErrorCode = (typeof COLLABORATION_ERROR_CODES)[number];

export interface CollaborationFailure {
  readonly code: CollaborationErrorCode;
  readonly summary: string;
  readonly retryable: boolean;
}

export function collaborationFailure(
  code: CollaborationErrorCode,
  summary: string,
  retryable = false,
): CollaborationFailure {
  return { code, summary, retryable };
}
