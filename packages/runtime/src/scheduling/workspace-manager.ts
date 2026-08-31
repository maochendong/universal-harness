import { execFile } from "node:child_process";
import { lstat, mkdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { contentDigest, type TddPathPolicy } from "@universal-harness-internal/core";

import type { Protocol13TaskSpecification } from "../planning/task.js";
import type { CapabilityGrant } from "../policy/capability-grant.js";
import { isPathWithinScopes, tryNormalizeRepoRelativePath } from "../policy/path-boundary.js";
import type { StrictTddTaskOutcome } from "../tdd/execution-runner.js";
import type { GitWorktreeWorkspacePort } from "../tdd/git-workspace.js";
import { effectiveTddWriteScopes, intersectWriteScopes } from "../tdd/phase-grants.js";
import type { WorkspaceHandle } from "../tdd/workspace.js";

/**
 * TaskWorkspaceManager (M4 design 4.3/12/13.1, plan Task 7 step 2/4/5): the
 * runtime-internal composition layer over the existing IsolatedWorkspacePort
 * — it is not a plugin SDK port and adds no second public workspace port.
 *
 * Non-Strict-TDD tasks run in a single detached `task_execution` worktree
 * created from the wave's frozen base commit; the manager never trusts agent
 * commit metadata — the candidate patch is re-derived from the worktree
 * contents with exact git argument arrays: a temporary index
 * (`read-tree`/`add -A`/`write-tree`) captures deletions, binary content,
 * mode changes and untracked files, `git diff --binary --cached` produces
 * the managed patch artifact and `git ls-tree` the source tree digest.
 *
 * Strict TDD tasks get no outer task_execution worktree at all: the accepted
 * `implementation_revision` is the only patch source, re-validated against
 * Git, the accepted TDD Cycle and its Red/Green Evidence, and every observed
 * final path is attested against the four-way write-scope intersection
 * (empty intersection blocks before the revision is even resolved).
 *
 * Cleanup is idempotent: discard/destroy replays after a crash are no-ops,
 * only manager-registered workspaces under the exact managed root are ever
 * removed, and a workspace whose collection failed a policy check is kept
 * on disk as diagnostic evidence.
 */
export const TASK_WORKSPACE_ERROR_KINDS = [
  "empty_write_scope",
  "missing_evidence",
  "revision_mismatch",
  "grant_drift",
  "write_set_violation",
  "path_escape",
  "unknown_workspace",
  "unmanaged_workspace",
] as const;

export type TaskWorkspaceErrorKind = (typeof TASK_WORKSPACE_ERROR_KINDS)[number];

/** Fail-closed rejection raised by the task workspace manager. */
export class TaskWorkspaceError extends Error {
  readonly kind: TaskWorkspaceErrorKind;

  constructor(kind: TaskWorkspaceErrorKind, message: string) {
    super(message);
    this.name = "TaskWorkspaceError";
    this.kind = kind;
  }
}

export interface TaskCandidatePatch {
  readonly task_id: string;
  readonly baseline_commit: string;
  readonly changed_paths: readonly string[];
  readonly patch_locator: string;
  readonly patch_digest: string;
  readonly source_tree_digest: string;
  readonly source_revision?: string;
}

export interface TaskExecutionWorkspace {
  readonly workspace_id: string;
  readonly root: string;
  readonly handle: WorkspaceHandle;
}

export interface TaskWorkspaceInput {
  readonly task: Protocol13TaskSpecification;
  readonly baseline_commit: string;
  readonly slot_id: string;
}

export interface CollectTaskCandidateInput {
  readonly task: Protocol13TaskSpecification;
  readonly workspace: TaskExecutionWorkspace;
  readonly task_grant: CapabilityGrant;
}

export interface CollectStrictTddCandidateInput {
  readonly task: Protocol13TaskSpecification;
  readonly outcome: StrictTddTaskOutcome;
  readonly task_grant: CapabilityGrant;
  readonly phase_grant: CapabilityGrant;
  readonly path_policy: TddPathPolicy;
}

export interface TaskWorkspaceManager {
  prepareTaskWorkspace(input: TaskWorkspaceInput): Promise<TaskExecutionWorkspace>;
  collectTaskCandidate(input: CollectTaskCandidateInput): Promise<TaskCandidatePatch>;
  collectStrictTddCandidate(input: CollectStrictTddCandidateInput): Promise<TaskCandidatePatch>;
  discardTaskWorkspace(workspaceId: string): Promise<void>;
}

export interface TaskWorkspaceManagerOptions {
  readonly repositoryRoot: string;
  /** Exact managed root; only workspaces registered below it are ever removed. */
  readonly managedRoot: string;
  /**
   * The git worktree adapter (IsolatedWorkspacePort) plus the internal root
   * introspection required to run managed git commands. Its workspaceRoot
   * must sit under `managedRoot`; preparation fails closed otherwise.
   */
  readonly workspace: GitWorktreeWorkspacePort;
}

const execFileAsync = promisify(execFile);

async function git(
  cwd: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    env: env === undefined ? undefined : { ...process.env, ...env },
  });
  return stdout;
}

