import { writePathsOverlap } from "../planning/waves.js";
import type { Protocol13TaskSpecification } from "../planning/task.js";
import { normalizeExclusiveResourceKey, normalizeTaskWritePath } from "../planning/validator.js";

import type { TaskLeaseChain } from "./lease.js";

/**
 * Runtime resource lock projection (M4 design §12, plan Task 6 step 2). The
 * Plan's resource declarations stay authoritative; this table is only the
 * execution-time guard that makes overlapping write sets and exclusive
 * resources mutually exclusive across concurrently leased Tasks.
 *
 * The table is a pure in-memory projection: every operation returns a new
 * table, so a failed acquisition holds nothing by construction
 * (all-or-nothing with no partial state to roll back). Nothing here writes a
 * ResourceLockRecord — after a Coordinator restart the table is rebuilt from
 * the currently granted Leases via {@link rebuildResourceLocks} and stale
 * SQLite projections of it are invalid.
 */

export const RESOURCE_LOCK_ERROR_KINDS = [
  "resource_busy",
  "release_mismatch",
  "unknown_task",
] as const;

export type ResourceLockErrorKind = (typeof RESOURCE_LOCK_ERROR_KINDS)[number];

/** Fail-closed rejection raised by the resource lock projection. */
export class ResourceLockError extends Error {
  readonly kind: ResourceLockErrorKind;

  constructor(kind: ResourceLockErrorKind, message: string) {
    super(message);
    this.name = "ResourceLockError";
    this.kind = kind;
  }
}

/** One held lock: a deterministic key bound to task_id + fencing_token. */
export interface ResourceLockEntry {
  readonly key: string;
  readonly task_id: string;
  readonly fencing_token: number;
}

/** Immutable snapshot of every held resource lock, entries sorted by key. */
export interface ResourceLockTable {
  readonly entries: readonly ResourceLockEntry[];
}

/** The resource claims of one leased Task, exactly as granted. */
export interface TaskResourceClaim {
  readonly task_id: string;
  readonly fencing_token: number;
  readonly write_paths: readonly string[];
  readonly exclusive_resources: readonly string[];
}

export function emptyResourceLockTable(): ResourceLockTable {
  return { entries: [] };
}

/**
 * The deterministic lock keys of one claim (design §12): `write:` plus the
 * normalized repository-relative path, `exclusive:` plus the normalized
 * resource key, deduplicated and sorted. Claims are re-normalized here —
 * normalization is idempotent for the canonical values the Plan carries — so
 * a non-canonical claim fails closed before any lock is created.
 */
export function resourceKeys(claim: {
  readonly write_paths: readonly string[];
  readonly exclusive_resources: readonly string[];
}): readonly string[] {
  const keys = new Set<string>();
  for (const path of claim.write_paths) {
    keys.add(`write:${normalizeTaskWritePath(path)}`);
  }
  for (const resource of claim.exclusive_resources) {
    keys.add(`exclusive:${normalizeExclusiveResourceKey(resource)}`);
  }
  return [...keys].sort();
}

/**
 * Whether two lock keys conflict. Write keys reuse the exact
 * ancestor/descendant test of compileParallelWaves() ({@link writePathsOverlap})
 * so the runtime guard can never diverge from wave compilation; exclusive
 * keys conflict only on exact equality; a write key never conflicts with an
 * exclusive key.
 */
function keysConflict(first: string, second: string): boolean {
  const firstSeparator = first.indexOf(":");
  const secondSeparator = second.indexOf(":");
  const firstKind = first.slice(0, firstSeparator);
  const secondKind = second.slice(0, secondSeparator);
  if (firstKind !== secondKind) return false;
  const firstValue = first.slice(firstSeparator + 1);
  const secondValue = second.slice(secondSeparator + 1);
  if (firstKind === "write") return writePathsOverlap(firstValue, secondValue);
  return firstValue === secondValue;
}

