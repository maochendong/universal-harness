import type { GroundedSynthesisPurpose } from "../schema/profile.js";
import type {
  ApprovalBriefInput,
  GroundedSynthesisOutput,
  ProjectDiscoveryInput,
} from "../schema/synthesis.js";
import type { DigestSchema } from "../schema/common.js";
import type { Static } from "@sinclair/typebox";

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
 * Minimal inputs for the purposes whose compilers land in later tasks
 * (context_enrichment T14, iteration_narrative T17). They still pin the
 * purpose, schema version, binding and bundle so the isolation and versioning
 * rules already apply uniformly. `approval_brief` graduated to its versioned
 * input schema in T7 (`ApprovalBriefInputSchema` in schema/synthesis).
 */
export interface GroundedSynthesisStubInput<P extends GroundedSynthesisPurpose> {
  readonly purpose: P;
  readonly schema_version: string;
  readonly binding_digest: Static<typeof DigestSchema>;
  readonly conversation_id: string;
  readonly run_id: string;
  readonly bundle_digest: string;
}

export type ContextEnrichmentInput = GroundedSynthesisStubInput<"context_enrichment">;
export type IterationNarrativeInput = GroundedSynthesisStubInput<"iteration_narrative">;

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
