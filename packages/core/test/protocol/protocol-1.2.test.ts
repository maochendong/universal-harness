import { describe, expect, it } from "vitest";

import {
  PROTOCOL_1_1_VERSION,
  PROTOCOL_1_2_VERSION,
  assertKnownProtocol,
  isKnownProtocol,
} from "../../src/protocol.js";
import { canonicalizeJson } from "../../src/identity/canonical-json.js";
import { readCommittedOperations } from "../../src/ledger/event-store.js";
import { LedgerRepository } from "../../src/ledger/repository.js";
import { LedgerValidationError, validateTransaction } from "../../src/ledger/transaction.js";
import {
  ProtocolProjectionError,
  assertProtocolReaderCanProject,
  buildCollaborationRecord,
} from "../../src/collaboration/records.js";
import { recordEnvelopeSchema, recordEnvelopeSchemaFor } from "../../src/schema/envelope.js";
import {
  PROTOCOL_1_1_SCHEMA_REGISTRY,
  PROTOCOL_1_2_SCHEMA_REGISTRY,
} from "../../src/schema/registry.js";
import { BASELINE, FIXED_NOW, makeEvent, makeInput, makeProjectRoot } from "../ledger/fixtures.js";
import { collaborationConnectionDraft } from "../collaboration/fixtures.js";

describe("protocol 1.2 registration", () => {
  it("registers 1.2.0 as in-development on the same major", () => {
    expect(isKnownProtocol(PROTOCOL_1_2_VERSION)).toBe(true);
    expect(assertKnownProtocol("1.2.0")).toMatchObject({
      version: "1.2.0",
      major: 1,
      status: "development",
    });
  });

  it("keeps the 1.0/1.1 registrations unchanged", () => {
    expect(assertKnownProtocol("1.0.0")).toMatchObject({ status: "stable" });
    expect(assertKnownProtocol(PROTOCOL_1_1_VERSION)).toMatchObject({ status: "development" });
  });
});

describe("protocol 1.2 schema registry", () => {
  it("exposes exactly the five frozen collaboration record schemas", () => {
    expect(PROTOCOL_1_2_SCHEMA_REGISTRY.keys).toEqual([
      "collaboration-connection",
      "principal-snapshot",
      "lease",
      "remote-approval-decision",
      "integration",
    ]);
  });

  it("pins the requested protocol version literal on the generalized envelope", () => {
    // TypeBox attaches non-enumerable symbol metadata, so match the JSON
    // Schema surface rather than the raw object identity.
    expect(
      recordEnvelopeSchemaFor("1.2.0", "principal_snapshot", {}).properties.protocol_version,
    ).toMatchObject({ const: "1.2.0", type: "string" });
    expect(recordEnvelopeSchema("example_record", {}).properties.protocol_version).toMatchObject({
      const: "1.1.0",
      type: "string",
    });
  });

  it("accepts a sealed 1.2 record and rejects one pinned to a foreign protocol", () => {
    const sealed = buildCollaborationRecord(collaborationConnectionDraft());
    expect(PROTOCOL_1_2_SCHEMA_REGISTRY.validate("collaboration-connection", sealed)).toMatchObject(
      { valid: true },
    );
    expect(
      PROTOCOL_1_2_SCHEMA_REGISTRY.validate("collaboration-connection", {
        ...sealed,
        protocol_version: PROTOCOL_1_1_VERSION,
      }),
    ).toMatchObject({ valid: false });
  });

  it("1.1 registry rejects a 1.2 record instead of projecting it", () => {
    const sealed = buildCollaborationRecord(collaborationConnectionDraft());
    expect(PROTOCOL_1_1_SCHEMA_REGISTRY.validate("collaboration-connection", sealed)).toMatchObject(
      { valid: false },
    );
    expect(PROTOCOL_1_1_SCHEMA_REGISTRY.has("collaboration-connection")).toBe(false);
  });
});

