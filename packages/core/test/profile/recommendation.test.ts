import { describe, expect, it } from "vitest";

import {
  PROFILE_RECOMMENDATION_TRIGGERS,
  ProfileRecommendationError,
  recommendProfileUpgrade,
} from "../../src/profile/recommendation.js";

describe("profile risk recommendation", () => {
  it("registers versioned triggers for both upgrade tiers", () => {
    const standardTriggers = PROFILE_RECOMMENDATION_TRIGGERS.filter(
      (trigger) => trigger.minimum_profile === "standard",
    ).map((trigger) => trigger.trigger_id);
    const governedTriggers = PROFILE_RECOMMENDATION_TRIGGERS.filter(
      (trigger) => trigger.minimum_profile === "governed",
    ).map((trigger) => trigger.trigger_id);
    expect(standardTriggers).toEqual([
      "cross_component_change",
      "public_api_change",
      "data_schema_or_migration_change",
      "security_or_supply_chain_surface",
      "medium_high_impact_uncertainty",
      "independent_evaluation_or_design_contract_required",
      "insufficient_gate_foundation",
    ]);
    expect(governedTriggers).toEqual([
      "critical_risk",
      "regulatory_or_audit_constraint",
      "irreversible_external_effect",
      "production_or_sensitive_data_access",
      "policy_mandated_governance",
    ]);
  });

  it("recommends the lowest profile that covers every triggered signal", () => {
    expect(
      recommendProfileUpgrade({ current_profile_id: "lite", triggered: ["public_api_change"] }),
    ).toEqual({ recommended_profile_id: "standard", triggers: ["public_api_change"] });

    const governed = recommendProfileUpgrade({
      current_profile_id: "lite",
      triggered: ["public_api_change", "critical_risk"],
    });
    expect(governed?.recommended_profile_id).toBe("governed");
    expect(governed?.triggers).toEqual(["critical_risk", "public_api_change"]);

    expect(
      recommendProfileUpgrade({ current_profile_id: "standard", triggered: ["critical_risk"] }),
    ).toEqual({ recommended_profile_id: "governed", triggers: ["critical_risk"] });
  });

  it("returns no recommendation when the current profile already covers the risk", () => {
    expect(
      recommendProfileUpgrade({ current_profile_id: "standard", triggered: ["public_api_change"] }),
    ).toBeUndefined();
    expect(
      recommendProfileUpgrade({ current_profile_id: "governed", triggered: ["critical_risk"] }),
    ).toBeUndefined();
    expect(recommendProfileUpgrade({ current_profile_id: "lite", triggered: [] })).toBeUndefined();
  });

  it("fails closed on unregistered trigger ids", () => {
    expect(() =>
      recommendProfileUpgrade({ current_profile_id: "lite", triggered: ["vibes"] }),
    ).toThrow(ProfileRecommendationError);
  });
});
