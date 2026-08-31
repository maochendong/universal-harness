import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { contentDigest } from "@universal-harness-internal/core";

import type { IsolatedWorkspacePort, PatchFile, WorkspaceHandle } from "./workspace.js";

/**
 * Git worktree adapter for the isolated workspace port (provable TDD design
 * 8.2, plan T15). Each workspace is a detached `git worktree` at the bound
 * baseline commit: creation is reproducible, `diff` is the tracked content
 * delta against that baseline, and `reset` discards changes inside the
 * worktree only — the host repository is never touched. The adapter holds
 * no write authority beyond the worktree directory it created.
 *
 * M4 (design 4.3): callers may pin `workspaceRoot` so an internal
 * composition layer (TaskWorkspaceManager) can prove every worktree sits
 * under its exact managed root; `rootOf` exposes that root for managed
 * git operations. Neither addition widens the IsolatedWorkspacePort
 * contract.
 */
const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd });
  return stdout;
}

interface GitWorkspaceState {
  readonly handle: WorkspaceHandle;
  readonly root: string;
}

/** The git adapter plus the internal root introspection the M4 manager needs. */
export interface GitWorktreeWorkspacePort extends IsolatedWorkspacePort {
  /** Absolute worktree root for a handle this port created; undefined once destroyed. */
  rootOf(handle: WorkspaceHandle): string | undefined;
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export function createGitWorktreeWorkspacePort(options: {
  readonly repositoryRoot: string;
  /** Directory under which worktrees are created; defaults to the OS temp dir. */
  readonly workspaceRoot?: string;
}): GitWorktreeWorkspacePort {
  const workspaces = new Map<string, GitWorkspaceState>();

  return {
    name: "git-worktree-workspace",
    async create(input) {
      const base = options.workspaceRoot ?? tmpdir();
      await mkdir(base, { recursive: true });
      const root = await mkdtemp(join(base, `harness-tdd-${input.purpose}-`));
      await git(options.repositoryRoot, [
        "worktree",
        "add",
        "--detach",
        root,
        input.baseline_commit,
      ]);
      const handle: WorkspaceHandle = {
        workspace_id: `workspace_${contentDigest(`${input.baseline_commit}:${input.purpose}:${root}`).slice(0, 16)}`,
        purpose: input.purpose,
        baseline_commit: input.baseline_commit,
        files_digest: contentDigest(await git(root, ["ls-files", "-z"])),
      };
      workspaces.set(handle.workspace_id, { handle, root });
      return handle;
    },
    rootOf(handle) {
      return workspaces.get(handle.workspace_id)?.root;
    },
    async applyFiles(handle, files) {
      const state = workspaces.get(handle.workspace_id);
      if (state === undefined) throw new Error("unknown workspace");
      for (const file of files) {
        await writeFile(join(state.root, file.path), file.content, "utf8");
      }
    },
    async diff(handle) {
      const state = workspaces.get(handle.workspace_id);
      if (state === undefined) throw new Error("unknown workspace");
      const nameOnly = await git(state.root, ["status", "--porcelain"]);
      const paths = nameOnly
        .split("\n")
        .map((line) => line.slice(3))
        .filter((path) => path.length > 0)
        .sort();
      const files: PatchFile[] = [];
      for (const path of paths) {
        const content = await readIfExists(join(state.root, path));
        if (content !== undefined) files.push({ path, content });
      }
      return files;
    },
    async reset(handle) {
      const state = workspaces.get(handle.workspace_id);
      if (state === undefined) throw new Error("unknown workspace");
      await git(state.root, ["reset", "--hard", "HEAD"]);
      await git(state.root, ["clean", "-fd"]);
    },
    async destroy(handle) {
      const state = workspaces.get(handle.workspace_id);
      if (state === undefined) return;
      workspaces.delete(handle.workspace_id);
      await git(options.repositoryRoot, ["worktree", "remove", "--force", state.root]).catch(
        async () => rm(state.root, { recursive: true, force: true }),
      );
    },
  };
}
