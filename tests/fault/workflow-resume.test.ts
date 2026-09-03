import { describe, expect, it } from "vitest";

import {
  DURABLE_BOUNDARIES,
  LedgerRepository,
  validateRunRecordStream,
  type DurableBoundary,
} from "../../packages/core/src/index.js";
import {
  InvalidStateTransition,
  WorkflowEngine,
  readRunStreams,
  resumeWorkflowOperation,
  type WorkflowDependencies,
} from "../../packages/runtime/src/index.js";
import {
  BASELINE,
  FIXED_NOW,
  cleanupDirectories,
  makeProjectRoot,
  makeStartInput,
  phaseIds,
} from "../../packages/runtime/test/workflow/helpers.js";
import { SimulatedProcessKill, createFaultInjector } from "../helpers/fault-injection.js";

/**
 * Interruption at every durable boundary of the checkpoint and resume
 * commits. Invariants under test: no boundary ever exposes a partially
 * accepted state change, retrying the same logical attempt is idempotent,
 * and resume never duplicates runs, events, edges or committed steps.
 */
function workflowDeps(
  projectRoot: string,
  tag: string,
  boundary?: DurableBoundary,
): WorkflowDependencies {
  return {
    projectRoot,
    readBaseline: () => BASELINE,
    now: () => FIXED_NOW,
    newId: phaseIds(tag),
    ...(boundary === undefined
      ? {}
      : { hooks: createFaultInjector({ boundary, kind: "process-kill" }).hooks }),
  };
}

/** Boot a running operation with one unfinished run, no faults. */
async function bootOperation(projectRoot: string): Promise<{
  workflowOperationId: string;
  runId: string;
}> {
  const engine = new WorkflowEngine(workflowDeps(projectRoot, "boot"));
  const started = await engine.startOperation(makeStartInput());
  const workflowOperationId = started.operation.workflow_operation_id;
  await engine.advance(workflowOperationId, "planned");
  await engine.advance(workflowOperationId, "running");
  const run = await engine.startRun(workflowOperationId, {
    taskId: "task_alpha",
    contextBundleId: "context_01",
  });
  return { workflowOperationId, runId: run.run_id };
}

function eventIds(projectRoot: string): string[] {
  return new LedgerRepository({ projectRoot, readBaseline: () => BASELINE })
    .replay()
    .events.map((event) => event.event_id);
}

// Process-kill boundary cases each build a full project, interrupt a commit
// and resume; under full-suite parallel load the 5s default is not enough
// (integration-cas-recovery.test.ts carries 120s for the same reason).
describe("checkpoint commit interruption", { timeout: 30_000 }, () => {
  for (const boundary of DURABLE_BOUNDARIES) {
    it(`recovers exactly once when killed at ${boundary}`, async () => {
      const projectRoot = makeProjectRoot();
      try {
        const { workflowOperationId } = await bootOperation(projectRoot);

        // First attempt crashes at the durable boundary.
        const crashed = new WorkflowEngine(workflowDeps(projectRoot, "blk", boundary));
        await expect(
          crashed.block(workflowOperationId, {
            reason: "transient_environment_failure",
            detail: "provider timeout",
          }),
        ).rejects.toBeInstanceOf(SimulatedProcessKill);

        // Retrying the same logical attempt mints identical ids: it either
        // commits (pre-commit kill) or is a typed refusal because the blocked
        // state already landed (post-commit kill). Never a duplicate.
        const retried = new WorkflowEngine(workflowDeps(projectRoot, "blk"));
        try {
          await retried.block(workflowOperationId, {
            reason: "transient_environment_failure",
            detail: "provider timeout",
          });
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidStateTransition);
        }

        const engine = new WorkflowEngine(workflowDeps(projectRoot, "observe"));
        const current = engine.getOperation(workflowOperationId);
        expect(current?.state).toBe("blocked");
        expect(current?.resume_state).toBe("running");

        const replay = new LedgerRepository({
          projectRoot,
          readBaseline: () => BASELINE,
        }).replay();
        // OperationStarted + start checkpoint + blocked-snapshot checkpoint.
        const checkpointEvents = replay.events.filter(
          (event) => event.event_type === "CheckpointCommitted",
        );
        expect(checkpointEvents).toHaveLength(2);
        expect(new Set(eventIds(projectRoot)).size).toBe(eventIds(projectRoot).length);
        // Boot commits (start, 2 advances, run) + exactly one block commit.
        expect(replay.operations).toHaveLength(5);
      } finally {
        cleanupDirectories();
      }
    });
  }
});

describe("resume commit interruption", { timeout: 30_000 }, () => {
  for (const boundary of DURABLE_BOUNDARIES) {
    it(`never duplicates runs, events or commits when killed at ${boundary}`, async () => {
      const projectRoot = makeProjectRoot();
      try {
        const { workflowOperationId, runId } = await bootOperation(projectRoot);
        const bootEngine = new WorkflowEngine(workflowDeps(projectRoot, "blk-setup"));
        await bootEngine.block(workflowOperationId, {
          reason: "transient_environment_failure",
          detail: "provider timeout",
        });

        // First resume attempt crashes at the durable boundary.
        await expect(
          resumeWorkflowOperation(workflowDeps(projectRoot, "res", boundary), workflowOperationId),
        ).rejects.toBeInstanceOf(SimulatedProcessKill);

        // Retry: identical mint, so a pre-commit crash resumes cleanly and a
        // post-commit crash is a typed refusal (the operation is running
        // again) — never a second RunInterrupted or successor run.
        try {
          await resumeWorkflowOperation(workflowDeps(projectRoot, "res"), workflowOperationId);
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidStateTransition);
        }

        const engine = new WorkflowEngine(workflowDeps(projectRoot, "observe"));
        const current = engine.getOperation(workflowOperationId);
        expect(current?.state).toBe("running");

        const streams = readRunStreams(workflowDeps(projectRoot, "observe"), workflowOperationId);
        const oldStream = streams.find((stream) => stream.runId === runId);
        expect(oldStream?.records.map((record) => record.record_kind)).toEqual([
          "run_started",
          "run_interrupted",
        ]);
        expect(validateRunRecordStream(oldStream?.records ?? []).valid).toBe(true);
        const successors = streams.filter((stream) => stream.runId !== runId);
        expect(successors).toHaveLength(1);
        expect(successors[0]?.records.map((record) => record.record_kind)).toEqual(["run_started"]);

        const replay = new LedgerRepository({
          projectRoot,
          readBaseline: () => BASELINE,
        }).replay();
        expect(
          replay.events.filter((event) => event.event_type === "OperationStarted"),
        ).toHaveLength(2);
        expect(replay.edges.filter((edge) => edge.type === "RESUMES")).toHaveLength(1);
        expect(new Set(eventIds(projectRoot)).size).toBe(eventIds(projectRoot).length);
        // 5 boot commits + exactly one resume commit.
        expect(replay.operations).toHaveLength(6);
      } finally {
        cleanupDirectories();
      }
    });
  }
});
