import {
  contentDigest,
  createProjectContextBundleRecord,
  createPromptContractRegistry,
  FEEDBACK_ANALYSIS_PROMPT_REGISTRATION,
  type FeedbackAnalysisInput,
  type FeedbackAnalysisOutput,
} from "@universal-harness-internal/core";
import { describe, expect, it, vi } from "vitest";

import {
  createModelBackedFeedbackAnalysisPort,
  type FeedbackAnalysisAdapterDeps,
} from "../../src/model/feedback-analysis-adapter.js";
import { readModelInvocationRecords } from "../../src/model/invocation-store.js";
import type { ManagedModelProviderPort } from "../../src/model/managed-runner.js";
import { makeTempDir } from "../bootstrap/helpers.js";

const SOURCE = "structured gate evidence";
const sourceDigest = contentDigest(SOURCE);

function input(): FeedbackAnalysisInput {
  return {
    purpose: "feedback_analysis",
    schema_version: "feedback_analysis.v1",
    binding_digest: "b".repeat(64),
    conversation_id: "conversation_feedback-01",
    run_id: "run_feedback-01",
    finding_digest: "f".repeat(64),
    deterministic_rca: {
      rule: "unclassified",
      category: "implementation_defect",
      layer: "plan",
      confidence: 0.3,
    },
    bundle: createProjectContextBundleRecord({
      session_id: "session_feedback-01",
      purpose: "review",
      project_baseline_digest: "1".repeat(64),
      profile_digest: "2".repeat(64),
      policy_digest: "3".repeat(64),
      budget: {
        max_files: 1,
        max_bytes_per_source: 4_000,
        max_total_bytes: 4_000,
        max_summary_chars: 1_000,
      },
      sources: [
        {
          locator: "evidence://gate/01",
          source_kind: "graph",
          source_digest: sourceDigest,
          selection_reason: "failed gate",
          classification: "internal_project",
          summary: "gate failed",
          truncated: false,
        },
      ],
      exclusions: [],
    }),
  };
}

function output(overrides: Partial<FeedbackAnalysisOutput> = {}): FeedbackAnalysisOutput {
  return {
    purpose: "feedback_analysis",
    schema_version: "feedback_analysis.v1",
    finding_digest: "f".repeat(64),
    diagnoses: [
      {
        summary: "implementation does not satisfy the gate contract",
        confidence: 0.85,
        risk: "medium",
        source_refs: [{ kind: "evidence", ref: "evidence://gate/01", digest: sourceDigest }],
      },
    ],
    change_seed_candidates: [],
    verification_suggestions: [],
    ...overrides,
  };
}

function deps(root: string, provider: ManagedModelProviderPort): FeedbackAnalysisAdapterDeps {
  return {
    projectRoot: root,
    registry: createPromptContractRegistry([FEEDBACK_ANALYSIS_PROMPT_REGISTRATION]),
    profile_id: "standard",
    provider_config: {
      provider_identity: "provider_deepseek",
      config_digest: "0".repeat(64),
      budget_profile: "operation-standard",
    },
    provider,
    bundle_content: () => SOURCE,
  };
}

describe("model-backed feedback analysis adapter", () => {
  it("compiles an isolated prompt, validates citations and consumes the invocation", async () => {
    const root = makeTempDir("harness-feedback-analysis-");
    const provider: ManagedModelProviderPort = {
      invoke: vi.fn(async () => ({ ok: true as const, content: JSON.stringify(output()) })),
    };
    const result = await createModelBackedFeedbackAnalysisPort(deps(root, provider)).analyze(
      input(),
    );

    expect(result.status).toBe("completed");
    expect(provider.invoke).toHaveBeenCalledTimes(1);
    expect(readModelInvocationRecords(root).map((record) => record.state)).toEqual([
      "planned",
      "started",
      "completed",
      "validated",
      "consumed",
    ]);
  });

  it("rejects a foreign citation and leaves validated output unconsumed", async () => {
    const root = makeTempDir("harness-feedback-analysis-invalid-");
    const provider: ManagedModelProviderPort = {
      invoke: vi.fn(async () => ({
        ok: true as const,
        content: JSON.stringify(
          output({
            diagnoses: [
              {
                summary: "invented",
                confidence: 0.9,
                risk: "low",
                source_refs: [{ kind: "evidence", ref: "foreign", digest: "9".repeat(64) }],
              },
            ],
          }),
        ),
      })),
    };
    const result = await createModelBackedFeedbackAnalysisPort(deps(root, provider)).analyze(
      input(),
    );

    expect(result).toMatchObject({ status: "failed", failure: { code: "invalid_output" } });
    expect(readModelInvocationRecords(root).map((record) => record.state)).toEqual([
      "planned",
      "started",
      "completed",
      "validated",
    ]);
  });
});
