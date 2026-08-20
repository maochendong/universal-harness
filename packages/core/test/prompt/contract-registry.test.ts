import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PromptContractError, definePromptContract } from "../../src/prompt/contracts.js";
import {
  PROMPT_POLICY_CLAUSES,
  PROMPT_POLICY_CLAUSE_IDS,
  PromptPolicyClauseError,
  isPromptPolicyClauseId,
  promptPolicyClause,
} from "../../src/prompt/policy-clauses.js";
import {
  PromptRegistryError,
  assertBindingMatchesResolution,
  createPromptContractRegistry,
  type PromptContractRegistration,
} from "../../src/prompt/registry.js";
import {
  PRD_PROPOSAL_PROMPT_CONTRACT,
  PRD_PROPOSAL_PROMPT_PORT_ID,
  PRD_PROPOSAL_PROMPT_REGISTRATION,
  PRD_PROPOSAL_PROMPT_VERSION,
} from "../../src/proposal/prompt-contract.js";
import {
  PRD_REVIEW_PROMPT_CONTRACT,
  PRD_REVIEW_PROMPT_PORT_ID,
  PRD_REVIEW_PROMPT_VERSION,
} from "../../src/review/prompt-contract.js";
import {
  APPROVAL_BRIEF_PROMPT_CONTRACT,
  APPROVAL_BRIEF_PROMPT_VERSION,
  PROJECT_DISCOVERY_PROMPT_CONTRACT,
  PROJECT_DISCOVERY_PROMPT_VERSION,
} from "../../src/synthesis/prompt-contracts.js";
import { createCapturePromptContractRegistry } from "./helpers.js";

const goldenDirectory = join(dirname(fileURLToPath(import.meta.url)), "../golden/prompt");

function readGolden<T>(name: string): T {
  return JSON.parse(readFileSync(join(goldenDirectory, name), "utf8")) as T;
}

function contractInputOf(
  contract: typeof PRD_PROPOSAL_PROMPT_CONTRACT,
): Omit<typeof PRD_PROPOSAL_PROMPT_CONTRACT, "contract_digest"> {
  const input: Record<string, unknown> = { ...contract };
  delete input["contract_digest"];
  return input as Omit<typeof PRD_PROPOSAL_PROMPT_CONTRACT, "contract_digest">;
}

function expectRegistryError(registrations: readonly PromptContractRegistration[], kind: string) {
  try {
    createPromptContractRegistry(registrations);
    expect.unreachable(`expected registry startup failure ${kind}`);
  } catch (error) {
    expect(error).toBeInstanceOf(PromptRegistryError);
    expect((error as PromptRegistryError).kind, kind).toBe(kind);
  }
}

