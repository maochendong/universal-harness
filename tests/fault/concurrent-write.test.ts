import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LedgerConflict,
  LedgerRepository,
  LockUnavailable,
  WRITE_LOCK_RELATIVE_PATH,
  acquireWriteLock,
  canonicalizeJson,
  resolveHarnessPath,
} from "../../packages/core/src/index.js";
import { BASELINE, FIXED_NOW, makeInput } from "../../packages/core/test/ledger/fixtures.js";

/**
 * Concurrent-write fault injection (design 15.2, plan Task 27). The project
 * write lock serializes writers: concurrent commits of distinct operations
 * both land with unique append-only sequences, a concurrent retry of the same
 * operation resolves idempotently, a conflicting retry is a typed conflict, a
 * live lock holder surfaces a typed LockUnavailable, and a lock orphaned by a
 * dead process is reclaimed instead of blocking forever.
 */
const created: string[] = [];

function makeRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "harness-concurrent-"));
  created.push(directory);
  return directory;
}

afterEach(() => {
  while (created.length > 0) {
    const directory = created.pop();
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

function repository(projectRoot: string): LedgerRepository {
  return new LedgerRepository({ projectRoot, readBaseline: () => BASELINE, now: () => FIXED_NOW });
}

describe("concurrent ledger writes", () => {
  it("serializes concurrent commits of distinct operations", async () => {
    const projectRoot = makeRoot();
    const first = repository(projectRoot);
    const second = repository(projectRoot);
    const outcomes = await Promise.all([
      first.commit(makeInput("ledger-op_conc01")),
      second.commit(makeInput("ledger-op_conc02")),
    ]);
    expect(outcomes.every((outcome) => outcome.status === "committed")).toBe(true);
    const sequences = repository(projectRoot)
      .operations()
      .map((operation) => operation.manifest.sequence);
    expect(sequences).toEqual([1, 2]);
  });

  it("resolves a concurrent retry of the same operation idempotently", async () => {
    const projectRoot = makeRoot();
    const input = makeInput("ledger-op_conc03");
    const outcomes = await Promise.all([
      repository(projectRoot).commit(input),
      repository(projectRoot).commit(input),
    ]);
    const statuses = outcomes.map((outcome) => outcome.status).sort();
    expect(statuses).toEqual(["already_committed", "committed"]);
    expect(outcomes[0]?.manifest.digest).toBe(outcomes[1]?.manifest.digest);
    expect(repository(projectRoot).operations()).toHaveLength(1);
  });

  it("rejects a conflicting retry of the same operation with a typed conflict", async () => {
    const projectRoot = makeRoot();
    const repo = repository(projectRoot);
    await repo.commit(makeInput("ledger-op_conc04"));
    await expect(
      repo.commit(makeInput("ledger-op_conc04", { attempt_id: "attempt_other" })),
    ).rejects.toBeInstanceOf(LedgerConflict);
    expect(repo.operations()).toHaveLength(1);
  });

  it("surfaces a typed LockUnavailable while a live process holds the lock", async () => {
    const projectRoot = makeRoot();
    const harnessRoot = resolveHarnessPath(repository(projectRoot).harnessRoot, "locks");
    mkdirSync(harnessRoot, { recursive: true });
    const lock = await acquireWriteLock({ harnessRoot: repository(projectRoot).harnessRoot });
    try {
      const contender = new LedgerRepository({
        projectRoot,
        readBaseline: () => BASELINE,
        now: () => FIXED_NOW,
        lock: { timeoutMs: 150, maxAttempts: 2, initialBackoffMs: 5, maxBackoffMs: 10 },
      });
      await expect(contender.commit(makeInput("ledger-op_conc05"))).rejects.toBeInstanceOf(
        LockUnavailable,
      );
      expect(contender.operations()).toHaveLength(0);
    } finally {
      lock.release();
    }
    // Once the holder releases, the contender commits normally.
    const outcome = await repository(projectRoot).commit(makeInput("ledger-op_conc05"));
    expect(outcome.status).toBe("committed");
  });

  it("reclaims a lock orphaned by a dead process", async () => {
    const projectRoot = makeRoot();
    const root = repository(projectRoot).harnessRoot;
    const lockDir = resolveHarnessPath(root, WRITE_LOCK_RELATIVE_PATH);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "owner.json"),
      `${canonicalizeJson({ pid: 424242, hostname: "dead-host", acquired_at: FIXED_NOW })}\n`,
      "utf8",
    );
    // The owner pid is dead, so acquisition reclaims the stale lock.
    const lock = await acquireWriteLock({
      harnessRoot: root,
      isProcessAlive: () => false,
    });
    lock.release();
    const outcome = await repository(projectRoot).commit(makeInput("ledger-op_conc06"));
    expect(outcome.status).toBe("committed");
  });
});
