import { describe, expect, it } from "vitest";

import {
  PROTOCOL_1_1_SCHEMA_REGISTRY,
  verifyRecordEnvelope,
  type ImpactAdvisoryOutput,
} from "@universal-harness-internal/core";

import { createImpactAdvisoryRecord } from "../../src/impact/advisory-record.js";
import { RELATION_RULE_REGISTRY } from "../../src/impact/advisory.js";

/** PG-3 record contract: sealed, schema-valid and deterministically identified. */
function output(): ImpactAdvisoryOutput {
  return {
    purpose: "impact_advisory",
    schema_version: "impact-advisory.v1",
    impact_set_digest: "a".repeat(64),
    additions: [],
    edge_candidates: [],
    risk_signals: [],
    missing_facts: [],
    questions: [],
  };
}

function input() {
  return {
    workflow_operation_id: "operation_01K1ABC",
    iteration_id: "iteration_01K1ABC",
    impact_set_digest: "a".repeat(64),
    binding_digest: "b".repeat(64),
    conversation_id: "conversation_01K1ABC",
    run_id: "run_01K1ABC",
    input_digest: "c".repeat(64),
    output: output(),
  };
}

describe("createImpactAdvisoryRecord", () => {
  it("seals a schema-valid record with a deterministic id", () => {
    const first = createImpactAdvisoryRecord(input());
    const second = createImpactAdvisoryRecord(input());
    expect(first.impact_advisory_id).toBe(second.impact_advisory_id);
    expect(first.impact_advisory_id.startsWith("impact-advisory_")).toBe(true);
    expect(verifyRecordEnvelope(first)).toBe(true);
    expect(PROTOCOL_1_1_SCHEMA_REGISTRY.validate("impact-advisory", first).valid).toBe(true);
  });

  it("pins the shipped relation rule registry version and digest", () => {
    const record = createImpactAdvisoryRecord(input());
    expect(record.relation_rule_registry_version).toBe(RELATION_RULE_REGISTRY.version);
    expect(record.relation_rule_registry_digest).toBe(RELATION_RULE_REGISTRY.digest);
  });

  it("changes identity when the advised output changes", () => {
    const base = createImpactAdvisoryRecord(input());
    const other = createImpactAdvisoryRecord({
      ...input(),
      output: { ...output(), questions: [{ question: "is the audit log in scope?" }] },
    });
    expect(other.impact_advisory_id).not.toBe(base.impact_advisory_id);
  });

  it("fails closed on an output that cannot validate", () => {
    expect(() =>
      createImpactAdvisoryRecord({
        ...input(),
        output: { ...output(), impact_set_digest: "not-a-digest" },
      }),
    ).toThrowError(/invalid impact advisory record/);
  });
});
