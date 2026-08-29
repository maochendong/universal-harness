import type { ApprovalRequestRecord, ApprovalRequestSpec } from "./request.js";

/**
 * Binding revalidation (design 11.3): before a decision commits, and again
 * on resume, every digest the request bound at creation time is recomputed.
 * Any drift appends an invalidation trail and re-issues a fresh request; a
 * decision made against stale bindings is never reusable.
 */
export interface ApprovalBindingSnapshot {
  readonly objectDigest: string;
  readonly baselineDigest: string;
  readonly policyDigest: string;
  readonly impactPath: readonly string[];
}

/** Names of the binding items whose digest changed, in a stable order. */
export function bindingDrift(
  request: ApprovalRequestRecord,
  current: ApprovalBindingSnapshot,
): readonly string[] {
  const drifted: string[] = [];
  if (current.objectDigest !== request.object_digest) drifted.push("object_digest");
  if (current.baselineDigest !== request.baseline_digest) drifted.push("baseline_digest");
  if (current.policyDigest !== request.policy_digest) drifted.push("policy_digest");
  if (
    current.impactPath.length !== request.impact_path.length ||
    current.impactPath.some((entry, index) => entry !== request.impact_path[index])
  ) {
    drifted.push("impact_path");
  }
  return drifted;
}

/**
 * Spec for the replacement request: same controlled object and actor
 * bindings, current digests, and a `supersedes` link back to the drifted
 * request so the audit trail stays append-only.
 */
export function reissueRequestSpec(
  request: ApprovalRequestRecord,
  current: ApprovalBindingSnapshot,
  spec: { readonly requestId: string; readonly createdAt: string; readonly proposedBy: string },
): ApprovalRequestSpec {
  return {
    requestId: spec.requestId,
    workflowOperationId: request.workflow_operation_id,
    objectId: request.object_id,
    objectType: request.object_type,
    objectDigest: current.objectDigest,
    baselineDigest: current.baselineDigest,
    policyDigest: current.policyDigest,
    impactPath: [...current.impactPath],
    risk: request.risk,
    reason: request.reason,
    allowedDecisions: [...request.allowed_decisions],
    createdAt: spec.createdAt,
    resumePhase: request.resume_phase,
    proposedBy: spec.proposedBy,
    // A remote-bound request stays remote-bound across re-issue (design §9.3):
    // the replacement carries the same first-class requester Principal.
    ...(request.requester_principal_id === undefined ||
    request.requester_principal_snapshot_digest === undefined
      ? {}
      : {
          requesterPrincipal: {
            principal_id: request.requester_principal_id,
            principal_snapshot_digest: request.requester_principal_snapshot_digest,
          },
        }),
    supersedesRequestId: request.request_id,
  };
}
