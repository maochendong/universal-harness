import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  adapter,
  cleanupDirectories,
  git,
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
    expect(result.value.root).toBe(path);
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
