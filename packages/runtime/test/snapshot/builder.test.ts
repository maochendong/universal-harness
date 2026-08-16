import { describe, expect, it } from "vitest";
import { contentDigest } from "@universal-harness-internal/core";

import {
  SnapshotError,
  buildSnapshot,
  snapshotCompletionBlockers,
  type SnapshotInput,
} from "../../src/snapshot/builder.js";

const FINAL_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const CREATED_AT = "2026-08-12T00:00:00.000Z";
const PROFILE = {
  control: "delegated",
  trajectory_visibility: "external-only",
  usage_metering: false,
  side_effect_interception: false,
} as const;

function baseInput(overrides?: Partial<SnapshotInput>): SnapshotInput {
  return {
    snapshot_id: "snapshot_01",
    iteration_id: "iteration_01",
    source_commit: FINAL_COMMIT,
    workflow_operation_id: "workflow-op_01",
    created_at: CREATED_AT,
    execution_plan_id: "plan_01",
    adapter_control_profile: PROFILE,
    adapter_profile_digest: contentDigest(PROFILE),
    tasks: [
      { task_id: "task_01", required: true, outcome: "handoff" },
      { task_id: "task_02", required: false, outcome: "partial" },
    ],
    task_verdicts: [
      { verdict_id: "verdict_01", task_id: "task_01", verdict: "passed" },
      { verdict_id: "verdict_02", task_id: "task_02", verdict: "blocked" },
    ],
    runs: [{ run_id: "run_01", required: true, outcome: "handoff" }],
    findings: [{ finding_id: "finding_01", blocking: true, status: "closed" }],
    evidence: [
      {
        evidence_id: "evidence_01",
        mandatory: true,
        passed: true,
        provisional: false,
        stale: false,
      },
    ],
    external_actions: [
      {
        intent_id: "intent-01",
        tool: "git_push",
        request_digest: "a".repeat(64),
        idempotency_key: "key-01",
        status: "completed",
      },
    ],
    approvals: ["decision-digest-01"],
    budget: { used_steps: 3, used_tokens: 1200, ceiling_steps: 10, ceiling_tokens: 5000 },
    budget_observations: [
      {
        dimension: "steps",
        availability: "unavailable",
        used: null,
        limit: 10,
        enforcement: "none",
      },
      {
        dimension: "tokens",
        availability: "unavailable",
        used: null,
        limit: 5000,
        enforcement: "none",
      },
      {
        dimension: "duration_ms",
        availability: "measured",
        used: 15000,
        limit: 60000,
        enforcement: "harness",
      },
    ],
    unresolved_items: ["non-blocking note"],
    improvement_candidates: [{ candidate_id: "improvement_01", status: "proposed" }],
    ...overrides,
  };
}

