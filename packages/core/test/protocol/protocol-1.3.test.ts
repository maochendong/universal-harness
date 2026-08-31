import { describe, expect, it } from "vitest";

import {
  PROTOCOL_1_2_VERSION,
  PROTOCOL_1_3_VERSION,
  ProtocolProjectionError,
  assertKnownProtocol,
  assertProtocolReaderCanProject,
  isKnownProtocol,
} from "../../src/protocol.js";
import { readCommittedOperations } from "../../src/ledger/event-store.js";
import { LedgerRepository } from "../../src/ledger/repository.js";
import { LedgerValidationError, validateTransaction } from "../../src/ledger/transaction.js";
import { BASELINE, FIXED_NOW, makeEvent, makeInput, makeProjectRoot } from "../ledger/fixtures.js";

describe("protocol 1.3 registration", () => {
  it("registers 1.3.0 as in-development on the same major", () => {
    expect(isKnownProtocol(PROTOCOL_1_3_VERSION)).toBe(true);
    expect(assertKnownProtocol("1.3.0")).toMatchObject({
      version: "1.3.0",
      major: 1,
      status: "development",
    });
  });

  it("keeps the 1.0/1.1/1.2 registrations unchanged", () => {
    expect(assertKnownProtocol("1.0.0")).toMatchObject({ status: "stable" });
    expect(assertKnownProtocol("1.1.0")).toMatchObject({ status: "development" });
    expect(assertKnownProtocol(PROTOCOL_1_2_VERSION)).toMatchObject({ status: "development" });
  });
});

describe("reader compatibility", () => {
  it("permits a 1.3 reader to project every 1.0-1.3 authoritative record", () => {
    for (const recordVersion of ["1.0.0", "1.1.0", "1.2.0", "1.3.0"]) {
      expect(() =>
        assertProtocolReaderCanProject({
          readerVersion: PROTOCOL_1_3_VERSION,
          recordVersion,
          authoritative: true,
        }),
      ).not.toThrow();
    }
  });

  it("fails closed with protocol_upgrade_required for a 1.2 reader and an authoritative 1.3 record", () => {
    const act = () =>
      assertProtocolReaderCanProject({
        readerVersion: PROTOCOL_1_2_VERSION,
        recordVersion: PROTOCOL_1_3_VERSION,
        authoritative: true,
      });
    expect(act).toThrow(ProtocolProjectionError);
    expect(act).toThrow(/protocol_upgrade_required/);
    try {
      act();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolProjectionError);
      expect((error as ProtocolProjectionError).kind).toBe("protocol_upgrade_required");
    }
  });

  it("permits a 1.2 reader to skip non-authoritative 1.3 records", () => {
    expect(() =>
      assertProtocolReaderCanProject({
        readerVersion: PROTOCOL_1_2_VERSION,
        recordVersion: PROTOCOL_1_3_VERSION,
        authoritative: false,
      }),
    ).not.toThrow();
  });
});

const TASK_LEASE_ARTIFACT = `${JSON.stringify({
  protocol_version: "1.3.0",
  record_kind: "task_lease",
})}\n`;

function m4TransactionInput(ledgerOperationId: string) {
  return makeInput(ledgerOperationId, {
    artifacts: [
      {
        path: "scheduling/leases/task-lease-record_01.json",
        content: TASK_LEASE_ARTIFACT,
      },
    ],
    events: [
      {
        ...makeEvent(`event_${ledgerOperationId}`, ledgerOperationId, 1),
        protocol_version: PROTOCOL_1_3_VERSION,
        event_type: "TaskLeaseGranted",
      },
    ],
  });
}

describe("required_reader_version on ledger manifests", () => {
  it("rejects an M4 transaction that omits required_reader_version", () => {
    const issues = validateTransaction(m4TransactionInput("ledger-op_m4_01"));
    expect(issues.length).toBeGreaterThan(0);
    const pinIssue = issues.find((issue) => issue.instancePath === "/required_reader_version");
    expect(pinIssue?.message).toContain("1.3.0");
  });

  it("accepts an M4 transaction with required_reader_version pinned to exactly 1.3.0", () => {
    expect(
      validateTransaction({
        ...m4TransactionInput("ledger-op_m4_02"),
        required_reader_version: "1.3.0",
      }),
    ).toEqual([]);
  });

  it("rejects an M4 transaction pinned to the stale 1.2.0 reader version", () => {
    const issues = validateTransaction({
      ...m4TransactionInput("ledger-op_m4_03"),
      required_reader_version: PROTOCOL_1_2_VERSION,
    });
    const pinIssue = issues.find((issue) => issue.instancePath === "/required_reader_version");
    expect(pinIssue?.message).toContain("1.3.0");
  });

  it("requires the newest carried version when a transaction mixes 1.2 and 1.3 content", () => {
    const mixed = m4TransactionInput("ledger-op_m4_04");
    mixed.events.push({
      ...makeEvent(`event_mixed_${mixed.ledger_operation_id}`, mixed.ledger_operation_id, 2),
      protocol_version: PROTOCOL_1_2_VERSION,
      event_type: "RemoteConnected",
    });
    const stalePin = validateTransaction({ ...mixed, required_reader_version: "1.2.0" });
    expect(stalePin.map((issue) => issue.instancePath)).toContain("/required_reader_version");
    expect(validateTransaction({ ...mixed, required_reader_version: "1.3.0" })).toEqual([]);
  });

  it("commits a 1.3 manifest and blocks readers older than required_reader_version", async () => {
    const projectRoot = makeProjectRoot();
    const repository = new LedgerRepository({
      projectRoot,
      readBaseline: () => BASELINE,
      now: () => FIXED_NOW,
    });

    await expect(repository.commit(m4TransactionInput("ledger-op_m4_05"))).rejects.toBeInstanceOf(
      LedgerValidationError,
    );

    const committed = await repository.commit({
      ...m4TransactionInput("ledger-op_m4_05"),
      required_reader_version: "1.3.0",
    });
    expect(committed.status).toBe("committed");
    expect(committed.manifest.required_reader_version).toBe("1.3.0");

    expect(() => readCommittedOperations(repository.harnessRoot)).not.toThrow();
    const staleRead = () =>
      readCommittedOperations(repository.harnessRoot, { readerVersion: PROTOCOL_1_2_VERSION });
    expect(staleRead).toThrow(ProtocolProjectionError);
    expect(staleRead).toThrow(/protocol_upgrade_required/);
  });
});
