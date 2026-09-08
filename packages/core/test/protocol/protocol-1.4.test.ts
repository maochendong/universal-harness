import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import {
  PROTOCOL_1_2_VERSION,
  PROTOCOL_1_3_VERSION,
  PROTOCOL_1_4_VERSION,
  ProtocolProjectionError,
  assertKnownProtocol,
  assertProtocolReaderCanProject,
  isKnownProtocol,
} from "../../src/protocol.js";
import { readCommittedOperations } from "../../src/ledger/event-store.js";
import { LedgerRepository } from "../../src/ledger/repository.js";
import {
  LedgerValidationError,
  transactionRequiredReaderVersion,
  validateTransaction,
} from "../../src/ledger/transaction.js";
import {
  ExtensionsSchema,
  IdentifierSchema,
  TimestampSchema,
  enumerated,
  persistedRecordProperties,
  strictObject,
} from "../../src/schema/common.js";
import { EVENT_TYPES } from "../../src/schema/event.js";
import { validateSchema } from "../../src/schema/registry.js";
import { compileAjvSchema } from "../../src/schema/validator.js";
import { BASELINE, FIXED_NOW, makeEvent, makeInput, makeProjectRoot } from "../ledger/fixtures.js";

const OBJECT_DIGEST = "a".repeat(64);
const DECISION_DIGEST = "b".repeat(64);
const DECIDED_AT = "2026-09-05T00:00:00.000Z";

function approvalDecidedPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    request_id: "approval_request_t01",
    approval_id: "approval_decision_t01",
    decision: "approve",
    object_digest: OBJECT_DIGEST,
    decision_digest: DECISION_DIGEST,
    decided_at: DECIDED_AT,
    ...overrides,
  };
}

function approvalDecidedEvent(
  eventId: string,
  ledgerOperationId: string,
  sequence: number,
  overrides?: Record<string, unknown>,
) {
  return {
    ...makeEvent(eventId, ledgerOperationId, sequence),
    protocol_version: PROTOCOL_1_4_VERSION,
    event_type: "ApprovalDecided",
    payload: approvalDecidedPayload(),
    ...overrides,
  };
}

function v14TransactionInput(ledgerOperationId: string) {
  return makeInput(ledgerOperationId, {
    events: [approvalDecidedEvent(`event_${ledgerOperationId}`, ledgerOperationId, 1)],
  });
}

describe("protocol 1.4 registration", () => {
  it("registers 1.4.0 as in-development on the same major", () => {
    expect(isKnownProtocol(PROTOCOL_1_4_VERSION)).toBe(true);
    expect(assertKnownProtocol("1.4.0").status).toBe("development");
    expect(assertKnownProtocol("1.4.0")).toMatchObject({ version: "1.4.0", major: 1 });
  });

  it("keeps the 1.0-1.3 registrations unchanged", () => {
    expect(assertKnownProtocol("1.0.0")).toMatchObject({ status: "stable" });
    expect(assertKnownProtocol("1.1.0")).toMatchObject({ status: "development" });
    expect(assertKnownProtocol(PROTOCOL_1_2_VERSION)).toMatchObject({ status: "development" });
    expect(assertKnownProtocol(PROTOCOL_1_3_VERSION)).toMatchObject({ status: "development" });
  });
});

describe("reader compatibility", () => {
  it("permits a 1.4 reader to project every 1.0-1.4 authoritative record", () => {
    for (const recordVersion of ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0"]) {
      expect(() =>
        assertProtocolReaderCanProject({
          readerVersion: PROTOCOL_1_4_VERSION,
          recordVersion,
          authoritative: true,
        }),
      ).not.toThrow();
    }
  });

  it("fails closed with protocol_upgrade_required for a 1.3 reader and an authoritative 1.4 record", () => {
    const act = () =>
      assertProtocolReaderCanProject({
        readerVersion: PROTOCOL_1_3_VERSION,
        recordVersion: PROTOCOL_1_4_VERSION,
        authoritative: true,
      });
    expect(act).toThrow(ProtocolProjectionError);
    expect(act).toThrow(/protocol_upgrade_required/);
  });
});

