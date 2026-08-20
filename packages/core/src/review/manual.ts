import type { PrdReviewReportDraft } from "../schema/review.js";
import type { PrdReviewPort } from "./port.js";
import { prdReviewRubricDigest } from "./records.js";

/**
 * ManualPrdReviewAdapter (intent-to-prd design 10.3): the human review path.
 * Without a committed ManualReviewInputRecord it returns `input_required`
 * listing the rubric dimensions to assess; with one it folds the human rubric
 * input into a deterministic report draft — all dimensions satisfied means
 * `accept`, any deficiency means `revise` with one finding per deficient
 * dimension. The adapter never invents a verdict the human did not express.
 */
export function createManualPrdReviewAdapter(): PrdReviewPort {
  return {
    name: "manual",
    review(input) {
      const manualInput = input.manual_input;
      if (manualInput === undefined) {
        return {
          status: "input_required",
          questions: input.rubric.dimensions.map((dimension) => ({
            dimension_id: dimension.dimension_id,
            prompt: dimension.prompt,
          })),
        };
      }
      if (manualInput.rubric_digest !== prdReviewRubricDigest(input.rubric)) {
        return {
          status: "failed",
          failure: {
            code: "version_mismatch",
            retryable: false,
            summary: "the manual review input was recorded against a different rubric",
          },
        };
      }
      const dimensions = input.rubric.dimensions.map((dimension) => {
        const given = manualInput.dimension_inputs.find(
          (candidate) => candidate.dimension_id === dimension.dimension_id,
        );
        return {
          dimension_id: dimension.dimension_id,
          status: given?.status ?? ("deficient" as const),
          notes: given?.notes ?? "not assessed",
        };
      });
      const findings = dimensions
        .filter((dimension) => dimension.status === "deficient")
        .map((dimension) => {
          const given = manualInput.dimension_inputs.find(
            (candidate) => candidate.dimension_id === dimension.dimension_id,
          );
          return {
            finding_id: `manual-${dimension.dimension_id}`,
            severity: given?.severity ?? ("warning" as const),
            target_kind: "prd_section" as const,
            message:
              dimension.notes.trim().length > 0
                ? dimension.notes
                : `dimension ${dimension.dimension_id} is deficient`,
          };
        });
      const draft: PrdReviewReportDraft = {
        verdict: findings.length === 0 ? "accept" : "revise",
        dimensions,
        findings,
        suggested_questions: [],
      };
      return { status: "completed", report: draft };
    },
  };
}
