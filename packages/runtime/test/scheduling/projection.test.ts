import { describe, expect, it } from "vitest";

import {
  projectSchedulerState,
  TASK_SCHEDULING_STATUSES,
  type SchedulerAuthorityFacts,
} from "../../src/scheduling/projection.js";
import type { SchedulerLiveSnapshot } from "../../src/scheduling/ports.js";
import {
  blockingFinding,
  closedLease,
  fixtureDag,
  fixtureDagWithWaves,
  fixtureTask,
  gateEvidence,
  grantedLease,
  pendingApproval,
  runStarted,
  runTerminated,
  waveIntegration,
} from "./scheduler-facts.js";

function facts(overrides: Partial<SchedulerAuthorityFacts> = {}): SchedulerAuthorityFacts {
  return {
    dag: fixtureDag([fixtureTask("task_a"), fixtureTask("task_b", ["task_a"])]),
    leases: [],
    runs: [],
    gate_evidence: [],
    approvals: [],
    findings: [],
    wave_integrations: [],
    ...overrides,
  };
}

function liveSnapshot(tasks: SchedulerLiveSnapshot["tasks"]): SchedulerLiveSnapshot {
  return {
    operation_id: "operation_1",
    observed_at: "2026-08-31T00:10:00.000Z",
    slots: [{ slot_id: "slot_1", state: "running", task_id: "task_a", run_id: "run_a" }],
    tasks,
  };
}

