import { describe, expect, it } from "vitest";

import { PLAN_PROPOSAL_PROMPT_VERSION } from "@universal-harness-internal/runtime";
import { DESIGN_PROPOSAL_PROMPT_VERSION } from "@universal-harness-internal/core";

import {
  SHIPPED_PROMPT_CONTRACT_REGISTRATIONS,
  createShippedPromptContractRegistry,
  probeShippedPromptRegistry,
} from "../src/prompt-registry.js";

/**
 * PG-8 production composition point: every shipped domain contract composes
 * into one registry; the doctor probe reports a clean composition or the
 * conflict detail, and never throws.
 */
describe("shipped prompt contract registry", () => {
  it("composes every domain registration and resolves their aliases", () => {
    const registry = createShippedPromptContractRegistry();
    expect(SHIPPED_PROMPT_CONTRACT_REGISTRATIONS).toHaveLength(11);
    expect(
      registry.resolve({
        port_id: "design_proposal",
        prompt_version: DESIGN_PROPOSAL_PROMPT_VERSION,
      }).prompt_contract_id,
    ).toBe("harness:prompt:design-proposal");
    expect(
      registry.resolve({
        port_id: "plan_proposal",
        prompt_version: PLAN_PROPOSAL_PROMPT_VERSION,
      }).prompt_contract_id,
    ).toBe("harness:prompt:plan-proposal");
    expect(
      registry.resolve({
        port_id: "grounded_synthesis",
        purpose: "iteration_narrative",
        prompt_version: "iteration-narrative.v1",
      }).prompt_contract_id,
    ).toBe("harness:prompt:iteration-narrative");
  });

  it("reports a clean probe for the doctor check", () => {
    const probe = probeShippedPromptRegistry();
    expect(probe.compositionError).toBeUndefined();
    expect(probe.contractCount).toBe(11);
  });
});
