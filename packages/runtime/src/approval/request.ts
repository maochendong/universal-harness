import {
  PROTOCOL_1_2_VERSION,
  PROTOCOL_VERSION,
  canonicalizeJson,
  sha256Hex,
  validateSchema,
} from "@universal-harness-internal/core";

import {
  artifactDigestAllowlist,
  listArtifactFiles,
  readVerifiedJsonArtifact,
} from "../workflow/checkpoint.js";
import type { CommittedOperation } from "@universal-harness-internal/core";

/**
 * ApprovalRequest records (design 11.3). A request binds one exact
 * object/type/digest plus the baseline, policy, Impact Path and preview
 * digests at creation time. The human-readable preview and the `--json`
 * output are both rendered from the same canonical record, and the record
 * carries the preview digest so any drift between the two views is
 * detectable on read.
 */
export const APPROVAL_EXTENSION_KEY = "harness.approval";

export const APPROVAL_RISKS = ["low", "medium", "high", "critical"] as const;

export type ApprovalRisk = (typeof APPROVAL_RISKS)[number];

export type ApprovalDecision = "approve" | "reject" | "defer";

/** Matches `ApprovalRequestRecordSchema` in core; validated on write and read. */
export interface ApprovalRequestRecord {
  readonly protocol_version: string;
  readonly record_kind: "approval_request";
  readonly request_id: string;
  readonly workflow_operation_id: string;
  readonly object_id: string;
  readonly object_type: string;
  readonly object_digest: string;
  readonly baseline_digest: string;
  readonly policy_digest: string;
  readonly preview_digest: string;
  readonly impact_path: readonly string[];
  readonly risk: ApprovalRisk;
  readonly reason: string;
  readonly allowed_decisions: readonly ApprovalDecision[];
  readonly created_at: string;
  readonly resume_phase: string;
  readonly requester_principal_id?: string;
  readonly requester_principal_snapshot_digest?: string;
  readonly extensions?: Record<string, unknown>;
}

/** Matches `ApprovalDecisionRecordSchema` in core; validated on write and read. */
export interface ApprovalDecisionRecord {
  readonly protocol_version: string;
  readonly record_kind: "approval_decision";
  readonly approval_id: string;
  readonly request_id: string;
  readonly actor: string;
  readonly decision: ApprovalDecision;
  readonly object_digest: string;
  readonly decided_at: string;
  readonly extensions?: Record<string, unknown>;
}

export type ApprovalErrorKind =
  | "approval_request_invalid"
  | "approval_decision_invalid"
  | "approval_request_not_found"
  | "approval_not_pending"
  | "approval_decision_not_allowed"
  | "approval_binding_mismatch"
  | "approval_self_approval"
  | "approval_binding_drift"
  | "ledger_failure";

export class ApprovalError extends Error {
  readonly kind: ApprovalErrorKind;
  readonly data?: Record<string, unknown>;

  constructor(kind: ApprovalErrorKind, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = "ApprovalError";
    this.kind = kind;
    if (data !== undefined) this.data = data;
  }
}

export interface ApprovalRequestSpec {
  readonly requestId: string;
  readonly workflowOperationId: string;
  readonly objectId: string;
  readonly objectType: string;
  readonly objectDigest: string;
  readonly baselineDigest: string;
  readonly policyDigest: string;
  readonly impactPath: readonly string[];
  readonly risk: ApprovalRisk;
  readonly reason: string;
  readonly allowedDecisions: readonly ApprovalDecision[];
  readonly createdAt: string;
  readonly resumePhase: string;
  /** Actor whose proposal is being approved; may never resolve the request. */
  readonly proposedBy: string;
  /**
   * First-class requester Principal binding for remote approval (design §9.3).
   * When present the record is emitted at protocol 1.2 and carries
   * `requester_principal_id` plus `requester_principal_snapshot_digest`;
   * requests without it keep the local `proposed_by` semantics and can never
   * be remotely approved.
   */
  readonly requesterPrincipal?: {
    readonly principal_id: string;
    readonly principal_snapshot_digest: string;
  };
  /** Set when this request re-issues one whose bindings drifted. */
  readonly supersedesRequestId?: string;
}

