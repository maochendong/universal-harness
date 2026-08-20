import { describe, expect, it } from "vitest";

import {
  createProfileRecommendationRecord,
  recommendProfileUpgrade,
  type ImpactRiskSignal,
} from "@universal-harness-internal/core";

import { profileEscalationTriggersFromRiskSignals } from "../../src/impact/escalation.js";

/**
 * T10 escalation bridge: an advisory risk signal may REQUEST a profile
 * upgrade through the standard recommendation channel — a fact record that
 * a human or policy decision must still approve. The bridge never decides
 * and never touches the active profile.
 */
function signal(risk: "low" | "medium" | "high", nodeId = "code-artifact_02"): ImpactRiskSignal {
  return {
    node_id: nodeId,
    signal: "shared mutable state across the export path",
    risk,
    rationale: "the dependency crosses a trust boundary",
    source_refs: [{ kind: "graph_node", ref: nodeId, digest: "a".repeat(64) }],
  };
}

describe("profileEscalationTriggersFromRiskSignals", () => {
  it("maps high-risk signals to the registered uncertainty trigger, canonically", () => {
    const triggers = profileEscalationTriggersFromRiskSignals([
      signal("high"),
      signal("high", "code-artifact_03"),
      signal("medium", "code-artifact_04"),
    ]);
    expect(triggers).toEqual(["medium_high_impact_uncertainty"]);
  });

  it("requests nothing from medium or low signals", () => {
    expect(profileEscalationTriggersFromRiskSignals([signal("medium"), signal("low")])).toEqual([]);
  });

  it("feeds the standard recommendation channel without ever approving", () => {
    const triggers = profileEscalationTriggersFromRiskSignals([signal("high")]);
    const upgrade = recommendProfileUpgrade({ current_profile_id: "lite", triggered: triggers });
    expect(upgrade?.recommended_profile_id).toBe("standard");
    const record = createProfileRecommendationRecord({
      project_id: "project_demo",
      iteration_id: "iteration_01K1ABC",
      current_profile_id: "lite",
      triggered: triggers,
      risk_object_digest: "b".repeat(64),
      requirement_digest: "c".repeat(64),
      scope_digest: "d".repeat(64),
      policy_digest: "e".repeat(64),
      rationale: "Impact 风险信号显示影响不确定性为 high，建议至少 Standard。",
    });
    // The bridge produces a recommendation fact only: the record kind is not
    // a decision, and the input profile is carried, never rewritten.
    expect(record?.record_kind).toBe("profile_recommendation");
    expect(JSON.stringify(record)).not.toContain("profile_decision");
  });

  it("recommends nothing when the current profile already covers the risk", () => {
    const triggers = profileEscalationTriggersFromRiskSignals([signal("high")]);
    expect(
      recommendProfileUpgrade({ current_profile_id: "governed", triggered: triggers }),
    ).toBeUndefined();
  });
});
