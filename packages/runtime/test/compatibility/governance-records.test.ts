import { describe, expect, it } from "vitest";

import {
  governanceMigrationReasons,
  projectLegacySnapshotTruth,
} from "../../src/compatibility/governance-records.js";

describe("governance record compatibility", () => {
  it("reads a legacy completed snapshot without granting it new execution authority", () => {
    const projection = projectLegacySnapshotTruth({
      protocol_version: "1.0.0",
      record_kind: "snapshot",
      snapshot_id: "snapshot_legacy",
      iteration_id: "iteration_legacy",
      status: "completed",
      final_commit: "abcdef1234567",
      run_outcomes: [
        { id: "task_legacy", outcome: "success" },
        { id: "run_legacy", outcome: "handoff" },
      ],
    });

    expect(projection).toEqual({
      legacy_inferred: true,
      source_commit: "abcdef1234567",
      run_outcomes: [{ id: "run_legacy", outcome: "handoff" }],
      task_verdicts: [{ task_id: "task_legacy", verdict: "passed", legacy_inferred: true }],
      usable_for_execution: false,
    });
  });

  it("requires migration for an open plan missing the new authority chain", () => {
    expect(
      governanceMigrationReasons({
        plan: { mode: "direct" },
        contexts: [{ record_kind: "context_bundle", task_id: "task_legacy" }],
        authorizationRecords: [],
        grantRecords: [],
      }),
    ).toEqual([
      "execution_kind_missing",
      "atomic_acceptance_missing",
      "task_context_manifest_missing:task_legacy",
      "execution_authorization_missing",
      "capability_grant_missing",
    ]);
  });
});
