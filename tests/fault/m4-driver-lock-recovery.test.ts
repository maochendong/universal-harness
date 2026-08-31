import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalizeJson } from "../../packages/core/src/identity/canonical-json.js";
import { LedgerRepository } from "../../packages/core/src/ledger/repository.js";
import {
  BASELINE,
  FIXED_NOW,
  makeInput,
  makeProjectRoot,
} from "../../packages/core/test/ledger/fixtures.js";
import type { PolicyDecision } from "../../packages/runtime/src/policy/decision.js";
import type { Protocol13TaskSpecification } from "../../packages/runtime/src/planning/task.js";
import { createFileSystemDriverLock } from "../../packages/runtime/src/scheduling/driver-lock.js";
import {
  buildTaskLeaseChain,
  grantTaskLease,
  terminateTaskLease,
  type GrantTaskLeaseInput,
  type TaskLeaseChain,
} from "../../packages/runtime/src/scheduling/lease.js";
import {
  acquireTaskResources,
  emptyResourceLockTable,
  rebuildResourceLocks,
  releaseTaskResources,
} from "../../packages/runtime/src/scheduling/resource-locks.js";

/**
 * Plan Task 6 step 3/5 fault evidence: crash recovery of the operation
 * Driver Lock and the resource lock projection (design §4.1/§12/§16). A dead
 * same-host owner's lock is reclaimed, a live owner is never reclaimed — age
 * alone is never death — malformed owner metadata blocks instead of being
 * deleted, a superseded owner token cannot release the new owner's lock, the
 * resource lock table rebuilds byte-equivalently from the granted Leases, and
 * the Ledger transaction lock commits normally while the Driver Lock is held
 * (the two locks are independent).
 */

const digest = (char: string): string => char.repeat(64);
const HOST = "m4-fault-host";
const ISSUED_AT = "2026-08-31T00:00:00.000Z";
const EXPIRES_AT = "2026-08-31T01:00:00.000Z";

function harnessRootOf(projectRoot: string): string {
  const harnessRoot = join(projectRoot, ".harness");
  mkdirSync(harnessRoot, { recursive: true });
  return harnessRoot;
}

function makeLock(harnessRoot: string, pid: number, isProcessAlive: (pid: number) => boolean) {
  return createFileSystemDriverLock({
    harness_root: harnessRoot,
    host: HOST,
    pid,
    is_process_alive: isProcessAlive,
  });
}

