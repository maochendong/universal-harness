import { describe, expect, it } from "vitest";

import {
  PROTOCOL_1_1_SCHEMA_REGISTRY,
  TDD_VERDICT_STATES,
  TDD_VERDICT_TO_GENERIC,
  sealRecordEnvelope,
} from "../../src/schema/index.js";

const validateCycle = (value: unknown) => PROTOCOL_1_1_SCHEMA_REGISTRY.validate("tdd-cycle", value);

/**
 * T16 TDD domain schemas (provable TDD design 9.4/13): the cycle record's
 * field completeness follows its terminal status — completed requires the
 * full Baseline/Red/Green chain, blocked/invalidated carry a reason and
 * never fabricate later evidence.
 */
const digest = (letter: string) => letter.repeat(64);

function goldenCycle() {
  return {
    logical_cycle_id: "cycle_01K1CY1",
    attempt_ordinal: 1,
    task_id: "task_01K1T01",
    assertion_ids: ["criterion-assertion_01K1AS1"],
    contract_digest: digest("9"),
    repository_baseline: "deadbeef",
    baseline_evidence_digest: digest("1"),
    test_patch_digest: digest("2"),
    target_gate_binding_digest: digest("3"),
    executor_environment_digest: digest("4"),
    red_evidence_digest: digest("5"),
    green_evidence_digest: digest("6"),
    implementation_revision: "cafe01",
    status: "completed",
  };
}

describe("tdd cycle record schema", () => {
  it("accepts a fully bound completed cycle", () => {
    const record = sealRecordEnvelope({
      protocol_version: "1.1.0",
      record_kind: "tdd_cycle",
      ...goldenCycle(),
    });
    expect(validateCycle(record).valid).toBe(true);
  });

  it("rejects a completed cycle missing the Red/Green chain", () => {
    const incompleteContent = goldenCycle() as Record<string, unknown>;
    delete incompleteContent.red_evidence_digest;
    delete incompleteContent.green_evidence_digest;
    const incomplete = sealRecordEnvelope({
      protocol_version: "1.1.0",
      record_kind: "tdd_cycle",
      ...incompleteContent,
    });
    expect(validateCycle(incomplete).valid).toBe(false);
  });

  it("requires a structured reason for blocked or invalidated cycles", () => {
    const blocked = {
      protocol_version: "1.1.0",
      record_kind: "tdd_cycle",
      logical_cycle_id: "cycle_01K1CY1",
      attempt_ordinal: 2,
      task_id: "task_01K1T01",
      assertion_ids: ["criterion-assertion_01K1AS1"],
      contract_digest: digest("9"),
      repository_baseline: "deadbeef",
      baseline_evidence_digest: digest("1"),
      status: "blocked",
      reason: "baseline gate failed: pre_existing_failure",
    };
    const sealed = sealRecordEnvelope(blocked);
    expect(validateCycle(sealed).valid).toBe(true);

    const reasonlessContent = { ...blocked } as Record<string, unknown>;
    delete reasonlessContent.reason;
    const reasonless = sealRecordEnvelope(reasonlessContent);
    expect(validateCycle(reasonless).valid).toBe(false);
  });

  it("maps the six domain verdicts onto the slim generic five", () => {
    expect(TDD_VERDICT_STATES).toHaveLength(6);
    expect(TDD_VERDICT_TO_GENERIC.tdd_proven).toBe("proven");
    expect(TDD_VERDICT_TO_GENERIC.framework_proven).toBe("proven");
    expect(TDD_VERDICT_TO_GENERIC.historical_without_tdd_proof).toBe("historical_without_proof");
    expect(TDD_VERDICT_TO_GENERIC.tdd_incomplete_or_invalid).toBe("invalid_or_incomplete");
    for (const state of TDD_VERDICT_STATES) {
      expect([
        "proven",
        "controlled_not_applicable",
        "not_enabled_by_profile",
        "historical_without_proof",
        "invalid_or_incomplete",
      ]).toContain(TDD_VERDICT_TO_GENERIC[state]);
    }
  });
});
