import type { AgentControlProfile, AgentUsage } from "./agent.js";

export const BUDGET_DIMENSIONS = ["steps", "tokens", "duration_ms"] as const;
export type BudgetDimension = (typeof BUDGET_DIMENSIONS)[number];

export const MEASUREMENT_AVAILABILITIES = ["measured", "estimated", "unavailable"] as const;
export type MeasurementAvailability = (typeof MEASUREMENT_AVAILABILITIES)[number];

export const BUDGET_ENFORCEMENTS = ["harness", "provider", "none"] as const;
export type BudgetEnforcement = (typeof BUDGET_ENFORCEMENTS)[number];

/** One observable budget dimension. Unknown usage is null, never a fabricated zero. */
export interface BudgetObservation {
  readonly dimension: BudgetDimension;
  readonly availability: MeasurementAvailability;
  readonly used: number | null;
  readonly limit: number;
  readonly enforcement: BudgetEnforcement;
}

export interface ObserveAgentBudgetInput {
  readonly budget: {
    readonly max_steps: number;
    readonly max_tokens: number;
    readonly max_duration_ms: number;
  };
  readonly usage: AgentUsage;
  readonly profile?: AgentControlProfile;
  /** Harness-observed loop steps. Omit when the provider hides its trajectory. */
  readonly observedSteps?: number;
}

/**
 * Convert compatibility usage fields into availability-aware observations.
 * Duration is measured around the process by the Harness and its envelope
 * timeout is Harness-enforced. Provider token reports are measured but only
 * provider-enforced. Step counts exist only when the Harness actually owns or
 * observes the loop; tool-call summaries are deliberately not used as a proxy.
 */
export function observeAgentBudget(input: ObserveAgentBudgetInput): readonly BudgetObservation[] {
  const stepsAvailable =
    input.observedSteps !== undefined &&
    Number.isInteger(input.observedSteps) &&
    input.observedSteps >= 0 &&
    input.profile?.trajectory_visibility !== "external-only";
  const tokensAvailable =
    input.usage.metering === "provider_reported" && input.usage.total_tokens !== null;
  return [
    {
      dimension: "steps",
      availability: stepsAvailable ? "measured" : "unavailable",
      used: stepsAvailable ? (input.observedSteps as number) : null,
      limit: input.budget.max_steps,
      enforcement: stepsAvailable && input.profile?.control === "managed" ? "harness" : "none",
    },
    {
      dimension: "tokens",
      availability: tokensAvailable ? "measured" : "unavailable",
      used: tokensAvailable ? input.usage.total_tokens : null,
      limit: input.budget.max_tokens,
      enforcement: tokensAvailable ? "provider" : "none",
    },
    {
      dimension: "duration_ms",
      availability: "measured",
      used: input.usage.duration_ms,
      limit: input.budget.max_duration_ms,
      enforcement: "harness",
    },
  ];
}

export function unavailableBudgetDimensions(
  observations: readonly BudgetObservation[],
): readonly BudgetDimension[] {
  return observations
    .filter((entry) => entry.availability === "unavailable")
    .map((entry) => entry.dimension);
}
