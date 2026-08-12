import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

import { canonicalizeJson } from "../identity/canonical-json.js";
import { WRITE_LOCK_RELATIVE_PATH, resolveHarnessPath } from "./layout.js";

/**
 * Project-level write lock. The lock is an atomically created directory so
 * acquisition is a single kernel operation on every supported platform;
 * concurrent readers never touch it. Owners record their pid so a lock left
 * behind by a killed process is detected and reclaimed instead of blocking
 * forever.
 */
export class LockUnavailable extends Error {
  readonly kind = "lock_unavailable" as const;
  readonly owner: LockOwner | undefined;

  constructor(message: string, owner?: LockOwner) {
    super(message);
    this.name = "LockUnavailable";
    this.owner = owner;
  }
}

export interface LockOwner {
  readonly pid: number;
  readonly hostname: string;
  readonly acquired_at: string;
}

export interface WriteLock {
  readonly lockPath: string;
  release(): void;
}

export interface AcquireWriteLockOptions {
  readonly harnessRoot: string;
  readonly timeoutMs?: number;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly staleAfterMs?: number;
  readonly maxAttempts?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly isProcessAlive?: (pid: number) => boolean;
}

const OWNER_FILE = "owner.json";

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function defaultIsProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readOwner(lockDir: string): LockOwner | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(lockDir, OWNER_FILE), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.pid !== "number") return undefined;
    return {
      pid: record.pid,
      hostname: typeof record.hostname === "string" ? record.hostname : "unknown",
      acquired_at: typeof record.acquired_at === "string" ? record.acquired_at : "unknown",
    };
  } catch {
    return undefined;
  }
}

function tryReclaimStaleLock(
  lockDir: string,
  isProcessAlive: (pid: number) => boolean,
  now: () => number,
  staleAfterMs: number,
): boolean {
  const owner = readOwner(lockDir);
  if (owner !== undefined) {
    // A dead owner can never release its handle; reclaim the directory.
    if (!isProcessAlive(owner.pid)) {
      rmSync(lockDir, { recursive: true, force: true });
      return true;
    }
    return false;
  }
  // The owner record was never written (killed between mkdir and write) or is
  // unreadable; fall back to lock directory age.
  try {
    if (now() - statSync(lockDir).mtimeMs >= staleAfterMs) {
      rmSync(lockDir, { recursive: true, force: true });
      return true;
    }
  } catch {
    // The directory vanished concurrently; let the next mkdir attempt decide.
    return true;
  }
  return false;
}

export async function acquireWriteLock(options: AcquireWriteLockOptions): Promise<WriteLock> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const staleAfterMs = options.staleAfterMs ?? 30_000;
  const maxAttempts = options.maxAttempts ?? 100;
  let backoffMs = options.initialBackoffMs ?? 25;
  const maxBackoffMs = options.maxBackoffMs ?? 250;

  const lockDir = resolveHarnessPath(options.harnessRoot, WRITE_LOCK_RELATIVE_PATH);
  mkdirSync(dirname(lockDir), { recursive: true });

  const startedAt = now();
  let attempts = 0;
  for (;;) {
    try {
      mkdirSync(lockDir);
      const owner: LockOwner = {
        pid: process.pid,
        hostname: hostname(),
        acquired_at: new Date(now()).toISOString(),
      };
      writeFileSync(join(lockDir, OWNER_FILE), `${canonicalizeJson(owner)}\n`, "utf8");
      let released = false;
      return {
        lockPath: lockDir,
        release() {
          if (released) return;
          released = true;
          rmSync(join(lockDir, OWNER_FILE), { force: true });
          rmSync(lockDir, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      attempts += 1;
      if (tryReclaimStaleLock(lockDir, isProcessAlive, now, staleAfterMs)) continue;
      if (attempts >= maxAttempts || now() - startedAt >= timeoutMs) {
        throw new LockUnavailable(
          `project write lock is held and did not become available: ${lockDir}`,
          readOwner(lockDir),
        );
      }
      // Bounded exponential backoff; contention on Windows sharing violations
      // resolves within a few retries, persistent holders surface as typed
      // LockUnavailable rather than an unbounded spin.
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    }
  }
}