/** Whether a git command exits 0 (used for rev-parse / merge-base checks). */
async function gitSucceeds(cwd: string, args: readonly string[]): Promise<boolean> {
  try {
    await execFileAsync("git", [...args], { cwd });
    return true;
  } catch {
    return false;
  }
}

/** Paths that may never appear in a candidate patch. */
function assertCandidatePath(path: string): string {
  const normalized = tryNormalizeRepoRelativePath(path);
  if (normalized === undefined) {
    throw new TaskWorkspaceError(
      "path_escape",
      `candidate path ${JSON.stringify(path)} is not a legal repository-relative path`,
    );
  }
  const first = normalized.split("/")[0] as string;
  if (first === ".git" || first === ".harness") {
    throw new TaskWorkspaceError(
      "path_escape",
      `candidate path ${normalized} names the ${first} authoritative store`,
    );
  }
  return normalized;
}

/** A symlink target must resolve to a legal in-repository path. */
function assertSymlinkTargetWithinRepository(path: string, target: string): void {
  if (target.startsWith("/") || /^[A-Za-z]:/u.test(target)) {
    throw new TaskWorkspaceError(
      "path_escape",
      `symlink at ${path} points outside the repository: ${target}`,
    );
  }
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  assertCandidatePath(resolved);
}

interface RawDiffEntry {
  readonly path: string;
  readonly newMode: string;
  readonly status: string;
}

/** Parse `git diff --raw -z` output (no rename detection: meta/path pairs). */
function parseRawDiff(raw: string): RawDiffEntry[] {
  const tokens = raw.split("\0").filter((token) => token.length > 0);
  const entries: RawDiffEntry[] = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const meta = tokens[index] as string;
    const match = /^:\d{6} (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])$/u.exec(meta);
    if (match === null || index + 1 >= tokens.length) {
      throw new TaskWorkspaceError(
        "revision_mismatch",
        `cannot parse git diff --raw entry: ${JSON.stringify(meta)}`,
      );
    }
    entries.push({
      path: tokens[index + 1] as string,
      newMode: match[1] as string,
      status: match[2] as string,
    });
  }
  return entries;
}

interface RegistryEntry {
  readonly workspace_id: string;
  readonly task_id: string;
  readonly slot_id: string;
  readonly baseline_commit: string;
  readonly root: string;
  readonly handle: WorkspaceHandle;
  status: "active" | "blocked";
}

