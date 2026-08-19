import { contentDigest } from "../identity/digest.js";
import { domainRecordId } from "../identity/record-id.js";
import { PROTOCOL_1_1_VERSION } from "../protocol.js";
import { sealRecordEnvelope } from "../schema/envelope.js";
import { GROUNDED_SYNTHESIS_PURPOSES, type GroundedSynthesisPurpose } from "../schema/profile.js";
import {
  GROUNDED_SYNTHESIS_SCHEMA_VERSIONS,
  type GroundedSynthesisOutput,
  type GroundedSynthesisRecord,
} from "../schema/synthesis.js";

/**
 * Constructors and identity derivation for grounded synthesis records (model
 * advisory design 5.3/5.4). Conversation identity binds purpose + binding +
 * bundle, so two purposes can never share a conversation; run identity binds
 * the exact input digest on top.
 */
export class SynthesisRecordError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "SynthesisRecordError";
    this.kind = kind;
  }
}

const DIGEST_REGEX = /^[a-f0-9]{64}$/u;

function assertDigest(value: string, field: string): void {
  if (!DIGEST_REGEX.test(value)) {
    throw new SynthesisRecordError(
      "invalid_digest",
      `${field} must be a lowercase sha-256 hex digest`,
    );
  }
}

/** One conversation per (purpose, binding, bundle) — never shared across purposes. */
export function deriveGroundedConversationId(input: {
  readonly purpose: GroundedSynthesisPurpose;
  readonly binding_digest: string;
  readonly bundle_digest: string;
}): string {
  return domainRecordId({
    domain_tag: "grounded_conversation",
    id_prefix: "grounded-conversation",
    protocol_version: PROTOCOL_1_1_VERSION,
    canonical_input: {
      purpose: input.purpose,
      binding_digest: input.binding_digest,
      bundle_digest: input.bundle_digest,
    },
  });
}

export function deriveGroundedRunId(input: {
  readonly conversation_id: string;
  readonly input_digest: string;
}): string {
  return domainRecordId({
    domain_tag: "grounded_run",
    id_prefix: "grounded-run",
    protocol_version: PROTOCOL_1_1_VERSION,
    canonical_input: {
      conversation_id: input.conversation_id,
      input_digest: input.input_digest,
    },
  });
}

/**
 * The cache key for a synthesis call (design 5.4): purpose, binding, bundle
 * and input digests — reuse across purposes or stale inputs is impossible
 * because the key covers every one of them.
 */
export function groundedSynthesisCacheKey(input: {
  readonly purpose: GroundedSynthesisPurpose;
  readonly binding_digest: string;
  readonly bundle_digest: string;
  readonly input_digest: string;
}): string {
  return contentDigest({
    purpose: input.purpose,
    binding_digest: input.binding_digest,
    bundle_digest: input.bundle_digest,
    input_digest: input.input_digest,
  });
}

function schemaVersionFor(purpose: GroundedSynthesisPurpose): string {
  return GROUNDED_SYNTHESIS_SCHEMA_VERSIONS[purpose];
}

export interface CreateGroundedSynthesisInput {
  readonly purpose: GroundedSynthesisPurpose;
  readonly session_id?: string;
  readonly profile_decision_digest?: string;
  readonly binding_digest: string;
  readonly bundle_digest: string;
  readonly conversation_id: string;
  readonly run_id: string;
  readonly input_digest: string;
  readonly output: GroundedSynthesisOutput;
}

/**
 * Seal a validated synthesis result. The constructor is the last line of
 * defense: record purpose, output purpose, registered schema version and
 * bundle binding must all agree or the record is refused.
 */
export function createGroundedSynthesisRecord(
  input: CreateGroundedSynthesisInput,
): GroundedSynthesisRecord {
  if (!GROUNDED_SYNTHESIS_PURPOSES.includes(input.purpose)) {
    throw new SynthesisRecordError(
      "unknown_purpose",
      `unknown grounded synthesis purpose: ${String(input.purpose)}`,
    );
  }
  if (input.output.purpose !== input.purpose) {
    throw new SynthesisRecordError(
      "purpose_mismatch",
      `output purpose ${String(input.output.purpose)} does not match record purpose ${input.purpose}`,
    );
  }
  if (input.output.schema_version !== schemaVersionFor(input.purpose)) {
    throw new SynthesisRecordError(
      "version_mismatch",
      `output schema version ${String(input.output.schema_version)} is not the registered version for ${input.purpose}`,
    );
  }
  if (input.output.bundle_digest !== input.bundle_digest) {
    throw new SynthesisRecordError(
      "bundle_mismatch",
      "output bundle digest does not match the record bundle binding",
    );
  }
  assertDigest(input.binding_digest, "binding_digest");
  assertDigest(input.bundle_digest, "bundle_digest");
  assertDigest(input.input_digest, "input_digest");
  if (input.profile_decision_digest !== undefined) {
    assertDigest(input.profile_decision_digest, "profile_decision_digest");
  }
  return sealRecordEnvelope({
    protocol_version: PROTOCOL_1_1_VERSION,
    record_kind: "grounded_synthesis" as const,
    grounded_synthesis_id: domainRecordId({
      domain_tag: "grounded_synthesis",
      id_prefix: "grounded-synthesis",
      protocol_version: PROTOCOL_1_1_VERSION,
      canonical_input: {
        purpose: input.purpose,
        conversation_id: input.conversation_id,
        run_id: input.run_id,
        input_digest: input.input_digest,
      },
    }),
    purpose: input.purpose,
    ...(input.session_id === undefined ? {} : { session_id: input.session_id }),
    ...(input.profile_decision_digest === undefined
      ? {}
      : { profile_decision_digest: input.profile_decision_digest }),
    binding_digest: input.binding_digest,
    bundle_digest: input.bundle_digest,
    conversation_id: input.conversation_id,
    run_id: input.run_id,
    input_digest: input.input_digest,
    output: input.output,
  });
}
