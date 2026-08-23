import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPackLock,
  createProjectManifest,
  harnessRootFor,
  initializeManagedLayout,
  replayLedger,
} from "@universal-harness-internal/core";

import { LedgerDagCheckpointStore, type DagCheckpointEntry } from "../../src/index.js";

const roots: string[] = [];

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-ledger-dag-"));
  roots.push(root);
  initializeManagedLayout({
    projectRoot: root,
    manifest: createProjectManifest({
      name: "dag-store",
      repositoryId: "repository_dag-store",
      now: () => "2026-08-23T00:00:00.000Z",
    }),
    packLock: createPackLock([{ name: "pack-generic", version: "0.1.0", digest: "a".repeat(64) }]),
  });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function checkpoint(sequence: number, nodeId: string): DagCheckpointEntry {
  return {
    sequence,
    node_id: nodeId,
    plan_digest: "a".repeat(64),
    wiring_digest: "b".repeat(64),
    input_digests: {},
    output_digests: { requirement_baseline: "c".repeat(64) },
    checkpoint_id: `checkpoint_${nodeId}`,
  };
}

describe("LedgerDagCheckpointStore", () => {
  it("projects append-only commits and invalidation facts into the latest valid prefix", async () => {
    const root = projectRoot();
    const store = new LedgerDagCheckpointStore({
      projectRoot: root,
      project_id: "project_dag-store",
      iteration_id: "iteration_dag-store",
      attempt_id: "attempt_dag-store",
      readBaseline: () => "d".repeat(40),
      now: () => "2026-08-23T00:00:00.000Z",
    });

    await store.append("operation_dag-store", checkpoint(1, "capture"));
    await store.append("operation_dag-store", checkpoint(2, "design"));
    await store.truncate("operation_dag-store", 1);

    expect(await store.load("operation_dag-store")).toEqual([checkpoint(1, "capture")]);
    const events = replayLedger(harnessRootFor(root)).events;
    expect(events.map((event) => event.event_type)).toEqual([
      "CheckpointCommitted",
      "CheckpointCommitted",
      "CheckpointInvalidated",
    ]);
    expect(events.at(-1)?.payload).toMatchObject({
      dag_action: "invalidate_tail",
      keep: 1,
      invalidated_checkpoint_ids: ["checkpoint_design"],
    });
  });
});
