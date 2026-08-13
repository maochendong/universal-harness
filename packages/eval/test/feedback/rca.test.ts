import { describe, expect, it } from "vitest";

import { validateSchema } from "@universal-harness-internal/core";

import { buildFindingRecord } from "../../src/feedback/finding.js";
import {
  analyzeRootCause,
  diagnosisEdgeRecord,
  readRootCauseContent,
  type FailureSignal,
} from "../../src/feedback/rca.js";

import { TIMESTAMP_CLOCK, findingSpec } from "./fixtures.js";

const CONTEXT = { actor: "workflow-engine", timestamp: "2026-08-11T00:00:00.000Z" } as const;

function diagnose(signal: FailureSignal) {
  const finding = buildFindingRecord(findingSpec());
  return analyzeRootCause({ id: "rca_build", finding, signal, clock: TIMESTAMP_CLOCK });
}

/**
 * Structured RCA (design 9.1, plan Task 21): deterministic rules assign
 * known failure patterns; unclassified failures fall back to a minimal
 * confidence diagnosis; high-risk or low-confidence conclusions require
 * human review.
 */
describe("analyzeRootCause", () => {
  it("routes evaluation failures to the eval layer", () => {
    const rca = diagnose({ origin: "evaluation", dimension: "safety" });
    const content = readRootCauseContent(rca);
    expect(content.rule).toBe("evaluation-dimension");
    expect(content.category).toBe("evaluation_gap");
    expect(content.responsible_layer).toBe("eval");
    expect(content.requires_human_review).toBe(false);
  });

  it("routes policy and tool error kinds to their owning layers", () => {
    const policy = readRootCauseContent(
      diagnose({ origin: "runtime", errorKind: "boundary_violation" }),
    );
    expect(policy.rule).toBe("policy-decision");
    expect(policy.responsible_layer).toBe("policy");
    expect(policy.confidence).toBe(0.95);

    const tool = readRootCauseContent(diagnose({ origin: "test", errorKind: "unknown_tool" }));
    expect(tool.rule).toBe("tool-error");
    expect(tool.responsible_layer).toBe("tool");
  });

  it("routes gate failures by layer", () => {
    const project = readRootCauseContent(diagnose({ origin: "test", gateLayer: "project" }));
    expect(project.rule).toBe("gate-project");
    expect(project.category).toBe("test_defect");
    expect(project.responsible_layer).toBe("test");

    const stack = readRootCauseContent(diagnose({ origin: "test", gateLayer: "stack" }));
    expect(stack.rule).toBe("gate-stack");
    expect(stack.category).toBe("implementation_defect");
    expect(stack.responsible_layer).toBe("architecture");
    expect(stack.requires_human_review).toBe(false);

    const universal = readRootCauseContent(diagnose({ origin: "test", gateLayer: "universal" }));
    expect(universal.rule).toBe("gate-universal");
    expect(universal.requires_human_review).toBe(true);
  });

  it("falls back to a minimal-confidence diagnosis that requires review", () => {
    const content = readRootCauseContent(diagnose({ origin: "audit" }));
    expect(content.rule).toBe("unclassified");
    expect(content.confidence).toBe(0.3);
    expect(content.requires_human_review).toBe(true);
  });

  it("honors the semantic layer hint only for unclassified failures", () => {
    const hinted = readRootCauseContent(diagnose({ origin: "audit", layerHint: "tool" }));
    expect(hinted.rule).toBe("unclassified");
    expect(hinted.responsible_layer).toBe("tool");
    const classified = readRootCauseContent(
      diagnose({ origin: "test", gateLayer: "stack", layerHint: "tool" }),
    );
    expect(classified.responsible_layer).toBe("architecture");
  });

  it("flags high-risk diagnoses for review regardless of confidence", () => {
    const content = readRootCauseContent(
      diagnose({ origin: "evaluation", dimension: "safety", highRisk: true }),
    );
    expect(content.requires_human_review).toBe(true);
  });

  it("records symptom, evidence, module and proposed verification", () => {
    const finding = buildFindingRecord(findingSpec());
    const rca = analyzeRootCause({
      id: "rca_build",
      finding,
      signal: {
        origin: "test",
        gateLayer: "stack",
        module: "packages/runtime",
        evidenceIds: ["evidence_build"],
      },
      clock: TIMESTAMP_CLOCK,
    });
    expect(validateSchema("feedback", rca).valid).toBe(true);
    const content = readRootCauseContent(rca);
    expect(content.finding_id).toBe("finding_build");
    expect(content.observed_symptom).toBe(finding.summary);
    expect(content.evidence_ids).toEqual(["evidence_build"]);
    expect(content.responsible_module).toBe("packages/runtime");
    expect(content.proposed_verification).toContain("re-run the failed stack gate");
  });

  it("is deterministic", () => {
    const signal: FailureSignal = { origin: "test", gateLayer: "stack" };
    expect(diagnose(signal).digest).toBe(diagnose(signal).digest);
  });
});

describe("diagnosisEdgeRecord", () => {
  it("links Finding DIAGNOSED_BY RootCauseAnalysis", () => {
    const rca = diagnose({ origin: "test", gateLayer: "stack" });
    const edge = diagnosisEdgeRecord(rca, CONTEXT);
    expect(validateSchema("edge", edge).valid).toBe(true);
    expect(edge.type).toBe("DIAGNOSED_BY");
    expect(edge.source_id).toBe("finding_build");
    expect(edge.target_id).toBe("rca_build");
  });
});
