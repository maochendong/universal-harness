import type {
  CollaborationPermission,
  PrincipalSnapshotRecord,
  RemoteApprovalDecisionRecord,
} from "@universal-harness-internal/core";
import { contentDigest } from "@universal-harness-internal/core";

import {
  ApprovalError,
  type ApprovalDecisionRecord,
  type ApprovalRequestRecord,
} from "../approval/request.js";
import type { ApprovalService } from "../approval/service.js";
import { collaborationFailure, type CollaborationFailure } from "./errors.js";
import type { GitControlStorePort } from "./port.js";
import { COLLABORATION_CONTROL_REF } from "./connection.js";

/**
 * Remote approval validation and materialization (design §13, §13.1). The
 * Coordinator validates a RemoteApprovalDecision draft against the committed
 * ApprovalRequest and the approver's PrincipalSnapshot before the Control Ref
 * CAS; the Local Kernel re-validates the committed decision and request after
 * sync and only then materializes the existing ApprovalDecision through the
 * existing ApprovalService.
 *
 * The snapshot only has to be valid at `decided_at`: a legally written
 * decision is immutable evidence that the principal held the permission when
 * deciding, and a later snapshot expiry never invalidates it on its own
 * (design §9.2, §15.2). Domain binding or requester identity drift makes the
 * decision stale and requires re-issuing the request.
 */

/** The snapshot facts validation needs; both the record and the OAuth facts qualify. */
export interface RemoteApprovalSnapshot {
  readonly principal_id: string;
  readonly permission: CollaborationPermission;
  readonly observed_at: string;
  readonly expires_at: string;
}

/** Fields of a RemoteApprovalDecision the deciding command determines. */
export interface RemoteApprovalDecisionDraft {
  readonly request_id: string;
  readonly operation_id: string;
  readonly object_id: string;
  readonly object_digest: string;
  readonly policy_digest: string;
  readonly decision: "approve" | "reject" | "defer";
  readonly required_permission: "write" | "maintain" | "admin";
  readonly decided_at: string;
}

export type RemoteApprovalValidation =
  | { readonly status: "valid" }
  | { readonly status: "blocked"; readonly failure: CollaborationFailure };

const PERMISSION_RANK: Record<CollaborationPermission, number> = {
  read: 0,
  write: 1,
  maintain: 2,
  admin: 3,
};

function blocked(
  code: CollaborationFailure["code"],
  summary: string,
  retryable = false,
): RemoteApprovalValidation {
  return { status: "blocked", failure: collaborationFailure(code, summary, retryable) };
}

/**
 * Validate one RemoteApprovalDecision draft against the committed request and
 * the approver's snapshot (design §13.1 checklist): first-class requester
 * Principal binding, self-approval prohibition, snapshot valid at
 * `decided_at`, exact request/operation/object/policy binding and the
 * required permission rank. `now` is part of the input contract for symmetry
 * with the deciding command; validity is judged at `decided_at`, never at
 * the wall clock.
 */
export function validateRemoteApprovalDecision(input: {
  readonly request: ApprovalRequestRecord;
  readonly snapshot: RemoteApprovalSnapshot;
  readonly decision: RemoteApprovalDecisionDraft;
  readonly now: string;
}): RemoteApprovalValidation {
  const { request, snapshot, decision } = input;
  if (request.requester_principal_id === undefined) {
    return blocked(
      "approval_binding_mismatch",
      `approval request ${request.request_id} has no requester principal binding; re-issue it under the current connection before remote approval`,
    );
  }
  if (snapshot.principal_id === request.requester_principal_id) {
    return blocked(
      "approval_self_approval",
      `principal ${snapshot.principal_id} may not approve its own request ${request.request_id}`,
    );
  }
  if (!(snapshot.observed_at <= decision.decided_at && decision.decided_at < snapshot.expires_at)) {
    return blocked(
      "permission_snapshot_stale",
      `principal snapshot was not valid at decided_at ${decision.decided_at}; re-query the platform permission`,
      true,
    );
  }
  const bindings: readonly (readonly [string, string, string])[] = [
    ["request_id", decision.request_id, request.request_id],
    ["operation_id", decision.operation_id, request.workflow_operation_id],
    ["object_id", decision.object_id, request.object_id],
    ["object_digest", decision.object_digest, request.object_digest],
    ["policy_digest", decision.policy_digest, request.policy_digest],
  ];
  for (const [name, decided, bound] of bindings) {
    if (decided !== bound) {
      return blocked(
        "approval_binding_mismatch",
        `remote decision binds ${name} ${decided} but request ${request.request_id} binds ${bound}; re-issue the request against current bindings`,
      );
    }
  }
  if (PERMISSION_RANK[snapshot.permission] < PERMISSION_RANK[decision.required_permission]) {
    return blocked(
      "permission_denied",
      `principal ${snapshot.principal_id} holds ${snapshot.permission} but request ${request.request_id} requires ${decision.required_permission}`,
    );
  }
  return { status: "valid" };
}

/** Deterministic RemoteApprovalDecision identity per deciding command. */
export function remoteDecisionIdFor(commandId: string): string {
  return `remote-decision_${contentDigest({ commandId }).slice(0, 24)}`;
}

