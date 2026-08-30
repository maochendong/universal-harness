import type {
  CollaborationConnectionRecord,
  ControlRecord,
  LeaseRecord,
} from "@universal-harness-internal/core";
import { contentDigest } from "@universal-harness-internal/core";

import { collaborationFailure, type CollaborationFailure } from "./errors.js";

/**
 * Pure connection-slice helpers: canonical Coordinator origin normalization,
 * deterministic record identity and the semantic equality behind idempotent
 * connect. No I/O lives here; the Coordinator orchestrates the ports.
 */

/** Fixed protected Control Ref branch for every connected project (spec §10). */
export const COLLABORATION_CONTROL_REF = "refs/heads/harness/control";

export type CoordinatorOriginNormalization =
  | { readonly status: "ok"; readonly origin: string }
  | { readonly status: "failed"; readonly failure: CollaborationFailure };

/**
 * A canonical Coordinator origin is HTTPS with no userinfo, query, fragment
 * or path. Anything else fails closed with `invalid_coordinator_origin`.
 */
export function normalizeCoordinatorOrigin(origin: string): CoordinatorOriginNormalization {
  const invalid = (reason: string): CoordinatorOriginNormalization => ({
    status: "failed",
    failure: collaborationFailure(
      "invalid_coordinator_origin",
      `coordinator origin must be a canonical HTTPS origin without userinfo, query or fragment: ${reason}`,
    ),
  });
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return invalid("not a URL");
  }
  if (url.protocol !== "https:") return invalid("protocol must be https");
  if (url.username !== "" || url.password !== "") return invalid("userinfo is not allowed");
  if (url.search !== "") return invalid("query is not allowed");
  if (url.hash !== "") return invalid("fragment is not allowed");
  if (url.pathname !== "/") return invalid("path is not allowed");
  return { status: "ok", origin: url.origin };
}

/** Deterministic connection identity per project and repository (spec §7). */
export function connectionIdFor(project_id: string, repository_id: string): string {
  return `connection_${contentDigest({ project_id, repository_id }).slice(0, 24)}`;
}

/** Deterministic PrincipalSnapshot identity per principal, repository and observation. */
export function snapshotIdFor(
  principal_id: string,
  repository_id: string,
  observed_at: string,
): string {
  return `snapshot_${contentDigest({ principal_id, repository_id, observed_at }).slice(0, 24)}`;
}

export interface ConnectionSemantics {
  readonly canonical_remote: string;
  readonly coordinator_origin: string;
  readonly target_ref: string;
  readonly policy_digest: string;
  readonly principal_id: string;
}

/**
 * A repeated connect with identical semantics returns the existing revision
 * instead of appending a duplicate fact (spec §7).
 */
export function semanticConnectionEqual(
  record: CollaborationConnectionRecord,
  semantics: ConnectionSemantics,
): boolean {
  return (
    record.canonical_remote === semantics.canonical_remote &&
    record.coordinator_origin === semantics.coordinator_origin &&
    record.target_ref === semantics.target_ref &&
    record.policy_digest === semantics.policy_digest &&
    record.actor_principal_id === semantics.principal_id
  );
}

function isLeaseRecord(record: ControlRecord): record is LeaseRecord {
  return record.record_kind === "lease";
}

/**
 * A lease is live while granted/renewed and not yet past its expiry. The
 * history is first reduced per resource to its chain tip — the record with
 * the highest control_sequence for that resource — because a closed tip
 * (released/expired/revoked) retires the whole epoch even though the older
 * granted record still sits on the chain.
 */
export function hasLiveLease(controlRecords: readonly ControlRecord[], now: string): boolean {
  const tips = new Map<string, LeaseRecord>();
  for (const record of controlRecords) {
    if (!isLeaseRecord(record)) continue;
    const key = `${record.resource_kind}:${record.resource_id}`;
    const current = tips.get(key);
    if (current === undefined || record.control_sequence > current.control_sequence) {
      tips.set(key, record);
    }
  }
  for (const tip of tips.values()) {
    if ((tip.state === "granted" || tip.state === "renewed") && tip.expires_at > now) {
      return true;
    }
  }
  return false;
}
