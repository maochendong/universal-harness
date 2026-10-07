import { Type, type Static } from "@sinclair/typebox";

import { DigestSchema, IdentifierSchema, enumerated, strictObject } from "./common.js";

export const JEV_IMPACT_SCHEMA_VERSION = "jev-impact-judgments.v1" as const;

export const JevChoiceSchema = enumerated(["affected", "unrelated", "insufficient"] as const);
export type JevChoice = Static<typeof JevChoiceSchema>;

const ProbabilitySchema = Type.Number({ minimum: 0, maximum: 1 });
const TokenCountSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

export const JevProviderResponseSchema = strictObject({
  model: Type.Literal("jev-1.13.0"),
  answers: Type.Record(
    IdentifierSchema,
    strictObject({
      type: Type.Literal("choice"),
      choice: JevChoiceSchema,
      probabilities: strictObject({
        affected: ProbabilitySchema,
        unrelated: ProbabilitySchema,
        insufficient: ProbabilitySchema,
      }),
      confidence: ProbabilitySchema,
    }),
    { additionalProperties: false, minProperties: 1, maxProperties: 20 },
  ),
  usage: strictObject({ input_tokens: TokenCountSchema, output_tokens: TokenCountSchema }),
});

export type JevProviderResponse = Static<typeof JevProviderResponseSchema>;

/** Invocation output only: provider facts and local provenance are kept separate. */
export const JevImpactJudgmentsSchema = strictObject({
  schema_version: Type.Literal(JEV_IMPACT_SCHEMA_VERSION),
  provider_response: JevProviderResponseSchema,
  harness: strictObject({
    request_digest: DigestSchema,
    candidate_set_digest: DigestSchema,
    mapping_version: Type.Literal("jev-impact-mapping.v1"),
  }),
});

export type JevImpactJudgments = Static<typeof JevImpactJudgmentsSchema>;