function sortEntries(entries: ResourceLockEntry[]): ResourceLockEntry[] {
  return entries.sort(
    (left, right) =>
      left.key.localeCompare(right.key) ||
      left.task_id.localeCompare(right.task_id) ||
      left.fencing_token - right.fencing_token,
  );
}

/**
 * Acquire every lock of one claim at once. Keys are sorted first and every
 * conflict is checked before the new table exists, so a busy resource throws
 * `resource_busy` while the caller's table keeps exactly its previous
 * entries — no priority, no lock upgrade, no partial holding (design §12).
 */
export function acquireTaskResources(
  table: ResourceLockTable,
  claim: TaskResourceClaim,
): ResourceLockTable {
  const keys = resourceKeys(claim);
  for (const key of keys) {
    const conflict = table.entries.find((entry) => keysConflict(entry.key, key));
    if (conflict !== undefined) {
      throw new ResourceLockError(
        "resource_busy",
        `task ${claim.task_id} cannot claim ${key}: it conflicts with ${conflict.key} ` +
          `held by task ${conflict.task_id} (fencing token ${conflict.fencing_token})`,
      );
    }
  }
  return {
    entries: sortEntries([
      ...table.entries,
      ...keys.map((key) => ({
        key,
        task_id: claim.task_id,
        fencing_token: claim.fencing_token,
      })),
    ]),
  };
}

/**
 * Release every lock of one Task. The release must name the exact task_id and
 * the fencing token the locks were taken under: a stale token or an unknown
 * Task keeps every lock and throws `release_mismatch`, so output of an old
 * attempt can never free the current attempt's guard.
 */
export function releaseTaskResources(
  table: ResourceLockTable,
  release: { readonly task_id: string; readonly fencing_token: number },
): ResourceLockTable {
  const owned = table.entries.filter((entry) => entry.task_id === release.task_id);
  if (owned.length === 0) {
    throw new ResourceLockError(
      "release_mismatch",
      `task ${release.task_id} holds no resource lock; nothing can be released`,
    );
  }
  if (owned.some((entry) => entry.fencing_token !== release.fencing_token)) {
    throw new ResourceLockError(
      "release_mismatch",
      `task ${release.task_id} holds locks under fencing token ` +
        `${String(owned[0]?.fencing_token)}, not ${release.fencing_token}; a stale token ` +
        "never releases the current attempt's locks",
    );
  }
  return { entries: table.entries.filter((entry) => entry.task_id !== release.task_id) };
}

/**
 * Rebuild the lock table after a Coordinator restart (design §16): every Task
 * whose latest Lease record is still `granted` re-acquires exactly the
 * declared claims under its current fencing token, in deterministic Task
 * order. Because entries are sorted, the rebuilt table is byte-equivalent to
 * the live table the crashed Coordinator held. A granted Lease without its
 * Task specification, or granted Leases that now conflict, fail closed.
 */
export function rebuildResourceLocks(
  tasks: readonly Protocol13TaskSpecification[],
  chain: TaskLeaseChain,
): ResourceLockTable {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const granted = [...chain.latest_by_task.values()]
    .filter((record) => record.state === "granted")
    .sort(
      (left, right) =>
        left.task_id.localeCompare(right.task_id) || left.fencing_token - right.fencing_token,
    );
  let table = emptyResourceLockTable();
  for (const lease of granted) {
    const task = byId.get(lease.task_id);
    if (task === undefined) {
      throw new ResourceLockError(
        "unknown_task",
        `granted lease ${lease.lease_id} binds task ${lease.task_id}, which has no ` +
          "specification in the approved plan; the lock table cannot be rebuilt",
      );
    }
    table = acquireTaskResources(table, {
      task_id: lease.task_id,
      fencing_token: lease.fencing_token,
      write_paths: task.write_paths,
      exclusive_resources: task.exclusive_resources,
    });
  }
  return table;
}
