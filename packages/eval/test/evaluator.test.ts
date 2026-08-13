import { describe, expect, it } from "vitest";

import { validateSchema } from "@universal-harness-internal/core";

import { EvaluationError, defineEvaluationCase } from "../src/case.js";
import {
  EVALUATION_EVIDENCE_TYPE,
  evaluateRun,
  readEvaluationEvidenceExtension,
} from "../src/evaluator.js";
import { dimensionScore, type Scorer } from "../src/scorer.js";

import { FIXED_TIMESTAMP, evaluateScenario, scenarioByName } from "./scenarios.js";

/**
 * Evaluator (design 16.1, plan Task 20): independent dimension scoring,
 * coverage disclosure, mandatory threshold Findings and a schema-valid
 * evidence record; semantic scorers stay optional and never gate by default.
 */
describe("evaluateRun", () => {
  it("passes the success scenario with full coverage and no findings", () => {
    const report = evaluateScenario(scenarioByName("success"));
    expect(report.passed).toBe(true);
    expect(report.mandatory_failures).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(report.coverage.ratio).toBe(1);
  });

  it("scores the five dimensions independently", () => {
    const report = evaluateScenario(scenarioByName("success"));
    expect(report.dimensions.map((score) => score.dimension)).toEqual([
      "outcome",
      "safety",
      "trajectory",
      "correct_failure",
      "efficiency",
    ]);
    expect(report.dimensions.every((score) => score.deterministic)).toBe(true);
  });

  it("creates a proposed Finding per failed mandatory dimension", () => {
    const report = evaluateScenario(scenarioByName("malformed-tool"));
    expect(report.passed).toBe(false);
    expect(report.mandatory_failures).toEqual(["trajectory"]);
    expect(report.findings).toHaveLength(1);
    const finding = report.findings[0];
    expect(finding?.type).toBe("Finding");
    expect(finding?.status).toBe("proposed");
    expect(finding?.id).toBe("finding_malformed-tool-trajectory");
    expect(finding?.summary).toContain("case_malformed-tool");
    expect(validateSchema("feedback", finding).valid).toBe(true);
  });

  it("seals the report in a schema-valid, content-digested evidence record", () => {
    const report = evaluateScenario(scenarioByName("success"));
    expect(report.evidence.evidence_type).toBe(EVALUATION_EVIDENCE_TYPE);
    expect(report.evidence.subject_id).toBe("task_build-feature");
    expect(validateSchema("runtime", report.evidence).valid).toBe(true);
    const extension = readEvaluationEvidenceExtension(report.evidence);
    expect(extension?.case_digest).toHaveLength(64);
    expect(extension?.coverage).toEqual(report.coverage);
  });

  it("is deterministic: identical inputs produce identical digests", () => {
    const scenario = scenarioByName("malformed-tool");
    const first = evaluateScenario(scenario);
    const second = evaluateScenario(scenario);
    expect(second.evidence.digest).toBe(first.evidence.digest);
    expect(second.findings.map((finding) => finding.digest)).toEqual(
      first.findings.map((finding) => finding.digest),
    );
  });

  it("discloses unavailable trajectory fields by adapter visibility", () => {
    const report = evaluateScenario(scenarioByName("handoff"));
    expect(report.coverage.visibility).toBe("external-only");
    expect(report.coverage.unavailable_fields).toContain("step_sequence");
    const trajectory = report.dimensions.find((score) => score.dimension === "trajectory");
    expect(trajectory).toMatchObject({ available: false, score: null });
    // Advisory by default: the unavailable verdict discloses but does not block.
    expect(report.passed).toBe(true);
  });

  it("fails a mandatory dimension whose trajectory is unavailable", () => {
    const scenario = scenarioByName("handoff");
    const report = evaluateRun({
      case: defineEvaluationCase({
        ...scenario.caseSpec,
        mandatory: ["outcome", "trajectory"],
      }),
      input: scenario.input,
      iterationId: "iteration_01",
      clock: () => FIXED_TIMESTAMP,
    });
    expect(report.mandatory_failures).toEqual(["trajectory"]);
    expect(report.findings).toHaveLength(1);
  });

  it("marks evidence provisional when requested", () => {
    const report = evaluateScenario(scenarioByName("success"), { provisional: true });
    expect(report.evidence.provisional).toBe(true);
  });
});

describe("semantic scorers", () => {
  const semanticOutcomeScorer: Scorer = {
    name: "semantic/judge",
    dimension: "outcome",
    deterministic: false,
    score: (context) =>
      dimensionScore(context, "outcome", {
        available: true,
        score: 1,
        reason: "a calibrated judge approved the explanation",
        scorer: "semantic/judge",
        deterministic: false,
        confidence: 0.9,
      }),
  };

  it("records semantic results with their confidence", () => {
    const report = evaluateScenario(scenarioByName("success"), {
      semanticScorers: [semanticOutcomeScorer],
    });
    const semantic = report.dimensions.find((score) => score.scorer === "semantic/judge");
    expect(semantic).toMatchObject({ deterministic: false, confidence: 0.9 });
  });

  it("cannot satisfy a mandatory dimension by default", () => {
    const scenario = scenarioByName("success");
    const failingRun = {
      ...scenario.input,
      run: { ...scenario.input.run, outcome: "failed" as const, completion_claimed: false },
    };
    const report = evaluateScenario(
      { ...scenario, input: failingRun },
      { semanticScorers: [semanticOutcomeScorer] },
    );
    expect(report.mandatory_failures).toEqual(["outcome"]);
    expect(report.passed).toBe(false);
  });

  it("can satisfy a mandatory dimension only when policy allows it", () => {
    const scenario = scenarioByName("success");
    const failingRun = {
      ...scenario.input,
      run: { ...scenario.input.run, outcome: "failed" as const, completion_claimed: false },
    };
    const report = evaluateScenario(
      { ...scenario, input: failingRun },
      { semanticScorers: [semanticOutcomeScorer], allowSemanticForMandatory: true },
    );
    expect(report.mandatory_failures).toEqual([]);
  });

  it("rejects a semantic result without confidence", () => {
    const badScorer: Scorer = {
      name: "semantic/bad",
      dimension: "outcome",
      deterministic: false,
      score: (context) => ({
        ...dimensionScore(context, "outcome", {
          available: true,
          score: 1,
          reason: "no confidence reported",
          scorer: "semantic/bad",
          deterministic: false,
        }),
      }),
    };
    expect(() =>
      evaluateScenario(scenarioByName("success"), { semanticScorers: [badScorer] }),
    ).toThrowError(EvaluationError);
  });
});
