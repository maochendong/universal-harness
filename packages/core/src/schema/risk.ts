import { Type, type Static } from "@sinclair/typebox";

import { DigestSchema, IdentifierSchema, enumerated, strictObject } from "./common.js";
import { recordEnvelopeSchema } from "./envelope.js";

/**
 * Protocol 1.1 capture risk assessment schemas (intent-to-prd design 6.7).
 * Risk-adaptive approval must replay from a deterministic record, not from
 * implicit judgments inside the reviewer or the Coordinator: the assessment
 * binds every fact it consumed, and the versioned rule set digests the
 * reduction rules themselves.
 */
export const CAPTURE_RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type CaptureRiskLevel = (typeof CAPTURE_RISK_LEVELS)[number];

export const CAPTURE_MATERIALITIES = ["non_material", "material"] as const;
export type CaptureMateriality = (typeof CAPTURE_MATERIALITIES)[number];

export const CAPTURE_RISK_CONFIDENCES = ["high", "medium", "low"] as const;
export type CaptureRiskConfidence = (typeof CAPTURE_RISK_CONFIDENCES)[number];

export const CAPTURE_RISK_TRIGGER_SOURCES = [
  "proposal",
  "validation",
  "review",
  "context_classification",
  "policy",
] as const;
export type CaptureRiskTriggerSource = (typeof CAPTURE_RISK_TRIGGER_SOURCES)[number];

export const CaptureRiskTriggerSchema = strictObject({
  trigger_id: Type.String({ minLength: 1, maxLength: 160 }),
  source_kind: enumerated(CAPTURE_RISK_TRIGGER_SOURCES),
  source_id: Type.String({ minLength: 1, maxLength: 400 }),
  source_digest: DigestSchema,
  severity: enumerated(CAPTURE_RISK_LEVELS),
  reason: Type.String({ minLength: 1, maxLength: 4000 }),
});
export type CaptureRiskTrigger = Static<typeof CaptureRiskTriggerSchema>;

/** Deterministic, replayable risk assessment bound to every input digest. */
export const CaptureRiskAssessmentRecordSchema = recordEnvelopeSchema("capture_risk_assessment", {
  risk_assessment_id: IdentifierSchema,
  session_id: IdentifierSchema,
  proposal_content_digest: DigestSchema,
  validation_report_digest: DigestSchema,
  review_report_digest: DigestSchema,
  proposal_context_bundle_digest: DigestSchema,
  review_context_bundle_digest: DigestSchema,
  project_profile_digest: DigestSchema,
  profile_decision_digest: DigestSchema,
  capture_policy_digest: DigestSchema,
  policy_digest: DigestSchema,
  rule_set_digest: DigestSchema,
  level: enumerated(CAPTURE_RISK_LEVELS),
  materiality: enumerated(CAPTURE_MATERIALITIES),
  confidence: enumerated(CAPTURE_RISK_CONFIDENCES),
  triggers: Type.Array(CaptureRiskTriggerSchema),
  assessment_digest: DigestSchema,
});
export type CaptureRiskAssessmentRecord = Static<typeof CaptureRiskAssessmentRecordSchema>;
