import {
  PROTOCOL_VERSION,
  type EdgeRecord,
  type FeedbackRecord,
} from "@universal-harness-internal/core";
import {
  POLICY_ERROR_KINDS,
  TOOL_ERROR_KINDS,
  type GateLayer,
} from "@universal-harness-internal/runtime";

import type { EvaluationDimension } from "../case.js";
import {
  FeedbackError,
  feedbackEdgeRecord,
  sealFeedbackRecord,
  type FeedbackDerivationContext,
  type FindingOrigin,
} from "./finding.js";
import type { TargetLayer } from "./router.js";

/**
 * Structured Root Cause Analysis (design 9.1, plan Task 21). Deterministic
 * rules assign known failure patterns first; everything unclassified falls
 * back to a minimal-confidence diagnosis that always requires human review --
 * M1 ships no semantic classifier, so the fallback is where one would plug
 * in. Every RCA records the observed symptom, the evidence, the responsible
 * layer and module, a root-cause category, a confidence and a proposed
 * verification, and high-risk or low-confidence conclusions are flagged for
 * human review. A model may propose a classification, but it can never pick
 * a privileged route on its own: routing consumes only these deterministic
 * fields.
 */
export const RCA_EXTENSION_KEY = "harness.rca";

export const ROOT_CAUSE_CATEGORIES = [
  "requirement_gap",
  "design_flaw",
  "spec_ambiguity",
  "plan_error",
  "policy_violation",
  "tool_defect",
  "test_defect",
  "evaluation_gap",
  "implementation_defect",
  "environment",
] as const;

export type RootCauseCategory = (typeof ROOT_CAUSE_CATEGORIES)[number];

/** Below this confidence a conclusion always requires human review. */
export const HUMAN_REVIEW_CONFIDENCE = 0.7;

/** Structured signals the failing phase reports alongside the Finding. */
export interface FailureSignal {
  readonly origin: FindingOrigin;
  /** Gate layer for gate-executed failures. */
  readonly gateLayer?: GateLayer;
  /** Failed evaluation dimension for evaluation failures. */
  readonly dimension?: EvaluationDimension;
  /** Typed error kind surfaced by the tool or policy boundary. */
  readonly errorKind?: string;
  /** Responsible module hint from the failing phase. */
  readonly module?: string;
  /** Evidence ids that observed the failure. */
  readonly evidenceIds?: readonly string[];
  /** High-risk failures require human review regardless of confidence. */
  readonly highRisk?: boolean;
  /**
   * Responsible-layer hint for unclassified failures; this is the semantic
   * hook -- deterministic rules never consult it.
   */
  readonly layerHint?: TargetLayer;
}

export interface RootCauseContent {
  readonly finding_id: string;
  readonly observed_symptom: string;
  readonly evidence_ids: readonly string[];
  readonly responsible_layer: TargetLayer;
  readonly responsible_module: string;
  readonly category: RootCauseCategory;
  readonly confidence: number;
  readonly proposed_verification: string;
  readonly requires_human_review: boolean;
  /** Name of the deterministic rule that fired, or "unclassified". */
  readonly rule: string;
}

interface RootCauseRule {
  readonly name: string;
  readonly match: (signal: FailureSignal) => boolean;
  readonly category: RootCauseCategory;
  readonly layer: TargetLayer;
  readonly confidence: number;
  readonly verification: string;
}

const POLICY_KINDS: readonly string[] = POLICY_ERROR_KINDS;
const TOOL_KINDS: readonly string[] = TOOL_ERROR_KINDS;

/**
 * Deterministic failure patterns, first match wins. Each rule names the
 * owning target layer of the repair; the confidence reflects how directly
 * the signal identifies the cause.
 */
const ROOT_CAUSE_RULES: readonly RootCauseRule[] = [
  {
    name: "evaluation-dimension",
    match: (signal) => signal.origin === "evaluation",
    category: "evaluation_gap",
    layer: "eval",
    confidence: 0.9,
    verification: "re-run the evaluation case after revising the evaluation assets",
  },
  {
    name: "policy-decision",
    match: (signal) => signal.errorKind !== undefined && POLICY_KINDS.includes(signal.errorKind),
    category: "policy_violation",
    layer: "policy",
    confidence: 0.95,
    verification: "re-run the failed check after the policy revision",
  },
  {
    name: "tool-error",
    match: (signal) => signal.errorKind !== undefined && TOOL_KINDS.includes(signal.errorKind),
    category: "tool_defect",
    layer: "tool",
    confidence: 0.9,
    verification: "re-run the failed check after the tool manifest revision",
  },
  {
    name: "gate-project",
    match: (signal) => signal.origin === "test" && signal.gateLayer === "project",
    category: "test_defect",
    layer: "test",
    confidence: 0.8,
    verification: "re-run the failed project gate after the test revision",
  },
  {
    name: "gate-stack",
    match: (signal) => signal.origin === "test" && signal.gateLayer === "stack",
    category: "implementation_defect",
    layer: "architecture",
    confidence: 0.7,
    verification: "re-run the failed stack gate after the component revision",
  },
  {
    name: "gate-universal",
    match: (signal) => signal.origin === "test" && signal.gateLayer === "universal",
    category: "spec_ambiguity",
    layer: "spec",
    confidence: 0.5,
    verification: "re-run the failed universal gate after the specification revision",
  },
];

