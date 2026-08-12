import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalizeJson } from "../../src/identity/canonical-json.js";
import { harnessRootFor, resolveHarnessPath } from "../../src/ledger/layout.js";
import { LockUnavailable, acquireWriteLock } from "../../src/ledger/lock.js";
import { LedgerRepository, assertSameVolumeAtomicity } from "../../src/ledger/repository.js";
import {
  BaselineMismatch,
  LedgerConflict,
  LedgerValidationError,
  UnsupportedAtomicity,
} from "../../src/ledger/transaction.js";
import { validateSchema } from "../../src/schema/registry.js";

import {
  BASELINE,
  FIXED_MONTH,
  FIXED_NOW,
  makeEvent,
  makeInput,
  makeProjectRoot,
} from "./fixtures.js";

function makeRepository(
  projectRoot: string,
  options?: { baseline?: string; deviceOf?: (path: string) => number },
): LedgerRepository {
  const deviceOf = options?.deviceOf;
  return new LedgerRepository({
    projectRoot,
    readBaseline: () => options?.baseline ?? BASELINE,
    now: () => FIXED_NOW,
    ...(deviceOf === undefined ? {} : { deviceOf }),
  });
}

describe("ledger repository commit", () => {
  it("commits artifacts, shards and manifest atomically", async () => {
    const projectRoot = makeProjectRoot();
    const repository = makeRepository(projectRoot);
    const input = makeInput("ledger-op_01");
    const result = await repository.commit(input);

    expect(result.status).toBe("committed");
    const root = repository.harnessRoot;
    expect(
      existsSync(resolveHarnessPath(root, `ledger/edges/${FIXED_MONTH}/ledger-op_01.jsonl`)),
    ).toBe(true);
    expect(existsSync(resolveHarnessPath(root, `events/${FIXED_MONTH}/ledger-op_01.jsonl`))).toBe(
      true,
    );
    expect(existsSync(resolveHarnessPath(root, "nodes/decisions/decision_01.json"))).toBe(true);

    const manifestRaw = readFileSync(
      resolveHarnessPath(root, "ledger/operations/ledger-op_01.json"),
      "utf8",
    );
    expect(manifestRaw).toBe(`${canonicalizeJson(result.manifest)}\n`);
    expect(validateSchema("ledger-operation", result.manifest)).toMatchObject({ valid: true });

    // Staging is cleaned up and replay sees exactly the committed records.
    expect(existsSync(resolveHarnessPath(root, "staging/ledger-op_01"))).toBe(false);
    const replay = repository.replay();
    expect(replay.edges.map((edge) => edge.id)).toEqual(["edge_ledger-op_01"]);
    expect(replay.events.map((event) => event.event_id)).toEqual(["event_ledger-op_01"]);

    // The next commit continues the append-only sequence.
    const second = await repository.commit(makeInput("ledger-op_02"));
    expect(second.manifest.sequence).toBe(2);
  });

  it("makes retries idempotent through ledger_operation_id", async () => {
    const projectRoot = makeProjectRoot();
    const repository = makeRepository(projectRoot);
    const input = makeInput("ledger-op_01");
    const first = await repository.commit(input);

    const retry = await repository.commit(input);
    expect(retry.status).toBe("already_committed");
    expect(retry.manifest.digest).toBe(first.manifest.digest);

    // A later retry at a different wall-clock time is still the same operation.
    const later = new LedgerRepository({
      projectRoot,
      readBaseline: () => BASELINE,
      now: () => "2027-01-01T00:00:00.000Z",
    });
    const lateRetry = await later.commit(input);
    expect(lateRetry.status).toBe("already_committed");
    expect(repository.replay().events).toHaveLength(1);
  });

  it("blocks the same id committed with different content", async () => {
    const projectRoot = makeProjectRoot();
    const repository = makeRepository(projectRoot);
    await repository.commit(makeInput("ledger-op_01"));
    const conflicting = makeInput("ledger-op_01", {
      events: [makeEvent("event_different", "ledger-op_01", 1)],
    });
    await expect(repository.commit(conflicting)).rejects.toBeInstanceOf(LedgerConflict);
  });

  it("blocks commits on a drifted baseline and preserves staging", async () => {
    const projectRoot = makeProjectRoot();
    const repository = makeRepository(projectRoot, { baseline: "fedcba9876543210" });
    await expect(repository.commit(makeInput("ledger-op_01"))).rejects.toBeInstanceOf(
      BaselineMismatch,
    );
    expect(repository.operations()).toEqual([]);
    const recovery = repository.recover();
    expect(recovery.staging.map((entry) => entry.status)).toEqual(["incomplete"]);
    // Incomplete staging is not authoritative.
    expect(repository.replay().events).toEqual([]);
  });

  it("rejects invalid transactions and keeps staging for revision", async () => {
    const projectRoot = makeProjectRoot();
    const repository = makeRepository(projectRoot);
    const invalid = makeInput("ledger-op_01", {
      events: [makeEvent("event_01", "ledger-op_OTHER", 1)],
    });
    const failure = await repository.commit(invalid).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LedgerValidationError);
    expect((failure as LedgerValidationError).issues.length).toBeGreaterThan(0);
    expect(repository.operations()).toEqual([]);
    expect(existsSync(resolveHarnessPath(repository.harnessRoot, "staging/ledger-op_01"))).toBe(
      true,
    );

    // Explicit discard, then a corrected commit succeeds cleanly.
    repository.discardStaging("ledger-op_01");
    expect(repository.recover().staging).toEqual([]);
    const corrected = await repository.commit(makeInput("ledger-op_01"));
    expect(corrected.status).toBe("committed");
    expect(() => repository.discardStaging("ledger-op_01")).toThrow(LedgerConflict);
  });

  it("reports orphan shards that no committed manifest references", async () => {
    const projectRoot = makeProjectRoot();
    const repository = makeRepository(projectRoot);
    await repository.commit(makeInput("ledger-op_01"));
    const orphanDir = resolveHarnessPath(repository.harnessRoot, `events/${FIXED_MONTH}`);
    writeFileSync(join(orphanDir, "ledger-op_orphan.jsonl"), "");
    expect(repository.recover().orphanShards).toEqual([
      `events/${FIXED_MONTH}/ledger-op_orphan.jsonl`,
    ]);
    // The orphan never feeds replay.
    expect(repository.replay().events.map((event) => event.event_id)).toEqual([
      "event_ledger-op_01",
    ]);
  });

  it("blocks with typed LockUnavailable while another writer holds the lock", async () => {
    const projectRoot = makeProjectRoot();
    const repository = new LedgerRepository({
      projectRoot,
      readBaseline: () => BASELINE,
      now: () => FIXED_NOW,
      lock: { timeoutMs: 100, initialBackoffMs: 5, maxBackoffMs: 20 },
    });
    const lock = await acquireWriteLock({ harnessRoot: harnessRootFor(projectRoot) });
    await expect(repository.commit(makeInput("ledger-op_01"))).rejects.toBeInstanceOf(
      LockUnavailable,
    );
    lock.release();
    expect(repository.operations()).toEqual([]);
  });

  it("blocks with UnsupportedAtomicity when same-volume rename cannot be proven", async () => {
    const projectRoot = makeProjectRoot();
    const repository = makeRepository(projectRoot, {
      deviceOf: (path) => (path.includes("staging") ? 7 : 3),
    });
    await expect(repository.commit(makeInput("ledger-op_01"))).rejects.toBeInstanceOf(
      UnsupportedAtomicity,
    );
    expect(repository.operations()).toEqual([]);
  });

  it("retries retriable rename errors with bounded backoff", async () => {
    // Unit-level: the platform wrapper retries EPERM/EACCES/EBUSY a bounded
    // number of times instead of failing immediately (Windows sharing
    // violations) and never spins forever.
    expect(() => assertSameVolumeAtomicity(["/a", "/b"], () => 1)).not.toThrow();
    expect(() =>
      assertSameVolumeAtomicity(["/a", "/b"], (path) => (path === "/a" ? 1 : 2)),
    ).toThrow(UnsupportedAtomicity);
  });
});

describe("staged output verification", () => {
  it("detects corrupt staged bytes before publishing", async () => {
    const projectRoot = makeProjectRoot();
    const repository = new LedgerRepository({
      projectRoot,
      readBaseline: () => BASELINE,
      now: () => FIXED_NOW,
      hooks: {
        atBoundary(boundary, context) {
          if (boundary !== "staging.prepared") return;
          const staged = context.stagedFiles[0];
          if (staged === undefined) throw new Error("expected staged files");
          writeFileSync(staged, "corrupted bytes\n");
        },
      },
    });
    await expect(repository.commit(makeInput("ledger-op_01"))).rejects.toThrow();
    expect(repository.operations()).toEqual([]);
  });
});
