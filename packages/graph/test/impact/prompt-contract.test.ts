import { describe, expect, it } from "vitest";

import { createPromptContractRegistry } from "@universal-harness-internal/core";

import {
  IMPACT_ADVISORY_PROMPT_CONTRACT,
  IMPACT_ADVISORY_PROMPT_REGISTRATION,
  IMPACT_ADVISORY_PROMPT_VERSION,
} from "../../src/impact/prompt-contract.js";

/**
 * PG-3: the graph domain owns the real impact-advisory contract. The core
 * test registry keeps its PG-0 stub (core must not import graph); production
 * composition registers this contract instead.
 */
describe("impact advisory prompt contract", () => {
  it("resolves the impact_advisory slot to the advisory output schema", () => {
    const registry = createPromptContractRegistry([IMPACT_ADVISORY_PROMPT_REGISTRATION]);
    const resolution = registry.resolve({
      port_id: "impact_advisory",
      prompt_version: IMPACT_ADVISORY_PROMPT_VERSION,
    });
    expect(resolution.prompt_contract_id).toBe("harness:prompt:impact-advisory");
    expect(resolution.prompt_contract_version).toBe("1.0.0");
    expect(resolution.output_schema_id).toBe("impact-advisory-output");
    expect(resolution.prompt_contract_digest).toBe(IMPACT_ADVISORY_PROMPT_CONTRACT.contract_digest);
  });

  it("fails closed on an unknown prompt_version alias", () => {
    const registry = createPromptContractRegistry([IMPACT_ADVISORY_PROMPT_REGISTRATION]);
    expect(() =>
      registry.resolve({ port_id: "impact_advisory", prompt_version: "impact_advisory.v0" }),
    ).toThrowError(/no prompt contract resolves/);
  });

  it("pins the additive-only authority boundary in the compiled segments", () => {
    expect(IMPACT_ADVISORY_PROMPT_CONTRACT.authority_boundary.text).toContain("additive");
    expect(IMPACT_ADVISORY_PROMPT_CONTRACT.authority_boundary.text).toContain("never");
  });
});
