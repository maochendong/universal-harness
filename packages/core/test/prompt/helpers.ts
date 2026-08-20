import { definePromptContract } from "../../src/prompt/contracts.js";
import {
  createPromptContractRegistry,
  type PromptContractBinding,
  type PromptContractRegistration,
  type PromptContractResolution,
  type PromptContractRegistry,
} from "../../src/prompt/registry.js";
import { PRD_PROPOSAL_PROMPT_REGISTRATION } from "../../src/proposal/prompt-contract.js";
import { PRD_REVIEW_PROMPT_REGISTRATION } from "../../src/review/prompt-contract.js";
import type { GroundedSynthesisPurpose, ModelSlotId } from "../../src/schema/profile.js";
import {
  APPROVAL_BRIEF_PROMPT_REGISTRATION,
  PROJECT_DISCOVERY_PROMPT_REGISTRATION,
} from "../../src/synthesis/prompt-contracts.js";

/**
 * Shared prompt-contract registries for the PG-0 tests. The Capture registry
 * holds only the four domain-owned contracts registered by PG-0; the
 * operation-scope slots (impact_advisory, design_review, plan_proposal,
 * feedback_analysis, context_enrichment, iteration_narrative) receive minimal
 * test-owned stub contracts under their final contract ids so the Capability
 * Compiler can resolve bindings before PG-3…PG-7 land the real domain
 * contracts. Stub digests are expected to rotate when those work packages
 * replace the stub content.
 */
export function createCapturePromptContractRegistry(): PromptContractRegistry {
  return createPromptContractRegistry([
    PRD_PROPOSAL_PROMPT_REGISTRATION,
    PRD_REVIEW_PROMPT_REGISTRATION,
    PROJECT_DISCOVERY_PROMPT_REGISTRATION,
    APPROVAL_BRIEF_PROMPT_REGISTRATION,
  ]);
}

const OPERATION_STUB_OUTPUT_SCHEMA_KEYS: Record<string, string> = {
  "impact_advisory:": "prd-validation-report",
  "design_review:": "prd-review-report-draft",
  "plan_proposal:": "prd-proposal-draft",
  "feedback_analysis:": "prd-validation-report",
  "grounded_synthesis:context_enrichment": "context-enrichment-output",
  "grounded_synthesis:iteration_narrative": "iteration-narrative-output",
};

function stubSegment(segmentId: string, text: string) {
  return { segment_id: segmentId, text };
}

/** Minimal test-owned stub contract for one operation-scope slot/purpose. */
export function stubOperationPromptRegistration(
  slotId: ModelSlotId,
  purpose?: GroundedSynthesisPurpose,
): PromptContractRegistration {
  const scopeKey = `${slotId}:${purpose ?? ""}`;
  const outputSchemaKey = OPERATION_STUB_OUTPUT_SCHEMA_KEYS[scopeKey];
  if (outputSchemaKey === undefined) {
    throw new Error(`no stub output schema registered for ${scopeKey}`);
  }
  const kebab = (purpose ?? slotId).replaceAll("_", "-");
  const contract = definePromptContract({
    contract_id: `harness:prompt:${kebab}`,
    port_id: slotId,
    ...(purpose === undefined ? {} : { purpose }),
    version: "1.0.0",
    authority_boundary: stubSegment(
      "authority-boundary",
      `PG-0 test stub authority boundary for ${scopeKey}; replaced by the owning domain work package.`,
    ),
    role_instruction: stubSegment("role", `PG-0 test stub role for ${scopeKey}.`),
    domain_rubric: stubSegment("domain-rubric", `PG-0 test stub rubric for ${scopeKey}.`),
    profile_overlays: {
      lite: stubSegment("profile-lite", `PG-0 test stub lite overlay for ${scopeKey}.`),
      standard: stubSegment("profile-standard", `PG-0 test stub standard overlay for ${scopeKey}.`),
      governed: stubSegment("profile-governed", `PG-0 test stub governed overlay for ${scopeKey}.`),
    },
    output_schema_id: outputSchemaKey,
    source_delimiter_version: "source-delimiter.v1",
  });
  return { contract, prompt_versions: [`${slotId}.v1`] };
}

export const OPERATION_SCOPE_STUB_REGISTRATIONS: readonly PromptContractRegistration[] = [
  stubOperationPromptRegistration("impact_advisory"),
  stubOperationPromptRegistration("design_review"),
  stubOperationPromptRegistration("plan_proposal"),
  stubOperationPromptRegistration("feedback_analysis"),
  stubOperationPromptRegistration("grounded_synthesis", "context_enrichment"),
  stubOperationPromptRegistration("grounded_synthesis", "iteration_narrative"),
];

export function createOperationPromptContractRegistry(): PromptContractRegistry {
  return createPromptContractRegistry(OPERATION_SCOPE_STUB_REGISTRATIONS);
}

/** Capture contracts plus the operation-scope stubs (Capability Compiler tests). */
export function createTestPromptContractRegistry(): PromptContractRegistry {
  return createPromptContractRegistry([
    PRD_PROPOSAL_PROMPT_REGISTRATION,
    PRD_REVIEW_PROMPT_REGISTRATION,
    PROJECT_DISCOVERY_PROMPT_REGISTRATION,
    APPROVAL_BRIEF_PROMPT_REGISTRATION,
    ...OPERATION_SCOPE_STUB_REGISTRATIONS,
  ]);
}

/** The four binding-pinned fields of a resolution (drops the schema id). */
export function bindingContractFields(resolution: PromptContractResolution): PromptContractBinding {
  return {
    prompt_contract_id: resolution.prompt_contract_id,
    prompt_contract_version: resolution.prompt_contract_version,
    prompt_contract_digest: resolution.prompt_contract_digest,
    output_schema_digest: resolution.output_schema_digest,
  };
}
