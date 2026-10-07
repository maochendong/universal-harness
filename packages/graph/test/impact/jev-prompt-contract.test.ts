import { describe, expect, it } from "vitest";

import { createPromptContractRegistry } from "@universal-harness-internal/core";

import {
  JEV_IMPACT_CRITERIA,
  JEV_IMPACT_PROMPT_CONTRACT,
  JEV_IMPACT_PROMPT_REGISTRATION,
  JEV_IMPACT_PROMPT_VERSION,
} from "../../src/impact/jev-prompt-contract.js";

describe("Jev impact prompt contract", () => {
  it("resolves the existing slot to the raw judgments schema with a complete bounded rubric", () => {
    const registry = createPromptContractRegistry([JEV_IMPACT_PROMPT_REGISTRATION]);
    expect(
      registry.resolve({ port_id: "impact_advisory", prompt_version: JEV_IMPACT_PROMPT_VERSION }),
    ).toMatchObject({
      prompt_contract_id: "harness:prompt:jev-impact-advisory",
      prompt_contract_version: "1.0.0",
      output_schema_id: "jev-impact-judgments",
    });
    expect(Object.keys(JEV_IMPACT_CRITERIA).sort()).toEqual([
      "affected",
      "insufficient",
      "unrelated",
    ]);
    expect(JEV_IMPACT_PROMPT_CONTRACT.domain_rubric.text).toContain(
      "Missing facts cannot establish unrelated",
    );
    expect(JEV_IMPACT_PROMPT_CONTRACT.authority_boundary.text).toContain("never approve");
    expect(Object.keys(JEV_IMPACT_PROMPT_CONTRACT.profile_overlays).sort()).toEqual([
      "governed",
      "lite",
      "standard",
    ]);
  });
});