describe("projectSchedulerState status precedence", () => {
  it("covers the complete status union with stable names", () => {
    expect(TASK_SCHEDULING_STATUSES).toEqual([
      "waiting_dependency",
      "ready",
      "awaiting_approval",
      "running",
      "verifying",
      "integration_queued",
      "candidate_validated",
      "retry_pending",
      "integrated",
      "blocked",
      "cancelled",
    ]);
  });

  it("marks a task with unintegrated dependencies as waiting_dependency", () => {
    const projection = projectSchedulerState(facts(), null);
    expect(projection.tasks.map((task) => [task.task_id, task.status])).toEqual([
      ["task_a", "ready"],
      ["task_b", "waiting_dependency"],
    ]);
  });

  it("marks a task outside the earliest incomplete wave as waiting_dependency", () => {
    const dag = fixtureDagWithWaves(
      [fixtureTask("task_a"), fixtureTask("task_b")],
      [
        { wave_index: 0, task_ids: ["task_a"] },
        { wave_index: 1, task_ids: ["task_b"] },
      ],
    );
    const lease = grantedLease("task_a", "run_a");
    const projection = projectSchedulerState(
      facts({
        dag,
        leases: [lease],
        runs: [runStarted("task_a", "run_a")],
      }),
      null,
    );
    const byId = new Map(projection.tasks.map((task) => [task.task_id, task]));
    expect(byId.get("task_a")?.status).toBe("running");
    expect(byId.get("task_b")?.status).toBe("waiting_dependency");
  });

  it("lets a pending approval request win over ready", () => {
    const projection = projectSchedulerState(
      facts({ approvals: [pendingApproval("task_a")] }),
      null,
    );
    expect(projection.tasks.find((task) => task.task_id === "task_a")?.status).toBe(
      "awaiting_approval",
    );
  });

  it("marks a granted lease with a started run as running", () => {
    const lease = grantedLease("task_a", "run_a");
    const projection = projectSchedulerState(
      facts({ leases: [lease], runs: [runStarted("task_a", "run_a")] }),
      null,
    );
    expect(projection.tasks.find((task) => task.task_id === "task_a")?.status).toBe("running");
  });

  it("marks a finished agent run without validating evidence as verifying", () => {
    const lease = grantedLease("task_a", "run_a");
    const projection = projectSchedulerState(
      facts({
        leases: [lease],
        runs: [
          runStarted("task_a", "run_a"),
          runTerminated("task_a", "run_a", "handoff", "completion"),
        ],
      }),
      null,
    );
    expect(projection.tasks.find((task) => task.task_id === "task_a")?.status).toBe("verifying");
  });

  it("marks locally validated work waiting for integration as integration_queued", () => {
    const lease = grantedLease("task_a", "run_a");
    const projection = projectSchedulerState(
      facts({
        leases: [lease],
        runs: [
          runStarted("task_a", "run_a"),
          runTerminated("task_a", "run_a", "handoff", "completion"),
        ],
        gate_evidence: [gateEvidence("task_a")],
      }),
      null,
    );
    expect(projection.tasks.find((task) => task.task_id === "task_a")?.status).toBe(
      "integration_queued",
    );
  });

  it("marks a released lease with valid candidate evidence as candidate_validated", () => {
    const granted = grantedLease("task_a", "run_a");
    const released = closedLease(granted, "released");
    const projection = projectSchedulerState(
      facts({
        leases: [granted, released],
        runs: [
          runStarted("task_a", "run_a"),
          runTerminated("task_a", "run_a", "handoff", "completion"),
        ],
        gate_evidence: [gateEvidence("task_a")],
      }),
      null,
    );
    expect(projection.tasks.find((task) => task.task_id === "task_a")?.status).toBe(
      "candidate_validated",
    );
  });

  it("never lets an agent completion claim produce integrated", () => {
    const granted = grantedLease("task_a", "run_a");
    const released = closedLease(granted, "released");
    const projection = projectSchedulerState(
      facts({
        leases: [granted, released],
        runs: [
          runStarted("task_a", "run_a"),
          runTerminated("task_a", "run_a", "handoff", "completion"),
        ],
        gate_evidence: [gateEvidence("task_a")],
      }),
      null,
    );
    expect(projection.tasks.find((task) => task.task_id === "task_a")?.status).not.toBe(
      "integrated",
    );
  });

  it("marks only wave-integrated tasks as integrated", () => {
    const granted = grantedLease("task_a", "run_a");
    const released = closedLease(granted, "released");
    const projection = projectSchedulerState(
      facts({
        leases: [granted, released],
        runs: [
          runStarted("task_a", "run_a"),
          runTerminated("task_a", "run_a", "handoff", "completion"),
        ],
        gate_evidence: [gateEvidence("task_a")],
        wave_integrations: [waveIntegration(0, ["task_a"])],
      }),
      null,
    );
    const byId = new Map(projection.tasks.map((task) => [task.task_id, task]));
    expect(byId.get("task_a")?.status).toBe("integrated");
    // Its dependency is now satisfied.
    expect(byId.get("task_b")?.status).toBe("ready");
  });

  it("marks a retryable failure as retry_pending", () => {
    const granted = grantedLease("task_a", "run_a");
    const released = closedLease(granted, "released");
    const projection = projectSchedulerState(
      facts({
        leases: [granted, released],
        runs: [
          runStarted("task_a", "run_a"),
          runTerminated("task_a", "run_a", "partial", "timeout"),
        ],
      }),
      null,
    );
    expect(projection.tasks.find((task) => task.task_id === "task_a")?.status).toBe(
      "retry_pending",
    );
  });

  it("marks a second failure after the consumed retry as blocked", () => {
    const first = grantedLease("task_a", "run_a");
    const firstReleased = closedLease(first, "released");
    const retry = grantedLease("task_a", "run_b", {
      attempt_number: 2,
      retry_kind: "executor_retry",
      fencing_token: first.fencing_token + 1,
    });
    const retryReleased = closedLease(retry, "released");
    const projection = projectSchedulerState(
      facts({
        leases: [first, firstReleased, retry, retryReleased],
        runs: [
          runStarted("task_a", "run_a"),
          runTerminated("task_a", "run_a", "partial", "timeout"),
          runStarted("task_a", "run_b"),
          runTerminated("task_a", "run_b", "failed", "adapter_failure"),
        ],
      }),
      null,
    );
    expect(projection.tasks.find((task) => task.task_id === "task_a")?.status).toBe("blocked");
  });

  it("marks a successful retry as candidate_validated once its lease released with valid evidence", () => {
    // Regression for the review finding: sequence is a per-run counter, so the
    // projection must follow the current lease's run, never a cross-run
    // sequence comparison that resurrects the failed first attempt.
    const first = grantedLease("task_a", "run_a");
    const firstReleased = closedLease(first, "released");
    const retry = grantedLease("task_a", "run_b", {
      attempt_number: 2,
      retry_kind: "executor_retry",
      fencing_token: first.fencing_token + 1,
    });
    const retryReleased = closedLease(retry, "released");
    const projection = projectSchedulerState(
      facts({
        leases: [first, firstReleased, retry, retryReleased],
        runs: [
          runStarted("task_a", "run_a"),
          runTerminated("task_a", "run_a", "partial", "timeout"),
          runStarted("task_a", "run_b"),
          runTerminated("task_a", "run_b", "handoff", "completion"),
        ],
        gate_evidence: [gateEvidence("task_a")],
      }),
      null,
    );
    expect(projection.tasks.find((task) => task.task_id === "task_a")?.status).toBe(
      "candidate_validated",
    );
  });

  it("reports a retry in flight as running, never verifying from the failed first attempt", () => {
    const first = grantedLease("task_a", "run_a");
    const firstReleased = closedLease(first, "released");
    const retry = grantedLease("task_a", "run_b", {
      attempt_number: 2,
      retry_kind: "executor_retry",
      fencing_token: first.fencing_token + 1,
    });
    const projection = projectSchedulerState(
      facts({
        leases: [first, firstReleased, retry],
        runs: [
          runStarted("task_a", "run_a"),
          runTerminated("task_a", "run_a", "partial", "timeout"),
          runStarted("task_a", "run_b"),
        ],
      }),
      null,
    );
    expect(projection.tasks.find((task) => task.task_id === "task_a")?.status).toBe("running");
  });

  it("selects the latest lease by fencing token regardless of input order", () => {
    // The projection has no ordering precondition on its facts: the highest
    // fencing token is the current attempt (design §8.2).
    const first = grantedLease("task_a", "run_a");
    const firstReleased = closedLease(first, "released");
    const retry = grantedLease("task_a", "run_b", {
      attempt_number: 2,
      retry_kind: "executor_retry",
      fencing_token: first.fencing_token + 1,
    });
    const retryReleased = closedLease(retry, "released");
    const projection = projectSchedulerState(
      facts({
        leases: [retryReleased, retry, firstReleased, first],
        runs: [
          runStarted("task_a", "run_a"),
          runTerminated("task_a", "run_a", "partial", "timeout"),
          runStarted("task_a", "run_b"),
          runTerminated("task_a", "run_b", "handoff", "completion"),
        ],
        gate_evidence: [gateEvidence("task_a")],
      }),
      null,
    );
    expect(projection.tasks.find((task) => task.task_id === "task_a")?.status).toBe(
      "candidate_validated",
    );
  });

  it("marks a policy-denied termination as blocked, never retryable", () => {
    const granted = grantedLease("task_a", "run_a");
    const released = closedLease(granted, "released");
    const projection = projectSchedulerState(
      facts({
        leases: [granted, released],
        runs: [
          runStarted("task_a", "run_a"),
          runTerminated("task_a", "run_a", "correct_block", "policy_denial"),
        ],
      }),
      null,
    );
    expect(projection.tasks.find((task) => task.task_id === "task_a")?.status).toBe("blocked");
  });

  it("lets an open blocker win over a stale live PID", () => {
    const granted = grantedLease("task_a", "run_a");
    const released = closedLease(granted, "released");
    const live = liveSnapshot([
      {
        task_id: "task_a",
        pid: 4242,
        heartbeat_at: "2026-08-31T00:09:00.000Z",
        output_tail: "still here",
        steps: null,
        tokens: null,
        duration_ms: 100,
        worktree_id: "worktree_0123456789ab",
      },
    ]);
    const projection = projectSchedulerState(
      facts({
        leases: [granted, released],
        runs: [
          runStarted("task_a", "run_a"),
          runTerminated("task_a", "run_a", "failed", "adapter_failure"),
        ],
        findings: [blockingFinding("task_a")],
      }),
      live,
    );
    const task = projection.tasks.find((entry) => entry.task_id === "task_a");
    expect(task?.status).toBe("blocked");
    // Live data decorates but never overrides authority.
    expect(task?.live?.pid).toBe(4242);
  });

  it("ignores closed or superseded findings", () => {
    const granted = grantedLease("task_a", "run_a");
    const released = closedLease(granted, "released");
    const projection = projectSchedulerState(
      facts({
        leases: [granted, released],
        runs: [
          runStarted("task_a", "run_a"),
          runTerminated("task_a", "run_a", "handoff", "completion"),
        ],
        gate_evidence: [gateEvidence("task_a")],
        findings: [blockingFinding("task_a", "closed")],
      }),
      null,
    );
    expect(projection.tasks.find((task) => task.task_id === "task_a")?.status).toBe(
      "candidate_validated",
    );
  });

  it("marks a reconciled user cancellation as cancelled", () => {
    const granted = grantedLease("task_a", "run_a");
    const revoked = closedLease(granted, "revoked");
    const projection = projectSchedulerState(
      facts({
        leases: [granted, revoked],
        runs: [
          runStarted("task_a", "run_a"),
          runTerminated("task_a", "run_a", "partial", "user_cancellation"),
        ],
      }),
      null,
    );
    expect(projection.tasks.find((task) => task.task_id === "task_a")?.status).toBe("cancelled");
  });

  it("labels provisional evidence and never satisfies validation with it", () => {
    const lease = grantedLease("task_a", "run_a");
    const projection = projectSchedulerState(
      facts({
        leases: [lease],
        runs: [
          runStarted("task_a", "run_a"),
          runTerminated("task_a", "run_a", "handoff", "completion"),
        ],
        gate_evidence: [gateEvidence("task_a", { provisional: true })],
      }),
      null,
    );
    const task = projection.tasks.find((entry) => entry.task_id === "task_a");
    // Provisional evidence cannot advance the task past verifying.
    expect(task?.status).toBe("verifying");
    expect(task?.provisional).toBe(true);
  });
});

