import { existsSync, readFileSync } from "node:fs";

import { resolveHarnessPath, sha256Hex } from "@universal-harness-internal/core";

import { managedProjectionPath } from "./managed-output.js";

/**
 * Projection drift detection (design 9 and 13.7, plan Task 22). Drift means
 * the bytes on disk no longer match the digest the projection was generated
 * with -- a hand edit, a deleted mirror or an upstream revision change. Drift
 * only ever triggers regeneration of the projection; it never modifies the
 * authoritative Definition Nodes the projection was rendered from.
 */
export const PROJECTION_DRIFT_STATUSES = ["current", "drifted", "missing"] as const;

export type ProjectionDriftStatus = (typeof PROJECTION_DRIFT_STATUSES)[number];

export interface ProjectionDrift {
  /** Harness-relative managed path that was checked. */
  readonly path: string;
  readonly status: ProjectionDriftStatus;
  readonly expected_digest: string;
  /** Present for `drifted`: the digest of the bytes actually on disk. */
  readonly actual_digest?: string;
  readonly detail: string;
}

export interface ProjectionTarget {
  /** Name relative to the managed projection directory, or harness-relative path. */
  readonly path: string;
  readonly expectedDigest: string;
}

function normalizeTargetPath(path: string): string {
  // Accept either a bare managed name or an already-qualified harness path.
  return path.startsWith("projections/") ? path : managedProjectionPath(path);
}

/** Compare one managed projection file against its recorded digest. */
export function detectProjectionDrift(
  harnessRoot: string,
  target: ProjectionTarget,
): ProjectionDrift {
  const relativePath = normalizeTargetPath(target.path);
  const absolute = resolveHarnessPath(harnessRoot, relativePath);
  if (!existsSync(absolute)) {
    return {
      path: relativePath,
      status: "missing",
      expected_digest: target.expectedDigest,
      detail: "projection file is missing; regenerate it from the authoritative graph",
    };
  }
  const actualDigest = sha256Hex(readFileSync(absolute, "utf8"));
  if (actualDigest === target.expectedDigest) {
    return {
      path: relativePath,
      status: "current",
      expected_digest: target.expectedDigest,
      detail: "projection matches its generation digest",
    };
  }
  return {
    path: relativePath,
    status: "drifted",
    expected_digest: target.expectedDigest,
    actual_digest: actualDigest,
    detail: "projection bytes differ from the generation digest; regenerate, never edit by hand",
  };
}

/** Drift report for several targets, in deterministic path order. */
export function detectProjectionDrifts(
  harnessRoot: string,
  targets: readonly ProjectionTarget[],
): readonly ProjectionDrift[] {
  return targets
    .map((target) => detectProjectionDrift(harnessRoot, target))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}
