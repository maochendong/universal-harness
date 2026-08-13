import type { ToolHandler } from "../../src/tools/registry.js";

/** Shared builders for deterministic gate tests. */

export const GATE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    exit_code: { type: "integer" },
    passed: { type: "boolean" },
    summary: { type: "string" },
    log_summary: { type: "string" },
    artifacts: { type: "object", additionalProperties: { type: "string" } },
  },
  required: ["exit_code"],
  additionalProperties: false,
};

/** A registered gate command tool; gates may only run in `verification`. */
export function gateTool(
  name: string,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    name,
    version: "1.0.0",
    description: `run the ${name} gate command`,
    input_schema: {
      type: "object",
      properties: { target: { type: "string" } },
      additionalProperties: false,
    },
    output_schema: GATE_OUTPUT_SCHEMA,
    allowed_phases: ["verification"],
    resource_patterns: [],
    risk: "low",
    side_effect_class: "none",
    requires_approval: false,
    timeout_ms: 50,
    retry_class: "none",
    max_retries: 0,
    max_invocations_per_run: 10,
    idempotent: true,
    reconciliation: "provider",
    ...overrides,
  };
}

export function passingHandler(artifacts?: Record<string, string>): ToolHandler {
  return () => ({
    exit_code: 0,
    summary: "all checks passed",
    log_summary: "12 checks, 0 failures",
    artifacts: artifacts ?? { "dist/report.json": "a".repeat(64) },
  });
}

export function failingHandler(): ToolHandler {
  return () => ({
    exit_code: 1,
    summary: "2 tests failed",
    log_summary: "12 checks, 2 failures",
    artifacts: {},
  });
}

export function gateDefinition(
  gateId: string,
  tool: string,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    gate_id: gateId,
    layer: "universal",
    name: gateId,
    mandatory: true,
    subject_id: "test_smoke",
    tool,
    ...overrides,
  };
}

/** Fixed digests for binding fixtures; distinct per slot for readability. */
export const BINDING_DIGESTS = {
  artifact: "a".repeat(64),
  code: "b".repeat(64),
  context: "c".repeat(64),
  evaluation: "e".repeat(64),
  policy: "f".repeat(64),
} as const;

export const FIXED_TIMESTAMP = "2026-08-11T00:00:00.000Z";
