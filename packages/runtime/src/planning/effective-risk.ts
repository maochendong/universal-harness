import type { AdapterControlProfile } from "../policy/action.js";

export const GOVERNANCE_RISKS = ["low", "medium", "high", "critical"] as const;
export type GovernanceRisk = (typeof GOVERNANCE_RISKS)[number];
export type PathScope = "exact" | "bounded" | "broad";
export type TaskComplexity = "small" | "medium" | "large";

export interface EffectiveRiskInput {
  readonly declaredTaskRisk: GovernanceRisk;
  readonly impactRisk: GovernanceRisk;
  readonly coverageRisk: GovernanceRisk;
  readonly pathScope: PathScope;
  readonly taskComplexity: TaskComplexity;
  readonly adapterProfile?: AdapterControlProfile;
  readonly actualDiffRisk?: GovernanceRisk;
}

function riskAtLeast(current: GovernanceRisk, candidate: GovernanceRisk): GovernanceRisk {
  return GOVERNANCE_RISKS.indexOf(current) >= GOVERNANCE_RISKS.indexOf(candidate)
    ? current
    : candidate;
}

export function deriveEffectiveRisk(input: EffectiveRiskInput): GovernanceRisk {
  let risk = input.declaredTaskRisk;
  risk = riskAtLeast(risk, input.impactRisk);
  risk = riskAtLeast(risk, input.coverageRisk);
  if (input.pathScope === "bounded") risk = riskAtLeast(risk, "medium");
  if (input.pathScope === "broad") risk = riskAtLeast(risk, "high");
  if (input.taskComplexity === "medium") risk = riskAtLeast(risk, "medium");
  if (input.taskComplexity === "large") risk = riskAtLeast(risk, "high");
  const profile = input.adapterProfile;
  if (profile?.control === "manual") risk = riskAtLeast(risk, "high");
  if (
    profile?.control === "delegated" &&
    (!profile.usage_metering ||
      !profile.side_effect_interception ||
      profile.trajectory_visibility === "external-only")
  ) {
    risk = riskAtLeast(risk, "high");
  }
  if (input.actualDiffRisk !== undefined) risk = riskAtLeast(risk, input.actualDiffRisk);
  return risk;
}