describe("required_reader_version reduction", () => {
  it("pins a transaction carrying a 1.4 ApprovalDecided event to 1.4.0", () => {
    expect(transactionRequiredReaderVersion(v14TransactionInput("ledger-op_t3_01"))).toBe("1.4.0");
  });

  it("keeps the 1.4 pin when the same transaction carries 1.0/1.2 decision records", () => {
    const mixed = v14TransactionInput("ledger-op_t3_02");
    mixed.artifacts.push({
      path: "artifacts/approvals/approval_decision_legacy.json",
      content: `${JSON.stringify({
        protocol_version: PROTOCOL_1_2_VERSION,
        record_kind: "approval_decision",
      })}\n`,
    });
    mixed.events.push({
      ...makeEvent(`event_mixed_${mixed.ledger_operation_id}`, mixed.ledger_operation_id, 2),
      protocol_version: PROTOCOL_1_2_VERSION,
      event_type: "RemoteApprovalMaterialized",
    });
    expect(transactionRequiredReaderVersion(mixed)).toBe("1.4.0");
  });

  it("rejects a 1.4 transaction that omits required_reader_version", () => {
    const issues = validateTransaction(v14TransactionInput("ledger-op_t3_03"));
    expect(issues.map((issue) => issue.instancePath)).toContain("/required_reader_version");
  });

  it("accepts a 1.4 transaction with required_reader_version pinned to exactly 1.4.0", () => {
    expect(
      validateTransaction({
        ...v14TransactionInput("ledger-op_t3_04"),
        required_reader_version: "1.4.0",
      }),
    ).toEqual([]);
  });

  it("rejects 1.4 transactions pinned to the stale 1.2.0 or 1.3.0 reader versions", () => {
    for (const stalePin of [PROTOCOL_1_2_VERSION, PROTOCOL_1_3_VERSION]) {
      const issues = validateTransaction({
        ...v14TransactionInput("ledger-op_t3_05"),
        required_reader_version: stalePin,
      });
      const pinIssue = issues.find((issue) => issue.instancePath === "/required_reader_version");
      expect(pinIssue?.message).toContain("1.4.0");
    }
  });

  it("requires the newest carried version when a transaction mixes 1.0-1.4 content", () => {
    const mixed = v14TransactionInput("ledger-op_t3_06");
    mixed.events.push(
      makeEvent(`event_10_${mixed.ledger_operation_id}`, mixed.ledger_operation_id, 2),
    );
    mixed.events.push({
      ...makeEvent(`event_13_${mixed.ledger_operation_id}`, mixed.ledger_operation_id, 3),
      protocol_version: PROTOCOL_1_3_VERSION,
      event_type: "TaskLeaseGranted",
    });
    expect(transactionRequiredReaderVersion(mixed)).toBe("1.4.0");
    expect(
      validateTransaction({ ...mixed, required_reader_version: "1.3.0" }).map(
        (i) => i.instancePath,
      ),
    ).toContain("/required_reader_version");
    expect(validateTransaction({ ...mixed, required_reader_version: "1.4.0" })).toEqual([]);
  });
});

describe("ApprovalDecided payload validation", () => {
  it("accepts a schema-valid six-field ApprovalDecided event at protocol 1.4.0", () => {
    const event = approvalDecidedEvent("event_t3_payload_01", "ledger-op_t3_payload", 1);
    expect(validateSchema("event", event)).toEqual({ valid: true, errors: [] });
  });

  it("rejects extra payload fields such as a raw actor", () => {
    const event = approvalDecidedEvent("event_t3_payload_02", "ledger-op_t3_payload", 1, {
      payload: approvalDecidedPayload({ actor: "principal_mallory" }),
    });
    const result = validateSchema("event", event);
    expect(result.valid).toBe(false);
    expect(result.errors.some((issue) => issue.instancePath.startsWith("/payload"))).toBe(true);
  });

  it("rejects a decision outside the approve/reject/defer enum", () => {
    const event = approvalDecidedEvent("event_t3_payload_03", "ledger-op_t3_payload", 1, {
      payload: approvalDecidedPayload({ decision: "yes" }),
    });
    expect(validateSchema("event", event).valid).toBe(false);
  });

  it("rejects a missing decision_digest and malformed digests", () => {
    const missing = approvalDecidedEvent("event_t3_payload_04", "ledger-op_t3_payload", 1, {
      payload: approvalDecidedPayload({ decision_digest: undefined }),
    });
    expect(validateSchema("event", missing).valid).toBe(false);

    const malformed = approvalDecidedEvent("event_t3_payload_05", "ledger-op_t3_payload", 1, {
      payload: approvalDecidedPayload({ object_digest: "not-a-digest" }),
    });
    expect(validateSchema("event", malformed).valid).toBe(false);
  });

  it("rejects an ApprovalDecided event written below protocol 1.4.0", () => {
    const event = approvalDecidedEvent("event_t3_payload_06", "ledger-op_t3_payload", 1, {
      protocol_version: "1.0.0",
    });
    const result = validateSchema("event", event);
    expect(result.valid).toBe(false);
    expect(result.errors.map((issue) => issue.instancePath)).toContain("/protocol_version");
  });

  it("leaves the payload tolerance of every other event type unchanged", () => {
    const legacy = makeEvent("event_t3_payload_07", "ledger-op_t3_payload", 1);
    legacy.payload = { anything: ["goes", 1, null] };
    expect(validateSchema("event", legacy)).toEqual({ valid: true, errors: [] });
  });
});