describe("buildSnapshot", () => {
  it("builds a completed snapshot when evidence allows it", () => {
    const snapshot = buildSnapshot(baseInput());
    expect(snapshot.status).toBe("completed");
    expect(snapshot.final_commit).toBe(FINAL_COMMIT);
    expect(snapshot.source_commit).toBe(FINAL_COMMIT);
    expect(snapshot).not.toHaveProperty("ledger_commit");
    expect(snapshot.run_outcomes).toEqual([{ id: "run_01", outcome: "handoff" }]);
    expect(snapshot.task_verdicts).toEqual([
      { verdict_id: "verdict_01", task_id: "task_01", verdict: "passed" },
      { verdict_id: "verdict_02", task_id: "task_02", verdict: "blocked" },
    ]);
    expect(snapshot.closed_findings).toEqual(["finding_01"]);
    expect(snapshot.evidence).toEqual(["evidence_01"]);
    expect(snapshot.adapter_profile_digest).toBe(contentDigest(PROFILE));
    expect(snapshot.budget_observations?.map((entry) => entry.used)).toEqual([null, null, 15000]);
    expect(snapshot.improvement_candidates).toEqual([{ id: "improvement_01", status: "proposed" }]);
    expect(snapshot.digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("is reproducible: identical input seals the identical record", () => {
    expect(buildSnapshot(baseInput())).toEqual(buildSnapshot(baseInput()));
  });

  it("refuses completed while a required task is unfinished", () => {
    const input = baseInput({
      tasks: [{ task_id: "task_01", required: true, outcome: "pending" }],
      task_verdicts: [],
      runs: [],
    });
    expect(snapshotCompletionBlockers(input)).toEqual(["required task task_01 has no TaskVerdict"]);
    try {
      buildSnapshot(input);
      expect.unreachable("must throw");
    } catch (error) {
      const snapshotError = error as SnapshotError;
      expect(snapshotError.kind).toBe("completion_blocked");
      expect(snapshotError.blockers).toEqual(["required task task_01 has no TaskVerdict"]);
    }
  });

  it("refuses completed for an open blocking finding", () => {
    const input = baseInput({
      findings: [{ finding_id: "finding_02", blocking: true, status: "accepted" }],
    });
    expect(snapshotCompletionBlockers(input)).toContain("blocking finding finding_02 is accepted");
  });

  it("refuses completed for stale or non-passing mandatory evidence", () => {
    const stale = baseInput({
      evidence: [
        {
          evidence_id: "evidence_02",
          mandatory: true,
          passed: true,
          provisional: false,
          stale: true,
        },
      ],
    });
    expect(snapshotCompletionBlockers(stale)).toContain("mandatory evidence evidence_02 is stale");
    const provisional = baseInput({
      evidence: [
        {
          evidence_id: "evidence_03",
          mandatory: true,
          passed: true,
          provisional: true,
          stale: false,
        },
      ],
    });
    expect(snapshotCompletionBlockers(provisional)).toContain(
      "mandatory evidence evidence_03 has no current passing verdict",
    );
  });

  it("refuses completed for a failed task verdict or unfinished external action", () => {
    const verdictFailed = baseInput({
      task_verdicts: [{ verdict_id: "verdict_01", task_id: "task_01", verdict: "failed" }],
    });
    expect(snapshotCompletionBlockers(verdictFailed)).toContain(
      "required task task_01 verdict is failed",
    );
    const uncertain = baseInput({
      external_actions: [
        {
          intent_id: "intent-02",
          tool: "git_push",
          request_digest: "b".repeat(64),
          idempotency_key: "key-02",
          status: "uncertain",
        },
      ],
    });
    expect(snapshotCompletionBlockers(uncertain)).toContain(
      "external action intent-02 is uncertain",
    );
  });

  it("builds a blocked snapshot with resume phase, blockers and checkpoint", () => {
    const snapshot = buildSnapshot(
      baseInput({
        tasks: [{ task_id: "task_01", required: true, outcome: "pending" }],
        task_verdicts: [],
        runs: [],
        block_reason: "awaiting_approval",
        resume_phase: "verification",
        checkpoint_id: "checkpoint_01",
      }),
    );
    expect(snapshot.status).toBe("blocked");
    expect(snapshot.resume_phase).toBe("verification");
    expect(snapshot.blockers).toEqual(["required task task_01 has no TaskVerdict"]);
    expect(snapshot.checkpoint_id).toBe("checkpoint_01");
    expect(snapshot.workflow_operation_id).toBe("workflow-op_01");
  });

  it("rejects a blocked snapshot without a typed recoverable reason", () => {
    expect(() =>
      buildSnapshot(
        baseInput({
          tasks: [{ task_id: "task_01", required: true, outcome: "pending" }],
          task_verdicts: [],
          runs: [],
          resume_phase: "verification",
        }),
      ),
    ).toThrowError(SnapshotError);
    expect(() =>
      buildSnapshot(
        baseInput({
          tasks: [{ task_id: "task_01", required: true, outcome: "pending" }],
          task_verdicts: [],
          runs: [],
          block_reason: "user_cancellation" as never,
          resume_phase: "verification",
        }),
      ),
    ).toThrowError(/not a typed recoverable reason/u);
  });

  it("builds an aborted snapshot only for explicit cancel or typed unrecoverable reasons", () => {
    const cancelled = buildSnapshot(baseInput({ abort_reason: "user_cancellation" }));
    expect(cancelled.status).toBe("aborted");
    expect(cancelled.abort_reason).toBe("user_cancellation");

    const policy = buildSnapshot(baseInput({ abort_reason: "policy_violation" }));
    expect(policy.status).toBe("aborted");

    expect(() => buildSnapshot(baseInput({ abort_reason: "timeout" as never }))).toThrowError(
      /not an explicit cancellation/u,
    );
  });

  it("requires a real commit anchor", () => {
    expect(() => buildSnapshot(baseInput({ source_commit: "not-a-commit" }))).toThrowError(
      SnapshotError,
    );
    try {
      buildSnapshot(baseInput({ source_commit: "not-a-commit" }));
    } catch (error) {
      expect((error as SnapshotError).kind).toBe("invalid_snapshot");
    }
  });
});
