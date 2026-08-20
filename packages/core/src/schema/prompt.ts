import { Type, type Static } from "@sinclair/typebox";

import { DigestSchema, enumerated, strictObject } from "./common.js";

/**
 * Protocol 1.1 prompt governance schemas (prompt governance addendum design
 * 5.1, 9.1). A PromptContract is protocol registry data owned by a domain
 * module — never a project record — so it uses the same strict shape rules as
 * the profile definitions: unknown fields, empty segments, foreign profiles
 * and malformed digests are rejected, never negotiated.
 */
export const PROMPT_CONTRACT_ID_PATTERN = "^harness:prompt:[a-z][a-z0-9]*(?:-[a-z0-9]+)*$" as const;
export const PROMPT_CONTRACT_VERSION_PATTERN =
  "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$" as const;

/**
 * One immutable segment of contract content: Harness-owned normalized text
 * with a stable identity. Runtime template code or caller-supplied text has
 * no representation here.
 */
export const PromptSegmentSchema = strictObject({
  segment_id: Type.String({ minLength: 1, maxLength: 120 }),
  text: Type.String({ minLength: 1 }),
});
export type PromptSegment = Static<typeof PromptSegmentSchema>;

/**
 * The versioned, digestible contract a model port/purpose is bound to
 * (addendum design 5.1). `contract_digest` seals every field except itself;
 * `contract_id + version` content is immutable, so any semantic change must
 * mint a new version. Profile overlays exist for exactly the three protocol
 * tiers — an unknown profile is an unknown field and is rejected.
 */
export const PromptContractSchema = strictObject({
  contract_id: Type.String({ pattern: PROMPT_CONTRACT_ID_PATTERN }),
  port_id: Type.String({ minLength: 1, maxLength: 80 }),
  purpose: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  version: Type.String({ pattern: PROMPT_CONTRACT_VERSION_PATTERN }),
  authority_boundary: PromptSegmentSchema,
  role_instruction: PromptSegmentSchema,
  domain_rubric: PromptSegmentSchema,
  profile_overlays: strictObject({
    lite: PromptSegmentSchema,
    standard: PromptSegmentSchema,
    governed: PromptSegmentSchema,
  }),
  output_schema_id: Type.String({ minLength: 1, maxLength: 120 }),
  output_schema_digest: DigestSchema,
  source_delimiter_version: Type.String({ minLength: 1, maxLength: 120 }),
  contract_digest: DigestSchema,
});
export type PromptContract = Static<typeof PromptContractSchema>;

/** Prompt preparation failure codes (addendum design 9.1), fixed by protocol. */
export const PROMPT_PREPARATION_FAILURE_CODES = [
  "prompt_contract_required",
  "prompt_contract_version_mismatch",
  "prompt_contract_digest_mismatch",
  "profile_overlay_missing",
  "policy_overlay_invalid",
  "output_schema_mismatch",
  "untrusted_source_boundary_failed",
  "prompt_size_exceeded",
] as const;
export type PromptPreparationFailureCode = (typeof PROMPT_PREPARATION_FAILURE_CODES)[number];

/**
 * The typed blocker payload for failures that happen before any provider
 * call: zero invocation records, zero budget. It never carries raw prompt
 * text — only the code, a sanitized summary and optional contract identity.
 */
export const PromptPreparationFailureSchema = strictObject({
  code: enumerated(PROMPT_PREPARATION_FAILURE_CODES),
  summary: Type.String({ minLength: 1 }),
  retryable: Type.Boolean(),
  contract_id: Type.Optional(Type.String({ pattern: PROMPT_CONTRACT_ID_PATTERN })),
});
export type PromptPreparationFailure = Static<typeof PromptPreparationFailureSchema>;
