import { contentDigest } from "@universal-harness-internal/core";

import type { CompiledPrompt, PromptPartition } from "./prompt-compiler.js";

/**
 * Sanitized compiled-prompt artifacts (prompt governance addendum design
 * 5.3, 11). The artifact keeps structure and every digest for audit, but raw
 * prompt text — especially untrusted project content — is replaced by its
 * digest and byte length. The compiler never writes to disk itself; callers
 * inject a controlled sink, and invocations only persist digest/locator.
 */
export interface SanitizedPromptMessage {
  readonly role: "system" | "user";
  readonly partition: PromptPartition;
  readonly digest: string;
  readonly byte_length: number;
}

export interface SanitizedPromptArtifact {
  readonly artifact_kind: "compiled_prompt";
  readonly contract_id: string;
  readonly contract_digest: string;
  readonly profile_overlay_digest: string;
  readonly policy_overlay_digest: string;
  readonly input_bundle_digest: string;
  readonly output_schema_digest: string;
  readonly compiled_prompt_digest: string;
  readonly messages: readonly SanitizedPromptMessage[];
}

export function createSanitizedPromptArtifact(compiled: CompiledPrompt): SanitizedPromptArtifact {
  return {
    artifact_kind: "compiled_prompt",
    contract_id: compiled.contract_id,
    contract_digest: compiled.contract_digest,
    profile_overlay_digest: compiled.profile_overlay_digest,
    policy_overlay_digest: compiled.policy_overlay_digest,
    input_bundle_digest: compiled.input_bundle_digest,
    output_schema_digest: compiled.output_schema_digest,
    compiled_prompt_digest: compiled.compiled_prompt_digest,
    messages: compiled.messages.map((message) => ({
      role: message.role,
      partition: message.partition,
      digest: message.digest,
      byte_length: Buffer.byteLength(message.content, "utf8"),
    })),
  };
}

/** A controlled artifact sink: the only write path for sanitized prompts. */
export interface PromptArtifactSink {
  write(artifact: SanitizedPromptArtifact): string;
}

export interface WrittenPromptArtifact {
  readonly artifact: SanitizedPromptArtifact;
  readonly artifact_digest: string;
  readonly locator: string;
}

export function writeSanitizedPromptArtifact(
  compiled: CompiledPrompt,
  sink: PromptArtifactSink,
): WrittenPromptArtifact {
  const artifact = createSanitizedPromptArtifact(compiled);
  return {
    artifact,
    artifact_digest: contentDigest(artifact),
    locator: sink.write(artifact),
  };
}
