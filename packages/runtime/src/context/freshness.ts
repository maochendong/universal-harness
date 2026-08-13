import { validateSchema } from "@universal-harness-internal/core";

import {
  type BundleBindings,
  type ContextBundleManifest,
  type ContextBundleRecord,
  type Freshness,
} from "./compiler.js";
import { ContextError } from "./selector.js";

/**
 * Bundle freshness and invalidation (design 10.3 and 13.4). A bundle is
 * fresh only while every source content digest and every binding digest it
 * was compiled against still holds. Any drift — a changed or vanished
 * source, a new requirement baseline, policy, plan or approval set — makes
 * it stale, and a stale bundle must be recompiled before the next step,
 * proposal acceptance or authoritative commit. Invalidation is append-only:
 * it yields a new record with the same digest and `stale: true`, never
 * rewriting history, and it is idempotent so continuous change collapses
 * into one pending invalidation instead of repeatedly restarting work.
 */
export function freshnessOf(expectedDigest: string, currentDigest: string): Freshness {
  return expectedDigest === currentDigest ? "fresh" : "stale";
}

/** Current authoritative state the manifest is checked against. */
export interface CurrentContextState {
  /** Current content digest per source node id; a missing id means gone. */
  readonly sourceDigests: ReadonlyMap<string, string>;
  readonly bindings: BundleBindings;
}

/** Every reason the bundle no longer reflects current state; empty is fresh. */
export function stalenessReasons(
  manifest: ContextBundleManifest,
  current: CurrentContextState,
): readonly string[] {
  const reasons: string[] = [];
  for (const entry of manifest.entries) {
    const currentDigest = current.sourceDigests.get(entry.node_id);
    if (currentDigest === undefined) {
      reasons.push(`source ${entry.node_id} is no longer available`);
    } else if (freshnessOf(entry.digest, currentDigest) === "stale") {
      reasons.push(`source ${entry.node_id} digest changed`);
    }
  }
  const expected = manifest.bindings;
  const actual = current.bindings;
  if (expected.requirement_baseline_digest !== actual.requirement_baseline_digest) {
    reasons.push("requirement baseline digest changed");
  }
  if (expected.policy_digest !== actual.policy_digest) {
    reasons.push("policy digest changed");
  }
  if (expected.plan_digest !== actual.plan_digest) {
    reasons.push("execution plan digest changed");
  }
  const expectedApprovals = [...expected.approval_digests].sort();
  const actualApprovals = [...actual.approval_digests].sort();
  if (JSON.stringify(expectedApprovals) !== JSON.stringify(actualApprovals)) {
    reasons.push("approval binding set changed");
  }
  return reasons;
}

export function isContextBundleStale(
  manifest: ContextBundleManifest,
  current: CurrentContextState,
): boolean {
  return stalenessReasons(manifest, current).length > 0;
}

/**
 * Append-only invalidation: the successor record keeps the bundle identity
 * (same digest, same sources) and only flips `stale`. Already-stale records
 * pass through, so repeated drift merges into a single pending
 * invalidation.
 */
export function invalidateContextBundle(record: ContextBundleRecord): ContextBundleRecord {
  if (record.stale) return record;
  const next: ContextBundleRecord = { ...record, stale: true };
  const validation = validateSchema("runtime", next);
  if (!validation.valid) {
    throw new ContextError(
      "invalid_record",
      `invalid stale context bundle record: ${validation.errors
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }
  return next;
}
