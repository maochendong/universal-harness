import { describe, expect, it } from "vitest";

import { LedgerRepository } from "../../packages/core/src/ledger/repository.js";
import {
  LedgerCorruptionError,
  type DurableBoundary,
} from "../../packages/core/src/ledger/transaction.js";
import {
  BASELINE,
  FIXED_NOW,
  makeInput,
  makeProjectRoot,
} from "../../packages/core/test/ledger/fixtures.js";
import {
  SimulatedProcessKill,
  SimulatedTimeout,
  UncertainCommitResult,
  createFaultInjector,
  type FaultKind,
} from "../helpers/fault-injection.js";

/**
 * Every durable boundary of the commit protocol is interrupted here. The
 * invariant under test: no fault point ever exposes a partially accepted
 * transaction, and replaying a completed operation never duplicates events.
 */
function makeRepository(
  projectRoot: string,
  fault?: { boundary: DurableBoundary; kind: FaultKind },
): { repository: LedgerRepository; fired: () => boolean } {
  const injector = fault === undefined ? undefined : createFaultInjector(fault);
  const repository = new LedgerRepository({
    projectRoot,
    readBaseline: () => BASELINE,
    now: () => FIXED_NOW,
    ...(injector === undefined ? {} : { hooks: injector.hooks }),
  });
  return { repository, fired: injector?.fired ?? (() => false) };
}

const PRE_COMMIT_BOUNDARIES = [
  "lock.acquired",
  "staging.prepared",
  "validation.completed",
  "shards.renamed",
] as const;

describe("ledger interruption fault injection", () => {
  for (const boundary of PRE_COMMIT_BOUNDARIES) {
    it(`never exposes a partial transaction when killed at ${boundary}`, async () => {
      const projectRoot = makeProjectRoot();
      const input = makeInput("ledger-op_01");

      const crashed = makeRepository(projectRoot, { boundary, kind: "process-kill" });
      await expect(crashed.repository.commit(input)).rejects.toBeInstanceOf(SimulatedProcessKill);
      expect(crashed.fired()).toBe(true);

      // A fresh process observes no partial acceptance: the operation has no
      // manifest, so replay ignores staged or renamed bytes entirely.
      const recovered = makeRepository(projectRoot);
      expect(recovered.repository.operations()).toEqual([]);
      expect(recovered.repository.replay().events).toEqual([]);

      // Retrying the same ledger_operation_id commits exactly once.
      const retry = await recovered.repository.commit(input);
      expect(retry.status).toBe("committed");
      expect(recovered.repository.replay().events.map((event) => event.event_id)).toEqual([
        "event_ledger-op_01",
      ]);
    });
  }

  it("recovers incomplete staging without treating it as authoritative", async () => {
    const projectRoot = makeProjectRoot();
    const crashed = makeRepository(projectRoot, {
      boundary: "validation.completed",
      kind: "process-kill",
    });
    await expect(crashed.repository.commit(makeInput("ledger-op_01"))).rejects.toBeInstanceOf(
      SimulatedProcessKill,
    );

    const recovered = makeRepository(projectRoot);
    const report = recovered.repository.recover();
    expect(report.staging.map((entry) => entry.status)).toEqual(["incomplete"]);
    expect(recovered.repository.replay().events).toEqual([]);

    // Explicit discard, then a fresh commit of the same operation succeeds.
    recovered.repository.discardStaging("ledger-op_01");
    expect(recovered.repository.recover().staging).toEqual([]);
    const retry = await recovered.repository.commit(makeInput("ledger-op_01"));
    expect(retry.status).toBe("committed");
  });

  it("treats a kill at the commit point as durable and replays without duplicates", async () => {
    const projectRoot = makeProjectRoot();
    const crashed = makeRepository(projectRoot, {
      boundary: "manifest.committed",
      kind: "process-kill",
    });
    await expect(crashed.repository.commit(makeInput("ledger-op_01"))).rejects.toBeInstanceOf(
      SimulatedProcessKill,
    );

    // The manifest was the commit point: the operation is fully accepted.
    const recovered = makeRepository(projectRoot);
    expect(recovered.repository.operations()).toHaveLength(1);
    expect(recovered.repository.replay().events).toHaveLength(1);
  });

  it("reconciles an uncertain result through idempotent retry", async () => {
    const projectRoot = makeProjectRoot();
    const uncertain = makeRepository(projectRoot, {
      boundary: "manifest.committed",
      kind: "uncertain-result",
    });
    await expect(uncertain.repository.commit(makeInput("ledger-op_01"))).rejects.toBeInstanceOf(
      UncertainCommitResult,
    );

    // The caller cannot tell whether the commit landed; retrying must not
    // produce a second copy of any event.
    const retried = makeRepository(projectRoot);
    const result = await retried.repository.commit(makeInput("ledger-op_01"));
    expect(result.status).toBe("already_committed");
    expect(retried.repository.replay().events).toHaveLength(1);
    expect(retried.repository.replay().operations).toHaveLength(1);
  });

  it("surfaces a timeout at a durable boundary as an interruption", async () => {
    const projectRoot = makeProjectRoot();
    const timedOut = makeRepository(projectRoot, {
      boundary: "staging.prepared",
      kind: "timeout",
    });
    await expect(timedOut.repository.commit(makeInput("ledger-op_01"))).rejects.toBeInstanceOf(
      SimulatedTimeout,
    );
    const recovered = makeRepository(projectRoot);
    expect(recovered.repository.operations()).toEqual([]);
    const retry = await recovered.repository.commit(makeInput("ledger-op_01"));
    expect(retry.status).toBe("committed");
  });

  it("blocks corrupt staged output before anything is published", async () => {
    const projectRoot = makeProjectRoot();
    const corrupted = makeRepository(projectRoot, {
      boundary: "staging.prepared",
      kind: "corrupt-output",
    });
    await expect(corrupted.repository.commit(makeInput("ledger-op_01"))).rejects.toBeInstanceOf(
      LedgerCorruptionError,
    );

    const recovered = makeRepository(projectRoot);
    expect(recovered.repository.operations()).toEqual([]);
    expect(recovered.repository.replay().events).toEqual([]);

    // Discarding the corrupt staging unblocks a clean retry.
    recovered.repository.discardStaging("ledger-op_01");
    const retry = await recovered.repository.commit(makeInput("ledger-op_01"));
    expect(retry.status).toBe("committed");
  });

  it("refuses to materialize shards whose bytes drifted after rename", async () => {
    const projectRoot = makeProjectRoot();
    const corrupted = makeRepository(projectRoot, {
      boundary: "shards.renamed",
      kind: "corrupt-output",
    });
    // The commit itself completes: corruption hit renamed bytes afterwards.
    const result = await corrupted.repository.commit(makeInput("ledger-op_01"));
    expect(result.status).toBe("committed");

    // Materialization cross-checks shard digests recorded in the manifest and
    // blocks instead of projecting corrupt data.
    const recovered = makeRepository(projectRoot);
    expect(() => recovered.repository.replay()).toThrow(LedgerCorruptionError);
  });
});
