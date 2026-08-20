import { contentDigest } from "../identity/digest.js";
import { domainRecordId } from "../identity/record-id.js";
import { PROTOCOL_1_1_VERSION } from "../protocol.js";
import type { CaptureSessionRecord } from "../schema/capture.js";
import type { ProjectContextBundleRecord } from "../schema/context.js";
import type { PrdProposalRecord, PrdValidationReportRecord } from "../schema/proposal.js";
import type {
  ManualReviewInputRecord,
  PrdReviewDimensionInput,
  PrdReviewReportDraft,
  PrdReviewReportRecord,
} from "../schema/review.js";
import { sealRecordEnvelope } from "../schema/envelope.js";
import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../schema/registry.js";
import type { PrdReviewRubric } from "./port.js";

/**
 * Canonicalization from adapter review draft to authoritative review report
 * (intent-to-prd design 6.6/10.2). The Coordinator — never the adapter — owns
 * the report identity, the verdict consistency rules (accept requires zero
 * critical findings and every mandatory dimension satisfied; clarify requires
 * questions), the finding target verification against the reviewed proposal
 * and the independence binding against the proposal invocation. An adapter
 * output violating any of these is a deterministic rejection.
 */
export class ReviewRecordError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "ReviewRecordError";
    this.kind = kind;
  }
}

function fail(kind: string, message: string): never {
  throw new ReviewRecordError(kind, message);
}

/** Canonical digest of the rubric the review ran under. */
export function prdReviewRubricDigest(rubric: PrdReviewRubric): string {
  return contentDigest({
    rubric_id: rubric.rubric_id,
    dimensions: [...rubric.dimensions].sort((left, right) =>
      left.dimension_id < right.dimension_id ? -1 : 1,
    ),
    mandatory_dimension_ids: [...rubric.mandatory_dimension_ids].sort(),
  });
}

function proposalEntityIds(
  proposal: PrdProposalRecord,
  targetKind: string,
): ReadonlySet<string> | undefined {
  const content = proposal.content;
  switch (targetKind) {
    case "requirement":
      return new Set(content.requirements.map((entity) => entity.id));
    case "constraint":
      return new Set(content.constraints.map((entity) => entity.id));
    case "acceptance_criterion":
      return new Set(content.acceptance_criteria.map((entity) => entity.criterion_id));
    case "risk":
      return new Set(content.risks.map((entity) => entity.id));
    case "glossary":
      return new Set(content.glossary.map((entity) => entity.id));
    case "intent":
      return new Set(["intent"]);
    default:
      // prd_section: no entity registry to verify against
      return undefined;
  }
}

export interface CreatePrdReviewReportInput {
  readonly session: CaptureSessionRecord;
  readonly proposal: PrdProposalRecord;
  readonly review_context_bundle: ProjectContextBundleRecord;
  readonly validation_report: PrdValidationReportRecord;
  readonly draft: PrdReviewReportDraft;
  readonly rubric: PrdReviewRubric;
  readonly reviewer_adapter_profile_digest: string;
  readonly prompt_version_digest: string;
  readonly reviewer_identity: string;
  readonly invocation_id: string;
  readonly conversation_id: string;
  readonly evidence_locator: string;
  /** Digest of the manual rubric input this review consumed, if any. */
  readonly manual_input_digest?: string;
}

