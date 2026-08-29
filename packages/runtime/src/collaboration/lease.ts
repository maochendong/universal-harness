import {
  buildCollaborationRecord,
  contentDigest,
  type ControlRecord,
  type LeaseRecord,
} from "@universal-harness-internal/core";

import { collaborationFailure, type CollaborationFailure } from "./errors.js";
import type { AcquireLeaseCommand, ReleaseLeaseCommand, RenewLeaseCommand } from "./port.js";

/**
 * Pure Lease/fencing state machine (spec §11.1). Given the complete
 * per-resource Lease chain read from the Control Ref, it decides the next
 * authoritative fact for one command. It performs no I/O: the Coordinator
 * seals drafts into records and only `appendControl` makes them authoritative.
 *
 * Rules:
 * - the fencing token is strictly increasing per resource; only a grant opens
 *   a new epoch (`max(history) + 1`), while renew/release/expiry records keep
 *   the token of the epoch they close;
 * - every state change is a new `lease_record_id` linked by
 *   `previous_lease_record_digest` — records are never rewritten;
 * - a repeated `command_id` replays the record it already produced;
 * - a lease whose `expires_at <= now` is never revived: renewal is answered
 *   `lease_expired`, and the next state change first records the expiry;
 * - requests naming a superseded or unknown lease are permanently rejected
 *   with `lease_fenced`.
 */

export const OPERATION_LEASE_DURATION_MS = 5 * 60 * 1000;

export type LeaseCommand = AcquireLeaseCommand | RenewLeaseCommand | ReleaseLeaseCommand;

/** Fields of the next LeaseRecord that the command itself determines. */
export interface LeaseDraft {
  readonly lease_record_id: string;
  readonly lease_id: string;
  readonly previous_lease_record_digest?: string;
  readonly resource_kind: "operation" | "integration";
  readonly resource_id: string;
  readonly fencing_token: number;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly state: "granted" | "renewed" | "released" | "expired" | "revoked";
  readonly command_id: string;
}

export type LeaseTransition =
  | { readonly kind: "existing"; readonly record: LeaseRecord; readonly replayed: boolean }
  | { readonly kind: "draft"; readonly draft: LeaseDraft }
  | { readonly kind: "rejected"; readonly failure: CollaborationFailure };

function isLive(record: LeaseRecord, now: string): boolean {
  return (record.state === "granted" || record.state === "renewed") && record.expires_at > now;
}

/** Granted/renewed on the chain but past its wall-clock expiry. */
function isExpiredUnrecorded(record: LeaseRecord, now: string): boolean {
  return (record.state === "granted" || record.state === "renewed") && record.expires_at <= now;
}

function leaseRecordIdFor(leaseId: string, state: LeaseDraft["state"], commandId: string): string {
  return `lease-record_${contentDigest({ leaseId, state, commandId }).slice(0, 24)}`;
}

function leaseIdFor(
  resourceKind: LeaseDraft["resource_kind"],
  resourceId: string,
  fencingToken: number,
): string {
  return `lease_${contentDigest({ resourceKind, resourceId, fencingToken }).slice(0, 24)}`;
}

function draftRecord(draft: Omit<LeaseDraft, "lease_record_id">): LeaseDraft {
  return {
    ...draft,
    lease_record_id: leaseRecordIdFor(draft.lease_id, draft.state, draft.command_id),
  };
}

/** The record closing a lapsed lease; its command id is derived, never the command's own. */
function expiryDraft(tip: LeaseRecord, commandId: string, now: string): LeaseDraft {
  return draftRecord({
    lease_id: tip.lease_id,
    previous_lease_record_digest: tip.record_digest,
    resource_kind: tip.resource_kind,
    resource_id: tip.resource_id,
    fencing_token: tip.fencing_token,
    issued_at: now,
    expires_at: tip.expires_at,
    state: "expired",
    command_id: `${commandId}-expiry`,
  });
}

function fenced(summary: string): LeaseTransition {
  return { kind: "rejected", failure: collaborationFailure("lease_fenced", summary) };
}

/**
 * Seal a lease draft into the Control Ref chain record. The draft carries the
 * per-resource semantics; the envelope chains it onto the ref tail and binds
 * the holder snapshot plus the caller's client instance.
 */
export function sealLeaseRecord(
  draft: LeaseDraft,
  chain: readonly ControlRecord[],
  holderDigest: string,
  clientInstanceId: string,
): LeaseRecord {
  const previous = chain[chain.length - 1];
  return buildCollaborationRecord({
    record_kind: "lease" as const,
    control_sequence: chain.length + 1,
    ...(previous === undefined ? {} : { previous_control_record_digest: previous.record_digest }),
    ...draft,
    holder_principal_snapshot_digest: holderDigest,
    client_instance_id: clientInstanceId,
  });
}

/**
 * The record revoking a still-live lease at Coordinator startup (spec §10.1).
 * The fencing token of the revoked epoch is permanently retired: the revoked
 * tip closes the chain, and the next acquire opens a new epoch. The command id
 * is derived from the revoked tip, so a repeated resume replays instead of
 * appending duplicates.
 */
export function leaseRevocationDraft(tip: LeaseRecord, now: string): LeaseDraft {
  return draftRecord({
    lease_id: tip.lease_id,
    previous_lease_record_digest: tip.record_digest,
    resource_kind: "operation",
    resource_id: tip.resource_id,
    fencing_token: tip.fencing_token,
    issued_at: now,
    expires_at: tip.expires_at,
    state: "revoked",
    command_id: `command_resume-${contentDigest({ leaseId: tip.lease_id, tipDigest: tip.record_digest }).slice(0, 16)}`,
  });
}

