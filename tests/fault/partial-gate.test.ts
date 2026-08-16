import { describe, expect, it } from "vitest";

import {
  ToolRegistry,
  completionBlockers,
  normalizeGateDefinition,
  orderGates,
  runGateSuite,
  type GateDefinition,
} from "../../packages/runtime/src/index.js";
import {
  BINDING_DIGESTS,
  FIXED_TIMESTAMP,
  failingHandler,
  gateTool,
  passingHandler,
} from "../../packages/runtime/test/gates/fixtures.js";

/**
 * Partial gate failure fault injection (design 13.6, 15.2; completion rules
 * 15-16). A suite with mixed outcomes keeps running to completion: every gate
 * produces evidence, every failed gate appends a proposed Finding, mandatory
 * failures block completion while advisory Findings remain warnings, a gate
 * whose tool cannot run fails closed, and provisional mandatory evidence
 * never satisfies completion.
 */
const BINDINGS = {
  artifact_digests: [BINDING_DIGESTS.artifact],
  code_digests: [BINDING_DIGESTS.code],
  evaluation_case_digests: [BINDING_DIGESTS.evaluation],
  policy_digest: BINDING_DIGESTS.policy,
};

function gate(
  id: string,
  tool: string,
  layer: "universal" | "stack" | "project",
  mandatory: boolean,
): GateDefinition {
  return normalizeGateDefinition({
    gate_id: id,
    layer,
    name: id,
    mandatory,
    subject_id: "test_smoke",
    tool,
  });
}

function suite(gates: readonly GateDefinition[], provisional = false) {
  return {
    iterationId: "iteration_01",
    gates,
    bindings: BINDINGS,
    clock: () => FIXED_TIMESTAMP,
    provisional,
  };
}

describe("partial gate failure", () => {
  it("runs every gate and records blocking plus advisory failures", async () => {
    const registry = new ToolRegistry();
    registry.register(gateTool("unit_tests"), passingHandler());
    registry.register(gateTool("lint"), failingHandler());
    registry.register(gateTool("style"), failingHandler());

    const universal = gate("gate_unit", "unit_tests", "universal", true);
    const stackMandatory = gate("gate_lint", "lint", "stack", true);
    const projectAdvisory = gate("gate_style", "style", "project", false);

    const outcome = await runGateSuite(
      registry,
      suite([projectAdvisory, stackMandatory, universal]),
    );

    // Deterministic layer-first order, every gate ran despite the failure.
    expect(orderGates([projectAdvisory, stackMandatory, universal]).map((g) => g.gate_id)).toEqual([
      "gate_unit",
      "gate_lint",
      "gate_style",
    ]);
    expect(outcome.results.map((result) => result.gate.gate_id)).toEqual([
      "gate_unit",
      "gate_lint",
      "gate_style",
    ]);
    expect(outcome.results.every((result) => result.evidence.evidence_id.length > 0)).toBe(true);

    // Both failures become governable Findings, but only the mandatory one
    // participates in completion blockers.
    expect(outcome.findings).toHaveLength(2);
    expect(outcome.findings.map((finding) => finding.summary)).toEqual([
      expect.stringContaining("gate_lint"),
      expect.stringContaining("gate_style"),
    ]);
    expect(outcome.findings.every((finding) => finding.status === "proposed")).toBe(true);
    expect(outcome.completed_allowed).toBe(false);

    const blockers = completionBlockers(outcome);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("gate_lint");
  });

  it("passes completion when only advisory gates fail", async () => {
    const registry = new ToolRegistry();
    registry.register(gateTool("unit_tests"), passingHandler());
    registry.register(gateTool("style"), failingHandler());
    const outcome = await runGateSuite(
      registry,
      suite([
        gate("gate_unit", "unit_tests", "universal", true),
        gate("gate_style", "style", "project", false),
      ]),
    );
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.summary).toContain("gate_style");
    expect(outcome.completed_allowed).toBe(true);
    expect(completionBlockers(outcome)).toEqual([]);
  });

  it("fails closed when the gate tool cannot run at all", async () => {
    const registry = new ToolRegistry();
    // The tool is never registered: the gate fails with a typed error, never
    // by executing anything outside the registry.
    const outcome = await runGateSuite(
      registry,
      suite([gate("gate_missing", "not_registered", "universal", true)]),
    );
    const result = outcome.results[0];
    expect(result?.outcome.passed).toBe(false);
    expect(result?.outcome.exit_code).toBeNull();
    expect(result?.outcome.error).toBe("unknown_tool");
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.completed_allowed).toBe(false);
  });

  it("never lets provisional mandatory evidence satisfy completion", async () => {
    const registry = new ToolRegistry();
    registry.register(gateTool("unit_tests"), passingHandler());
    const outcome = await runGateSuite(
      registry,
      suite([gate("gate_unit", "unit_tests", "universal", true)], true),
    );
    expect(outcome.results[0]?.outcome.passed).toBe(true);
    expect(outcome.results[0]?.evidence.provisional).toBe(true);
    expect(outcome.completed_allowed).toBe(false);
    expect(completionBlockers(outcome)[0]).toContain("provisional");
  });
});
