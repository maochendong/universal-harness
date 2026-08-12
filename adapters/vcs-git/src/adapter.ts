import { isAbsolute } from "node:path";

import {
  vcsErr,
  vcsOk,
  type AddWorktreeRequest,
  type CommitRequest,
  type CreateBranchOptions,
  type DiffFileSummary,
  type DiffSummary,
  type DriftReport,
  type RemoveWorktreeOptions,
  type RepositoryInfo,
  type VcsAdapter,
  type VcsResult,
  type WorktreeStatus,
} from "@universal-harness-internal/plugin-sdk";

import { createGitRunner, narrowError, type GitRunner, type GitRunnerOptions } from "./commands.js";
import { parseNameStatusZ, parseNumstatZ, readWorktreeStatus } from "./status.js";
import { runAddWorktree, runRemoveWorktree } from "./worktree.js";

export type GitVcsAdapterOptions = GitRunnerOptions;

const BAD_REVISION = /ambiguous argument|unknown revision|bad revision|Needed a single revision/u;
const PATHSPEC_MISMATCH = /did not match any/u;

async function readRepositoryInfo(
  run: GitRunner,
  operation: string,
  path: string,
): Promise<VcsResult<RepositoryInfo>> {
  const topLevel = await run(operation, path, ["rev-parse", "--show-toplevel"]);
  if (!topLevel.ok) return topLevel;
  const gitDir = await run(operation, path, ["rev-parse", "--absolute-git-dir"]);
  if (!gitDir.ok) return gitDir;
  const branch = await run(operation, path, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const head = await run(operation, path, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  return vcsOk({
    root: topLevel.value.stdout.trim(),
    gitDir: gitDir.value.stdout.trim(),
    head: head.ok ? head.value.stdout.trim() : null,
    branch: branch.ok ? branch.value.stdout.trim() : null,
  });
}

/**
 * Git-backed VCS adapter. Git is invoked through a fixed executable and an
 * argument array via `execFile`; no user text ever reaches a shell. Every
 * operation returns a typed result and preserves user modifications it was
 * not asked to touch.
 */
export function createGitVcsAdapter(options: GitVcsAdapterOptions = {}): VcsAdapter {
  const run = createGitRunner(options);

  async function detectRepository(path: string): Promise<VcsResult<RepositoryInfo>> {
    return readRepositoryInfo(run, "detectRepository", path);
  }

  async function status(root: string): Promise<VcsResult<WorktreeStatus>> {
    return readWorktreeStatus(run, "status", root);
  }

  async function baselineCommit(root: string): Promise<VcsResult<string>> {
    const head = await run("baselineCommit", root, ["rev-parse", "HEAD"]);
    const narrowed = narrowError(head, "ref_not_found", BAD_REVISION);
    if (!narrowed.ok) return narrowed;
    return vcsOk(narrowed.value.stdout.trim());
  }

  async function createBranch(
    root: string,
    name: string,
    createOptions?: CreateBranchOptions,
  ): Promise<VcsResult<RepositoryInfo>> {
    const check = await run("createBranch", root, ["check-ref-format", "--branch", name]);
    if (!check.ok) return vcsErr({ ...check.error, kind: "invalid_argument" });

    const checkout = createOptions?.checkout ?? true;
    const args = checkout ? ["switch", "--create", name] : ["branch", name];
    if (createOptions?.startPoint !== undefined) args.push(createOptions.startPoint);
    const created = await run("createBranch", root, args);
    if (!created.ok) return created;
    return readRepositoryInfo(run, "createBranch", root);
  }

  async function commit(root: string, request: CommitRequest): Promise<VcsResult<string>> {
    if (request.paths.length === 0) {
      return vcsErr({
        kind: "invalid_argument",
        operation: "commit",
        message: "commit requires at least one declared path",
      });
    }
    if (request.message.trim().length === 0) {
      return vcsErr({
        kind: "invalid_argument",
        operation: "commit",
        message: "commit requires a non-empty message",
      });
    }
    // Stage only the declared paths; everything else stays as the user left it.
    const staged = await run("commit", root, ["add", "--", ...request.paths]);
    const stagedNarrowed = narrowError(staged, "invalid_argument", PATHSPEC_MISMATCH);
    if (!stagedNarrowed.ok) return stagedNarrowed;

    const pending = await run("commit", root, [
      "diff",
      "--cached",
      "--quiet",
      "--",
      ...request.paths,
    ]);
    if (pending.ok) {
      return vcsErr({
        kind: "nothing_to_commit",
        operation: "commit",
        message: "declared paths have no changes to commit",
      });
    }
    if (pending.error.exitCode !== 1) return pending;

    // Committing with a pathspec records the declared paths only; unrelated
    // staged and unstaged user changes are preserved.
    const committed = await run("commit", root, [
      "commit",
      "--no-verify",
      "-m",
      request.message,
      "--",
      ...request.paths,
    ]);
    if (!committed.ok) return committed;

    const head = await run("commit", root, ["rev-parse", "HEAD"]);
    if (!head.ok) return head;
    return vcsOk(head.value.stdout.trim());
  }

  async function diffSummary(
    root: string,
    from: string,
    to?: string,
  ): Promise<VcsResult<DiffSummary>> {
    const verifyFrom = await run("diffSummary", root, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${from}^{commit}`,
    ]);
    const fromChecked = narrowError(verifyFrom, "ref_not_found");
    if (!fromChecked.ok) return fromChecked;

    let resolvedTo = "worktree";
    if (to !== undefined) {
      const verifyTo = await run("diffSummary", root, [
        "rev-parse",
        "--verify",
        "--quiet",
        `${to}^{commit}`,
      ]);
      const toChecked = narrowError(verifyTo, "ref_not_found");
      if (!toChecked.ok) return toChecked;
      resolvedTo = toChecked.value.stdout.trim();
    }

    const range = to !== undefined ? [from, to] : [from];
    const nameStatus = await run("diffSummary", root, [
      "diff",
      "--name-status",
      "-z",
      "-M",
      ...range,
    ]);
    if (!nameStatus.ok) return nameStatus;
    const numstat = await run("diffSummary", root, ["diff", "--numstat", "-z", "-M", ...range]);
    if (!numstat.ok) return numstat;

    const counts = parseNumstatZ(numstat.value.stdout);
    const files: DiffFileSummary[] = parseNameStatusZ(nameStatus.value.stdout).map((entry) => {
      const lineCounts = counts.get(entry.path) ?? { insertions: 0, deletions: 0 };
      return {
        path: entry.path,
        status: entry.status,
        ...(entry.previousPath !== undefined ? { previousPath: entry.previousPath } : {}),
        insertions: lineCounts.insertions,
        deletions: lineCounts.deletions,
      };
    });
    return vcsOk({
      from,
      to: resolvedTo,
      files,
      insertions: files.reduce((total, file) => total + file.insertions, 0),
      deletions: files.reduce((total, file) => total + file.deletions, 0),
    });
  }

  async function detectDrift(root: string, baseline: string): Promise<VcsResult<DriftReport>> {
    const verify = await run("detectDrift", root, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${baseline}^{commit}`,
    ]);
    const checked = narrowError(verify, "ref_not_found");
    if (!checked.ok) return checked;

    const head = await run("detectDrift", root, ["rev-parse", "HEAD"]);
    const headChecked = narrowError(head, "ref_not_found", BAD_REVISION);
    if (!headChecked.ok) return headChecked;
    const headHash = headChecked.value.stdout.trim();

    const counts = await run("detectDrift", root, [
      "rev-list",
      "--left-right",
      "--count",
      `${baseline}...HEAD`,
    ]);
    if (!counts.ok) return counts;
    const [behindText, aheadText] = counts.value.stdout.trim().split(/\s+/u);
    const behind = Number.parseInt(behindText ?? "", 10);
    const ahead = Number.parseInt(aheadText ?? "", 10);
    if (Number.isNaN(behind) || Number.isNaN(ahead)) {
      return vcsErr({
        kind: "command_failed",
        operation: "detectDrift",
        message: `unexpected rev-list output: ${counts.value.stdout.trim()}`,
      });
    }

    const worktree = await readWorktreeStatus(run, "detectDrift", root);
    if (!worktree.ok) return worktree;
    return vcsOk({
      baseline,
      head: headHash,
      drifted: ahead > 0 || behind > 0 || !worktree.value.clean,
      ahead,
      behind,
      worktree: worktree.value,
    });
  }

  async function addWorktree(
    root: string,
    request: AddWorktreeRequest,
  ): Promise<VcsResult<RepositoryInfo>> {
    if (!isAbsolute(request.path)) {
      return vcsErr({
        kind: "invalid_argument",
        operation: "addWorktree",
        message: "worktree path must be absolute",
      });
    }
    const added = await runAddWorktree(run, root, request.path, request.branch, request.startPoint);
    if (!added.ok) return added;
    return readRepositoryInfo(run, "addWorktree", request.path);
  }

  async function removeWorktree(
    root: string,
    path: string,
    removeOptions?: RemoveWorktreeOptions,
  ): Promise<VcsResult<void>> {
    return runRemoveWorktree(run, root, path, removeOptions?.force ?? false);
  }

  return {
    name: "git",
    detectRepository,
    status,
    baselineCommit,
    createBranch,
    commit,
    diffSummary,
    detectDrift,
    addWorktree,
    removeWorktree,
  };
}