describe("projectSchedulerState live decoration", () => {
  it("returns live_state rebuilding when no live snapshot exists", () => {
    const projection = projectSchedulerState(facts(), null);
    expect(projection.live_state).toBe("rebuilding");
    expect(projection.observed_at).toBeNull();
    expect(projection.slots).toEqual([]);
    expect(projection.tasks.every((task) => task.live === null)).toBe(true);
    // Authority is unaffected: the task is still ready, never failed/success.
    expect(projection.tasks.find((task) => task.task_id === "task_a")?.status).toBe("ready");
  });

  it("decorates running tasks with live observations only", () => {
    const lease = grantedLease("task_a", "run_a");
    const live = liveSnapshot([
      {
        task_id: "task_a",
        pid: 4242,
        heartbeat_at: "2026-08-31T00:09:30.000Z",
        output_tail: "compiling",
        steps: null,
        tokens: null,
        duration_ms: 500,
        worktree_id: "worktree_0123456789ab",
      },
    ]);
    const projection = projectSchedulerState(
      facts({ leases: [lease], runs: [runStarted("task_a", "run_a")] }),
      live,
    );
    const task = projection.tasks.find((entry) => entry.task_id === "task_a");
    expect(projection.live_state).toBe("observed");
    expect(projection.observed_at).toBe("2026-08-31T00:10:00.000Z");
    expect(task?.status).toBe("running");
    expect(task?.live).toEqual({
      task_id: "task_a",
      pid: 4242,
      heartbeat_at: "2026-08-31T00:09:30.000Z",
      output_tail: "compiling",
      steps: null,
      tokens: null,
      duration_ms: 500,
      worktree_id: "worktree_0123456789ab",
    });
    expect(projection.slots).toEqual([
      { slot_id: "slot_1", state: "running", task_id: "task_a", run_id: "run_a" },
    ]);
  });

  it("is deterministic: identical facts produce an identical projection", () => {
    const granted = grantedLease("task_a", "run_a");
    const released = closedLease(granted, "released");
    const input = facts({
      leases: [granted, released],
      runs: [
        runStarted("task_a", "run_a"),
        runTerminated("task_a", "run_a", "handoff", "completion"),
      ],
      gate_evidence: [gateEvidence("task_a")],
    });
    expect(projectSchedulerState(input, null)).toEqual(projectSchedulerState(input, null));
  });
});
