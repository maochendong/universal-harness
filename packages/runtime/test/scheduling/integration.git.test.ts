import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { contentDigest } from "@universal-harness-internal/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  CandidateIntegrationError,
  createGitWaveIntegrationGit,
  operationRefFor,
  sourceTreeDigest,
  type WaveIntegrationGitPort,
} from "../../src/scheduling/integration.js";
import type { TaskCandidatePatch } from "../../src/scheduling/workspace-manager.js";
import {
  cleanupDirectories,
  git,
  headOf,
  makeRepo,
  makeTempDir,
  writeTree,
} from "../bootstrap/helpers.js";

/**
 * Plan Task 10 step 2/5 against a real Git repository (M4 design §13.1/§13.3):
 * candidate worktrees are disposable and detached at the wave frozen base;
 * managed binary patches apply with `git apply --index` in Plan order; Task
 * commits carry the fixed Harness identity and message inputs (never agent
 * metadata); the source-tree digest excludes the `.harness` Ledger content;
 * the operation-local ref moves only through compare-and-swap.
 */

const IDENTITY = { name: "Harness Integration", email: "harness@integration.invalid" };

afterEach(cleanupDirectories);

interface Repo {
  readonly root: string;
  readonly managedRoot: string;
  readonly port: WaveIntegrationGitPort;
  readonly base: string;
}

function setup(): Repo {
  const root = makeRepo({ "README.md": "base\n", "src/a.ts": "export const a = 1;\n" });
  const managedRoot = join(makeTempDir("harness-m4-managed-"), "managed");
  const port = createGitWaveIntegrationGit({
    repositoryRoot: root,
    managedRoot,
    commitIdentity: IDENTITY,
  });
  return { root, managedRoot, port, base: headOf(root) };
}

/**
 * Produce a real managed patch artifact the way the Task workspace manager
 * does: a scratch worktree at base, content edits, then `git diff --binary`
 * of the fully staged state against the base.
 */
