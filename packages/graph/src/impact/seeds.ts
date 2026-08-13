import {
  classifyRescan,
  contentDigest,
  type NodeRecord,
  type NodeSnapshot,
} from "@universal-harness-internal/core";

/**
 * Change seeds (design section 9, step 1): impact analysis starts from a
 * changed node digest, a git diff mapping, a Finding, a RootCauseAnalysis or
 * an ImprovementCandidate. A seed is a deterministic, self-describing record;
 * the same change input always derives the same seed, so ImpactSet digests
 * are reproducible across rebuilds and platforms.
 */
export class ImpactError extends Error {
  readonly kind = "impact_error" as const;

  constructor(message: string) {
    super(message);
    this.name = "ImpactError";
  }
}

export const ITERATION_KINDS = [
  "feature",
  "bugfix",
  "refactor",
  "security",
  "maintenance",
] as const;

export type IterationKind = (typeof ITERATION_KINDS)[number];

export const CHANGE_SEED_KINDS = [
  "content-change",
  "rename-with-change",
  "pure-rename",
  "finding",
  "improvement",
] as const;

export type ChangeSeedKind = (typeof CHANGE_SEED_KINDS)[number];

export interface ChangeSeed {
  /** Deterministic id derived from the seed content, never from a clock. */
  readonly id: string;
  /** Node the change starts from; propagation begins here. */
  readonly nodeId: string;
  readonly kind: ChangeSeedKind;
  readonly iterationKind: IterationKind;
  readonly reason: string;
}

function seedId(nodeId: string, kind: ChangeSeedKind, iterationKind: IterationKind): string {
  return `seed_${contentDigest({ nodeId, kind, iterationKind }).slice(0, 16)}`;
}

function makeSeed(
  nodeId: string,
  kind: ChangeSeedKind,
  iterationKind: IterationKind,
  reason: string,
): ChangeSeed {
  return { id: seedId(nodeId, kind, iterationKind), nodeId, kind, iterationKind, reason };
}

/** A node observed again by a rescan, with its previous and next snapshots. */
export interface RescanChange {
  readonly nodeId: string;
  readonly previous: NodeSnapshot;
  readonly next: NodeSnapshot;
}

/**
 * Derive a seed from a rescan classification (design 8.4). An unchanged node
 * yields no seed. A pure rename changes only the locator while the normalized
 * content digest stays identical; its SUPERSEDES path later produces only
 * informational impact, so a rename alone never triggers downstream churn.
 */
export function seedFromRescan(
  change: RescanChange,
  iterationKind: IterationKind,
): ChangeSeed | undefined {
  const classification = classifyRescan(change.previous, change.next);
  switch (classification) {
    case "unchanged":
      return undefined;
    case "pure-rename":
      return makeSeed(
        change.nodeId,
        "pure-rename",
        iterationKind,
        `locator changed from ${change.previous.locator} to ${change.next.locator}; content digest unchanged`,
      );
    case "content-change":
      return makeSeed(
        change.nodeId,
        "content-change",
        iterationKind,
        `content digest changed from ${change.previous.digest} to ${change.next.digest}`,
      );
    case "rename-with-change":
      return makeSeed(
        change.nodeId,
        "rename-with-change",
        iterationKind,
        `locator changed from ${change.previous.locator} to ${change.next.locator} and content digest changed`,
      );
  }
}

/**
 * Derive a seed from a Finding node (test, review, audit, runtime or
 * evaluation failure). Propagation follows the Finding's VIOLATES and BLOCKS
 * edges; a security iteration keeps the default-must-change semantics of
 * design section 9.
 */
export function seedFromFinding(finding: NodeRecord, iterationKind: IterationKind): ChangeSeed {
  if (finding.type !== "Finding") {
    throw new ImpactError(`finding seed requires a Finding node, got ${finding.type}`);
  }
  return makeSeed(
    finding.id,
    "finding",
    iterationKind,
    `finding ${finding.id} revision ${finding.revision} triggers impact analysis`,
  );
}

/**
 * Derive a seed from an ImprovementCandidate node. Propagation follows its
 * PROPOSES_CHANGE_TO edges to the targeted versionable nodes.
 */
export function seedFromImprovementCandidate(
  candidate: NodeRecord,
  iterationKind: IterationKind,
): ChangeSeed {
  if (candidate.type !== "ImprovementCandidate") {
    throw new ImpactError(
      `improvement seed requires an ImprovementCandidate node, got ${candidate.type}`,
    );
  }
  return makeSeed(
    candidate.id,
    "improvement",
    iterationKind,
    `improvement candidate ${candidate.id} proposes a change`,
  );
}
