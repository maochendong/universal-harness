import { describe, expect, it } from "vitest";

import { PromptContractError } from "../../src/prompt/contracts.js";
import type { PromptContractResolver, PromptContractSelector } from "../../src/prompt/registry.js";
import {
  PRD_PROPOSAL_PROMPT_CONTRACT,
  PRD_PROPOSAL_PROMPT_PORT_ID,
  PRD_PROPOSAL_PROMPT_VERSION,
  inMemoryCaptureProposalProfile,
  manualCaptureProposalProfile,
  promptBindingOfProposalProfile,
  resolveModelBackedProposalProfile,
  validateCaptureProposalProfile,
} from "../../src/proposal/prompt-contract.js";
import { createCapturePromptContractRegistry } from "../prompt/helpers.js";

const ADAPTER_PROFILE_DIGEST = "e".repeat(64);
const PROMPT_VERSION_DIGEST = "f".repeat(64);

function baseProfile() {
  return {
    adapter_profile_digest: ADAPTER_PROFILE_DIGEST,
    prompt_version_digest: PROMPT_VERSION_DIGEST,
    producer_identity: "test-producer",
  };
}

function countingResolver(registry: ReturnType<typeof createCapturePromptContractRegistry>) {
  const selectors: PromptContractSelector[] = [];
  const resolver: PromptContractResolver = {
    resolve(selector) {
      selectors.push(selector);
      return registry.resolve(selector);
    },
  };
  return { resolver, selectors };
}

describe("model-backed capture proposal profile", () => {
  it("resolves contract id/version/digest and output schema digest from the registry", () => {
    const registry = createCapturePromptContractRegistry();
    const { resolver, selectors } = countingResolver(registry);
    const profile = resolveModelBackedProposalProfile({
      resolver,
      ...baseProfile(),
      prompt_version: PRD_PROPOSAL_PROMPT_VERSION,
    });
    expect(selectors).toEqual([
      { port_id: PRD_PROPOSAL_PROMPT_PORT_ID, prompt_version: PRD_PROPOSAL_PROMPT_VERSION },
    ]);
    expect(profile).toEqual({
      backing: "model",
      ...baseProfile(),
      prompt_version: PRD_PROPOSAL_PROMPT_VERSION,
      prompt_contract_id: "harness:prompt:prd-proposal",
      prompt_contract_version: "1.0.0",
      prompt_contract_digest: PRD_PROPOSAL_PROMPT_CONTRACT.contract_digest,
      output_schema_digest: PRD_PROPOSAL_PROMPT_CONTRACT.output_schema_digest,
    });
    expect(validateCaptureProposalProfile(profile)).toEqual({ valid: true, errors: [] });
  });

  it("rejects hand-supplied contract digests and unresolved versions fail-closed", () => {
    const registry = createCapturePromptContractRegistry();
    try {
      resolveModelBackedProposalProfile({
        resolver: registry,
        ...baseProfile(),
        prompt_version: PRD_PROPOSAL_PROMPT_VERSION,
        prompt_contract_digest: "0".repeat(64),
      } as never);
      expect.unreachable("hand-supplied digests must fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(PromptContractError);
      expect((error as PromptContractError).code).toBe("prompt_contract_digest_mismatch");
    }
    try {
      resolveModelBackedProposalProfile({
        resolver: registry,
        ...baseProfile(),
        prompt_version: "prd-proposal.v404",
      });
      expect.unreachable("unknown prompt versions must fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(PromptContractError);
      expect((error as PromptContractError).code).toBe("prompt_contract_version_mismatch");
    }
  });

  it("rejects model-backed profiles missing contract fields at configuration time", () => {
    const registry = createCapturePromptContractRegistry();
    const profile = resolveModelBackedProposalProfile({
      resolver: registry,
      ...baseProfile(),
      prompt_version: PRD_PROPOSAL_PROMPT_VERSION,
    }) as unknown as Record<string, unknown>;

    for (const field of [
      "prompt_contract_id",
      "prompt_contract_version",
      "prompt_contract_digest",
      "output_schema_digest",
    ]) {
      const incomplete = { ...profile };
      delete incomplete[field];
      expect(validateCaptureProposalProfile(incomplete).valid, field).toBe(false);
    }
    expect(validateCaptureProposalProfile({ ...profile, backing: "manual" }).valid).toBe(false);
    expect(validateCaptureProposalProfile({ ...profile, backing: "mysterious" }).valid).toBe(false);
  });
});

describe("non-model capture proposal profiles", () => {
  it("keeps manual and in-memory variants valid without any contract field", () => {
    const manual = manualCaptureProposalProfile(baseProfile());
    const inMemory = inMemoryCaptureProposalProfile(baseProfile());
    expect(manual.backing).toBe("manual");
    expect(inMemory.backing).toBe("in_memory");
    expect(validateCaptureProposalProfile(manual)).toEqual({ valid: true, errors: [] });
    expect(validateCaptureProposalProfile(inMemory)).toEqual({ valid: true, errors: [] });
  });

  it("produces zero prompt contract bindings — no compilation, no invocation", () => {
    const registry = createCapturePromptContractRegistry();
    const { resolver, selectors } = countingResolver(registry);
    const manual = manualCaptureProposalProfile(baseProfile());
    const inMemory = inMemoryCaptureProposalProfile(baseProfile());

    expect(promptBindingOfProposalProfile(manual, resolver)).toBeUndefined();
    expect(promptBindingOfProposalProfile(inMemory, resolver)).toBeUndefined();
    expect(selectors).toEqual([]);

    const model = resolveModelBackedProposalProfile({
      resolver,
      ...baseProfile(),
      prompt_version: PRD_PROPOSAL_PROMPT_VERSION,
    });
    expect(promptBindingOfProposalProfile(model, resolver)).toEqual({
      prompt_contract_id: model.prompt_contract_id,
      prompt_contract_version: model.prompt_contract_version,
      prompt_contract_digest: model.prompt_contract_digest,
      output_schema_digest: model.output_schema_digest,
    });
  });
});
