import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../schema/registry.js";
import type { FeedbackAnalysisInput, FeedbackAnalysisOutput } from "../schema/feedback-analysis.js";
import type { ModelPortFailure } from "../schema/model-invocation.js";

/** Core-owned advisory seam; eval remains a compatibility re-export only. */
export const HUMAN_REVIEW_CONFIDENCE_THRESHOLD = 0.7 as const;

export function shouldInvokeFeedbackAnalysis(
  deterministicRca: { readonly rule: string },
  options?: { readonly policy_requires_semantic_explanation?: boolean },
): boolean {
  return (
    deterministicRca.rule === "unclassified" ||
    options?.policy_requires_semantic_explanation === true
  );
}

export type FeedbackAnalysisResult =
  | { readonly status: "completed"; readonly output: FeedbackAnalysisOutput }
  | { readonly status: "failed"; readonly failure: ModelPortFailure };

export interface FeedbackAnalysisPort {
  readonly name: string;
  analyze(input: FeedbackAnalysisInput): Promise<FeedbackAnalysisResult>;
}

export const FEEDBACK_ANALYSIS_ISSUE_CODES = [
  "stale_finding",
  "citation_invalid",
  "rca_overwrite",
] as const;
export type FeedbackAnalysisIssueCode = (typeof FEEDBACK_ANALYSIS_ISSUE_CODES)[number];

export interface FeedbackAnalysisIssue {
  readonly code: FeedbackAnalysisIssueCode;
  readonly message: string;
}

export function validateFeedbackAnalysisOutput(input: {
  readonly output: FeedbackAnalysisOutput;
  readonly finding_digest: string;
  readonly fact_digests: Readonly<Record<string, string>>;
}): FeedbackAnalysisIssue[] {
  const issues: FeedbackAnalysisIssue[] = [];
  const { output } = input;
  if (output.finding_digest !== input.finding_digest) {
    issues.push({
      code: "stale_finding",
      message: `analysis binds finding ${output.finding_digest}, expected ${input.finding_digest}`,
    });
  }
  const claims = [
    ...output.diagnoses,
    ...output.change_seed_candidates,
    ...output.verification_suggestions,
  ];
  for (const claim of claims) {
    for (const ref of claim.source_refs) {
      if (input.fact_digests[ref.ref] !== ref.digest) {
        issues.push({
          code: "citation_invalid",
          message: `citation ${ref.ref} does not match a verifiable fact digest`,
        });
        break;
      }
    }
  }
  return issues.sort((left, right) => left.code.localeCompare(right.code));
}

export function candidateDisposition(candidate: {
  readonly confidence: number;
  readonly risk: "low" | "medium" | "high";
}): "router_consumable" | "requires_human_review" {
  return candidate.confidence >= HUMAN_REVIEW_CONFIDENCE_THRESHOLD && candidate.risk !== "high"
    ? "router_consumable"
    : "requires_human_review";
}

function invalidOutput(summary: string): ModelPortFailure {
  return { code: "invalid_output", summary, retryable: false };
}

export function createInMemoryFeedbackAnalysisPort(
  script: (input: FeedbackAnalysisInput) => unknown,
): FeedbackAnalysisPort {
  return {
    name: "in-memory-feedback-analysis",
    async analyze(input) {
      const payload = script(input);
      const wrapped =
        typeof payload === "object" && payload !== null && !Array.isArray(payload)
          ? {
              purpose: "feedback_analysis",
              schema_version: "feedback_analysis.v1",
              finding_digest: input.finding_digest,
              ...payload,
            }
          : payload;
      const shape = PROTOCOL_1_1_SCHEMA_REGISTRY.validate("feedback-analysis-output", wrapped);
      if (!shape.valid) {
        return {
          status: "failed",
          failure: invalidOutput(
            `feedback analysis output failed schema validation: ${shape.errors[0]?.message ?? "unknown"}`,
          ),
        };
      }
      const issues = validateFeedbackAnalysisOutput({
        output: wrapped as FeedbackAnalysisOutput,
        finding_digest: input.finding_digest,
        fact_digests: Object.fromEntries(
          input.bundle.sources.map((source) => [source.locator, source.source_digest]),
        ),
      });
      if (issues.length > 0) {
        return {
          status: "failed",
          failure: invalidOutput(
            `feedback analysis failed result validation: ${issues
              .map((entry) => entry.code)
              .join(", ")}`,
          ),
        };
      }
      return { status: "completed", output: wrapped as FeedbackAnalysisOutput };
    },
  };
}
