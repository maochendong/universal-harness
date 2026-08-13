import { describe, expect, it } from "vitest";

import { normalizeGateDefinition, type GateDefinition } from "../../src/gates/provider.js";
import {
  completionBlockers,
  orderGates,
  runGateSuite,
  type GateSuiteSpec,
} from "../../src/gates/runner.js";
import type { CurrentEvidenceState } from "../../src/gates/freshness.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import {
  BINDING_DIGESTS,
  FIXED_TIMESTAMP,
  failingHandler,
  gateTool,
  passingHandler,
} from "./fixtures.js";

/**
 * Three-layer gate runner (design 13.6, plan Task 19): universal, stack and
 * project gates run in a deterministic order through the Tool Registry, every
 * run produces bound evidence, and a failed mandatory gate creates a Finding
 * and blocks the `completed` state.
 */
function gate(
  gateId: string,
  layer: "universal" | "stack" | "project",
  tool: string,
  mandatory = true,
): GateDefinition {
  return normalizeGateDefinition({
    gate_id: gateId,
    layer,
    name: gateId,
    mandatory,
    subject_id: "test_smoke",
    tool,
  });
}

function suiteSpec(gates: readonly GateDefinition[]): GateSuiteSpec {
  return {
    iterationId: "iteration_01",
    gates,
    bindings: {
      artifact_digests: [BINDING_DIGESTS.artifact],
      code_digests: [BINDING_DIGESTS.code],
      context_bundle_digest: BINDING_DIGESTS.context,
      evaluation_case_digests: [],
      policy_digest: BINDING_DIGESTS.policy,
    },
    clock: () => FIXED_TIMESTAMP,
  };
}

function currentFor(): (gate: GateDefinition) => CurrentEvidenceState {
  return (gateDefinition) => ({
    artifact_digests: [BINDING_DIGESTS.artifact],
    code_digests: [BINDING_DIGESTS.code],
    context_bundle_digest: BINDING_DIGESTS.context,
    gate_digest: gateDefinition.digest,
    evaluation_case_digests: [],
    policy_digest: BINDING_DIGESTS.policy,
  });
}

describe("orderGates", () => {
  it("orders universal, then stack, then project, by gate id within a layer", () => {
    const ordered = orderGates([
      gate("gate_lint", "project", "run_lint"),
      gate("gate_build", "stack", "run_build"),
      gate("gate_integrity", "universal", "run_integrity"),
      gate("gate_audit", "universal", "run_audit"),
    ]);
    expect(ordered.map((entry) => entry.gate_id)).toEqual([
      "gate_audit",
      "gate_integrity",
      "gate_build",
      "gate_lint",
    ]);
  });
});

