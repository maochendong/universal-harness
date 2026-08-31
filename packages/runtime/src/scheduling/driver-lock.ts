import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";

import { canonicalizeJson, contentDigest } from "@universal-harness-internal/core";

/**
 * Operation-scoped local Driver Lock (M4 design §4.1/§16, plan Task 6 step
 * 4). A scheduling loop may only run while it holds the Driver Lock of its
 * Operation, so CLI run/resume and Dashboard recovery can never drive the
 * same Operation concurrently. The lock is a directory created with a single
 * atomic mkdir under `.harness/locks/` — independent of both the Ledger
 * transaction lock (locks/write.lock) and the M3 Operation Lease; none of
 * them can substitute for another. No DriverLock domain record is ever
 * written; acquisition failure is `driver_lock_unavailable`.
 *
 * Crash recovery is deliberately stricter than the Ledger write lock: only a
 * same-host lock whose recorded PID is actually dead is reclaimed, a lock
 * with missing or malformed owner metadata blocks forever instead of being
 * guessed away, and directory age alone is never treated as death.
 */

export const DRIVER_LOCK_ERROR_KINDS = [
  "driver_lock_unavailable",
  "driver_lock_invalid_operation",
  "driver_lock_invalid_root",
  "driver_lock_boundary",
  "driver_lock_owner_malformed",
  "driver_lock_owner_mismatch",
] as const;

export type DriverLockErrorKind = (typeof DRIVER_LOCK_ERROR_KINDS)[number];

/** Fail-closed rejection raised by the Driver Lock. */
export class DriverLockError extends Error {
  readonly kind: DriverLockErrorKind;

  constructor(kind: DriverLockErrorKind, message: string) {
    super(message);
    this.name = "DriverLockError";
    this.kind = kind;
  }
}

export type DriverKind = "cli" | "dashboard";

export interface DriverLockHandle {
  readonly operation_id: string;
  readonly owner_token: string;
  readonly path: string;
  release(): Promise<void>;
}

export interface DriverLock {
  acquire(input: {
    readonly operation_id: string;
    readonly driver_kind: DriverKind;
  }): Promise<DriverLockHandle>;
}

const LOCKS_DIRECTORY = "locks";
const OWNER_FILE = "owner.json";

/** The exact on-disk name of one Operation's lock directory. */
export function driverLockDirectoryName(operationId: string): string {
  return `operation-${contentDigest(operationId).slice(0, 24)}.lock`;
}

interface DriverLockOwner {
  readonly operation_id: string;
  readonly pid: number;
  readonly host: string;
  readonly driver_kind: DriverKind;
  readonly acquired_at: string;
  readonly owner_token: string;
}

/**
 * Defense in depth: the directory name is a pure function of the operation
 * digest, but a hostile operation_id is still rejected before any path is
 * derived so nothing outside the lock root can ever be addressed.
 */
function assertDriverLockOperationId(operationId: string): void {
  if (
    operationId.length === 0 ||
    operationId.includes("/") ||
    operationId.includes("\\") ||
    operationId.includes("..") ||
    operationId.includes(String.fromCharCode(0)) ||
    operationId !== operationId.normalize("NFC")
  ) {
    throw new DriverLockError(
      "driver_lock_invalid_operation",
      `operation_id ${JSON.stringify(operationId)} may not name a driver lock`,
    );
  }
}

/**
 * Resolve and revalidate the exact lock root before any mutation: the harness
 * root and the locks directory must be real directories — never symlinks —
 * and every derived path is checked to stay inside the resolved root.
 */
function resolveLockRoot(harnessRoot: string): string {
  let rootStats;
  try {
    rootStats = lstatSync(harnessRoot);
  } catch {
    throw new DriverLockError(
      "driver_lock_invalid_root",
      `harness root ${harnessRoot} does not exist; the driver lock requires an adopted project`,
    );
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new DriverLockError(
      "driver_lock_invalid_root",
      `harness root ${harnessRoot} is not a real directory`,
    );
  }
  const rootReal = realpathSync(harnessRoot);
  const locksDir = join(rootReal, LOCKS_DIRECTORY);
  if (existsSync(locksDir)) {
    const locksStats = lstatSync(locksDir);
    if (locksStats.isSymbolicLink() || !locksStats.isDirectory()) {
      throw new DriverLockError(
        "driver_lock_boundary",
        `locks directory ${locksDir} is not a real directory; refusing to follow it`,
      );
    }
  } else {
    mkdirSync(locksDir, { recursive: true });
  }
  return locksDir;
}

