import { PROMPT_PREPARATION_FAILURE_CODES } from "../schema/prompt.js";
import {
  GROUNDED_SYNTHESIS_FAILURE_CODES,
  type GroundedSynthesisFailureCode,
} from "../synthesis/port.js";

/**
 * The fixed failure code → layer → authoritative carrier mapping (prompt
 * governance addendum design 9.1.1). Every code has exactly one layer and one
 * authoritative carrier; a GroundedSynthesisFailure only ever projects an
 * existing invocation-layer or domain-layer fact — it is never a second
 * truth. Unknown codes fail closed instead of being guessed into a carrier.
 */
export const PROMPT_FAILURE_LAYERS = ["prompt_preparation", "model_invocation", "domain"] as const;
export type PromptFailureLayer = (typeof PROMPT_FAILURE_LAYERS)[number];

export const PROMPT_FAILURE_CARRIERS = [
  "prompt_preparation_failure",
  "model_invocation_record",
  "domain_typed_outcome",
] as const;
export type PromptFailureCarrier = (typeof PROMPT_FAILURE_CARRIERS)[number];

export interface PromptFailureDisposition {
  readonly layer: PromptFailureLayer;
  readonly carrier: PromptFailureCarrier;
}

/** Model invocation orchestration/execution codes (addendum design 9.1.1). */
export const MODEL_INVOCATION_FAILURE_CODES = [
  "provider_required",
  "provider_unavailable",
  "timeout",
  "budget_exhausted",
  "invalid_output",
  "independence_violation",
  "version_mismatch",
  "policy_denied",
  "uncertain",
] as const;
export type ModelInvocationFailureCode = (typeof MODEL_INVOCATION_FAILURE_CODES)[number];

/** Domain preflight/validation/consumption codes (addendum design 9.1.1). */
export const DOMAIN_VALIDATION_FAILURE_CODES = [
  "binding_drift",
  "bundle_stale",
  "unknown_purpose",
  "citation_missing",
  "citation_invalid",
] as const;
export type DomainValidationFailureCode = (typeof DOMAIN_VALIDATION_FAILURE_CODES)[number];

export class UnknownPromptFailureCodeError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Unknown prompt failure code: ${code}`);
    this.name = "UnknownPromptFailureCodeError";
    this.code = code;
  }
}

const DISPOSITIONS: ReadonlyMap<string, PromptFailureDisposition> = (() => {
  const dispositions = new Map<string, PromptFailureDisposition>();
  const register = (codes: readonly string[], disposition: PromptFailureDisposition) => {
    for (const code of codes) {
      if (dispositions.has(code)) {
        throw new Error(`prompt failure code ${code} registered in two layers`);
      }
      dispositions.set(code, disposition);
    }
  };
  register(PROMPT_PREPARATION_FAILURE_CODES, {
    layer: "prompt_preparation",
    carrier: "prompt_preparation_failure",
  });
  register(MODEL_INVOCATION_FAILURE_CODES, {
    layer: "model_invocation",
    carrier: "model_invocation_record",
  });
  register(DOMAIN_VALIDATION_FAILURE_CODES, {
    layer: "domain",
    carrier: "domain_typed_outcome",
  });
  return dispositions;
})();

/** The one authoritative layer/carrier for a code; unknown codes fail closed. */
export function promptFailureDisposition(code: string): PromptFailureDisposition {
  const disposition = DISPOSITIONS.get(code);
  if (disposition === undefined) {
    throw new UnknownPromptFailureCodeError(code);
  }
  return disposition;
}

/**
 * Read-only projection for GroundedSynthesisFailure: the port may only
 * project codes its contract already declares (invocation-layer and
 * domain-layer facts). Preparation codes and unknown codes fail closed.
 */
export function groundedSynthesisFailureProjection(
  code: GroundedSynthesisFailureCode,
): PromptFailureDisposition {
  if (!(GROUNDED_SYNTHESIS_FAILURE_CODES as readonly string[]).includes(code)) {
    throw new UnknownPromptFailureCodeError(code);
  }
  return promptFailureDisposition(code);
}
