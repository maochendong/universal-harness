import { domainRecordId } from "../identity/record-id.js";
import { contentDigest } from "../identity/digest.js";
import { PROTOCOL_1_1_VERSION } from "../protocol.js";
import type { CaptureSessionRecord } from "../schema/capture.js";
import type { CaptureRiskAssessmentRecord, CaptureRiskTrigger } from "../schema/risk.js";
import { sealRecordEnvelope } from "../schema/envelope.js";
import { captureRiskRuleSetDigest, type CaptureRiskOutcome } from "./engine.js";

/**
 * Capture risk assessment record constructor (intent-to-prd design 6.7). The
 * record binds every fact the reduction consumed — proposal, validation,
 * review, both context bundles, profile, decision, capture policy, policy and
 * the versioned rule set — so the same inputs always reseal to the same
 * assessment digest and any drift rotates it.
 */
export interface CreateCaptureRiskAssessmentInput {
  readonly session: CaptureSessionRecord;
  readonly outcome: CaptureRiskOutcome;
  /** Digest of the governing Policy (distinct from the CapturePolicy digest). */
  readonly policy_digest: string;
}

export function createCaptureRiskAssessmentRecord(
  input: CreateCaptureRiskAssessmentInput,
): CaptureRiskAssessmentRecord {
  const session = input.session;
  const digests = {
    proposal_content_digest: session.current_proposal_digest,
    validation_report_digest: session.current_validation_digest,
    review_report_digest: session.current_review_digest,
    proposal_context_bundle_digest: session.proposal_context_bundle_digest,
    review_context_bundle_digest: session.review_context_bundle_digest,
  };
  for (const [field, value] of Object.entries(digests)) {
    if (value === undefined) {
      throw new RiskRecordError(
        "missing_binding",
        `cannot assess risk without a committed ${field} on the session`,
      );
    }
  }
  const triggers: CaptureRiskTrigger[] = [...input.outcome.triggers];
  const ruleSetDigest = captureRiskRuleSetDigest();
  const assessmentDigest = contentDigest({
    session_id: session.session_id,
    ...digests,
    project_profile_digest: session.project_profile_digest,
    profile_decision_digest: session.profile_decision_digest,
    capture_policy_digest: session.capture_policy_digest,
    policy_digest: input.policy_digest,
    rule_set_digest: ruleSetDigest,
    level: input.outcome.level,
    materiality: input.outcome.materiality,
    confidence: input.outcome.confidence,
    triggers,
  });
  return sealRecordEnvelope({
    protocol_version: PROTOCOL_1_1_VERSION,
    record_kind: "capture_risk_assessment" as const,
    risk_assessment_id: domainRecordId({
      domain_tag: "capture_risk_assessment",
      id_prefix: "capture-risk-assessment",
      protocol_version: PROTOCOL_1_1_VERSION,
      canonical_input: { assessment_digest: assessmentDigest },
    }),
    session_id: session.session_id,
    proposal_content_digest: digests.proposal_content_digest as string,
    validation_report_digest: digests.validation_report_digest as string,
    review_report_digest: digests.review_report_digest as string,
    proposal_context_bundle_digest: digests.proposal_context_bundle_digest as string,
    review_context_bundle_digest: digests.review_context_bundle_digest as string,
    project_profile_digest: session.project_profile_digest,
    profile_decision_digest: session.profile_decision_digest,
    capture_policy_digest: session.capture_policy_digest,
    policy_digest: input.policy_digest,
    rule_set_digest: ruleSetDigest,
    level: input.outcome.level,
    materiality: input.outcome.materiality,
    confidence: input.outcome.confidence,
    triggers,
    assessment_digest: assessmentDigest,
  });
}

export class RiskRecordError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "RiskRecordError";
    this.kind = kind;
  }
}