export function createPrdReviewReportRecord(
  input: CreatePrdReviewReportInput,
): PrdReviewReportRecord {
  const draftValidation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate(
    "prd-review-report-draft",
    input.draft,
  );
  if (!draftValidation.valid) {
    fail(
      "invalid_draft",
      `review draft failed schema validation: ${draftValidation.errors
        .map((error) => `${error.instancePath}: ${error.message}`)
        .join("; ")}`,
    );
  }
  const draft = input.draft;
  const proposal = input.proposal;

  // --- binding to the reviewed facts --------------------------------------
  if (input.validation_report.passed !== true) {
    fail("validation_not_passed", "review requires a passed validation report");
  }
  if (input.validation_report.proposal_digest !== proposal.content_digest) {
    fail(
      "validation_binding_mismatch",
      "the validation report does not bind the reviewed proposal",
    );
  }
  if (input.review_context_bundle.purpose !== "review") {
    fail("invalid_bundle", "the review context bundle must be purpose-bound to review");
  }

  // --- independence (design 10.2): review never shares identity with the ---
  // --- proposal it reviews. -----------------------------------------------
  const proposalBinding = proposal.input_binding;
  if (input.invocation_id === proposalBinding.invocation_id) {
    fail("independence_violation", "review reuses the proposal invocation id");
  }
  if (input.conversation_id === proposalBinding.conversation_id) {
    fail("independence_violation", "review reuses the proposal conversation id");
  }
  if (input.reviewer_adapter_profile_digest === proposalBinding.adapter_profile_digest) {
    fail("independence_violation", "review reuses the proposal adapter profile");
  }
  if (input.prompt_version_digest === proposalBinding.prompt_version_digest) {
    fail("independence_violation", "review reuses the proposal prompt version");
  }
  if (
    input.review_context_bundle.content_digest === proposalBinding.proposal_context_bundle_digest
  ) {
    fail("independence_violation", "review reuses the proposal context bundle");
  }

  // --- rubric coverage ------------------------------------------------------
  const rubricDimensionIds = new Set(
    input.rubric.dimensions.map((dimension) => dimension.dimension_id),
  );
  const seenDimensions = new Set<string>();
  for (const dimension of draft.dimensions) {
    if (!rubricDimensionIds.has(dimension.dimension_id)) {
      fail(
        "unknown_dimension",
        `review dimension is not part of the rubric: ${dimension.dimension_id}`,
      );
    }
    if (seenDimensions.has(dimension.dimension_id)) {
      fail("duplicate_dimension", `dimension assessed twice: ${dimension.dimension_id}`);
    }
    seenDimensions.add(dimension.dimension_id);
  }
  for (const mandatory of input.rubric.mandatory_dimension_ids) {
    if (!seenDimensions.has(mandatory)) {
      fail("missing_dimension", `mandatory rubric dimension missing from the review: ${mandatory}`);
    }
  }

  // --- finding targets ------------------------------------------------------
  const seenFindings = new Set<string>();
  for (const finding of draft.findings) {
    if (seenFindings.has(finding.finding_id)) {
      fail("duplicate_finding", `finding id used twice: ${finding.finding_id}`);
    }
    seenFindings.add(finding.finding_id);
    if (finding.target_id !== undefined) {
      const ids = proposalEntityIds(proposal, finding.target_kind);
      if (ids !== undefined && !ids.has(finding.target_id)) {
        fail(
          "unknown_finding_target",
          `finding ${finding.finding_id} targets ${finding.target_kind} ${finding.target_id}, which is not part of the reviewed proposal`,
        );
      }
    }
  }

  // --- verdict consistency ----------------------------------------------------
  if (draft.verdict === "clarify" && draft.suggested_questions.length === 0) {
    fail("verdict_inconsistent", "a clarify verdict must carry suggested questions");
  }
  if (draft.verdict === "accept") {
    const critical = draft.findings.find((finding) => finding.severity === "critical");
    if (critical !== undefined) {
      fail(
        "verdict_inconsistent",
        `an accept verdict cannot carry the unresolved critical finding ${critical.finding_id}`,
      );
    }
    const deficientMandatory = input.rubric.mandatory_dimension_ids.find(
      (dimensionId) =>
        draft.dimensions.find((dimension) => dimension.dimension_id === dimensionId)?.status !==
        "satisfied",
    );
    if (deficientMandatory !== undefined) {
      fail(
        "verdict_inconsistent",
        `an accept verdict requires mandatory dimension ${deficientMandatory} to be satisfied`,
      );
    }
  }

  const dimensions = [...draft.dimensions].sort((left, right) =>
    left.dimension_id < right.dimension_id ? -1 : left.dimension_id > right.dimension_id ? 1 : 0,
  );
  const findings = [...draft.findings].sort((left, right) =>
    left.finding_id < right.finding_id ? -1 : left.finding_id > right.finding_id ? 1 : 0,
  );
  const suggestedQuestions = draft.suggested_questions.map((question) => ({ ...question }));
  const reportDigest = contentDigest({
    session_id: input.session.session_id,
    proposal_digest: proposal.content_digest,
    review_context_bundle_digest: input.review_context_bundle.content_digest,
    validation_digest: input.validation_report.report_digest,
    reviewer_adapter_profile_digest: input.reviewer_adapter_profile_digest,
    reviewer_identity: input.reviewer_identity,
    prompt_version_digest: input.prompt_version_digest,
    invocation_id: input.invocation_id,
    conversation_id: input.conversation_id,
    manual_input_digest: input.manual_input_digest ?? null,
    verdict: draft.verdict,
    dimensions,
    findings,
    suggested_questions: suggestedQuestions,
  });
  return sealRecordEnvelope({
    protocol_version: PROTOCOL_1_1_VERSION,
    record_kind: "prd_review_report" as const,
    review_report_id: domainRecordId({
      domain_tag: "prd_review_report",
      id_prefix: "prd-review-report",
      protocol_version: PROTOCOL_1_1_VERSION,
      canonical_input: { report_digest: reportDigest },
    }),
    session_id: input.session.session_id,
    proposal_digest: proposal.content_digest,
    review_context_bundle_digest: input.review_context_bundle.content_digest,
    validation_digest: input.validation_report.report_digest,
    reviewer_adapter_profile_digest: input.reviewer_adapter_profile_digest,
    reviewer_identity: input.reviewer_identity,
    prompt_version_digest: input.prompt_version_digest,
    invocation_id: input.invocation_id,
    conversation_id: input.conversation_id,
    evidence_locator: input.evidence_locator,
    verdict: draft.verdict,
    dimensions,
    findings,
    suggested_questions: suggestedQuestions,
    report_digest: reportDigest,
  });
}

