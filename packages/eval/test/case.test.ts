import { describe, expect, it } from "vitest";

import {
  DEFAULT_MANDATORY,
  DEFAULT_THRESHOLDS,
  EvaluationError,
  defineEvaluationCase,
} from "../src/case.js";

/**
 * EvaluationCase normalization (plan Task 20): structural validation, sealed
 * defaults and a deterministic content digest.
 */
describe("defineEvaluationCase", () => {
  it("applies default mandatory dimensions and thresholds", () => {
    const evalCase = defineEvaluationCase({
      case_id: "case_defaults",
      subject_id: "task_subject",
      expected_outcomes: ["success"],
    });
    expect(evalCase.mandatory).toEqual(DEFAULT_MANDATORY);
    expect(evalCase.thresholds).toEqual(DEFAULT_THRESHOLDS);
  });

  it("is deterministic: same definition, same digest", () => {
    const spec = {
      case_id: "case_digest",
      subject_id: "task_subject",
      expected_outcomes: ["success", "handoff"],
      mandatory: ["outcome", "trajectory"],
      thresholds: { trajectory: 0.5 },
    } as const;
    expect(defineEvaluationCase(spec).digest).toBe(defineEvaluationCase(spec).digest);
    expect(defineEvaluationCase(spec).thresholds.trajectory).toBe(0.5);
    expect(defineEvaluationCase(spec).thresholds.outcome).toBe(1);
  });

  it("changes its digest when any expectation or threshold changes", () => {
    const base = defineEvaluationCase({
      case_id: "case_drift",
      subject_id: "task_subject",
      expected_outcomes: ["success"],
    });
    const tightened = defineEvaluationCase({
      case_id: "case_drift",
      subject_id: "task_subject",
      expected_outcomes: ["success"],
      thresholds: { efficiency: 0.5 },
    });
    expect(tightened.digest).not.toBe(base.digest);
  });

  it("rejects malformed identifiers, empty outcomes and out-of-range thresholds", () => {
    expect(() =>
      defineEvaluationCase({
        case_id: "not-a-case-id",
        subject_id: "task_subject",
        expected_outcomes: ["success"],
      }),
    ).toThrowError(EvaluationError);
    expect(() =>
      defineEvaluationCase({
        case_id: "case_empty",
        subject_id: "task_subject",
        expected_outcomes: [],
      }),
    ).toThrowError(EvaluationError);
    expect(() =>
      defineEvaluationCase({
        case_id: "case_range",
        subject_id: "task_subject",
        expected_outcomes: ["success"],
        thresholds: { safety: 1.5 },
      }),
    ).toThrowError(EvaluationError);
  });
});
