import { canonicalStringSet } from "../identity/canonical-set.js";
import { contentDigest } from "../identity/digest.js";
import { domainRecordId } from "../identity/record-id.js";
import { PROTOCOL_1_1_VERSION } from "../protocol.js";
import type { AcceptedPrdRecord, RequirementBaselineRecord } from "../schema/acceptance.js";
import type { CaptureSessionRecord } from "../schema/capture.js";
import type { PrdProposalRecord } from "../schema/proposal.js";
import type { RequirementBaselineCriterionSeed } from "../schema/acceptance.js";
import { sealRecordEnvelope } from "../schema/envelope.js";

/**
 * Accepted PRD and requirement baseline constructors (intent-to-prd design
 * 6.8, 7.5). The accepted record seals the unique proposal content digest
 * plus every binding that authorized the acceptance; the baseline references
 * the same content digest and materializes the Criterion → Test seed mapping.
 * Both are plain deterministic functions of already-committed facts.
 */
export class AcceptanceRecordError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "AcceptanceRecordError";
    this.kind = kind;
  }
}

function requireDigest(value: string | undefined, field: string): string {
  if (value === undefined) {
    throw new AcceptanceRecordError(
      "missing_binding",
      `cannot accept without a committed ${field} on the session`,
    );
  }
  return value;
}

/** One PRD identity per capture session; revisions chain via supersedes. */
export function deriveAcceptedPrdId(sessionId: string): string {
  return domainRecordId({
    domain_tag: "capture_prd",
    id_prefix: "prd",
    protocol_version: PROTOCOL_1_1_VERSION,
    canonical_input: { session_id: sessionId },
  });
}

export interface CreateRequirementBaselineInput {
  readonly session: CaptureSessionRecord;
  readonly proposal: PrdProposalRecord;
  readonly prd_revision: number;
  /** Deterministic Criterion → Test seed bindings in canonical order. */
  readonly criterion_test_seeds: readonly RequirementBaselineCriterionSeed[];
}

export function createRequirementBaselineRecord(
  input: CreateRequirementBaselineInput,
): RequirementBaselineRecord {
  const proposal = input.proposal;
  const requirementIds = canonicalStringSet(
    proposal.content.requirements.map((requirement) => requirement.id),
  );
  const constraintIds = canonicalStringSet(
    proposal.content.constraints.map((constraint) => constraint.id),
  );
  const seeds = [...input.criterion_test_seeds].sort((left, right) =>
    left.criterion_id < right.criterion_id ? -1 : left.criterion_id > right.criterion_id ? 1 : 0,
  );
  const documentDigest = contentDigest({
    proposal_content_digest: proposal.content_digest,
    requirement_ids: requirementIds,
    constraint_ids: constraintIds,
    criterion_test_seeds: seeds,
  });
  return sealRecordEnvelope({
    protocol_version: PROTOCOL_1_1_VERSION,
    record_kind: "requirement_baseline" as const,
    baseline_id: domainRecordId({
      domain_tag: "requirement_baseline",
      id_prefix: "requirement-baseline",
      protocol_version: PROTOCOL_1_1_VERSION,
      canonical_input: {
        prd_id: deriveAcceptedPrdId(input.session.session_id),
        prd_revision: input.prd_revision,
        document_digest: documentDigest,
      },
    }),
    session_id: input.session.session_id,
    prd_id: deriveAcceptedPrdId(input.session.session_id),
    prd_revision: input.prd_revision,
    proposal_content_digest: proposal.content_digest,
    requirement_ids: requirementIds,
    constraint_ids: constraintIds,
    criterion_test_seeds: seeds,
    baseline_document_digest: documentDigest,
  });
}

export interface CreateAcceptedPrdInput {
  readonly session: CaptureSessionRecord;
  readonly proposal: PrdProposalRecord;
  /** 1-based revision of this prd_id; supersedes binds the previous record. */
  readonly revision: number;
  readonly supersedes_digest?: string;
  readonly approval_digest: string;
  readonly requirement_baseline_digest: string;
  /** Digest of the governing Policy (distinct from the CapturePolicy digest). */
  readonly policy_digest: string;
}

export function createAcceptedPrdRecord(input: CreateAcceptedPrdInput): AcceptedPrdRecord {
  const session = input.session;
  if (!Number.isInteger(input.revision) || input.revision < 1) {
    throw new AcceptanceRecordError("invalid_revision", "accepted PRD revision must be >= 1");
  }
  if (input.revision > 1 && input.supersedes_digest === undefined) {
    throw new AcceptanceRecordError(
      "missing_supersedes",
      "a superseding accepted PRD revision must bind its predecessor",
    );
  }
  const prdId = deriveAcceptedPrdId(session.session_id);
  return sealRecordEnvelope({
    protocol_version: PROTOCOL_1_1_VERSION,
    record_kind: "accepted_prd" as const,
    prd_id: prdId,
    revision: input.revision,
    session_id: session.session_id,
    workflow_operation_id: session.workflow_operation_id,
    proposal_id: input.proposal.proposal_id,
    proposal_content_digest: input.proposal.content_digest,
    proposal_context_bundle_digest: requireDigest(
      session.proposal_context_bundle_digest,
      "proposal_context_bundle_digest",
    ),
    review_context_bundle_digest: requireDigest(
      session.review_context_bundle_digest,
      "review_context_bundle_digest",
    ),
    validation_report_digest: requireDigest(
      session.current_validation_digest,
      "current_validation_digest",
    ),
    review_report_digest: requireDigest(session.current_review_digest, "current_review_digest"),
    risk_assessment_digest: requireDigest(
      session.current_risk_assessment_digest,
      "current_risk_assessment_digest",
    ),
    project_profile_digest: session.project_profile_digest,
    profile_decision_digest: session.profile_decision_digest,
    capture_policy_digest: session.capture_policy_digest,
    policy_digest: input.policy_digest,
    approval_digest: input.approval_digest,
    requirement_baseline_digest: input.requirement_baseline_digest,
    ...(input.supersedes_digest === undefined
      ? {}
      : { supersedes_digest: input.supersedes_digest }),
  });
}
