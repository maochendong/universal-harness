import {
  APPROVAL_BRIEF_PROMPT_REGISTRATION,
  CONTEXT_ENRICHMENT_PROMPT_REGISTRATION,
  DESIGN_PROPOSAL_PROMPT_REGISTRATION,
  DESIGN_REVIEW_PROMPT_REGISTRATION,
  ITERATION_NARRATIVE_PROMPT_REGISTRATION,
  PRD_PROPOSAL_PROMPT_REGISTRATION,
  PRD_REVIEW_PROMPT_REGISTRATION,
  PROJECT_DISCOVERY_PROMPT_REGISTRATION,
  createPromptContractRegistry,
  type PromptContractRegistry,
} from "@universal-harness-internal/core";
import { IMPACT_ADVISORY_PROMPT_REGISTRATION } from "@universal-harness-internal/graph";
import { FEEDBACK_ANALYSIS_PROMPT_REGISTRATION } from "@universal-harness-internal/eval";
import { PLAN_PROPOSAL_PROMPT_REGISTRATION } from "@universal-harness-internal/runtime";

/**
 * The production composition point for the shipped prompt contracts (PG-8):
 * every domain registration across core, graph, eval and runtime composes
 * into one registry. Composition re-verifies every contract digest and
 * fails closed on any conflict or drift — this is what `harness doctor`
 * probes.
 */
export const SHIPPED_PROMPT_CONTRACT_REGISTRATIONS = [
  PRD_PROPOSAL_PROMPT_REGISTRATION,
  PRD_REVIEW_PROMPT_REGISTRATION,
  PROJECT_DISCOVERY_PROMPT_REGISTRATION,
  APPROVAL_BRIEF_PROMPT_REGISTRATION,
  CONTEXT_ENRICHMENT_PROMPT_REGISTRATION,
  ITERATION_NARRATIVE_PROMPT_REGISTRATION,
  DESIGN_PROPOSAL_PROMPT_REGISTRATION,
  DESIGN_REVIEW_PROMPT_REGISTRATION,
  IMPACT_ADVISORY_PROMPT_REGISTRATION,
  PLAN_PROPOSAL_PROMPT_REGISTRATION,
  FEEDBACK_ANALYSIS_PROMPT_REGISTRATION,
] as const;

export function createShippedPromptContractRegistry(): PromptContractRegistry {
  return createPromptContractRegistry(SHIPPED_PROMPT_CONTRACT_REGISTRATIONS);
}

/** The doctor probe shape: a clean composition or the conflict detail. */
export function probeShippedPromptRegistry(): {
  readonly contractCount: number;
  readonly compositionError?: string;
} {
  try {
    createShippedPromptContractRegistry();
    return { contractCount: SHIPPED_PROMPT_CONTRACT_REGISTRATIONS.length };
  } catch (error) {
    return {
      contractCount: 0,
      compositionError: error instanceof Error ? error.message : String(error),
    };
  }
}
