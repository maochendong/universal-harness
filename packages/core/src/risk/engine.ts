import { canonicalStringSet } from "../identity/canonical-set.js";
import { contentDigest } from "../identity/digest.js";
import type { ProfileId } from "../schema/profile.js";
import type { PrdProposalRecord, PrdValidationReportRecord } from "../schema/proposal.js";
import type { PrdReviewReportRecord } from "../schema/review.js";
import type {
  CaptureMateriality,
  CaptureRiskAssessmentRecord,
  CaptureRiskConfidence,
  CaptureRiskLevel,
  CaptureRiskTrigger,
} from "../schema/risk.js";
import { recommendProfileUpgrade } from "../profile/recommendation.js";

/**
 * Deterministic capture risk engine (intent-to-prd design 6.7/15). It reduces
 * only committed facts — the reviewed proposal, the passed validation report
 * and the review report — through a versioned rule set: the level is the
 * highest triggered severity, materiality follows the Policy-declared
 * sensitive scopes, and any unknown classification degrades confidence. Review
 * findings feed risk signals; they never set the level or the approval route
 * by themselves.
 */
export const CAPTURE_RISK_RULE_SET = {
  rule_set_id: "capture-risk-rules",
  version: "capture-risk.v1",
} as const;

export function captureRiskRuleSetDigest(): string {
  return contentDigest(CAPTURE_RISK_RULE_SET);
}

const LEVEL_ORDER: readonly CaptureRiskLevel[] = ["low", "medium", "high", "critical"];

function maxLevel(levels: readonly CaptureRiskLevel[]): CaptureRiskLevel {
  let highest: CaptureRiskLevel = "low";
  for (const level of levels) {
    if (LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf(highest)) highest = level;
  }
  return highest;
}

/** Risk/constraint scopes a Policy treats as material (design 6.7). */
const SENSITIVE_RISK_CATEGORIES = new Set([
  "security",
  "privacy",
  "compliance",
  "financial",
  "data_integrity",
  "migration",
]);
const SENSITIVE_CONSTRAINT_CATEGORIES = new Set(["security", "compliance", "compatibility"]);

const REVIEW_SEVERITY_TO_LEVEL: Record<"info" | "warning" | "critical", CaptureRiskLevel> = {
  info: "low",
  warning: "medium",
  critical: "high",
};

export interface CaptureRiskInput {
  readonly proposal: PrdProposalRecord;
  readonly validation_report: PrdValidationReportRecord;
  readonly review_report: PrdReviewReportRecord;
}

export interface CaptureRiskOutcome {
  readonly level: CaptureRiskLevel;
  readonly materiality: CaptureMateriality;
  readonly confidence: CaptureRiskConfidence;
  readonly triggers: readonly CaptureRiskTrigger[];
}

/**
 * Reduce the bound facts to level/materiality/confidence plus the sourced
 * triggers. Trigger identity (`trigger_id`) is deterministic per source so the
 * reduction is stable under input reordering.
 */
export function assessCaptureRisk(input: CaptureRiskInput): CaptureRiskOutcome {
  const triggers: CaptureRiskTrigger[] = [];
  const proposal = input.proposal;

  if (input.validation_report.passed !== true) {
    triggers.push({
      trigger_id: "validation-not-passed",
      source_kind: "validation",
      source_id: input.validation_report.validation_report_id,
      source_digest: input.validation_report.report_digest,
      severity: "critical",
      reason: "the deterministic validation report did not pass",
    });
  }
  for (const risk of proposal.content.risks) {
    const severity: CaptureRiskLevel =
      risk.impact === "critical"
        ? "critical"
        : risk.impact === "high"
          ? "high"
          : risk.impact === "medium"
            ? "medium"
            : risk.impact === "low"
              ? "low"
              : "medium"; // unknown impact cannot be assumed low
    triggers.push({
      trigger_id: `proposal-risk:${risk.id}`,
      source_kind: "proposal",
      source_id: risk.id,
      source_digest: contentDigest(risk),
      severity,
      reason: `proposal risk ${risk.id} (${risk.category}) with impact ${risk.impact}`,
    });
  }
  for (const finding of input.review_report.findings) {
    triggers.push({
      trigger_id: `review-finding:${finding.finding_id}`,
      source_kind: "review",
      source_id: finding.finding_id,
      source_digest: contentDigest(finding),
      severity: REVIEW_SEVERITY_TO_LEVEL[finding.severity],
      reason: `review finding ${finding.finding_id} with severity ${finding.severity}`,
    });
  }

  const level = maxLevel(triggers.map((trigger) => trigger.severity));

  const hasUnknown = proposal.content.risks.some(
    (risk) => risk.likelihood === "unknown" || risk.impact === "unknown",
  );
  const hasWarningFinding = input.review_report.findings.some(
    (finding) => finding.severity !== "info",
  );
  const confidence: CaptureRiskConfidence = hasUnknown
    ? "low"
    : hasWarningFinding
      ? "medium"
      : "high";

  const material =
    proposal.content.risks.some((risk) => SENSITIVE_RISK_CATEGORIES.has(risk.category)) ||
    proposal.content.constraints.some((constraint) =>
      SENSITIVE_CONSTRAINT_CATEGORIES.has(constraint.category),
    );

  const sorted = [...triggers].sort((left, right) =>
    left.trigger_id < right.trigger_id ? -1 : left.trigger_id > right.trigger_id ? 1 : 0,
  );
  return {
    level,
    materiality: material ? "material" : "non_material",
    confidence,
    triggers: sorted,
  };
}

