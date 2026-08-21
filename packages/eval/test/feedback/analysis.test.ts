import { describe, expect, it } from "vitest";

import {
  FEEDBACK_ANALYSIS_PROMPT_CONTRACT,
  FEEDBACK_ANALYSIS_PROMPT_REGISTRATION,
  FEEDBACK_ANALYSIS_PROMPT_VERSION,
  candidateDisposition,
  createInMemoryFeedbackAnalysisPort,
  shouldInvokeFeedbackAnalysis,
  validateFeedbackAnalysisOutput,
} from "../../src/index.js";
import {
  createPromptContractRegistry,
  sealRecordEnvelope,
  type FeedbackAnalysisInput,
} from "../../../core/src/index.js";

/**
 * T17/PG-7 feedback analysis: the model is consulted only for unclassified
 * or policy-required cases; candidates carry confidence/risk/citations;
 * low-confidence or high-risk candidates require human review before the
 * router may consume them; citations must resolve against verifiable facts.
 */
const digest = (letter: string) => letter.repeat(64);

function bundleView() {
  return sealRecordEnvelope({
    protocol_version: "1.1.0",
    record_kind: "project_context_bundle",
    bundle_id: "bundle_01K1B01",
    session_id: "session_01K1S01",
    purpose: "review",
    project_baseline_digest: digest("b"),
    profile_digest: digest("2"),
    policy_digest: digest("2"),
    budget: {
      max_files: 4,
      max_bytes_per_source: 4000,
      max_total_bytes: 16000,
      max_summary_chars: 4000,
    },
    sources: [
      {
        locator: "feedback://finding/finding_01K1F01",
        source_kind: "graph",
        source_digest: digest("f"),
        selection_reason: "the finding under analysis",
        classification: "internal_project",
        summary: "",
        truncated: false,
      },
    ],
    exclusions: [],
    content_digest: digest("c"),
  });
}

function analysisInput(): FeedbackAnalysisInput {
  return {
    purpose: "feedback_analysis",
    schema_version: "feedback_analysis.v1",
    binding_digest: digest("1"),
    conversation_id: "conversation_01K1CV1",
    run_id: "run_01K1RN1",
    finding_digest: digest("f"),
    deterministic_rca: {
      rule: "unclassified",
      category: "implementation_defect",
      layer: "plan",
      confidence: 0.3,
    },
    bundle: bundleView() as FeedbackAnalysisInput["bundle"],
  };
}

function citedCandidate(overrides: Record<string, unknown> = {}) {
  return {
    summary: "the cache invalidation misses the rename path",
    confidence: 0.85,
    risk: "low",
    source_refs: [
      { kind: "bundle_source", ref: "feedback://finding/finding_01K1F01", digest: digest("f") },
    ],
    ...overrides,
  };
}

describe("shouldInvokeFeedbackAnalysis", () => {
  it("calls the model only for unclassified or policy-required cases", () => {
    expect(shouldInvokeFeedbackAnalysis({ rule: "unclassified" })).toBe(true);
    expect(shouldInvokeFeedbackAnalysis({ rule: "gate_failure_project" })).toBe(false);
    expect(
      shouldInvokeFeedbackAnalysis(
        { rule: "gate_failure_project" },
        { policy_requires_semantic_explanation: true },
      ),
    ).toBe(true);
  });
});

describe("feedback analysis validation and disposition", () => {
  it("rejects stale findings and foreign citations", () => {
    const output = {
      purpose: "feedback_analysis",
      schema_version: "feedback_analysis.v1",
      finding_digest: digest("f"),
      diagnoses: [citedCandidate()],
      change_seed_candidates: [],
      verification_suggestions: [],
    } as const;
    expect(
      validateFeedbackAnalysisOutput({
        output,
        finding_digest: digest("f"),
        fact_digests: { "feedback://finding/finding_01K1F01": digest("f") },
      }),
    ).toEqual([]);
    expect(
      validateFeedbackAnalysisOutput({
        output: { ...output, finding_digest: digest("9") },
        finding_digest: digest("f"),
        fact_digests: { "feedback://finding/finding_01K1F01": digest("f") },
      }).map((issue) => issue.code),
    ).toContain("stale_finding");
    expect(
      validateFeedbackAnalysisOutput({
        output,
        finding_digest: digest("f"),
        fact_digests: {},
      }).map((issue) => issue.code),
    ).toContain("citation_invalid");
  });

  it("gates low-confidence or high-risk candidates behind human review", () => {
    expect(candidateDisposition({ confidence: 0.9, risk: "low" })).toBe("router_consumable");
    expect(candidateDisposition({ confidence: 0.5, risk: "low" })).toBe("requires_human_review");
    expect(candidateDisposition({ confidence: 0.95, risk: "high" })).toBe("requires_human_review");
  });

  it("runs the in-memory port through schema and citation validation", async () => {
    const clean = createInMemoryFeedbackAnalysisPort(() => ({
      diagnoses: [citedCandidate()],
      change_seed_candidates: [],
      verification_suggestions: [],
    }));
    expect((await clean.analyze(analysisInput())).status).toBe("completed");

    const dirty = createInMemoryFeedbackAnalysisPort(() => ({
      diagnoses: [
        citedCandidate({ source_refs: [{ kind: "bundle_source", ref: "x", digest: digest("9") }] }),
      ],
      change_seed_candidates: [],
      verification_suggestions: [],
    }));
    expect((await dirty.analyze(analysisInput())).status).toBe("failed");
  });
});

describe("feedback analysis prompt contract", () => {
  it("resolves the feedback_analysis port with its own contract", () => {
    const registry = createPromptContractRegistry([FEEDBACK_ANALYSIS_PROMPT_REGISTRATION]);
    const resolution = registry.resolve({
      port_id: "feedback_analysis",
      prompt_version: FEEDBACK_ANALYSIS_PROMPT_VERSION,
    });
    expect(resolution.prompt_contract_id).toBe("harness:prompt:feedback-analysis");
    expect(resolution.output_schema_id).toBe("feedback-analysis-output");
    expect(FEEDBACK_ANALYSIS_PROMPT_CONTRACT.authority_boundary.text).toContain(
      "never overwritten",
    );
  });
});
