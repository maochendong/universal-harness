import { describe, expect, it } from "vitest";

import { hasIndependentValue } from "@universal-harness-internal/runtime";

import { buildFindingRecord, FeedbackError } from "../../src/feedback/finding.js";
import { analyzeRootCause } from "../../src/feedback/rca.js";
import {
  OWNER_PHASE,
  TARGET_LAYERS,
  assertWriteAllowed,
  ownerPhaseForLayer,
  routeRevisionTask,
  type DeliveryPhase,
  type TargetLayer,
} from "../../src/feedback/router.js";

import { TIMESTAMP_CLOCK, findingSpec } from "./fixtures.js";

function diagnosed(layer: "stack" | "project" | "universal") {
  const finding = buildFindingRecord(findingSpec());
  return analyzeRootCause({
    id: "rca_build",
    finding,
    signal: { origin: "test", gateLayer: layer },
    clock: TIMESTAMP_CLOCK,
  });
}

/**
 * Owner-phase routing (design 9.1 and principle 5, plan Task 21, completion
 * rule 17): every target layer has one owning phase; downstream writers are
 * rejected and repairs route back as declarative revision Tasks.
 */
describe("owner-phase routing", () => {
  it("assigns every target layer exactly one owning phase", () => {
    const expected: Record<TargetLayer, DeliveryPhase> = {
      prd: "prd",
      architecture: "architecture",
      spec: "spec",
      plan: "plan",
      policy: "architecture",
      tool: "plan",
      test: "verification",
      eval: "verification",
    };
    for (const layer of TARGET_LAYERS) {
      expect(ownerPhaseForLayer(layer)).toBe(expected[layer]);
      expect(OWNER_PHASE[layer]).toBe(expected[layer]);
    }
  });

  it("forbids downstream phases from writing upstream artifacts", () => {
    for (const writer of ["spec", "plan", "implementation", "verification"] as const) {
      expect(() => assertWriteAllowed(writer, "prd")).toThrowError(
        expect.objectContaining({ kind: "upstream_write_forbidden" }) as FeedbackError,
      );
    }
    expect(() => assertWriteAllowed("implementation", "spec")).toThrowError(FeedbackError);
  });

  it("allows owner-phase and upstream writes", () => {
    expect(() => assertWriteAllowed("prd", "prd")).not.toThrow();
    expect(() => assertWriteAllowed("architecture", "policy")).not.toThrow();
    expect(() => assertWriteAllowed("verification", "test")).not.toThrow();
    expect(() => assertWriteAllowed("prd", "eval")).not.toThrow();
  });
});

describe("routeRevisionTask", () => {
  it("routes a stack gate repair back to the architecture phase", () => {
    const routing = routeRevisionTask({
      rca: diagnosed("stack"),
      targetNodeIds: ["component_builder"],
      taskId: "task_revise-builder",
    });
    expect(routing.owner_phase).toBe("architecture");
    expect(routing.responsible_layer).toBe("architecture");
    expect(routing.task.objective).toContain("implementation_defect");
    expect(routing.task.expected_outputs).toEqual(["component_builder"]);
    expect(routing.task.acceptance[0]?.verification).toContain("re-run the failed stack gate");
    expect(hasIndependentValue(routing.task)).toBe(true);
  });

  it("escalates task risk when the diagnosis requires human review", () => {
    const routing = routeRevisionTask({
      rca: diagnosed("universal"),
      targetNodeIds: ["constraint_traceability"],
      taskId: "task_revise-spec",
    });
    expect(routing.owner_phase).toBe("spec");
    expect(routing.task.risk).toBe("high");
  });

  it("sorts target nodes and rejects an empty target set", () => {
    const routing = routeRevisionTask({
      rca: diagnosed("project"),
      targetNodeIds: ["test_b", "test_a"],
      taskId: "task_revise-tests",
    });
    expect(routing.owner_phase).toBe("verification");
    expect(routing.task.expected_outputs).toEqual(["test_a", "test_b"]);
    expect(() =>
      routeRevisionTask({ rca: diagnosed("project"), targetNodeIds: [], taskId: "task_revise-x" }),
    ).toThrowError(expect.objectContaining({ kind: "invalid_revision_task" }) as FeedbackError);
  });
});
