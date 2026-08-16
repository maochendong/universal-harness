import { describe, expect, it } from "vitest";

import { assessImpactCoverage } from "../../src/planning/impact-coverage.js";

const baseEntries = [
  { node_id: "intent_01", node_type: "Intent", risk: "medium" },
  { node_id: "requirement_01", node_type: "Requirement", risk: "medium" },
  { node_id: "test_01", node_type: "Test", risk: "medium" },
] as const;

describe("assessImpactCoverage", () => {
  it("blocks an agent coding task whose impact stops at requirements and tests", () => {
    const assessment = assessImpactCoverage({
      executionKind: "agent",
      entries: baseEntries,
      forecastPaths: [],
    });

    expect(assessment.status).toBe("partial");
    expect(assessment.covered_layers).toEqual(["intent", "requirement", "test"]);
    expect(assessment.missing_layers).toEqual(["implementation_or_path"]);
    expect(assessment.risk).toBe("medium");
  });

  it("accepts stable implementation or approved bounded-path coverage", () => {
    const implementation = assessImpactCoverage({
      executionKind: "agent",
      entries: [...baseEntries, { node_id: "code_01", node_type: "CodeArtifact", risk: "high" }],
      forecastPaths: [],
    });
    const boundedPath = assessImpactCoverage({
      executionKind: "agent",
      entries: baseEntries,
      forecastPaths: [{ pattern: "backend/src", scope: "bounded", approved: true }],
    });

    expect(implementation).toMatchObject({ status: "complete", risk: "high" });
    expect(boundedPath).toMatchObject({ status: "complete", risk: "medium" });
    expect(
      assessImpactCoverage({
        executionKind: "agent",
        entries: baseEntries,
        forecastPaths: [{ pattern: "**", scope: "broad", approved: true }],
      }),
    ).toMatchObject({ status: "unknown", risk: "high" });
  });

  it("is digest-stable regardless of input order", () => {
    const first = assessImpactCoverage({
      executionKind: "agent",
      entries: baseEntries,
      forecastPaths: [{ pattern: "src", scope: "bounded", approved: true }],
    });
    const second = assessImpactCoverage({
      executionKind: "agent",
      entries: [...baseEntries].reverse(),
      forecastPaths: [{ pattern: "src", scope: "bounded", approved: true }],
    });
    expect(second.digest).toBe(first.digest);
  });
});
