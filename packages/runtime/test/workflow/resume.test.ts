import { afterEach, describe, expect, it } from "vitest";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  LedgerRepository,
  PROTOCOL_VERSION,
  canonicalizeJson,
  harnessRootFor,
  sha256Hex,
  validateRunRecordStream,
} from "@universal-harness-internal/core";

import {
  InvalidStateTransition,
  WorkflowEngine,
  readRunStreams,
  resumeWorkflowOperation,
  runRecordArtifactPath,
  type WorkflowDependencies,
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

let plantCounter = 0;

/** Commit an artifact directly, simulating records other subsystems own. */
async function plantArtifact(
  projectRoot: string,
  workflowOperationId: string,
  attemptId: string,
  path: string,
  record: Record<string, unknown>,
): Promise<string> {
  const content = `${canonicalizeJson(record)}\n`;
  plantCounter += 1;
  const repository = new LedgerRepository({
    projectRoot,
    readBaseline: () => BASELINE,
    now: () => FIXED_NOW,
  });
  await repository.commit({
    ledger_operation_id: `ledger_plant${String(plantCounter).padStart(2, "0")}`,
    workflow_operation_id: workflowOperationId,
    attempt_id: attemptId,
    expected_baseline: BASELINE,
    artifacts: [{ path, content }],
    events: [],
  });
  return sha256Hex(content);
}

async function blockedWithRun(projectRoot: string): Promise<{
  engine: WorkflowEngine;
  workflowOperationId: string;
  attemptId: string;
  runId: string;
}> {
  const engine = new WorkflowEngine(makeDeps(projectRoot, { newId: phaseIds("boot") }));
  const started = await engine.startOperation(makeStartInput());
  const workflowOperationId = started.operation.workflow_operation_id;
  const attemptId = started.operation.attempt_id;
  await engine.advance(workflowOperationId, "planned");
  await engine.advance(workflowOperationId, "running");
  const run = await engine.startRun(workflowOperationId, {
    taskId: "task_alpha",
    contextBundleId: "context_01",
  });
  await engine.block(workflowOperationId, {
    reason: "transient_environment_failure",
    detail: "provider timeout",
    proposal: { phase: "execution" },
  });
  return { engine, workflowOperationId, attemptId, runId: run.run_id };
}

function resumeDeps(projectRoot: string, overrides?: Partial<WorkflowDependencies>) {
  return makeDeps(projectRoot, { newId: phaseIds("resume"), ...overrides });
}

describe("workflow resume", () => {
  it("resumes into resume_state with a new attempt and reconciles the interrupted run", async () => {
    const projectRoot = makeProjectRoot();
    const { engine, workflowOperationId, attemptId, runId } = await blockedWithRun(projectRoot);

    const outcome = await resumeWorkflowOperation(resumeDeps(projectRoot), workflowOperationId);
    expect(outcome.resumedState).toBe("running");
    expect(outcome.attemptId).not.toBe(attemptId);
    expect(outcome.resumedRuns).toHaveLength(1);
    const resumed = outcome.resumedRuns[0];
    expect(resumed?.interruptedRunId).toBe(runId);

    // The operation is back to running under the new attempt.
    const current = engine.getOperation(workflowOperationId);
    expect(current?.state).toBe("running");
    expect(current?.attempt_id).toBe(outcome.attemptId);

    // The old run gained exactly one RunInterrupted closing its stream.
    const streams = readRunStreams(makeDeps(projectRoot), workflowOperationId);
    const oldStream = streams.find((stream) => stream.runId === runId);
    expect(oldStream?.records.map((record) => record.record_kind)).toEqual([
      "run_started",
      "run_interrupted",
    ]);
    const interrupted = oldStream?.records.at(-1);
    expect(interrupted).toMatchObject({
      outcome: "failed",
      termination_reason: "process_interruption",
      attempt_id: attemptId,
      sequence: 2,
    });
    expect(validateRunRecordStream(oldStream?.records ?? []).valid).toBe(true);

    // The interrupted Run also received its result artifact so evaluation
    // (reconcile/backfill) can close the loop instead of leaving a permanent
    // unassessed-Run blocker.
    const interruptedResultPath = join(
      harnessRootFor(projectRoot),
      "artifacts/run-results",
      `${runId}.json`,
    );
    expect(existsSync(interruptedResultPath)).toBe(true);
    expect(JSON.parse(readFileSync(interruptedResultPath, "utf8"))).toMatchObject({
      run_id: runId,
      completion_claimed: false,
      outcome: "failed",
      termination_reason: "process_interruption",
      interrupted: true,
    });

    // Exactly one successor run, linked RESUMES -> old run.
    const successorStream = streams.find((stream) => stream.runId === resumed?.successorRunId);
    expect(successorStream?.records).toHaveLength(1);
    expect(successorStream?.records[0]).toMatchObject({
      record_kind: "run_started",
      attempt_id: outcome.attemptId,
      task_id: "task_alpha",
    });
    const replay = new LedgerRepository({ projectRoot, readBaseline: () => BASELINE }).replay();
    const resumesEdges = replay.edges.filter((edge) => edge.type === "RESUMES");
    expect(resumesEdges).toHaveLength(1);
    expect(resumesEdges[0]).toMatchObject({
      source_id: resumed?.successorRunId,
      target_id: runId,
    });

    // No duplicated lifecycle events.
    const startedEvents = replay.events.filter((event) => event.event_type === "OperationStarted");
    expect(startedEvents).toHaveLength(2);
    expect(new Set(replay.events.map((event) => event.event_id)).size).toBe(replay.events.length);

    // A resumed operation is no longer blocked: resuming again is a typed
    // refusal, never a duplicate.
    await expect(
      resumeWorkflowOperation(resumeDeps(projectRoot), workflowOperationId),
    ).rejects.toBeInstanceOf(InvalidStateTransition);
  });

  it("resumes a blocked operation without runs by committing only the state record", async () => {
    const projectRoot = makeProjectRoot();
    const engine = new WorkflowEngine(makeDeps(projectRoot, { newId: phaseIds("plain") }));
    const started = await engine.startOperation(makeStartInput());
    const id = started.operation.workflow_operation_id;
    await engine.advance(id, "awaiting_approval");
    await engine.block(id, { reason: "awaiting_approval", detail: "needs human decision" });

    const outcome = await resumeWorkflowOperation(resumeDeps(projectRoot), id);
    expect(outcome.resumedState).toBe("awaiting_approval");
    expect(outcome.resumedRuns).toEqual([]);
    expect(engine.getOperation(id)?.state).toBe("awaiting_approval");
  });

  it("refuses to resume when the baseline drifted since the checkpoint", async () => {
    const projectRoot = makeProjectRoot();
    const { workflowOperationId } = await blockedWithRun(projectRoot);
    const drifted = "f".repeat(40);
    await expect(
      resumeWorkflowOperation(
        resumeDeps(projectRoot, { readBaseline: () => drifted }),
        workflowOperationId,
      ),
    ).rejects.toMatchObject({ name: "WorkflowError", kind: "baseline_mismatch" });
  });

  it("refuses non-blocked, terminal and unknown operations", async () => {
    const projectRoot = makeProjectRoot();
    const engine = new WorkflowEngine(makeDeps(projectRoot, { newId: phaseIds("guard") }));
    const started = await engine.startOperation(makeStartInput());
    const id = started.operation.workflow_operation_id;

    await expect(resumeWorkflowOperation(resumeDeps(projectRoot), id)).rejects.toBeInstanceOf(
      InvalidStateTransition,
    );
    await expect(
      resumeWorkflowOperation(resumeDeps(projectRoot), "workflow_missing"),
    ).rejects.toMatchObject({ name: "WorkflowError", kind: "operation_not_found" });

    await engine.advance(id, "planned");
    await engine.advance(id, "running");
    await engine.advance(id, "verifying");
    await engine.advance(id, "completed");
    await expect(resumeWorkflowOperation(resumeDeps(projectRoot), id)).rejects.toMatchObject({
      name: "WorkflowError",
      kind: "operation_terminal",
    });
  });

  it("re-verifies approval bindings before resuming", async () => {
    const projectRoot = makeProjectRoot();

    const approval = (decision: string, suffix: string): Record<string, unknown> => ({
      protocol_version: PROTOCOL_VERSION,
      record_kind: "approval_decision",
      approval_id: `approval_${suffix}`,
      request_id: "request_a01",
      actor: "human-reviewer",
      decision,
      object_digest: "e".repeat(64),
      decided_at: FIXED_NOW,
    });

    async function blockedWithApprovalBinding(
      tag: string,
      decision: "approve" | "reject" | "none",
    ): Promise<{ id: string; digest: string }> {
      const engine = new WorkflowEngine(makeDeps(projectRoot, { newId: phaseIds(tag) }));
      const started = await engine.startOperation(
        makeStartInput({ iterationId: `iteration_${tag}` }),
      );
      const id = started.operation.workflow_operation_id;
      const digest =
        decision === "none"
          ? "f".repeat(64)
          : await plantArtifact(
              projectRoot,
              id,
              started.operation.attempt_id,
              `artifacts/approvals/approval_${tag}.json`,
              approval(decision, tag),
            );
      await engine.advance(id, "awaiting_approval");
      await engine.commitCheckpoint(id, {
        boundary: "approval",
        proposal: { add_approval_digests: [digest] },
      });
      await engine.block(id, { reason: "awaiting_approval", detail: "waiting" });
      return { id, digest };
    }

    // A binding with no committed decision artifact is rejected.
    const ghost = await blockedWithApprovalBinding("ghost", "none");
    await expect(resumeWorkflowOperation(resumeDeps(projectRoot), ghost.id)).rejects.toMatchObject({
      name: "WorkflowError",
      kind: "approval_invalid",
    });

    // A binding whose decision is not approve is rejected.
    const rejected = await blockedWithApprovalBinding("rejected", "reject");
    await expect(
      resumeWorkflowOperation(resumeDeps(projectRoot), rejected.id),
    ).rejects.toMatchObject({ name: "WorkflowError", kind: "approval_invalid" });

    // A valid approval binding resumes.
    const approved = await blockedWithApprovalBinding("approved", "approve");
    const outcome = await resumeWorkflowOperation(resumeDeps(projectRoot), approved.id);
    expect(outcome.resumedState).toBe("awaiting_approval");
  });

  it("re-verifies the context bundle binding before resuming", async () => {
    const projectRoot = makeProjectRoot();
    const bundleDigest = "d".repeat(64);
    const bundle = (stale: boolean, idSuffix: string): Record<string, unknown> => ({
      protocol_version: PROTOCOL_VERSION,
      record_kind: "context_bundle",
      context_bundle_id: `context_${idSuffix}`,
      task_id: "task_alpha",
      source_digests: ["c".repeat(64)],
      digest: bundleDigest,
      stale,
    });

    async function blockedWithBundle(
      tag: string,
      plant: "fresh" | "stale" | "none",
    ): Promise<string> {
      const engine = new WorkflowEngine(makeDeps(projectRoot, { newId: phaseIds(tag) }));
      const started = await engine.startOperation(
        makeStartInput({ iterationId: `iteration_${tag}` }),
      );
      const id = started.operation.workflow_operation_id;
      if (plant !== "none") {
        await plantArtifact(
          projectRoot,
          id,
          started.operation.attempt_id,
          `artifacts/context-bundles/context_${tag}.json`,
          bundle(plant === "stale", tag),
        );
      }
      await engine.commitCheckpoint(id, {
        boundary: "task",
        proposal: { set_context_bundle_digest: bundleDigest },
      });
      await engine.block(id, { reason: "stale_evidence", detail: "source drift" });
      return id;
    }

    const fresh = await blockedWithBundle("fresh", "fresh");
    const outcome = await resumeWorkflowOperation(resumeDeps(projectRoot), fresh);
    expect(outcome.resumedState).toBe("created");

    const stale = await blockedWithBundle("stale", "stale");
    await expect(resumeWorkflowOperation(resumeDeps(projectRoot), stale)).rejects.toMatchObject({
      name: "WorkflowError",
      kind: "context_bundle_invalid",
    });

    const missing = await blockedWithBundle("missing", "none");
    await expect(resumeWorkflowOperation(resumeDeps(projectRoot), missing)).rejects.toMatchObject({
      name: "WorkflowError",
      kind: "context_bundle_invalid",
    });
  });

  it("closes an interrupted run with progress evidence as partial", async () => {
    const projectRoot = makeProjectRoot();
    const { workflowOperationId, attemptId, runId } = await blockedWithRun(projectRoot);

    await plantArtifact(
      projectRoot,
      workflowOperationId,
      attemptId,
      runRecordArtifactPath(runId, 2, "run_progress"),
      {
        protocol_version: PROTOCOL_VERSION,
        record_kind: "run_progress",
        run_id: runId,
        task_id: "task_alpha",
        workflow_operation_id: workflowOperationId,
        attempt_id: attemptId,
        sequence: 2,
        timestamp: FIXED_NOW,
        step: 1,
        message: "partial output captured",
        evidence_id: "evidence_p01",
      },
    );

    const outcome = await resumeWorkflowOperation(resumeDeps(projectRoot), workflowOperationId);
    const streams = readRunStreams(makeDeps(projectRoot), workflowOperationId);
    const oldStream = streams.find((stream) => stream.runId === runId);
    expect(oldStream?.records.at(-1)).toMatchObject({
      record_kind: "run_interrupted",
      outcome: "partial",
      sequence: 3,
      partial_evidence_ids: ["evidence_p01"],
    });
    expect(validateRunRecordStream(oldStream?.records ?? []).valid).toBe(true);
    expect(outcome.resumedRuns[0]?.successorRunId).toBeDefined();
  });
});
