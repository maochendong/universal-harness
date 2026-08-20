import type { CaptureStageHandler } from "../capture/commands.js";
import { readProjectContextBundles } from "../context/store.js";
import { findPrdProposalByDigest, readPrdValidationReports } from "../proposal/store.js";
import { readPrdReviewReports } from "../review/store.js";
import { readCaptureRiskAssessments } from "../risk/store.js";
import type { GroundedSynthesisPort } from "./port.js";
import { runApprovalBrief } from "./approval-brief.js";

/**
 * Coordinator stage wiring for the Capture `approval_brief` (intent-to-prd
 * design 7.5/11.1): the handler assembles the committed approval object from
 * the stores, compiles the approval bundle, resolves the Capture-scope
 * binding and runs the GroundedSynthesisPort under bounded controlled
 * retries. A missing binding or an exhausted provider surfaces as a typed
 * failure the Coordinator maps to the `approval_brief_provider_required`
 * blocker; the brief never touches the approved object's digest.
 */
export interface CaptureApprovalBriefStageDeps {
  readonly projectRoot: string;
  readonly port: GroundedSynthesisPort;
  readonly maxRetries?: number;
}

function stageFailure(
  code: string,
  summary: string,
  retryable: boolean,
): { kind: "stage_failed"; failure: { code: string; summary: string; retryable: boolean } } {
  return { kind: "stage_failed", failure: { code, summary, retryable } };
}

export function createCaptureApprovalBriefStageHandler(
  deps: CaptureApprovalBriefStageDeps,
): CaptureStageHandler {
  const root = deps.projectRoot;

  return async (request) => {
    const session = request.session;
    if (session.current_proposal_digest === undefined) {
      return stageFailure("proposal_missing", "no current proposal digest to brief", false);
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
    const review = readPrdReviewReports(root, session.session_id).find(
      (candidate) => candidate.report_digest === session.current_review_digest,
    );
    if (review === undefined) {
      return stageFailure(
        "review_missing",
        "no committed review report matches the session binding",
        false,
      );
    }
    const risk = readCaptureRiskAssessments(root, session.session_id).find(
      (candidate) => candidate.assessment_digest === session.current_risk_assessment_digest,
    );
    if (risk === undefined) {
      return stageFailure(
        "risk_missing",
        "no committed risk assessment matches the session binding",
        false,
      );
    }
    const reviewBundle = readProjectContextBundles(root).find(
      (candidate) =>
        candidate.session_id === session.session_id &&
        candidate.purpose === "review" &&
        candidate.content_digest === session.review_context_bundle_digest,
    );
    if (reviewBundle === undefined) {
      return stageFailure(
        "context_bundle_missing",
        "no committed review-purpose context bundle matches the session binding",
        false,
      );
    }
    const approvalRequestId = session.current_approval_request_id;
    if (approvalRequestId === undefined) {
      return stageFailure(
        "approval_object_incomplete",
        "the approval request must be committed before the brief runs",
        false,
      );
    }
    const outcome = await runApprovalBrief({
      projectRoot: root,
      port: deps.port,
      facts: {
        session,
        proposal,
        validation_report: validation,
        review_report: review,
        risk_assessment: risk,
        review_bundle_sources: reviewBundle.sources,
      },
      approval_request_id: approvalRequestId,
      ...(deps.maxRetries === undefined ? {} : { maxRetries: deps.maxRetries }),
    });
    if (outcome.status === "blocked") {
      return stageFailure(outcome.failure.code, outcome.failure.summary, outcome.failure.retryable);
    }
    return { kind: "approval_brief_ready", brief_digest: outcome.record.record_digest };
  };
}
