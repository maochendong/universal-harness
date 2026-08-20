import { describe, expect, it } from "vitest";

import { PromptContractError } from "../../src/prompt/contracts.js";
import type { PromptContractResolver, PromptContractSelector } from "../../src/prompt/registry.js";
import {
  PRD_REVIEW_PROMPT_CONTRACT,
  PRD_REVIEW_PROMPT_PORT_ID,
  PRD_REVIEW_PROMPT_VERSION,
  inMemoryCaptureReviewProfile,
  manualCaptureReviewProfile,
  promptBindingOfReviewProfile,
  resolveModelBackedReviewProfile,
  validateCaptureReviewProfile,
} from "../../src/review/prompt-contract.js";
import { createCapturePromptContractRegistry } from "../prompt/helpers.js";

const ADAPTER_PROFILE_DIGEST = "e".repeat(64);
const PROMPT_VERSION_DIGEST = "f".repeat(64);

function baseProfile() {
  return {
    adapter_profile_digest: ADAPTER_PROFILE_DIGEST,
    prompt_version_digest: PROMPT_VERSION_DIGEST,
    reviewer_identity: "human:reviewer",
  };
}

describe("model-backed capture review profile", () => {
  it("resolves contract fields from the registry and validates", () => {
    const registry = createCapturePromptContractRegistry();
    const selectors: PromptContractSelector[] = [];
    const resolver: PromptContractResolver = {
      resolve(selector) {
        selectors.push(selector);
        return registry.resolve(selector);
      },
    };
    const profile = resolveModelBackedReviewProfile({
      resolver,
      ...baseProfile(),
      prompt_version: PRD_REVIEW_PROMPT_VERSION,
    });
    expect(selectors).toEqual([
      { port_id: PRD_REVIEW_PROMPT_PORT_ID, prompt_version: PRD_REVIEW_PROMPT_VERSION },
    ]);
    expect(profile).toEqual({
      backing: "model",
      ...baseProfile(),
      prompt_version: PRD_REVIEW_PROMPT_VERSION,
      prompt_contract_id: "harness:prompt:prd-review",
      prompt_contract_version: "1.0.0",
      prompt_contract_digest: PRD_REVIEW_PROMPT_CONTRACT.contract_digest,
      output_schema_digest: PRD_REVIEW_PROMPT_CONTRACT.output_schema_digest,
    });
    expect(validateCaptureReviewProfile(profile)).toEqual({ valid: true, errors: [] });
  });

  it("rejects hand-supplied digests and unknown versions fail-closed", () => {
    const registry = createCapturePromptContractRegistry();
    try {
      resolveModelBackedReviewProfile({
        resolver: registry,
        ...baseProfile(),
        prompt_version: PRD_REVIEW_PROMPT_VERSION,
        output_schema_digest: "0".repeat(64),
      } as never);
      expect.unreachable("hand-supplied digests must fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(PromptContractError);
      expect((error as PromptContractError).code).toBe("prompt_contract_digest_mismatch");
    }
    try {
      resolveModelBackedReviewProfile({
        resolver: registry,
        ...baseProfile(),
        prompt_version: "prd-review.v404",
      });
      expect.unreachable("unknown prompt versions must fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(PromptContractError);
      expect((error as PromptContractError).code).toBe("prompt_contract_version_mismatch");
    }
  });

  it("rejects model-backed profiles missing contract fields at configuration time", () => {
    const registry = createCapturePromptContractRegistry();
    const profile = resolveModelBackedReviewProfile({
      resolver: registry,
      ...baseProfile(),
      prompt_version: PRD_REVIEW_PROMPT_VERSION,
    }) as unknown as Record<string, unknown>;
    for (const field of [
      "prompt_contract_id",
      "prompt_contract_version",
      "prompt_contract_digest",
      "output_schema_digest",
    ]) {
      const incomplete = { ...profile };
      delete incomplete[field];
      expect(validateCaptureReviewProfile(incomplete).valid, field).toBe(false);
    }
  });
});

describe("non-model capture review profiles", () => {
  it("keeps manual and in-memory variants valid without contract fields and zero compilation", () => {
    const manual = manualCaptureReviewProfile(baseProfile());
    const inMemory = inMemoryCaptureReviewProfile(baseProfile());
    expect(validateCaptureReviewProfile(manual)).toEqual({ valid: true, errors: [] });
    expect(validateCaptureReviewProfile(inMemory)).toEqual({ valid: true, errors: [] });

    const registry = createCapturePromptContractRegistry();
    const selectors: PromptContractSelector[] = [];
    const resolver: PromptContractResolver = {
      resolve(selector) {
        selectors.push(selector);
        return registry.resolve(selector);
      },
    };
    expect(promptBindingOfReviewProfile(manual, resolver)).toBeUndefined();
    expect(promptBindingOfReviewProfile(inMemory, resolver)).toBeUndefined();
    expect(selectors).toEqual([]);
  });
});
