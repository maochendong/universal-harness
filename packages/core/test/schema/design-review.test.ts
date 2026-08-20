import { describe, expect, it } from "vitest";

import { PROTOCOL_1_1_SCHEMA_REGISTRY, sealRecordEnvelope } from "../../src/schema/index.js";

/**
 * T11/T12 design review schemas (model advisory design 7): the review draft
 * is the only thing a DesignReviewPort may return — verdict, structured
 * findings, coverage assessment and residual risks. Findings always carry
 * severity, category, an affected asset or criterion, cited sources, the
 * observed problem, a recommended revision and a suggested verification.
 */
const digest = (letter: string) => letter.repeat(64);

function goldenFinding() {
  return {
    finding_id: "finding_01K1F01",
    severity: "warning",
    category: "coverage_gap",
    affected_asset_id: "designartifact_01K1API",
    source_refs: [
      { kind: "bundle_source", ref: "capture://accepted-prd/abc", digest: digest("5") },
    ],
    observed_problem: "the error contract omits the rate-limit response",
    recommended_revision: "add a 429 response to the api_contract errors",
    suggested_verification: "contract test covers the 429 branch",
  };
}

function goldenDraft() {
  return {
    verdict: "revision_required",
    findings: [goldenFinding()],
    coverage_assessment: [
      { requirement_id: "requirement_01K1REQ", status: "deficient", notes: "error path uncovered" },
    ],
    residual_risks: [
      {
        description: "clients may retry aggressively",
        level: "medium",
        mitigation: "document 429",
      },
    ],
    summary: "one coverage gap remains",
  };
}

const validateOutput = (value: unknown) =>
  PROTOCOL_1_1_SCHEMA_REGISTRY.validate("design-review-output", value);

describe("design review output schema", () => {
  it("accepts the golden review output through the registry", () => {
    const output = {
      purpose: "design_review",
      schema_version: "design_review.v1",
      ...goldenDraft(),
    };
    expect(validateOutput(output).valid).toBe(true);
  });

  it("rejects unknown severities, categories and facet-less findings", () => {
    const badSeverity = {
      purpose: "design_review",
      schema_version: "design_review.v1",
      ...goldenDraft(),
      findings: [{ ...goldenFinding(), severity: "blocker" }],
    };
    expect(validateOutput(badSeverity).valid).toBe(false);

    const badCategory = {
      purpose: "design_review",
      schema_version: "design_review.v1",
      ...goldenDraft(),
      findings: [{ ...goldenFinding(), category: "vibes" }],
    };
    expect(validateOutput(badCategory).valid).toBe(false);

    const noVerification = goldenFinding() as Record<string, unknown>;
    delete noVerification.suggested_verification;
    const facetLess = {
      purpose: "design_review",
      schema_version: "design_review.v1",
      ...goldenDraft(),
      findings: [noVerification],
    };
    expect(validateOutput(facetLess).valid).toBe(false);

    const noRefs = {
      purpose: "design_review",
      schema_version: "design_review.v1",
      ...goldenDraft(),
      findings: [{ ...goldenFinding(), source_refs: [] }],
    };
    expect(validateOutput(noRefs).valid).toBe(false);
  });

  it("seals and validates the design review record envelope", () => {
    const record = sealRecordEnvelope({
      protocol_version: "1.1.0",
      record_kind: "design_review",
      review_id: "designreview_01K1R01",
      workflow_operation_id: "operation_01K1OP1",
      iteration_id: "iteration_01K1IT1",
      proposal_digest: digest("3"),
      proposal_content_digest: digest("c"),
      validation_digest: digest("4"),
      review_bundle_digest: digest("6"),
      reviewer_port: "dsh-design-review",
      conversation_id: "conversation_01K1CV1",
      run_id: "run_01K1RN1",
      output: goldenDraft(),
    });
    expect(PROTOCOL_1_1_SCHEMA_REGISTRY.validate("design-review", record).valid).toBe(true);
  });

  it("registers the design proposal output schema", () => {
    const clarification = {
      purpose: "design_proposal",
      schema_version: "design_proposal.v1",
      questions: [{ question: "which tenant does this serve?", target_id: "requirement_01K1REQ" }],
    };
    expect(
      PROTOCOL_1_1_SCHEMA_REGISTRY.validate("design-proposal-output", clarification).valid,
    ).toBe(true);
  });
});
