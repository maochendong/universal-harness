import { describe, expect, it } from "vitest";

import { designSetContentDigest, type DesignSetContent } from "../../src/index.js";
import {
  validateDesignReviewOutput,
  type DesignReviewValidationInput,
} from "../../src/design/review-validator.js";

/**
 * T12 ReviewResultValidator (designset lifecycle design 6.5/10, model
 * advisory design 7): the three-state review outcome and the unresolved
 * Critical determination are re-verifiable by a pure validator. A model
 * accept never substitutes for human approval, and a citation outside the
 * review bundle or a legal citation with a wrong conclusion never gains
 * authority.
 */
const digest = (letter: string) => letter.repeat(64);
const REQUIREMENT_ID = "requirement_01K1REQ";
const CRITERION_ID = "criterion_01K1AC1";
const STRATEGY_ID = "designartifact_01K1TST";

function proposalContent(): DesignSetContent {
  return {
    requirement_baseline_digest: digest("b"),
    impact_set_id: "impactset_01K1IMP",
    impact_set_digest: digest("1"),
    policy_digest: digest("2"),
    repository_baseline: "deadbeef",
    mode: "change",
    node_changes: [
      {
        action: "create",
        node_id: STRATEGY_ID,
        node_type: "DesignArtifact",
        target_revision: 1,
        proposed_extensions: {},
      },
    ],
    reused_assets: [],
    edge_changes: [],
    coverage: [
      {
        requirement_id: REQUIREMENT_ID,
        decision_ids: [],
        component_scope: { status: "not_applicable", reason: "none" },
        test_strategy_coverage: [
          {
            acceptance_criterion_id: CRITERION_ID,
            test_node_id: "test_01K1T01",
            primary_test_strategy_id: STRATEGY_ID,
          },
        ],
        supporting_test_strategy_ids: [],
        applicability: {
          api: { status: "not_applicable", reason: "no api" },
          data: { status: "not_applicable", reason: "no data" },
          ui: { status: "not_applicable", reason: "no ui" },
        },
      },
    ],
    risk_summary: { level: "medium", reasons: ["impact medium"] },
    rationale: "cover the requirement",
  };
}

function finding(overrides: Record<string, unknown> = {}) {
  return {
    finding_id: "finding_01K1F01",
    severity: "warning",
    category: "coverage_gap",
    affected_asset_id: STRATEGY_ID,
    source_refs: [
      { kind: "bundle_source", ref: "capture://accepted-prd/abc", digest: digest("5") },
    ],
    observed_problem: "observed",
    recommended_revision: "revise",
    suggested_verification: "verify",
    ...overrides,
  };
}

function baseInput(
  overrides: Partial<DesignReviewValidationInput> = {},
): DesignReviewValidationInput {
  return {
    output: {
      verdict: "revision_required",
      findings: [finding()],
      coverage_assessment: [{ requirement_id: REQUIREMENT_ID, status: "deficient" }],
      residual_risks: [],
      summary: "one gap",
    },
    bundle_sources: [{ ref: "capture://accepted-prd/abc", digest: digest("5") }],
    proposal_content: proposalContent(),
    must_change_requirement_ids: [REQUIREMENT_ID],
    ...overrides,
  };
}

function codes(input: DesignReviewValidationInput): string[] {
  return validateDesignReviewOutput(input).map((issue) => issue.code);
}

describe("validateDesignReviewOutput", () => {
  it("accepts a consistent revision_required review", () => {
    expect(validateDesignReviewOutput(baseInput())).toEqual([]);
  });

  it("lets accept_recommended carry no unresolved critical finding", () => {
    const input = baseInput();
    input.output = { ...input.output, verdict: "accept_recommended", findings: [finding()] };
    expect(validateDesignReviewOutput(input)).toEqual([]);
  });

  it("blocks approval when accept_recommended hides a critical finding", () => {
    const input = baseInput();
    input.output = {
      ...input.output,
      verdict: "accept_recommended",
      findings: [finding({ severity: "critical" })],
    };
    expect(codes(input)).toContain("unresolved_critical");
  });

  it("requires a critical finding behind a blocked verdict", () => {
    const input = baseInput();
    input.output = { ...input.output, verdict: "blocked" };
    expect(codes(input)).toContain("verdict_inconsistent");
  });

  it("rejects citations outside the review bundle", () => {
    const input = baseInput();
    input.output = {
      ...input.output,
      findings: [
        finding({
          source_refs: [{ kind: "bundle_source", ref: "capture://other", digest: digest("5") }],
        }),
      ],
    };
    expect(codes(input)).toContain("citation_outside_bundle");
  });

  it("verifies proposal citations against the canonical content digest", () => {
    const content = proposalContent();
    const good = baseInput();
    good.output = {
      ...good.output,
      findings: [
        finding({
          source_refs: [
            {
              kind: "proposal_content",
              ref: "design-set-content",
              digest: designSetContentDigest(content),
            },
          ],
        }),
      ],
    };
    expect(validateDesignReviewOutput(good)).toEqual([]);

    const bad = baseInput();
    bad.output = {
      ...bad.output,
      findings: [
        finding({
          source_refs: [
            { kind: "proposal_content", ref: "design-set-content", digest: digest("9") },
          ],
        }),
      ],
    };
    expect(codes(bad)).toContain("citation_outside_bundle");
  });

  it("rejects findings aimed at assets or criteria the proposal does not contain", () => {
    const badAsset = baseInput();
    badAsset.output = {
      ...badAsset.output,
      findings: [finding({ affected_asset_id: "designartifact_01K1MIA" })],
    };
    expect(codes(badAsset)).toContain("unknown_affected_target");

    const badCriterion = baseInput();
    badCriterion.output = {
      ...badCriterion.output,
      findings: [
        finding({ affected_asset_id: undefined, affected_criterion_id: "criterion_01K1MIA" }),
      ],
    };
    expect(codes(badCriterion)).toContain("unknown_affected_target");

    const noTarget = baseInput();
    const targetless = finding();
    delete (targetless as Record<string, unknown>).affected_asset_id;
    noTarget.output = { ...noTarget.output, findings: [targetless] };
    expect(codes(noTarget)).toContain("unknown_affected_target");
  });

  it("requires exactly one coverage assessment per must-change requirement", () => {
    const missing = baseInput();
    missing.output = { ...missing.output, coverage_assessment: [] };
    expect(codes(missing)).toContain("coverage_assessment_gap");

    const duplicated = baseInput();
    duplicated.output = {
      ...duplicated.output,
      coverage_assessment: [
        { requirement_id: REQUIREMENT_ID, status: "covered" },
        { requirement_id: REQUIREMENT_ID, status: "deficient" },
      ],
    };
    expect(codes(duplicated)).toContain("coverage_assessment_gap");

    const unknown = baseInput();
    unknown.output = {
      ...unknown.output,
      coverage_assessment: [
        { requirement_id: REQUIREMENT_ID, status: "covered" },
        { requirement_id: "requirement_01K1OTH", status: "covered" },
      ],
    };
    expect(codes(unknown)).toContain("unknown_affected_target");
  });
});
