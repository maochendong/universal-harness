import {
  PROTOCOL_VERSION,
  contentDigest,
  validateSchema,
  type EdgeRecord,
  type FeedbackRecord,
  type NodeRecord,
} from "@universal-harness-internal/core";
import {
  findingClosableBy,
  type CurrentEvidenceState,
  type GateEvidenceRecord,
} from "@universal-harness-internal/runtime";

/**
 * Canonical Finding records and their lifecycle (design 9.1, plan Task 21).
 * Test, review, audit, runtime and evaluation failures share one feedback
 * protocol: the failure is normalized into a proposed Finding that carries
 * exactly what it violates and what it blocks. A Finding is closed only by
 * current repair evidence -- passed, non-provisional and still fresh against
 * every bound digest; stale evidence never closes anything (completion rule
 * 19). Records are immutable: every transition reseals a new digest.
 */
export const FINDING_EXTENSION_KEY = "harness.finding";

export const FEEDBACK_ERROR_KINDS = [
  "invalid_feedback_record",
  "invalid_feedback_transition",
  "stale_evidence",
  "upstream_write_forbidden",
  "invalid_revision_task",
  "invalid_improvement_candidate",
  "unapproved_promotion",
  "promotion_binding_mismatch",
  "self_promotion",
] as const;

export type FeedbackErrorKind = (typeof FEEDBACK_ERROR_KINDS)[number];

export class FeedbackError extends Error {
  readonly kind: FeedbackErrorKind;

  constructor(kind: FeedbackErrorKind, message: string) {
    super(message);
    this.name = "FeedbackError";
    this.kind = kind;
  }
}

/** Failure sources that share the feedback protocol (design 9.1). */
export const FINDING_ORIGINS = ["test", "review", "audit", "runtime", "evaluation"] as const;

export type FindingOrigin = (typeof FINDING_ORIGINS)[number];

export interface FindingSubject {
  readonly origin: FindingOrigin;
  /** True while the finding blocks its Task or Iteration from completing. */
  readonly blocking: boolean;
  /** Requirement/Constraint/Policy node ids the finding violates. */
  readonly violates: readonly string[];
  /** Task/Iteration node ids the finding blocks. */
  readonly blocks: readonly string[];
  /** Evidence ids that observed the failure. */
  readonly evidence: readonly string[];
}

export interface FindingSpec {
  readonly id: string;
  readonly iterationId: string;
  readonly summary: string;
  readonly subject: FindingSubject;
  /** ISO timestamp clock; fake in tests. */
  readonly clock: () => string;
}

const FINDING_SUMMARY_LIMIT = 10_000;

function formatValidationErrors(
  errors: readonly { instancePath: string; message?: string }[],
): string {
  return errors.map((issue) => `${issue.instancePath}: ${issue.message}`).join("; ");
}

/** Seal a feedback record: content digest plus schema validation. */
export function sealFeedbackRecord(content: Record<string, unknown>): FeedbackRecord {
  const record = { ...content, digest: contentDigest(content) };
  const validation = validateSchema("feedback", record);
  if (!validation.valid) {
    throw new FeedbackError(
      "invalid_feedback_record",
      `invalid feedback record: ${formatValidationErrors(validation.errors)}`,
    );
  }
  return record as unknown as FeedbackRecord;
}