describe("reader compatibility", () => {
  it("permits a 1.2 reader to project 1.0/1.1 and equal-version records", () => {
    expect(() =>
      assertProtocolReaderCanProject({
        readerVersion: "1.2.0",
        recordVersion: "1.0.0",
        authoritative: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertProtocolReaderCanProject({
        readerVersion: "1.2.0",
        recordVersion: "1.1.0",
        authoritative: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertProtocolReaderCanProject({
        readerVersion: "1.2.0",
        recordVersion: "1.2.0",
        authoritative: true,
      }),
    ).not.toThrow();
  });

  it("fails closed with protocol_upgrade_required for an old reader and an authoritative 1.2 record", () => {
    const act = () =>
      assertProtocolReaderCanProject({
        readerVersion: "1.1.0",
        recordVersion: "1.2.0",
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

  it("permits an old reader to skip non-authoritative newer records", () => {
    expect(() =>
      assertProtocolReaderCanProject({
        readerVersion: "1.1.0",
        recordVersion: "1.2.0",
        authoritative: false,
      }),
    ).not.toThrow();
  });
});

function m3TransactionInput(ledgerOperationId: string) {
  const connection = buildCollaborationRecord(collaborationConnectionDraft());
  return makeInput(ledgerOperationId, {
    artifacts: [
      {
        path: "collaboration/connections/connection_01.json",
        content: `${canonicalizeJson(connection)}\n`,
      },
    ],
    events: [
      {
        ...makeEvent(`event_${ledgerOperationId}`, ledgerOperationId, 1),
        protocol_version: PROTOCOL_1_2_VERSION,
        event_type: "RemoteConnected",
      },
    ],
  });
}

describe("required_reader_version on ledger manifests", () => {
  it("rejects an M3 transaction that omits required_reader_version", () => {
    const issues = validateTransaction(m3TransactionInput("ledger-op_m3_01"));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.map((issue) => issue.instancePath)).toContain("/required_reader_version");
  });

  it("accepts an M3 transaction with required_reader_version pinned to 1.2.0", () => {
    expect(
      validateTransaction({
        ...m3TransactionInput("ledger-op_m3_02"),
        required_reader_version: "1.2.0",
      }),
    ).toEqual([]);
  });

  it("rejects required_reader_version on a plain 1.0/1.1 transaction", () => {
    const issues = validateTransaction({
      ...makeInput("ledger-op_plain_01"),
      required_reader_version: "1.2.0",
    });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.map((issue) => issue.instancePath)).toContain("/required_reader_version");
  });

  it("keeps existing 1.0/1.1 transactions valid without the field", () => {
    expect(validateTransaction(makeInput("ledger-op_plain_02"))).toEqual([]);
  });

  it("commits a 1.2 manifest and blocks readers older than required_reader_version", async () => {
    const projectRoot = makeProjectRoot();
    const repository = new LedgerRepository({
      projectRoot,
      readBaseline: () => BASELINE,
      now: () => FIXED_NOW,
    });

    await expect(repository.commit(m3TransactionInput("ledger-op_m3_03"))).rejects.toBeInstanceOf(
      LedgerValidationError,
    );

    const committed = await repository.commit({
      ...m3TransactionInput("ledger-op_m3_03"),
      required_reader_version: "1.2.0",
    });
    expect(committed.status).toBe("committed");
    expect(committed.manifest.required_reader_version).toBe("1.2.0");

    expect(() => readCommittedOperations(repository.harnessRoot)).not.toThrow();
    const staleRead = () =>
      readCommittedOperations(repository.harnessRoot, { readerVersion: "1.1.0" });
    expect(staleRead).toThrow(ProtocolProjectionError);
    expect(staleRead).toThrow(/protocol_upgrade_required/);
  });

  it("commits a plain transaction without the field and reads it under any reader", async () => {
    const projectRoot = makeProjectRoot();
    const repository = new LedgerRepository({
      projectRoot,
      readBaseline: () => BASELINE,
      now: () => FIXED_NOW,
    });
    const committed = await repository.commit(makeInput("ledger-op_plain_03"));
    expect(committed.status).toBe("committed");
    expect(committed.manifest.required_reader_version).toBeUndefined();
    expect(
      readCommittedOperations(repository.harnessRoot, { readerVersion: "1.0.0" }),
    ).toHaveLength(1);
  });

  it("rejects a manifest whose required_reader_version is not exactly 1.2.0", () => {
    const issues = validateTransaction({
      ...m3TransactionInput("ledger-op_m3_04"),
      required_reader_version: "9.9.9",
    });
    expect(issues.map((issue) => issue.instancePath)).toContain("/required_reader_version");
  });
});
