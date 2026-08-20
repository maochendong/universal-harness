import { describe, expect, it } from "vitest";

import {
  compileDesignProposalBundle,
  compileDesignReviewBundle,
} from "../../src/design/input-bundles.js";
import {
  createInMemoryDesignProposalPort,
  createInMemoryDesignReviewPort,
  createManualDesignProposalPort,
  parseDesignProposalOutput,
  type DesignProposalInput,
  type DesignReviewInput,
} from "../../src/design/ports.js";
import type { DesignSetContent } from "../../src/schema/index.js";

/**
 * T12 design ports (designset lifecycle design 6, model advisory design 7):
 * the proposal and review ports are the only semantic seams; their input
 * bundles are independently compiled so proposal and review never share a
 * bundle identity. In-memory adapters exercise the exact production parse
 * and validation semantics; the manual adapter never fabricates a proposal.
 */
const digest = (letter: string) => letter.repeat(64);
const REQUIREMENT_ID = "requirement_01K1REQ";

function proposalContent(): DesignSetContent {
  return {
    requirement_baseline_digest: digest("b"),
    impact_set_id: "impactset_01K1IMP",
    impact_set_digest: digest("1"),
    policy_digest: digest("2"),
    repository_baseline: "deadbeef",
    mode: "change",
    node_changes: [],
    reused_assets: [],
    edge_changes: [],
    coverage: [],
    risk_summary: { level: "low", reasons: [] },
    rationale: "minimal",
  };
}

function proposalInput(): DesignProposalInput {
  const bundle = compileDesignProposalBundle(proposalFacts());
  return {
    workflow_operation_id: "operation_01K1OP1",
    iteration_id: "iteration_01K1IT1",
    requirement_baseline_digest: digest("b"),
    impact_set_id: "impactset_01K1IMP",
    impact_set_digest: digest("1"),
    policy_digest: digest("2"),
    repository_baseline: "deadbeef",
    must_change_requirement_ids: [REQUIREMENT_ID],
    requirement_impact_risks: { [REQUIREMENT_ID]: "medium" },
    criterion_test_pairs: [],
    sources: bundle.sources,
    bundle_digest: bundle.bundle_digest,
    conversation_id: "conversation_01K1CV1",
    run_id: "run_01K1RN1",
  };
}

function proposalFacts() {
  return {
    requirement_baseline_digest: digest("b"),
    impact_set_id: "impactset_01K1IMP",
    impact_set_digest: digest("1"),
    policy_digest: digest("2"),
    repository_baseline: "deadbeef",
    must_change_requirement_ids: [REQUIREMENT_ID],
    requirement_impact_risks: { [REQUIREMENT_ID]: "medium" as const },
    criterion_test_pairs: [],
    neighborhood: [],
  };
}

function reviewInput(): DesignReviewInput {
  const bundle = compileDesignReviewBundle({
    proposal_content: proposalContent(),
    validation_digest: digest("4"),
    policy_digest: digest("2"),
    rubric: { rubric_id: "design-review-default", categories: ["coverage_gap"] },
  });
  return {
    workflow_operation_id: "operation_01K1OP1",
    iteration_id: "iteration_01K1IT1",
    proposal_content: proposalContent(),
    proposal_digest: digest("3"),
    validation_digest: digest("4"),
    bundle_sources: bundle.sources.map((source) => ({
      ref: source.locator,
      digest: source.source_digest,
    })),
    bundle_digest: bundle.bundle_digest,
    rubric: { rubric_id: "design-review-default", categories: ["coverage_gap"] },
    must_change_requirement_ids: [REQUIREMENT_ID],
    conversation_id: "conversation_01K1CV2",
    run_id: "run_01K1RN2",
  };
}

describe("parseDesignProposalOutput", () => {
  it("maps a proposal payload to proposed", () => {
    const result = parseDesignProposalOutput({
      purpose: "design_proposal",
      schema_version: "design_proposal.v1",
      proposal: proposalContent(),
      questions: [],
    });
    expect(result.status).toBe("proposed");
  });

  it("maps a question-only payload to clarification_required", () => {
    const result = parseDesignProposalOutput({
      purpose: "design_proposal",
      schema_version: "design_proposal.v1",
      questions: [{ question: "which tenant?" }],
    });
    expect(result.status).toBe("clarification_required");
  });

  it("fails closed on empty or malformed payloads", () => {
    expect(
      parseDesignProposalOutput({
        purpose: "design_proposal",
        schema_version: "design_proposal.v1",
        questions: [],
      }).status,
    ).toBe("failed");
    expect(parseDesignProposalOutput("garbage").status).toBe("failed");
  });
});

describe("design input bundles", () => {
  it("compiles independent proposal and review bundle identities", () => {
    const proposal = compileDesignProposalBundle(proposalFacts());
    const review = compileDesignReviewBundle({
      proposal_content: proposalContent(),
      validation_digest: digest("4"),
      policy_digest: digest("2"),
      rubric: { rubric_id: "design-review-default", categories: ["coverage_gap"] },
    });
    expect(proposal.bundle_digest).not.toBe(review.bundle_digest);
    expect(proposal.bundle_digest).toMatch(/^[a-f0-9]{64}$/u);
    const proposalLocators = new Set(proposal.sources.map((source) => source.locator));
    for (const source of review.sources) {
      expect(proposalLocators.has(source.locator)).toBe(false);
    }
  });
});

describe("in-memory and manual design ports", () => {
  it("runs the proposal port through output parsing", async () => {
    const port = createInMemoryDesignProposalPort(() => ({
      proposal: proposalContent(),
      questions: [],
    }));
    const result = await port.propose(proposalInput());
    expect(result.status).toBe("proposed");

    const failing = createInMemoryDesignProposalPort(() => "not-a-payload");
    expect((await failing.propose(proposalInput())).status).toBe("failed");
  });

  it("runs the review port through the result validator", async () => {
    const input = reviewInput();
    const accept = createInMemoryDesignReviewPort(() => ({
      verdict: "accept_recommended",
      findings: [],
      coverage_assessment: [{ requirement_id: REQUIREMENT_ID, status: "covered" }],
      residual_risks: [],
      summary: "clean",
    }));
    expect((await accept.review(input)).status).toBe("accept_recommended");

    const hidden = createInMemoryDesignReviewPort(() => ({
      verdict: "accept_recommended",
      findings: [
        {
          finding_id: "finding_01K1F01",
          severity: "critical",
          category: "coverage_gap",
          affected_asset_id: undefined,
          affected_criterion_id: "criterion_01K1MIA",
          source_refs: [{ kind: "bundle_source", ref: "x", digest: digest("5") }],
          observed_problem: "o",
          recommended_revision: "r",
          suggested_verification: "v",
        },
      ],
      coverage_assessment: [{ requirement_id: REQUIREMENT_ID, status: "covered" }],
      residual_risks: [],
      summary: "hidden critical",
    }));
    expect((await hidden.review(input)).status).toBe("failed");
  });

  it("never fabricates a manual proposal", async () => {
    const manual = createManualDesignProposalPort();
    expect((await manual.propose(proposalInput())).status).toBe("clarification_required");

    const supplied = createManualDesignProposalPort({
      proposal: () => proposalContent(),
    });
    expect((await supplied.propose(proposalInput())).status).toBe("proposed");
  });
});
