import { describe, expect, it } from "vitest";

import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../../src/schema/registry.js";

function judgments() {
  return {
    schema_version: "jev-impact-judgments.v1",
    provider_response: {
      model: "jev-1.13.0",
      answers: {
        requirement_02: {
          type: "choice",
          choice: "affected",
          probabilities: { affected: 0.9, unrelated: 0.05, insufficient: 0.05 },
          confidence: 0.85,
        },
      },
      usage: { input_tokens: 300, output_tokens: 20 },
    },
    harness: {
      request_digest: "a".repeat(64),
      candidate_set_digest: "b".repeat(64),
      mapping_version: "jev-impact-mapping.v1",
    },
  };
}

describe("Jev impact judgments output schema", () => {
  it("accepts raw judgments and their separate Harness provenance", () => {
    expect(PROTOCOL_1_1_SCHEMA_REGISTRY.validate("jev-impact-judgments", judgments())).toEqual({
      valid: true,
      errors: [],
    });
  });

  it.each([
    [
      "extra field",
      (value: ReturnType<typeof judgments>) => ({ ...value, explanation: "invented" }),
    ],
    [
      "wrong model",
      (value: ReturnType<typeof judgments>) => ({
        ...value,
        provider_response: { ...value.provider_response, model: "jev-latest" },
      }),
    ],
    [
      "negative usage",
      (value: ReturnType<typeof judgments>) => ({
        ...value,
        provider_response: {
          ...value.provider_response,
          usage: { input_tokens: -1, output_tokens: 0 },
        },
      }),
    ],
    [
      "illegal choice",
      (value: ReturnType<typeof judgments>) => ({
        ...value,
        provider_response: {
          ...value.provider_response,
          answers: {
            requirement_02: {
              ...value.provider_response.answers.requirement_02,
              choice: "approved",
            },
          },
        },
      }),
    ],
    [
      "missing probability",
      (value: ReturnType<typeof judgments>) => ({
        ...value,
        provider_response: {
          ...value.provider_response,
          answers: {
            requirement_02: {
              ...value.provider_response.answers.requirement_02,
              probabilities: { affected: 0.9, unrelated: 0.1 },
            },
          },
        },
      }),
    ],
  ])("rejects %s", (_name, change) => {
    expect(
      PROTOCOL_1_1_SCHEMA_REGISTRY.validate("jev-impact-judgments", change(judgments())).valid,
    ).toBe(false);
  });
});