/** Request id this request supersedes, if any (stored in extensions). */
export function supersededRequestId(record: ApprovalRequestRecord): string | undefined {
  const extension = record.extensions?.[APPROVAL_EXTENSION_KEY];
  if (typeof extension !== "object" || extension === null) return undefined;
  const supersedes = (extension as { supersedes_request_id?: unknown }).supersedes_request_id;
  return typeof supersedes === "string" ? supersedes : undefined;
}

/** Actor whose proposal the request controls (stored in extensions). */
export function proposedByOf(record: ApprovalRequestRecord): string | undefined {
  const extension = record.extensions?.[APPROVAL_EXTENSION_KEY];
  if (typeof extension !== "object" || extension === null) return undefined;
  const proposedBy = (extension as { proposed_by?: unknown }).proposed_by;
  return typeof proposedBy === "string" ? proposedBy : undefined;
}

function requestFields(
  record: Omit<ApprovalRequestRecord, "preview_digest">,
): Record<string, unknown> {
  return {
    protocol_version: record.protocol_version,
    record_kind: record.record_kind,
    request_id: record.request_id,
    workflow_operation_id: record.workflow_operation_id,
    object_id: record.object_id,
    object_type: record.object_type,
    object_digest: record.object_digest,
    baseline_digest: record.baseline_digest,
    policy_digest: record.policy_digest,
    impact_path: [...record.impact_path],
    risk: record.risk,
    reason: record.reason,
    allowed_decisions: [...record.allowed_decisions],
    created_at: record.created_at,
    resume_phase: record.resume_phase,
    ...(record.requester_principal_id === undefined
      ? {}
      : { requester_principal_id: record.requester_principal_id }),
    ...(record.requester_principal_snapshot_digest === undefined
      ? {}
      : { requester_principal_snapshot_digest: record.requester_principal_snapshot_digest }),
    ...(record.extensions === undefined ? {} : { extensions: record.extensions }),
  };
}

/**
 * Human-readable preview rendered from the canonical request record; the
 * `--json` output is the same record. The preview never contains the preview
 * digest itself, so the digest can bind the rendering without a cycle.
 */
export function renderApprovalPreview(
  record: Omit<ApprovalRequestRecord, "preview_digest">,
): string {
  const impactPath = record.impact_path.length === 0 ? "-" : record.impact_path.join(" -> ");
  return [
    `Approval Request: ${record.request_id}`,
    `Object: ${record.object_type} ${record.object_id}`,
    `Object Digest: ${record.object_digest}`,
    `Baseline Digest: ${record.baseline_digest}`,
    `Policy Digest: ${record.policy_digest}`,
    `Impact Path: ${impactPath}`,
    `Risk: ${record.risk}`,
    `Reason: ${record.reason}`,
    `Allowed Decisions: ${record.allowed_decisions.join("|")}`,
    `Workflow Operation: ${record.workflow_operation_id}`,
    `Resume Phase: ${record.resume_phase}`,
    `Created At: ${record.created_at}`,
    ...(record.requester_principal_id === undefined
      ? []
      : [`Requester Principal: ${record.requester_principal_id}`]),
    ...(record.requester_principal_snapshot_digest === undefined
      ? []
      : [`Requester Snapshot Digest: ${record.requester_principal_snapshot_digest}`]),
  ].join("\n");
}

function buildValidated(fields: Record<string, unknown>): ApprovalRequestRecord {
  const validation = validateSchema("runtime", fields);
  if (!validation.valid) {
    const detail = validation.errors
      .map((issue) => `${issue.instancePath}: ${issue.message}`)
      .join("; ");
    throw new ApprovalError("approval_request_invalid", `invalid approval request: ${detail}`);
  }
  return fields as unknown as ApprovalRequestRecord;
}

