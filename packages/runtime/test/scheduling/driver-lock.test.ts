import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { contentDigest } from "@universal-harness-internal/core";
import { describe, expect, it } from "vitest";

import {
  createFileSystemDriverLock,
  driverLockDirectoryName,
  type DriverLock,
} from "../../src/scheduling/driver-lock.js";

/**
 * Plan Task 6 step 3/4: the operation-scoped local Driver Lock (design §4.1).
 * One Operation has exactly one Driver; the lock is an atomically created
 * directory under `.harness/locks/` named from contentDigest(operation_id),
 * independent of both the Ledger transaction lock and the M3 Operation Lease.
 */

const HOST = "driver-lock-test-host";

function makeHarnessRoot(): string {
  const harnessRoot = join(mkdtempSync(join(tmpdir(), "harness-driver-lock-")), ".harness");
  mkdirSync(harnessRoot, { recursive: true });
  return harnessRoot;
}

function makeLock(
  harnessRoot: string,
  overrides?: { readonly pid?: number; readonly is_process_alive?: (pid: number) => boolean },
): DriverLock {
  return createFileSystemDriverLock({
    harness_root: harnessRoot,
    host: HOST,
    pid: overrides?.pid ?? 111_111,
    is_process_alive: overrides?.is_process_alive ?? (() => true),
  });
}

describe("driverLockDirectoryName", () => {
  it("is operation- plus the first 24 hex characters of contentDigest(operation_id)", () => {
    expect(driverLockDirectoryName("operation_1")).toBe(
      `operation-${contentDigest("operation_1").slice(0, 24)}.lock`,
    );
    expect(driverLockDirectoryName("operation_1")).toMatch(/^operation-[0-9a-f]{24}\.lock$/u);
  });
});

describe("createFileSystemDriverLock", () => {
  it("acquires the atomic directory and writes the owner metadata", async () => {
    const harnessRoot = makeHarnessRoot();
    const lock = makeLock(harnessRoot);
    const handle = await lock.acquire({ operation_id: "operation_1", driver_kind: "cli" });

    expect(handle.operation_id).toBe("operation_1");
    expect(handle.path).toBe(
      join(realpathSync(harnessRoot), "locks", driverLockDirectoryName("operation_1")),
    );
    const owner = JSON.parse(readFileSync(join(handle.path, "owner.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(owner).sort()).toEqual(
      ["acquired_at", "driver_kind", "host", "operation_id", "owner_token", "pid"].sort(),
    );
    expect(owner).toMatchObject({
      operation_id: "operation_1",
      pid: 111_111,
      host: HOST,
      driver_kind: "cli",
      owner_token: handle.owner_token,
    });
    expect(typeof owner.acquired_at).toBe("string");
    await handle.release();
  });

  it("drives one winner between CLI and Dashboard per operation, others are free", async () => {
    const harnessRoot = makeHarnessRoot();
    const lock = makeLock(harnessRoot);
    const cli = await lock.acquire({ operation_id: "operation_1", driver_kind: "cli" });
    await expect(
      lock.acquire({ operation_id: "operation_1", driver_kind: "dashboard" }),
    ).rejects.toMatchObject({ kind: "driver_lock_unavailable" });
    await expect(
      lock.acquire({ operation_id: "operation_2", driver_kind: "dashboard" }),
    ).resolves.toBeDefined();
    await cli.release();
  });

  it("mints a fresh random owner_token per acquisition", async () => {
    const harnessRoot = makeHarnessRoot();
    const lock = makeLock(harnessRoot);
    const first = await lock.acquire({ operation_id: "operation_1", driver_kind: "cli" });
    await first.release();
    const second = await lock.acquire({ operation_id: "operation_1", driver_kind: "cli" });
    expect(second.owner_token).not.toBe(first.owner_token);
    await second.release();
  });

  it("release frees the directory so another driver can acquire", async () => {
    const harnessRoot = makeHarnessRoot();
    const lock = makeLock(harnessRoot);
    const first = await lock.acquire({ operation_id: "operation_1", driver_kind: "cli" });
    await first.release();
    const second = await lock.acquire({ operation_id: "operation_1", driver_kind: "dashboard" });
    expect(second.path).toBe(first.path);
    await second.release();
  });

  it("release is idempotent", async () => {
    const harnessRoot = makeHarnessRoot();
    const lock = makeLock(harnessRoot);
    const handle = await lock.acquire({ operation_id: "operation_1", driver_kind: "cli" });
    await handle.release();
    await expect(handle.release()).resolves.toBeUndefined();
  });
});
