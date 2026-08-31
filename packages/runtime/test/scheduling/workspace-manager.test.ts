import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Protocol13TaskSpecification } from "../../src/planning/task.js";
import { effectiveTddWriteScopes, intersectWriteScopes } from "../../src/tdd/phase-grants.js";
import type { GitWorktreeWorkspacePort } from "../../src/tdd/git-workspace.js";
import type { WorkspaceHandle } from "../../src/tdd/workspace.js";
import { createTaskWorkspaceManager } from "../../src/scheduling/workspace-manager.js";
import { cleanupDirectories, makeTempDir } from "../bootstrap/helpers.js";

/**
 * Plan Task 7 step 2/4/5 (M4 design 4.3/12/13.1): the write-scope
 * intersection is a true path-scope intersection — never string-array
 * equality — and the manager only ever destroys workspaces it registered
 * under its exact managed root; destroy/discard replays after a crash are
 * no-ops, and policy-blocked workspaces stay on disk for diagnosis.
 */
function task(id: string, writePaths: readonly string[]): Protocol13TaskSpecification {
  return {
    id,
    objective: `objective of ${id}`,
    impact_paths: [],
    expected_outputs: [`output_${id}`],
    capabilities: [],
    tools: [],
    dependencies: [],
    risk: "low",
    budget: { steps: 10, tokens: 1_000, duration_ms: 60_000 },
    write_paths: writePaths,
    exclusive_resources: [],
    acceptance: [{ description: "done", verification: "gate" }],
    required_gates: [],
  };
}

/** A filesystem-backed fake of the git adapter shape: real directories, no git. */
function fakeWorkspacePort(baseRoot: string): GitWorktreeWorkspacePort {
  const roots = new Map<string, string>();
  let counter = 0;
  return {
    name: "fake-worktree-port",
    async create(input) {
      counter += 1;
      const root = join(baseRoot, `workspace-${String(counter)}`);
      await mkdir(root, { recursive: true });
      const handle: WorkspaceHandle = {
        workspace_id: `workspace_fake_${String(counter)}`,
        purpose: input.purpose,
        baseline_commit: input.baseline_commit,
        files_digest: "f".repeat(64),
      };
      roots.set(handle.workspace_id, root);
      return handle;
    },
    rootOf(handle) {
      return roots.get(handle.workspace_id);
    },
    applyFiles() {
      return Promise.resolve();
    },
    diff() {
      return Promise.resolve([]);
    },
    reset() {
      return Promise.resolve();
    },
    async destroy(handle) {
      const root = roots.get(handle.workspace_id);
      roots.delete(handle.workspace_id);
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    },
  };
}

describe("intersectWriteScopes", () => {
  it("computes the true path-scope intersection, not string-array equality", () => {
    // Same coverage expressed differently still intersects.
    expect(
      intersectWriteScopes([
        ["src", "tests"],
        ["src/app", "tests/unit"],
      ]),
    ).toEqual(["src/app", "tests/unit"]);
    // Ancestor/descendant pairs collapse to the descendant.
    expect(intersectWriteScopes([["src/**"], ["src/app/**"]])).toEqual(["src/app"]);
    // Identical scopes survive verbatim.
    expect(intersectWriteScopes([["src"], ["src"]])).toEqual(["src"]);
  });

  it("is empty when any set is empty or the sets are disjoint", () => {
    expect(intersectWriteScopes([["src"], []])).toEqual([]);
    expect(intersectWriteScopes([["src"], ["docs"]])).toEqual([]);
  });

  it("fails closed on scopes that are not legal repository-relative paths", () => {
    expect(intersectWriteScopes([["src"], ["../escape"]])).toEqual([]);
    expect(intersectWriteScopes([["src"], ["/absolute"]])).toEqual([]);
    expect(intersectWriteScopes([["src"], [".git"]])).toEqual([]);
    expect(intersectWriteScopes([["src"], [".harness"]])).toEqual([]);
  });
});

