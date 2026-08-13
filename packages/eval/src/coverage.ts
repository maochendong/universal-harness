import type { AgentTrajectoryVisibility } from "@universal-harness-internal/plugin-sdk";

/**
 * Trajectory coverage (design 16.1). Every evaluation discloses which
 * trajectory fields the adapter's visibility could supply and which it could
 * not; a delegated provider with `external-only` visibility can never
 * back a trajectory verdict, and policy may require a minimum coverage.
 * The ratio is the share of catalog fields the visibility exposes.
 */

export const TRAJECTORY_FIELDS = [
  "outcome",
  "termination_reason",
  "usage",
  "tool_activity_summary",
  "step_sequence",
  "tool_validity",
  "repeat_detection",
] as const;

export type TrajectoryField = (typeof TRAJECTORY_FIELDS)[number];

const FIELDS_BY_VISIBILITY: Readonly<
  Record<AgentTrajectoryVisibility, readonly TrajectoryField[]>
> = {
  full: TRAJECTORY_FIELDS,
  summarized: ["outcome", "termination_reason", "usage", "tool_activity_summary"],
  "external-only": ["outcome", "termination_reason", "usage"],
};

export interface TrajectoryCoverage {
  readonly visibility: AgentTrajectoryVisibility;
  readonly available_fields: readonly TrajectoryField[];
  readonly unavailable_fields: readonly TrajectoryField[];
  /** Available fields as a fraction of the full catalog, rounded to 1e-6. */
  readonly ratio: number;
}

/** Fields a visibility level exposes, in catalog order. */
export function availableFields(visibility: AgentTrajectoryVisibility): readonly TrajectoryField[] {
  return FIELDS_BY_VISIBILITY[visibility];
}

/** Coverage disclosure for one adapter visibility level. */
export function trajectoryCoverage(visibility: AgentTrajectoryVisibility): TrajectoryCoverage {
  const available = FIELDS_BY_VISIBILITY[visibility];
  const exposed = new Set<string>(available);
  const unavailable = TRAJECTORY_FIELDS.filter((field) => !exposed.has(field));
  return {
    visibility,
    available_fields: available,
    unavailable_fields: unavailable,
    ratio: Math.round((available.length / TRAJECTORY_FIELDS.length) * 1e6) / 1e6,
  };
}