/** Build a schema-valid request record; the preview digest binds the rendering. */
export function buildApprovalRequest(spec: ApprovalRequestSpec): ApprovalRequestRecord {
  const withoutPreviewDigest: Omit<ApprovalRequestRecord, "preview_digest"> = {
    protocol_version:
      spec.requesterPrincipal === undefined ? PROTOCOL_VERSION : PROTOCOL_1_2_VERSION,
    record_kind: "approval_request",
    request_id: spec.requestId,
    workflow_operation_id: spec.workflowOperationId,
    object_id: spec.objectId,
    object_type: spec.objectType,
    object_digest: spec.objectDigest,
    baseline_digest: spec.baselineDigest,
    policy_digest: spec.policyDigest,
    impact_path: [...spec.impactPath],
    risk: spec.risk,
    reason: spec.reason,
    allowed_decisions: [...spec.allowedDecisions],
    created_at: spec.createdAt,
    resume_phase: spec.resumePhase,
    ...(spec.requesterPrincipal === undefined
      ? {}
      : {
          requester_principal_id: spec.requesterPrincipal.principal_id,
          requester_principal_snapshot_digest: spec.requesterPrincipal.principal_snapshot_digest,
        }),
    extensions: {
      [APPROVAL_EXTENSION_KEY]: {
        proposed_by: spec.proposedBy,
        ...(spec.supersedesRequestId === undefined
          ? {}
          : { supersedes_request_id: spec.supersedesRequestId }),
      },
    },
  };
  const previewDigest = sha256Hex(renderApprovalPreview(withoutPreviewDigest));
  return buildValidated({ ...requestFields(withoutPreviewDigest), preview_digest: previewDigest });
}

/** Recompute the preview digest of a committed record; mismatch means tampering. */
export function previewDigestMatches(record: ApprovalRequestRecord): boolean {
  return sha256Hex(renderApprovalPreview(record)) === record.preview_digest;
}

export function approvalRequestArtifactPath(requestId: string): string {
  return `artifacts/approval-requests/${requestId}.json`;
}

export function approvalDecisionArtifactPath(approvalId: string): string {
  return `artifacts/approvals/${approvalId}.json`;
}

export function approvalRequestArtifact(record: ApprovalRequestRecord): {
  readonly path: string;
  readonly content: string;
} {
  return {
    path: approvalRequestArtifactPath(record.request_id),
    content: `${canonicalizeJson(record)}\n`,
  };
}

export function approvalDecisionArtifact(record: ApprovalDecisionRecord): {
  readonly path: string;
  readonly content: string;
} {
  return {
    path: approvalDecisionArtifactPath(record.approval_id),
    content: `${canonicalizeJson(record)}\n`,
  };
}

/** Remote decision digest bound by a materialized decision, if any (stored in extensions). */
export function remoteDecisionDigestOf(record: ApprovalDecisionRecord): string | undefined {
  const extension = record.extensions?.[APPROVAL_EXTENSION_KEY];
  if (typeof extension !== "object" || extension === null) return undefined;
  const digest = (extension as { remote_decision_digest?: unknown }).remote_decision_digest;
  return typeof digest === "string" ? digest : undefined;
}

/** Build a schema-valid approval decision record bound to one exact object digest. */
export function buildApprovalDecision(spec: {
  readonly approvalId: string;
  readonly requestId: string;
  readonly actor: string;
  readonly decision: ApprovalDecision;
  readonly objectDigest: string;
  readonly decidedAt: string;
  /**
   * Digest of the authoritative RemoteApprovalDecision this decision
   * materializes (design §13.1). When present the record is emitted at
   * protocol 1.2 and the extension contains only this binding.
   */
  readonly remoteDecisionDigest?: string;
}): ApprovalDecisionRecord {
  const fields = {
    protocol_version:
      spec.remoteDecisionDigest === undefined ? PROTOCOL_VERSION : PROTOCOL_1_2_VERSION,
    record_kind: "approval_decision",
    approval_id: spec.approvalId,
    request_id: spec.requestId,
    actor: spec.actor,
    decision: spec.decision,
    object_digest: spec.objectDigest,
    decided_at: spec.decidedAt,
    ...(spec.remoteDecisionDigest === undefined
      ? {}
      : {
          extensions: {
            [APPROVAL_EXTENSION_KEY]: { remote_decision_digest: spec.remoteDecisionDigest },
          },
        }),
  };
  const validation = validateSchema("runtime", fields);
  if (!validation.valid) {
    const detail = validation.errors
      .map((issue) => `${issue.instancePath}: ${issue.message}`)
      .join("; ");
    throw new ApprovalError("approval_decision_invalid", `invalid approval decision: ${detail}`);
  }
  return fields as unknown as ApprovalDecisionRecord;
}

