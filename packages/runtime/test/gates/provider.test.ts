import { describe, expect, it, vi } from "vitest";

import { GateError, normalizeGateDefinition, runGate } from "../../src/gates/provider.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { failingHandler, gateDefinition, gateTool, passingHandler } from "./fixtures.js";

/**
 * GateProvider (design 13.6, plan Task 19). Gates execute only through the
 * Tool Registry and normalize exit code, structured result, log summary and
 * artifact hashes; an unregistered or failing tool is a failed gate, never a
 * direct subprocess.
 */
function registryWith(tool: Record<string, unknown>, handler = passingHandler()): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(tool, handler);
  return registry;
}

describe("normalizeGateDefinition", () => {
  it("normalizes a valid declaration and digests it deterministically", () => {
    const gate = normalizeGateDefinition(gateDefinition("gate_integrity", "run_tests"));
    expect(gate.layer).toBe("universal");
    expect(gate.mandatory).toBe(true);
    expect(gate.parameters).toEqual({});
    expect(gate.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(normalizeGateDefinition(gateDefinition("gate_integrity", "run_tests")).digest).toBe(
      gate.digest,
    );
  });

  it("rejects structural violations before any execution", () => {
    const invalid: readonly Record<string, unknown>[] = [
      { ...gateDefinition("integrity", "run_tests") },
      { ...gateDefinition("gate_x", "run_tests"), layer: "outer" },
      { ...gateDefinition("gate_x", "run_tests"), subject_id: "not-an-identifier" },
      { ...gateDefinition("gate_x", "run_tests"), parameters: [1] },
    ];
    for (const raw of invalid) {
      try {
        normalizeGateDefinition(raw);
        throw new Error("expected invalid_gate_definition");
      } catch (error) {
        expect(error).toBeInstanceOf(GateError);
        expect((error as GateError).kind).toBe("invalid_gate_definition");
      }
    }
  });
});

describe("runGate", () => {
  it("normalizes a passing result with artifact hashes", async () => {
    const registry = registryWith(gateTool("run_tests"));
    const gate = normalizeGateDefinition(gateDefinition("gate_integrity", "run_tests"));
    const outcome = await runGate(registry, gate, { intentId: "intent_01" });
    expect(outcome.passed).toBe(true);
    expect(outcome.exit_code).toBe(0);
    expect(outcome.summary).toBe("all checks passed");
    expect(outcome.log_summary).toBe("12 checks, 0 failures");
    expect(outcome.artifact_hashes).toEqual({ "dist/report.json": "a".repeat(64) });
    expect(outcome.output_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(outcome.error).toBeUndefined();
  });

  it("normalizes a failing exit code into a failed gate", async () => {
    const registry = registryWith(gateTool("run_tests"), failingHandler());
    const gate = normalizeGateDefinition(gateDefinition("gate_integrity", "run_tests"));
    const outcome = await runGate(registry, gate, { intentId: "intent_01" });
    expect(outcome.passed).toBe(false);
    expect(outcome.exit_code).toBe(1);
    expect(outcome.summary).toBe("2 tests failed");
  });

  it("honors an explicit structured result over the exit code", async () => {
    const registry = registryWith(gateTool("run_tests"), () => ({
      exit_code: 1,
      passed: true,
      summary: "flaky but tolerated",
    }));
    const gate = normalizeGateDefinition(gateDefinition("gate_integrity", "run_tests"));
    const outcome = await runGate(registry, gate, { intentId: "intent_01" });
    expect(outcome.passed).toBe(true);
    expect(outcome.exit_code).toBe(1);
  });

  it("fails the gate when the tool is not registered; nothing runs outside the registry", async () => {
    const registry = new ToolRegistry();
    const gate = normalizeGateDefinition(gateDefinition("gate_integrity", "run_tests"));
    const outcome = await runGate(registry, gate, { intentId: "intent_01" });
    expect(outcome.passed).toBe(false);
    expect(outcome.exit_code).toBeNull();
    expect(outcome.error).toBe("unknown_tool");
  });

  it("fails the gate on invocation errors such as quota exhaustion", async () => {
    const registry = registryWith(gateTool("run_tests", { max_invocations_per_run: 1 }));
    const gate = normalizeGateDefinition(gateDefinition("gate_integrity", "run_tests"));
    await runGate(registry, gate, { intentId: "intent_01" });
    const second = await runGate(registry, gate, { intentId: "intent_02" });
    expect(second.passed).toBe(false);
    expect(second.error).toBe("quota_exceeded");
  });

  it("runs every gate in the verification phase through the registered handler", async () => {
    const handler = vi.fn(passingHandler());
    const registry = registryWith(gateTool("run_tests"), handler);
    const gate = normalizeGateDefinition(
      gateDefinition("gate_integrity", "run_tests", { parameters: { target: "src" } }),
    );
    await runGate(registry, gate, { intentId: "intent_01" });
    expect(handler).toHaveBeenCalledOnce();
    const input = handler.mock.calls[0]?.[0];
    expect(input?.parameters).toEqual({ target: "src" });
    expect(registry.invocationSummaries()[0]?.invocations).toBe(1);
  });

  it("is deterministic: identical inputs reproduce the identical outcome", async () => {
    const first = await runGate(
      registryWith(gateTool("run_tests")),
      normalizeGateDefinition(gateDefinition("gate_integrity", "run_tests")),
      { intentId: "intent_01" },
    );
    const second = await runGate(
      registryWith(gateTool("run_tests")),
      normalizeGateDefinition(gateDefinition("gate_integrity", "run_tests")),
      { intentId: "intent_01" },
    );
    expect(second).toEqual(first);
  });
});
