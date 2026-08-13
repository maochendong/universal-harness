import { dimensionScore, type DimensionScore, type ScorerContext } from "../scorer.js";

/**
 * Outcome scorer (design 16.1, P0): the terminal outcome must be one the
 * case declared acceptable. Always available -- every run records one
 * defined outcome and termination reason (acceptance 15).
 */
export function scoreOutcome(context: ScorerContext): DimensionScore {
  const outcome = context.input.run.outcome;
  const expected = context.case.expected_outcomes;
  const matched = expected.includes(outcome);
  return dimensionScore(context, "outcome", {
    available: true,
    score: matched ? 1 : 0,
    reason: matched
      ? `run outcome "${outcome}" is an expected outcome`
      : `run outcome "${outcome}" is not one of the expected outcomes [${expected.join(", ")}]`,
  });
}
