import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGitRunner } from "../src/commands.js";
import { runAddDetachedWorktree } from "../src/worktree.js";
import {
  adapter,
  cleanupDirectories,
  expectSameDirectory,
  git,
  headOf,
  makeRepo,
  makeTempDir,
  writeRepoFile,
} from "./helpers.js";

afterEach(cleanupDirectories);

describe("addWorktree", () => {
  it("creates a worktree on a new branch at HEAD", async () => {
    const root = makeRepo();
    const path = join(makeTempDir("harness-vcs-parent-"), "worktree-a");
    const result = await adapter.addWorktree(root, {
      path,
      branch: "harness/iteration_01-work",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectSameDirectory(result.value.root, path);
    expect(result.value.branch).toBe("harness/iteration_01-work");
    expect(existsSync(join(path, "README.md"))).toBe(true);
    const status = await adapter.status(path);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.clean).toBe(true);
  });

  it("rejects a relative worktree path", async () => {
    const root = makeRepo();
    const result = await adapter.addWorktree(root, {
      path: "relative/worktree",
      branch: "harness/relative",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid_argument");
  });
});

describe("runAddDetachedWorktree", () => {
  const run = createGitRunner();

  it("creates a detached worktree at the start point without a branch", async () => {
    const root = makeRepo();
    writeRepoFile(root, "second.txt", "second\n");
    git(root, "add", "second.txt");
    git(root, "commit", "-m", "second commit");
    const base = headOf(root);
    const path = join(makeTempDir("harness-vcs-parent-"), "worktree-detached");
    const branchesBefore = git(root, "branch", "--format=%(refname)").trim();

    const result = await runAddDetachedWorktree(run, root, path, base);

    expect(result).toEqual({ ok: true, value: undefined });
    expect(existsSync(join(path, "second.txt"))).toBe(true);
    expect(git(path, "rev-parse", "HEAD").trim()).toBe(base);
    // Detached HEAD: no current branch, and no branch ref was created.
    expect(git(path, "branch", "--show-current").trim()).toBe("");
    expect(git(root, "branch", "--format=%(refname)").trim()).toBe(branchesBefore);
  });

  it("rejects a start point that does not exist", async () => {
    const root = makeRepo();
    const path = join(makeTempDir("harness-vcs-parent-"), "worktree-missing");
    const result = await runAddDetachedWorktree(run, root, path, "0".repeat(40));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("command_failed");
    expect(existsSync(path)).toBe(false);
  });
});

describe("removeWorktree", () => {
  it("removes a clean worktree", async () => {
    const root = makeRepo();
    const path = join(makeTempDir("harness-vcs-parent-"), "worktree-b");
    await adapter.addWorktree(root, { path, branch: "harness/removable" });
    const result = await adapter.removeWorktree(root, path);
    expect(result).toEqual({ ok: true, value: undefined });
    expect(existsSync(path)).toBe(false);
  });

  it("refuses to remove a dirty worktree without force", async () => {
    const root = makeRepo();
    const path = join(makeTempDir("harness-vcs-parent-"), "worktree-c");
    await adapter.addWorktree(root, { path, branch: "harness/dirty" });
    writeRepoFile(path, "README.md", "user edits\n");

    const result = await adapter.removeWorktree(root, path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("worktree_dirty");
    // User modifications are preserved: the worktree is untouched.
    expect(existsSync(join(path, "README.md"))).toBe(true);
  });

  it("removes a dirty worktree only with explicit force", async () => {
    const root = makeRepo();
    const path = join(makeTempDir("harness-vcs-parent-"), "worktree-d");
    await adapter.addWorktree(root, { path, branch: "harness/forced" });
    writeRepoFile(path, "README.md", "user edits\n");

    const result = await adapter.removeWorktree(root, path, { force: true });
    expect(result).toEqual({ ok: true, value: undefined });
    expect(existsSync(path)).toBe(false);
  });

  it("refuses to remove the main worktree", async () => {
    const root = makeRepo();
    const result = await adapter.removeWorktree(root, root, { force: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unsafe_operation");
    expect(git(root, "branch", "--show-current").trim()).toBe("main");
  });
});
