import type {
  ApprovalBriefInput,
  ContextEnrichmentInput,
  GroundedSynthesisOutput,
  IterationNarrativeInput,
  ProjectDiscoveryInput,
} from "../schema/synthesis.js";

/**
 * GroundedSynthesisPort contract (model advisory design 10). Fixed to four
 * purposes, each with its own versioned input/output schema; this is not a
 * dynamic prompt/schema port. Every call gets an independent conversation
 * and run identity — adapters may share vendor/model/executable but never
 * hidden history.
 */
export const GROUNDED_SYNTHESIS_FAILURE_CODES = [
  "provider_required",
  "provider_unavailable",
  "invalid_output",
  "citation_missing",
  "citation_invalid",
  "binding_drift",
  "independence_violation",
  "version_mismatch",
  "unknown_purpose",
  "bundle_stale",
  "policy_denied",
  "uncertain",
] as const;
export type GroundedSynthesisFailureCode = (typeof GROUNDED_SYNTHESIS_FAILURE_CODES)[number];

export interface GroundedSynthesisFailure {
  readonly code: GroundedSynthesisFailureCode;
  readonly summary: string;
  readonly retryable: boolean;
}

/**
 * Every purpose graduated to its versioned input schema (T7/T14/T17); the
 * strict input/output pairs below are the only shapes the port accepts.
 */
export type GroundedSynthesisInput =
  ProjectDiscoveryInput | ContextEnrichmentInput | ApprovalBriefInput | IterationNarrativeInput;

export type GroundedSynthesisResult =
  | { readonly status: "completed"; readonly output: GroundedSynthesisOutput }
  | { readonly status: "failed"; readonly failure: GroundedSynthesisFailure };

export interface GroundedSynthesisPort {
  readonly name: string;
  synthesize(
    input: GroundedSynthesisInput,
  ): Promise<GroundedSynthesisResult> | GroundedSynthesisResult;
}