/**
 * The approval routing policy for one capture session: derived by the caller
 * from the ProjectProfile, the CapturePolicyBinding and the Policy. The engine
 * never widens it; `governed` never auto-approves regardless of the flags.
 */
export interface CaptureRiskPolicy {
  readonly project_id: string;
  readonly profile_id: ProfileId;
  readonly allow_policy_auto_approval: boolean;
  /** Versioned Policy identity recorded as the actor of an auto decision. */
  readonly policy_actor: string;
  readonly deny_levels?: readonly CaptureRiskLevel[];
}

export type CaptureApprovalRoute =
  | { readonly kind: "policy_auto" }
  | { readonly kind: "human" }
  | { readonly kind: "denied" }
  | {
      readonly kind: "upgrade_required";
      readonly recommended_profile_id: ProfileId;
      readonly triggers: readonly string[];
    };

/** Map triggered risk sources onto the versioned profile recommendation triggers. */
function profileTriggerIds(input: CaptureRiskInput, level: CaptureRiskLevel): string[] {
  const ids = new Set<string>();
  if (level === "critical") ids.add("critical_risk");
  if (level === "high" || level === "medium") ids.add("medium_high_impact_uncertainty");
  for (const risk of input.proposal.content.risks) {
    if (risk.category === "security" || risk.category === "privacy") {
      ids.add("security_or_supply_chain_surface");
    }
    if (risk.category === "compliance") ids.add("regulatory_or_audit_constraint");
    if (risk.category === "data_integrity" || risk.category === "migration") {
      ids.add("data_schema_or_migration_change");
    }
    if (risk.category === "compatibility") ids.add("public_api_change");
  }
  for (const constraint of input.proposal.content.constraints) {
    if (constraint.category === "security") ids.add("security_or_supply_chain_surface");
    if (constraint.category === "compliance") ids.add("regulatory_or_audit_constraint");
    if (constraint.category === "compatibility") ids.add("public_api_change");
  }
  return [...ids].sort();
}

/**
 * The approval route decision (design 15). Only `low + non_material + high
 * confidence` may route to Policy auto approval, and only when the Policy
 * allows it on a non-Governed profile. Policy deny lists and profile upgrade
 * recommendations always win over auto approval.
 */
export function routeCaptureApproval(
  assessment: Pick<CaptureRiskAssessmentRecord, "level" | "materiality" | "confidence">,
  input: CaptureRiskInput,
  policy: CaptureRiskPolicy,
): CaptureApprovalRoute {
  if (policy.deny_levels?.includes(assessment.level) === true) {
    return { kind: "denied" };
  }
  const upgrade = recommendProfileUpgrade({
    current_profile_id: policy.profile_id,
    triggered: profileTriggerIds(input, assessment.level),
  });
  if (upgrade !== undefined) {
    return {
      kind: "upgrade_required",
      recommended_profile_id: upgrade.recommended_profile_id,
      triggers: canonicalStringSet([...upgrade.triggers]),
    };
  }
  const autoEligible =
    assessment.level === "low" &&
    assessment.materiality === "non_material" &&
    assessment.confidence === "high" &&
    policy.allow_policy_auto_approval &&
    policy.profile_id !== "governed";
  return { kind: autoEligible ? "policy_auto" : "human" };
}
