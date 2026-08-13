import type { ChangeSeed, IterationKind } from "./seeds.js";
import type { ImpactPathStep } from "./propagation.js";

/**
 * Impact scoring and classification (design section 9, steps 3-4). Every rule
 * here is deterministic code: risk combines the seed's iteration kind with
 * the default risk of the relations on the explanation path, confidence is
 * the product of the traversed edge confidences, and classification follows a
 * fixed decision order. Model-inferred semantics never raise a classification;
 * they can only hold a candidate at `inspect`.
 */
export const RISK_LEVELS = ["low", "medium", "high"] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

export const IMPACT_CLASSIFICATIONS = ["must-change", "inspect", "informational"] as const;

export type ImpactClassification = (typeof IMPACT_CLASSIFICATIONS)[number];

const RISK_RANK: Readonly<Record<RiskLevel, number>> = { low: 0, medium: 1, high: 2 };

export function maxRisk(left: RiskLevel, right: RiskLevel): RiskLevel {
  return RISK_RANK[left] >= RISK_RANK[right] ? left : right;
}

/** Base risk of an iteration kind for content-affecting seeds. */
export const ITERATION_BASE_RISK: Readonly<Record<IterationKind, RiskLevel>> = {
  feature: "medium",
  bugfix: "medium",
  refactor: "low",
  security: "high",
  maintenance: "low",
};

/**
 * Base risk carried by a seed. Security or compliance failures default to
 * high (design section 9); a pure rename is always low because nothing
 * downstream has to change for a locator-only move.
 */
export function seedBaseRisk(seed: ChangeSeed): RiskLevel {
  if (seed.kind === "pure-rename") return "low";
  if (seed.kind === "finding") {
    return seed.iterationKind === "security" ? "high" : "medium";
  }
  return ITERATION_BASE_RISK[seed.iterationKind];
}

/** Product of the step confidences, rounded to six decimals for stable I/O. */
export function pathConfidence(path: readonly ImpactPathStep[]): number {
  let confidence = 1;
  for (const step of path) confidence *= step.confidence;
  return Math.round(confidence * 1_000_000) / 1_000_000;
}

/**
 * Risk of a reached node: the seed risk, elevated to high whenever the
 * explanation path crosses a high-risk relation (constraints, policies,
 * refuting evidence, realization). Ordinary relations keep the seed risk, so
 * a low-risk refactor does not escalate every neighboring artifact.
 */
export function pathRisk(seed: ChangeSeed, path: readonly ImpactPathStep[]): RiskLevel {
  let risk = seedBaseRisk(seed);
  for (const step of path) {
    if (step.relationRisk === "high") risk = "high";
  }
  return risk;
}

export interface ImpactAssessment {
  readonly risk: RiskLevel;
  readonly confidence: number;
  readonly classification: ImpactClassification;
  readonly reason: string;
}

/**
 * Classify one reached node. Decision order is fixed:
 *
 * 1. A pure-rename seed whose explanation path uses only SUPERSEDES edges is
 *    informational (design 8.4): nothing downstream must change.
 * 2. A path that traverses an inferred edge (proposed, or accepted with its
 *    original sub-1.0 confidence) can only be `inspect`; accepting an
 *    inferred edge never rewrites its confidence into a must-change.
 * 3. The seed node itself must change, unless the seed is a pure rename.
 * 4. Low residual risk is informational; medium or high is must-change.
 */
export function assessImpact(seed: ChangeSeed, path: readonly ImpactPathStep[]): ImpactAssessment {
  const risk = pathRisk(seed, path);
  const confidence = pathConfidence(path);
  if (seed.kind === "pure-rename" && path.every((step) => step.relation === "SUPERSEDES")) {
    return {
      risk,
      confidence,
      classification: "informational",
      reason: "pure rename: only the locator changed; the content digest is unchanged",
    };
  }
  const inferredStep = path.find((step) => step.inferred);
  if (inferredStep !== undefined) {
    return {
      risk,
      confidence,
      classification: "inspect",
      reason: `path traverses inferred edge ${inferredStep.edgeId} (confidence ${inferredStep.confidence}); a human must confirm the relation`,
    };
  }
  if (path.length === 0) {
    return {
      risk,
      confidence,
      classification: "must-change",
      reason: `change seed: ${seed.reason}`,
    };
  }
  if (risk === "low") {
    return {
      risk,
      confidence,
      classification: "informational",
      reason: `low-risk ${seed.iterationKind} change; deterministic path of ${path.length} edge(s) needs no revision`,
    };
  }
  return {
    risk,
    confidence,
    classification: "must-change",
    reason: `${risk} risk ${seed.iterationKind} change propagated over ${path.length} deterministic edge(s)`,
  };
}
