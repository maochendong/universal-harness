import { describe, expect, it } from "vitest";

import { TDD_VERDICT_TO_GENERIC, type TddCycleRecord } from "../../../core/src/index.js";

import { computeTaskTddVerdict } from "../../src/tdd/verdict.js";

/**
 * T16 TaskVerdict (provable TDD design 13): the six domain states are
 * mechanically distinguished — a completed cycle chain proves only
 * `tdd_proven` when gates and evaluation also pass; controlled
 * not_applicable, framework bootstrap, profile-disabled and historical
 * records never masquerade as proof.
 */
const digest = (letter: string) => letter.repeat(64);
const ASSERTION = "criterion-assertion_01K1AS1";

function completedCycle(overrides: Partial<TddCycleRecord> = {}): TddCycleRecord {
  return {
    protocol_version: "1.1.0",
    record_kind: "tdd_cycle",
    logical_cycle_id: "cycle_01K1CY1",
    attempt_ordinal: 1,
    task_id: "task_01",
    assertion_ids: [ASSERTION],
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
    record_digest: digest("7"),
    ...overrides,
  } as TddCycleRecord;
}

function baseInput() {
  return {
    capability_enabled: true,
    contract_mode: "required" as const,
    required_assertion_ids: [ASSERTION],
    cycles: [completedCycle()],
    current_contract_digest: digest("9"),
    gates_passed: true,
  };
}

describe("computeTaskTddVerdict", () => {
  it("proves tdd_proven only with a valid completed cycle plus gates and evaluation", () => {
    const verdict = computeTaskTddVerdict(baseInput());
    expect(verdict.verdict).toBe("tdd_proven");
    expect(verdict.generic_status).toBe(TDD_VERDICT_TO_GENERIC.tdd_proven);
  });

  it("fails the verdict when the full gate or evaluation fails despite Green", () => {
    expect(computeTaskTddVerdict({ ...baseInput(), gates_passed: false }).verdict).toBe(
      "tdd_incomplete_or_invalid",
    );
    expect(computeTaskTddVerdict({ ...baseInput(), evaluation_passed: false }).verdict).toBe(
      "tdd_incomplete_or_invalid",
    );
  });

  it("fails on missing, drifted or invalidated cycles", () => {
    expect(computeTaskTddVerdict({ ...baseInput(), cycles: [] }).verdict).toBe(
      "tdd_incomplete_or_invalid",
    );
    expect(
      computeTaskTddVerdict({
        ...baseInput(),
        cycles: [completedCycle({ contract_digest: digest("8") })],
      }).verdict,
    ).toBe("tdd_incomplete_or_invalid");
    expect(
      computeTaskTddVerdict({
        ...baseInput(),
        cycles: [completedCycle({ status: "invalidated", reason: "patch drift" })],
      }).verdict,
    ).toBe("tdd_incomplete_or_invalid");
  });

  it("distinguishes the non-proof states", () => {
    expect(computeTaskTddVerdict({ ...baseInput(), capability_enabled: false }).verdict).toBe(
      "not_enabled_by_profile",
    );
    expect(computeTaskTddVerdict({ ...baseInput(), historical: true }).verdict).toBe(
      "historical_without_tdd_proof",
    );
    expect(
      computeTaskTddVerdict({
        ...baseInput(),
        contract_mode: "not_applicable",
        cycles: [],
        not_applicable_binding: { category: "documentation_only", reason: "docs only" },
      }).verdict,
    ).toBe("controlled_not_applicable");
    // not_applicable without the controlled binding is invalid, not proven.
    expect(
      computeTaskTddVerdict({ ...baseInput(), contract_mode: "not_applicable", cycles: [] })
        .verdict,
    ).toBe("tdd_incomplete_or_invalid");
    expect(
      computeTaskTddVerdict({
        ...baseInput(),
        contract_mode: "framework_bootstrap",
        cycles: [],
        framework_evidence: { accepted: true, discovery_proven: true },
      }).verdict,
    ).toBe("framework_proven");
    expect(
      computeTaskTddVerdict({
        ...baseInput(),
        contract_mode: "framework_bootstrap",
        cycles: [],
        framework_evidence: { accepted: true, discovery_proven: false },
      }).verdict,
    ).toBe("tdd_incomplete_or_invalid");
  });

  it("requires accepted refactor evidence when the policy plans a refactor", () => {
    expect(
      computeTaskTddVerdict({
        ...baseInput(),
        refactor_policy: "planned",
        cycles: [completedCycle({ refactor_evidence_digest: digest("a") })],
      }).verdict,
    ).toBe("tdd_proven");
    expect(computeTaskTddVerdict({ ...baseInput(), refactor_policy: "planned" }).verdict).toBe(
      "tdd_incomplete_or_invalid",
    );
  });
});
