import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { createFileSystemDriverLock } from "../../packages/runtime/src/scheduling/driver-lock.js";
import {
  acquireTaskResources,
  emptyResourceLockTable,
} from "../../packages/runtime/src/scheduling/resource-locks.js";

/**
 * Plan Task 6 step 5: path, symlink and owner-file boundaries of the M4
 * locks. The operation_id can never escape the lock root, a symlinked lock
 * path is rejected instead of followed, reserved .git/.harness write claims
 * are rejected before any resource lock is created, owner.json never leaks
 * environment values, and concurrent mkdir acquisition has exactly one
 * winner.
 */

const HOST = "m4-security-host";

function makeHarnessRoot(): string {
  const harnessRoot = join(mkdtempSync(join(tmpdir(), "harness-lock-boundary-")), ".harness");
  mkdirSync(harnessRoot, { recursive: true });
  return harnessRoot;
}

function makeLock(harnessRoot: string, pid: number) {
  return createFileSystemDriverLock({
    harness_root: harnessRoot,
    host: HOST,
    pid,
    is_process_alive: () => true,
  });
}

describe("operation_id lock-root containment", () => {
  it("rejects traversal, absolute and separator-bearing operation ids", async () => {
    const harnessRoot = makeHarnessRoot();
    const lock = makeLock(harnessRoot, 111_111);
    for (const operationId of [
      "../escape",
      "../../.git/config",
      "/absolute/path",
      "with\\backslash",
      "with..dots",
      "",
    ]) {
      await expect(
        lock.acquire({ operation_id: operationId, driver_kind: "cli" }),
      ).rejects.toMatchObject({ kind: "driver_lock_invalid_operation" });
    }
    // Nothing was created at all: the rejection precedes any lock creation.
    expect(readdirSync(realpathSync(harnessRoot))).toEqual([]);
  });

  it("keeps even hostile-looking accepted ids inside the resolved lock root", async () => {
    const harnessRoot = makeHarnessRoot();
    const lock = makeLock(harnessRoot, 111_111);
    const handle = await lock.acquire({
      operation_id: "operation_weird$%^@!=name",
      driver_kind: "cli",
    });
    const locksDir = realpathSync(join(harnessRoot, "locks"));
    expect(handle.path.startsWith(`${locksDir}${sep}`)).toBe(true);
    expect(readdirSync(locksDir)).toHaveLength(1);
    await handle.release();
  });
});

describe("symlink boundaries", () => {
  it("rejects a symlinked harness root", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "harness-lock-boundary-"));
    const real = join(projectRoot, "real-harness");
    mkdirSync(real, { recursive: true });
    const linked = join(projectRoot, ".harness");
    symlinkSync(real, linked, "dir");
    await expect(
      makeLock(linked, 111_111).acquire({ operation_id: "operation_1", driver_kind: "cli" }),
    ).rejects.toMatchObject({ kind: "driver_lock_invalid_root" });
  });

  it("rejects a symlinked locks directory", async () => {
    const harnessRoot = makeHarnessRoot();
    const elsewhere = mkdtempSync(join(tmpdir(), "harness-lock-elsewhere-"));
    symlinkSync(elsewhere, join(harnessRoot, "locks"), "dir");
    await expect(
      makeLock(harnessRoot, 111_111).acquire({ operation_id: "operation_1", driver_kind: "cli" }),
    ).rejects.toMatchObject({ kind: "driver_lock_boundary" });
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("rejects a symlinked per-operation lock directory", async () => {
    const harnessRoot = makeHarnessRoot();
    // Win the name by acquiring once, then replace the released path with a
    // symlink and prove a later acquisition refuses to follow it.
    const first = makeLock(harnessRoot, 111_111);
    const handle = await first.acquire({ operation_id: "operation_1", driver_kind: "cli" });
    const lockPath = handle.path;
    await handle.release();
    const elsewhere = mkdtempSync(join(tmpdir(), "harness-lock-elsewhere-"));
    symlinkSync(elsewhere, lockPath, "dir");
    await expect(
      makeLock(harnessRoot, 222_222).acquire({ operation_id: "operation_1", driver_kind: "cli" }),
    ).rejects.toMatchObject({ kind: "driver_lock_boundary" });
    expect(existsSync(join(elsewhere, "owner.json"))).toBe(false);
  });
});

describe("reserved write claims", () => {
  it("rejects .git/.harness/absolute/traversal claims before any lock exists", () => {
    for (const writePaths of [
      [".git/config"],
      ["modules/.git/hooks"],
      [".harness/locks"],
      [".harness"],
      ["/etc/passwd"],
      ["../outside"],
    ]) {
      const table = emptyResourceLockTable();
      expect(() =>
        acquireTaskResources(table, {
          task_id: "task_evil",
          fencing_token: 1,
          write_paths: writePaths,
          exclusive_resources: [],
        }),
      ).toThrowError(expect.objectContaining({ name: "PlanningError" }));
      // All-or-nothing: no lock was created for the rejected claim.
      expect(table.entries).toEqual([]);
    }
  });
});

describe("owner metadata hygiene", () => {
  it("writes exactly the declared fields and never an environment value", async () => {
    const probe = "m4-owner-json-env-probe-9f27e1";
    process.env.M4_DRIVER_LOCK_PROBE = probe;
    try {
      const harnessRoot = makeHarnessRoot();
      const handle = await makeLock(harnessRoot, 111_111).acquire({
        operation_id: "operation_1",
        driver_kind: "cli",
      });
      const raw = readFileSync(join(handle.path, "owner.json"), "utf8");
      expect(raw).not.toContain(probe);
      expect(Object.keys(JSON.parse(raw) as Record<string, unknown>).sort()).toEqual(
        ["acquired_at", "driver_kind", "host", "operation_id", "owner_token", "pid"].sort(),
      );
      await handle.release();
    } finally {
      delete process.env.M4_DRIVER_LOCK_PROBE;
    }
  });
});

describe("concurrent acquisition", () => {
  it("gives concurrent mkdir contenders exactly one winner", async () => {
    const harnessRoot = makeHarnessRoot();
    const contenders = [111_111, 222_222, 333_333, 444_444].map((pid) =>
      makeLock(harnessRoot, pid),
    );
    const outcomes = await Promise.allSettled(
      contenders.map((lock) => lock.acquire({ operation_id: "operation_1", driver_kind: "cli" })),
    );
    const winners = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const losers = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(3);
    for (const loser of losers) {
      expect((loser as PromiseRejectedResult).reason).toMatchObject({
        kind: "driver_lock_unavailable",
      });
    }
    const locksDir = realpathSync(join(harnessRoot, "locks"));
    expect(readdirSync(locksDir)).toHaveLength(1);
    await (winners[0] as PromiseFulfilledResult<{ release(): Promise<void> }>).value.release();
  });
});