describe("prompt contract registry startup", () => {
  it("fails startup when the same contract id/version registers different content", () => {
    const amended = definePromptContract({
      ...contractInputOf(PRD_PROPOSAL_PROMPT_CONTRACT),
      domain_rubric: { segment_id: "domain-rubric", text: "Silently amended rubric." },
    });
    expect(amended.contract_digest).not.toBe(PRD_PROPOSAL_PROMPT_CONTRACT.contract_digest);
    expectRegistryError(
      [
        PRD_PROPOSAL_PROMPT_REGISTRATION,
        { contract: amended, prompt_versions: ["prd-proposal.v2"] },
      ],
      "contract_content_conflict",
    );
  });

  it("fails startup on exact duplicate registrations and conflicting version aliases", () => {
    expectRegistryError(
      [PRD_PROPOSAL_PROMPT_REGISTRATION, PRD_PROPOSAL_PROMPT_REGISTRATION],
      "duplicate_contract",
    );

    const nextVersion = definePromptContract({
      ...contractInputOf(PRD_PROPOSAL_PROMPT_CONTRACT),
      version: "1.1.0",
    });
    expectRegistryError(
      [
        PRD_PROPOSAL_PROMPT_REGISTRATION,
        { contract: nextVersion, prompt_versions: [PRD_PROPOSAL_PROMPT_VERSION] },
      ],
      "prompt_version_conflict",
    );
  });

  it("fails startup on digest forgery, unknown output schemas and schema drift", () => {
    const forgedDigest = {
      contract: {
        ...PRD_PROPOSAL_PROMPT_CONTRACT,
        contract_digest: "0".repeat(64),
      },
      prompt_versions: ["prd-proposal.v1"],
    };
    expectRegistryError([forgedDigest], "contract_digest_mismatch");

    const unknownSchema = {
      ...contractInputOf(PRD_PROPOSAL_PROMPT_CONTRACT),
      output_schema_id: "never-registered-output",
    };
    expect(() => definePromptContract(unknownSchema)).toThrow(PromptContractError);

    const driftedSchema = definePromptContract({
      ...contractInputOf(PRD_PROPOSAL_PROMPT_CONTRACT),
      output_schema_id: "prd-review-report-draft",
    });
    expectRegistryError(
      [
        {
          contract: { ...driftedSchema, output_schema_digest: "1".repeat(64) },
          prompt_versions: ["prd-proposal.v1"],
        },
      ],
      "output_schema_digest_mismatch",
    );
  });

  it("freezes the registry: no runtime mutation API and no mutable contract list", () => {
    const registry = createCapturePromptContractRegistry();
    expect(Object.isFrozen(registry.contracts)).toBe(true);
    expect(() =>
      (registry.contracts as unknown as unknown[]).push(PRD_PROPOSAL_PROMPT_CONTRACT),
    ).toThrow(TypeError);
    expect("register" in registry).toBe(false);
  });
});