/** Reseal an existing record under a new status; everything else carries over. */
export function resealFeedbackRecord(
  record: FeedbackRecord,
  status: FeedbackRecord["status"],
): FeedbackRecord {
  const content: Record<string, unknown> = { ...record, status };
  delete content.digest;
  return sealFeedbackRecord(content);
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function normalizeSubject(subject: FindingSubject): FindingSubject {
  if (!(FINDING_ORIGINS as readonly string[]).includes(subject.origin)) {
    throw new FeedbackError(
      "invalid_feedback_record",
      `unknown finding origin ${JSON.stringify(subject.origin)}`,
    );
  }
  return {
    origin: subject.origin,
    blocking: subject.blocking,
    violates: sortedUnique(subject.violates),
    blocks: sortedUnique(subject.blocks),
    evidence: sortedUnique(subject.evidence),
  };
}

/**
 * Normalize a failure into a canonical proposed Finding. Gate runners and
 * evaluators may emit bare findings; this builder is the normalizer that
 * binds the finding to the nodes it violates and blocks, so downstream RCA,
 * impact analysis and routing never guess.
 */
export function buildFindingRecord(spec: FindingSpec): FeedbackRecord {
  const subject = normalizeSubject(spec.subject);
  return sealFeedbackRecord({
    protocol_version: PROTOCOL_VERSION,
    record_kind: "feedback",
    id: spec.id,
    type: "Finding",
    iteration_id: spec.iterationId,
    status: "proposed",
    summary: spec.summary.slice(0, FINDING_SUMMARY_LIMIT),
    created_at: spec.clock(),
    extensions: { [FINDING_EXTENSION_KEY]: subject },
  });
}

/** The bound subject of a canonical Finding record, or throw. */
export function readFindingSubject(record: FeedbackRecord): FindingSubject {
  if (record.type !== "Finding") {
    throw new FeedbackError(
      "invalid_feedback_record",
      `expected a Finding record, got ${record.type}`,
    );
  }
  const extension = record.extensions?.[FINDING_EXTENSION_KEY];
  if (typeof extension !== "object" || extension === null) {
    throw new FeedbackError(
      "invalid_feedback_record",
      `finding ${record.id} carries no ${FINDING_EXTENSION_KEY} subject`,
    );
  }
  return extension as FindingSubject;
}

function assertFindingStatus(
  record: FeedbackRecord,
  allowed: readonly FeedbackRecord["status"][],
  action: string,
): void {
  if (record.type !== "Finding") {
    throw new FeedbackError(
      "invalid_feedback_record",
      `expected a Finding record, got ${record.type}`,
    );
  }
  if (!allowed.includes(record.status)) {
    throw new FeedbackError(
      "invalid_feedback_transition",
      `cannot ${action} finding ${record.id} in status ${record.status}`,
    );
  }
}

/** Triage: a proposed Finding becomes accepted for repair routing. */
export function acceptFinding(record: FeedbackRecord): FeedbackRecord {
  assertFindingStatus(record, ["proposed"], "accept");
  return resealFeedbackRecord(record, "accepted");
}

/** A Finding no longer relevant (fixed elsewhere or duplicated) is superseded. */
export function supersedeFinding(record: FeedbackRecord): FeedbackRecord {
  assertFindingStatus(record, ["proposed", "accepted"], "supersede");
  return resealFeedbackRecord(record, "superseded");
}

/**
 * Close a repaired Finding (completion rule 19). Only current repair evidence
 * counts: the evidence must be a passed, non-provisional verdict whose bound
 * digests still hold. Stale, provisional or failed evidence is rejected with
 * a typed error -- it can never close the Finding, no matter how green it
 * once was.
 */
export function closeFinding(
  record: FeedbackRecord,
  repairEvidence: GateEvidenceRecord,
  current: CurrentEvidenceState,
): FeedbackRecord {
  assertFindingStatus(record, ["proposed", "accepted"], "close");
  if (!findingClosableBy(repairEvidence, current)) {
    throw new FeedbackError(
      "stale_evidence",
      `finding ${record.id} cannot be closed: repair evidence ${repairEvidence.evidence_id} is not a current passing verdict`,
    );
  }
  return resealFeedbackRecord(record, "closed");
}

/** Provenance context for ledger nodes and edges derived from feedback. */
export interface FeedbackDerivationContext {
  readonly actor: string;
  readonly timestamp: string;
}

const ORIGIN_SOURCE: Readonly<Record<FindingOrigin, NodeRecord["source"]>> = {
  test: "gate",
  review: "human",
  audit: "audit",
  runtime: "workflow",
  evaluation: "evaluation",
};

const NODE_STATUS_BY_FEEDBACK_STATUS: Readonly<
  Record<FeedbackRecord["status"], NodeRecord["status"]>
> = {
  proposed: "proposed",
  accepted: "accepted",
  closed: "accepted",
  superseded: "superseded",
};

/**
 * Project a Finding feedback record into the Artifact Graph as a Finding
 * node, so impact analysis can seed from it. The extension carries the
 * feedback digest and the bound subject; the node digest is content-derived.
 */
export function findingNodeRecord(
  record: FeedbackRecord,
  context: FeedbackDerivationContext,
): NodeRecord {
  const subject = readFindingSubject(record);
  const content: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "node",
    id: record.id,
    type: "Finding",
    revision: 1,
    status: NODE_STATUS_BY_FEEDBACK_STATUS[record.status],
    source: ORIGIN_SOURCE[subject.origin],
    provenance: {
      iteration_id: record.iteration_id,
      actor: context.actor,
      timestamp: context.timestamp,
    },
    confidence: 1,
    extensions: {
      [FINDING_EXTENSION_KEY]: { feedback_digest: record.digest, ...subject },
    },
  };
  const node = { ...content, digest: contentDigest(content) };
  const validation = validateSchema("node", node);
  if (!validation.valid) {
    throw new FeedbackError(
      "invalid_feedback_record",
      `invalid finding node record: ${formatValidationErrors(validation.errors)}`,
    );
  }
  return node as unknown as NodeRecord;
}

