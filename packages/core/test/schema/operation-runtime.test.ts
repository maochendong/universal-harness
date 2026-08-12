import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  OPERATION_STATES,
  iterationStateForOperation,
  validateRunRecordStream,
  validateSchema,
} from "../../src/schema/index.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const goldenDirectory = join(testDirectory, "../golden/schema");

function readGolden<T>(name: string): T {
  return JSON.parse(readFileSync(join(goldenDirectory, name), "utf8")) as T;
}

describe("operation and runtime contracts", () => {
  it("keeps the operation to iteration state mapping stable", () => {
    const actual = Object.fromEntries(
      OPERATION_STATES.map((state) => [state, iterationStateForOperation(state)]),
    );
    expect(actual).toEqual(readGolden("operation-state-map.json"));
  });

  it("requires resume_state only for blocked workflow operations", () => {
    const base = {
      protocol_version: "1.0.0",
      record_kind: "workflow_operation",
      workflow_operation_id: "workflow_01K1ABCDEFGHIJKLMNOPQ",
      attempt_id: "attempt_01K1ABCDEFGHIJKLMNOPQRST",
      iteration_id: "iteration_01K1ABCDEFGHIJKLMNO",
      updated_at: "2026-08-12T00:00:00.000Z",
    };

    expect(
      validateSchema("workflow-operation", {
        ...base,
        state: "blocked",
        resume_state: "awaiting_approval",
      }),
    ).toMatchObject({ valid: true });
    expect(validateSchema("workflow-operation", { ...base, state: "blocked" })).toMatchObject({
      valid: false,
    });
    expect(
      validateSchema("workflow-operation", {
        ...base,
        state: "running",
        resume_state: "running",
      }),
    ).toMatchObject({ valid: false });
  });

  it("accepts one start and one terminal record and rejects malformed streams", () => {
    const records = readGolden<unknown[]>("run-record-stream.json");
    for (const record of records) {
      expect(validateSchema("runtime", record)).toMatchObject({ valid: true });
    }
    expect(validateRunRecordStream(records)).toEqual({ valid: true, errors: [] });
    expect(validateRunRecordStream([...records, records.at(-1)])).toMatchObject({ valid: false });
    expect(validateRunRecordStream(records.slice(1))).toMatchObject({ valid: false });
  });

  it("accepts interrupted terminal records and rejects duplicate or inconsistent streams", () => {
    const records = readGolden<Record<string, unknown>[]>("run-record-stream.json");
    const interrupted = [
      records[0],
      {
        ...records[2],
        record_kind: "run_interrupted",
        outcome: "partial",
        termination_reason: "process_interruption",
        partial_evidence_ids: ["evidence_01K1ABCDEFGHIJKLMNO"],
      },
    ];
    expect(validateRunRecordStream(interrupted)).toEqual({ valid: true, errors: [] });
    expect(validateRunRecordStream([...interrupted, interrupted[1]])).toMatchObject({
      valid: false,
    });
    expect(
      validateRunRecordStream([
        records[0],
        { ...records[1], run_id: "run_01K1DIFFERENTIDENTIFIER" },
        records[2],
      ]),
    ).toMatchObject({ valid: false });
  });

  it("validates context, checkpoint and evidence runtime records", () => {
    const records = [
      {
        protocol_version: "1.0.0",
        record_kind: "context_bundle",
        context_bundle_id: "context_01K1ABCDEFGHIJKLMNOPQRS",
        task_id: "task_01K1ABCDEFGHIJKLMNOPQRSTU",
        source_digests: ["1".repeat(64)],
        digest: "2".repeat(64),
        stale: false,
      },
      {
        protocol_version: "1.0.0",
        record_kind: "checkpoint",
        checkpoint_id: "checkpoint_01K1ABCDEFGHIJKLMNO",
        workflow_operation_id: "workflow_01K1ABCDEFGHIJKLMNOPQ",
        attempt_id: "attempt_01K1ABCDEFGHIJKLMNOPQRST",
        phase: "planning",
        state_digest: "3".repeat(64),
        timestamp: "2026-08-12T00:00:00.000Z",
      },
      {
        protocol_version: "1.0.0",
        record_kind: "evidence",
        evidence_id: "evidence_01K1ABCDEFGHIJKLMNO",
        evidence_type: "test_result",
        subject_id: "requirement_01K1ABCDEFGHIJKLMN",
        digest: "4".repeat(64),
        provisional: true,
        created_at: "2026-08-12T00:00:00.000Z",
      },
    ];
    for (const record of records) {
      expect(validateSchema("runtime", record), record.record_kind).toMatchObject({ valid: true });
    }
  });

  it("validates ledger operation identity and immutable shard paths", () => {
    const operation = {
      protocol_version: "1.0.0",
      record_kind: "ledger_operation",
      ledger_operation_id: "ledger_01K1ABCDEFGHIJKLMNOPQRST",
      workflow_operation_id: "workflow_01K1ABCDEFGHIJKLMNOPQ",
      attempt_id: "attempt_01K1ABCDEFGHIJKLMNOPQRST",
      baseline_commit: "abcdef1234567",
      sequence: 1,
      artifact_digests: ["b".repeat(64)],
      edge_file: "ledger/edges/2026-08/ledger_01.jsonl",
      event_file: "events/2026-08/ledger_01.jsonl",
      committed_at: "2026-08-12T00:00:00.000Z",
      digest: "c".repeat(64),
    };
    expect(validateSchema("ledger-operation", operation)).toMatchObject({ valid: true });
    expect(
      validateSchema("ledger-operation", { ...operation, edge_file: "ledger/edges.jsonl" }),
    ).toMatchObject({ valid: false });
  });

  it("validates digest-bound approval requests and explicit decisions", () => {
    const request = {
      protocol_version: "1.0.0",
      record_kind: "approval_request",
      request_id: "approval-request_01K1ABCDEFGHIJK",
      workflow_operation_id: "workflow_01K1ABCDEFGHIJKLMNOPQ",
      object_id: "requirement_01K1ABCDEFGHIJKLMN",
      object_type: "Requirement",
      object_digest: "d".repeat(64),
      baseline_digest: "e".repeat(64),
      policy_digest: "f".repeat(64),
      preview_digest: "a".repeat(64),
      impact_path: [],
      risk: "medium",
      reason: "approve requirement baseline",
      allowed_decisions: ["approve", "reject", "defer"],
      created_at: "2026-08-12T00:00:00.000Z",
      resume_phase: "requirements",
    };
    expect(validateSchema("runtime", request)).toMatchObject({ valid: true });
    expect(validateSchema("runtime", { ...request, preview_digest: undefined })).toMatchObject({
      valid: false,
    });
    expect(
      validateSchema("runtime", {
        protocol_version: "1.0.0",
        record_kind: "approval_decision",
        approval_id: "approval_01K1ABCDEFGHIJKLMNO",
        request_id: request.request_id,
        actor: "human:reviewer",
        decision: "defer",
        object_digest: request.object_digest,
        decided_at: "2026-08-12T00:00:01.000Z",
      }),
    ).toMatchObject({ valid: true });
  });
});
