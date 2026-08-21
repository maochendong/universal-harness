import { describe, expect, it } from "vitest";

import {
  DOWNSTREAM_ARTIFACT_KINDS,
  INVALIDATION_MATRIX,
  UPSTREAM_DRIFT_KINDS,
  planDownstreamInvalidation,
  survivesDrift,
} from "../../src/orchestration/invalidation.js";

/**
 * T17 invalidation matrix (designset lifecycle design 14, provable TDD
 * design 11): upstream drift invalidates exactly the derived downstream
 * set, the pipeline re-enters at the earliest affected phase, and no
 * artifact survives a drift of its own authority chain.
 */
describe("downstream invalidation matrix", () => {
  it("invalidates the full derived chain on baseline drift", () => {
    const plan = planDownstreamInvalidation("requirement_baseline");
    expect(plan.resume_phase).toBe("impact");
    expect(plan.invalidated).toEqual(expect.arrayContaining([...DOWNSTREAM_ARTIFACT_KINDS]));
  });

  it("re-enters at the earliest affected phase", () => {
    expect(planDownstreamInvalidation("impact_set").resume_phase).toBe("design");
    expect(planDownstreamInvalidation("design_set").resume_phase).toBe("plan");
    expect(planDownstreamInvalidation("impact_set").invalidated).toContain("design_set");
    expect(planDownstreamInvalidation("design_set").invalidated).not.toContain("impact_set");
  });

  it("never lets a derived artifact survive its own authority drift", () => {
    expect(survivesDrift("design_set", "plan")).toBe(false);
    expect(survivesDrift("design_set", "tdd_cycle")).toBe(false);
    expect(survivesDrift("plan", "context_bundle")).toBe(false);
    expect(survivesDrift("plan", "design_set")).toBe(true);
    expect(survivesDrift("policy", "impact_set")).toBe(true);
  });

  it("covers every drift kind and every artifact kind explicitly", () => {
    for (const kind of UPSTREAM_DRIFT_KINDS) {
      const entry = INVALIDATION_MATRIX[kind];
      expect(entry.invalidated.length).toBeGreaterThan(0);
      for (const artifact of entry.invalidated) {
        expect(DOWNSTREAM_ARTIFACT_KINDS).toContain(artifact);
      }
    }
  });
});
