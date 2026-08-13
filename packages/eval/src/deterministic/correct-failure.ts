import type {
  AgentRunOutcome,
  AgentTerminationReason,
} from "@universal-harness-internal/plugin-sdk";

import { dimensionScore, type DimensionScore, type ScorerContext } from "../scorer.js";

/**
 * Correct-failure scorer (design 16.1, P1): when the case expects the run to
 * fail, it must fail the right way -- ask for clarification when information
 * is missing, block when permission is denied, hand off when a tool failure
 * is unrecoverable. A run that "succeeds" where failure was expected scores
 * zero, as does the right outcome with the wrong termination.
 */

const FAILURE_EXPECTATIONS: Readonly<
  Partial<Record<AgentRunOutcome, readonly AgentTerminationReason[]>>
> = {
  clarification_required: ["completion"],
  correct_block: ["policy_denial"],
  handoff: ["completion", "adapter_failure", "timeout", "budget_ceiling"],
  partial: ["timeout", "budget_ceiling", "process_interruption"],
  failed: ["adapter_failure", "timeout", "budget_ceiling", "repeat_detection"],
};

function expectedFailures(context: ScorerContext): readonly AgentRunOutcome[] {
  return context.case.expected_outcomes.filter((outcome) => outcome in FAILURE_EXPECTATIONS);
}

export function scoreCorrectFailure(context: ScorerContext): DimensionScore {
  const failures = expectedFailures(context);
  if (failures.length === 0) {
    return dimensionScore(context, "correct_failure", {
      available: true,
      score: 1,
      reason: "not a failure scenario; the case expects no failure-class outcome",
    });
  }
  const { outcome, termination_reason: termination } = context.input.run;
  if (!failures.includes(outcome)) {
    return dimensionScore(context, "correct_failure", {
      available: true,
      score: 0,
      reason:
        `run ended "${outcome}" where a correct failure was expected ` + `[${failures.join(", ")}]`,
    });
  }
  const allowed = FAILURE_EXPECTATIONS[outcome] ?? [];
  const correct = allowed.includes(termination);
  return dimensionScore(context, "correct_failure", {
    available: true,
    score: correct ? 1 : 0,
    reason: correct
      ? `run failed correctly: "${outcome}" via "${termination}"`
      : `run ended "${outcome}" but terminated "${termination}", expected one of [${allowed.join(", ")}]`,
  });
}
