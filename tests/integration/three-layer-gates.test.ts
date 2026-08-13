import { describe, expect, it } from "vitest";

import {
  completionBlockers,
  findingClosableBy,
  normalizeGateDefinition,
  runGateSuite,
  type CurrentEvidenceState,
  type GateDefinition,
  type GateSuiteOutcome,
} from "../../packages/runtime/src/index.js";
import { ToolRegistry } from "../../packages/runtime/src/index.js";
import {
  BINDING_DIGESTS,
  FIXED_TIMESTAMP,
  failingHandler,
  gateTool,
  passingHandler,
} from "../../packages/runtime/test/gates/fixtures.js";

/**
 * Three-layer gate integration (plan Task 19). Universal, stack and project
 * gates execute through the Tool Registry -- never as direct subprocesses --
 * and normalize into bound evidence. A failed mandatory gate creates a
 * Finding and blocks `completed`; once any bound input (artifact, code,
 * context bundle, gate, evaluation case or policy) drifts, the evidence is
 * stale and can neither close the Finding nor satisfy the Snapshot.
 */
const TIMESTAMP_CLOCK = (): string => FIXED_TIMESTAMP;

function gate(
  gateId: string,
  layer: "universal" | "stack" | "project",
  tool: string,
): GateDefinition {
  return normalizeGateDefinition({
    gate_id: gateId,
    layer,
    name: gateId,
    mandatory: true,
    subject_id: "test_smoke",
    tool,
  });
}

const GATES = [
  gate("gate_integrity", "universal", "run_integrity"),
  gate("gate_build", "stack", "run_build"),
  gate("gate_lint", "project", "run_lint"),
];

function registryWithHandlers(handlers: {
  integrity?: Parameters<ToolRegistry["register"]>[1];
  build?: Parameters<ToolRegistry["register"]>[1];
  lint?: Parameters<ToolRegistry["register"]>[1];
}): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(gateTool("run_integrity"), handlers.integrity ?? passingHandler());
  registry.register(gateTool("run_build"), handlers.build ?? passingHandler());
  registry.register(gateTool("run_lint"), handlers.lint ?? passingHandler());
  return registry;
}

function suiteBindings(): {
  artifact_digests: readonly string[];
  code_digests: readonly string[];
  context_bundle_digest: string;
  evaluation_case_digests: readonly string[];
  policy_digest: string;
} {
  return {
    artifact_digests: [BINDING_DIGESTS.artifact],
    code_digests: [BINDING_DIGESTS.code],
    context_bundle_digest: BINDING_DIGESTS.context,
    evaluation_case_digests: [BINDING_DIGESTS.evaluation],
    policy_digest: BINDING_DIGESTS.policy,
  };
}

async function runSuite(registry: ToolRegistry): Promise<GateSuiteOutcome> {
  return runGateSuite(registry, {
    iterationId: "iteration_01",
    gates: GATES,
    bindings: suiteBindings(),
    clock: TIMESTAMP_CLOCK,
  });
}

function currentDigests(
  outcome: GateSuiteOutcome,
  overrides?: Partial<CurrentEvidenceState>,
): (gateDefinition: GateDefinition) => CurrentEvidenceState {
  return (gateDefinition) => ({
    ...suiteBindings(),
    gate_digest: gateDefinition.digest,
    ...overrides,
  });
}

describe("three-layer gate integration", () => {
  it("runs universal, stack and project gates in order with bound evidence", async () => {
    const outcome = await runSuite(registryWithHandlers({}));

    expect(outcome.results.map((result) => result.gate.layer)).toEqual([
      "universal",
      "stack",
      "project",
    ]);
    expect(outcome.completed_allowed).toBe(true);
    expect(outcome.findings).toEqual([]);
    expect(completionBlockers(outcome, currentDigests(outcome))).toEqual([]);
    for (const result of outcome.results) {
      const extension = result.evidence.extensions?.["harness.gate"] as {
        bindings: Record<string, unknown>;
      };
      expect(extension.bindings).toMatchObject({
        artifact_digests: [BINDING_DIGESTS.artifact],
        code_digests: [BINDING_DIGESTS.code],
        context_bundle_digest: BINDING_DIGESTS.context,
        gate_digest: result.gate.digest,
        evaluation_case_digests: [BINDING_DIGESTS.evaluation],
        policy_digest: BINDING_DIGESTS.policy,
      });
    }
  });

  it("creates a Finding and blocks completed when a mandatory stack gate fails", async () => {
    const outcome = await runSuite(registryWithHandlers({ build: failingHandler() }));

    expect(outcome.completed_allowed).toBe(false);
    expect(outcome.findings.map((finding) => finding.id)).toEqual(["finding_build"]);
    expect(outcome.findings[0]?.summary).toContain("Mandatory stack gate gate_build failed");
    const blockers = completionBlockers(outcome, currentDigests(outcome));
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("gate_build");
    // The failed gate's evidence can never close its own Finding.
    const buildEvidence = outcome.results[1]?.evidence;
    expect(buildEvidence).toBeDefined();
    if (buildEvidence !== undefined) {
      expect(
        findingClosableBy(buildEvidence, currentDigests(outcome)(GATES[1] as GateDefinition)),
      ).toBe(false);
    }
  });

  it("blocks completed and Finding closure once a bound input drifts", async () => {
    const outcome = await runSuite(registryWithHandlers({}));
    expect(outcome.completed_allowed).toBe(true);

    // The effective policy changed after the gates ran: every verdict is stale.
    const drifted = currentDigests(outcome, { policy_digest: "6".repeat(64) });
    const blockers = completionBlockers(outcome, drifted);
    expect(blockers).toHaveLength(3);
    for (const result of outcome.results) {
      expect(findingClosableBy(result.evidence, drifted(result.gate))).toBe(false);
    }
  });

  it("fails a gate whose command is not registered instead of executing it directly", async () => {
    const registry = new ToolRegistry();
    registry.register(gateTool("run_integrity"), passingHandler());
    registry.register(gateTool("run_build"), passingHandler());
    // run_lint deliberately not registered.

    const outcome = await runSuite(registry);

    const lint = outcome.results[2];
    expect(lint?.outcome.passed).toBe(false);
    expect(lint?.outcome.error).toBe("unknown_tool");
    expect(outcome.findings.map((finding) => finding.id)).toEqual(["finding_lint"]);
    expect(outcome.completed_allowed).toBe(false);
  });
});
