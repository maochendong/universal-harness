import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TransactionInput } from "../../src/ledger/transaction.js";
import type { EdgeRecord } from "../../src/schema/edge.js";
import type { LifecycleEvent } from "../../src/schema/event.js";

export const FIXED_NOW = "2026-08-12T00:00:00.000Z";
export const FIXED_MONTH = "2026-08";
export const BASELINE = "0123456789abcdef";

export function makeProjectRoot(): string {
  return mkdtempSync(join(tmpdir(), "harness-ledger-"));
}

export function makeEdge(id: string): EdgeRecord {
  return {
    protocol_version: "1.0.0",
    record_kind: "edge",
    id,
    type: "CONTAINS",
    source_id: "project_01",
    target_id: "requirement_01",
    status: "accepted",
    source: "workflow",
    provenance: { iteration_id: "iteration_01", actor: "ledger-test", timestamp: FIXED_NOW },
    confidence: 1,
    digest: "a".repeat(64),
  } as EdgeRecord;
}

export function makeEvent(
  eventId: string,
  ledgerOperationId: string,
  sequence: number,
): LifecycleEvent {
  return {
    protocol_version: "1.0.0",
    record_kind: "event",
    event_id: eventId,
    event_type: "OperationStarted",
    project_id: "project_01",
    iteration_id: "iteration_01",
    workflow_operation_id: "workflow-op_01",
    ledger_operation_id: ledgerOperationId,
    sequence,
    timestamp: FIXED_NOW,
    payload: {},
  } as LifecycleEvent;
}

export function makeInput(
  ledgerOperationId: string,
  overrides?: Partial<TransactionInput>,
): TransactionInput {
  return {
    ledger_operation_id: ledgerOperationId,
    workflow_operation_id: "workflow-op_01",
    attempt_id: "attempt_01",
    expected_baseline: BASELINE,
    artifacts: [{ path: "nodes/decisions/decision_01.json", content: '{"decision":"keep"}\n' }],
    edges: [makeEdge(`edge_${ledgerOperationId}`)],
    events: [makeEvent(`event_${ledgerOperationId}`, ledgerOperationId, 1)],
    ...overrides,
  };
}
