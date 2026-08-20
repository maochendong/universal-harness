import { describe, expect, it } from "vitest";

import type { LifecycleEvent } from "../../../core/src/index.js";
import {
  ORCHESTRATION_PHASES,
  PHASE_CHECKPOINT_BOUNDARY,
  PHASE_OPERATION_STATE,
  assertLifecycleOrder,
  isOrchestrationPhase,
  nextPhase,
  phaseLifecycleEvents,
  phaseRank,
} from "../../src/index.js";

/** Phase metadata and lifecycle-event ordering units (plan Task 23). */
describe("orchestration phases", () => {
  it("orders the pipeline phases deterministically", () => {
    expect(ORCHESTRATION_PHASES).toEqual([
      "capture",
      "impact",
      "design",
      "plan",
      "context",
      "execute",
      "verify",
      "evaluate",
      "snapshot",
    ]);
    expect(phaseRank("capture")).toBe(0);
    expect(phaseRank("snapshot")).toBe(ORCHESTRATION_PHASES.length - 1);
    expect(nextPhase("capture")).toBe("impact");
    expect(nextPhase("impact")).toBe("design");
    expect(nextPhase("design")).toBe("plan");
    expect(nextPhase("snapshot")).toBeUndefined();
  });

  it("recognizes only known phases", () => {
    expect(isOrchestrationPhase("verify")).toBe(true);
    expect(isOrchestrationPhase("deploy")).toBe(false);
    expect(isOrchestrationPhase(42)).toBe(false);
  });

  it("maps every phase to a checkpoint boundary and an operation state", () => {
    for (const phase of ORCHESTRATION_PHASES) {
      expect(PHASE_CHECKPOINT_BOUNDARY[phase]).toBeDefined();
      expect(PHASE_OPERATION_STATE[phase]).toBeDefined();
    }
    expect(PHASE_CHECKPOINT_BOUNDARY.verify).toBe("gate");
    expect(PHASE_CHECKPOINT_BOUNDARY.snapshot).toBe("snapshot");
    expect(PHASE_OPERATION_STATE.execute).toBe("running");
    expect(PHASE_OPERATION_STATE.evaluate).toBe("verifying");
  });
});

describe("phase lifecycle events", () => {
  it("emits BeforeContextCompile before ContextCompiled", () => {
    const events = phaseLifecycleEvents({
      phase: "context",
      contextBundleId: "bundle_1",
      contextBundleDigest: "d".repeat(64),
      includedTokens: 10,
    });
    expect(events.map((event) => event.eventType)).toEqual([
      "BeforeContextCompile",
      "ContextCompiled",
    ]);
  });

  it("emits one GateCompleted per gate in suite order", () => {
    const events = phaseLifecycleEvents({
      phase: "verify",
      gates: [
        { gateId: "gate_a", passed: true },
        { gateId: "gate_b", passed: false },
      ],
    });
    expect(events.map((event) => event.eventType)).toEqual(["GateCompleted", "GateCompleted"]);
    expect(events[1]?.payload["passed"]).toBe(false);
  });

  it("emits EvaluationCompleted followed by FindingCreated per finding", () => {
    const events = phaseLifecycleEvents({
      phase: "evaluate",
      caseId: "case_x",
      passed: false,
      findingIds: ["finding_a", "finding_b"],
    });
    expect(events.map((event) => event.eventType)).toEqual([
      "EvaluationCompleted",
      "FindingCreated",
      "FindingCreated",
    ]);
  });

  it("accepts strictly increasing sequences and rejects disorder", () => {
    const event = (sequence: number): LifecycleEvent =>
      ({
        event_id: `event_${String(sequence)}`,
        event_type: "CheckpointCommitted",
        sequence,
        workflow_operation_id: "workflow_1",
      }) as unknown as LifecycleEvent;
    expect(() => assertLifecycleOrder([event(1), event(2), event(5)])).not.toThrow();
    expect(() => assertLifecycleOrder([event(2), event(2)])).toThrow(/not ordered/u);
    expect(() => assertLifecycleOrder([event(3), event(1)])).toThrow(/not ordered/u);
  });
});
