import type { PluginManifest } from "@universal-harness-internal/core";

/**
 * ToolProvider port (design 13.5). Every executable command, script,
 * provider-exposed MCP capability and external API must be registered as an
 * ordinary tool descriptor before use; a provider only supplies descriptor
 * data, never execution authority. The runtime registry normalizes and
 * digests each descriptor, then enforces schema, phase, resource, parameter,
 * risk, approval, quota, timeout, redaction, idempotency and reconciliation
 * constraints identically for every tool.
 *
 * `ToolDescriptorInput` is the pre-registration shape: the runtime-owned
 * normalization adds the content digest and applies defaults, so providers
 * never mint their own digest.
 */

export const TOOL_RISKS = ["low", "medium", "high", "critical"] as const;

export type ToolRisk = (typeof TOOL_RISKS)[number];

export const TOOL_SIDE_EFFECT_CLASSES = ["none", "repository", "external"] as const;

export type ToolSideEffectClass = (typeof TOOL_SIDE_EFFECT_CLASSES)[number];

export const TOOL_RETRY_CLASSES = ["none", "idempotent_only"] as const;

export type ToolRetryClass = (typeof TOOL_RETRY_CLASSES)[number];

export const TOOL_RECONCILIATION_MODES = ["provider", "manual"] as const;

export type ToolReconciliationMode = (typeof TOOL_RECONCILIATION_MODES)[number];

export interface ToolDescriptorInput {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  /** JSON Schema 2020-12 documents, compiled by the registry at registration. */
  readonly input_schema: Record<string, unknown>;
  readonly output_schema: Record<string, unknown>;
  readonly allowed_phases: readonly string[];
  /** Exact resources or `*`-suffixed prefix patterns; empty means no resource. */
  readonly resource_patterns?: readonly string[];
  /** Per-parameter allow-lists invocation arguments must stay within. */
  readonly parameter_bounds?: Readonly<Record<string, readonly (string | number | boolean)[]>>;
  readonly risk: ToolRisk;
  readonly side_effect_class: ToolSideEffectClass;
  readonly requires_approval?: boolean;
  /** Top-level output fields replaced before output is recorded as evidence. */
  readonly redacted_output_fields?: readonly string[];
  /** Parameter names that accept an Environment Secret Reference. */
  readonly secret_parameters?: readonly string[];
  readonly timeout_ms: number;
  readonly retry_class?: ToolRetryClass;
  readonly max_retries?: number;
  /** Quota: maximum invocations of this tool per run. */
  readonly max_invocations_per_run: number;
  readonly idempotent?: boolean;
  readonly reconciliation?: ToolReconciliationMode;
}

export interface ToolProvider {
  readonly name: string;
  readonly manifest: PluginManifest;
  /** Descriptors the provider offers; the registry validates every one. */
  listTools(): readonly ToolDescriptorInput[];
}
