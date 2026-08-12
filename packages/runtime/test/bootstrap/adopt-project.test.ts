import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LedgerRepository,
  readManagedManifest,
  scannedNodeId,
} from "@universal-harness-internal/core";

import {
  commitAdoption,
  createNewProject,
  prepareAdoption,
  projectNameForPath,
} from "../../src/index.js";
import {
  cleanupDirectories,
  git,
  headOf,
  makeDeps,
  makeRepo,
  makeTempDir,
  writeTree,
} from "./helpers.js";

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
  // Git-ignored cache content: present in the worktree, never scanned.
  writeTree(root, { "node_modules/leftpad/index.js": "module.exports = 1;\n" });
  return root;
}

function harnessExists(root: string, relative: string): boolean {
  return existsSync(join(root, ".harness", relative));
}

describe("prepareAdoption", () => {
  it("stages only into .harness/staging and leaves authority untouched", async () => {
    const root = makeFixtureRepo();
    const headBefore = headOf(root);
    const outcome = await prepareAdoption({ projectRoot: root, intent: "change it" }, makeDeps());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const value = outcome.value;

    expect(value.name).toBe(projectNameForPath(root));
    expect(value.baselineCommit).toBe(headBefore);
    expect(value.preview.files.map((file) => file.path)).toEqual([
      ".gitignore",
      "README.md",
      "package.json",
      "src/helper.ts",
      "src/index.test.ts",
      "src/index.ts",
    ]);
    expect(value.preview.stack.primary).toBe("node");
    expect(value.preview.components).toEqual([{ path: "src", file_count: 3 }]);
    expect(value.preview.conflicts).toEqual([]);
    expect(value.preview.unknown_items).toEqual([]);
    expect(value.semanticInput).toContainEqual({
      path: "src/index.ts",
      language: "typescript",
      references: ["./helper"],
    });

    // Staging is the only change; no manifest, ledger or git mutation.
    expect(harnessExists(root, `staging/${value.stagingOperationId}/preview.json`)).toBe(true);
    expect(harnessExists(root, "manifest.yaml")).toBe(false);
    expect(harnessExists(root, "ledger")).toBe(false);
    expect(headOf(root)).toBe(headBefore);
    expect(git(root, "branch", "--show-current").trim()).toBe("main");
    expect(git(root, "status", "--porcelain").trim()).toBe("?? .harness/");
  });

  it("produces the same preview digest for repeated previews", async () => {
    const root = makeFixtureRepo();
    const first = await prepareAdoption({ projectRoot: root, intent: "a" }, makeDeps());
    const second = await prepareAdoption({ projectRoot: root, intent: "b" }, makeDeps());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.previewDigest).toBe(second.value.previewDigest);
  });

  it("produces the same preview digest for identical repositories", async () => {
    // The preview binds the baseline commit hash, so identical repositories
    // means identical commits: pin git timestamps for this comparison.
    const savedAuthorDate = process.env.GIT_AUTHOR_DATE;
    const savedCommitterDate = process.env.GIT_COMMITTER_DATE;
    process.env.GIT_AUTHOR_DATE = "2026-08-12T00:00:00Z";
    process.env.GIT_COMMITTER_DATE = "2026-08-12T00:00:00Z";
    try {
      const first = await prepareAdoption(
        { projectRoot: makeFixtureRepo(), intent: "x" },
        makeDeps(),
      );
      const second = await prepareAdoption(
        { projectRoot: makeFixtureRepo(), intent: "x" },
        makeDeps(),
      );
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(first.value.previewDigest).toBe(second.value.previewDigest);
    } finally {
      if (savedAuthorDate === undefined) delete process.env.GIT_AUTHOR_DATE;
      else process.env.GIT_AUTHOR_DATE = savedAuthorDate;
      if (savedCommitterDate === undefined) delete process.env.GIT_COMMITTER_DATE;
      else process.env.GIT_COMMITTER_DATE = savedCommitterDate;
    }
  });

  it("refuses dirty worktrees, non-repositories and unborn branches", async () => {
    const dirty = makeFixtureRepo();
    writeTree(dirty, { "src/index.ts": "export const changed = true;\n" });
    const dirtyOutcome = await prepareAdoption({ projectRoot: dirty, intent: "x" }, makeDeps());
    expect(dirtyOutcome.ok).toBe(false);
    if (dirtyOutcome.ok) return;
    expect(dirtyOutcome.error.kind).toBe("worktree_dirty");

    const untracked = makeFixtureRepo();
    writeTree(untracked, { "new-file.ts": "export {};\n" });
    const untrackedOutcome = await prepareAdoption(
      { projectRoot: untracked, intent: "x" },
      makeDeps(),
    );
    expect(untrackedOutcome.ok).toBe(false);
    if (untrackedOutcome.ok) return;
    expect(untrackedOutcome.error.kind).toBe("worktree_dirty");

    const outside = makeTempDir("harness-adopt-outside-");
    const outsideOutcome = await prepareAdoption({ projectRoot: outside, intent: "x" }, makeDeps());
    expect(outsideOutcome.ok).toBe(false);
    if (outsideOutcome.ok) return;
    expect(outsideOutcome.error.kind).toBe("not_a_repository");

    const unborn = makeTempDir("harness-adopt-unborn-");
    git(unborn, "init", "-b", "main");
    const unbornOutcome = await prepareAdoption({ projectRoot: unborn, intent: "x" }, makeDeps());
    expect(unbornOutcome.ok).toBe(false);
    if (unbornOutcome.ok) return;
    expect(unbornOutcome.error.kind).toBe("no_baseline_commit");

    const missing = await prepareAdoption(
      { projectRoot: join(outside, "nope"), intent: "x" },
      makeDeps(),
    );
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.kind).toBe("path_not_found");
  });

  it("refuses to adopt an already managed project", async () => {
    const parent = makeTempDir("harness-adopt-managed-");
    const created = await createNewProject(
      { parentDirectory: parent, name: "demo-app", intent: "x" },
      makeDeps(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const outcome = await prepareAdoption(
      { projectRoot: created.value.projectRoot, intent: "x" },
      makeDeps(),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("already_managed");
  });
});

describe("commitAdoption", () => {
  async function staged(): Promise<{
    root: string;
    name: string;
    repositoryId: string;
    stagingOperationId: string;
    previewDigest: string;
  }> {
    const root = makeFixtureRepo();
    const prepared = await prepareAdoption({ projectRoot: root, intent: "change it" }, makeDeps());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("prepare failed");
    return {
      root,
      name: prepared.value.name,
      repositoryId: prepared.value.repositoryId,
      stagingOperationId: prepared.value.stagingOperationId,
      previewDigest: prepared.value.previewDigest,
    };
  }

  it("rejects without producing any authoritative change", async () => {
    const { root, stagingOperationId, previewDigest } = await staged();
    const headBefore = headOf(root);
    const outcome = await commitAdoption(
      {
        projectRoot: root,
        stagingOperationId,
        approval: { decision: "reject", previewDigest, actor: "reviewer" },
      },
      makeDeps(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.committed).toBe(false);
    expect(outcome.value.rejected).toBe(true);
    // Rejected staging survives for revision; authority is untouched.
    expect(harnessExists(root, `staging/${stagingOperationId}/preview.json`)).toBe(true);
    expect(harnessExists(root, "manifest.yaml")).toBe(false);
    expect(headOf(root)).toBe(headBefore);
    expect(git(root, "for-each-ref", "refs/heads", "--format=%(refname:short)").trim()).toBe(
      "main",
    );
  });

  it("blocks an approval that binds a different preview digest", async () => {
    const { root, stagingOperationId } = await staged();
    const outcome = await commitAdoption(
      {
        projectRoot: root,
        stagingOperationId,
        approval: { decision: "approve", previewDigest: "f".repeat(64), actor: "reviewer" },
      },
      makeDeps(),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("approval_binding_mismatch");
    expect(harnessExists(root, "manifest.yaml")).toBe(false);
  });

  it("blocks when the repository drifted after the preview", async () => {
    const { root, stagingOperationId, previewDigest } = await staged();
    writeTree(root, { "src/added.ts": "export {};\n" });
    git(root, "add", "-A");
    git(root, "commit", "-m", "drift");
    const outcome = await commitAdoption(
      {
        projectRoot: root,
        stagingOperationId,
        approval: { decision: "approve", previewDigest, actor: "reviewer" },
      },
      makeDeps(),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("preview_drift");
    expect(harnessExists(root, "manifest.yaml")).toBe(false);
  });

  it("reports missing staging as a typed error", async () => {
    const root = makeFixtureRepo();
    const outcome = await commitAdoption(
      {
        projectRoot: root,
        stagingOperationId: "adopt-scan_missing",
        approval: { decision: "approve", previewDigest: "f".repeat(64), actor: "reviewer" },
      },
      makeDeps(),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("staging_not_found");
  });

  it("commits the deterministic baseline on approval and leaves main untouched", async () => {
    const { root, name, repositoryId, stagingOperationId, previewDigest } = await staged();
    const userHead = headOf(root);
    const outcome = await commitAdoption(
      {
        projectRoot: root,
        stagingOperationId,
        approval: { decision: "approve", previewDigest, actor: "reviewer" },
      },
      makeDeps(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const value = outcome.value;
    expect(value.committed).toBe(true);
    expect(value.baselineCommit).toBe(userHead);
    expect(value.branch).toBe("harness/iteration_t0001-bootstrap");

    // The user's branch is untouched; the bootstrap branch carries the
    // harness commit on top of the adopted baseline.
    expect(git(root, "rev-parse", "main").trim()).toBe(userHead);
    expect(git(root, "branch", "--show-current").trim()).toBe(value.branch as string);
    expect(headOf(root)).toBe(value.headCommit);
    expect(git(root, "status", "--porcelain").trim()).toBe("");

    const manifest = readManagedManifest(root);
    expect(manifest.name).toBe(name);
    expect(manifest.repository_id).toBe(repositoryId);
    const lock = JSON.parse(readFileSync(join(root, ".harness", "harness.lock"), "utf8")) as {
      packs: { name: string }[];
    };
    expect(lock.packs.map((pack) => pack.name)).toEqual(["pack-node"]);

    // Staging is consumed; the ledger holds the accepted baseline.
    expect(harnessExists(root, "staging")).toBe(false);
    const ledger = new LedgerRepository({
      projectRoot: root,
      readBaseline: () => userHead,
    });
    const replay = ledger.replay();
    expect(replay.operations).toHaveLength(1);
    expect(replay.operations[0]?.manifest.baseline_commit).toBe(userHead);
    expect(replay.events.map((event) => event.event_type)).toEqual([
      "OperationStarted",
      "OperationCompleted",
    ]);

    // Node identities are repository-qualified and reproducible.
    const projectId = `project_${name}`;
    const expected = (
      type: "Repository" | "Component" | "CodeArtifact" | "Test",
      locator: string,
    ) =>
      scannedNodeId({
        project_id: projectId,
        repository_id: repositoryId,
        type,
        locator,
      });
    const nodeIds = readdirSync(join(root, ".harness", "artifacts", "code-artifacts"));
    expect(nodeIds).toContain(
      `${expected("CodeArtifact", `repo://${repositoryId}/src/index.ts`)}.json`,
    );
    expect(readdirSync(join(root, ".harness", "artifacts", "tests"))).toEqual([
      `${expected("Test", `repo://${repositoryId}/src/index.test.ts`)}.json`,
    ]);
    expect(readdirSync(join(root, ".harness", "artifacts", "components"))).toEqual([
      `${expected("Component", `repo://${repositoryId}/src`)}.json`,
    ]);
    expect(replay.edges).toHaveLength(value.edgeCount);
    expect(value.nodeCount).toBe(9);
  });

  it("commits byte-identical baselines for identical repositories", async () => {
    // Pin git timestamps so user and harness commit hashes — and the
    // recorded baseline binding — are reproducible for identical inputs.
    const savedAuthorDate = process.env.GIT_AUTHOR_DATE;
    const savedCommitterDate = process.env.GIT_COMMITTER_DATE;
    process.env.GIT_AUTHOR_DATE = "2026-08-12T00:00:00Z";
    process.env.GIT_COMMITTER_DATE = "2026-08-12T00:00:00Z";
    try {
      const rootA = makeFixtureRepo();
      const rootB = makeFixtureRepo();
      expect(headOf(rootA)).toBe(headOf(rootB));
      const preparedA = await prepareAdoption({ projectRoot: rootA, intent: "x" }, makeDeps());
      const preparedB = await prepareAdoption({ projectRoot: rootB, intent: "x" }, makeDeps());
      expect(preparedA.ok && preparedB.ok).toBe(true);
      if (!preparedA.ok || !preparedB.ok) return;
      expect(preparedA.value.previewDigest).toBe(preparedB.value.previewDigest);

      const committedA = await commitAdoption(
        {
          projectRoot: rootA,
          stagingOperationId: preparedA.value.stagingOperationId,
          approval: {
            decision: "approve",
            previewDigest: preparedA.value.previewDigest,
            actor: "r",
          },
        },
        makeDeps(),
      );
      const committedB = await commitAdoption(
        {
          projectRoot: rootB,
          stagingOperationId: preparedB.value.stagingOperationId,
          approval: {
            decision: "approve",
            previewDigest: preparedB.value.previewDigest,
            actor: "r",
          },
        },
        makeDeps(),
      );
      expect(committedA.ok && committedB.ok).toBe(true);
      if (!committedA.ok || !committedB.ok) return;
      expect(committedA.value.repositoryNodeId).toBe(committedB.value.repositoryNodeId);
      expect(committedA.value.nodeCount).toBe(committedB.value.nodeCount);
      expect(committedA.value.headCommit).toBe(committedB.value.headCommit);

      const readTree = (root: string): Record<string, string> => {
        const result: Record<string, string> = {};
        const walk = (directory: string, prefix: string): void => {
          for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
            const absolute = join(directory, entry.name);
            if (entry.isDirectory()) walk(absolute, relative);
            else if (entry.isFile()) result[relative] = readFileSync(absolute, "utf8");
          }
        };
        walk(join(root, ".harness"), "");
        return result;
      };
      expect(readTree(rootA)).toEqual(readTree(rootB));
    } finally {
      if (savedAuthorDate === undefined) delete process.env.GIT_AUTHOR_DATE;
      else process.env.GIT_AUTHOR_DATE = savedAuthorDate;
      if (savedCommitterDate === undefined) delete process.env.GIT_COMMITTER_DATE;
      else process.env.GIT_COMMITTER_DATE = savedCommitterDate;
    }
  });
});