const EDGE_ID_LIMIT = 160;

function feedbackEdge(
  id: string,
  type: EdgeRecord["type"],
  sourceId: string,
  targetId: string,
  status: EdgeRecord["status"],
  source: EdgeRecord["source"],
  iterationId: string,
  context: FeedbackDerivationContext,
): EdgeRecord {
  if (id.length > EDGE_ID_LIMIT) {
    throw new FeedbackError("invalid_feedback_record", `edge id ${id} exceeds 160 characters`);
  }
  const content: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "edge",
    id,
    type,
    source_id: sourceId,
    target_id: targetId,
    status,
    source,
    provenance: {
      iteration_id: iterationId,
      actor: context.actor,
      timestamp: context.timestamp,
    },
    confidence: 1,
  };
  const edge = { ...content, digest: contentDigest(content) };
  const validation = validateSchema("edge", edge);
  if (!validation.valid) {
    throw new FeedbackError(
      "invalid_feedback_record",
      `invalid feedback edge record: ${formatValidationErrors(validation.errors)}`,
    );
  }
  return edge as unknown as EdgeRecord;
}

/** Shared edge builder for feedback-derived relations (VIOLATES, BLOCKS, ...). */
export function feedbackEdgeRecord(spec: {
  readonly id: string;
  readonly type: EdgeRecord["type"];
  readonly sourceId: string;
  readonly targetId: string;
  readonly status: EdgeRecord["status"];
  readonly source: EdgeRecord["source"];
  readonly iterationId: string;
  readonly context: FeedbackDerivationContext;
}): EdgeRecord {
  return feedbackEdge(
    spec.id,
    spec.type,
    spec.sourceId,
    spec.targetId,
    spec.status,
    spec.source,
    spec.iterationId,
    spec.context,
  );
}

/**
 * The graph relations a Finding states as facts: it VIOLATES each bound
 * Requirement/Constraint/Policy and BLOCKS each bound Task/Iteration.
 * Propagation from the finding seed follows exactly these edges.
 */
export function findingEdgeRecords(
  record: FeedbackRecord,
  context: FeedbackDerivationContext,
): readonly EdgeRecord[] {
  const subject = readFindingSubject(record);
  const source = ORIGIN_SOURCE[subject.origin];
  return [
    ...subject.violates.map((targetId) =>
      feedbackEdge(
        `edge_${record.id}-violates-${targetId}`,
        "VIOLATES",
        record.id,
        targetId,
        "accepted",
        source,
        record.iteration_id,
        context,
      ),
    ),
    ...subject.blocks.map((targetId) =>
      feedbackEdge(
        `edge_${record.id}-blocks-${targetId}`,
        "BLOCKS",
        record.id,
        targetId,
        "accepted",
        source,
        record.iteration_id,
        context,
      ),
    ),
  ];
}
