import { describe, expect, it } from "vitest";

import { TRAJECTORY_FIELDS, availableFields, trajectoryCoverage } from "../src/coverage.js";

/**
 * Trajectory coverage disclosure (design 16.1): every report states which
 * fields the adapter visibility supplies and which it cannot.
 */
describe("trajectoryCoverage", () => {
  it("full visibility exposes the whole field catalog", () => {
    const coverage = trajectoryCoverage("full");
    expect(coverage.available_fields).toEqual(TRAJECTORY_FIELDS);
    expect(coverage.unavailable_fields).toEqual([]);
    expect(coverage.ratio).toBe(1);
  });

  it("summarized visibility hides the step-level fields", () => {
    const coverage = trajectoryCoverage("summarized");
    expect(coverage.available_fields).toEqual([
      "outcome",
      "termination_reason",
      "usage",
      "tool_activity_summary",
    ]);
    expect(coverage.unavailable_fields).toEqual([
      "step_sequence",
      "tool_validity",
      "repeat_detection",
    ]);
  });

  it("external-only visibility exposes only Harness-observed fields", () => {
    const coverage = trajectoryCoverage("external-only");
    expect(coverage.available_fields).toEqual(["outcome", "termination_reason", "usage"]);
    expect(coverage.unavailable_fields).toContain("tool_activity_summary");
    expect(coverage.ratio).toBeCloseTo(3 / TRAJECTORY_FIELDS.length, 6);
  });

  it("orders available fields in catalog order for every visibility", () => {
    for (const visibility of ["full", "summarized", "external-only"] as const) {
      const fields = availableFields(visibility);
      const catalogOrder = TRAJECTORY_FIELDS.filter((field) => fields.includes(field));
      expect(fields).toEqual(catalogOrder);
    }
  });
});