function lockDirectoryFor(locksDir: string, operationId: string): string {
  const lockDir = resolve(locksDir, driverLockDirectoryName(operationId));
  if (!lockDir.startsWith(`${locksDir}${sep}`)) {
    throw new DriverLockError(
      "driver_lock_boundary",
      `driver lock path for operation ${operationId} escapes the lock root`,
    );
  }
  return lockDir;
}

type OwnerRead =
  | { readonly status: "pending" }
  | { readonly status: "malformed" }
  | { readonly status: "ok"; readonly owner: DriverLockOwner };

/**
 * Read the owner metadata of a held lock. A missing owner.json means another
 * driver won mkdir and is still writing — the lock is pending, not stale.
 * Present but unreadable or structurally invalid metadata is malformed and
 * blocks; it is never deleted on guesswork.
 */
function readOwner(lockDir: string): OwnerRead {
  let raw: string;
  try {
    raw = readFileSync(join(lockDir, OWNER_FILE), "utf8");
  } catch {
    return { status: "pending" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null) return { status: "malformed" };
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.operation_id !== "string" ||
    typeof record.pid !== "number" ||
    !Number.isInteger(record.pid) ||
    typeof record.host !== "string" ||
    (record.driver_kind !== "cli" && record.driver_kind !== "dashboard") ||
    typeof record.acquired_at !== "string" ||
    typeof record.owner_token !== "string"
  ) {
    return { status: "malformed" };
  }
  return {
    status: "ok",
    owner: {
      operation_id: record.operation_id,
      pid: record.pid,
      host: record.host,
      driver_kind: record.driver_kind,
      acquired_at: record.acquired_at,
      owner_token: record.owner_token,
    },
  };
}

/** Atomic owner.json write: a same-directory temporary file plus rename. */
function writeOwner(lockDir: string, owner: DriverLockOwner): void {
  const temporary = join(lockDir, `${OWNER_FILE}.${owner.owner_token}.tmp`);
  writeFileSync(temporary, `${canonicalizeJson(owner)}\n`, "utf8");
  renameSync(temporary, join(lockDir, OWNER_FILE));
}

/** Same default liveness rule as the Ledger write lock: EPERM means alive. */
function defaultIsProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

class FileSystemDriverLock implements DriverLock {
  private readonly harnessRoot: string;
  private readonly host: string;
  private readonly pid: number;
  private readonly isProcessAlive: (pid: number) => boolean;

  constructor(options: {
    readonly harness_root: string;
    readonly host: string;
    readonly pid: number;
    readonly is_process_alive?: (pid: number) => boolean;
  }) {
    this.harnessRoot = options.harness_root;
    this.host = options.host;
    this.pid = options.pid;
    this.isProcessAlive = options.is_process_alive ?? defaultIsProcessAlive;
  }

  async acquire(input: {
    readonly operation_id: string;
    readonly driver_kind: DriverKind;
  }): Promise<DriverLockHandle> {
    assertDriverLockOperationId(input.operation_id);
    const locksDir = resolveLockRoot(this.harnessRoot);
    const lockDir = lockDirectoryFor(locksDir, input.operation_id);

    // Bounded attempts: at most one reclaim plus one retry of the atomic
    // mkdir; anything else means a live driver holds the Operation.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stats = existsSync(lockDir) ? lstatSync(lockDir) : undefined;
      if (stats?.isSymbolicLink()) {
        throw new DriverLockError(
          "driver_lock_boundary",
          `driver lock path ${lockDir} is a symlink; refusing to follow it`,
        );
      }
      try {
        mkdirSync(lockDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        this.handleContention(lockDir, input.operation_id);
        continue;
      }
      const owner: DriverLockOwner = {
        operation_id: input.operation_id,
        pid: this.pid,
        host: this.host,
        driver_kind: input.driver_kind,
        acquired_at: new Date().toISOString(),
        owner_token: randomUUID(),
      };
      writeOwner(lockDir, owner);
      return this.handle(input.operation_id, lockDir, owner.owner_token);
    }
    throw new DriverLockError(
      "driver_lock_unavailable",
      `driver lock for operation ${input.operation_id} could not be acquired`,
    );
  }