/**
 * Acquire-side transition shared by the operation lease commands and the
 * internal Integration Lease (spec §11.1, design §14.1 step 1): replay by
 * command id, reject while a live lease holds the resource, record the expiry
 * of a lapsed tip first, then grant a new epoch with `max(token) + 1`.
 */
export function transitionAcquireLease(
  history: readonly LeaseRecord[],
  input: {
    readonly resource_kind: LeaseDraft["resource_kind"];
    readonly resource_id: string;
    readonly command_id: string;
  },
  now: string,
  durationMs = OPERATION_LEASE_DURATION_MS,
): LeaseTransition {
  // Idempotency: a repeated command id returns the record it produced,
  // wherever that record sits in the chain.
  const replay = history.find((record) => record.command_id === input.command_id);
  if (replay !== undefined) return { kind: "existing", record: replay, replayed: true };

  const tip = history[history.length - 1];
  if (tip !== undefined && isLive(tip, now)) {
    return {
      kind: "rejected",
      failure: collaborationFailure(
        "lease_unavailable",
        `resource ${tip.resource_id} already has a live lease; wait for expiry or release`,
        true,
      ),
    };
  }
  if (tip !== undefined && isExpiredUnrecorded(tip, now)) {
    return { kind: "draft", draft: expiryDraft(tip, input.command_id, now) };
  }
  const fencingToken = (tip?.fencing_token ?? 0) + 1;
  return {
    kind: "draft",
    draft: draftRecord({
      lease_id: leaseIdFor(input.resource_kind, input.resource_id, fencingToken),
      ...(tip === undefined ? {} : { previous_lease_record_digest: tip.record_digest }),
      resource_kind: input.resource_kind,
      resource_id: input.resource_id,
      fencing_token: fencingToken,
      issued_at: now,
      expires_at: new Date(Date.parse(now) + durationMs).toISOString(),
      state: "granted",
      command_id: input.command_id,
    }),
  };
}

export function transitionLease(
  history: readonly LeaseRecord[],
  command: LeaseCommand,
  now: string,
  durationMs = OPERATION_LEASE_DURATION_MS,
): LeaseTransition {
  if (command.kind === "acquire_operation_lease") {
    return transitionAcquireLease(
      history,
      {
        resource_kind: "operation",
        resource_id: command.operation_id,
        command_id: command.command_id,
      },
      now,
      durationMs,
    );
  }

  // Idempotency: a repeated command id returns the record it produced,
  // wherever that record sits in the chain.
  const replay = history.find((record) => record.command_id === command.command_id);
  if (replay !== undefined) return { kind: "existing", record: replay, replayed: true };

  const tip = history[history.length - 1];

  // renew/release address a lease by id; resolve its position in the chain.
  const leaseHistory = history.filter((record) => record.lease_id === command.lease_id);
  const leaseTip = leaseHistory[leaseHistory.length - 1];
  if (leaseTip === undefined) {
    return fenced(`lease ${command.lease_id} is unknown to this resource`);
  }
  if (leaseTip !== tip) {
    return fenced(
      `lease ${command.lease_id} no longer holds the resource; a newer lease is current`,
    );
  }
  if (leaseTip.state === "released" || leaseTip.state === "revoked") {
    if (command.kind === "release_operation_lease") {
      // No state change: closing an already closed lease appends nothing.
      return { kind: "existing", record: leaseTip, replayed: false };
    }
    return fenced(`lease ${command.lease_id} is already ${leaseTip.state}`);
  }

  if (command.kind === "renew_operation_lease") {
    if (leaseTip.state === "expired" || isExpiredUnrecorded(leaseTip, now)) {
      return {
        kind: "rejected",
        failure: collaborationFailure(
          "lease_expired",
          `lease ${command.lease_id} expired at ${leaseTip.expires_at}; re-acquire it`,
          true,
        ),
      };
    }
    const extended = new Date(Date.parse(now) + durationMs).toISOString();
    if (extended <= leaseTip.expires_at) {
      // Only an actual extension appends a record (spec §10).
      return { kind: "existing", record: leaseTip, replayed: false };
    }
    return {
      kind: "draft",
      draft: draftRecord({
        lease_id: leaseTip.lease_id,
        previous_lease_record_digest: leaseTip.record_digest,
        resource_kind: leaseTip.resource_kind,
        resource_id: leaseTip.resource_id,
        fencing_token: leaseTip.fencing_token,
        issued_at: now,
        expires_at: extended,
        state: "renewed",
        command_id: command.command_id,
      }),
    };
  }

  // release_operation_lease
  if (leaseTip.state === "expired") return { kind: "existing", record: leaseTip, replayed: false };
  if (isExpiredUnrecorded(leaseTip, now)) {
    return { kind: "draft", draft: expiryDraft(leaseTip, command.command_id, now) };
  }
  return {
    kind: "draft",
    draft: draftRecord({
      lease_id: leaseTip.lease_id,
      previous_lease_record_digest: leaseTip.record_digest,
      resource_kind: leaseTip.resource_kind,
      resource_id: leaseTip.resource_id,
      fencing_token: leaseTip.fencing_token,
      issued_at: now,
      expires_at: leaseTip.expires_at,
      state: "released",
      command_id: command.command_id,
    }),
  };
}
