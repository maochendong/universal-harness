import { afterEach, describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
  canonicalizeJson,
  contentDigest,
  harnessRootFor,
  readCommittedOperations,
  resolveHarnessPath,
  type NodeRecord,
} from "@universal-harness-internal/core";

import {
  anchorSnapshot,
  buildSnapshot,
  createNewProject,
  hashCommitCode,
  hashWorktreeCode,
  resolveSnapshotSourceCommit,
  type SnapshotAnchorError,
} from "../../src/index.js";
import {
  FIXED_NOW,
  cleanupDirectories,
  git,
  headOf,
  makeTempDir,
  makeRepo,
  sequentialIds,
  writeTree,
} from "../bootstrap/helpers.js";

afterEach(cleanupDirectories);

describe("snapshot source anchors", () => {
  it("hashes a clean mixed-case Git tree exactly like its worktree", () => {
    const projectRoot = makeRepo({
      "README.md": "# Fixture\n",
      "index.ts": "export const answer = 42;\n",
    });
    writeTree(projectRoot, { ".harness/uncommitted.json": "{}\n" });

    expect(hashCommitCode(projectRoot, headOf(projectRoot))).toBe(hashWorktreeCode(projectRoot));
  });

  it("appends a verified correction, retries idempotently and rejects a conflicting anchor", async () => {
    const created = await createNewProject(
      {
        parentDirectory: makeTempDir("harness-snapshot-anchor-"),
        name: "anchor-project",
        intent: "prove a historical snapshot against its source commit",
      },
      {
        vcs: (await import("@universal-harness-internal/adapter-vcs-git")).createGitVcsAdapter(),
        now: () => FIXED_NOW,
        newId: sequentialIds(),
      },
    );
    if (!created.ok) throw new Error(created.error.message);
    const projectRoot = created.value.projectRoot;
    const originalCommit = headOf(projectRoot);

    writeTree(projectRoot, {
      "README.md": "# Anchor fixture\n",
      "src/example.ts": "export const answer = 42;\n",
    });
    git(projectRoot, "add", "README.md", "src/example.ts");
    git(projectRoot, "commit", "-m", "feat: add verified source");
    const sourceCommit = headOf(projectRoot);
    const evidenceId = "evidence_snapshot_anchor";
    const snapshotId = "snapshot_historical";
    const codeDigest = hashWorktreeCode(projectRoot);
    const operation = readCommittedOperations(harnessRootFor(projectRoot)).at(-1)?.manifest;
    if (operation === undefined) throw new Error("bootstrap operation missing");

    const evidenceContent: Record<string, unknown> = {
      protocol_version: PROTOCOL_VERSION,
      record_kind: "node",
      id: evidenceId,
      type: "Evidence",
      revision: 1,
      status: "accepted",
      source: "gate",
      provenance: {
        iteration_id: created.value.iterationId,
        actor: "test-fixture",
        timestamp: FIXED_NOW,
      },
      confidence: 1,
      extensions: {
        "harness.evidence": {
          artifact_digest: "a".repeat(64),
          gate_id: "gate_snapshot_anchor",
          passed: true,
          bindings: { code_digests: [codeDigest] },
        },
      },
    };
    const evidence = {
      ...evidenceContent,
      digest: contentDigest(evidenceContent),
    } as unknown as NodeRecord;
    const snapshot = buildSnapshot({
      snapshot_id: snapshotId,
      iteration_id: created.value.iterationId,
      final_commit: originalCommit,
      workflow_operation_id: operation.workflow_operation_id,
      created_at: FIXED_NOW,
      tasks: [{ task_id: "task_snapshot_anchor", required: true, outcome: "success" }],
      evidence: [
        {
          evidence_id: evidenceId,
          mandatory: true,
          passed: true,
          provisional: false,
          stale: false,
        },
      ],
    });
    writeTree(projectRoot, {
      [`.harness/artifacts/evidence-nodes/${evidenceId}/1.json`]: `${canonicalizeJson(evidence)}\n`,
      [`.harness/artifacts/snapshots/${snapshotId}.json`]: `${canonicalizeJson(snapshot)}\n`,
    });

    const first = await anchorSnapshot({
      projectRoot,
      snapshotId,
      sourceCommit,
      reason: "the legacy snapshot recorded its ledger commit",
      actor: "human:test",
      readBaseline: () => headOf(projectRoot),
      now: () => FIXED_NOW,
    });
    expect(first.status).toBe("created");
    expect(first.correction.corrected_source_commit).toBe(sourceCommit);
    expect(first.correction.code_digest).toBe(codeDigest);
    expect(resolveSnapshotSourceCommit(projectRoot, snapshot)).toBe(sourceCommit);
    expect(
      resolveHarnessPath(
        harnessRootFor(projectRoot),
        `artifacts/snapshot-anchor-corrections/${snapshotId}/${first.correction.digest}.json`,
      ),
    ).toBeTruthy();

    const retry = await anchorSnapshot({
      projectRoot,
      snapshotId,
      sourceCommit,
      reason: "the legacy snapshot recorded its ledger commit",
      actor: "human:test",
      readBaseline: () => headOf(projectRoot),
      now: () => FIXED_NOW,
    });
    expect(retry.status).toBe("already_anchored");
    expect(retry.correction.digest).toBe(first.correction.digest);

    await expect(
      anchorSnapshot({
        projectRoot,
        snapshotId,
        sourceCommit: originalCommit,
        reason: "conflicting correction",
        actor: "human:test",
        readBaseline: () => headOf(projectRoot),
        now: () => FIXED_NOW,
      }),
    ).rejects.toMatchObject<Partial<SnapshotAnchorError>>({ kind: "anchor_conflict" });
  });
});