const FALLBACK_CATEGORY: RootCauseCategory = "implementation_defect";
const FALLBACK_CONFIDENCE = 0.3;

function classify(signal: FailureSignal): {
  readonly rule: string;
  readonly category: RootCauseCategory;
  readonly layer: TargetLayer;
  readonly confidence: number;
  readonly verification: string;
} {
  for (const rule of ROOT_CAUSE_RULES) {
    if (rule.match(signal)) {
      return {
        rule: rule.name,
        category: rule.category,
        layer: rule.layer,
        confidence: rule.confidence,
        verification: rule.verification,
      };
    }
  }
  return {
    rule: "unclassified",
    category: FALLBACK_CATEGORY,
    layer: signal.layerHint ?? "plan",
    confidence: FALLBACK_CONFIDENCE,
    verification: "reproduce the failure, then re-run the failed check after the revision",
  };
}

export interface RootCauseSpec {
  readonly id: string;
  readonly finding: FeedbackRecord;
  readonly signal: FailureSignal;
  /** ISO timestamp clock; fake in tests. */
  readonly clock: () => string;
}

/**
 * Diagnose a Finding into a structured, proposed RootCauseAnalysis record.
 * The diagnosis is fully determined by the finding and the signal: same
 * inputs, same record, same digest.
 */
export function analyzeRootCause(spec: RootCauseSpec): FeedbackRecord {
  if (spec.finding.type !== "Finding") {
    throw new FeedbackError(
      "invalid_feedback_record",
      `root cause analysis requires a Finding record, got ${spec.finding.type}`,
    );
  }
  const diagnosis = classify(spec.signal);
  const content: RootCauseContent = {
    finding_id: spec.finding.id,
    observed_symptom: spec.finding.summary,
    evidence_ids: [...new Set(spec.signal.evidenceIds ?? [])].sort(),
    responsible_layer: diagnosis.layer,
    responsible_module: spec.signal.module ?? "unscoped",
    category: diagnosis.category,
    confidence: diagnosis.confidence,
    proposed_verification: diagnosis.verification,
    requires_human_review:
      diagnosis.confidence < HUMAN_REVIEW_CONFIDENCE || spec.signal.highRisk === true,
    rule: diagnosis.rule,
  };
  return sealFeedbackRecord({
    protocol_version: PROTOCOL_VERSION,
    record_kind: "feedback",
    id: spec.id,
    type: "RootCauseAnalysis",
    iteration_id: spec.finding.iteration_id,
    status: "proposed",
    summary: `${spec.finding.id}: ${diagnosis.category} in ${diagnosis.layer} (${diagnosis.rule})`,
    created_at: spec.clock(),
    extensions: { [RCA_EXTENSION_KEY]: content },
  });
}

/** The structured content of a RootCauseAnalysis record, or throw. */
export function readRootCauseContent(record: FeedbackRecord): RootCauseContent {
  if (record.type !== "RootCauseAnalysis") {
    throw new FeedbackError(
      "invalid_feedback_record",
      `expected a RootCauseAnalysis record, got ${record.type}`,
    );
  }
  const extension = record.extensions?.[RCA_EXTENSION_KEY];
  if (typeof extension !== "object" || extension === null) {
    throw new FeedbackError(
      "invalid_feedback_record",
      `root cause analysis ${record.id} carries no ${RCA_EXTENSION_KEY} content`,
    );
  }
  return extension as RootCauseContent;
}

/** The accepted Finding DIAGNOSED_BY RootCauseAnalysis graph relation. */
export function diagnosisEdgeRecord(
  rca: FeedbackRecord,
  context: FeedbackDerivationContext,
): EdgeRecord {
  const content = readRootCauseContent(rca);
  return feedbackEdgeRecord({
    id: `edge_${content.finding_id}-diagnosed-by-${rca.id}`,
    type: "DIAGNOSED_BY",
    sourceId: content.finding_id,
    targetId: rca.id,
    status: "accepted",
    source: "evaluation",
    iterationId: rca.iteration_id,
    context,
  });
}