  /**
   * Decide what an existing lock directory means: a pending or live lock and
   * any foreign-host lock make the acquisition fail; malformed metadata
   * blocks without deleting anything; only a same-host lock with a verifiably
   * dead PID is reclaimed, after revalidating the exact lock root.
   */
  private handleContention(lockDir: string, operationId: string): void {
    const read = readOwner(lockDir);
    if (read.status === "malformed") {
      throw new DriverLockError(
        "driver_lock_owner_malformed",
        `driver lock ${lockDir} carries malformed owner metadata; it blocks instead of ` +
          "being reclaimed by guesswork",
      );
    }
    if (read.status === "pending") {
      throw new DriverLockError(
        "driver_lock_unavailable",
        `driver lock ${lockDir} is mid-acquisition by another driver`,
      );
    }
    const { owner } = read;
    if (owner.operation_id !== operationId) {
      throw new DriverLockError(
        "driver_lock_owner_malformed",
        `driver lock ${lockDir} names operation ${owner.operation_id}, not ${operationId}`,
      );
    }
    if (owner.host === this.host && !this.isProcessAlive(owner.pid)) {
      // Dead same-host owner: revalidate the root, then reclaim and retry.
      const locksDir = resolveLockRoot(this.harnessRoot);
      if (lockDirectoryFor(locksDir, operationId) !== lockDir) {
        throw new DriverLockError(
          "driver_lock_boundary",
          `driver lock path ${lockDir} no longer resolves inside the lock root`,
        );
      }
      rmSync(lockDir, { recursive: true, force: true });
      return;
    }
    throw new DriverLockError(
      "driver_lock_unavailable",
      `operation ${operationId} is already driven by ${owner.driver_kind} pid ${owner.pid} ` +
        `on host ${owner.host} (acquired ${owner.acquired_at})`,
    );
  }

  private handle(operationId: string, lockDir: string, ownerToken: string): DriverLockHandle {
    let released = false;
    return {
      operation_id: operationId,
      owner_token: ownerToken,
      path: lockDir,
      release: async () => {
        if (released) return;
        released = true;
        if (!existsSync(lockDir)) return;
        const stats = lstatSync(lockDir);
        if (stats.isSymbolicLink()) {
          throw new DriverLockError(
            "driver_lock_boundary",
            `driver lock path ${lockDir} became a symlink; refusing to mutate it`,
          );
        }
        const read = readOwner(lockDir);
        if (read.status === "pending") return;
        if (read.status === "malformed") {
          throw new DriverLockError(
            "driver_lock_owner_malformed",
            `driver lock ${lockDir} carries malformed owner metadata; refusing to release it`,
          );
        }
        if (read.owner.owner_token !== ownerToken) {
          throw new DriverLockError(
            "driver_lock_owner_mismatch",
            `driver lock ${lockDir} is now owned by another driver; this handle must not ` +
              "release it",
          );
        }
        // Revalidate the exact root before removing anything.
        const locksDir = resolveLockRoot(this.harnessRoot);
        if (lockDirectoryFor(locksDir, operationId) !== lockDir) {
          throw new DriverLockError(
            "driver_lock_boundary",
            `driver lock path ${lockDir} no longer resolves inside the lock root`,
          );
        }
        rmSync(lockDir, { recursive: true, force: true });
      },
    };
  }
}

/**
 * Create the file-system Driver Lock rooted at the project's `.harness`
 * directory. `pid`/`host` identify this driver process; `is_process_alive`
 * decides whether a recorded owner PID is dead and defaults to the same
 * kill(pid, 0) rule as the Ledger write lock.
 */
export function createFileSystemDriverLock(options: {
  readonly harness_root: string;
  readonly host: string;
  readonly pid: number;
  readonly is_process_alive?: (pid: number) => boolean;
}): DriverLock {
  return new FileSystemDriverLock(options);
}
