import type { REMOTE_REQUIRED_PERMISSIONS } from "@universal-harness-internal/core";

/**
 * Approval-permission Policy resolution point (design §9.1). The default rule
 * is that only `maintain` or `admin` may take a terminal remote decision or
 * run an Integration; a Project Policy approved by `maintain`/`admin` may
 * lower the bar to `write` for an explicitly named object scope, and the
 * resulting decision binds that Policy's digest.
 *
 * M3 has no Policy-document seam: the committed ApprovalRequest and the
 * connection only carry the opaque `policy_digest`. This pure function is
 * therefore the single point where a future Policy view plugs in; with no
 * Policy view it fails closed to `maintain`. No I/O lives here.
 */

export type RemoteRequiredPermission = (typeof REMOTE_REQUIRED_PERMISSIONS)[number];

/** Fail-closed default required permission (design §9.1). */
export const DEFAULT_REMOTE_REQUIRED_PERMISSION: RemoteRequiredPermission = "maintain";

/**
 * One maintain/admin-approved downgrade rule. Design §9.1 only ever lowers
 * the requirement, and only to `write`, for an explicit object scope.
 */
export interface ApprovalPermissionPolicyRule {
  readonly object_id: string;
  readonly permission: "write";
}

/**
 * The approval-permission view of a governing Policy. The digest is the
 * identity the Decision and Integration records bind.
 */
export interface ApprovalPermissionPolicy {
  readonly policy_digest: string;
  readonly downgrades?: readonly ApprovalPermissionPolicyRule[];
}

/**
 * Resolve the required permission for one object scope under the current
 * approval Policy. Absent a Policy view, or absent a rule naming exactly this
 * object, the result is the fail-closed `maintain` default.
 */
export function resolveRequiredPermission(
  policy: ApprovalPermissionPolicy | undefined,
  objectId: string,
): RemoteRequiredPermission {
  const rule = policy?.downgrades?.find((downgrade) => downgrade.object_id === objectId);
  return rule === undefined ? DEFAULT_REMOTE_REQUIRED_PERMISSION : rule.permission;
}
