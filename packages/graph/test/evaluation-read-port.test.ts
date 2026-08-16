import { beforeAll, describe, expect, it } from "vitest";

import { createGraphReadPorts, materializeLedger, type Materialization } from "../src/index.js";

import { commitEvaluationScenario, commitScenario, makeProjectRoot } from "./fixtures.js";

describe("evaluation read port", () => {
  let materialization: Materialization;

  beforeAll(async () => {
    const projectRoot = makeProjectRoot();
    await commitScenario(projectRoot);
    await commitEvaluationScenario(projectRoot);
    materialization = materializeLedger({ projectRoot, databasePath: ":memory:" });
    return () => {
      materialization.database.close();
    };
  });

  it("summarizes each Run's five-dimension verdict, case, Evidence, coverage, and freshness", () => {
    const port = createGraphReadPorts(materialization.database).evaluation;

    expect(port.page({ iterationId: "iteration_01" }).items).toEqual([
      {
        runId: "run_01",
        subjectId: "task_01",
        caseId: "case_01",
        caseDigest: "b".repeat(64),
        evidenceId: "evidence_evaluation_01",
        evidenceDigest: "a".repeat(64),
        status: "accepted",
        passed: true,
        provisional: false,
        fresh: true,
        visibility: "full",
        dimensions: expect.arrayContaining([
          expect.objectContaining({ dimension: "outcome", score: 1, passed: true }),
          expect.objectContaining({ dimension: "safety", score: 1, passed: true }),
          expect.objectContaining({ dimension: "trajectory", score: 0.75, passed: true }),
          expect.objectContaining({ dimension: "correct_failure", score: 1, passed: true }),
          expect.objectContaining({ dimension: "efficiency", score: 0.8, passed: true }),
        ]),
        mandatoryFailures: [],
        coverage: {
          visibility: "full",
          availableFields: [
            "outcome",
            "termination_reason",
            "usage",
            "tool_activity_summary",
            "step_sequence",
            "tool_validity",
            "repeat_detection",
          ],
          unavailableFields: [],
          ratio: 1,
        },
      },
    ]);
    expect(port.coverage({ iterationId: "iteration_01" })).toEqual({
      evaluated: 1,
      total: 2,
      ratio: 0.5,
    });
  });

  it("never presents an incomplete historical verdict as fresh five-dimension evidence", async () => {
    const projectRoot = makeProjectRoot();
    await commitScenario(projectRoot);
    await commitEvaluationScenario(projectRoot, { includeVerdictDetails: false });
    const legacy = materializeLedger({ projectRoot, databasePath: ":memory:" });
    try {
      const [verdict] = createGraphReadPorts(legacy.database).evaluation.page().items;
      expect(verdict).toMatchObject({
        runId: "run_01",
        dimensions: [],
        fresh: false,
      });
      expect(verdict?.coverage).toBeUndefined();
    } finally {
      legacy.database.close();
    }
  });
});
