import { describe, expect, it } from "vitest";

import { createPromptContractRegistry } from "../../../core/src/index.js";

import {
  PLAN_PROPOSAL_PROMPT_CONTRACT,
  PLAN_PROPOSAL_PROMPT_REGISTRATION,
  PLAN_PROPOSAL_PROMPT_VERSION,
} from "../../src/planning/plan-prompt-contract.js";

/**
 * PG-5: the plan proposal contract exposes only Harness-compiled canonical
 * assertion descriptors and bound digests; the model allocates, the Harness
 * compiles. The contract pins that boundary in text and pins the output
 * schema digest by construction.
 */
describe("plan proposal prompt contract", () => {
  it("resolves the plan_proposal port to its contract and output schema", () => {
    const registry = createPromptContractRegistry([PLAN_PROPOSAL_PROMPT_REGISTRATION]);
    const resolution = registry.resolve({
      port_id: "plan_proposal",
      prompt_version: PLAN_PROPOSAL_PROMPT_VERSION,
    });
    expect(resolution.prompt_contract_id).toBe("harness:prompt:plan-proposal");
    expect(resolution.output_schema_id).toBe("plan-proposal-output");
    expect(resolution.prompt_contract_digest).toBe(PLAN_PROPOSAL_PROMPT_CONTRACT.contract_digest);
  });

  it("pins the allocate-only authority boundary", () => {
    const text = PLAN_PROPOSAL_PROMPT_CONTRACT.authority_boundary.text;
    expect(text).toContain("never create");
    expect(text).toContain("assertion");
    expect(PLAN_PROPOSAL_PROMPT_CONTRACT.domain_rubric.text).toContain("Allocate");
  });
});
