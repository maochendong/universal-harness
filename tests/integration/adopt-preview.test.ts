import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LedgerRepository, scannedNodeId } from "../../packages/core/src/index.js";
import { createRuntimeService, discardStagedDocuments } from "../../packages/runtime/src/index.js";
import {
  cleanupDirectories,
  git,
  headOf,
  makeDeps,
  makeRepo,
  writeTree,
} from "../../packages/runtime/test/bootstrap/helpers.js";

/**
 * Adoption preview integration (plan Task 9): before approval the authority
 * ledger does not change, a rejected preview leaves the repository pristine,
 * and an approved preview commits a deterministic baseline.
 */
afterEach(cleanupDirectories);

const FIXTURE_FILES: Readonly<Record<string, string>> = {
  ".gitignore": "node_modules/\n",
  "package.json": '{"name":"fixture","version":"0.0.0"}\n',
  "src/index.ts": "import { helper } from './helper';\nexport const x = helper;\n",
  "src/helper.ts": "export const helper = 1;\n",
  "src/index.test.ts": "import { x } from './index';\n",
  "README.md": "# Fixture\n",
};

function makeFixtureRepo(): string {
  const root = makeRepo(FIXTURE_FILES, "fixture-app");
  writeTree(root, { "node_modules/leftpad/index.js": "module.exports = 1;\n" });
  return root;
}

function worktreeEntries(root: string): string {
  return git(root, "status", "--porcelain").trim();
}

describe("adoption preview integration", () => {
  it("changes no authoritative state before approval", async () => {
    const root = makeFixtureRepo();
    const service = createRuntimeService(makeDeps());
    const headBefore = headOf(root);
    const refsBefore = git(root, "for-each-ref", "--format=%(refname)");

    const preview = await service.prepareAdoption({ projectRoot: root, intent: "change it" });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    // The only observable change is local staging scratch space.
    expect(worktreeEntries(root)).toBe("?? .harness/");
    expect(existsSync(join(root, ".harness", "manifest.yaml"))).toBe(false);
    expect(existsSync(join(root, ".harness", "ledger"))).toBe(false);
    expect(headOf(root)).toBe(headBefore);
    expect(git(root, "for-each-ref", "--format=%(refname)")).toBe(refsBefore);
    expect(preview.value.preview.conflicts).toEqual([]);
    expect(preview.value.preview.unknown_items).toEqual([]);

    // Rejecting and discarding the preview restores a pristine worktree.
    const rejected = await service.commitAdoption({
      projectRoot: root,
      stagingOperationId: preview.value.stagingOperationId,
      approval: {
        decision: "reject",
        previewDigest: preview.value.previewDigest,
        actor: "reviewer",
      },
    });
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    expect(rejected.value.committed).toBe(false);
    discardStagedDocuments(root, preview.value.stagingOperationId);
    expect(worktreeEntries(root)).toBe("");
    expect(existsSync(join(root, ".harness"))).toBe(false);
    expect(headOf(root)).toBe(headBefore);
  });

  it("commits a deterministic, repository-qualified baseline after approval", async () => {
    const root = makeFixtureRepo();
    const service = createRuntimeService(makeDeps());
    const userHead = headOf(root);

    const preview = await service.prepareAdoption({ projectRoot: root, intent: "change it" });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const committed = await service.commitAdoption({
      projectRoot: root,
      stagingOperationId: preview.value.stagingOperationId,
      approval: {
        decision: "approve",
        previewDigest: preview.value.previewDigest,
        actor: "reviewer",
      },
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const value = committed.value;

    // The user's branch is untouched; work continues on the bootstrap branch.
    expect(git(root, "rev-parse", "main").trim()).toBe(userHead);
    expect(git(root, "branch", "--show-current").trim()).toBe(value.branch as string);
    expect(worktreeEntries(root)).toBe("");

    // Ledger replay reproduces every scanned node with repository-qualified,
    // reproducible identities (design section 16: same repository and
    // configuration produce the same node IDs).
    const projectId = `project_${preview.value.name}`;
    const repositoryId = preview.value.repositoryId;
    const replay = new LedgerRepository({
      projectRoot: root,
      readBaseline: () => userHead,
    }).replay();
    expect(replay.operations).toHaveLength(1);
    expect(replay.operations[0]?.manifest.baseline_commit).toBe(userHead);

    const expectedRepositoryId = scannedNodeId({
      project_id: projectId,
      repository_id: repositoryId,
      type: "Repository",
      locator: `repo://${repositoryId}`,
    });
    expect(value.repositoryNodeId).toBe(expectedRepositoryId);
    expect(
      existsSync(
        join(root, ".harness", "artifacts", "repositories", `${expectedRepositoryId}.json`),
      ),
    ).toBe(true);

    // Containment edges connect repository -> component and repository ->
    // file; component membership follows the design relation matrix (design
    // 8.3) as CodeArtifact REALIZES Component.
    const componentId = scannedNodeId({
      project_id: projectId,
      repository_id: repositoryId,
      type: "Component",
      locator: `repo://${repositoryId}/src`,
    });
    const fileId = scannedNodeId({
      project_id: projectId,
      repository_id: repositoryId,
      type: "CodeArtifact",
      locator: `repo://${repositoryId}/src/index.ts`,
    });
    const edgeEndpoints = replay.edges.map(
      (edge) => `${edge.type}:${edge.source_id}->${edge.target_id}`,
    );
    expect(edgeEndpoints).toContain(`CONTAINS:${expectedRepositoryId}->${componentId}`);
    expect(edgeEndpoints).toContain(`CONTAINS:${expectedRepositoryId}->${fileId}`);
    expect(edgeEndpoints).toContain(`REALIZES:${fileId}->${componentId}`);

    // The semantic edge proposal input was staged for later enrichment, but
    // no inferred edge entered the committed baseline.
    expect(
      replay.edges.every(
        (edge) =>
          edge.type === "CONTAINS" || edge.type === "DERIVES_FROM" || edge.type === "REALIZES",
      ),
    ).toBe(true);
  });
});
