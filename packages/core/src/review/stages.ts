import type { CaptureStageHandler, CaptureStageResult } from "../capture/commands.js";
import { readProjectContextBundles } from "../context/store.js";
import { domainRecordId } from "../identity/record-id.js";
import { PROTOCOL_1_1_VERSION } from "../protocol.js";
import { findPrdProposalByDigest, readPrdValidationReports } from "../proposal/store.js";
import type { ClarificationQuestionDraft } from "../capture/records.js";
import type { PrdReviewPort, PrdReviewRubric } from "./port.js";
import {
  ReviewRecordError,
  createPrdReviewReportRecord,
  prdReviewRubricDigest,
} from "./records.js";
import {
  appendPrdReviewReportRecord,
  readManualReviewInputs,
  readPrdReviewReports,
} from "./store.js";

/**
 * Coordinator stage wiring (intent-to-prd design 10): wraps a PrdReviewPort
 * into the `reviewing` stage handler. The handler assembles the port input
 * from committed facts only — the current proposal, the review-purpose
 * context bundle, the passed validation report and the latest rubric-matching
 * manual review input — runs the adapter, then canonicalizes the draft:
 * rubric coverage, verdict consistency, finding target verification and the
 * independence binding are all enforced by `createPrdReviewReportRecord`
 * before the report is persisted. The reviewer is only ever called after the
 * deterministic hard gates passed; the Coordinator state machine makes the
 * ordering structural.
 */
export interface CaptureReviewStageDeps {
  readonly projectRoot: string;
  readonly review: PrdReviewPort;
  readonly rubric: PrdReviewRubric;
  readonly adapter_profile: {
    readonly adapter_profile_digest: string;
    readonly prompt_version_digest: string;
    readonly reviewer_identity: string;
  };
}

function stageFailure(
  code: string,
  summary: string,
  retryable: boolean,
): { kind: "stage_failed"; failure: { code: string; summary: string; retryable: boolean } } {
  return { kind: "stage_failed", failure: { code, summary, retryable } };
}

export function createCaptureReviewStageHandlers(deps: CaptureReviewStageDeps): {
  readonly review: CaptureStageHandler;
} {
  const root = deps.projectRoot;

  const review: CaptureStageHandler = async (request) => {
    const session = request.session;
    const invocation = request.invocation;
    if (invocation === undefined) {
      return stageFailure(
        "invocation_missing",
        "the reviewing stage requires a committed invocation record",
        false,
      );
    }
    if (session.current_proposal_digest === undefined) {
      return stageFailure("proposal_missing", "no current proposal digest to review", false);
    }
    const proposal = findPrdProposalByDigest(
      root,
      session.session_id,
      session.current_proposal_digest,
    );
    if (proposal === undefined) {
      return stageFailure(
        "proposal_missing",
        "no committed proposal matches the session's current proposal digest",
        false,
      );
    }
    const bundle = readProjectContextBundles(root).find(
      (candidate) =>
        candidate.session_id === session.session_id &&
        candidate.purpose === "review" &&
        candidate.content_digest === session.review_context_bundle_digest,
    );
    if (bundle === undefined) {
      return stageFailure(
        "context_bundle_missing",
        "no committed review-purpose context bundle matches the session binding",
        false,
      );
    }
    const validation = readPrdValidationReports(root, session.session_id).find(
      (candidate) => candidate.report_digest === session.current_validation_digest,
    );
    if (validation === undefined) {
      return stageFailure(
        "validation_missing",
        "no committed validation report matches the session binding",
        false,
      );
    }
    // The hard gates always precede the reviewer (design 7.4): a report that
    // did not pass, or that binds another proposal, is a deterministic refusal.
    if (validation.passed !== true || validation.proposal_digest !== proposal.content_digest) {
      return stageFailure(
        "validation_not_passed",
        "the reviewing stage requires a passed validation report for the current proposal",
        false,
      );
    }
    const rubricDigest = prdReviewRubricDigest(deps.rubric);
    const manualInput = readManualReviewInputs(root, session.session_id)
      .filter((candidate) => candidate.rubric_digest === rubricDigest)
      .at(-1);
    const conversationId = domainRecordId({
      domain_tag: "capture_conversation",
      id_prefix: "capture-conversation",
      protocol_version: PROTOCOL_1_1_VERSION,
      canonical_input: { invocation_id: invocation.invocation_id },
    });
    const result = await deps.review.review({
      session,
      proposal,
      review_context_bundle: bundle,
      validation_report: validation,
      ...(manualInput === undefined ? {} : { manual_input: manualInput }),
      rubric: deps.rubric,
      profile: deps.adapter_profile,
      invocation: {
        invocation_id: invocation.invocation_id,
        conversation_id: conversationId,
        evidence_locator: `capture-evidence://${invocation.invocation_id}`,
      },
    });
    if (result.status === "failed") {
      return stageFailure(result.failure.code, result.failure.summary, result.failure.retryable);
    }
    if (result.status === "input_required") {
      return { kind: "review_input_required" };
    }
    try {
      const report = createPrdReviewReportRecord({
        session,
        proposal,
        review_context_bundle: bundle,
        validation_report: validation,
        draft: result.report,
        rubric: deps.rubric,
        reviewer_adapter_profile_digest: deps.adapter_profile.adapter_profile_digest,
        prompt_version_digest: deps.adapter_profile.prompt_version_digest,
        reviewer_identity: deps.adapter_profile.reviewer_identity,
        invocation_id: invocation.invocation_id,
        conversation_id: conversationId,
        evidence_locator: `capture-evidence://${invocation.invocation_id}`,
        ...(manualInput === undefined ? {} : { manual_input_digest: manualInput.record_digest }),
      });
      // Idempotent resume: the same committed inputs reseal to the same report.
      const existing = readPrdReviewReports(root, session.session_id).find(
        (candidate) => candidate.review_report_id === report.review_report_id,
      );
      if (existing === undefined) {
        appendPrdReviewReportRecord(root, report);
      }
      const questions: ClarificationQuestionDraft[] = report.suggested_questions.map(
        (question) => ({
          source: "review" as const,
          target_kind: question.target_kind,
          ...(question.target_id === undefined ? {} : { target_id: question.target_id }),
          missing_dimension: question.missing_dimension,
          question: question.question,
          ...(question.options === undefined ? {} : { options: question.options }),
          required: question.required,
        }),
      );
      const outcome: CaptureStageResult = {
        kind: "review_completed",
        verdict: report.verdict,
        review_digest: report.report_digest,
        ...(questions.length === 0 ? {} : { questions }),
      };
      return outcome;
    } catch (error) {
      if (error instanceof ReviewRecordError) {
        return stageFailure("review_invalid", error.message, false);
      }
      throw error;
    }
  };

  return { review };
}
