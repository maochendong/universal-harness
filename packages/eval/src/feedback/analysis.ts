import {
  PROTOCOL_1_1_SCHEMA_REGISTRY,
  type FeedbackAnalysisInput,
  type FeedbackAnalysisOutput,
  type ModelPortFailure,
} from "@universal-harness-internal/core";

/**
 * The FeedbackAnalysisPort seam (model advisory design 9, PG-7, plan T17).
 * The model is consulted only when the deterministic RCA is unclassified,
 * signals conflict, or policy requires a cited semantic explanation; a
 * deterministic RCA hit is never overwritten and never re-analyzed. The
 * output carries candidates with confidence and citations only — target
 * layers, capability/profile upgrades, invalidation scope and privileged
 * routes have no fields here, so the model cannot decide them. Low
 * confidence or high risk candidates require human review before the
 * feedback router may consume them.
 */
export const HUMAN_REVIEW_CONFIDENCE_THRESHOLD = 0.7 as const;

/** Call the model only for unclassified/conflicting/policy-required cases. */
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

/**
 * Deterministic result validation: the output must bind the current finding
 * and cite only verifiable sources. It never judges whether a diagnosis is
 * semantically right — the router and human review own that.
 */
export function validateFeedbackAnalysisOutput(input: {
  readonly output: FeedbackAnalysisOutput;
  readonly finding_digest: string;
  /** Verifiable fact digest by ref (finding/evidence/graph node/bundle source). */
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

/**
 * Router-consumable or not (model advisory 9): low-confidence or high-risk
 * candidates require human review before the feedback router may consume
 * them. Deterministic RCA outputs never pass through here at all.
 */
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

/** The in-memory reference adapter: a script supplies the raw payload. */
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