const RECORD_DIGEST = "c".repeat(64);

function artifactAvailablePayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    artifact_kind: "plan",
    record_digest: RECORD_DIGEST,
    summary: "执行计划 plan_t01 已生成",
    ...overrides,
  };
}

function artifactAvailableEventRecord(
  eventId: string,
  ledgerOperationId: string,
  sequence: number,
  overrides?: Record<string, unknown>,
) {
  return {
    ...makeEvent(eventId, ledgerOperationId, sequence),
    protocol_version: PROTOCOL_1_4_VERSION,
    event_type: "ArtifactAvailable",
    payload: artifactAvailablePayload(),
    ...overrides,
  };
}

describe("ArtifactAvailable payload validation (spec §9.3)", () => {
  it("accepts a schema-valid three-field ArtifactAvailable event at protocol 1.4.0", () => {
    const event = artifactAvailableEventRecord("event_t5_payload_01", "ledger-op_t5_payload", 1);
    expect(validateSchema("event", event)).toEqual({ valid: true, errors: [] });
  });

  it("pins a transaction carrying an ArtifactAvailable event to 1.4.0", () => {
    const input = makeInput("ledger-op_t5_01");
    input.events.push(artifactAvailableEventRecord("event_t5_01", "ledger-op_t5_01", 1));
    expect(transactionRequiredReaderVersion(input)).toBe("1.4.0");
  });

  it("rejects extra payload fields such as artifact content", () => {
    const event = artifactAvailableEventRecord("event_t5_payload_02", "ledger-op_t5_payload", 1, {
      payload: artifactAvailablePayload({ content: { raw: "全文" } }),
    });
    const result = validateSchema("event", event);
    expect(result.valid).toBe(false);
    expect(result.errors.some((issue) => issue.instancePath.startsWith("/payload"))).toBe(true);
  });

  it("rejects an artifact_kind outside the fixed enum", () => {
    const event = artifactAvailableEventRecord("event_t5_payload_03", "ledger-op_t5_payload", 1, {
      payload: artifactAvailablePayload({ artifact_kind: "raw_log" }),
    });
    expect(validateSchema("event", event).valid).toBe(false);
  });

  it("rejects a malformed record_digest and an over-long summary", () => {
    const malformed = artifactAvailableEventRecord(
      "event_t5_payload_04",
      "ledger-op_t5_payload",
      1,
      { payload: artifactAvailablePayload({ record_digest: "artifacts/plans/plan.json" }) },
    );
    expect(validateSchema("event", malformed).valid).toBe(false);

    const long = artifactAvailableEventRecord("event_t5_payload_05", "ledger-op_t5_payload", 1, {
      payload: artifactAvailablePayload({ summary: "长".repeat(201) }),
    });
    expect(validateSchema("event", long).valid).toBe(false);
  });

  it("rejects an ArtifactAvailable event written below protocol 1.4.0", () => {
    const event = artifactAvailableEventRecord("event_t5_payload_06", "ledger-op_t5_payload", 1, {
      protocol_version: "1.3.0",
    });
    const result = validateSchema("event", event);
    expect(result.valid).toBe(false);
    expect(result.errors.map((issue) => issue.instancePath)).toContain("/protocol_version");
  });
});

/**
 * Pre-1.4 writer contract, pinned as literal bytes instead of deriving from
 * the live EVENT_TYPES: an old writer only knows these event types and must
 * reject ApprovalDecided rather than silently accepting it.
 */
const FROZEN_1_3_EVENT_TYPES = [
  "OperationStarted",
  "PlanAccepted",
  "BeforeContextCompile",
  "ContextCompiled",
  "BeforeToolCall",
  "AfterToolCall",
  "ApprovalRequired",
  "CheckpointCommitted",
  "CheckpointInvalidated",
  "GateCompleted",
  "EvaluationCompleted",
  "FindingCreated",
  "FindingAccepted",
  "FindingClosed",
  "FindingSuperseded",
  "OperationCompleted",
  "TddCycleStarted",
  "TddBaselineAccepted",
  "TddTestPatchFrozen",
  "TddRedAccepted",
  "TddImplementationUnlocked",
  "TddGreenAccepted",
  "TddRefactorAccepted",
  "TddCycleCompleted",
  "TddCycleInvalidated",
  "RemoteConnected",
  "RemoteDisconnected",
  "RemoteApprovalMaterialized",
  "IntegrationAccepted",
  "TaskLeaseGranted",
  "TaskDispatched",
  "TaskIntegrationQueued",
  "TaskCandidateValidated",
  "TaskRetryScheduled",
  "WaveGateCompleted",
  "WaveIntegrated",
  "SchedulerRecovered",
] as const;

