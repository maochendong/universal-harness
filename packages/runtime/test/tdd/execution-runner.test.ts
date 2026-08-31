import { contentDigest, type TaskTddContract } from "@universal-harness-internal/core";
import { describe, expect, it } from "vitest";

import { mergePolicyLayers } from "../../src/policy/evaluator.js";
import {
  createInMemoryTddEvidenceStore,
  createStrictTddExecutionRunner,
} from "../../src/tdd/execution-runner.js";
import { createInMemoryWorkspacePort } from "../../src/tdd/workspace.js";
import type { TaskSpecification } from "../../src/planning/task.js";
import { field, layer } from "../policy/fixtures.js";

const digest = (letter: string): string => letter.repeat(64);
const ASSERTION = "criterion-assertion_01K1AS1";

const task: TaskSpecification = {
  id: "task_01",
  objective: "implement item lookup",
  impact_paths: [],
  expected_outputs: ["component_items"],
  capabilities: [],
  tools: [],
  dependencies: [],
  risk: "low",
  budget: { steps: 20, tokens: 2_000 },
  acceptance: [{ description: "returns the item", verification: "target gate" }],
  assertions: [
    {
      assertion_id: ASSERTION,
      test_ids: ["test_items"],
      required_gate_ids: ["gate_items"],
      evidence_requirements: ["gate_evidence"],
    },
  ],
  required_gates: ["gate_items"],
};

function contract(overrides: Partial<TaskTddContract> = {}): TaskTddContract {
  return {
    contract_id: "tdd-contract_01",
    task_id: task.id,
    contract_mode: "required",
    accepted_prd_digest: digest("1"),
    requirement_baseline_digest: digest("2"),
    impact_set_digest: digest("3"),
    design_set_digest: digest("4"),
    capability_plan_digest: digest("5"),
    test_strategy_asset_id: "design-artifact_tests",
    test_strategy_digest: digest("6"),
    plan_digest: digest("7"),
    assertion_clusters: [
      {
        cluster_id: "assertion-cluster_01",
        logical_cycle_id: "tdd-cycle_01",
        requirement_ids: ["requirement_01"],
        acceptance_criterion_ids: ["criterion_01"],
        assertion_ids: [ASSERTION],
        test_node_ids: ["test_items"],
        target_gate_id: "gate_items",
        target_test_selectors: ["tests/items.test.ts"],
        baseline_guard_gate_ids: ["gate_items"],
        failure_oracle: {
          selector_ids: ["tests/items.test.ts"],
          allowed_failure_kinds: ["assertion_failure"],
          assertion_ids: [ASSERTION],
        },
        path_policy: {
          test: ["tests/**"],
          test_config: ["vitest.config.ts"],
          production: ["src/**"],
          immutable: [".harness/**"],
        },
        framework_profile_digest: digest("8"),
        refactor_policy: "not_planned",
      },
    ],
    phase_budgets: {
      test_authoring: { max_runs: 2, max_duration_ms: 2_000, max_steps: 10, max_tokens: 1_000 },
      implementation: { max_runs: 2, max_duration_ms: 2_000, max_steps: 10, max_tokens: 1_000 },
    },
    contract_digest: digest("9"),
    ...overrides,
  } as TaskTddContract;
}

function effectivePolicy() {
  return mergePolicyLayers([
    layer("project", [
      field("paths.write.allow", "allow_intersection", ["src", "tests", "vitest.config.ts"]),
      field("paths.read.allow", "allow_intersection", ["src", "tests", "vitest.config.ts"]),
    ]),
  ]).effective;
}

function gateObservation(phase: "baseline" | "red" | "green" | "refactor", validRed = true) {
  const failed = phase === "red";
  return {
    result: {
      outcome: "structured" as const,
      runs: [
        {
          selector_id: "tests/items.test.ts",
          status: failed ? ("failed" as const) : ("passed" as const),
          assertion_id: validRed ? ASSERTION : "criterion-assertion_other",
          ...(failed ? { failure_kind: "assertion_failure" } : {}),
        },
      ],
    },
    target_gate_binding_digest: digest("a"),
    framework_profile_digest: digest("8"),
    executor_environment_digest: digest("b"),
    output_artifact: {
      locator: `artifacts/tdd/${phase}.json`,
      digest: contentDigest({ phase, failed }),
    },
  };
}

