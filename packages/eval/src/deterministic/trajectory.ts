import { clampScore, dimensionScore, type DimensionScore, type ScorerContext } from "../scorer.js";

/**
 * Trajectory scorer (design 16.1, P1): valid tool calls and no invalid
 * repeats. Only a `full`-visibility adapter supplies the step sequence this
 * scorer judges; for `summarized` or `external-only` visibility the verdict
 * is unavailable and the report must disclose that (coverage).
 */
export function scoreTrajectory(context: ScorerContext): DimensionScore {
  const { visibility, trajectory } = context.input;
  if (visibility !== "full" || trajectory === undefined) {
    return dimensionScore(context, "trajectory", {
      available: false,
      score: null,
      reason:
        `adapter visibility "${visibility}" does not expose the step-level trajectory ` +
        "(step_sequence, tool_validity, repeat_detection)",
    });
  }
  if (trajectory.length === 0) {
    return dimensionScore(context, "trajectory", {
      available: true,
      score: 1,
      reason: "run made no tool calls",
    });
  }
  const invalid = trajectory.filter((step) => !step.valid).length;
  const repeated = trajectory.filter((step) => step.repeated).length;
  const score = clampScore(1 - (invalid + repeated) / trajectory.length);
  const problems: string[] = [];
  if (invalid > 0) problems.push(`${String(invalid)} invalid tool call(s)`);
  if (repeated > 0) problems.push(`${String(repeated)} repeated tool call(s)`);
  return dimensionScore(context, "trajectory", {
    available: true,
    score,
    reason:
      problems.length === 0
        ? `all ${String(trajectory.length)} tool calls valid and non-repeated`
        : `${problems.join(" and ")} across ${String(trajectory.length)} tool call(s)`,
  });
}
