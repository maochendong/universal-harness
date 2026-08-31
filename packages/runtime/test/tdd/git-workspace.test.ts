import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createGitWorktreeWorkspacePort } from "../../src/tdd/git-workspace.js";
import { cleanupDirectories, headOf, makeRepo, makeTempDir } from "../bootstrap/helpers.js";

/**
 * T15 git worktree adapter: real workspaces are reproducible git worktrees
 * at the bound baseline commit; diffs, patch application and reset behave
 * exactly like the in-memory reference adapter.
 */
describe("git worktree workspace port", { timeout: 30000 }, () => {
  it("creates, diffs, applies and resets a real worktree", async () => {
    const root = makeRepo({ "src/items.ts": "export const items = [];", "tests/README.md": "t" });
    const port = createGitWorktreeWorkspacePort({ repositoryRoot: root });
    try {
      const baseline = headOf(root);
      const authoring = await port.create({ baseline_commit: baseline, purpose: "test_authoring" });
      expect(await port.diff(authoring)).toEqual([]);

      await port.applyFiles(authoring, [{ path: "tests/items.test.ts", content: "the test" }]);
      const patch = await port.diff(authoring);
      expect(patch.map((file) => file.path)).toEqual(["tests/items.test.ts"]);

      const red = await port.create({ baseline_commit: baseline, purpose: "red_verification" });
      expect(await port.diff(red)).toEqual([]);
      await port.applyFiles(red, patch);
      expect((await port.diff(red))[0]?.content).toBe("the test");

      await port.reset(red);
      expect(await port.diff(red)).toEqual([]);
      await port.destroy(authoring);
      await port.destroy(red);
      // The host repository is never touched by workspace lifecycle.
      expect(headOf(root)).toBe(baseline);
    } finally {
      cleanupDirectories();
    }
  });

  it("places workspaces under an explicit root and exposes their roots", async () => {
    // M4 plan Task 7 step 2/5: the manager must be able to bind worktrees to
    // its exact managed root and resolve a handle to its filesystem root.
    const root = makeRepo({ "src/items.ts": "export const items = [];" });
    const workspaceRoot = makeTempDir("harness-tdd-managed-");
    const port = createGitWorktreeWorkspacePort({ repositoryRoot: root, workspaceRoot });
    try {
      const handle = await port.create({
        baseline_commit: headOf(root),
        purpose: "task_execution",
      });
      const worktreeRoot = port.rootOf(handle);
      expect(worktreeRoot).toBeDefined();
      expect(worktreeRoot?.startsWith(join(workspaceRoot, "harness-tdd-"))).toBe(true);
      expect(await port.diff(handle)).toEqual([]);
      await port.destroy(handle);
      expect(port.rootOf(handle)).toBeUndefined();
      expect(existsSync(worktreeRoot as string)).toBe(false);
    } finally {
      cleanupDirectories();
    }
  });
});