describe("prompt contract resolution", () => {
  it("resolves each capture contract uniquely by port/purpose/prompt_version", () => {
    const registry = createCapturePromptContractRegistry();

    const proposal = registry.resolve({
      port_id: PRD_PROPOSAL_PROMPT_PORT_ID,
      prompt_version: PRD_PROPOSAL_PROMPT_VERSION,
    });
    expect(proposal).toEqual({
      prompt_contract_id: "harness:prompt:prd-proposal",
      prompt_contract_version: "1.0.0",
      prompt_contract_digest: PRD_PROPOSAL_PROMPT_CONTRACT.contract_digest,
      output_schema_id: "prd-proposal-draft",
      output_schema_digest: PRD_PROPOSAL_PROMPT_CONTRACT.output_schema_digest,
    });

    const review = registry.resolve({
      port_id: PRD_REVIEW_PROMPT_PORT_ID,
      prompt_version: PRD_REVIEW_PROMPT_VERSION,
    });
    expect(review.prompt_contract_id).toBe("harness:prompt:prd-review");
    expect(review.prompt_contract_digest).toBe(PRD_REVIEW_PROMPT_CONTRACT.contract_digest);

    const discovery = registry.resolve({
      port_id: "grounded_synthesis",
      purpose: "project_discovery",
      prompt_version: PROJECT_DISCOVERY_PROMPT_VERSION,
    });
    expect(discovery.prompt_contract_id).toBe("harness:prompt:project-discovery");
    expect(discovery.prompt_contract_digest).toBe(
      PROJECT_DISCOVERY_PROMPT_CONTRACT.contract_digest,
    );

    const brief = registry.resolve({
      port_id: "grounded_synthesis",
      purpose: "approval_brief",
      prompt_version: APPROVAL_BRIEF_PROMPT_VERSION,
    });
    expect(brief.prompt_contract_id).toBe("harness:prompt:approval-brief");
    expect(brief.prompt_contract_digest).toBe(APPROVAL_BRIEF_PROMPT_CONTRACT.contract_digest);
  });

  it("returns prompt_contract_version_mismatch for unknown ports, purposes and versions", () => {
    const registry = createCapturePromptContractRegistry();
    const mismatches = [
      { port_id: "plan_proposal", prompt_version: "plan_proposal.v1" },
      { port_id: PRD_PROPOSAL_PROMPT_PORT_ID, prompt_version: "prd-proposal.v404" },
      {
        port_id: "grounded_synthesis",
        purpose: "context_enrichment" as const,
        prompt_version: PROJECT_DISCOVERY_PROMPT_VERSION,
      },
      {
        port_id: "grounded_synthesis",
        prompt_version: PROJECT_DISCOVERY_PROMPT_VERSION,
      },
      {
        port_id: PRD_PROPOSAL_PROMPT_PORT_ID,
        purpose: "project_discovery" as const,
        prompt_version: PRD_PROPOSAL_PROMPT_VERSION,
      },
    ];
    for (const selector of mismatches) {
      try {
        registry.resolve(selector);
        expect.unreachable(`expected mismatch for ${JSON.stringify(selector)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(PromptContractError);
        expect((error as PromptContractError).code).toBe("prompt_contract_version_mismatch");
      }
    }
  });

  it("fails closed when a binding drifts from the resolved contract fields", () => {
    const registry = createCapturePromptContractRegistry();
    const resolution = registry.resolve({
      port_id: "grounded_synthesis",
      purpose: "project_discovery",
      prompt_version: PROJECT_DISCOVERY_PROMPT_VERSION,
    });
    const binding = {
      prompt_version: PROJECT_DISCOVERY_PROMPT_VERSION,
      prompt_contract_id: resolution.prompt_contract_id,
      prompt_contract_version: resolution.prompt_contract_version,
      prompt_contract_digest: resolution.prompt_contract_digest,
      output_schema_digest: resolution.output_schema_digest,
    };
    expect(() => assertBindingMatchesResolution(binding, resolution)).not.toThrow();

    const drifts = [
      { ...binding, prompt_contract_id: "harness:prompt:approval-brief" },
      { ...binding, prompt_contract_version: "1.0.1" },
      { ...binding, prompt_contract_digest: "2".repeat(64) },
      { ...binding, output_schema_digest: "3".repeat(64) },
    ];
    for (const drifted of drifts) {
      try {
        assertBindingMatchesResolution(drifted, resolution);
        expect.unreachable("expected binding drift to fail closed");
      } catch (error) {
        expect(error).toBeInstanceOf(PromptContractError);
        expect((error as PromptContractError).code).toBe("prompt_contract_version_mismatch");
      }
    }
  });
});

describe("allowlisted policy clause registry", () => {
  it("registers the four protocol clause ids with stable digests", () => {
    expect(PROMPT_POLICY_CLAUSE_IDS).toEqual([
      "require_security_negative_paths",
      "require_migration_analysis",
      "require_reviewer_segregation",
      "require_compliance_traceability",
    ]);
    for (const clauseId of PROMPT_POLICY_CLAUSE_IDS) {
      const clause = promptPolicyClause(clauseId);
      expect(clause.clause_id).toBe(clauseId);
      expect(clause.clause_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(clause).toBe(promptPolicyClause(clauseId));
    }
    expect(Object.isFrozen(PROMPT_POLICY_CLAUSES)).toBe(true);
  });

  it("rejects unknown clause ids fail-closed", () => {
    expect(isPromptPolicyClauseId("require_security_negative_paths")).toBe(true);
    expect(isPromptPolicyClauseId("drop_authority_boundary")).toBe(false);
    expect(() => promptPolicyClause("drop_authority_boundary")).toThrow(PromptPolicyClauseError);
  });
});

describe("prompt contract golden fixtures", () => {
  it("matches the committed golden fixtures byte for byte", () => {
    const golden = readGolden<Record<string, unknown>>("prompt-contracts.json");
    expect(golden).toEqual({
      "harness:prompt:approval-brief": APPROVAL_BRIEF_PROMPT_CONTRACT,
      "harness:prompt:prd-proposal": PRD_PROPOSAL_PROMPT_CONTRACT,
      "harness:prompt:prd-review": PRD_REVIEW_PROMPT_CONTRACT,
      "harness:prompt:project-discovery": PROJECT_DISCOVERY_PROMPT_CONTRACT,
    });
  });
});
