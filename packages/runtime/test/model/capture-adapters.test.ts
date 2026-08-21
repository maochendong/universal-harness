import { describe, expect, it, vi } from "vitest";

import type { ApprovalBriefInput, ProjectDiscoveryInput } from "@universal-harness-internal/core";

import {
  PromptPreparationFailureError,
  createModelBackedGroundedSynthesisPort,
  createModelBackedPrdProposalPort,
  createModelBackedPrdReviewPort,
  type ModelBackedAdapterDeps,
} from "../../src/model/capture-adapters.js";
import { readModelInvocationRecords } from "../../src/model/invocation-store.js";
import type { ManagedModelProviderPort } from "../../src/model/managed-runner.js";
import { makeTempDir } from "../bootstrap/helpers.js";
import {
  adapterBundle,
  adapterBundleContent,
  adapterRegistry,
  adapterSession,
  proposalProfile,
  proposalRecord,
  reviewProfile,
  validDraft,
  validationReport,
} from "./adapter-fixtures.js";

function deps(root: string, provider?: ManagedModelProviderPort): ModelBackedAdapterDeps {
  return {
    projectRoot: root,
    registry: adapterRegistry(),
    profile_id: "standard",
    provider_config: {
      provider_identity: "provider_anthropic",
      config_digest: "0".repeat(64),
      budget_profile: "capture-standard",
    },
    bundle_content: adapterBundleContent,
    ...(provider === undefined ? {} : { provider }),
  };
}

function providerReturning(content: string): ManagedModelProviderPort {
  return { invoke: vi.fn(async () => ({ ok: true as const, content })) };
}

function proposalInvocation(suffix: string) {
  return {
    invocation_id: `capture-invocation_${suffix}`,
    conversation_id: `capture-conversation_${suffix}`,
    evidence_locator: `capture-evidence://capture-invocation_${suffix}`,
  };
}

