import { resolve } from "node:path";

import { vcsErr, vcsOk, type VcsResult } from "@universal-harness-internal/plugin-sdk";

import type { GitRunner } from "./commands.js";
import { readWorktreeStatus } from "./status.js";

/**
 * Add a linked worktree on a new branch. The branch name is validated with
 * `git check-ref-format` before any state changes.
 */
export async function runAddWorktree(
  run: GitRunner,
  root: string,
  path: string,
  branch: string,
  startPoint?: string,
): Promise<VcsResult<void>> {
  const check = await run("addWorktree", root, ["check-ref-format", "--branch", branch]);
  if (!check.ok) return vcsErr({ ...check.error, kind: "invalid_argument" });

  const args = ["worktree", "add", "-b", branch, path];
  if (startPoint !== undefined) args.push(startPoint);
  const added = await run("addWorktree", root, args);
  if (!added.ok) return added;
  return vcsOk(undefined);
}

/**
 * Remove a linked worktree. Dirty worktrees are rejected unless `force` is
 * set, so user modifications are never discarded ambiguously; removing the
 * main worktree itself is always refused.
 */
export async function runRemoveWorktree(
  run: GitRunner,
  root: string,
  path: string,
  force: boolean,
): Promise<VcsResult<void>> {
  if (resolve(path) === resolve(root)) {
    return vcsErr({
      kind: "unsafe_operation",
      operation: "removeWorktree",
      message: "refusing to remove the main worktree",
    });
  }
  const status = await readWorktreeStatus(run, "removeWorktree", path);
  if (!status.ok) return status;
  if (!status.value.clean && !force) {
    return vcsErr({
      kind: "worktree_dirty",
      operation: "removeWorktree",
      message: "worktree has uncommitted modifications; pass force to discard them explicitly",
    });
  }
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(path);
  const removed = await run("removeWorktree", root, args);
  if (!removed.ok) return removed;
  return vcsOk(undefined);
}
