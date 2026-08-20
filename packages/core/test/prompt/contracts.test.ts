import { describe, expect, it } from "vitest";

import { contentDigest } from "../../src/identity/digest.js";
import { definePromptContract, promptContractDigest } from "../../src/prompt/contracts.js";
import {
  PRD_PROPOSAL_PROMPT_CONTRACT,
  PRD_PROPOSAL_PROMPT_PORT_ID,
} from "../../src/proposal/prompt-contract.js";
import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../../src/schema/registry.js";
import type { PromptContract } from "../../src/schema/prompt.js";

function validContract(): PromptContract {
  return PRD_PROPOSAL_PROMPT_CONTRACT;
}

describe("prompt contract schema", () => {
  it("accepts the registered domain contracts through the protocol registry", () => {
    const result = PROTOCOL_1_1_SCHEMA_REGISTRY.validate("prompt-contract", validContract());
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("rejects unknown fields, empty segments, malformed digests and unknown profiles", () => {
    const contract = validContract() as unknown as Record<string, unknown>;
    const validate = (value: unknown) =>
      PROTOCOL_1_1_SCHEMA_REGISTRY.validate("prompt-contract", value);

    expect(validate({ ...contract, template_engine: "handlebars" }).valid).toBe(false);
    expect(validate({ ...contract, contract_digest: "not-a-digest" }).valid).toBe(false);
    expect(validate({ ...contract, output_schema_digest: "abc123" }).valid).toBe(false);
    expect(validate({ ...contract, version: "v1" }).valid).toBe(false);
    expect(validate({ ...contract, contract_id: "prompt:prd-proposal" }).valid).toBe(false);

    const emptySegment = { segment_id: "authority-boundary", text: "" };
    expect(validate({ ...contract, authority_boundary: emptySegment }).valid).toBe(false);
    const fieldlessSegment = { text: "content without identity" };
    expect(validate({ ...contract, role_instruction: fieldlessSegment }).valid).toBe(false);

    const overlays = contract["profile_overlays"] as Record<string, unknown>;
    expect(
      validate({ ...contract, profile_overlays: { ...overlays, turbo: overlays["lite"] } }).valid,
    ).toBe(false);
    const missingGoverned = { ...overlays };
    delete missingGoverned["governed"];
    expect(validate({ ...contract, profile_overlays: missingGoverned }).valid).toBe(false);

    const digestless = { ...contract };
    delete digestless["contract_digest"];
    expect(validate(digestless).valid).toBe(false);
  });

  it("rejects preparation failures with unknown codes or extra fields", () => {
    const validate = (value: unknown) =>
      PROTOCOL_1_1_SCHEMA_REGISTRY.validate("prompt-preparation-failure", value);
    const valid = {
      code: "prompt_contract_version_mismatch",
      summary: "selector resolved to nothing",
      retryable: false,
    };
    expect(validate(valid)).toEqual({ valid: true, errors: [] });
    expect(validate({ ...valid, code: "model_exploded" }).valid).toBe(false);
    expect(validate({ ...valid, raw_prompt: "system: ..." }).valid).toBe(false);
    expect(validate({ ...valid, summary: "" }).valid).toBe(false);
  });
});

describe("canonical prompt contract digest", () => {
  function contractInput(): Omit<PromptContract, "contract_digest"> {
    const input: Record<string, unknown> = { ...validContract() };
    delete input["contract_digest"];
    return input as Omit<PromptContract, "contract_digest">;
  }

  it("derives the digest from the canonical content, independent of key order", () => {
    const input = contractInput();
    expect(promptContractDigest(input)).toBe(validContract().contract_digest);

    const shuffled = {
      profile_overlays: input.profile_overlays,
      contract_id: input.contract_id,
      domain_rubric: input.domain_rubric,
      authority_boundary: input.authority_boundary,
      output_schema_id: input.output_schema_id,
      output_schema_digest: input.output_schema_digest,
      port_id: input.port_id,
      role_instruction: input.role_instruction,
      source_delimiter_version: input.source_delimiter_version,
      version: input.version,
      ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
    };
    expect(promptContractDigest(shuffled)).toBe(validContract().contract_digest);
  });

  it("changes the digest on any semantic change", () => {
    const input = contractInput();
    const changed = definePromptContract({
      ...input,
      domain_rubric: {
        segment_id: input.domain_rubric.segment_id,
        text: `${input.domain_rubric.text} Amended.`,
      },
    });
    expect(changed.contract_digest).not.toBe(validContract().contract_digest);
  });

  it("seals output schema digests from the exported schema documents", () => {
    const input = contractInput();
    expect(input.output_schema_id).toBe("prd-proposal-draft");
    const document =
      PROTOCOL_1_1_SCHEMA_REGISTRY.documents()[`${input.output_schema_id}.schema.json`];
    expect(document).toBeDefined();
    expect(input.output_schema_digest).toBe(contentDigest(document));
    expect(validContract().port_id).toBe(PRD_PROPOSAL_PROMPT_PORT_ID);
  });
});
