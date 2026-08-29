import { contentDigest, type LeaseRecord } from "@universal-harness-internal/core";

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
  readonly resource_kind: "operation";
  readonly resource_id: string;
  readonly fencing_token: number;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly state: "granted" | "renewed" | "released" | "expired";
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

function leaseIdFor(resourceId: string, fencingToken: number): string {
  return `lease_${contentDigest({ resourceKind: "operation", resourceId, fencingToken }).slice(0, 24)}`;
}

function draftRecord(draft: Omit<LeaseDraft, "lease_record_id">): LeaseDraft {
  return {
    ...draft,
    lease_record_id: leaseRecordIdFor(draft.lease_id, draft.state, draft.command_id),
  };
}

/** The record closing a lapsed lease; its command id is derived, never the command's own. */
function expiryDraft(tip: LeaseRecord, command: LeaseCommand, now: string): LeaseDraft {
  return draftRecord({
    lease_id: tip.lease_id,
    previous_lease_record_digest: tip.record_digest,
    resource_kind: "operation",
    resource_id: tip.resource_id,
    fencing_token: tip.fencing_token,
    issued_at: now,
    expires_at: tip.expires_at,
    state: "expired",
    command_id: `${command.command_id}-expiry`,
  });
}

function fenced(summary: string): LeaseTransition {
  return { kind: "rejected", failure: collaborationFailure("lease_fenced", summary) };
}

export function transitionLease(
  history: readonly LeaseRecord[],
  command: LeaseCommand,
  now: string,
  durationMs = OPERATION_LEASE_DURATION_MS,
): LeaseTransition {
  // Idempotency: a repeated command id returns the record it produced,
  // wherever that record sits in the chain.
  const replay = history.find((record) => record.command_id === command.command_id);
  if (replay !== undefined) return { kind: "existing", record: replay, replayed: true };

  const tip = history[history.length - 1];

  if (command.kind === "acquire_operation_lease") {
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
      return { kind: "draft", draft: expiryDraft(tip, command, now) };
    }
    const fencingToken = (tip?.fencing_token ?? 0) + 1;
    return {
      kind: "draft",
      draft: draftRecord({
        lease_id: leaseIdFor(command.operation_id, fencingToken),
        ...(tip === undefined ? {} : { previous_lease_record_digest: tip.record_digest }),
        resource_kind: "operation",
        resource_id: command.operation_id,
        fencing_token: fencingToken,
        issued_at: now,
        expires_at: new Date(Date.parse(now) + durationMs).toISOString(),
        state: "granted",
        command_id: command.command_id,
      }),
    };
  }

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
        resource_kind: "operation",
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
    return { kind: "draft", draft: expiryDraft(leaseTip, command, now) };
  }
  return {
    kind: "draft",
    draft: draftRecord({
      lease_id: leaseTip.lease_id,
      previous_lease_record_digest: leaseTip.record_digest,
      resource_kind: "operation",
      resource_id: leaseTip.resource_id,
      fencing_token: leaseTip.fencing_token,
      issued_at: now,
      expires_at: leaseTip.expires_at,
      state: "released",
      command_id: command.command_id,
    }),
  };
}
