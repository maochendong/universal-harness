import type { PluginManifest } from "@universal-harness-internal/core";

/**
 * GateProvider port (design 13.6). A gate provider declares deterministic
 * verification gates -- test, lint, build, security or project-specific -- as
 * data. Each gate names a registered tool that performs the actual command,
 * so execution always flows through the Tool Registry with the same grant,
 * approval, quota and redaction enforcement as any governed capability. The
 * provider normalizes exit code, structured result, log summary and artifact
 * hashes into evidence; whether a result permits release is a policy decision
 * made elsewhere.
 *
 * `GateDefinitionInput` is the pre-registration shape: the runtime-owned
 * normalization adds the content digest, so providers never mint their own.
 */

export const GATE_PROVIDER_LAYERS = ["universal", "stack", "project"] as const;

export type GateProviderLayer = (typeof GATE_PROVIDER_LAYERS)[number];

export interface GateDefinitionInput {
  readonly gate_id: string;
  readonly layer: GateProviderLayer;
  readonly name: string;
  /** Mandatory gates block completion and create a Finding on failure. */
  readonly mandatory: boolean;
  /** Ledger node the gate verifies (Test, Requirement, EvaluationCase, ...). */
  readonly subject_id: string;
  /** Name of the registered tool that executes the gate command. */
  readonly tool: string;
  readonly version?: string;
  readonly parameters?: Record<string, unknown>;
  readonly resource?: string;
}

export interface GateProvider {
  readonly name: string;
  readonly manifest: PluginManifest;
  /** Gate declarations the provider offers; the runtime validates every one. */
  listGates(): readonly GateDefinitionInput[];
}
