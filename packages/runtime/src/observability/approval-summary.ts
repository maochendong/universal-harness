import {
  canonicalizeJson,
  harnessRootFor,
  readCommittedOperations,
  readManagedManifest,
  sha256Hex,
  validateSchema,
} from "@universal-harness-internal/core";

import {
  approvalDecisionArtifactPath,
  type ApprovalDecision,
  type ApprovalDecisionRecord,
} from "../approval/request.js";
import { listArtifactFiles, readVerifiedArtifact } from "../workflow/checkpoint.js";

/**
 * Shared read-only approval decision summary (transparency spec §5.1, §10).
 * One committed Decision artifact — located by its manifest-recorded byte
 * digest — is the only accepted source; the raw actor never leaves this
 * module, both the CLI and the Dashboard render the same decision, identity
 * and time for the same reference. Task 5's general artifact reader reuses
 * this verification instead of growing a second source-of-truth check.
 */
export interface ApprovalSummary {
  readonly request_id: string;
  readonly approval_id: string;
  readonly decision: ApprovalDecision;
  /** Project-scoped stable redacted identity; never the raw actor. */
  readonly actor_display: string;
  readonly decided_at: string;
  readonly decision_digest: string;
}

/** The committed operation whose manifest vouches for the decision bytes. */
export interface ApprovalSummaryProvenance {
  readonly ledger_operation_id: string;
  readonly workflow_operation_id: string;
  readonly artifact_path: string;
  readonly committed_at: string;
}

export interface ApprovalSummaryRead {
  readonly summary: ApprovalSummary;
  readonly provenance: ApprovalSummaryProvenance;
}

export type ApprovalSummaryErrorKind = "approval_decision_not_found" | "approval_decision_corrupt";

export class ApprovalSummaryError extends Error {
  readonly kind: ApprovalSummaryErrorKind;

  constructor(kind: ApprovalSummaryErrorKind, message: string) {
    super(message);
    this.name = "ApprovalSummaryError";
    this.kind = kind;
  }
}

const UNMANAGED_PROJECT_SCOPE = "unmanaged-project";

/**
 * Project-scoped display identity (spec §10): SHA-256 over the canonical
 * encoding of the project id and the actor, first 12 hex digits behind a
 * fixed "审批者" prefix. Stable per project and actor, irreversible enough
 * that the raw actor (email, external subject) never enters an event, an SSE
 * view or this summary. It is a display label only — never an
 * authentication or authorization identifier.
 */
export function approvalActorDisplay(projectRoot: string, actor: string): string {
  let scope = UNMANAGED_PROJECT_SCOPE;
  try {
    scope = readManagedManifest(projectRoot).repository_id;
  } catch {
    // Bare ledger roots (no managed project manifest) still get a
    // deterministic scope, so the display stays stable for one project.
  }
  return `审批者${sha256Hex(canonicalizeJson([scope, actor])).slice(0, 12)}`;
}

/**
 * Read the shared summary of one committed approval Decision by its
 * manifest-recorded byte digest. A digest no committed manifest carries is a
 * typed not-found (never an inferred success); a digest whose bytes went
 * missing or no longer match is a typed corruption error.
 */
export function readApprovalSummary(
  projectRoot: string,
  decisionDigest: string,
): ApprovalSummaryRead {
  const harnessRoot = harnessRootFor(projectRoot);
  const operations = readCommittedOperations(harnessRoot);
  const committing = operations
    .filter((operation) => operation.manifest.artifact_digests.includes(decisionDigest))
    .sort((left, right) => left.manifest.sequence - right.manifest.sequence)[0];
  if (committing === undefined) {
    throw new ApprovalSummaryError(
      "approval_decision_not_found",
      `no committed manifest carries decision digest ${decisionDigest}`,
    );
  }
  const corrupt = (detail: string): ApprovalSummaryError =>
    new ApprovalSummaryError(
      "approval_decision_corrupt",
      `committed decision ${decisionDigest} is not readable: ${detail}`,
    );
  let relativePath: string | undefined;
  let bytes: string | undefined;
  for (const candidate of listArtifactFiles(harnessRoot, "artifacts/approvals")) {
    let content: string;
    try {
      content = readVerifiedArtifact(harnessRoot, candidate, new Set([decisionDigest]));
    } catch {
      continue;
    }
    relativePath = candidate;
    bytes = content;
    break;
  }
  if (relativePath === undefined || bytes === undefined) {
    throw corrupt("the decision artifact bytes are missing or no longer match the digest");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw corrupt("the decision artifact is not parsable JSON");
  }
  const record = parsed as ApprovalDecisionRecord;
  if (
    typeof record !== "object" ||
    record === null ||
    record.record_kind !== "approval_decision" ||
    !validateSchema("runtime", record).valid
  ) {
    throw corrupt("the decision artifact is not a valid approval decision record");
  }
  if (relativePath !== approvalDecisionArtifactPath(record.approval_id)) {
    throw corrupt("the decision artifact path does not match its approval_id");
  }
  return {
    summary: {
      request_id: record.request_id,
      approval_id: record.approval_id,
      decision: record.decision,
      actor_display: approvalActorDisplay(projectRoot, record.actor),
      decided_at: record.decided_at,
      decision_digest: decisionDigest,
    },
    provenance: {
      ledger_operation_id: committing.manifest.ledger_operation_id,
      workflow_operation_id: committing.manifest.workflow_operation_id,
      artifact_path: relativePath,
      committed_at: committing.manifest.committed_at,
    },
  };
}
