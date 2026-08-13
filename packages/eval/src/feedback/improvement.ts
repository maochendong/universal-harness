import {
  PROTOCOL_VERSION,
  type EdgeRecord,
  type FeedbackRecord,
} from "@universal-harness-internal/core";
import { findSecretReferences } from "@universal-harness-internal/runtime";

import {
  FeedbackError,
  feedbackEdgeRecord,
  sealFeedbackRecord,
  type FeedbackDerivationContext,
} from "./finding.js";
import { TARGET_LAYERS, type TargetLayer } from "./router.js";

/**
 * Reviewable ImprovementCandidate (design 9.1 and principle 8, plan Task
 * 21). When a diagnosed failure class is reusable, the RCA produces one or
 * more candidates targeting evaluation, knowledge or engineering assets. A
 * candidate must be reproducible, state its expected behavior, name the
 * representative failure class, carry a verification method and contain no
 * unapproved secret references. It is always born `proposed`; only an
 * approved promotion (promotion.ts) may turn it into a ledger revision --
 * learning proposes, it never writes.
 */
export const IMPROVEMENT_EXTENSION_KEY = "harness.improvement";

export const IMPROVEMENT_TARGET_KINDS = ["evaluation", "knowledge", "engineering"] as const;

export type ImprovementTargetKind = (typeof IMPROVEMENT_TARGET_KINDS)[number];

export interface ImprovementCandidateContent {
  readonly target_kind: ImprovementTargetKind;
  readonly target_layer: TargetLayer;
  /** Representative failure class this improvement prevents. */
  readonly failure_class: string;
  readonly expected_behavior: string;
  /** Deterministic reproduction steps; at least one is required. */
  readonly reproduction: readonly string[];
  readonly verification_method: string;
  /** Diagnosis this candidate was produced from. */
  readonly source_rca_id?: string;
  /** Secret reference names approved for inclusion; all others are rejected. */
  readonly approved_secret_references: readonly string[];
}

export interface ImprovementCandidateSpec {
  readonly id: string;
  readonly iterationId: string;
  readonly summary: string;
  readonly content: ImprovementCandidateContent;
  /** ISO timestamp clock; fake in tests. */
  readonly clock: () => string;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new FeedbackError(
      "invalid_improvement_candidate",
      `improvement candidate requires a non-empty ${field}`,
    );
  }
}

function normalizeContent(content: ImprovementCandidateContent): ImprovementCandidateContent {
  if (!(IMPROVEMENT_TARGET_KINDS as readonly string[]).includes(content.target_kind)) {
    throw new FeedbackError(
      "invalid_improvement_candidate",
      `unknown improvement target kind ${JSON.stringify(content.target_kind)}`,
    );
  }
  if (!(TARGET_LAYERS as readonly string[]).includes(content.target_layer)) {
    throw new FeedbackError(
      "invalid_improvement_candidate",
      `unknown improvement target layer ${JSON.stringify(content.target_layer)}`,
    );
  }
  assertNonEmpty(content.failure_class, "failure_class");
  assertNonEmpty(content.expected_behavior, "expected_behavior");
  assertNonEmpty(content.verification_method, "verification_method");
  if (content.reproduction.length === 0) {
    throw new FeedbackError(
      "invalid_improvement_candidate",
      "improvement candidate must be reproducible: at least one reproduction step is required",
    );
  }
  const approved = new Set(content.approved_secret_references);
  const unapproved = findSecretReferences(content as unknown as Record<string, unknown>).filter(
    (site) => !approved.has(site.name),
  );
  if (unapproved.length > 0) {
    throw new FeedbackError(
      "invalid_improvement_candidate",
      `improvement candidate contains unapproved secret reference(s): ${unapproved
        .map((site) => site.name)
        .join(", ")}`,
    );
  }
  return {
    target_kind: content.target_kind,
    target_layer: content.target_layer,
    failure_class: content.failure_class,
    expected_behavior: content.expected_behavior,
    reproduction: [...content.reproduction],
    verification_method: content.verification_method,
    ...(content.source_rca_id === undefined ? {} : { source_rca_id: content.source_rca_id }),
    approved_secret_references: [...new Set(content.approved_secret_references)].sort(),
  };
}

/**
 * Build a proposed ImprovementCandidate. The record is schema-valid and
 * content-digested; the same inputs always produce the same candidate.
 */
export function buildImprovementCandidate(spec: ImprovementCandidateSpec): FeedbackRecord {
  const content = normalizeContent(spec.content);
  return sealFeedbackRecord({
    protocol_version: PROTOCOL_VERSION,
    record_kind: "feedback",
    id: spec.id,
    type: "ImprovementCandidate",
    iteration_id: spec.iterationId,
    status: "proposed",
    summary: spec.summary,
    created_at: spec.clock(),
    extensions: { [IMPROVEMENT_EXTENSION_KEY]: content },
  });
}

/** The content of an ImprovementCandidate record, or throw. */
export function readImprovementContent(record: FeedbackRecord): ImprovementCandidateContent {
  if (record.type !== "ImprovementCandidate") {
    throw new FeedbackError(
      "invalid_feedback_record",
      `expected an ImprovementCandidate record, got ${record.type}`,
    );
  }
  const extension = record.extensions?.[IMPROVEMENT_EXTENSION_KEY];
  if (typeof extension !== "object" || extension === null) {
    throw new FeedbackError(
      "invalid_feedback_record",
      `improvement candidate ${record.id} carries no ${IMPROVEMENT_EXTENSION_KEY} content`,
    );
  }
  return extension as ImprovementCandidateContent;
}

/**
 * The proposed ImprovementCandidate PROPOSES_CHANGE_TO target relation. The
 * edge stays `proposed` until the candidate's promotion is approved; only
 * then may the target revision be applied.
 */
export function improvementEdgeRecord(
  candidate: FeedbackRecord,
  targetNodeId: string,
  context: FeedbackDerivationContext,
): EdgeRecord {
  if (candidate.type !== "ImprovementCandidate") {
    throw new FeedbackError(
      "invalid_feedback_record",
      `expected an ImprovementCandidate record, got ${candidate.type}`,
    );
  }
  return feedbackEdgeRecord({
    id: `edge_${candidate.id}-proposes-${targetNodeId}`,
    type: "PROPOSES_CHANGE_TO",
    sourceId: candidate.id,
    targetId: targetNodeId,
    status: "proposed",
    source: "workflow",
    iterationId: candidate.iteration_id,
    context,
  });
}
