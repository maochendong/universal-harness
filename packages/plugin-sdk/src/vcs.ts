/**
 * VCS adapter port contract.
 *
 * The port is intentionally transport-agnostic: adapters report outcomes as
 * typed results instead of throwing, so the workflow engine can distinguish
 * recoverable conditions (drift, dirty worktree, missing ref) from genuine
 * failures. Adapters must never mutate repository state beyond the declared
 * operation and must preserve user modifications they were not asked to
 * touch.
 */

export const VCS_ERROR_KINDS = [
  "executable_unavailable",
  "not_a_repository",
  "invalid_argument",
  "ref_not_found",
  "nothing_to_commit",
  "worktree_dirty",
  "unsafe_operation",
  "command_failed",
] as const;

export type VcsErrorKind = (typeof VCS_ERROR_KINDS)[number];

export interface VcsError {
  readonly kind: VcsErrorKind;
  /** Adapter operation that produced the error, e.g. `commit`. */
  readonly operation: string;
  readonly message: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

export type VcsResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: VcsError };

export function vcsOk<T>(value: T): VcsResult<T> {
  return { ok: true, value };
}

export function vcsErr<T = never>(error: VcsError): VcsResult<T> {
  return { ok: false, error };
}

export interface RepositoryInfo {
  /** Absolute path to the working tree root. */
  readonly root: string;
  /** Absolute path to the resolved git directory. */
  readonly gitDir: string;
  /** Current commit hash, or `null` on an unborn branch. */
  readonly head: string | null;
  /** Current branch name, or `null` when HEAD is detached. */
  readonly branch: string | null;
}

export interface WorktreeStatus {
  readonly clean: boolean;
  readonly branch: string | null;
  readonly head: string | null;
  /** Paths with staged changes (rename entries report the new path). */
  readonly staged: readonly string[];
  /** Paths with unstaged changes to tracked files. */
  readonly unstaged: readonly string[];
  /** Untracked paths (untracked directories collapse to their root). */
  readonly untracked: readonly string[];
}

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffFileSummary {
  readonly path: string;
  readonly status: DiffFileStatus;
  /** Previous path for renamed files. */
  readonly previousPath?: string;
  readonly insertions: number;
  readonly deletions: number;
}

export interface DiffSummary {
  readonly from: string;
  /** Resolved commit hash, or `worktree` when diffing against the worktree. */
  readonly to: string;
  readonly files: readonly DiffFileSummary[];
  readonly insertions: number;
  readonly deletions: number;
}

export interface DriftReport {
  readonly baseline: string;
  readonly head: string;
  /** `true` when HEAD moved away from baseline or the worktree is dirty. */
  readonly drifted: boolean;
  /** Commits reachable from HEAD but not from baseline. */
  readonly ahead: number;
  /** Commits reachable from baseline but not from HEAD. */
  readonly behind: number;
  readonly worktree: WorktreeStatus;
}

export interface InitRepositoryOptions {
  /** Initial branch name; defaults to the Git default when omitted. */
  readonly initialBranch?: string;
}

export interface CommitRequest {
  readonly message: string;
  /**
   * Repository-relative paths to stage and commit. Only these paths are
   * committed; every other staged or unstaged user change is left untouched.
   */
  readonly paths: readonly string[];
  /**
   * Explicit author/committer identity for this commit only (applied via
   * `git -c`), so tool-authored commits never depend on ambient git config.
   */
  readonly identity?: {
    readonly name: string;
    readonly email: string;
  };
}

export interface CreateBranchOptions {
  /** Commit-ish the branch starts from; defaults to HEAD. */
  readonly startPoint?: string;
  /** Switch to the new branch (default `true`). */
  readonly checkout?: boolean;
}

export interface AddWorktreeRequest {
  /** Absolute path of the new worktree; must not exist yet. */
  readonly path: string;
  /** New branch created for the worktree. */
  readonly branch: string;
  /** Commit-ish the branch starts from; defaults to HEAD. */
  readonly startPoint?: string;
}

export interface RemoveWorktreeOptions {
  /**
   * Remove even when the worktree is dirty. Without `force`, a dirty
   * worktree is rejected with a typed `worktree_dirty` error so user
   * modifications are never discarded ambiguously.
   */
  readonly force?: boolean;
}

export interface VcsAdapter {
  readonly name: string;
  /**
   * Initialize a new repository at `path` (which must already exist) without
   * touching any existing repository state elsewhere.
   */
  initRepository(path: string, options?: InitRepositoryOptions): Promise<VcsResult<RepositoryInfo>>;
  detectRepository(path: string): Promise<VcsResult<RepositoryInfo>>;
  status(root: string): Promise<VcsResult<WorktreeStatus>>;
  /** Current HEAD commit hash; the baseline an iteration binds to. */
  baselineCommit(root: string): Promise<VcsResult<string>>;
  createBranch(
    root: string,
    name: string,
    options?: CreateBranchOptions,
  ): Promise<VcsResult<RepositoryInfo>>;
  commit(root: string, request: CommitRequest): Promise<VcsResult<string>>;
  /**
   * Summarize the diff from `from` to `to`, or to the worktree (staged and
   * unstaged tracked changes, untracked files excluded) when `to` is omitted.
   */
  diffSummary(root: string, from: string, to?: string): Promise<VcsResult<DiffSummary>>;
  detectDrift(root: string, baseline: string): Promise<VcsResult<DriftReport>>;
  addWorktree(root: string, request: AddWorktreeRequest): Promise<VcsResult<RepositoryInfo>>;
  removeWorktree(
    root: string,
    path: string,
    options?: RemoveWorktreeOptions,
  ): Promise<VcsResult<void>>;
}
