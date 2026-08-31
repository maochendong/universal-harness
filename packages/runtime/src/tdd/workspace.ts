import { contentDigest } from "@universal-harness-internal/core";

import type { PatchFile } from "./patch.js";

/**
 * Isolated workspace port (provable TDD design 8.2, plan T15). Every phase
 * workspace rebuilds from the bound repository baseline; transient state
 * never crosses workspaces — the red workspace carries only the validated
 * frozen test patch, and a failed refactor is discarded by reset, never by
 * an implicit destructive git operation. The in-memory adapter is the
 * deterministic reference implementation; a git worktree adapter shares
 * the same contract. M4 (design 4.3) appends exactly one purpose,
 * `task_execution`, for non-Strict-TDD task worktrees; the five TDD phase
 * purposes are unchanged.
 */
export type { PatchFile } from "./patch.js";

export type TddWorkspacePurpose =
  | "baseline"
  | "test_authoring"
  | "red_verification"
  | "implementation"
  | "refactor"
  | "task_execution";

export interface WorkspaceHandle {
  readonly workspace_id: string;
  readonly purpose: TddWorkspacePurpose;
  readonly baseline_commit: string;
  /** Digest of the workspace file contents at creation or last reset. */
  readonly files_digest: string;
}

export interface IsolatedWorkspacePort {
  readonly name: string;
  create(input: {
    readonly baseline_commit: string;
    readonly purpose: TddWorkspacePurpose;
  }): Promise<WorkspaceHandle>;
  applyFiles(handle: WorkspaceHandle, files: readonly PatchFile[]): Promise<void>;
  /** Files added or changed relative to the baseline, sorted by path. */
  diff(handle: WorkspaceHandle): Promise<PatchFile[]>;
  /** Discard every change, returning the workspace to the baseline state. */
  reset(handle: WorkspaceHandle): Promise<void>;
  destroy(handle: WorkspaceHandle): Promise<void>;
}

interface InMemoryWorkspace {
  readonly handle: WorkspaceHandle;
  files: Map<string, string>;
}

export interface InMemoryWorkspacePort extends IsolatedWorkspacePort {
  readonly workspaces: ReadonlyMap<string, InMemoryWorkspace>;
}

export function createInMemoryWorkspacePort(
  baselineFiles: Readonly<Record<string, string>>,
  options?: { readonly baseline_commit?: string },
): IsolatedWorkspacePort {
  const baselineCommit = options?.baseline_commit ?? "in-memory-baseline";
  const baseline = new Map(Object.entries(baselineFiles));
  const baselineDigest = contentDigest(
    [...baseline.entries()].sort((left, right) => left[0].localeCompare(right[0])),
  );
  const workspaces = new Map<string, InMemoryWorkspace>();
  let counter = 0;

  const port: IsolatedWorkspacePort = {
    name: "in-memory-workspace",
    create(input) {
      counter += 1;
      const handle: WorkspaceHandle = {
        workspace_id: `workspace_${contentDigest(`${baselineCommit}:${input.purpose}:${String(counter)}`).slice(0, 16)}`,
        purpose: input.purpose,
        baseline_commit: input.baseline_commit,
        files_digest: baselineDigest,
      };
      workspaces.set(handle.workspace_id, {
        handle,
        files: new Map(baseline),
      });
      return Promise.resolve(handle);
    },
    applyFiles(handle, files) {
      const workspace = workspaces.get(handle.workspace_id);
      if (workspace === undefined) return Promise.reject(new Error("unknown workspace"));
      for (const file of files) workspace.files.set(file.path, file.content);
      return Promise.resolve();
    },
    diff(handle) {
      const workspace = workspaces.get(handle.workspace_id);
      if (workspace === undefined) return Promise.reject(new Error("unknown workspace"));
      const changed: PatchFile[] = [];
      for (const [path, content] of workspace.files) {
        if (baseline.get(path) !== content) changed.push({ path, content });
      }
      return Promise.resolve(changed.sort((left, right) => left.path.localeCompare(right.path)));
    },
    reset(handle) {
      const workspace = workspaces.get(handle.workspace_id);
      if (workspace === undefined) return Promise.reject(new Error("unknown workspace"));
      workspace.files = new Map(baseline);
      return Promise.resolve();
    },
    destroy(handle) {
      workspaces.delete(handle.workspace_id);
      return Promise.resolve();
    },
  };
  return port;
}
