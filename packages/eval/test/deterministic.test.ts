import { describe, expect, it } from "vitest";

import { defineEvaluationCase, type EvaluationCase } from "../src/case.js";
import { scoreCorrectFailure } from "../src/deterministic/correct-failure.js";
import { scoreEfficiency } from "../src/deterministic/efficiency.js";
import { scoreOutcome } from "../src/deterministic/outcome.js";
import { scoreSafety } from "../src/deterministic/safety.js";
import { scoreTrajectory } from "../src/deterministic/trajectory.js";
import type { RunEvaluationInput, ScorerContext } from "../src/scorer.js";

import { BUDGET, cleanTrajectory, makeRun } from "./scenarios.js";

/**
 * Deterministic scorers (design 16.1): outcome, safety, visible trajectory,
 * correct failure and efficiency, scored independently.
 */
function contextFor(
  spec: Partial<Parameters<typeof defineEvaluationCase>[0]>,
  input: RunEvaluationInput,
): ScorerContext {
  const evalCase: EvaluationCase = defineEvaluationCase({
    case_id: "case_unit",
    subject_id: "task_unit",
    expected_outcomes: ["success"],
    ...spec,
  });
  return { case: evalCase, input };
}

function fullInput(run: ReturnType<typeof makeRun>): RunEvaluationInput {
  return { run, visibility: "full", budget: BUDGET, trajectory: cleanTrajectory() };
}

describe("scoreOutcome", () => {
  it("passes when the terminal outcome is expected", () => {
    const score = scoreOutcome(contextFor({}, fullInput(makeRun("success", "completion"))));
    expect(score).toMatchObject({ score: 1, passed: true, available: true });
  });

  it("fails when the terminal outcome is not expected", () => {
    const score = scoreOutcome(contextFor({}, fullInput(makeRun("failed", "adapter_failure"))));
    expect(score.score).toBe(0);
    expect(score.passed).toBe(false);
    expect(score.reason).toContain("failed");
  });
});

describe("scoreSafety", () => {
  it("passes a clean run", () => {
    const score = scoreSafety(contextFor({}, fullInput(makeRun("success", "completion"))));
    expect(score.score).toBe(1);
  });

  it("fails a run with undeclared writes", () => {
    const run = makeRun("failed", "adapter_failure", {
      completion_claimed: false,
      undeclared_writes: ["secrets.txt"],
    });
    const score = scoreSafety(contextFor({}, fullInput(run)));
    expect(score.score).toBe(0);
    expect(score.reason).toContain("secrets.txt");
  });

  it("fails a completion claim on a failed run", () => {
    const run = makeRun("failed", "adapter_failure", { completion_claimed: true });
    expect(scoreSafety(contextFor({}, fullInput(run))).score).toBe(0);
  });
});

describe("scoreTrajectory", () => {
  it("passes a clean full-visibility trajectory", () => {
    const score = scoreTrajectory(contextFor({}, fullInput(makeRun("success", "completion"))));
    expect(score).toMatchObject({ score: 1, available: true });
  });

  it("penalizes invalid and repeated calls", () => {
    const input: RunEvaluationInput = {
      run: makeRun("success", "completion"),
      visibility: "full",
      budget: BUDGET,
      trajectory: [
        { tool: "tool:fs", valid: true, repeated: false },
        { tool: "tool:fs", valid: false, repeated: false },
        { tool: "tool:fs", valid: true, repeated: true },
        { tool: "tool:fs", valid: true, repeated: false },
      ],
    };
    const score = scoreTrajectory(contextFor({}, input));
    expect(score.score).toBe(0.5);
  });

  it("is unavailable for summarized and external-only visibility", () => {
    for (const visibility of ["summarized", "external-only"] as const) {
      const score = scoreTrajectory(
        contextFor(
          { mandatory: ["trajectory"] },
          { run: makeRun("success", "completion"), visibility, budget: BUDGET },
        ),
      );
      expect(score.available).toBe(false);
      expect(score.score).toBeNull();
      expect(score.passed).toBe(false);
    }
  });

  it("does not block on unavailable data when the dimension is advisory", () => {
    const score = scoreTrajectory(
      contextFor(
        {},
        {
          run: makeRun("success", "completion"),
          visibility: "external-only",
          budget: BUDGET,
        },
      ),
    );
    expect(score.available).toBe(false);
    expect(score.passed).toBe(true);
  });
});

describe("scoreCorrectFailure", () => {
  it("passes vacuously when no failure-class outcome is expected", () => {
    const score = scoreCorrectFailure(contextFor({}, fullInput(makeRun("success", "completion"))));
    expect(score).toMatchObject({ score: 1, available: true });
  });

  it.each([
    ["clarification_required", "completion"],
    ["correct_block", "policy_denial"],
    ["handoff", "adapter_failure"],
    ["partial", "budget_ceiling"],
    ["failed", "repeat_detection"],
  ] as const)("passes a correct %s via %s", (outcome, termination) => {
    const score = scoreCorrectFailure(
      contextFor({ expected_outcomes: [outcome] }, fullInput(makeRun(outcome, termination))),
    );
    expect(score.score).toBe(1);
  });

  it("fails the right outcome with the wrong termination", () => {
    const score = scoreCorrectFailure(
      contextFor(
        { expected_outcomes: ["correct_block"] },
        fullInput(makeRun("correct_block", "timeout")),
      ),
    );
    expect(score.score).toBe(0);
    expect(score.reason).toContain("policy_denial");
  });

  it("fails a run that succeeds where failure was expected", () => {
    const score = scoreCorrectFailure(
      contextFor(
        { expected_outcomes: ["clarification_required"] },
        fullInput(makeRun("success", "completion")),
      ),
    );
    expect(score.score).toBe(0);
  });
});

describe("scoreEfficiency", () => {
  it("scores one minus the worst budget utilization", () => {
    const score = scoreEfficiency(contextFor({}, fullInput(makeRun("success", "completion"))));
    // tokens 1200/4000 = 0.3, duration 15000/60000 = 0.25, steps 3/10 = 0.3
    expect(score.score).toBe(0.7);
    expect(score.reason).toContain("30%");
  });

  it("scores zero at the ceiling", () => {
    const run = makeRun("partial", "budget_ceiling", {
      usage: {
        input_tokens: 3000,
        output_tokens: 1000,
        total_tokens: 4000,
        duration_ms: 60_000,
        metering: "provider_reported",
      },
    });
    expect(scoreEfficiency(contextFor({}, fullInput(run))).score).toBe(0);
  });

  it("discloses unmetered tokens instead of treating them as zero use", () => {
    const run = makeRun("handoff", "completion", {
      usage: {
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        duration_ms: 15_000,
        metering: "unmetered",
      },
    });
    const score = scoreEfficiency(contextFor({}, fullInput(run)));
    expect(score.reason).toContain("unmetered");
    expect(score.score).toBe(0.7);
  });
});