describe("runGateSuite", () => {
  it("runs all three layers through the registry and binds evidence per gate", async () => {
    const registry = new ToolRegistry();
    registry.register(gateTool("run_integrity"), passingHandler());
    registry.register(gateTool("run_build"), passingHandler());
    registry.register(
      gateTool("run_lint"),
      passingHandler({ "reports/lint.json": "2".repeat(64) }),
    );
    const gates = [
      gate("gate_lint", "project", "run_lint"),
      gate("gate_build", "stack", "run_build"),
      gate("gate_integrity", "universal", "run_integrity"),
    ];

    const outcome = await runGateSuite(registry, suiteSpec(gates));

    expect(outcome.results.map((result) => result.gate.gate_id)).toEqual([
      "gate_integrity",
      "gate_build",
      "gate_lint",
    ]);
    expect(outcome.completed_allowed).toBe(true);
    expect(outcome.findings).toEqual([]);
    for (const result of outcome.results) {
      expect(result.evidence.digest).toMatch(/^[a-f0-9]{64}$/u);
      expect(result.evidence.extensions?.["harness.gate"]).toMatchObject({
        gate_id: result.gate.gate_id,
        passed: true,
      });
    }
    const lintEvidence = outcome.results[2]?.evidence;
    expect(lintEvidence?.extensions?.["harness.gate"]).toMatchObject({
      artifact_hashes: { "reports/lint.json": "2".repeat(64) },
    });
    // Every gate consumed exactly one registry invocation; none ran directly.
    expect(
      registry.invocationSummaries().map((summary) => [summary.tool, summary.invocations]),
    ).toEqual([
      ["run_build", 1],
      ["run_integrity", 1],
      ["run_lint", 1],
    ]);
  });

  it("creates a Finding and blocks completion when a mandatory gate fails", async () => {
    const registry = new ToolRegistry();
    registry.register(gateTool("run_integrity"), passingHandler());
    registry.register(gateTool("run_build"), failingHandler());
    const gates = [
      gate("gate_integrity", "universal", "run_integrity"),
      gate("gate_build", "stack", "run_build"),
    ];

    const outcome = await runGateSuite(registry, suiteSpec(gates));

    expect(outcome.completed_allowed).toBe(false);
    expect(outcome.findings).toHaveLength(1);
    const finding = outcome.findings[0];
    expect(finding).toMatchObject({
      record_kind: "feedback",
      type: "Finding",
      status: "proposed",
      iteration_id: "iteration_01",
    });
    expect(finding?.summary).toContain("gate_build");
    // Later layers still ran, so the picture is complete.
    expect(outcome.results).toHaveLength(2);
    expect(completionBlockers(outcome)[0]).toContain("gate_build");
  });

  it("records advisory failures as evidence without findings or blocking", async () => {
    const registry = new ToolRegistry();
    registry.register(gateTool("run_lint"), failingHandler());
    const gates = [gate("gate_lint", "project", "run_lint", false)];

    const outcome = await runGateSuite(registry, suiteSpec(gates));

    expect(outcome.completed_allowed).toBe(true);
    expect(outcome.findings).toEqual([]);
    expect(outcome.results[0]?.outcome.passed).toBe(false);
    expect(completionBlockers(outcome)).toEqual([]);
  });

  it("is deterministic: identical inputs reproduce identical records", async () => {
    const make = (): ToolRegistry => {
      const registry = new ToolRegistry();
      registry.register(gateTool("run_integrity"), passingHandler());
      return registry;
    };
    const gates = [gate("gate_integrity", "universal", "run_integrity")];
    const first = await runGateSuite(make(), suiteSpec(gates));
    const second = await runGateSuite(make(), suiteSpec(gates));
    expect(second).toEqual(first);
  });
});

describe("completionBlockers", () => {
  it("stays empty when mandatory evidence is current", async () => {
    const registry = new ToolRegistry();
    registry.register(gateTool("run_integrity"), passingHandler());
    const gates = [gate("gate_integrity", "universal", "run_integrity")];
    const outcome = await runGateSuite(registry, suiteSpec(gates));
    expect(completionBlockers(outcome, currentFor())).toEqual([]);
  });

  it("blocks completion when mandatory evidence went stale", async () => {
    const registry = new ToolRegistry();
    registry.register(gateTool("run_integrity"), passingHandler());
    const gates = [gate("gate_integrity", "universal", "run_integrity")];
    const outcome = await runGateSuite(registry, suiteSpec(gates));
    const drifted = (gateDefinition: GateDefinition): CurrentEvidenceState => ({
      ...currentFor()(gateDefinition),
      policy_digest: "6".repeat(64),
    });
    const blockers = completionBlockers(outcome, drifted);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("stale");
  });

  it("blocks completion on provisional mandatory evidence", async () => {
    const registry = new ToolRegistry();
    registry.register(gateTool("run_integrity"), passingHandler());
    const gates = [gate("gate_integrity", "universal", "run_integrity")];
    const outcome = await runGateSuite(registry, { ...suiteSpec(gates), provisional: true });
    expect(outcome.completed_allowed).toBe(false);
    expect(completionBlockers(outcome)[0]).toContain("provisional");
  });
});
