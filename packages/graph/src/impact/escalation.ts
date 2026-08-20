import type {
  ImpactRiskSignal,
  ProfileRecommendationTriggerId,
} from "@universal-harness-internal/core";

/**
 * Advisory → profile escalation bridge (plan T10): a high-risk advisory
 * signal may request a profile upgrade through the standard recommendation
 * channel. The bridge only maps signals onto registered recommendation
 * trigger ids — the output feeds `recommendProfileUpgrade`, whose record is
 * a fact a human or policy decision must still approve. The bridge never
 * decides, never approves and never touches the active profile.
 */
export function profileEscalationTriggersFromRiskSignals(
  signals: readonly ImpactRiskSignal[],
): ProfileRecommendationTriggerId[] {
  return signals.some((signal) => signal.risk === "high") ? ["medium_high_impact_uncertainty"] : [];
}