const FROZEN_1_3_EVENT_SCHEMA = strictObject({
  ...persistedRecordProperties("event"),
  event_id: IdentifierSchema,
  event_type: enumerated(FROZEN_1_3_EVENT_TYPES),
  project_id: IdentifierSchema,
  iteration_id: IdentifierSchema,
  workflow_operation_id: IdentifierSchema,
  ledger_operation_id: IdentifierSchema,
  sequence: Type.Integer({ minimum: 1 }),
  timestamp: TimestampSchema,
  payload: Type.Record(Type.String(), Type.Unknown()),
  extensions: Type.Optional(ExtensionsSchema),
});

describe("old writer and old reader contracts", () => {
  it("keeps the frozen pre-1.4 schema an exact prefix of the live vocabulary", () => {
    expect(FROZEN_1_3_EVENT_TYPES).toEqual(
      EVENT_TYPES.filter(
        (eventType) => eventType !== "ApprovalDecided" && eventType !== "ArtifactAvailable",
      ),
    );
  });

  it("a fixed pre-1.4 event schema rejects the 1.4 event types", () => {
    const frozen = compileAjvSchema(FROZEN_1_3_EVENT_SCHEMA);
    const event = approvalDecidedEvent("event_t3_frozen_01", "ledger-op_t3_frozen", 1);
    expect(frozen(event)).toBe(false);
    const available = artifactAvailableEventRecord("event_t3_frozen_03", "ledger-op_t3_frozen", 3);
    expect(frozen(available)).toBe(false);
    const legacy = makeEvent("event_t3_frozen_02", "ledger-op_t3_frozen", 2);
    expect(frozen(legacy)).toBe(true);
  });

  it("commits a 1.4 manifest, reads it back with the default reader and blocks an explicit 1.3 reader", async () => {
    const projectRoot = makeProjectRoot();
    const repository = new LedgerRepository({
      projectRoot,
      readBaseline: () => BASELINE,
      now: () => FIXED_NOW,
    });

    await expect(repository.commit(v14TransactionInput("ledger-op_t3_07"))).rejects.toBeInstanceOf(
      LedgerValidationError,
    );

    const committed = await repository.commit({
      ...v14TransactionInput("ledger-op_t3_07"),
      required_reader_version: "1.4.0",
    });
    expect(committed.status).toBe("committed");
    expect(committed.manifest.required_reader_version).toBe("1.4.0");

    // Restart read: a fresh repository with the runtime default reader opens
    // the 1.4 transaction without an explicit version override.
    const restarted = new LedgerRepository({ projectRoot, readBaseline: () => BASELINE });
    expect(() => restarted.operations()).not.toThrow();
    expect(() => readCommittedOperations(restarted.harnessRoot)).not.toThrow();

    const staleRead = () =>
      readCommittedOperations(restarted.harnessRoot, { readerVersion: PROTOCOL_1_3_VERSION });
    expect(staleRead).toThrow(ProtocolProjectionError);
    expect(staleRead).toThrow(/protocol_upgrade_required/);
  });

  it("replays committed 1.0-1.4 records together with the default reader", async () => {
    const projectRoot = makeProjectRoot();
    const repository = new LedgerRepository({
      projectRoot,
      readBaseline: () => BASELINE,
      now: () => FIXED_NOW,
    });
    await repository.commit(makeInput("ledger-op_t3_08_legacy"));
    await repository.commit({
      ...v14TransactionInput("ledger-op_t3_08_v14"),
      required_reader_version: "1.4.0",
    });

    const replayed = new LedgerRepository({ projectRoot, readBaseline: () => BASELINE }).replay();
    expect(replayed.operations.map((operation) => operation.manifest.ledger_operation_id)).toEqual([
      "ledger-op_t3_08_legacy",
      "ledger-op_t3_08_v14",
    ]);
    const decided = replayed.events.filter((event) => event.event_type === "ApprovalDecided");
    expect(decided).toHaveLength(1);
    expect(decided[0]?.payload).toEqual(approvalDecidedPayload());
  });
});
