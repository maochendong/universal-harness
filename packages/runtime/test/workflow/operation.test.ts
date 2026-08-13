import { afterEach, describe, expect, it } from "vitest";

import { LedgerRepository, validateRunRecordStream } from "@universal-harness-internal/core";

import {
  InvalidStateTransition,
  WorkflowEngine,
  readOperationHistory,
  readRunStreams,
  streamTerminalRecord,
} from "../../src/index.js";
import {
  BASELINE,
  FIXED_NOW,
  cleanupDirectories,
  makeDeps,
  makeProjectRoot,
  makeStartInput,
  phaseIds,
} from "./helpers.js";

afterEach(() => {
  cleanupDirectories();
});

async function startRunningOperation(projectRoot: string): Promise<{
  engine: WorkflowEngine;
  workflowOperationId: string;
}> {
  const engine = new WorkflowEngine(makeDeps(projectRoot, { newId: phaseIds("boot") }));
  const started = await engine.startOperation(makeStartInput());
  const workflowOperationId = started.operation.workflow_operation_id;
  await engine.advance(workflowOperationId, "planned");
  await engine.advance(workflowOperationId, "running");
  return { engine, workflowOperationId };
}

describe("workflow operation lifecycle", () => {
  it("commits the initial record, checkpoint and events in one operation", async () => {
    const projectRoot = makeProjectRoot();
    const engine = new WorkflowEngine(makeDeps(projectRoot));
    const started = await engine.startOperation(makeStartInput());

    expect(started.operation.state).toBe("created");
    const current = engine.getOperation(started.operation.workflow_operation_id);
    expect(current?.state).toBe("created");
    expect(current?.iteration_id).toBe("iteration_t0001");

    const workingState = engine.getWorkingState(started.operation.workflow_operation_id);
    expect(workingState?.goal).toBe("ship the demo feature");
    expect(workingState?.pending_task_ids).toEqual(["task_alpha"]);

    const replay = new LedgerRepository({
      projectRoot,
      readBaseline: () => BASELINE,
    }).replay();
    expect(replay.events.map((event) => event.event_type)).toEqual([
      "OperationStarted",
      "CheckpointCommitted",
    ]);
    expect(
      replay.events.every(
        (event) => event.workflow_operation_id === started.operation.workflow_operation_id,
      ),
    ).toBe(true);
  });

  it("advances along the chain and records completion", async () => {
    const projectRoot = makeProjectRoot();
    const engine = new WorkflowEngine(makeDeps(projectRoot));
    const started = await engine.startOperation(makeStartInput());
    const id = started.operation.workflow_operation_id;

    await engine.advance(id, "planned");
    await engine.advance(id, "running");
    await engine.advance(id, "verifying");
    const completed = await engine.advance(id, "completed");
    expect(completed.state).toBe("completed");

    const replay = new LedgerRepository({
      projectRoot,
      readBaseline: () => BASELINE,
    }).replay();
    expect(replay.events.map((event) => event.event_type)).toContain("OperationCompleted");
    expect(readOperationHistory(makeDeps(projectRoot), id).map((record) => record.state)).toEqual([
      "created",
      "planned",
      "running",
      "verifying",
      "completed",
    ]);
  });

  it("rejects illegal transitions with a typed error", async () => {
    const projectRoot = makeProjectRoot();
    const engine = new WorkflowEngine(makeDeps(projectRoot));
    const started = await engine.startOperation(makeStartInput());
    const id = started.operation.workflow_operation_id;

    await expect(engine.advance(id, "completed")).rejects.toBeInstanceOf(InvalidStateTransition);
    await expect(engine.advance(id, "blocked")).rejects.toBeInstanceOf(InvalidStateTransition);
    await expect(engine.advance(id, "aborted")).rejects.toBeInstanceOf(InvalidStateTransition);
    await expect(engine.advance("workflow_missing", "planned")).rejects.toMatchObject({
      name: "WorkflowError",
      kind: "operation_not_found",
    });
  });

  it("blocks with resume_state and a blocked-snapshot checkpoint", async () => {
    const projectRoot = makeProjectRoot();
    const { engine, workflowOperationId } = await startRunningOperation(projectRoot);

    const outcome = await engine.block(workflowOperationId, {
      reason: "transient_environment_failure",
      detail: "provider timeout",
      proposal: { phase: "execution" },
    });
    expect(outcome.operation.state).toBe("blocked");
    expect(outcome.operation.resume_state).toBe("running");

    const workingState = engine.getWorkingState(workflowOperationId);
    expect(workingState?.blockers).toEqual(["provider timeout"]);
    expect(workingState?.phase).toBe("execution");
    expect(workingState?.previous_checkpoint_id).toBeDefined();

    // No transition out of blocked except resume.
    await expect(engine.advance(workflowOperationId, "running")).rejects.toBeInstanceOf(
      InvalidStateTransition,
    );
  });

  it("aborts only into a terminal state and stays there", async () => {
    const projectRoot = makeProjectRoot();
    const { engine, workflowOperationId } = await startRunningOperation(projectRoot);

    const aborted = await engine.abort(workflowOperationId, {
      reason: "policy_violation",
      detail: "schema rejected the plan",
    });
    expect(aborted.state).toBe("aborted");
    await expect(
      engine.abort(workflowOperationId, { reason: "user_cancellation", detail: "again" }),
    ).rejects.toBeInstanceOf(InvalidStateTransition);
    await expect(engine.advance(workflowOperationId, "running")).rejects.toBeInstanceOf(
      InvalidStateTransition,
    );

    const replay = new LedgerRepository({
      projectRoot,
      readBaseline: () => BASELINE,
    }).replay();
    const completed = replay.events.filter((event) => event.event_type === "OperationCompleted");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.payload).toMatchObject({ outcome: "aborted", reason: "policy_violation" });
  });
});