function readRecords<T extends ApprovalRequestRecord | ApprovalDecisionRecord>(
  harnessRoot: string,
  operations: readonly CommittedOperation[],
  workflowOperationId: string,
  relativeDirectory: string,
  recordKind: T["record_kind"],
): T[] {
  const allowed = artifactDigestAllowlist(operations, workflowOperationId);
  const records: T[] = [];
  for (const relative of listArtifactFiles(harnessRoot, relativeDirectory)) {
    let parsed: unknown;
    try {
      parsed = readVerifiedJsonArtifact(harnessRoot, relative, allowed);
    } catch {
      // Orphan bytes of an interrupted commit are not authoritative.
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const candidate = parsed as T;
    if (candidate.record_kind !== recordKind) continue;
    if (recordKind === "approval_request") {
      const request = candidate as ApprovalRequestRecord;
      if (request.workflow_operation_id !== workflowOperationId) continue;
      if (!previewDigestMatches(request)) continue;
    }
    if (!validateSchema("runtime", candidate).valid) continue;
    records.push(candidate);
  }
  return records;
}

/**
 * Committed requests of one workflow operation in deterministic processing
 * order (created_at, then request_id). Decisions resolve strictly one at a
 * time in this order; M1 has no bulk or wildcard approval.
 */
export function readApprovalRequests(
  harnessRoot: string,
  operations: readonly CommittedOperation[],
  workflowOperationId: string,
): ApprovalRequestRecord[] {
  return readRecords<ApprovalRequestRecord>(
    harnessRoot,
    operations,
    workflowOperationId,
    "artifacts/approval-requests",
    "approval_request",
  ).sort((left, right) =>
    left.created_at === right.created_at
      ? left.request_id < right.request_id
        ? -1
        : 1
      : left.created_at < right.created_at
        ? -1
        : 1,
  );
}

/** All committed decision records of one workflow operation. */
export function readApprovalDecisions(
  harnessRoot: string,
  operations: readonly CommittedOperation[],
  workflowOperationId: string,
): ApprovalDecisionRecord[] {
  return readRecords<ApprovalDecisionRecord>(
    harnessRoot,
    operations,
    workflowOperationId,
    "artifacts/approvals",
    "approval_decision",
  );
}

/**
 * All currently pending committed requests across workflow operations.
 * ApprovalRequest artifacts are authoritative only when vouched for by a
 * committed operation. Approve/reject are terminal, defer remains pending,
 * and a reissued request supersedes its predecessor.
 */
export function readPendingApprovalRequests(
  harnessRoot: string,
  operations: readonly CommittedOperation[],
): ApprovalRequestRecord[] {
  const workflowOperationIds = [
    ...new Set(operations.map((operation) => operation.manifest.workflow_operation_id)),
  ];
  const requests = workflowOperationIds.flatMap((workflowOperationId) =>
    readApprovalRequests(harnessRoot, operations, workflowOperationId),
  );
  const terminal = new Set(
    workflowOperationIds.flatMap((workflowOperationId) =>
      readApprovalDecisions(harnessRoot, operations, workflowOperationId)
        .filter((decision) => decision.decision === "approve" || decision.decision === "reject")
        .map((decision) => decision.request_id),
    ),
  );
  const superseded = new Set(
    requests
      .map((request) => supersededRequestId(request))
      .filter((requestId): requestId is string => requestId !== undefined),
  );
  return requests
    .filter((request) => !terminal.has(request.request_id) && !superseded.has(request.request_id))
    .sort((left, right) =>
      left.created_at === right.created_at
        ? left.request_id < right.request_id
          ? -1
          : left.request_id > right.request_id
            ? 1
            : 0
        : left.created_at < right.created_at
          ? -1
          : 1,
    );
}