describe("effectiveTddWriteScopes", () => {
  it("intersects task, task grant, phase policy and phase grant scopes", () => {
    expect(
      effectiveTddWriteScopes({
        task_write_paths: ["src"],
        task_grant_write_paths: ["src/app/**"],
        phase_policy_write_paths: ["src"],
        phase_grant_write_paths: ["src/app"],
      }),
    ).toEqual(["src/app"]);
  });

  it("keeps every surviving branch of a multi-scope intersection", () => {
    expect(
      effectiveTddWriteScopes({
        task_write_paths: ["src", "tests"],
        task_grant_write_paths: ["src", "tests"],
        phase_policy_write_paths: ["src/**", "tests/**"],
        phase_grant_write_paths: ["src/items", "tests/unit"],
      }),
    ).toEqual(["src/items", "tests/unit"]);
  });

  it("is empty when the phase grant leaves nothing writable", () => {
    expect(
      effectiveTddWriteScopes({
        task_write_paths: ["src"],
        task_grant_write_paths: ["src"],
        phase_policy_write_paths: ["src"],
        phase_grant_write_paths: [],
      }),
    ).toEqual([]);
  });
});

describe("task workspace registration and cleanup", () => {
  it("prepares registered task_execution workspaces under the managed root", async () => {
    const managedRoot = makeTempDir("harness-m4-managed-");
    const port = fakeWorkspacePort(join(managedRoot, "worktrees"));
    const manager = createTaskWorkspaceManager({
      repositoryRoot: managedRoot,
      managedRoot,
      workspace: port,
    });
    const base = "a".repeat(40);
    const left = await manager.prepareTaskWorkspace({
      task: task("task_left", ["src"]),
      baseline_commit: base,
      slot_id: "slot_1",
    });
    const right = await manager.prepareTaskWorkspace({
      task: task("task_right", ["src"]),
      baseline_commit: base,
      slot_id: "slot_2",
    });
    expect(left.handle.purpose).toBe("task_execution");
    expect(right.handle.purpose).toBe("task_execution");
    expect(left.handle.baseline_commit).toBe(base);
    expect(right.handle.baseline_commit).toBe(base);
    expect(left.root).not.toBe(right.root);
    expect(existsSync(left.root)).toBe(true);
    await manager.discardTaskWorkspace(left.workspace_id);
    await manager.discardTaskWorkspace(right.workspace_id);
    cleanupDirectories();
  });

  it("refuses a workspace port whose roots escape the managed root", async () => {
    const managedRoot = makeTempDir("harness-m4-managed-");
    const outside = makeTempDir("harness-m4-outside-");
    const manager = createTaskWorkspaceManager({
      repositoryRoot: managedRoot,
      managedRoot,
      workspace: fakeWorkspacePort(outside),
    });
    await expect(
      manager.prepareTaskWorkspace({
        task: task("task_01", ["src"]),
        baseline_commit: "a".repeat(40),
        slot_id: "slot_1",
      }),
    ).rejects.toMatchObject({ name: "TaskWorkspaceError", kind: "unmanaged_workspace" });
    cleanupDirectories();
  });

  it("discard is idempotent and replays cleanly after a crash", async () => {
    const managedRoot = makeTempDir("harness-m4-managed-");
    const port = fakeWorkspacePort(join(managedRoot, "worktrees"));
    const manager = createTaskWorkspaceManager({
      repositoryRoot: managedRoot,
      managedRoot,
      workspace: port,
    });
    const workspace = await manager.prepareTaskWorkspace({
      task: task("task_01", ["src"]),
      baseline_commit: "a".repeat(40),
      slot_id: "slot_1",
    });
    // Unknown ids and double-discards are replay no-ops.
    await manager.discardTaskWorkspace("workspace_never_registered");
    await manager.discardTaskWorkspace(workspace.workspace_id);
    expect(existsSync(workspace.root)).toBe(false);
    await manager.discardTaskWorkspace(workspace.workspace_id);

    // Crash replay: the directory vanished mid-cleanup, the replay still succeeds.
    const second = await manager.prepareTaskWorkspace({
      task: task("task_02", ["src"]),
      baseline_commit: "a".repeat(40),
      slot_id: "slot_1",
    });
    await rm(second.root, { recursive: true, force: true });
    await manager.discardTaskWorkspace(second.workspace_id);
    await manager.discardTaskWorkspace(second.workspace_id);
    cleanupDirectories();
  });

  it("never removes a workspace it did not register", async () => {
    const managedRoot = makeTempDir("harness-m4-managed-");
    const manager = createTaskWorkspaceManager({
      repositoryRoot: managedRoot,
      managedRoot,
      workspace: fakeWorkspacePort(join(managedRoot, "worktrees")),
    });
    const stranger = join(managedRoot, "worktrees", "not-ours");
    await mkdir(stranger, { recursive: true });
    await manager.discardTaskWorkspace("workspace_stranger");
    expect(existsSync(stranger)).toBe(true);
    cleanupDirectories();
  });
});