describe("checkpoint persistence", () => {
  it("persists WorkingState at each boundary via typed proposals", async () => {
    const projectRoot = makeProjectRoot();
    const { engine, workflowOperationId } = await startRunningOperation(projectRoot);

    const checkpoint = await engine.commitCheckpoint(workflowOperationId, {
      boundary: "task",
      proposal: {
        add_confirmed_facts: [{ fact: "baseline scanned", evidence_id: "evidence_01" }],
        complete_task_ids: ["task_alpha"],
        set_next_action: "verify gates",
      },
    });
    expect(checkpoint.workflow_operation_id).toBe(workflowOperationId);

    const workingState = engine.getWorkingState(workflowOperationId);
    expect(workingState?.confirmed_facts).toEqual([
      { fact: "baseline scanned", evidence_id: "evidence_01" },
    ]);
    expect(workingState?.completed_task_ids).toEqual(["task_alpha"]);
    expect(workingState?.next_action).toBe("verify gates");

    const replay = new LedgerRepository({
      projectRoot,
      readBaseline: () => BASELINE,
    }).replay();
    const checkpointEvents = replay.events.filter(
      (event) => event.event_type === "CheckpointCommitted",
    );
    // operation_start checkpoint + this task-boundary checkpoint.
    expect(checkpointEvents).toHaveLength(2);
    expect(checkpointEvents.at(-1)?.payload).toMatchObject({ boundary: "task" });
  });

  it("refuses checkpoints on terminal operations", async () => {
    const projectRoot = makeProjectRoot();
    const { engine, workflowOperationId } = await startRunningOperation(projectRoot);
    await engine.abort(workflowOperationId, { reason: "user_cancellation", detail: "stop" });
    await expect(
      engine.commitCheckpoint(workflowOperationId, { boundary: "task", proposal: {} }),
    ).rejects.toMatchObject({ name: "WorkflowError", kind: "operation_terminal" });
  });
});

describe("run records", () => {
  it("starts and terminates runs only while running", async () => {
    const projectRoot = makeProjectRoot();
    const engine = new WorkflowEngine(makeDeps(projectRoot, { newId: phaseIds("runs") }));
    const started = await engine.startOperation(makeStartInput());
    const id = started.operation.workflow_operation_id;

    await expect(
      engine.startRun(id, { taskId: "task_alpha", contextBundleId: "context_01" }),
    ).rejects.toBeInstanceOf(InvalidStateTransition);

    await engine.advance(id, "planned");
    await engine.advance(id, "running");
    const run = await engine.startRun(id, {
      taskId: "task_alpha",
      contextBundleId: "context_01",
    });
    expect(run.record_kind).toBe("run_started");

    const terminated = await engine.terminateRun(id, {
      runId: run.run_id,
      outcome: "success",
      terminationReason: "completion",
    });
    expect(terminated.record_kind).toBe("run_terminated");
    await expect(
      engine.terminateRun(id, {
        runId: run.run_id,
        outcome: "failed",
        terminationReason: "adapter_failure",
      }),
    ).rejects.toMatchObject({ name: "WorkflowError", kind: "run_already_terminated" });
    await expect(
      engine.terminateRun(id, {
        runId: "run_missing",
        outcome: "failed",
        terminationReason: "timeout",
      }),
    ).rejects.toMatchObject({ name: "WorkflowError", kind: "run_not_found" });

    const streams = readRunStreams(makeDeps(projectRoot), id);
    expect(streams).toHaveLength(1);
    const stream = streams[0];
    expect(stream !== undefined && streamTerminalRecord(stream)?.record_kind).toBe(
      "run_terminated",
    );
    expect(validateRunRecordStream(stream?.records ?? []).valid).toBe(true);
  });

  it("keeps the fixed timestamp on every record for deterministic replay", async () => {
    const projectRoot = makeProjectRoot();
    const engine = new WorkflowEngine(makeDeps(projectRoot));
    const started = await engine.startOperation(makeStartInput());
    expect(started.operation.updated_at).toBe(FIXED_NOW);
  });
});
