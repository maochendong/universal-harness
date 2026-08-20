import { describe, expect, it } from "vitest";

import {
  DOMAIN_VALIDATION_FAILURE_CODES,
  MODEL_INVOCATION_FAILURE_CODES,
  UnknownPromptFailureCodeError,
  groundedSynthesisFailureProjection,
  promptFailureDisposition,
} from "../../src/prompt/failure-mapping.js";
import { PROMPT_PREPARATION_FAILURE_CODES } from "../../src/schema/prompt.js";
import { GROUNDED_SYNTHESIS_FAILURE_CODES } from "../../src/synthesis/port.js";

describe("prompt failure code → layer → authoritative carrier mapping", () => {
  it("maps every preparation code to the PromptPreparationFailure carrier", () => {
    expect(PROMPT_PREPARATION_FAILURE_CODES).toEqual([
      "prompt_contract_required",
      "prompt_contract_version_mismatch",
      "prompt_contract_digest_mismatch",
      "profile_overlay_missing",
      "policy_overlay_invalid",
      "output_schema_mismatch",
      "untrusted_source_boundary_failed",
      "prompt_size_exceeded",
    ]);
    for (const code of PROMPT_PREPARATION_FAILURE_CODES) {
      expect(promptFailureDisposition(code), code).toEqual({
        layer: "prompt_preparation",
        carrier: "prompt_preparation_failure",
      });
    }
  });

  it("maps every invocation code to the ModelInvocationRecord carrier", () => {
    expect(MODEL_INVOCATION_FAILURE_CODES).toEqual([
      "provider_required",
      "provider_unavailable",
      "timeout",
      "budget_exhausted",
      "invalid_output",
      "independence_violation",
      "version_mismatch",
      "policy_denied",
      "uncertain",
    ]);
    for (const code of MODEL_INVOCATION_FAILURE_CODES) {
      expect(promptFailureDisposition(code), code).toEqual({
        layer: "model_invocation",
        carrier: "model_invocation_record",
      });
    }
  });

  it("maps every domain code to the owning-domain outcome carrier", () => {
    expect(DOMAIN_VALIDATION_FAILURE_CODES).toEqual([
      "binding_drift",
      "bundle_stale",
      "unknown_purpose",
      "citation_missing",
      "citation_invalid",
    ]);
    for (const code of DOMAIN_VALIDATION_FAILURE_CODES) {
      expect(promptFailureDisposition(code), code).toEqual({
        layer: "domain",
        carrier: "domain_typed_outcome",
      });
    }
  });

  it("assigns every code to exactly one layer and one carrier", () => {
    const all = [
      ...PROMPT_PREPARATION_FAILURE_CODES,
      ...MODEL_INVOCATION_FAILURE_CODES,
      ...DOMAIN_VALIDATION_FAILURE_CODES,
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it("fails closed on unknown codes instead of guessing a carrier", () => {
    expect(() => promptFailureDisposition("model_exploded")).toThrow(UnknownPromptFailureCodeError);
    expect(() => promptFailureDisposition("")).toThrow(UnknownPromptFailureCodeError);
  });
});

describe("grounded synthesis failure projection", () => {
  it("projects only existing invocation/domain facts, never a second truth", () => {
    for (const code of GROUNDED_SYNTHESIS_FAILURE_CODES) {
      const projection = groundedSynthesisFailureProjection(code);
      expect(projection).toEqual(promptFailureDisposition(code));
      expect(["model_invocation", "domain"]).toContain(projection.layer);
    }
  });

  it("rejects preparation codes and unknown codes fail-closed", () => {
    // A grounded synthesis port outcome is never the authoritative carrier of
    // a prompt preparation failure; those live in checkpoint blockers.
    for (const code of PROMPT_PREPARATION_FAILURE_CODES) {
      expect(() => groundedSynthesisFailureProjection(code as never), code).toThrow(
        UnknownPromptFailureCodeError,
      );
    }
    expect(() => groundedSynthesisFailureProjection("citation_forged" as never)).toThrow(
      UnknownPromptFailureCodeError,
    );
  });
});
