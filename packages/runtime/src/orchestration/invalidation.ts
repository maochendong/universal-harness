/**
 * The downstream invalidation graph (designset lifecycle design 14, provable
 * TDD design 11, plan T17). When an upstream authority digest drifts, the
 * downstream artifacts that derived from it lose their authorization —
 * append-only invalidation, never deletion. The table is the single source
 * of truth for what invalidates what and where the pipeline re-enters; the
 * earliest affected phase always wins, so a baseline drift never resumes
 * into design with a stale impact set.
 */
export const UPSTREAM_DRIFT_KINDS = [
  "requirement_baseline",
  "impact_set",
  "design_set",
  "plan",
  "capability_plan",
  "policy",
] as const;
export type UpstreamDriftKind = (typeof UPSTREAM_DRIFT_KINDS)[number];

export const DOWNSTREAM_ARTIFACT_KINDS = [
  "impact_set",
  "design_set",
  "capability_plan",
  "plan",
  "task_tdd_contract",
  "context_bundle",
  "capability_grant",
  "tdd_cycle",
  "execution_authorization",
  "approval",
] as const;
export type DownstreamArtifactKind = (typeof DOWNSTREAM_ARTIFACT_KINDS)[number];

export type InvalidationResumePhase = "capture" | "impact" | "design" | "plan";

export interface DownstreamInvalidation {
  readonly invalidated: readonly DownstreamArtifactKind[];
  readonly resume_phase: InvalidationResumePhase;
}

const EVERYTHING_DOWNSTREAM: readonly DownstreamArtifactKind[] = [
  "impact_set",
  "design_set",
  "capability_plan",
  "plan",
  "task_tdd_contract",
  "context_bundle",
  "capability_grant",
  "tdd_cycle",
  "execution_authorization",
  "approval",
];

/** The invalidation matrix: drift kind → downstream set + re-entry phase. */
export const INVALIDATION_MATRIX: Readonly<Record<UpstreamDriftKind, DownstreamInvalidation>> = {
  // A requirement baseline change invalidates everything derived from it.
  requirement_baseline: { invalidated: EVERYTHING_DOWNSTREAM, resume_phase: "impact" },
  impact_set: {
    invalidated: [
      "design_set",
      "capability_plan",
      "plan",
      "task_tdd_contract",
      "context_bundle",
      "capability_grant",
      "tdd_cycle",
      "execution_authorization",
      "approval",
    ],
    resume_phase: "design",
  },
  design_set: {
    invalidated: [
      "capability_plan",
      "plan",
      "task_tdd_contract",
      "context_bundle",
      "capability_grant",
      "tdd_cycle",
      "execution_authorization",
    ],
    resume_phase: "plan",
  },
  capability_plan: {
    invalidated: ["plan", "task_tdd_contract", "context_bundle", "capability_grant", "tdd_cycle"],
    resume_phase: "plan",
  },
  plan: {
    invalidated: [
      "task_tdd_contract",
      "context_bundle",
      "capability_grant",
      "tdd_cycle",
      "execution_authorization",
    ],
    resume_phase: "plan",
  },
  // Policy drift never rewrites facts but reissues every open approval.
  policy: { invalidated: ["capability_grant", "approval"], resume_phase: "plan" },
};

/** What a drift of `kind` invalidates and where the pipeline re-enters. */
export function planDownstreamInvalidation(kind: UpstreamDriftKind): DownstreamInvalidation {
  return INVALIDATION_MATRIX[kind];
}

/** True when `artifact` may still be consumed after a drift of `kind`. */
export function survivesDrift(kind: UpstreamDriftKind, artifact: DownstreamArtifactKind): boolean {
  return !INVALIDATION_MATRIX[kind].invalidated.includes(artifact);
}
