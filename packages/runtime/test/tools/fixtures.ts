import type { ToolHandler } from "../../src/tools/registry.js";

/** Shared builders for deterministic tool tests. */

export const INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    url: { type: "string" },
    token: { type: "string" },
    mode: { type: "string" },
  },
  required: ["url"],
  additionalProperties: false,
};

export const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    status: { type: "string" },
    detail: { type: "string" },
  },
  required: ["status"],
  additionalProperties: false,
};

export function pureTool(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    name: "http_fetch",
    version: "1.0.0",
    description: "fetch a URL",
    input_schema: INPUT_SCHEMA,
    output_schema: OUTPUT_SCHEMA,
    allowed_phases: ["implementation"],
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

export function externalTool(overrides?: Record<string, unknown>): Record<string, unknown> {
  return pureTool({
    name: "issue_comment",
    allowed_phases: ["implementation", "verification"],
    resource_patterns: ["issue:*"],
    risk: "high",
    side_effect_class: "external",
    requires_approval: true,
    ...overrides,
  });
}

export function okHandler(output?: unknown): ToolHandler {
  return () => output ?? { status: "ok" };
}

export function failingHandler(error: Error): ToolHandler {
  return () => {
    throw error;
  };
}

/** A handler that never settles, so the declared timeout always wins. */
export function hangingHandler(): ToolHandler {
  return () => new Promise(() => undefined);
}
