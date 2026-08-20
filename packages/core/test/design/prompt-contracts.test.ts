import { describe, expect, it } from "vitest";

import { createPromptContractRegistry } from "../../src/prompt/index.js";
import {
  DESIGN_PROPOSAL_PROMPT_CONTRACT,
  DESIGN_PROPOSAL_PROMPT_REGISTRATION,
  DESIGN_PROPOSAL_PROMPT_VERSION,
  DESIGN_REVIEW_PROMPT_CONTRACT,
  DESIGN_REVIEW_PROMPT_REGISTRATION,
  DESIGN_REVIEW_PROMPT_VERSION,
} from "../../src/design/prompt-contracts.js";

/**
 * PG-4: two fully isolated design prompt contracts. Proposal and review
 * never share a contract, an output schema or a prompt version, so even the
 * same model cannot self-review through a hidden channel. The contracts pin
 * the authority boundary: the proposal never fabricates structure edges,
 * execution facts or approvals; the review only ever returns the three
 * verdicts and structured findings.
 */
describe("design prompt contracts", () => {
  const registry = createPromptContractRegistry([
    DESIGN_PROPOSAL_PROMPT_REGISTRATION,
    DESIGN_REVIEW_PROMPT_REGISTRATION,
  ]);

  it("resolves the design_proposal port to its own contract and output schema", () => {
    const resolution = registry.resolve({
      port_id: "design_proposal",
      prompt_version: DESIGN_PROPOSAL_PROMPT_VERSION,
    });
    expect(resolution.prompt_contract_id).toBe("harness:prompt:design-proposal");
    expect(resolution.output_schema_id).toBe("design-proposal-output");
    expect(resolution.prompt_contract_digest).toBe(DESIGN_PROPOSAL_PROMPT_CONTRACT.contract_digest);
  });

  it("resolves the design_review port to its own contract and output schema", () => {
    const resolution = registry.resolve({
      port_id: "design_review",
      prompt_version: DESIGN_REVIEW_PROMPT_VERSION,
    });
    expect(resolution.prompt_contract_id).toBe("harness:prompt:design-review");
    expect(resolution.output_schema_id).toBe("design-review-output");
    expect(resolution.prompt_contract_digest).toBe(DESIGN_REVIEW_PROMPT_CONTRACT.contract_digest);
  });

  it("keeps proposal and review contracts fully distinct", () => {
    expect(DESIGN_PROPOSAL_PROMPT_CONTRACT.contract_digest).not.toBe(
      DESIGN_REVIEW_PROMPT_CONTRACT.contract_digest,
    );
    expect(DESIGN_PROPOSAL_PROMPT_CONTRACT.output_schema_id).not.toBe(
      DESIGN_REVIEW_PROMPT_CONTRACT.output_schema_id,
    );
    expect(DESIGN_PROPOSAL_PROMPT_VERSION).not.toBe(DESIGN_REVIEW_PROMPT_VERSION);
  });

  it("pins the authority boundaries in the compiled segments", () => {
    expect(DESIGN_PROPOSAL_PROMPT_CONTRACT.authority_boundary.text).toContain("never approve");
    expect(DESIGN_REVIEW_PROMPT_CONTRACT.authority_boundary.text).toContain("accept_recommended");
    expect(DESIGN_REVIEW_PROMPT_CONTRACT.authority_boundary.text).toContain("never approve");
  });

  it("fails closed on cross-port version aliases", () => {
    expect(() =>
      registry.resolve({
        port_id: "design_proposal",
        prompt_version: DESIGN_REVIEW_PROMPT_VERSION,
      }),
    ).toThrowError(/no prompt contract resolves/);
  });
});
