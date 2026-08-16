import { readFileSync, writeFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  LedgerRepository,
  harnessRootFor,
  resolveHarnessPath,
} from "@universal-harness-internal/core";

import {
  CheckpointError,
  WorkflowEngine,
  WorkingStateError,
  buildCheckpointArtifacts,
  latestValidCheckpoint,
  listValidCheckpoints,
  type WorkingState,
} from "../../src/index.js";
import type { WorkingStateWriter } from "../../src/workflow/working-state.js";
import {
  BASELINE,
  cleanupDirectories,
  makeDeps,
  makeProjectRoot,
  makeStartInput,
  phaseIds,
} from "./helpers.js";

afterEach(() => {
  cleanupDirectories();
});

function minimalState(): WorkingState {
  return {
    goal: "g",
    baseline_commit: BASELINE,
    requirement_baseline_digest: "a".repeat(64),
    policy_digest: "b".repeat(64),
    phase: "p",
    confirmed_facts: [],
    rejected_hypotheses: [],
    open_questions: [],
    blockers: [],
    completed_task_ids: [],
    pending_task_ids: [],
    budget: { used_steps: 0, used_tokens: 0, ceiling_steps: 1, ceiling_tokens: 1 },
    capability_grants: [],
    approval_digests: [],
    input_digests: [],
    external_action_intents: [],
  };
}

describe("checkpoint serialization discipline", () => {
  it("refuses to serialize WorkingState without the engine writer token", () => {
    const forged = { role: "workflow-engine" } as WorkingStateWriter;
    expect(() =>
      buildCheckpointArtifacts(forged, {
        checkpoint_id: "checkpoint_x01",
        workflow_operation_id: "workflow_x01",
        attempt_id: "attempt_x01",
        phase: "p",
        timestamp: "2026-08-12T00:00:00.000Z",
        working_state: minimalState(),
      }),
    ).toThrowError(WorkingStateError);
  });
});

describe("checkpoint read-back", () => {
  it("persists only blockers still live under authoritative lifecycle facts", async () => {
    const projectRoot = makeProjectRoot();
    const engine = new WorkflowEngine(makeDeps(projectRoot, { newId: phaseIds("live") }));
    const started = await engine.startOperation(makeStartInput());
    const id = started.operation.workflow_operation_id;
    await engine.commitCheckpoint(id, {
      boundary: "task",
      proposal: {
        add_blockers: [
          "task task_done did not complete: old failure",
          "blocking finding finding_closed",
          "waiting on the user",
        ],
      },
    });
    const checkpoint = await engine.commitCheckpoint(id, {
      boundary: "task",
      proposal: {
        reconcile_blockers: {
          passed_task_ids: ["task_done"],
          inactive_finding_ids: ["finding_closed"],
        },
      },
    });

    const repository = new LedgerRepository({ projectRoot, readBaseline: () => BASELINE });
    const latest = latestValidCheckpoint(harnessRootFor(projectRoot), repository.operations(), id);
    expect(latest?.record.checkpoint_id).toBe(checkpoint.checkpoint_id);
    expect(latest?.workingState.blockers).toEqual(["waiting on the user"]);
  });

  it("chains checkpoints through previous_checkpoint_id", async () => {
    const projectRoot = makeProjectRoot();
    const engine = new WorkflowEngine(makeDeps(projectRoot, { newId: phaseIds("chain") }));
    const started = await engine.startOperation(makeStartInput());
    const id = started.operation.workflow_operation_id;
    await engine.commitCheckpoint(id, { boundary: "task", proposal: { phase: "execution" } });
    await engine.commitCheckpoint(id, { boundary: "gate", proposal: { phase: "verification" } });

    const repository = new LedgerRepository({ projectRoot, readBaseline: () => BASELINE });
    const checkpoints = listValidCheckpoints(
      harnessRootFor(projectRoot),
      repository.operations(),
      id,
    );
    expect(checkpoints).toHaveLength(3);
    expect(checkpoints[0]?.workingState.previous_checkpoint_id).toBeUndefined();
    expect(checkpoints[1]?.workingState.previous_checkpoint_id).toBe(
      checkpoints[0]?.record.checkpoint_id,
    );
    expect(checkpoints[2]?.workingState.previous_checkpoint_id).toBe(
      checkpoints[1]?.record.checkpoint_id,
    );
    expect(checkpoints[2]?.workingState.phase).toBe("verification");
  });

  it("skips a corrupt newest checkpoint in favor of the latest valid one", async () => {
    const projectRoot = makeProjectRoot();
    const engine = new WorkflowEngine(makeDeps(projectRoot, { newId: phaseIds("corr") }));
    const started = await engine.startOperation(makeStartInput());
    const id = started.operation.workflow_operation_id;
    await engine.commitCheckpoint(id, { boundary: "task", proposal: { phase: "execution" } });
    const newest = await engine.commitCheckpoint(id, {
      boundary: "gate",
      proposal: { phase: "verification" },
    });

    // Flip the first byte of the newest checkpoint's WorkingState document:
    // its bytes no longer match any committed manifest digest.
    const workingStatePath = resolveHarnessPath(
      harnessRootFor(projectRoot),
      `artifacts/working-state/${newest.checkpoint_id}.json`,
    );
    const bytes = readFileSync(workingStatePath, "utf8");
    writeFileSync(workingStatePath, `[${bytes.slice(1)}`, "utf8");

    const repository = new LedgerRepository({ projectRoot, readBaseline: () => BASELINE });
    const latest = latestValidCheckpoint(harnessRootFor(projectRoot), repository.operations(), id);
    expect(latest?.workingState.phase).toBe("execution");
    expect(latest?.record.checkpoint_id).not.toBe(newest.checkpoint_id);
  });

  it("reports checkpoints for unknown operations as absent, not corrupt", () => {
    const projectRoot = makeProjectRoot();
    const repository = new LedgerRepository({ projectRoot, readBaseline: () => BASELINE });
    expect(
      latestValidCheckpoint(harnessRootFor(projectRoot), repository.operations(), "workflow_none"),
    ).toBeUndefined();
  });
});

describe("checkpoint errors", () => {
  it("carries a typed kind", () => {
    expect(new CheckpointError("checkpoint_not_found", "missing").kind).toBe(
      "checkpoint_not_found",
    );
  });
});
