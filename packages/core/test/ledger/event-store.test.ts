import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertAppendOnly,
  assertBaselineCompatible,
  mergeCommittedOperations,
  nextSequence,
  readCommittedOperations,
  replayLedger,
  sha256Hex,
  type CommittedOperation,
} from "../../src/ledger/event-store.js";
import { operationManifestRelativePath, resolveHarnessPath } from "../../src/ledger/layout.js";
import { LedgerRepository } from "../../src/ledger/repository.js";
import {
  BaselineMismatch,
  LedgerConflict,
  LedgerCorruptionError,
  LedgerSequenceError,
  buildManifest,
} from "../../src/ledger/transaction.js";

import { BASELINE, FIXED_MONTH, FIXED_NOW, makeInput, makeProjectRoot } from "./fixtures.js";

function makeRepository(projectRoot: string): LedgerRepository {
  return new LedgerRepository({
    projectRoot,
    readBaseline: () => BASELINE,
    now: () => FIXED_NOW,
  });
}

function virtualOperation(
  operationId: string,
  sequence: number,
  baseline: string = BASELINE,
): CommittedOperation {
  const manifest = buildManifest({
    ledger_operation_id: operationId,
    workflow_operation_id: "workflow-op_01",
    attempt_id: "attempt_01",
    baseline_commit: baseline,
    sequence,
    artifact_digests: [],
    edge_file: `ledger/edges/${FIXED_MONTH}/${operationId}.jsonl`,
    event_file: `events/${FIXED_MONTH}/${operationId}.jsonl`,
    edge_file_digest: sha256Hex(""),
    event_file_digest: sha256Hex(""),
    committed_at: FIXED_NOW,
  });
  return { manifest, manifestPath: `/virtual/ledger/operations/${operationId}.json` };
}

describe("committed operation store", () => {
  it("replays by manifest sequence, never by directory order", async () => {
    const projectRoot = makeProjectRoot();
    const repository = makeRepository(projectRoot);
    // File names sort in the opposite order of the logical sequence.
    await repository.commit(makeInput("ledger-op_zzzz"));
    await repository.commit(makeInput("ledger-op_aaaa"));

    const replay = replayLedger(repository.harnessRoot);
    expect(replay.operations.map((op) => op.manifest.ledger_operation_id)).toEqual([
      "ledger-op_zzzz",
      "ledger-op_aaaa",
    ]);
    expect(replay.events.map((event) => event.ledger_operation_id)).toEqual([
      "ledger-op_zzzz",
      "ledger-op_aaaa",
    ]);
    expect(nextSequence(replay.operations)).toBe(3);
  });

  it("rejects manifests whose digest no longer matches", async () => {
    const projectRoot = makeProjectRoot();
    const repository = makeRepository(projectRoot);
    await repository.commit(makeInput("ledger-op_01"));

    const manifestPath = resolveHarnessPath(
      repository.harnessRoot,
      operationManifestRelativePath("ledger-op_01"),
    );
    const tampered = JSON.parse(readFileSync(manifestPath, "utf8")) as { sequence: number };
    tampered.sequence = 99;
    writeFileSync(manifestPath, `${JSON.stringify(tampered)}\n`);

    expect(() => readCommittedOperations(repository.harnessRoot)).toThrow(LedgerCorruptionError);
  });

  it("rejects unparsable manifest files", async () => {
    const projectRoot = makeProjectRoot();
    const repository = makeRepository(projectRoot);
    await repository.commit(makeInput("ledger-op_01"));
    const operationsDir = resolveHarnessPath(repository.harnessRoot, "ledger/operations");
    writeFileSync(join(operationsDir, "ledger-op_broken.json"), "not json\n");
    expect(() => readCommittedOperations(repository.harnessRoot)).toThrow(LedgerCorruptionError);
  });

  it("blocks replay when shard bytes drift from the manifest digest", async () => {
    const projectRoot = makeProjectRoot();
    const repository = makeRepository(projectRoot);
    await repository.commit(makeInput("ledger-op_01"));

    const eventShard = resolveHarnessPath(
      repository.harnessRoot,
      `events/${FIXED_MONTH}/ledger-op_01.jsonl`,
    );
    appendFileSync(eventShard, '{"corrupt":true}\n');

    expect(() => replayLedger(repository.harnessRoot)).toThrow(LedgerCorruptionError);
  });
});

describe("append-only and merge invariants", () => {
  it("enforces the append-only sequence and unique operation ids", () => {
    const operations = [virtualOperation("ledger-op_01", 1)];
    expect(() =>
      assertAppendOnly(operations, { ledger_operation_id: "ledger-op_02", sequence: 2 }),
    ).not.toThrow();
    expect(() =>
      assertAppendOnly(operations, { ledger_operation_id: "ledger-op_01", sequence: 2 }),
    ).toThrow(LedgerConflict);
    expect(() =>
      assertAppendOnly(operations, { ledger_operation_id: "ledger-op_03", sequence: 3 }),
    ).toThrow(LedgerSequenceError);
  });

  it("merges distinct operations from different branches", () => {
    const local = [virtualOperation("ledger-op_01", 1), virtualOperation("ledger-op_02", 2)];
    const incoming = [virtualOperation("ledger-op_03", 3)];
    // The identical operation on both branches is not a conflict.
    const shared = virtualOperation("ledger-op_02", 2);
    const merged = mergeCommittedOperations(local, [...incoming, shared]);
    expect(merged.map((op) => op.manifest.ledger_operation_id)).toEqual([
      "ledger-op_01",
      "ledger-op_02",
      "ledger-op_03",
    ]);
  });

  it("blocks the same operation id with conflicting digests", () => {
    const local = [virtualOperation("ledger-op_01", 1)];
    const conflicting = virtualOperation("ledger-op_01", 1, "fedcba9876543210");
    expect(() => mergeCommittedOperations(local, [conflicting])).toThrow(LedgerConflict);
  });

  it("blocks revision forks at the same sequence", () => {
    const local = [virtualOperation("ledger-op_01", 1)];
    const forked = virtualOperation("ledger-op_02", 1);
    expect(() => mergeCommittedOperations(local, [forked])).toThrow(LedgerSequenceError);
  });

  it("blocks operations targeting an incompatible baseline", () => {
    const operations = [virtualOperation("ledger-op_01", 1, "aaaabbbbccccdddd")];
    expect(() => assertBaselineCompatible(operations, (baseline) => baseline === BASELINE)).toThrow(
      BaselineMismatch,
    );
    expect(() =>
      assertBaselineCompatible(operations, (baseline) => baseline === "aaaabbbbccccdddd"),
    ).not.toThrow();
  });
});