describe("model-backed PRD proposal adapter", () => {
  it("compiles, invokes, validates and consumes through the managed runner", async () => {
    const root = makeTempDir("harness-adapter-");
    const session = adapterSession();
    const provider = providerReturning(JSON.stringify(validDraft(session)));
    const port = createModelBackedPrdProposalPort(deps(root, provider));
    const result = await port.propose({
      session,
      proposal_context_bundle: adapterBundle(session, "proposal"),
      accepted_answers: [],
      profile: proposalProfile(adapterRegistry()),
      invocation: proposalInvocation("01K1PROPOSE"),
    });
    expect(result.status).toBe("proposed");
    const states = readModelInvocationRecords(root).map((record) => record.state);
    expect(states).toEqual(["planned", "started", "completed", "validated", "consumed"]);
  });

  it("maps a missing provider to a typed port failure", async () => {
    const root = makeTempDir("harness-adapter-");
    const session = adapterSession();
    const port = createModelBackedPrdProposalPort(deps(root));
    const result = await port.propose({
      session,
      proposal_context_bundle: adapterBundle(session, "proposal"),
      accepted_answers: [],
      profile: proposalProfile(adapterRegistry()),
      invocation: proposalInvocation("01K1NOPROV"),
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.failure.code).toBe("provider_unavailable");
  });

  it("raises a preparation failure — zero invocations — for an unknown prompt version", async () => {
    const root = makeTempDir("harness-adapter-");
    const session = adapterSession();
    const provider = providerReturning("{}");
    const port = createModelBackedPrdProposalPort(deps(root, provider));
    const profile = {
      ...proposalProfile(adapterRegistry()),
      prompt_version: "prd-proposal.v99",
    };
    await expect(
      port.propose({
        session,
        proposal_context_bundle: adapterBundle(session, "proposal"),
        accepted_answers: [],
        profile,
        invocation: proposalInvocation("01K1PREP"),
      }),
    ).rejects.toThrow(PromptPreparationFailureError);
    expect(readModelInvocationRecords(root)).toHaveLength(0);
    expect(provider.invoke as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("refuses non-model profiles without compiling or invoking", async () => {
    const root = makeTempDir("harness-adapter-");
    const session = adapterSession();
    const provider = providerReturning("{}");
    const port = createModelBackedPrdProposalPort(deps(root, provider));
    await expect(
      port.propose({
        session,
        proposal_context_bundle: adapterBundle(session, "proposal"),
        accepted_answers: [],
        profile: {
          backing: "manual",
          adapter_profile_digest: "e".repeat(64),
          prompt_version_digest: "f".repeat(64),
          producer_identity: "manual",
        },
        invocation: proposalInvocation("01K1MANUAL"),
      }),
    ).rejects.toThrow(PromptPreparationFailureError);
    expect(provider.invoke as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});

describe("model-backed PRD review adapter", () => {
  it("completes an independent review with its own contract and conversation", async () => {
    const root = makeTempDir("harness-adapter-");
    const session = adapterSession();
    // A real proposal + validation produced through the domain factories.
    const proposal = proposalRecord(session, adapterBundle(session, "proposal"));
    const report = validationReport(session, proposal);
    const provider = providerReturning(
      JSON.stringify({
        verdict: "accept",
        dimensions: [
          { dimension_id: "clarity", status: "satisfied", notes: "ok" },
          { dimension_id: "completeness", status: "satisfied", notes: "ok" },
          { dimension_id: "testability", status: "satisfied", notes: "ok" },
        ],
        findings: [],
        suggested_questions: [],
      }),
    );
    const reviewPort = createModelBackedPrdReviewPort(deps(root, provider));
    const result = await reviewPort.review({
      session,
      proposal,
      review_context_bundle: adapterBundle(session, "review"),
      validation_report: report,
      rubric: {
        rubric_id: "capture-review-rubric",
        dimensions: [
          { dimension_id: "clarity", prompt: "Is every requirement unambiguous?" },
          { dimension_id: "completeness", prompt: "Does the PRD cover the intent?" },
          { dimension_id: "testability", prompt: "Is every criterion observable?" },
        ],
        mandatory_dimension_ids: ["clarity", "completeness", "testability"],
      },
      profile: reviewProfile(adapterRegistry()),
      invocation: proposalInvocation("01K1REVIEW"),
    });
    expect(result.status).toBe("completed");
    if (result.status === "completed") expect(result.report.verdict).toBe("accept");
  });

  it("fails independence_violation when the review reuses the proposal conversation", async () => {
    const root = makeTempDir("harness-adapter-");
    const session = adapterSession();
    const proposal = proposalRecord(session, adapterBundle(session, "proposal"));
    const report = validationReport(session, proposal);
    const shared = proposalInvocation("01K1SHARED");

    const proposalProvider = providerReturning(JSON.stringify(validDraft(session)));
    const proposalPort = createModelBackedPrdProposalPort(deps(root, proposalProvider));
    const proposed = await proposalPort.propose({
      session,
      proposal_context_bundle: adapterBundle(session, "proposal"),
      accepted_answers: [],
      profile: proposalProfile(adapterRegistry()),
      invocation: shared,
    });
    expect(proposed.status).toBe("proposed");

    const reviewProvider = providerReturning("{}");
    const reviewPort = createModelBackedPrdReviewPort(deps(root, reviewProvider));
    const result = await reviewPort.review({
      session,
      proposal,
      review_context_bundle: adapterBundle(session, "review"),
      validation_report: report,
      rubric: {
        rubric_id: "capture-review-rubric",
        dimensions: [{ dimension_id: "clarity", prompt: "clear?" }],
        mandatory_dimension_ids: ["clarity"],
      },
      profile: reviewProfile(adapterRegistry()),
      invocation: { ...shared, invocation_id: "capture-invocation_01K1SHARER" },
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.failure.code).toBe("policy_denied");
  });
});

describe("model-backed grounded synthesis adapter", () => {
  function discoveryInput(
    session: ReturnType<typeof adapterSession>,
    bundle: ReturnType<typeof adapterBundle>,
    suffix: string,
  ): ProjectDiscoveryInput {
    return {
      purpose: "project_discovery",
      schema_version: "project-discovery.v1",
      binding_digest: "9".repeat(64),
      conversation_id: `grounded-conversation_${suffix}`,
      run_id: `grounded-run_${suffix}`,
      bundle,
    };
  }

  function discoveryOutput(bundle: ReturnType<typeof adapterBundle>): string {
    const ref = { locator: "README.md", source_digest: bundle.sources[0]!.source_digest };
    return JSON.stringify({
      purpose: "project_discovery",
      schema_version: "project-discovery.v1",
      bundle_digest: bundle.record_digest,
      facts: [{ fact: "Node package", confidence: "high", source_refs: [ref] }],
      capability_candidates: [],
      gate_candidates: [],
    });
  }

  it("completes discovery with citation-checked output", async () => {
    const root = makeTempDir("harness-adapter-");
    const session = adapterSession();
    const bundle = adapterBundle(session, "proposal");
    const provider = providerReturning(discoveryOutput(bundle));
    const port = createModelBackedGroundedSynthesisPort(deps(root, provider));
    const result = await port.synthesize(discoveryInput(session, bundle, "01K1DISC"));
    expect(result.status).toBe("completed");
  });

  it("fails citation_invalid when a cited digest does not match the bundle", async () => {
    const root = makeTempDir("harness-adapter-");
    const session = adapterSession();
    const bundle = adapterBundle(session, "proposal");
    const bogus = JSON.parse(discoveryOutput(bundle));
    bogus.facts[0].source_refs[0].source_digest = "0".repeat(64);
    const provider = providerReturning(JSON.stringify(bogus));
    const port = createModelBackedGroundedSynthesisPort(deps(root, provider));
    const result = await port.synthesize(discoveryInput(session, bundle, "01K1CITE"));
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.failure.code).toBe("citation_invalid");
  });

  it("passes citation-valid output through verbatim — conclusions are never rewritten", async () => {
    const root = makeTempDir("harness-adapter-");
    const session = adapterSession();
    const bundle = adapterBundle(session, "proposal");
    const wrongConclusion = JSON.parse(discoveryOutput(bundle));
    wrongConclusion.facts[0].fact = "The project is a COBOL mainframe.";
    const provider = providerReturning(JSON.stringify(wrongConclusion));
    const port = createModelBackedGroundedSynthesisPort(deps(root, provider));
    const result = await port.synthesize(discoveryInput(session, bundle, "01K1VERBA"));
    expect(result.status).toBe("completed");
    if (result.status === "completed" && result.output.purpose === "project_discovery") {
      expect(result.output.facts[0]!.fact).toBe("The project is a COBOL mainframe.");
    }
  });

  it("completes an approval brief through the managed path", async () => {
    const root = makeTempDir("harness-adapter-");
    const session = adapterSession();
    const bundle = adapterBundle(session, "approval_brief");
    const briefOutput = JSON.stringify({
      purpose: "approval_brief",
      schema_version: "approval-brief.v1",
      bundle_digest: bundle.record_digest,
      changes: [],
      risks: [],
      tradeoffs: [],
      open_questions: [],
    });
    const provider = providerReturning(briefOutput);
    const port = createModelBackedGroundedSynthesisPort(deps(root, provider));
    const briefInput: ApprovalBriefInput = {
      purpose: "approval_brief",
      schema_version: "approval-brief.v1",
      binding_digest: "9".repeat(64),
      conversation_id: "grounded-conversation_01K1BRIEF",
      run_id: "grounded-run_01K1BRIEF",
      bundle,
      approval_object: {
        proposal_id: "prd-proposal_01K1ABCDEFGHIJKLMNO",
        proposal_content_digest: "1".repeat(64),
        validation_report_digest: "2".repeat(64),
        review_report_digest: "3".repeat(64),
        risk_assessment_digest: "4".repeat(64),
        approval_request_id: "approval-request_01K1ABCDEFGHIJKLMNO",
      },
    };
    const brief = await port.synthesize(briefInput);
    expect(brief.status).toBe("completed");
  });

  it("completes a context enrichment through the same managed path", async () => {
    const root = makeTempDir("harness-adapter-");
    const bundle = adapterBundle(adapterSession(), "context_enrichment");
    const provider = providerReturning(
      JSON.stringify({
        purpose: "context_enrichment",
        schema_version: "context-enrichment.v1",
        bundle_digest: bundle.record_digest,
        terms: [],
        segment_summaries: [],
        relevance_explanations: [],
      }),
    );
    const port = createModelBackedGroundedSynthesisPort(deps(root, provider));
    const result = await port.synthesize({
      purpose: "context_enrichment",
      schema_version: "context-enrichment.v1",
      binding_digest: "9".repeat(64),
      conversation_id: "grounded-conversation_01K1ENRIC",
      run_id: "grounded-run_01K1ENRIC",
      bundle,
    });
    expect(result.status).toBe("completed");
    if (result.status === "completed") expect(result.output.purpose).toBe("context_enrichment");
  });

  it("completes an iteration narrative through the same managed path", async () => {
    const root = makeTempDir("harness-adapter-");
    // Bundle purposes stop at context_enrichment; the narrative's snapshot
    // bundle view is purpose-tagged context_enrichment too (narrative.ts).
    const bundle = adapterBundle(adapterSession(), "context_enrichment");
    const provider = providerReturning(
      JSON.stringify({
        purpose: "iteration_narrative",
        schema_version: "iteration-narrative.v1",
        bundle_digest: bundle.record_digest,
        outcomes: [],
        residual_risks: [],
        follow_ups: [],
      }),
    );
    const port = createModelBackedGroundedSynthesisPort(deps(root, provider));
    const result = await port.synthesize({
      purpose: "iteration_narrative",
      schema_version: "iteration-narrative.v1",
      binding_digest: "9".repeat(64),
      conversation_id: "grounded-conversation_01K1NARRA",
      run_id: "grounded-run_01K1NARRA",
      bundle,
    });
    expect(result.status).toBe("completed");
    if (result.status === "completed") expect(result.output.purpose).toBe("iteration_narrative");
  });

  it("keeps enrichment and narrative invocations of one operation distinct (T23)", async () => {
    const root = makeTempDir("harness-adapter-");
    const bundle = adapterBundle(adapterSession(), "context_enrichment");
    // The pipeline mints conversation ids as `<purpose>-conversation_<operation>`;
    // both grounded purposes of one operation share the operation suffix.
    const queue = [
      JSON.stringify({
        purpose: "context_enrichment",
        schema_version: "context-enrichment.v1",
        bundle_digest: bundle.record_digest,
        terms: [],
        segment_summaries: [],
        relevance_explanations: [],
      }),
      JSON.stringify({
        purpose: "iteration_narrative",
        schema_version: "iteration-narrative.v1",
        bundle_digest: bundle.record_digest,
        outcomes: [],
        residual_risks: [],
        follow_ups: [],
      }),
    ];
    const provider: ManagedModelProviderPort = {
      invoke: vi.fn(async () => ({ ok: true as const, content: queue.shift() ?? "{}" })),
    };
    const port = createModelBackedGroundedSynthesisPort(deps(root, provider));
    const enrichment = await port.synthesize({
      purpose: "context_enrichment",
      schema_version: "context-enrichment.v1",
      binding_digest: "9".repeat(64),
      conversation_id: "context-enrichment-conversation_01M0JSHARE",
      run_id: "context-enrichment-run_01M0JSHARE",
      bundle,
    });
    const narrative = await port.synthesize({
      purpose: "iteration_narrative",
      schema_version: "iteration-narrative.v1",
      binding_digest: "9".repeat(64),
      conversation_id: "iteration-narrative-conversation_01M0JSHARE",
      run_id: "iteration-narrative-run_01M0JSHARE",
      bundle,
    });
    expect(enrichment.status).toBe("completed");
    expect(narrative.status).toBe("completed");
    const ids = new Set(readModelInvocationRecords(root).map((record) => record.invocation_id));
    expect(ids.size).toBe(2);
  });
});
