import { Type, type Static } from "@sinclair/typebox";

import { DigestSchema, IdentifierSchema, enumerated, strictObject } from "./common.js";
import { recordEnvelopeProperties } from "./envelope.js";

/**
 * Provable TDD domain schemas (provable TDD design 8-10/13, plan T16). The
 * cycle record is the immutable per-attempt fact: `completed` requires the
 * full Baseline → Red → Green binding chain, while `invalidated`/`blocked`
 * keep only the bindings accepted before termination plus a structured
 * reason — early termination never fabricates later evidence.
 */
export const TDD_CYCLE_STATUSES = ["completed", "invalidated", "blocked"] as const;
export type TddCycleStatus = (typeof TDD_CYCLE_STATUSES)[number];

export const TDD_EVIDENCE_TYPES = [
  "framework_result",
  "baseline_test_result",
  "red_test_result",
  "green_test_result",
  "refactor_test_result",
] as const;
export type TddEvidenceType = (typeof TDD_EVIDENCE_TYPES)[number];

/** The harness.tdd extension payload of a TDD Evidence node (design 9.1). */
export const TddEvidenceBindingSchema = strictObject({
  evidence_type: enumerated(TDD_EVIDENCE_TYPES),
  task_id: IdentifierSchema,
  logical_cycle_id: IdentifierSchema,
  attempt_ordinal: Type.Integer({ minimum: 1 }),
  contract_digest: DigestSchema,
  repository_baseline: Type.String({ minLength: 1 }),
  test_patch_digest: Type.Optional(DigestSchema),
  target_gate_binding_digest: DigestSchema,
  framework_profile_digest: DigestSchema,
  executor_environment_digest: DigestSchema,
  selector_ids: Type.Array(Type.String({ minLength: 1 })),
  assertion_ids: Type.Array(IdentifierSchema),
  failure_kind: Type.Optional(Type.String({ minLength: 1 })),
  grant_digest: DigestSchema,
  observed_write_set_digest: DigestSchema,
  output_artifact: strictObject({ locator: Type.String({ minLength: 1 }), digest: DigestSchema }),
});
export type TddEvidenceBinding = Static<typeof TddEvidenceBindingSchema>;

const cycleProperties = {
  logical_cycle_id: IdentifierSchema,
  attempt_ordinal: Type.Integer({ minimum: 1 }),
  task_id: IdentifierSchema,
  assertion_ids: Type.Array(IdentifierSchema, { minItems: 1 }),
  contract_digest: DigestSchema,
  repository_baseline: Type.String({ minLength: 1 }),
  baseline_evidence_digest: Type.Optional(DigestSchema),
  test_patch_digest: Type.Optional(DigestSchema),
  target_gate_binding_digest: Type.Optional(DigestSchema),
  executor_environment_digest: Type.Optional(DigestSchema),
  red_evidence_digest: Type.Optional(DigestSchema),
  green_evidence_digest: Type.Optional(DigestSchema),
  refactor_evidence_digest: Type.Optional(DigestSchema),
  implementation_revision: Type.Optional(Type.String({ minLength: 1 })),
  status: enumerated(TDD_CYCLE_STATUSES),
  reason: Type.Optional(Type.String({ minLength: 1 })),
} as const;

/** The immutable per-attempt record (design 9.4); history is never rewritten. */
export const TddCycleRecordSchema = Type.Object(
  {
    ...recordEnvelopeProperties("tdd_cycle"),
    ...cycleProperties,
    record_digest: DigestSchema,
  },
  {
    additionalProperties: false,
    allOf: [
      {
        if: { properties: { status: { const: "completed" } }, required: ["status"] },
        then: {
          properties: {
            baseline_evidence_digest: true,
            test_patch_digest: true,
            target_gate_binding_digest: true,
            executor_environment_digest: true,
            red_evidence_digest: true,
            green_evidence_digest: true,
            implementation_revision: true,
          },
          required: [
            "baseline_evidence_digest",
            "test_patch_digest",
            "target_gate_binding_digest",
            "executor_environment_digest",
            "red_evidence_digest",
            "green_evidence_digest",
            "implementation_revision",
          ],
        },
      },
      {
        if: {
          properties: { status: { enum: ["invalidated", "blocked"] } },
          required: ["status"],
        },
        then: { properties: { reason: true }, required: ["reason"] },
      },
    ],
  },
);
export type TddCycleRecord = Static<typeof TddCycleRecordSchema>;

/** The six TDD domain verdict states (design 13/14.3). */
export const TDD_VERDICT_STATES = [
  "tdd_proven",
  "framework_proven",
  "controlled_not_applicable",
  "not_enabled_by_profile",
  "historical_without_tdd_proof",
  "tdd_incomplete_or_invalid",
] as const;
export type TddVerdictState = (typeof TDD_VERDICT_STATES)[number];

/** The mandated projection onto the slim generic five (design 14.3). */
export const TDD_VERDICT_TO_GENERIC: Readonly<Record<TddVerdictState, string>> = {
  tdd_proven: "proven",
  framework_proven: "proven",
  controlled_not_applicable: "controlled_not_applicable",
  not_enabled_by_profile: "not_enabled_by_profile",
  historical_without_tdd_proof: "historical_without_proof",
  tdd_incomplete_or_invalid: "invalid_or_incomplete",
};
