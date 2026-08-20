import { describe, expect, it } from "vitest";

import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../../src/schema/index.js";

/**
 * T13 TaskTddContract / AssertionCluster schemas (provable TDD design 7.2):
 * the contract binds the accepted PRD, requirement baseline, impact set,
 * design set, capability plan, plan and test strategy digests plus the
 * assertion clusters; a required task carries exactly one cluster, the
 * controlled not_applicable and framework_bootstrap modes carry none and
 * must prove their binding/profile.
 */
const digest = (letter: string) => letter.repeat(64);

const validateContract = (value: unknown) =>
  PROTOCOL_1_1_SCHEMA_REGISTRY.validate("task-tdd-contract", value);

function goldenCluster() {
  return {
    cluster_id: "assertion-cluster_01K1C01",
    logical_cycle_id: "cycle_01K1CY1",
    requirement_ids: ["requirement_01K1REQ"],
    acceptance_criterion_ids: ["criterion_01K1AC1"],
    assertion_ids: ["criterion-assertion_01K1AS1"],
    test_node_ids: ["test_01K1T01"],
    target_gate_id: "gate_target",
    target_test_selectors: ["tests/items.test.ts"],
    baseline_guard_gate_ids: ["gate_baseline"],
    failure_oracle: {
      selector_ids: ["tests/items.test.ts"],
      allowed_failure_kinds: ["assertion_failure"],
      assertion_ids: ["criterion-assertion_01K1AS1"],
    },
    path_policy: {
      test: ["tests/**"],
      test_config: ["vitest.config.ts"],
      production: ["src/**"],
      immutable: ["migrations/**"],
    },
    framework_profile_digest: digest("f"),
    refactor_policy: "planned",
  };
}

function goldenContract() {
  return {
    contract_id: "task-tdd-contract_01K1K01",
    task_id: "task_01K1T01",
    contract_mode: "required",
    accepted_prd_digest: digest("a"),
    requirement_baseline_digest: digest("b"),
    impact_set_digest: digest("1"),
    design_set_digest: digest("d"),
    capability_plan_digest: digest("c"),
    test_strategy_asset_id: "designartifact_01K1TST",
    test_strategy_digest: digest("e"),
    plan_digest: digest("3"),
    assertion_clusters: [goldenCluster()],
    phase_budgets: {
      test_authoring: { max_runs: 3, max_duration_ms: 600000 },
      implementation: { max_runs: 5, max_duration_ms: 1200000 },
    },
    contract_digest: digest("9"),
  };
}

describe("task tdd contract schema", () => {
  it("accepts the golden required contract", () => {
    expect(validateContract(goldenContract()).valid).toBe(true);
  });

  it("rejects unknown modes, empty clusters on required and stray fields", () => {
    const badMode = { ...goldenContract(), contract_mode: "optional" };
    expect(validateContract(badMode).valid).toBe(false);

    const extra = { ...goldenContract(), unexpected: true };
    expect(validateContract(extra).valid).toBe(false);

    const badOracle = goldenContract();
    (
      badOracle.assertion_clusters[0].failure_oracle as Record<string, unknown>
    ).allowed_failure_kinds = ["syntax_error"];
    expect(validateContract(badOracle).valid).toBe(false);
  });

  it("binds not_applicable to a controlled category and non-empty reason", () => {
    const applicable = {
      ...goldenContract(),
      contract_mode: "not_applicable",
      assertion_clusters: [],
      not_applicable_binding: { category: "documentation_only", reason: "docs only" },
    };
    expect(validateContract(applicable).valid).toBe(true);

    const reasonless = {
      ...applicable,
      not_applicable_binding: { category: "documentation_only", reason: "" },
    };
    expect(validateContract(reasonless).valid).toBe(false);

    const badCategory = {
      ...applicable,
      not_applicable_binding: { category: "trivial", reason: "x" },
    };
    expect(validateContract(badCategory).valid).toBe(false);
  });

  it("binds framework_bootstrap to its profile", () => {
    const bootstrap = {
      ...goldenContract(),
      contract_mode: "framework_bootstrap",
      assertion_clusters: [],
      framework_bootstrap_profile: {
        framework_profile_id: "framework_vitest",
        discovery_gate_id: "gate_discovery",
        pass_fixture_id: "fixture_pass",
        fail_fixture_id: "fixture_fail",
        expected_failure_kind: "assertion_failure",
        test_write_paths: ["tests/**"],
        test_config_write_paths: ["vitest.config.ts"],
      },
    };
    expect(validateContract(bootstrap).valid).toBe(true);

    const profileless = { ...bootstrap };
    delete (profileless as Record<string, unknown>).framework_bootstrap_profile;
    expect(validateContract(profileless).valid).toBe(false);
  });
});
