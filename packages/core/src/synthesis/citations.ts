import type { ProjectContextBundleRecord } from "../schema/context.js";
import type { GroundedSynthesisOutput, GroundedSourceRef } from "../schema/synthesis.js";

/**
 * Deterministic citation validator (model advisory design 10): it proves
 * that every business claim cites at least one source in the current bundle
 * and that each cited locator/digest matches what the model actually saw. It
 * deliberately says nothing about whether the claim's interpretation is
 * semantically right — domain validators, review and human approval own that.
 */
export interface CitationIssue {
  readonly code: "citation_missing" | "citation_invalid";
  readonly claim_path: string;
  readonly message: string;
}

interface ClaimLike {
  readonly source_refs?: readonly GroundedSourceRef[];
}

function claimArrays(
  output: GroundedSynthesisOutput,
): ReadonlyArray<[string, readonly ClaimLike[]]> {
  switch (output.purpose) {
    case "project_discovery":
      return [
        ["facts", output.facts],
        ["capability_candidates", output.capability_candidates],
        ["gate_candidates", output.gate_candidates],
      ];
    case "context_enrichment":
      return [
        ["terms", output.terms],
        ["segment_summaries", output.segment_summaries],
        ["relevance_explanations", output.relevance_explanations],
      ];
    case "approval_brief":
      return [
        ["changes", output.changes],
        ["risks", output.risks],
        ["tradeoffs", output.tradeoffs],
        ["open_questions", output.open_questions],
      ];
    case "iteration_narrative":
      return [
        ["outcomes", output.outcomes],
        ["residual_risks", output.residual_risks],
        ["follow_ups", output.follow_ups],
      ];
  }
}

export function validateGroundedCitations(
  output: GroundedSynthesisOutput,
  bundle: ProjectContextBundleRecord,
): CitationIssue[] {
  const issues: CitationIssue[] = [];
  if (output.bundle_digest !== bundle.record_digest) {
    issues.push({
      code: "citation_invalid",
      claim_path: "/bundle_digest",
      message: "output is bound to a different bundle than the one being validated",
    });
    return issues;
  }
  const sourcesByLocator = new Map(bundle.sources.map((source) => [source.locator, source]));
  for (const [name, claims] of claimArrays(output)) {
    claims.forEach((claim, index) => {
      const claimPath = `/${name}/${String(index)}`;
      const refs = claim.source_refs ?? [];
      if (refs.length === 0) {
        issues.push({
          code: "citation_missing",
          claim_path: claimPath,
          message: "every business claim must cite at least one bundle source",
        });
        return;
      }
      for (const ref of refs) {
        const source = sourcesByLocator.get(ref.locator);
        if (source === undefined) {
          issues.push({
            code: "citation_invalid",
            claim_path: claimPath,
            message: `cited locator is not part of the current bundle: ${ref.locator}`,
          });
        } else if (source.source_digest !== ref.source_digest) {
          issues.push({
            code: "citation_invalid",
            claim_path: claimPath,
            message: `cited source digest does not match the bundle source: ${ref.locator}`,
          });
        }
      }
    });
  }
  return issues;
}
