import {
  sealRecordEnvelope,
  type FeedbackAnalysisInput,
  type FeedbackAnalysisOutput,
  type FeedbackAnalysisPort,
  type ProjectContextBundleRecord,
} from "@universal-harness-internal/core";
import { describe, expect, it, vi } from "vitest";

import {
  createFeedbackAnalysisCoordinator,
  createInMemoryFeedbackAnalysisStore,
} from "../../src/finding/feedback-analysis-coordinator.js";

const digest = (letter: string): string => letter.repeat(64);

function bundle(): ProjectContextBundleRecord {
  return sealRecordEnvelope({
    protocol_version: "1.1.0",
    record_kind: "project_context_bundle",
    bundle_id: "bundle_feedback",
    session_id: "session_feedback",
    purpose: "review",
    project_baseline_digest: digest("1"),
    profile_digest: digest("2"),
    policy_digest: digest("3"),
    budget: {
      max_files: 2,
      max_bytes_per_source: 4_000,
      max_total_bytes: 8_000,
      max_summary_chars: 2_000,
    },
    sources: [
      {
        locator: "feedback://finding/finding_01",
        source_kind: "graph",
        source_digest: digest("f"),
        selection_reason: "finding under analysis",
        classification: "internal_project",
        summary: "failure",
        truncated: false,
      },
    ],
    exclusions: [],
    content_digest: digest("4"),
  });
}

function output(
  input: FeedbackAnalysisInput,
  overrides: Partial<FeedbackAnalysisOutput> = {},
): FeedbackAnalysisOutput {
  const cited = {
    summary: "cache invalidation misses a rename",
    confidence: 0.9,
    risk: "low" as const,
    source_refs: [
      {
        kind: "bundle_source" as const,
        ref: "feedback://finding/finding_01",
        digest: digest("f"),
      },
    ],
  };
  return {
    purpose: "feedback_analysis",
    schema_version: "feedback_analysis.v1",
    finding_digest: input.finding_digest,
    diagnoses: [cited],
    change_seed_candidates: [{ ...cited, seed_kind: "finding" }],
    verification_suggestions: [cited],
    ...overrides,
  };
}

function analysisInput(rule = "unclassified") {
  return {
    analysis_id: "feedback-analysis_01",
    evidence_id: "evidence_feedback-analysis-01",
    workflow_operation_id: "operation_01",
    iteration_id: "iteration_01",
    finding_digest: digest("f"),
    binding_digest: digest("b"),
    conversation_id: "conversation_feedback-01",
    run_id: "run_feedback-01",
    deterministic_rca: {
      rule,
      category: "implementation_defect",
      layer: "plan",
      confidence: rule === "unclassified" ? 0.3 : 0.9,
    },
    bundle: bundle(),
    binding_required: true,
  } as const;
}

function port(script: (input: FeedbackAnalysisInput) => FeedbackAnalysisOutput): {
  readonly value: FeedbackAnalysisPort;
  readonly analyze: ReturnType<typeof vi.fn>;
} {
  const analyze = vi.fn(async (input: FeedbackAnalysisInput) => ({
    status: "completed" as const,
    output: script(input),
  }));
  return { value: { name: "fake-feedback-analysis", analyze }, analyze };
}

describe("FeedbackAnalysisCoordinator", () => {
  it("performs zero model calls when deterministic RCA has classified the Finding", async () => {
    const model = port(output);
    const store = createInMemoryFeedbackAnalysisStore();
    const coordinator = createFeedbackAnalysisCoordinator({ port: model.value, store });

    await expect(coordinator.analyzeFinding(analysisInput("gate-project"))).resolves.toMatchObject({
      status: "deterministic_only",
      deterministic_rca: { rule: "gate-project" },
    });
    expect(model.analyze).not.toHaveBeenCalled();
    expect(store.records).toEqual([]);
  });

  it("invokes exactly once for an ambiguous RCA and persists cited advisory Evidence", async () => {
    const model = port(output);
    const store = createInMemoryFeedbackAnalysisStore();
    const coordinator = createFeedbackAnalysisCoordinator({ port: model.value, store });

    const first = await coordinator.analyzeFinding(analysisInput());
    const replay = await coordinator.analyzeFinding(analysisInput());

    expect(first).toMatchObject({ status: "analyzed", disposition: "router_consumable" });
    expect(replay).toMatchObject({ status: "analyzed", replayed: true });
    expect(model.analyze).toHaveBeenCalledTimes(1);
    expect(store.records).toHaveLength(1);
    expect(store.evidence).toEqual([
      expect.objectContaining({
        evidence_id: "evidence_feedback-analysis-01",
        finding_digest: digest("f"),
        binding_digest: digest("b"),
        disposition: "router_consumable",
      }),
    ]);
  });

  it("requires human review for low-confidence or high-risk candidates", async () => {
    const model = port((input) =>
      output(input, {
        change_seed_candidates: [
          {
            summary: "possible data contract drift",
            seed_kind: "finding",
            confidence: 0.4,
            risk: "high",
            source_refs: [
              { kind: "finding", ref: "feedback://finding/finding_01", digest: digest("f") },
            ],
          },
        ],
      }),
    );
    const coordinator = createFeedbackAnalysisCoordinator({
      port: model.value,
      store: createInMemoryFeedbackAnalysisStore(),
    });

    await expect(coordinator.analyzeFinding(analysisInput())).resolves.toMatchObject({
      status: "analyzed",
      disposition: "requires_human_review",
    });
  });

  it("blocks a required missing/failed provider but lets optional Lite stay deterministic", async () => {
    const store = createInMemoryFeedbackAnalysisStore();
    const absent = createFeedbackAnalysisCoordinator({ store });
    await expect(absent.analyzeFinding(analysisInput())).resolves.toMatchObject({
      status: "blocked",
      failure: { code: "provider_required" },
    });
    await expect(
      absent.analyzeFinding({ ...analysisInput(), binding_required: false }),
    ).resolves.toMatchObject({
      status: "deterministic_only",
      reason: "optional_provider_unavailable",
    });

    const failing: FeedbackAnalysisPort = {
      name: "failed",
      analyze: vi.fn().mockResolvedValue({
        status: "failed",
        failure: { code: "provider_unavailable", summary: "offline", retryable: true },
      }),
    };
    const required = createFeedbackAnalysisCoordinator({ port: failing, store });
    await expect(required.analyzeFinding(analysisInput())).resolves.toMatchObject({
      status: "blocked",
      failure: { code: "provider_unavailable" },
    });
  });
});
