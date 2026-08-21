import { describe, expect, it, vi } from "vitest";

import {
  createPromptContractRegistry,
  DESIGN_PROPOSAL_PROMPT_REGISTRATION,
  DESIGN_REVIEW_PROMPT_REGISTRATION,
  designSetContentDigest,
  type DesignProposalInput,
  type DesignReviewInput,
  type DesignSetContent,
} from "@universal-harness-internal/core";

import {
  createModelBackedDesignProposalPort,
  createModelBackedDesignReviewPort,
  type DesignProposalAdapterDeps,
  type DesignReviewAdapterDeps,
} from "../../src/model/design-adapters.js";
import { readModelInvocationRecords } from "../../src/model/invocation-store.js";
import type { ManagedModelProviderPort } from "../../src/model/managed-runner.js";
import { makeTempDir } from "../bootstrap/helpers.js";

/**
 * PG-4 runtime adapters: the model-backed design ports compile their
 * isolated contracts, invoke through the managed runner and fail closed on
 * any output the domain validators reject — a rejected output is never
 * consumed.
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
    sources: [],
    bundle_digest: digest("7"),
    conversation_id: "conversation_01K1CV1",
    run_id: "run_01K1RN1",
  };
}

function reviewInput(): DesignReviewInput {
  const bundleSource = {
    ref: `review://design-proposal/${designSetContentDigest(proposalContent())}`,
    digest: digest("8"),
  };
  return {
    workflow_operation_id: "operation_01K1OP1",
    iteration_id: "iteration_01K1IT1",
    proposal_content: proposalContent(),
    proposal_digest: digest("3"),
    validation_digest: digest("4"),
    bundle_sources: [bundleSource],
    bundle_digest: digest("9"),
    rubric: { rubric_id: "design-review-default", categories: ["coverage_gap"] },
    must_change_requirement_ids: [REQUIREMENT_ID],
    conversation_id: "conversation_01K1CV2",
    run_id: "run_01K1RN2",
  };
}

const REGISTRY = createPromptContractRegistry([
  DESIGN_PROPOSAL_PROMPT_REGISTRATION,
  DESIGN_REVIEW_PROMPT_REGISTRATION,
]);

function proposalDeps(root: string, provider: ManagedModelProviderPort): DesignProposalAdapterDeps {
  return {
    projectRoot: root,
    registry: REGISTRY,
    profile_id: "standard",
    provider_config: {
      provider_identity: "provider_anthropic",
      config_digest: "0".repeat(64),
      budget_profile: "operation-standard",
    },
    provider,
  };
}

function reviewDeps(root: string, provider: ManagedModelProviderPort): DesignReviewAdapterDeps {
  return proposalDeps(root, provider);
}

function providerReturning(output: unknown): ManagedModelProviderPort {
  return { invoke: vi.fn(async () => ({ ok: true as const, content: JSON.stringify(output) })) };
}

describe("model-backed design proposal adapter", () => {
  it("compiles, invokes, parses and consumes a clean proposal", async () => {
    const root = makeTempDir("harness-design-proposal-");
    const port = createModelBackedDesignProposalPort(
      proposalDeps(
        root,
        providerReturning({
          purpose: "design_proposal",
          schema_version: "design_proposal.v1",
          proposal: proposalContent(),
          questions: [],
        }),
      ),
    );
    const result = await port.propose(proposalInput());
    expect(result.status).toBe("proposed");
    const states = readModelInvocationRecords(root).map((record) => record.state);
    expect(states).toEqual(["planned", "started", "completed", "validated", "consumed"]);
  });

  it("fails closed on an empty payload and never consumes it", async () => {
    const root = makeTempDir("harness-design-proposal-empty-");
    const port = createModelBackedDesignProposalPort(
      proposalDeps(
        root,
        providerReturning({
          purpose: "design_proposal",
          schema_version: "design_proposal.v1",
          questions: [],
        }),
      ),
    );
    const result = await port.propose(proposalInput());
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.failure.code).toBe("invalid_output");
    const states = readModelInvocationRecords(root).map((record) => record.state);
    expect(states).toEqual(["planned", "started", "completed", "validated"]);
  });
});

describe("design adapter input fidelity (T21)", () => {
  it("itemizes bound node contents into the prompt when node_content is supplied", async () => {
    const root = makeTempDir("harness-design-nodes-");
    const captured: { user?: string } = {};
    const provider: ManagedModelProviderPort = {
      invoke: vi.fn(async (request) => {
        captured.user = request.messages.find((message) => message.role === "user")?.content;
        return {
          ok: true as const,
          content: JSON.stringify({
            purpose: "design_proposal",
            schema_version: "design_proposal.v1",
            proposal: proposalContent(),
            questions: [],
          }),
        };
      }),
    };
    const port = createModelBackedDesignProposalPort({
      ...proposalDeps(root, provider),
      node_content: (nodeId) => `canonical-content-of-${nodeId}`,
    });
    const result = await port.propose(proposalInput());
    expect(result.status).toBe("proposed");
    expect(captured.user).toContain(`source-id="node:${REQUIREMENT_ID}"`);
    expect(captured.user).toContain(`canonical-content-of-${REQUIREMENT_ID}`);
  });

  it("keeps the compilation digest-only when no node_content resolver is supplied", async () => {
    const root = makeTempDir("harness-design-nonodes-");
    const captured: { user?: string } = {};
    const provider: ManagedModelProviderPort = {
      invoke: vi.fn(async (request) => {
        captured.user = request.messages.find((message) => message.role === "user")?.content;
        return {
          ok: true as const,
          content: JSON.stringify({
            purpose: "design_proposal",
            schema_version: "design_proposal.v1",
            proposal: proposalContent(),
            questions: [],
          }),
        };
      }),
    };
    const port = createModelBackedDesignProposalPort(proposalDeps(root, provider));
    const result = await port.propose(proposalInput());
    expect(result.status).toBe("proposed");
    expect(captured.user).not.toContain(`source-id="node:${REQUIREMENT_ID}"`);
  });
});

describe("model-backed design review adapter", () => {
  it("compiles, invokes, validates and consumes a clean review", async () => {
    const root = makeTempDir("harness-design-review-");
    const port = createModelBackedDesignReviewPort(
      reviewDeps(
        root,
        providerReturning({
          purpose: "design_review",
          schema_version: "design_review.v1",
          verdict: "accept_recommended",
          findings: [],
          coverage_assessment: [{ requirement_id: REQUIREMENT_ID, status: "covered" }],
          residual_risks: [],
          summary: "clean",
        }),
      ),
    );
    const result = await port.review(reviewInput());
    expect(result.status).toBe("accept_recommended");
    const states = readModelInvocationRecords(root).map((record) => record.state);
    expect(states).toEqual(["planned", "started", "completed", "validated", "consumed"]);
  });

  it("fails closed on a hidden critical finding with a foreign citation", async () => {
    const root = makeTempDir("harness-design-review-hidden-");
    const port = createModelBackedDesignReviewPort(
      reviewDeps(
        root,
        providerReturning({
          purpose: "design_review",
          schema_version: "design_review.v1",
          verdict: "accept_recommended",
          findings: [
            {
              finding_id: "finding_01K1F01",
              severity: "critical",
              category: "coverage_gap",
              affected_criterion_id: "criterion_01K1MIA",
              source_refs: [
                { kind: "bundle_source", ref: "review://foreign", digest: digest("5") },
              ],
              observed_problem: "o",
              recommended_revision: "r",
              suggested_verification: "v",
            },
          ],
          coverage_assessment: [{ requirement_id: REQUIREMENT_ID, status: "covered" }],
          residual_risks: [],
          summary: "hidden critical",
        }),
      ),
    );
    const result = await port.review(reviewInput());
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("invalid_output");
      expect(result.failure.summary).toContain("citation_outside_bundle");
    }
    const states = readModelInvocationRecords(root).map((record) => record.state);
    expect(states).toEqual(["planned", "started", "completed", "validated"]);
  });
});
