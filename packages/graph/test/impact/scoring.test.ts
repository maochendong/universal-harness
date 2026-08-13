import { describe, expect, it } from "vitest";

import { assessImpact, maxRisk, pathConfidence, seedBaseRisk } from "../../src/impact/scoring.js";
import type { ImpactPathStep } from "../../src/impact/propagation.js";
import type { ChangeSeed } from "../../src/impact/seeds.js";

function seed(kind: ChangeSeed["kind"], iterationKind: ChangeSeed["iterationKind"]): ChangeSeed {
  return {
    id: `seed_${kind}_${iterationKind}`,
    nodeId: "node_01",
    kind,
    iterationKind,
    reason: "test",
  };
}

function step(overrides: Partial<ImpactPathStep> = {}): ImpactPathStep {
  return {
    edgeId: "edge_01",
    relation: "VERIFIES",
    fromNodeId: "node_01",
    toNodeId: "node_02",
    relationRisk: "medium",
    inferred: false,
    confidence: 1,
    ...overrides,
  };
}

describe("impact scoring", () => {
  it("orders risk levels", () => {
    expect(maxRisk("low", "high")).toBe("high");
    expect(maxRisk("medium", "low")).toBe("medium");
    expect(maxRisk("high", "high")).toBe("high");
  });

  it("derives seed base risk from kind and iteration kind", () => {
    expect(seedBaseRisk(seed("pure-rename", "security"))).toBe("low");
    expect(seedBaseRisk(seed("finding", "security"))).toBe("high");
    expect(seedBaseRisk(seed("finding", "bugfix"))).toBe("medium");
    expect(seedBaseRisk(seed("content-change", "feature"))).toBe("medium");
    expect(seedBaseRisk(seed("content-change", "refactor"))).toBe("low");
    expect(seedBaseRisk(seed("rename-with-change", "maintenance"))).toBe("low");
    expect(seedBaseRisk(seed("improvement", "bugfix"))).toBe("medium");
  });

  it("multiplies path confidence and rounds deterministically", () => {
    expect(pathConfidence([])).toBe(1);
    expect(pathConfidence([step({ confidence: 0.5 })])).toBe(0.5);
    expect(pathConfidence([step({ confidence: 0.6 }), step({ confidence: 0.6 })])).toBe(0.36);
  });

  it("classifies the seed node as must-change unless it is a pure rename", () => {
    expect(assessImpact(seed("content-change", "refactor"), []).classification).toBe("must-change");
    expect(assessImpact(seed("pure-rename", "feature"), []).classification).toBe("informational");
  });

  it("classifies a SUPERSEDES-only pure-rename path as informational", () => {
    const renamePath = [step({ relation: "SUPERSEDES", relationRisk: "low" })];
    const assessment = assessImpact(seed("pure-rename", "refactor"), renamePath);
    expect(assessment.classification).toBe("informational");
    expect(assessment.reason).toContain("pure rename");
  });

  it("caps any path through an inferred edge at inspect", () => {
    const inferredPath = [step({ inferred: true, confidence: 0.5 })];
    const assessment = assessImpact(seed("content-change", "security"), inferredPath);
    expect(assessment.classification).toBe("inspect");
    expect(assessment.reason).toContain("edge_01");
    expect(assessment.confidence).toBe(0.5);
  });

  it("classifies low residual risk as informational and higher risk as must-change", () => {
    const lowPath = [step({ relation: "DEPENDS_ON", relationRisk: "low" })];
    expect(assessImpact(seed("content-change", "maintenance"), lowPath).classification).toBe(
      "informational",
    );
    expect(assessImpact(seed("content-change", "feature"), lowPath).classification).toBe(
      "must-change",
    );
  });

  it("elevates risk across high-risk relations but not across ordinary ones", () => {
    const governed = [step({ relation: "GOVERNED_BY", relationRisk: "high" })];
    const assessment = assessImpact(seed("content-change", "refactor"), governed);
    expect(assessment.risk).toBe("high");
    expect(assessment.classification).toBe("must-change");
    const ordinary = [step({ relation: "VERIFIES", relationRisk: "medium" })];
    expect(assessImpact(seed("content-change", "refactor"), ordinary).risk).toBe("low");
  });
});
