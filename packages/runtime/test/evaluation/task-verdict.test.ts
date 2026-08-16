import { describe, expect, it } from "vitest";

import { buildTaskVerdict } from "../../src/evaluation/task-verdict.js";

const assertion = {
  assertion_id: "assertion_01",
  test_ids: ["test_01"],
  required_gate_ids: ["gate_test"],
  evidence_requirements: ["gate_evidence", "evaluation_evidence"],
} as const;

describe("buildTaskVerdict", () => {
  it("passes only when every atomic assertion, gate and evaluation is proven", () => {
    const verdict = buildTaskVerdict({
      verdictId: "verdict_01",
      iterationId: "iteration_01",
      taskId: "task_01",
      runIds: ["run_01"],
      assertions: [assertion],
      gates: [{ gate_id: "gate_test", passed: true, evidence_id: "evidence_gate" }],
      evaluations: [{ passed: true, evidence_id: "evidence_eval" }],
      createdAt: "2026-08-17T00:00:00.000Z",
    });

    expect(verdict.verdict).toBe("passed");
    expect(verdict.assertion_verdicts).toEqual([
      {
        assertion_id: "assertion_01",
        passed: true,
        test_ids: ["test_01"],
        evidence_ids: ["evidence_eval", "evidence_gate"],
      },
    ]);
    expect(verdict.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("fails rather than inventing proof when a required gate is absent", () => {
    const verdict = buildTaskVerdict({
      verdictId: "verdict_02",
      iterationId: "iteration_01",
      taskId: "task_01",
      runIds: ["run_01"],
      assertions: [assertion],
      gates: [],
      evaluations: [{ passed: true, evidence_id: "evidence_eval" }],
      createdAt: "2026-08-17T00:00:00.000Z",
    });

    expect(verdict.verdict).toBe("failed");
    expect(verdict.assertion_verdicts[0]?.passed).toBe(false);
  });
});
