import { describe, expect, it } from "vitest";

import { deriveEffectiveRisk } from "../../src/planning/effective-risk.js";

describe("deriveEffectiveRisk", () => {
  it("never lowers downstream risk below an upstream source", () => {
    expect(
      deriveEffectiveRisk({
        declaredTaskRisk: "low",
        impactRisk: "medium",
        coverageRisk: "low",
        pathScope: "exact",
        taskComplexity: "small",
      }),
    ).toBe("medium");
    expect(
      deriveEffectiveRisk({
        declaredTaskRisk: "critical",
        impactRisk: "low",
        coverageRisk: "low",
        pathScope: "exact",
        taskComplexity: "small",
      }),
    ).toBe("critical");
  });

  it("elevates opaque delegated adapters and broad paths to high", () => {
    expect(
      deriveEffectiveRisk({
        declaredTaskRisk: "low",
        impactRisk: "low",
        coverageRisk: "low",
        pathScope: "broad",
        taskComplexity: "small",
        adapterProfile: {
          control: "delegated",
          trajectory_visibility: "external-only",
          usage_metering: false,
          side_effect_interception: false,
        },
      }),
    ).toBe("high");
  });
});