function makePatch(
  repo: Repo,
  taskId: string,
  edits: Readonly<Record<string, string>>,
  deletions: readonly string[] = [],
): TaskCandidatePatch {
  const scratch = join(makeTempDir("harness-m4-patch-"), "wt");
  git(repo.root, "worktree", "add", "--detach", scratch, repo.base);
  writeTree(scratch, edits);
  for (const path of deletions) git(scratch, "rm", "-q", path);
  git(scratch, "add", "-A");
  const patch = git(scratch, "diff", "--cached", "--binary", repo.base);
  git(repo.root, "worktree", "remove", "--force", scratch);
  const artifacts = join(repo.managedRoot, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const locator = join(artifacts, `${taskId}.patch`);
  writeFileSync(locator, patch, "utf8");
  return {
    task_id: taskId,
    baseline_commit: repo.base,
    changed_paths: [...Object.keys(edits), ...deletions].sort(),
    patch_locator: locator,
    patch_digest: contentDigest(patch),
    source_tree_digest: contentDigest(`tree:${taskId}`),
  };
}

describe("createGitWaveIntegrationGit", () => {
  it("rebuilds a candidate: detached worktree at base, Plan-order apply, Harness-owned commits", async () => {
    const repo = setup();
    const patchA = makePatch(repo, "task_a", { "src/a.ts": "export const a = 2;\n" });
    const patchB = makePatch(repo, "task_b", { "src/b.ts": "export const b = 1;\n" });

    const root = await repo.port.createCandidateWorktree({
      base_commit: repo.base,
      wave_index: 0,
    });
    // Plan order, even if task_b completed first.
    let head = repo.base;
    for (const patch of [patchA, patchB]) {
      await repo.port.applyManagedPatch({ worktree_root: root, patch });
      head = await repo.port.commitCandidate({
        worktree_root: root,
        task_id: patch.task_id,
        message: `harness: task ${patch.task_id} candidate`,
      });
    }

    expect(git(repo.root, "cat-file", "-e", `${head}^{commit}`)).toBe("");
    expect(git(repo.root, "show", `${head}:src/a.ts`)).toBe("export const a = 2;\n");
    expect(git(repo.root, "show", `${head}:src/b.ts`)).toBe("export const b = 1;\n");
    // The candidate is a linear chain of two Harness-owned commits on base.
    expect(git(repo.root, "rev-list", "--count", `${repo.base}..${head}`).trim()).toBe("2");
    const author = git(repo.root, "log", "-1", "--format=%an <%ae>", head).trim();
    expect(author).toBe(`${IDENTITY.name} <${IDENTITY.email}>`);
    expect(git(repo.root, "log", "-1", "--format=%s", head).trim()).toBe(
      "harness: task task_b candidate",
    );
    // The host repository HEAD never moved.
    expect(headOf(repo.root)).toBe(repo.base);

    await repo.port.discardWorktree(root);
    expect(await repo.port.listCandidateWorktrees()).toEqual([]);
  });

  it("applies managed binary patches byte-exactly", async () => {
    const repo = setup();
    // 256 distinct bytes exercise the binary patch path end to end.
    const binary = Buffer.from([...Array(256).keys()]).toString("base64");
    const patch = makePatch(repo, "task_bin", { "assets/blob.bin": binary });
    const root = await repo.port.createCandidateWorktree({
      base_commit: repo.base,
      wave_index: 0,
    });
    await repo.port.applyManagedPatch({ worktree_root: root, patch });
    const commit = await repo.port.commitCandidate({
      worktree_root: root,
      task_id: "task_bin",
      message: "harness: task task_bin candidate",
    });
    expect(git(repo.root, "show", `${commit}:assets/blob.bin`)).toBe(binary);
    await repo.port.discardWorktree(root);
  });

  it("rejects a patch artifact whose content no longer matches the committed digest", async () => {
    const repo = setup();
    const patch = makePatch(repo, "task_a", { "src/a.ts": "export const a = 2;\n" });
    writeFileSync(patch.patch_locator, `${patch.patch_digest}\n`, "utf8");
    const root = await repo.port.createCandidateWorktree({
      base_commit: repo.base,
      wave_index: 0,
    });
    await expect(
      repo.port.applyManagedPatch({ worktree_root: root, patch }),
    ).rejects.toMatchObject({ kind: "patch_digest_mismatch" });
    await repo.port.discardWorktree(root);
  });

  it("reports integration_conflict when a patch does not apply to the candidate tree", async () => {
    const repo = setup();
    const patchA = makePatch(repo, "task_a", { "src/a.ts": "export const a = 2;\n" });
    // task_b rewrote the same lines task_a patches: a genuine textual conflict.
    const conflicting = makePatch(repo, "task_c", { "src/a.ts": "export const a = 3;\n" });
    const root = await repo.port.createCandidateWorktree({
      base_commit: repo.base,
      wave_index: 0,
    });
    await repo.port.applyManagedPatch({ worktree_root: root, patch: patchA });
    await repo.port.commitCandidate({
      worktree_root: root,
      task_id: "task_a",
      message: "harness: task task_a candidate",
    });
    await expect(
      repo.port.applyManagedPatch({ worktree_root: root, patch: conflicting }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof CandidateIntegrationError && error.kind === "integration_conflict",
    );
    await repo.port.discardWorktree(root);
  });

  it("computes the source-tree digest excluding the Harness Ledger content", async () => {
    const root = makeRepo({ "src/a.ts": "export const a = 1;\n" });
    const sourceOnly = headOf(root);
    // A Ledger-only commit: identical source tree, extra .harness content.
    writeTree(root, { ".harness/ledger/operations/op.json": "{}\n" });
    git(root, "add", "-A");
    git(root, "commit", "-m", "ledger only");
    const withLedger = headOf(root);

    expect(await sourceTreeDigest(root, sourceOnly, { excludeHarnessLedger: true })).toBe(
      await sourceTreeDigest(root, withLedger, { excludeHarnessLedger: true }),
    );
    expect(await sourceTreeDigest(root, sourceOnly, { excludeHarnessLedger: false })).not.toBe(
      await sourceTreeDigest(root, withLedger, { excludeHarnessLedger: false }),
    );
  });

  it("moves the operation-local ref only through compare-and-swap", async () => {
    const repo = setup();
    const ref = operationRefFor("operation_git_test");
    expect(await repo.port.readRef(ref)).toBeUndefined();

    // Create-only CAS: succeeds when the ref is absent, fails otherwise.
    const first = headOf(repo.root);
    expect(await repo.port.compareAndSwapRef({ ref, expected: undefined, next: first })).toBe(true);
    expect(await repo.port.readRef(ref)).toBe(first);
    expect(await repo.port.compareAndSwapRef({ ref, expected: undefined, next: first })).toBe(false);

    writeTree(repo.root, { "src/c.ts": "export const c = 1;\n" });
    git(repo.root, "add", "-A");
    git(repo.root, "commit", "-m", "second commit");
    const second = headOf(repo.root);

    // A drifted expectation never moves the ref.
    expect(
      await repo.port.compareAndSwapRef({ ref, expected: "f".repeat(40), next: second }),
    ).toBe(false);
    expect(await repo.port.readRef(ref)).toBe(first);
    // The matching expectation swaps exactly once.
    expect(await repo.port.compareAndSwapRef({ ref, expected: first, next: second })).toBe(true);
    expect(await repo.port.readRef(ref)).toBe(second);
  });
});
