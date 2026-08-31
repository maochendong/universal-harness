import { describe, expect, it } from "vitest";

import {
  boundOutputTail,
  redactSchedulerText,
  redactedWorktreeLocator,
  SCHEDULER_EVENT_TYPES,
  schedulerRecoveredEvent,
  taskCandidateValidatedEvent,
  taskDispatchedEvent,
  taskIntegrationQueuedEvent,
  taskLeaseGrantedEvent,
  taskRetryScheduledEvent,
  waveGateCompletedEvent,
  waveIntegratedEvent,
} from "../../src/scheduling/events.js";

describe("scheduler event builders", () => {
  it("covers exactly the eight M4 event types", () => {
    expect(SCHEDULER_EVENT_TYPES).toEqual([
      "TaskLeaseGranted",
      "TaskDispatched",
      "TaskIntegrationQueued",
      "TaskCandidateValidated",
      "TaskRetryScheduled",
      "WaveGateCompleted",
      "WaveIntegrated",
      "SchedulerRecovered",
    ]);
  });

  it("pins protocol 1.3 on every builder", () => {
    const specs = [
      taskLeaseGrantedEvent({
        operation_id: "operation_1",
        task_id: "task_a",
        lease_id: "lease_1",
        slot_id: "slot_1",
        fencing_token: 1,
        plan_digest: "c".repeat(64),
      }),
      taskDispatchedEvent({
        operation_id: "operation_1",
        task_id: "task_a",
        run_id: "run_a",
        slot_id: "slot_1",
        attempt_number: 1,
        worktree_root: "/Users/alice/project/.harness/worktrees/task_a",
      }),
      taskIntegrationQueuedEvent({
        operation_id: "operation_1",
        task_id: "task_a",
        run_id: "run_a",
        patch_digest: "d".repeat(64),
      }),
      taskCandidateValidatedEvent({
        operation_id: "operation_1",
        task_id: "task_a",
        evidence_digests: ["2".repeat(64), "1".repeat(64)],
      }),
      taskRetryScheduledEvent({
        operation_id: "operation_1",
        task_id: "task_a",
        retry_kind: "executor_retry",
        attempt_number: 2,
        reason: "agent crashed",
      }),
      waveGateCompletedEvent({
        operation_id: "operation_1",
        wave_index: 0,
        passed: true,
        evidence_digests: ["9".repeat(64)],
      }),
      waveIntegratedEvent({
        operation_id: "operation_1",
        wave_index: 0,
        task_ids: ["task_a"],
        wave_integration_id: "wave-integration_0",
        candidate_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
      schedulerRecoveredEvent({
        operation_id: "operation_1",
        recovered_tasks: ["task_b", "task_a"],
        released_leases: ["lease_2", "lease_1"],
      }),
    ];

    expect(specs.map((spec) => spec.protocolVersion)).toEqual(
      Array.from({ length: 8 }, () => "1.3.0"),
    );
    expect(specs.map((spec) => spec.eventType)).toEqual([...SCHEDULER_EVENT_TYPES]);
    // Deterministic ordering where the payload carries sets.
    expect(specs[3]?.payload.evidence_digests).toEqual(["1".repeat(64), "2".repeat(64)]);
    expect(specs[7]?.payload.recovered_tasks).toEqual(["task_a", "task_b"]);
    expect(specs[7]?.payload.released_leases).toEqual(["lease_1", "lease_2"]);
  });

  it("redacts absolute paths and never stores the worktree root", () => {
    const dispatched = taskDispatchedEvent({
      operation_id: "operation_1",
      task_id: "task_a",
      run_id: "run_a",
      slot_id: "slot_1",
      attempt_number: 1,
      worktree_root: "/Users/alice/project/.harness/worktrees/task_a",
    });
    const encoded = JSON.stringify(dispatched.payload);
    expect(encoded).not.toContain("/Users/alice");
    expect(dispatched.payload.worktree_locator).toMatch(/^worktree_[a-f0-9]{12}$/u);

    const retry = taskRetryScheduledEvent({
      operation_id: "operation_1",
      task_id: "task_a",
      retry_kind: "executor_retry",
      attempt_number: 2,
      reason: "provider wrote /Users/alice/project/secrets.txt unexpectedly",
    });
    expect(retry.payload.reason).toBe("provider wrote <redacted-path> unexpectedly");
  });
});

describe("scheduler text redaction", () => {
  it("strips absolute paths from free text", () => {
    expect(redactSchedulerText("wrote /Users/alice/repo/src/a.ts and /tmp/build/x")).toBe(
      "wrote <redacted-path> and <redacted-path>",
    );
  });

  it("bounds the tail to the trailing bytes", () => {
    const long = `prefix-${"x".repeat(10_000)}`;
    const tail = boundOutputTail(long, 100);
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(100);
    expect(tail).toBe("x".repeat(100));
    expect(long.endsWith(tail)).toBe(true);
  });

  it("derives a stable digest locator for one worktree root", () => {
    const root = "/Users/alice/project/.harness/worktrees/task_a";
    expect(redactedWorktreeLocator(root)).toBe(redactedWorktreeLocator(root));
    expect(redactedWorktreeLocator(root)).not.toContain("alice");
  });
});
