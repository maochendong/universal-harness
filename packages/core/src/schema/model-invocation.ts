import { Type, type Static } from "@sinclair/typebox";

import { DigestSchema, IdentifierSchema, enumerated, strictObject } from "./common.js";
import { recordEnvelopeSchema } from "./envelope.js";
import { PROMPT_CONTRACT_ID_PATTERN } from "./prompt.js";

/**
 * Model invocation schemas (prompt governance addendum design 5.4, 9.1.1).
 * A ModelInvocationRecord is the single authoritative carrier for
 * invocation-layer facts: every digest that shaped the call is pinned at
 * `planned` time, and each lifecycle transition appends a new revision —
 * history is never rewritten in place.
 */

/** Invocation orchestration/execution failure codes, fixed by protocol. */
export const MODEL_INVOCATION_FAILURE_CODES = [
  "provider_required",
  "provider_unavailable",
  "timeout",
  "budget_exhausted",
  "invalid_output",
  "independence_violation",
  "version_mismatch",
  "policy_denied",
  "uncertain",
] as const;
export type ModelInvocationFailureCode = (typeof MODEL_INVOCATION_FAILURE_CODES)[number];

/** Normalized provider-side failure; never carries raw prompt or output text. */
export const ModelPortFailureSchema = strictObject({
  code: enumerated(MODEL_INVOCATION_FAILURE_CODES),
  summary: Type.String({ minLength: 1 }),
  retryable: Type.Boolean(),
});
export type ModelPortFailure = Static<typeof ModelPortFailureSchema>;

/** Lifecycle order: terminal consumption states follow execution states. */
export const MODEL_INVOCATION_STATES = [
  "planned",
  "started",
  "completed",
  "failed",
  "validated",
  "consumed",
  "invalidated",
] as const;
export type ModelInvocationState = (typeof MODEL_INVOCATION_STATES)[number];

export const ModelInvocationRecordSchema = recordEnvelopeSchema("model_invocation", {
  invocation_id: IdentifierSchema,
  conversation_id: IdentifierSchema,
  run_id: IdentifierSchema,
  attempt: Type.Integer({ minimum: 1 }),
  revision: Type.Integer({ minimum: 1 }),
  port_id: Type.String({ minLength: 1, maxLength: 80 }),
  purpose: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  prompt_contract_id: Type.String({ pattern: PROMPT_CONTRACT_ID_PATTERN }),
  prompt_contract_version: Type.String({ minLength: 1 }),
  prompt_contract_digest: DigestSchema,
  output_schema_id: Type.String({ minLength: 1 }),
  output_schema_digest: DigestSchema,
  profile_overlay_digest: DigestSchema,
  policy_overlay_digest: DigestSchema,
  input_bundle_digest: DigestSchema,
  compiled_prompt_digest: DigestSchema,
  provider_identity: Type.String({ minLength: 1 }),
  config_digest: DigestSchema,
  budget_profile: Type.String({ minLength: 1 }),
  cache_key: DigestSchema,
  state: enumerated(MODEL_INVOCATION_STATES),
  failure: Type.Optional(ModelPortFailureSchema),
  output_digest: Type.Optional(DigestSchema),
  artifact_locator: Type.Optional(Type.String({ minLength: 1 })),
});
export type ModelInvocationRecord = Static<typeof ModelInvocationRecordSchema>;
