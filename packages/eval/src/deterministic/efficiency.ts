import { clampScore, dimensionScore, type DimensionScore, type ScorerContext } from "../scorer.js";

/**
 * Efficiency scorer (design 16.1, P2): budget utilization of the run against
 * the envelope ceilings -- tokens, duration and steps. The score is one
 * minus the worst utilization ratio, so a run at its ceiling scores zero and
 * a frugal run scores high. Unmetered tokens are disclosed and skipped, not
 * treated as zero use. Advisory by default (threshold 0).
 */
export function scoreEfficiency(context: ScorerContext): DimensionScore {
  const { run, budget, trajectory } = context.input;
  const ratios: number[] = [];
  const parts: string[] = [];

  if (run.usage.total_tokens !== null && budget.max_tokens > 0) {
    ratios.push(run.usage.total_tokens / budget.max_tokens);
    parts.push(`tokens ${String(run.usage.total_tokens)}/${String(budget.max_tokens)}`);
  } else {
    parts.push("tokens unmetered");
  }
  if (budget.max_duration_ms > 0) {
    ratios.push(run.usage.duration_ms / budget.max_duration_ms);
    parts.push(`duration ${String(run.usage.duration_ms)}/${String(budget.max_duration_ms)}ms`);
  }
  const steps = trajectory?.length ?? run.tool_activity.total_calls;
  if (budget.max_steps > 0) {
    ratios.push(steps / budget.max_steps);
    parts.push(`steps ${String(steps)}/${String(budget.max_steps)}`);
  }

  const worst = ratios.length === 0 ? 0 : Math.max(...ratios);
  const percent = Math.round(worst * 1000) / 10;
  return dimensionScore(context, "efficiency", {
    available: true,
    score: clampScore(1 - worst),
    reason: `worst budget utilization ${String(percent)}% (${parts.join("; ")})`,
  });
}
