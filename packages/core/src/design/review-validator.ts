import type {
  DesignReviewDraft,
  DesignReviewSourceRef,
  DesignSetContent,
} from "../schema/index.js";
import { designSetContentDigest } from "./canonical.js";

/**
 * The ReviewResultValidator (designset lifecycle design 6.5 and 10, model
 * advisory design 7): a pure, deterministic re-verification of the
 * independent design review. A model `accept_recommended` never substitutes
 * for human approval; an unresolved Critical finding always blocks the
 * ApprovalRequest; a citation that is not verifiably part of the review
 * bundle or the proposal content never gains authority — no matter how
 * confident the conclusion.
 */
export const DESIGN_REVIEW_VALIDATION_ISSUE_CODES = [
  "citation_outside_bundle",
  "unknown_affected_target",
  "unresolved_critical",
  "verdict_inconsistent",
  "coverage_assessment_gap",
] as const;
export type DesignReviewValidationIssueCode = (typeof DESIGN_REVIEW_VALIDATION_ISSUE_CODES)[number];

export interface DesignReviewValidationIssue {
  readonly code: DesignReviewValidationIssueCode;
  readonly message: string;
  readonly target_id?: string;
}

export interface DesignReviewValidationInput {
  readonly output: DesignReviewDraft;
  /** Sources compiled into the independent review bundle. */
  readonly bundle_sources: readonly { readonly ref: string; readonly digest: string }[];
  readonly proposal_content: DesignSetContent;
  readonly must_change_requirement_ids: readonly string[];
}

function issue(
  code: DesignReviewValidationIssueCode,
  message: string,
  targetId?: string,
): DesignReviewValidationIssue {
  return { code, message, ...(targetId === undefined ? {} : { target_id: targetId }) };
}

function citationValid(
  ref: DesignReviewSourceRef,
  bundleSources: ReadonlyMap<string, string>,
  proposalContentDigest: string,
): boolean {
  if (ref.kind === "bundle_source") {
    return bundleSources.get(ref.ref) === ref.digest;
  }
  if (ref.kind === "proposal_content") {
    return ref.digest === proposalContentDigest;
  }
  return false;
}

export function validateDesignReviewOutput(
  input: DesignReviewValidationInput,
): DesignReviewValidationIssue[] {
  const issues: DesignReviewValidationIssue[] = [];
  const { output } = input;
  const bundleSources = new Map(input.bundle_sources.map((source) => [source.ref, source.digest]));
  const contentDigest = designSetContentDigest(input.proposal_content);

  const assetIds = new Set([
    ...input.proposal_content.node_changes.map((change) => change.node_id),
    ...input.proposal_content.reused_assets.map((asset) => asset.node_id),
  ]);
  const criterionIds = new Set(
    input.proposal_content.coverage.flatMap((entry) =>
      entry.test_strategy_coverage.map((binding) => binding.acceptance_criterion_id),
    ),
  );

  let criticalCount = 0;
  for (const finding of output.findings) {
    if (finding.severity === "critical") criticalCount += 1;
    if (!finding.source_refs.every((ref) => citationValid(ref, bundleSources, contentDigest))) {
      issues.push(
        issue(
          "citation_outside_bundle",
          `finding ${finding.finding_id} cites a source outside the review bundle or proposal`,
          finding.finding_id,
        ),
      );
    }
    const targets = [finding.affected_asset_id, finding.affected_criterion_id].filter(
      (target): target is string => target !== undefined,
    );
    const targetKnown = targets.some((target) => assetIds.has(target) || criterionIds.has(target));
    if (targets.length === 0 || !targetKnown) {
      issues.push(
        issue(
          "unknown_affected_target",
          `finding ${finding.finding_id} affects neither a proposal asset nor a covered criterion`,
          finding.finding_id,
        ),
      );
    }
  }

  if (output.verdict === "accept_recommended" && criticalCount > 0) {
    issues.push(
      issue(
        "unresolved_critical",
        "accept_recommended carries unresolved critical findings; approval must not be requested",
      ),
    );
  }
  if (output.verdict === "blocked" && criticalCount === 0) {
    issues.push(issue("verdict_inconsistent", "blocked requires at least one critical finding"));
  }

  const assessments = new Map<string, number>();
  for (const assessment of output.coverage_assessment) {
    assessments.set(
      assessment.requirement_id,
      (assessments.get(assessment.requirement_id) ?? 0) + 1,
    );
    if (!input.must_change_requirement_ids.includes(assessment.requirement_id)) {
      issues.push(
        issue(
          "unknown_affected_target",
          `coverage assessment ${assessment.requirement_id} is not a must-change requirement`,
          assessment.requirement_id,
        ),
      );
    }
  }
  for (const requirementId of input.must_change_requirement_ids) {
    if (assessments.get(requirementId) !== 1) {
      issues.push(
        issue(
          "coverage_assessment_gap",
          `must-change requirement ${requirementId} has ${assessments.get(requirementId) ?? 0} coverage assessments, expected exactly 1`,
          requirementId,
        ),
      );
    }
  }

  return issues.sort((left, right) => left.code.localeCompare(right.code));
}

/** True when the review may proceed to a human ApprovalRequest. */
export function designReviewPermitsApproval(output: DesignReviewDraft): boolean {
  return output.findings.every((finding) => finding.severity !== "critical");
}
