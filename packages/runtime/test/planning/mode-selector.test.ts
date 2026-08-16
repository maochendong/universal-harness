import { describe, expect, it } from "vitest";

import {
  ModeSelectionError,
  selectExecutionMode,
  type ModeSelectionInput,
} from "../../src/planning/mode-selector.js";

function input(overrides?: Partial<ModeSelectionInput>): ModeSelectionInput {
  return {
    executionKind: "workflow",
    intentShape: "structured",
    hasExistingGraph: true,
    deterministicWork: true,
    taskCount: 1,
    ...overrides,
  };
}

describe("selectExecutionMode", () => {
  it("routes a structured intent with deterministic work to direct", () => {
    const selection = selectExecutionMode(input());
    expect(selection).toEqual({
      mode: "direct",
      restricted: false,
      reason: "structured intent with fully deterministic work runs without an agent loop",
    });
  });

  it("never routes an agent executor to direct even when its task is deterministic", () => {
    const selection = selectExecutionMode(input({ executionKind: "agent" }));
    expect(selection).toEqual({
      mode: "single-loop",
      restricted: false,
      reason: "one bounded agent goal with one independently reviewable output",
    });
  });

  it("routes a deterministic pack conversion to direct", () => {
    const selection = selectExecutionMode(input({ intentShape: "pack-converted" }));
    expect(selection.mode).toBe("direct");
    expect(selection.restricted).toBe(false);
  });

  it("routes free text without an existing graph to a restricted single loop", () => {
    const selection = selectExecutionMode(
      input({ intentShape: "free-text", hasExistingGraph: false }),
    );
    expect(selection.mode).toBe("single-loop");
    expect(selection.restricted).toBe(true);
  });

  it("never skips the restricted capture loop because later steps look deterministic", () => {
    const selection = selectExecutionMode(
      input({
        intentShape: "free-text",
        hasExistingGraph: false,
        deterministicWork: true,
        taskCount: 3,
      }),
    );
    expect(selection.mode).toBe("single-loop");
    expect(selection.restricted).toBe(true);
  });

  it("never routes free text to direct, even with an existing graph", () => {
    const selection = selectExecutionMode(input({ intentShape: "free-text" }));
    expect(selection.mode).toBe("single-loop");
    expect(selection.restricted).toBe(false);
  });

  it("routes one non-deterministic goal to an unrestricted single loop", () => {
    const selection = selectExecutionMode(input({ deterministicWork: false }));
    expect(selection.mode).toBe("single-loop");
    expect(selection.restricted).toBe(false);
  });

  it("routes two or more independent tasks to a sequential dag", () => {
    const selection = selectExecutionMode(input({ deterministicWork: false, taskCount: 3 }));
    expect(selection.mode).toBe("dag");
    expect(selection.restricted).toBe(false);
  });

  it("requires at least one task", () => {
    expect(() => selectExecutionMode(input({ taskCount: 0 }))).toThrow(ModeSelectionError);
  });
});