describe("driver lock crash recovery", () => {
  it("reclaims a dead same-host owner's lock; the old handle cannot release it", async () => {
    const harnessRoot = harnessRootOf(makeProjectRoot());
    // The crashed driver was pid 222222; nothing on this host answers for it.
    const crashed = makeLock(harnessRoot, 222_222, () => false);
    const staleHandle = await crashed.acquire({ operation_id: "operation_1", driver_kind: "cli" });

    const recovering = makeLock(harnessRoot, 333_333, (pid) => pid === 333_333);
    const live = await recovering.acquire({
      operation_id: "operation_1",
      driver_kind: "dashboard",
    });
    expect(live.path).toBe(staleHandle.path);
    expect(live.owner_token).not.toBe(staleHandle.owner_token);

    // The superseded owner must not release the new driver's lock.
    await expect(staleHandle.release()).rejects.toMatchObject({
      kind: "driver_lock_owner_mismatch",
    });
    expect(existsSync(live.path)).toBe(true);
    await live.release();
    expect(existsSync(live.path)).toBe(false);
  });

  it("never reclaims a live owner, however old the lock is", async () => {
    const harnessRoot = harnessRootOf(makeProjectRoot());
    const alive = makeLock(harnessRoot, 222_222, () => true);
    const handle = await alive.acquire({ operation_id: "operation_1", driver_kind: "cli" });

    // Backdate the owner metadata far into the past: age alone is not death.
    const ownerPath = join(handle.path, "owner.json");
    const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
    writeFileSync(
      ownerPath,
      `${canonicalizeJson({ ...owner, acquired_at: "2020-01-01T00:00:00.000Z" })}\n`,
    );

    const contender = makeLock(harnessRoot, 333_333, () => true);
    await expect(
      contender.acquire({ operation_id: "operation_1", driver_kind: "dashboard" }),
    ).rejects.toMatchObject({ kind: "driver_lock_unavailable" });
    // The live owner's metadata was not rewritten or removed.
    expect(readFileSync(ownerPath, "utf8")).toContain("2020-01-01T00:00:00.000Z");
    await handle.release();
  });

  it("blocks on malformed owner metadata instead of deleting it", async () => {
    const harnessRoot = harnessRootOf(makeProjectRoot());
    const first = makeLock(harnessRoot, 222_222, () => false);
    const handle = await first.acquire({ operation_id: "operation_1", driver_kind: "cli" });
    const ownerPath = join(handle.path, "owner.json");

    const contender = makeLock(harnessRoot, 333_333, () => false);
    for (const corrupt of ["not json at all", '{"pid": "a string, not a number"}']) {
      writeFileSync(ownerPath, corrupt);
      await expect(
        contender.acquire({ operation_id: "operation_1", driver_kind: "dashboard" }),
      ).rejects.toMatchObject({ kind: "driver_lock_owner_malformed" });
      // The corrupt evidence stays on disk for diagnosis; nothing is reclaimed.
      expect(readFileSync(ownerPath, "utf8")).toBe(corrupt);
    }
    // Owner metadata naming a different operation is equally malformed.
    const stale = JSON.parse(readFileSync(join(handle.path, "owner.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const foreign = `${canonicalizeJson({ ...stale, operation_id: "operation_other" })}\n`;
    writeFileSync(ownerPath, foreign);
    await expect(
      contender.acquire({ operation_id: "operation_1", driver_kind: "dashboard" }),
    ).rejects.toMatchObject({ kind: "driver_lock_owner_malformed" });
    expect(readFileSync(ownerPath, "utf8")).toBe(foreign);
    rmSync(handle.path, { recursive: true, force: true });
  });

  it("treats a lock without owner metadata as mid-acquisition, never as stale", async () => {
    const harnessRoot = harnessRootOf(makeProjectRoot());
    const first = makeLock(harnessRoot, 222_222, () => false);
    const handle = await first.acquire({ operation_id: "operation_1", driver_kind: "cli" });
    rmSync(join(handle.path, "owner.json"));

    const contender = makeLock(harnessRoot, 333_333, () => false);
    await expect(
      contender.acquire({ operation_id: "operation_1", driver_kind: "dashboard" }),
    ).rejects.toMatchObject({ kind: "driver_lock_unavailable" });
    expect(existsSync(handle.path)).toBe(true);
    rmSync(handle.path, { recursive: true, force: true });
  });

  it("lets the Ledger transaction commit while the Driver Lock is held", async () => {
    const projectRoot = makeProjectRoot();
    const repository = new LedgerRepository({
      projectRoot,
      readBaseline: () => BASELINE,
      now: () => FIXED_NOW,
    });
    const lock = makeLock(harnessRootOf(repository.harnessRoot), 222_222, () => true);
    const handle = await lock.acquire({ operation_id: "operation_1", driver_kind: "cli" });

    const result = await repository.commit(makeInput("ledger-op_driver_lock01"));
    expect(result.status).toBe("committed");
    expect(repository.operations()).toHaveLength(1);
    await handle.release();
  });
});

describe("resource lock rebuild after a coordinator crash", () => {
  function makeTask(
    id: string,
    writePaths: readonly string[],
    exclusiveResources: readonly string[],
  ): Protocol13TaskSpecification {
    return {
      id,
      objective: `objective of ${id}`,
      impact_paths: [],
      expected_outputs: [`output_${id}`],
      capabilities: ["edit-source"],
      tools: ["apply_patch"],
      dependencies: [],
      risk: "low",
      budget: { steps: 5, tokens: 1_000, duration_ms: 60_000 },
      write_paths: writePaths,
      exclusive_resources: exclusiveResources,
      acceptance: [{ description: "works", verification: "vitest" }],
      required_gates: [],
    };
  }

  function allowDecision(): PolicyDecision {
    return {
      outcome: "allow",
      reasons: [],
      action_digest: digest("0"),
      effective_policy_digest: digest("d"),
      layers: [],
      field_traces: [],
      digest: digest("9"),
    };
  }

  function grantInput(chain: TaskLeaseChain, taskId: string): GrantTaskLeaseInput {
    return {
      chain,
      decision: allowDecision(),
      expected_action_digest: digest("0"),
      operation_id: "operation_m4_fault_locks",
      iteration_id: "iteration_m4_fault_locks",
      plan_digest: digest("a"),
      task_id: taskId,
      task_digest: digest("b"),
      run_id: `run_${taskId}`,
      slot_id: "slot_01",
      baseline_commit: BASELINE,
      agent_adapter_digest: digest("c"),
      reserved_budget: { steps: 5, tokens: 1_000 },
      issued_at: ISSUED_AT,
      expires_at: EXPIRES_AT,
      command_id: `command_grant_${taskId}_${chain.records.length}`,
    };
  }

  it("rebuilds a byte-equivalent table binding the latest fencing tokens", () => {
    const taskA = makeTask("task_a", ["src/api"], ["database-schema"]);
    const taskB = makeTask("task_b", ["src/web"], []);

    // task_a crashes once and retries with fencing token 2; task_b runs once.
    const firstA = grantTaskLease(grantInput(buildTaskLeaseChain([]), "task_a"));
    const expiredA = terminateTaskLease(firstA, {
      state: "expired",
      consumed_budget: { steps: 5, tokens: 1_000 },
      command_id: "command_expire_task_a",
    });
    const afterExpiry = buildTaskLeaseChain([firstA, expiredA]);
    const retryA = grantTaskLease(grantInput(afterExpiry, "task_a"));
    const grantedB = grantTaskLease(grantInput(buildTaskLeaseChain([firstA, expiredA]), "task_b"));
    const records = [firstA, expiredA, retryA, grantedB];
    expect(retryA.fencing_token).toBe(2);

    // The live table the crashed Coordinator held.
    let live = emptyResourceLockTable();
    live = acquireTaskResources(live, {
      task_id: "task_a",
      fencing_token: 2,
      write_paths: taskA.write_paths,
      exclusive_resources: taskA.exclusive_resources,
    });
    live = acquireTaskResources(live, {
      task_id: "task_b",
      fencing_token: 1,
      write_paths: taskB.write_paths,
      exclusive_resources: taskB.exclusive_resources,
    });

    // Crash: only the authoritative Lease records survive the Coordinator.
    const rebuilt = rebuildResourceLocks([taskA, taskB], buildTaskLeaseChain(records));
    expect(canonicalizeJson(rebuilt)).toBe(canonicalizeJson(live));

    // The expired attempt's stale token can never release the rebuilt locks.
    expect(() =>
      releaseTaskResources(rebuilt, { task_id: "task_a", fencing_token: 1 }),
    ).toThrowError(expect.objectContaining({ kind: "release_mismatch" }));
    const released = releaseTaskResources(rebuilt, { task_id: "task_a", fencing_token: 2 });
    expect(released.entries).toHaveLength(1);
  });
});
