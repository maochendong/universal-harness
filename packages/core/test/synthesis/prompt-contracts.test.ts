import { describe, expect, it } from "vitest";

import { contentDigest } from "../../src/identity/digest.js";
import { PromptContractError } from "../../src/prompt/contracts.js";
import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../../src/schema/registry.js";
import {
  APPROVAL_BRIEF_PROMPT_CONTRACT,
  APPROVAL_BRIEF_PROMPT_VERSION,
  PROJECT_DISCOVERY_PROMPT_CONTRACT,
  PROJECT_DISCOVERY_PROMPT_VERSION,
} from "../../src/synthesis/prompt-contracts.js";
import { createCapturePromptContractRegistry } from "../prompt/helpers.js";

describe("grounded synthesis prompt contracts", () => {
  it("registers project discovery and approval brief as domain-owned contracts", () => {
    expect(PROJECT_DISCOVERY_PROMPT_CONTRACT.contract_id).toBe("harness:prompt:project-discovery");
    expect(PROJECT_DISCOVERY_PROMPT_CONTRACT.port_id).toBe("grounded_synthesis");
    expect(PROJECT_DISCOVERY_PROMPT_CONTRACT.purpose).toBe("project_discovery");
    expect(PROJECT_DISCOVERY_PROMPT_CONTRACT.version).toBe("1.0.0");
    expect(APPROVAL_BRIEF_PROMPT_CONTRACT.contract_id).toBe("harness:prompt:approval-brief");
    expect(APPROVAL_BRIEF_PROMPT_CONTRACT.purpose).toBe("approval_brief");

    for (const contract of [PROJECT_DISCOVERY_PROMPT_CONTRACT, APPROVAL_BRIEF_PROMPT_CONTRACT]) {
      expect(
        PROTOCOL_1_1_SCHEMA_REGISTRY.validate("prompt-contract", contract),
        contract.contract_id,
      ).toEqual({ valid: true, errors: [] });
    }
  });

  it("binds the output schema digest to the exported schema documents", () => {
    const documents = PROTOCOL_1_1_SCHEMA_REGISTRY.documents();
    expect(PROJECT_DISCOVERY_PROMPT_CONTRACT.output_schema_id).toBe("project-discovery-output");
    expect(PROJECT_DISCOVERY_PROMPT_CONTRACT.output_schema_digest).toBe(
      contentDigest(documents["project-discovery-output.schema.json"]),
    );
    expect(APPROVAL_BRIEF_PROMPT_CONTRACT.output_schema_id).toBe("approval-brief-output");
    expect(APPROVAL_BRIEF_PROMPT_CONTRACT.output_schema_digest).toBe(
      contentDigest(documents["approval-brief-output.schema.json"]),
    );
  });

  it("resolves through the registry and rejects cross-purpose aliases fail-closed", () => {
    const registry = createCapturePromptContractRegistry();
    const discovery = registry.resolve({
      port_id: "grounded_synthesis",
      purpose: "project_discovery",
      prompt_version: PROJECT_DISCOVERY_PROMPT_VERSION,
    });
    expect(discovery.prompt_contract_digest).toBe(
      PROJECT_DISCOVERY_PROMPT_CONTRACT.contract_digest,
    );

    // The discovery alias must never resolve the approval-brief contract.
    try {
      registry.resolve({
        port_id: "grounded_synthesis",
        purpose: "approval_brief",
        prompt_version: PROJECT_DISCOVERY_PROMPT_VERSION,
      });
      expect.unreachable("cross-purpose alias resolution must fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(PromptContractError);
      expect((error as PromptContractError).code).toBe("prompt_contract_version_mismatch");
    }

    const brief = registry.resolve({
      port_id: "grounded_synthesis",
      purpose: "approval_brief",
      prompt_version: APPROVAL_BRIEF_PROMPT_VERSION,
    });
    expect(brief.prompt_contract_digest).toBe(APPROVAL_BRIEF_PROMPT_CONTRACT.contract_digest);
    expect(brief.prompt_contract_digest).not.toBe(discovery.prompt_contract_digest);
  });
});