export interface CreateManualReviewInput {
  readonly session: CaptureSessionRecord;
  readonly review_invocation_id: string;
  readonly reviewer_actor: string;
  /** Digest of the rubric the input was recorded against. */
  readonly rubric_digest: string;
  readonly dimension_inputs: readonly PrdReviewDimensionInput[];
  readonly expected_session_digest: string;
  /**
   * When the caller knows the rubric (the review stage), dimension inputs are
   * verified against it; the Coordinator-only command path leaves this unset
   * and the stage rejects unknown dimensions deterministically.
   */
  readonly known_dimension_ids?: readonly string[];
}

/**
 * The human rubric input (design 6.6). It binds the review invocation that
 * requested input, the rubric and the session revision the reviewer saw; it is
 * stored independently and never flows back into clarification answers.
 */
export function createManualReviewInputRecord(
  input: CreateManualReviewInput,
): ManualReviewInputRecord {
  if (input.expected_session_digest !== input.session.record_digest) {
    fail(
      "session_digest_mismatch",
      "the manual review input does not bind the current session revision",
    );
  }
  if (input.reviewer_actor.trim().length === 0) {
    fail("invalid_input", "reviewer_actor must be a non-empty actor identity");
  }
  if (input.dimension_inputs.length === 0) {
    fail("invalid_input", "a manual review input must cover at least one dimension");
  }
  const known = input.known_dimension_ids;
  const seen = new Set<string>();
  for (const dimension of input.dimension_inputs) {
    if (known !== undefined && !known.includes(dimension.dimension_id)) {
      fail(
        "unknown_dimension",
        `manual input dimension is not part of the rubric: ${dimension.dimension_id}`,
      );
    }
    if (seen.has(dimension.dimension_id)) {
      fail("duplicate_dimension", `manual input dimension given twice: ${dimension.dimension_id}`);
    }
    seen.add(dimension.dimension_id);
  }
  const dimensionInputs = [...input.dimension_inputs].sort((left, right) =>
    left.dimension_id < right.dimension_id ? -1 : left.dimension_id > right.dimension_id ? 1 : 0,
  );
  const rubricDigest = input.rubric_digest;
  const contentKey = contentDigest({
    session_id: input.session.session_id,
    review_invocation_id: input.review_invocation_id,
    reviewer_actor: input.reviewer_actor,
    rubric_digest: rubricDigest,
    dimension_inputs: dimensionInputs,
  });
  return sealRecordEnvelope({
    protocol_version: PROTOCOL_1_1_VERSION,
    record_kind: "manual_review_input" as const,
    manual_review_input_id: domainRecordId({
      domain_tag: "manual_review_input",
      id_prefix: "manual-review-input",
      protocol_version: PROTOCOL_1_1_VERSION,
      canonical_input: { content_key: contentKey },
    }),
    session_id: input.session.session_id,
    review_invocation_id: input.review_invocation_id,
    reviewer_actor: input.reviewer_actor,
    rubric_digest: rubricDigest,
    dimension_inputs: dimensionInputs,
    expected_session_digest: input.expected_session_digest,
  });
}
