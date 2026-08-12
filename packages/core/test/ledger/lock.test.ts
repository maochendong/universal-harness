import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LockUnavailable, acquireWriteLock } from "../../src/ledger/lock.js";
import { canonicalizeJson } from "../../src/identity/canonical-json.js";

import { makeProjectRoot } from "./fixtures.js";

function lockDirOf(harnessRoot: string): string {
  return join(harnessRoot, "locks", "write.lock");
}

describe("project write lock", () => {
  it("acquires and releases the lock directory", async () => {
    const harnessRoot = join(makeProjectRoot(), ".harness");
    const lock = await acquireWriteLock({ harnessRoot });
    expect(existsSync(lockDirOf(harnessRoot))).toBe(true);
    lock.release();
    expect(existsSync(lockDirOf(harnessRoot))).toBe(false);
    // Releasing twice is a no-op.
    lock.release();
  });

  it("rejects a concurrent writer with a typed LockUnavailable", async () => {
    const harnessRoot = join(makeProjectRoot(), ".harness");
    const first = await acquireWriteLock({ harnessRoot });
    await expect(
      acquireWriteLock({ harnessRoot, timeoutMs: 60, initialBackoffMs: 5, maxBackoffMs: 10 }),
    ).rejects.toBeInstanceOf(LockUnavailable);
    first.release();
    // After release the lock is available again.
    const second = await acquireWriteLock({ harnessRoot, timeoutMs: 60 });
    second.release();
  });

  it("reports the current owner when unavailable", async () => {
    const harnessRoot = join(makeProjectRoot(), ".harness");
    const first = await acquireWriteLock({ harnessRoot });
    const failure = await acquireWriteLock({
      harnessRoot,
      timeoutMs: 30,
      initialBackoffMs: 5,
      maxAttempts: 2,
      sleep: async () => {},
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LockUnavailable);
    expect((failure as LockUnavailable).owner?.pid).toBe(process.pid);
    first.release();
  });

  it("reclaims a lock whose owner process is dead", async () => {
    const harnessRoot = join(makeProjectRoot(), ".harness");
    const lockDir = lockDirOf(harnessRoot);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "owner.json"),
      `${canonicalizeJson({ pid: 424242, hostname: "dead-host", acquired_at: "2026-08-12T00:00:00.000Z" })}\n`,
    );
    const lock = await acquireWriteLock({
      harnessRoot,
      timeoutMs: 60,
      isProcessAlive: () => false,
    });
    lock.release();
  });

  it("reclaims an orphaned lock directory older than the stale threshold", async () => {
    const harnessRoot = join(makeProjectRoot(), ".harness");
    const lockDir = lockDirOf(harnessRoot);
    // Killed between mkdir and owner write: no owner.json at all.
    mkdirSync(lockDir, { recursive: true });
    const lock = await acquireWriteLock({ harnessRoot, staleAfterMs: 0, timeoutMs: 60 });
    lock.release();
  });

  it("stops after a bounded number of attempts", async () => {
    const harnessRoot = join(makeProjectRoot(), ".harness");
    const first = await acquireWriteLock({ harnessRoot });
    let sleeps = 0;
    await expect(
      acquireWriteLock({
        harnessRoot,
        maxAttempts: 3,
        timeoutMs: 60_000,
        initialBackoffMs: 1,
        sleep: async () => {
          sleeps += 1;
        },
      }),
    ).rejects.toBeInstanceOf(LockUnavailable);
    expect(sleeps).toBeLessThanOrEqual(3);
    first.release();
  });
});
