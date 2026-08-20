import type { CaptureStageHandler } from "../capture/commands.js";
import { appendProfileRecommendationRecord } from "../profile/store.js";
import { createProfileRecommendationRecord } from "../profile/recommendation.js";
import { findPrdProposalByDigest, readPrdValidationReports } from "../proposal/store.js";
import { readPrdReviewReports } from "../review/store.js";
import { assessCaptureRisk, routeCaptureApproval, type CaptureRiskPolicy } from "./engine.js";
import { RiskRecordError, createCaptureRiskAssessmentRecord } from "./records.js";
import { appendCaptureRiskAssessmentRecord } from "./store.js";

/**
 * Coordinator stage wiring (intent-to-prd design 6.7/15): the deterministic
 * risk engine behind the `risk_assessing` stage. It consumes only committed
 * records, persists the replayable CaptureRiskAssessmentRecord, then derives
 * the approval route — Policy auto approval only for low/non-material/high
 * confidence on an explicitly allowing non-Governed policy, a profile upgrade
 * recommendation when the triggered risks exceed the current profile, a typed
 * denial when the Policy denies the level, otherwise human approval.
 */
export interface CaptureRiskStageDeps {
  readonly projectRoot: string;
  readonly policy: CaptureRiskPolicy;
  /** Digest of the governing Policy bound into the assessment record. */
  readonly policy_digest: string;
}

function stageFailure(
  code: string,
  summary: string,
  retryable: boolean,
): { kind: "stage_failed"; failure: { code: string; summary: string; retryable: boolean } } {
  return { kind: "stage_failed", failure: { code, summary, retryable } };
}

export function createCaptureRiskStageHandlers(deps: CaptureRiskStageDeps): {
  readonly assessRisk: CaptureStageHandler;
} {
  const root = deps.projectRoot;

  const assessRisk: CaptureStageHandler = (request) => {
    const session = request.session;
    if (session.current_proposal_digest === undefined) {
      return stageFailure("proposal_missing", "no current proposal digest to assess", false);
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
    const outcome = assessCaptureRisk({
      proposal,
      validation_report: validation,
      review_report: review,
    });
    let assessment;
    try {
      assessment = createCaptureRiskAssessmentRecord({
        session,
        outcome,
        policy_digest: deps.policy_digest,
      });
    } catch (error) {
      if (error instanceof RiskRecordError) {
        return stageFailure("risk_invalid", error.message, false);
      }
      throw error;
    }
    // Idempotent resume: the same committed facts reseal to the same record.
    appendCaptureRiskAssessmentRecord(root, assessment);

    const route = routeCaptureApproval(
      assessment,
      { proposal, validation_report: validation, review_report: review },
      deps.policy,
    );
    if (route.kind === "denied") {
      return { kind: "risk_denied" };
    }
    if (route.kind === "upgrade_required") {
      const recommendation = createProfileRecommendationRecord({
        project_id: deps.policy.project_id,
        iteration_id: session.iteration_id,
        current_profile_id: deps.policy.profile_id,
        triggered: [...route.triggers],
        risk_object_digest: assessment.assessment_digest,
        requirement_digest: proposal.content_digest,
        scope_digest: proposal.content_digest,
        policy_digest: deps.policy_digest,
        rationale: `Capture 风险 ${assessment.level} 命中触发器 ${route.triggers.join(", ")}，建议升级到 ${route.recommended_profile_id}。`,
      });
      if (recommendation !== undefined) {
        appendProfileRecommendationRecord(root, recommendation);
      }
      return { kind: "risk_upgrade_required" };
    }
    if (route.kind === "policy_auto") {
      return {
        kind: "risk_stable",
        risk_assessment_digest: assessment.assessment_digest,
        approval_route: "policy_auto",
        policy_actor: deps.policy.policy_actor,
      };
    }
    return { kind: "risk_stable", risk_assessment_digest: assessment.assessment_digest };
  };

  return { assessRisk };
}
