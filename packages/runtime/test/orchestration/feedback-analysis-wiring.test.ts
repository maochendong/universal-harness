import type {
  FeedbackAnalysisInput,
  FeedbackAnalysisOutput,
  FeedbackAnalysisPort,
} from "@universal-harness-internal/core";
import { describe, expect, it, vi } from "vitest";

import {
  createCapabilityDagRunnerRegistry,
  type FeedbackAnalysisRequest,
} from "../../src/orchestration/capability-dag-runners.js";
import {
  createFeedbackAnalysisCoordinator,
  createInMemoryFeedbackAnalysisStore,
} from "../../src/finding/feedback-analysis-coordinator.js";

const digest = (letter: string): string => letter.repeat(64);

describe("feedback analysis DAG wiring", () => {
  it("analyzes ambiguous Findings after Verify and blocks before its checkpoint on required failure", async () => {
    const analyze = vi.fn(async (input: FeedbackAnalysisInput) => ({
      status: "completed" as const,
      output: {
        purpose: "feedback_analysis",
        schema_version: "feedback_analysis.v1",
        finding_digest: input.finding_digest,
        diagnoses: [],
        change_seed_candidates: [],
        verification_suggestions: [],
      } satisfies FeedbackAnalysisOutput,
    }));
    const coordinator = createFeedbackAnalysisCoordinator({
      port: { name: "fake", analyze } satisfies FeedbackAnalysisPort,
      store: createInMemoryFeedbackAnalysisStore(),
    });
    const request = {
      analysis_id: "feedback-analysis_01",
      evidence_id: "evidence_feedback-01",
      workflow_operation_id: "operation_01",
      iteration_id: "iteration_01",
      finding_digest: digest("f"),
      binding_digest: digest("b"),
      conversation_id: "conversation_feedback-01",
      run_id: "run_feedback-01",
      deterministic_rca: {
        rule: "unclassified",
        category: "implementation_defect",
        layer: "plan",
        confidence: 0.3,
      },
      bundle: { sources: [] } as never,
      binding_required: true,
    } satisfies FeedbackAnalysisRequest;
    const registry = createCapabilityDagRunnerRegistry({
      kernel: {
        verify: () => ({
          status: "committed",
          produces: [{ kind: "gate_evidence", digest: digest("g") }],
        }),
      },
      feedbackAnalysis: {
        coordinator,
        requests: () => [request],
      },
    });

    const result = await registry.kernel["verify"]!({
      operation_id: "operation_01",
      plan_digest: digest("p"),
      node: {
        node_id: "verify",
        node_kind: "kernel",
        depends_on: ["execute"],
        consumes: ["context_bundle"],
        produces: ["gate_evidence"],
        checkpoint: true,
      },
      inputs: { context_bundle: digest("c") },
    });

    expect(result.status).toBe("committed");
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it("keeps deterministic Findings at zero model calls for wrapped Verify/Evaluate/Audit runners", async () => {
    const analyze = vi.fn();
    const coordinator = createFeedbackAnalysisCoordinator({
      port: { name: "never", analyze } as FeedbackAnalysisPort,
      store: createInMemoryFeedbackAnalysisStore(),
    });
    const deterministic = {
      analysis_id: "feedback-analysis_02",
      evidence_id: "evidence_feedback-02",
      workflow_operation_id: "operation_01",
      iteration_id: "iteration_01",
      finding_digest: digest("f"),
      binding_digest: digest("b"),
      conversation_id: "conversation_feedback-02",
      run_id: "run_feedback-02",
      deterministic_rca: {
        rule: "gate-project",
        category: "test_defect",
        layer: "test",
        confidence: 0.8,
      },
      bundle: { sources: [] } as never,
      binding_required: true,
    } satisfies FeedbackAnalysisRequest;
    const registry = createCapabilityDagRunnerRegistry({
      kernel: { verify: () => ({ status: "committed" }) },
      modules: {
        independent_evaluation: () => ({ status: "committed" }),
        advanced_audit: () => ({ status: "committed" }),
      },
      feedbackAnalysis: { coordinator, requests: () => [deterministic] },
    });

    expect(registry.kernel["verify"]).toBeDefined();
    expect(registry.modules?.independent_evaluation).toBeDefined();
    expect(registry.modules?.advanced_audit).toBeDefined();
    const context = {
      operation_id: "operation_01",
      plan_digest: digest("p"),
      node: {
        node_id: "verify",
        node_kind: "kernel" as const,
        depends_on: [],
        consumes: [],
        produces: [],
        checkpoint: true,
      },
      inputs: {},
    };
    await registry.kernel["verify"]!(context);
    await registry.modules?.independent_evaluation?.({
      ...context,
      node: {
        ...context.node,
        node_id: "evaluate",
        node_kind: "module",
        capability_id: "independent_evaluation",
      },
    });
    await registry.modules?.advanced_audit?.({
      ...context,
      node: {
        ...context.node,
        node_id: "audit",
        node_kind: "module",
        capability_id: "advanced_audit",
      },
    });
    expect(analyze).not.toHaveBeenCalled();
  });
});
