import { afterEach, describe, expect, it } from "vitest";

import {
  LedgerRepository,
  canonicalizeJson,
  contentDigest,
  type NodeRecord,
} from "@universal-harness-internal/core";
import { createGraphReadPorts, materializeLedger } from "@universal-harness-internal/graph";

import { backfillEvaluationGraph } from "../src/index.js";
import { FIXED_NOW, cleanupDirectories, headOf, makeRepo } from "./bootstrap/helpers.js";

afterEach(cleanupDirectories);

function node(id: string, type: NodeRecord["type"]): NodeRecord {
  const content = {
    protocol_version: "1.0.0",
    record_kind: "node",
    id,
    type,
    revision: 1,
    status: "accepted",
    source: "workflow",
    provenance: {
      iteration_id: "iteration_01",
      actor: "evaluation-backfill-test",
      timestamp: FIXED_NOW,
    },
    confidence: 1,
  };
  return { ...content, digest: contentDigest(content) } as NodeRecord;
}

describe("evaluation graph backfill", () => {
  it("projects five-dimension verdict details from historical evaluation evidence", async () => {
    const projectRoot = makeRepo({ "README.md": "# fixture\n" });
    const task = node("task_01", "Task");
    const run = node("run_01", "Run");
    const dimensions = ["outcome", "safety", "trajectory", "correct_failure", "efficiency"].map(
      (dimension) => ({
        dimension,
        available: true,
        score: 1,
        threshold: dimension === "efficiency" ? 0 : 1,
        passed: true,
        mandatory: dimension === "outcome" || dimension === "safety",
        deterministic: true,
        scorer: `deterministic/${dimension}`,
        reason: `${dimension} passed`,
        confidence: null,
      }),
    );
    const extension = {
      case_id: "case_01",
      case_digest: "b".repeat(64),
      visibility: "full",
      coverage: {
        visibility: "full",
        available_fields: [
          "outcome",
          "termination_reason",
          "usage",
          "tool_activity_summary",
          "step_sequence",
          "tool_validity",
          "repeat_detection",
        ],
        unavailable_fields: [],
        ratio: 1,
      },
      dimensions,
      mandatory_failures: [],
      passed: true,
    };
    const evidence = {
      protocol_version: "1.0.0",
      record_kind: "evidence",
      evidence_id: "evidence_evaluation_01",
      evidence_type: "evaluation_report",
      subject_id: task.id,
      digest: contentDigest({
        evidence_type: "evaluation_report",
        subject_id: task.id,
        extension,
      }),
      provisional: false,
      created_at: FIXED_NOW,
      extensions: { "harness.evaluation": extension },
    };
    const runResult = { outcome: "handoff", summary: "historical run" };
    const evaluateArtifact = {
      record_kind: "orchestration_evaluate_result",
      iteration_id: "iteration_01",
      run_digest: contentDigest(runResult),
      result: {
        evidenceId: evidence.evidence_id,
        passed: true,
        mandatoryFailures: [],
        findings: [],
        summary: "passed",
        record: evidence,
      },
    };
    await new LedgerRepository({
      projectRoot,
      readBaseline: () => headOf(projectRoot),
      now: () => FIXED_NOW,
    }).commit({
      ledger_operation_id: "ledger-history_01",
      workflow_operation_id: "workflow-history_01",
      attempt_id: "attempt-history_01",
      expected_baseline: headOf(projectRoot),
      artifacts: [
        { path: "artifacts/tasks/task_01.json", content: `${canonicalizeJson(task)}\n` },
        { path: "artifacts/runs/run_01.json", content: `${canonicalizeJson(run)}\n` },
        {
          path: "artifacts/run-results/run_01.json",
          content: `${canonicalizeJson(runResult)}\n`,
        },
        {
          path: `artifacts/evaluations/${evidence.evidence_id}/${evidence.digest}.json`,
          content: `${canonicalizeJson(evidence)}\n`,
        },
        {
          path: `artifacts/evaluate/iteration_01/${contentDigest(runResult)}.json`,
          content: `${canonicalizeJson(evaluateArtifact)}\n`,
        },
      ],
      edges: [],
      events: [],
    });

    await backfillEvaluationGraph({
      projectRoot,
      readBaseline: () => headOf(projectRoot),
      now: () => FIXED_NOW,
    });

    const graph = materializeLedger({ projectRoot, databasePath: ":memory:" });
    try {
      const [verdict] = createGraphReadPorts(graph.database).evaluation.page().items;
      expect(verdict).toMatchObject({
        runId: run.id,
        caseId: "case_01",
        fresh: true,
        dimensions: dimensions.map(({ dimension }) =>
          expect.objectContaining({ dimension, passed: true }),
        ),
        mandatoryFailures: [],
        coverage: expect.objectContaining({ ratio: 1 }),
      });
    } finally {
      graph.database.close();
    }
  });
});