/** The first non-defer decision of one request on the chain, if any (first-terminal-wins). */
export function terminalRemoteDecision(
  records: readonly { readonly record_kind: string }[],
  requestId: string,
): RemoteApprovalDecisionRecord | undefined {
  return records.find(
    (record): record is RemoteApprovalDecisionRecord =>
      record.record_kind === "remote_approval_decision" &&
      (record as RemoteApprovalDecisionRecord).request_id === requestId &&
      (record as RemoteApprovalDecisionRecord).decision !== "defer",
  );
}

export interface MaterializeRemoteApprovalInput {
  readonly service: ApprovalService;
  readonly controlStore: GitControlStorePort;
  readonly project_id: string;
  readonly request_id: string;
  /** Protected Control Ref; fixed to `harness/control` by default (spec §10). */
  readonly control_ref?: string;
  /** Locator hint for the Ledger's latest connection; authority stays with Git. */
  readonly target_ref?: string;
}

export type RemoteApprovalMaterialization =
  | {
      readonly status: "materialized";
      readonly decision: ApprovalDecisionRecord;
      readonly remote_decision: RemoteApprovalDecisionRecord;
      readonly replayed: boolean;
    }
  /** No terminal remote decision for the request on the Control Ref yet. */
  | { readonly status: "pending" }
  | { readonly status: "failed"; readonly failure: CollaborationFailure };

function mapApprovalError(error: ApprovalError): CollaborationFailure {
  switch (error.kind) {
    case "approval_self_approval":
      return collaborationFailure("approval_self_approval", error.message);
    case "approval_binding_mismatch":
    case "approval_binding_drift":
    case "approval_request_not_found":
    case "approval_not_pending":
    case "approval_decision_not_allowed":
      // A drifted, missing or already-decided request means the remote
      // decision is stale against current bindings; the request must be
      // re-issued (design §13.1). Drift already re-issued it as a side effect.
      return collaborationFailure("approval_binding_mismatch", error.message);
    default:
      return collaborationFailure("coordinator_unavailable", error.message, true);
  }
}

/**
 * Local Kernel materialization (design §13.1): re-read the committed request
 * and the Control Ref, re-validate the exact bindings plus the snapshot's
 * validity at `decided_at`, then materialize through the existing
 * ApprovalService. The materialized ApprovalDecision binds the remote
 * decision digest in its protocol 1.2 extension; the
 * RemoteApprovalMaterialized event lands in the same atomic ledger commit, so
 * it is emitted only when the decision commit succeeds. A retry after a lost
 * response replays the already-materialized decision.
 */
export async function materializeRemoteApprovalDecision(
  input: MaterializeRemoteApprovalInput,
): Promise<RemoteApprovalMaterialization> {
  // 1. Re-read the authoritative Control Ref.
  const state = await input.controlStore.readControl({
    project_id: input.project_id,
    control_ref: input.control_ref ?? COLLABORATION_CONTROL_REF,
    ...(input.target_ref === undefined ? {} : { target_ref: input.target_ref }),
  });
  if (state.status === "failed") return { status: "failed", failure: state.failure };

  // 2. First-terminal-wins over the authoritative chain.
  const terminal = terminalRemoteDecision(state.snapshot.control_records, input.request_id);
  if (terminal === undefined) return { status: "pending" };

  // 3. The snapshot the decision was made under must be on the chain.
  const snapshot = state.snapshot.control_records.find(
    (record): record is PrincipalSnapshotRecord =>
      record.record_kind === "principal_snapshot" &&
      (record as PrincipalSnapshotRecord).record_digest === terminal.principal_snapshot_digest,
  );
  if (snapshot === undefined) {
    return {
      status: "failed",
      failure: collaborationFailure(
        "control_ref_invalid",
        `remote decision ${terminal.remote_decision_id} references a principal snapshot missing from the control ref`,
      ),
    };
  }

  // 4. Re-read the committed request and re-validate every binding.
  let request: ApprovalRequestRecord;
  try {
    request = input.service.getRequestById(input.request_id);
  } catch (error) {
    if (error instanceof ApprovalError) {
      return { status: "failed", failure: mapApprovalError(error) };
    }
    throw error;
  }
  const validation = validateRemoteApprovalDecision({
    request,
    snapshot,
    decision: terminal,
    now: terminal.decided_at,
  });
  if (validation.status === "blocked") {
    return { status: "failed", failure: validation.failure };
  }

  // 5. Materialize through the existing ApprovalService; it revalidates the
  //    domain bindings once more and re-issues the request on drift.
  try {
    const resolution = await input.service.resolveRemoteDecision({
      requestId: request.request_id,
      decision: terminal.decision,
      objectDigest: terminal.object_digest,
      actor: snapshot.principal_id,
      decidedAt: terminal.decided_at,
      remoteDecisionId: terminal.remote_decision_id,
      remoteDecisionDigest: terminal.record_digest,
    });
    return {
      status: "materialized",
      decision: resolution.decision,
      remote_decision: terminal,
      replayed: resolution.replayed,
    };
  } catch (error) {
    if (error instanceof ApprovalError) {
      return { status: "failed", failure: mapApprovalError(error) };
    }
    throw error;
  }
}