export function createTaskWorkspaceManager(
  options: TaskWorkspaceManagerOptions,
): TaskWorkspaceManager {
  const registry = new Map<string, RegistryEntry>();
  const artifactsRoot = join(options.managedRoot, "artifacts");
  let managedRootReal: string | undefined;

  const managedRootRealPath = async (): Promise<string> => {
    if (managedRootReal === undefined) {
      await mkdir(options.managedRoot, { recursive: true });
      managedRootReal = await realpath(options.managedRoot);
    }
    return managedRootReal;
  };

  /** Containment proof; tolerates an already-removed root (crash replay). */
  const assertUnderManagedRoot = async (root: string): Promise<string> => {
    const base = await managedRootRealPath();
    let real: string;
    try {
      real = await realpath(root);
    } catch {
      return resolve(root);
    }
    if (real !== base && !real.startsWith(`${base}${sep}`)) {
      throw new TaskWorkspaceError(
        "unmanaged_workspace",
        `workspace root ${real} is outside the managed root ${base}`,
      );
    }
    return real;
  };

  /** Policy violations retain the workspace for diagnosis (design 15). */
  const block = (entry: RegistryEntry | undefined, error: TaskWorkspaceError): never => {
    if (
      entry !== undefined &&
      (error.kind === "write_set_violation" ||
        error.kind === "path_escape" ||
        error.kind === "empty_write_scope" ||
        error.kind === "grant_drift")
    ) {
      entry.status = "blocked";
    }
    throw error;
  };

  /**
   * Validate every path a candidate patch would touch: legal
   * repository-relative form, never `.git`/`.harness`, never an embedded
   * gitlink, never a symlink escaping the repository, and always inside the
   * effective write scopes.
   */
  const attestCandidateEntries = async (
    entries: readonly RawDiffEntry[],
    scopes: readonly string[],
    symlinkTarget: (entry: RawDiffEntry) => Promise<string | undefined>,
  ): Promise<readonly string[]> => {
    const changed: string[] = [];
    for (const entry of entries) {
      const path = assertCandidatePath(entry.path);
      if (entry.newMode === "160000") {
        throw new TaskWorkspaceError(
          "path_escape",
          `candidate embeds a git repository at ${path} (gitlink entries are never accepted)`,
        );
      }
      if (entry.newMode === "120000" && entry.status !== "D") {
        const target = await symlinkTarget(entry);
        if (target !== undefined) assertSymlinkTargetWithinRepository(path, target);
      }
      changed.push(path);
    }
    const unique = [...new Set(changed)].sort();
    const violations = unique.filter((path) => !isPathWithinScopes([...scopes], path));
    if (violations.length > 0) {
      throw new TaskWorkspaceError(
        "write_set_violation",
        `candidate writes outside the effective write scope: ${violations.join(", ")}`,
      );
    }
    return unique;
  };

  const persistCandidate = async (input: {
    readonly task_id: string;
    readonly baseline_commit: string;
    readonly changed_paths: readonly string[];
    readonly patch: string;
    readonly tree: string;
    readonly source_revision?: string;
  }): Promise<TaskCandidatePatch> => {
    await mkdir(artifactsRoot, { recursive: true });
    const listing = await git(options.repositoryRoot, ["ls-tree", "-r", input.tree]);
    const patchDigest = contentDigest(input.patch);
    const locator = join(artifactsRoot, `${input.task_id}.${patchDigest.slice(0, 16)}.patch`);
    await writeFile(locator, input.patch, "utf8");
    return {
      task_id: input.task_id,
      baseline_commit: input.baseline_commit,
      changed_paths: input.changed_paths,
      patch_locator: locator,
      patch_digest: patchDigest,
      source_tree_digest: contentDigest(listing),
      ...(input.source_revision === undefined ? {} : { source_revision: input.source_revision }),
    };
  };

  return {
    async prepareTaskWorkspace(input) {
      const handle = await options.workspace.create({
        baseline_commit: input.baseline_commit,
        purpose: "task_execution",
      });
      const root = options.workspace.rootOf(handle);
      if (root === undefined) {
        throw new TaskWorkspaceError(
          "unmanaged_workspace",
          "the workspace port did not expose a filesystem root for the new workspace",
        );
      }
      const real = await assertUnderManagedRoot(root);
      const entry: RegistryEntry = {
        workspace_id: handle.workspace_id,
        task_id: input.task.id,
        slot_id: input.slot_id,
        baseline_commit: input.baseline_commit,
        root: real,
        handle,
        status: "active",
      };
      registry.set(entry.workspace_id, entry);
      return { workspace_id: entry.workspace_id, root: entry.root, handle };
    },

    async collectTaskCandidate(input) {
      const entry = registry.get(input.workspace.workspace_id);
      if (entry === undefined || entry.task_id !== input.task.id) {
        throw new TaskWorkspaceError(
          "unknown_workspace",
          `workspace ${input.workspace.workspace_id} is not registered for task ${input.task.id}`,
        );
      }
      if (input.task_grant.task_id !== input.task.id) {
        block(
          entry,
          new TaskWorkspaceError(
            "grant_drift",
            `grant ${input.task_grant.grant_id} does not bind task ${input.task.id}`,
          ),
        );
      }
      const scopes = intersectWriteScopes([input.task.write_paths, input.task_grant.write_paths]);
      if (scopes.length === 0) {
        block(
          entry,
          new TaskWorkspaceError(
            "empty_write_scope",
            `task ${input.task.id} has no writable path left after grant intersection`,
          ),
        );
      }
      await mkdir(artifactsRoot, { recursive: true });
      const indexFile = join(artifactsRoot, `${entry.workspace_id}.index`);
      const env = { GIT_INDEX_FILE: indexFile };
      try {
        // A scratch index stages the full worktree state (tracked, untracked,
        // deletions, mode changes) without ever moving the worktree's HEAD or
        // the host repository.
        await git(entry.root, ["read-tree", entry.baseline_commit], env);
        await git(entry.root, ["add", "-A"], env);
        const tree = (await git(entry.root, ["write-tree"], env)).trim();
        const raw = await git(
          entry.root,
          ["diff", "--cached", "--raw", "-z", entry.baseline_commit],
          env,
        );
        const rootReal = await realpath(entry.root);
        let changedPaths: readonly string[];
        try {
          changedPaths = await attestCandidateEntries(parseRawDiff(raw), scopes, async (item) => {
            const absolute = join(entry.root, item.path);
            const stat = await lstat(absolute).catch(() => undefined);
            if (stat === undefined || !stat.isSymbolicLink()) return undefined;
            const target = await readlink(absolute);
            const resolved = resolve(dirname(absolute), target);
            if (resolved !== rootReal && !resolved.startsWith(`${rootReal}${sep}`)) {
              throw new TaskWorkspaceError(
                "path_escape",
                `symlink at ${item.path} escapes the task workspace (resolves to ${resolved})`,
              );
            }
            return target;
          });
        } catch (error) {
          if (error instanceof TaskWorkspaceError) block(entry, error);
          throw error;
        }
        const patch = await git(
          entry.root,
          ["diff", "--cached", "--binary", entry.baseline_commit],
          env,
        );
        return await persistCandidate({
          task_id: input.task.id,
          baseline_commit: entry.baseline_commit,
          changed_paths: changedPaths,
          patch,
          tree,
        });
      } finally {
        await rm(indexFile, { force: true });
      }
    },

    async collectStrictTddCandidate(input) {
      const { task, outcome, task_grant, phase_grant, path_policy } = input;
      // The four-way intersection is computed before any revision is
      // resolved; an empty intersection blocks before execution (design 12).
      const scopes = effectiveTddWriteScopes({
        task_write_paths: task.write_paths,
        task_grant_write_paths: task_grant.write_paths,
        // The final revision legitimately carries the accepted frozen test
        // patch plus the production implementation, so the phase policy
        // scopes for the final candidate are the contract's full writable
        // set (immutable paths never enter a scope).
        phase_policy_write_paths: [
          ...path_policy.test,
          ...path_policy.test_config,
          ...path_policy.production,
        ],
        phase_grant_write_paths: phase_grant.write_paths,
      });
      if (scopes.length === 0) {
        throw new TaskWorkspaceError(
          "empty_write_scope",
          `task ${task.id} has no writable path in the four-way write-scope intersection`,
        );
      }
      if (task_grant.task_id !== task.id || phase_grant.task_id !== task.id) {
        throw new TaskWorkspaceError("grant_drift", `a grant does not bind task ${task.id}`);
      }
      if (outcome.status !== "completed" || outcome.task_id !== task.id) {
        throw new TaskWorkspaceError(
          "missing_evidence",
          `task ${task.id} has no completed Strict TDD outcome`,
        );
      }
      const cycle = outcome.cycle;
      if (
        cycle.status !== "completed" ||
        cycle.task_id !== task.id ||
        cycle.red_evidence_digest === undefined ||
        cycle.green_evidence_digest === undefined ||
        cycle.implementation_revision === undefined
      ) {
        throw new TaskWorkspaceError(
          "missing_evidence",
          `TDD cycle ${cycle.logical_cycle_id} is not a completed cycle bound to task ${task.id}`,
        );
      }
      const revision = outcome.implementation_revision;
      if (revision !== cycle.implementation_revision) {
        throw new TaskWorkspaceError(
          "revision_mismatch",
          `outcome revision ${revision} differs from the accepted TDD cycle revision ${cycle.implementation_revision}`,
        );
      }
      // Accepted Red/Green Evidence must be present, digest-bound to the
      // exact cycle attempt, baseline and contract.
      const acceptedEvidence = (type: "red_test_result" | "green_test_result", digest: string) =>
        outcome.evidence.some(
          (binding) =>
            binding.evidence_type === type &&
            binding.task_id === task.id &&
            binding.logical_cycle_id === cycle.logical_cycle_id &&
            binding.attempt_ordinal === cycle.attempt_ordinal &&
            binding.contract_digest === cycle.contract_digest &&
            binding.repository_baseline === cycle.repository_baseline &&
            contentDigest(binding) === digest,
        );
      if (
        !acceptedEvidence("red_test_result", cycle.red_evidence_digest) ||
        !acceptedEvidence("green_test_result", cycle.green_evidence_digest)
      ) {
        throw new TaskWorkspaceError(
          "missing_evidence",
          `cycle ${cycle.logical_cycle_id} lacks accepted Red/Green evidence bindings`,
        );
      }
      // The revision must exist in Git and descend from the cycle baseline —
      // never from agent-reported metadata alone.
      const exists = await gitSucceeds(options.repositoryRoot, [
        "rev-parse",
        "--verify",
        "--quiet",
        `${revision}^{commit}`,
      ]);
      if (!exists) {
        throw new TaskWorkspaceError(
          "revision_mismatch",
          `implementation revision ${revision} does not resolve to a commit in the repository`,
        );
      }
      const onBaseline = await gitSucceeds(options.repositoryRoot, [
        "merge-base",
        "--is-ancestor",
        cycle.repository_baseline,
        revision,
      ]);
      if (!onBaseline) {
        throw new TaskWorkspaceError(
          "revision_mismatch",
          `implementation revision ${revision} is not built on the cycle baseline ${cycle.repository_baseline}`,
        );
      }
      const raw = await git(options.repositoryRoot, [
        "diff",
        "--raw",
        "-z",
        cycle.repository_baseline,
        revision,
      ]);
      const changedPaths = await attestCandidateEntries(parseRawDiff(raw), scopes, async (item) => {
        const target = await git(options.repositoryRoot, [
          "cat-file",
          "-p",
          `${revision}:${item.path}`,
        ]).catch(() => undefined);
        return target;
      });
      const patch = await git(options.repositoryRoot, [
        "diff",
        "--binary",
        cycle.repository_baseline,
        revision,
      ]);
      return persistCandidate({
        task_id: task.id,
        baseline_commit: cycle.repository_baseline,
        changed_paths: changedPaths,
        patch,
        tree: revision,
        source_revision: revision,
      });
    },

    async discardTaskWorkspace(workspaceId) {
      const entry = registry.get(workspaceId);
      // Replay after a crash: unknown ids are no-ops.
      if (entry === undefined) return;
      // Policy-blocked workspaces are retained as diagnostic evidence.
      if (entry.status === "blocked") return;
      // Only ever remove a registered workspace under the exact managed root.
      await assertUnderManagedRoot(entry.root);
      await options.workspace.destroy(entry.handle);
      registry.delete(workspaceId);
    },
  };
}