function harness(
  options: { readonly invalidRed?: boolean; readonly productionTestWrite?: boolean } = {},
) {
  const evidence = createInMemoryTddEvidenceStore();
  const implementationCalls: string[] = [];
  const grants: { phase: string; write_paths: readonly string[] }[] = [];
  const runner = createStrictTddExecutionRunner({
    workspace: createInMemoryWorkspacePort(
      {
        "src/items.ts": "export const lookup = () => undefined;",
        "tests/items.test.ts": "",
        "vitest.config.ts": "export default {};",
      },
      { baseline_commit: "deadbeef" },
    ),
    evidence,
    effectivePolicy: effectivePolicy(),
    readBaseline: () => "deadbeef",
    gate: {
      run(input) {
        grants.push({ phase: input.grant.phase, write_paths: input.grant.write_paths });
        return Promise.resolve(gateObservation(input.phase, options.invalidRed !== true));
      },
    },
    executor: {
      authorTests(input) {
        grants.push({ phase: input.grant.phase, write_paths: input.grant.write_paths });
        return Promise.resolve({
          files: [
            {
              path: options.productionTestWrite === true ? "src/items.ts" : "tests/items.test.ts",
              content: "expect(lookup()).toBeDefined();",
            },
          ],
        });
      },
      implement(input) {
        implementationCalls.push(input.grant.digest);
        grants.push({ phase: input.grant.phase, write_paths: input.grant.write_paths });
        return Promise.resolve({
          files: [{ path: "src/items.ts", content: "export const lookup = () => ({ id: 1 });" }],
          implementation_revision: "cafe01",
        });
      },
    },
  });
  return { runner, evidence, implementationCalls, grants };
}

describe("StrictTddExecutionPort", () => {
  it("runs an isolated Baseline -> Red -> Green chain under phase-specific grants", async () => {
    const fixture = harness();
    const outcome = await fixture.runner.runTask({
      task,
      contract: contract(),
      capability_plan_digest: digest("5"),
    });

    expect(outcome.status).toBe("completed");
    expect(fixture.implementationCalls).toHaveLength(1);
    expect(fixture.grants.map((grant) => grant.phase)).toEqual([
      "baseline_guard",
      "test_authoring",
      "red_verification",
      "implementation",
      "implementation",
    ]);
    expect(fixture.grants.find((grant) => grant.phase === "test_authoring")?.write_paths).toEqual([
      "tests/**",
      "vitest.config.ts",
    ]);
    expect(fixture.grants.find((grant) => grant.phase === "implementation")?.write_paths).toEqual([
      "src/**",
    ]);
    expect(fixture.evidence.evidence.map((entry) => entry.evidence_type)).toEqual([
      "baseline_test_result",
      "red_test_result",
      "green_test_result",
    ]);
    expect(fixture.evidence.cycles[0]).toMatchObject({
      attempt_ordinal: 1,
      status: "completed",
      test_patch_digest: expect.any(String),
      red_evidence_digest: expect.any(String),
      green_evidence_digest: expect.any(String),
    });
  });

  it("never invokes the production executor before a target Assertion and Oracle prove Red", async () => {
    const fixture = harness({ invalidRed: true });
    const outcome = await fixture.runner.runTask({
      task,
      contract: contract(),
      capability_plan_digest: digest("5"),
    });

    expect(outcome.status).toBe("blocked");
    expect(outcome.tdd_verdict).toBe("tdd_incomplete_or_invalid");
    expect(fixture.implementationCalls).toEqual([]);
    expect(fixture.evidence.evidence.map((entry) => entry.evidence_type)).toEqual([
      "baseline_test_result",
    ]);
  });

  it("rejects a test-authoring production write and preserves immutable attempt history", async () => {
    const fixture = harness({ productionTestWrite: true });
    const first = await fixture.runner.runTask({
      task,
      contract: contract(),
      capability_plan_digest: digest("5"),
    });
    const second = await fixture.runner.runTask({
      task,
      contract: contract(),
      capability_plan_digest: digest("5"),
    });

    expect(first.status).toBe("blocked");
    expect(second.status).toBe("blocked");
    expect(fixture.implementationCalls).toEqual([]);
    expect(fixture.evidence.cycles.map((entry) => entry.attempt_ordinal)).toEqual([1, 2]);
    expect(fixture.evidence.cycles.every((entry) => entry.status === "blocked")).toBe(true);
  });
});

