import { sha256Hex } from "@universal-harness-internal/core";

import { ProjectionError, managedProjectionPath, type ManagedOutput } from "./managed-output.js";

/**
 * Provider Instruction Projection (design 13.7, plan Task 22). A provider
 * instruction file (for example an agent instruction document) is a Mirror
 * generated from the Canonical Pack template plus the Task Envelope and
 * ContextBundle digests it was compiled for -- never a source of truth. The
 * mirror records every input digest in its header, so any upstream change
 * shows up as drift and triggers regeneration instead of a silent edit.
 */
export interface ProviderInstructionSpec {
  /** Provider identifier, e.g. `claude` or `codex`; lowercase slug. */
  readonly provider: string;
  /** Canonical Pack instruction template text (already pack-resolved). */
  readonly instruction: string;
  /** Digest of the Task Envelope this instruction serves. */
  readonly task_envelope_digest: string;
  /** Digest of the ContextBundle manifest this instruction serves. */
  readonly context_bundle_digest: string;
}

export interface ProviderInstructionMirror {
  readonly provider: string;
  /** Managed projection output; always under `.harness/projections/`. */
  readonly output: ManagedOutput;
  /** SHA-256 of the mirror bytes; reproducible from the same inputs. */
  readonly digest: string;
}

const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * Generate the deterministic Provider Instruction Mirror. The same pack
 * template, envelope and bundle digests always produce the same bytes and the
 * same digest; the mirror path is fixed per provider inside the managed
 * projection root, so regeneration after drift converges to the same file.
 */
export function buildProviderInstructionMirror(
  spec: ProviderInstructionSpec,
): ProviderInstructionMirror {
  if (!PROVIDER_PATTERN.test(spec.provider)) {
    throw new ProjectionError(
      "invalid_projection_output",
      `provider id ${JSON.stringify(spec.provider)} must match ${PROVIDER_PATTERN.source}`,
    );
  }
  for (const [field, digest] of [
    ["task_envelope_digest", spec.task_envelope_digest],
    ["context_bundle_digest", spec.context_bundle_digest],
  ] as const) {
    if (!DIGEST_PATTERN.test(digest)) {
      throw new ProjectionError(
        "invalid_projection_output",
        `${field} must be a lowercase SHA-256 hex digest`,
      );
    }
  }
  const lines = [
    "<!-- harness:provider-instruction",
    `provider: ${spec.provider}`,
    `task_envelope_digest: ${spec.task_envelope_digest}`,
    `context_bundle_digest: ${spec.context_bundle_digest}`,
    "-->",
    "",
    spec.instruction.trimEnd(),
  ];
  const content = `${lines.join("\n")}\n`;
  return {
    provider: spec.provider,
    output: { name: `providers/${spec.provider}.md`, content },
    digest: sha256Hex(content),
  };
}

/** Harness-relative path of a provider mirror, for drift checks and previews. */
export function providerInstructionPath(provider: string): string {
  return managedProjectionPath(`providers/${provider}.md`);
}
