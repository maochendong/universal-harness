import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { contentDigest } from "../../packages/core/src/index.js";
import {
  assessImpactCoverage,
  buildSnapshot,
  buildTaskVerdict,
  deriveActualRunChanges,
  reconcileLiveBlockers,
} from "../../packages/runtime/src/index.js";

interface ScenarioTask {
  readonly task_id: string;
  readonly run_id: string;
  readonly assertion_id: string;
  readonly test_id: string;
  readonly gate_id: string;
}

interface Scenario {
  readonly profile: {
    readonly control: "delegated";
    readonly trajectory_visibility: "external-only";
    readonly usage_metering: false;
    readonly side_effect_interception: false;
  };
  readonly impact_entries: readonly {
    readonly node_id: string;
    readonly node_type: "Intent" | "Requirement" | "Test";
    readonly risk: "medium" | "high";
  }[];
  readonly forecast_paths: readonly {
    readonly pattern: string;
    readonly scope: "bounded";
    readonly approved: true;
  }[];
  readonly approved_write_paths: readonly string[];
  readonly changed_paths: readonly string[];
  readonly rename: { readonly from: string; readonly to: string };
  readonly binary_path: string;
  readonly scope_drift_path: string;
  readonly tasks: readonly ScenarioTask[];
}

const SCENARIO = JSON.parse(
  readFileSync(new URL("../golden/atlas-t8-shaped-run/scenario.json", import.meta.url), "utf8"),
) as Scenario;

describe("execution governance vertical truth loop", () => {
  it("blocks incomplete/drifted work, then preserves handoff while accepting a proven task", () => {
    expect(
      assessImpactCoverage({
        executionKind: "agent",
        entries: SCENARIO.impact_entries,
        forecastPaths: [],
      }),
    ).toMatchObject({ status: "partial", missing_layers: ["implementation_or_path"] });

    const coverage = assessImpactCoverage({
      executionKind: "agent",
      entries: SCENARIO.impact_entries,
      forecastPaths: SCENARIO.forecast_paths,
    });
    expect(coverage.status).toBe("complete");

    const verifiedFiles = [
      ...SCENARIO.changed_paths.map((path) => ({
        path,
        status: "modified" as const,
        insertions: 1,
        deletions: 1,
      })),
      {
        path: SCENARIO.rename.to,
        previousPath: SCENARIO.rename.from,
        status: "renamed" as const,
        insertions: 0,
        deletions: 0,
      },
      {
        path: SCENARIO.binary_path,
        status: "modified" as const,
        insertions: 0,
        deletions: 0,
        binary: true,
      },
    ];
    const driftedChanges = deriveActualRunChanges(
      { from: "a".repeat(40), to: "worktree", files: [], insertions: 0, deletions: 0 },
      {
        from: "a".repeat(40),
        to: "worktree",
        files: [
          ...verifiedFiles,
          {
            path: SCENARIO.scope_drift_path,
            status: "added",
            insertions: 1,
            deletions: 0,
          },
        ],
        insertions: 29,
        deletions: 28,
      },
      SCENARIO.approved_write_paths,
    );
    expect(driftedChanges.undeclared_writes).toEqual([SCENARIO.scope_drift_path]);

    const verifiedChanges = deriveActualRunChanges(
      { from: "a".repeat(40), to: "worktree", files: [], insertions: 0, deletions: 0 },
      {
        from: "a".repeat(40),
        to: "worktree",
        files: verifiedFiles,
        insertions: 28,
        deletions: 28,
      },
      SCENARIO.approved_write_paths,
    );
    expect(verifiedChanges.change_summary.files_changed).toBe(30);
    expect(verifiedChanges.renamed_paths).toEqual([
      { from: SCENARIO.rename.from, to: SCENARIO.rename.to },
    ]);
    expect(verifiedChanges.binary_paths).toEqual([SCENARIO.binary_path]);

    const verdicts = SCENARIO.tasks.map((task) =>
      buildTaskVerdict({
        verdictId: `verdict_${task.task_id.slice("task_".length)}`,
        iterationId: "iteration_01",
        taskId: task.task_id,
        runIds: [task.run_id],
        assertions: [
          {
            assertion_id: task.assertion_id,
            test_ids: [task.test_id],
            required_gate_ids: [task.gate_id],
            evidence_requirements: ["gate_evidence", "evaluation_evidence"],
          },
        ],
        gates: [{ gate_id: task.gate_id, passed: true, evidence_id: `evidence_${task.gate_id}` }],
        evaluations: [{ passed: true, evidence_id: `evidence_${task.task_id}` }],
        createdAt: "2026-08-17T00:00:00.000Z",
      }),
    );
    expect(verdicts.map((verdict) => verdict.verdict)).toEqual(["passed", "passed", "passed"]);
    expect(
      reconcileLiveBlockers({
        blocker_messages: SCENARIO.tasks.map(
          (task) => `task ${task.task_id} did not complete: prior attempt`,
        ),
        passed_task_ids: verdicts.map((verdict) => verdict.task_id),
      }),
    ).toEqual([]);

    const snapshot = buildSnapshot({
      snapshot_id: "snapshot_01",
      iteration_id: "iteration_01",
      source_commit: "0123456789abcdef0123456789abcdef01234567",
      workflow_operation_id: "workflow_01",
      created_at: "2026-08-17T00:00:00.000Z",
      adapter_control_profile: SCENARIO.profile,
      adapter_profile_digest: contentDigest(SCENARIO.profile),
      tasks: SCENARIO.tasks.map((task) => ({
        task_id: task.task_id,
        required: true,
        outcome: "handoff" as const,
      })),
      runs: SCENARIO.tasks.map((task) => ({
        run_id: task.run_id,
        required: true,
        outcome: "handoff" as const,
      })),
      task_verdicts: verdicts.map((verdict) => ({
        verdict_id: verdict.verdict_id,
        task_id: verdict.task_id,
        verdict: verdict.verdict,
      })),
      evidence: [
        {
          evidence_id: "evidence_gate",
          mandatory: true,
          passed: true,
          provisional: false,
          stale: false,
        },
      ],
      budget_observations: [
        {
          dimension: "steps",
          availability: "unavailable",
          used: null,
          limit: 30,
          enforcement: "none",
        },
        {
          dimension: "tokens",
          availability: "unavailable",
          used: null,
          limit: 120000,
          enforcement: "none",
        },
        {
          dimension: "duration_ms",
          availability: "measured",
          used: 390000,
          limit: 2700000,
          enforcement: "harness",
        },
      ],
    });
    expect(snapshot).toMatchObject({
      status: "completed",
      run_outcomes: SCENARIO.tasks.map((task) => ({ id: task.run_id, outcome: "handoff" })),
      task_verdicts: SCENARIO.tasks.map((task) => ({
        task_id: task.task_id,
        verdict: "passed",
      })),
    });
    expect(snapshot).not.toHaveProperty("ledger_commit");
  });
});