/**
 * M4 plan Task 7 step 4 (design 12): when a Protocol 1.3 task declares
 * write_paths, every writing phase runs under the true path-scope
 * intersection Task.write_paths ∩ phase policy scopes ∩ phase grant —
 * an empty intersection blocks before execution, and writes outside the
 * intersection are write-set violations.
 */
function p13Harness(spec: TaskSpecification, implementPath = "src/items.ts") {
  const evidence = createInMemoryTddEvidenceStore();
  const calls: string[] = [];
  const runner = createStrictTddExecutionRunner({
    workspace: createInMemoryWorkspacePort(
      {
        "src/items.ts": "export const lookup = () => undefined;",
        "tests/items.test.ts": "",
        "vitest.config.ts": "export default {};",
      },
      { baseline_commit: "deadbeef" },
    ),
    evidence,
    effectivePolicy: effectivePolicy(),
    readBaseline: () => "deadbeef",
    gate: {
      run(input) {
        return Promise.resolve(gateObservation(input.phase));
      },
    },
    executor: {
      authorTests() {
        calls.push("authorTests");
        return Promise.resolve({
          files: [{ path: "tests/items.test.ts", content: "expect(lookup()).toBeDefined();" }],
        });
      },
      implement() {
        calls.push("implement");
        return Promise.resolve({
          files: [{ path: implementPath, content: "export const lookup = () => ({ id: 1 });" }],
          implementation_revision: "cafe01",
        });
      },
    },
  });
  return { runner, evidence, calls };
}

function p13Task(writePaths: readonly string[]): TaskSpecification {
  return { ...task, write_paths: writePaths };
}

describe("Protocol 1.3 write-scope intersection", () => {
  it("completes when every phase write stays inside the intersection", async () => {
    const fixture = p13Harness(
      p13Task(["src/items.ts", "tests/items.test.ts", "vitest.config.ts"]),
    );
    const outcome = await fixture.runner.runTask({
      task: p13Task(["src/items.ts", "tests/items.test.ts", "vitest.config.ts"]),
      contract: contract(),
      capability_plan_digest: digest("5"),
    });
    expect(outcome.status).toBe("completed");
    expect(fixture.calls).toEqual(["authorTests", "implement"]);
  });

  it("blocks before execution when the test-authoring intersection is empty", async () => {
    const spec = p13Task(["src"]);
    const fixture = p13Harness(spec);
    const outcome = await fixture.runner.runTask({
      task: spec,
      contract: contract(),
      capability_plan_digest: digest("5"),
    });
    expect(outcome.status).toBe("blocked");
    expect(fixture.calls).toEqual([]);
    if (outcome.status === "blocked") {
      expect(outcome.issues.map((issue) => issue.code)).toContain("write_set_violation");
    }
  });

  it("blocks implementation writes outside the declared task write paths", async () => {
    const spec = p13Task(["src/items.ts", "tests/items.test.ts", "vitest.config.ts"]);
    const fixture = p13Harness(spec, "src/evil.ts");
    const outcome = await fixture.runner.runTask({
      task: spec,
      contract: contract(),
      capability_plan_digest: digest("5"),
    });
    expect(outcome.status).toBe("blocked");
    expect(fixture.calls).toEqual(["authorTests", "implement"]);
    if (outcome.status === "blocked") {
      expect(outcome.issues.map((issue) => issue.code)).toContain("write_set_violation");
      expect(outcome.reason).toContain("write scope");
    }
  });
});
