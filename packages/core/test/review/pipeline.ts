import type { CaptureStageHandlers, CaptureStageRequest } from "../../src/capture/commands.js";
import { createProjectContextBundleRecord } from "../../src/context/records.js";
import { appendProjectContextBundleRecord } from "../../src/context/store.js";
import { contentDigest } from "../../src/identity/digest.js";
import { createInMemoryPrdProposalAdapter } from "../../src/proposal/in-memory.js";
import { createCaptureProposalStageHandlers } from "../../src/proposal/stages.js";
import type { CaptureSessionRecord } from "../../src/schema/capture.js";
import type { PrdProposalDraft } from "../../src/schema/proposal.js";
import type { PrdReviewReportDraft } from "../../src/schema/review.js";
import { createInMemoryPrdReviewAdapter } from "../../src/review/in-memory.js";
import type { PrdReviewRubric } from "../../src/review/records.js";
import { createCaptureReviewStageHandlers } from "../../src/review/stages.js";
import { ADAPTER_PROFILE_DIGEST, PROMPT_VERSION_DIGEST } from "../proposal/helpers.js";

/**
 * Shared T7 pipeline fixtures: the real proposal/review stage handlers wired
 * with in-memory adapters, plus the rubric every review test runs against.
 */
export const REVIEW_ADAPTER_PROFILE_DIGEST = "7".repeat(64);
export const REVIEW_PROMPT_VERSION_DIGEST = "8".repeat(64);

export const REVIEW_RUBRIC: PrdReviewRubric = {
  rubric_id: "capture-review-rubric",
  dimensions: [
    { dimension_id: "clarity", prompt: "Is every requirement unambiguous?" },
    { dimension_id: "completeness", prompt: "Does the PRD cover the intent?" },
    { dimension_id: "testability", prompt: "Is every criterion observable?" },
  ],
  mandatory_dimension_ids: ["clarity", "completeness", "testability"],
};

export function makeAcceptDraft(): PrdReviewReportDraft {
  return {
    verdict: "accept",
    dimensions: REVIEW_RUBRIC.dimensions.map((dimension) => ({
      dimension_id: dimension.dimension_id,
      status: "satisfied" as const,
      notes: "ok",
    })),
    findings: [],
    suggested_questions: [],
  };
}

/** A review-purpose context bundle for direct record tests. */
export function makeReviewBundle(session: CaptureSessionRecord) {
  return createProjectContextBundleRecord({
    session_id: session.session_id,
    purpose: "review",
    project_baseline_digest: session.project_baseline_digest,
    profile_digest: session.project_profile_digest,
    policy_digest: session.capture_policy_digest,
    budget: {
      max_files: 10,
      max_bytes_per_source: 4096,
      max_total_bytes: 16384,
      max_summary_chars: 500,
    },
    sources: [],
    exclusions: [],
  });
}

/** Full coordinator wiring with the real proposal/review stages. */
export function makeReviewPipelineHandlers(
  root: string,
  options: {
    readonly proposalDrafts: readonly ((session: CaptureSessionRecord) => PrdProposalDraft)[];
    readonly reviewResults?: readonly PrdReviewReportDraft[];
    readonly reviewAdapter?: ReturnType<typeof createInMemoryPrdReviewAdapter>;
  },
): {
  handlers: CaptureStageHandlers;
  proposalAdapter: ReturnType<typeof createInMemoryPrdProposalAdapter>;
  reviewAdapter: ReturnType<typeof createInMemoryPrdReviewAdapter>;
} {
  let proposalCall = 0;
  const proposalAdapter = createInMemoryPrdProposalAdapter((input) => {
    const build =
      options.proposalDrafts[Math.min(proposalCall, options.proposalDrafts.length - 1)]!;
    proposalCall += 1;
    return { status: "proposed", draft: build(input.session) };
  });
  let reviewCall = 0;
  const reviewAdapter =
    options.reviewAdapter ??
    createInMemoryPrdReviewAdapter(() => {
      const draft =
        options.reviewResults === undefined
          ? makeAcceptDraft()
          : options.reviewResults[Math.min(reviewCall, options.reviewResults.length - 1)]!;
      reviewCall += 1;
      return { status: "completed", report: draft };
    });
  const proposalStages = createCaptureProposalStageHandlers({
    projectRoot: root,
    proposal: proposalAdapter,
    adapter_profile: {
      backing: "in_memory",
      adapter_profile_digest: ADAPTER_PROFILE_DIGEST,
      prompt_version_digest: PROMPT_VERSION_DIGEST,
      producer_identity: "in-memory-proposal",
    },
  });
  const reviewStages = createCaptureReviewStageHandlers({
    projectRoot: root,
    review: reviewAdapter,
    rubric: REVIEW_RUBRIC,
    adapter_profile: {
      backing: "in_memory",
      adapter_profile_digest: REVIEW_ADAPTER_PROFILE_DIGEST,
      prompt_version_digest: REVIEW_PROMPT_VERSION_DIGEST,
      reviewer_identity: "in-memory-review",
    },
  });
  const compileContext = (request: CaptureStageRequest) => {
    const purpose = request.invocation?.purpose === "context_review" ? "review" : "proposal";
    const bundle = createProjectContextBundleRecord({
      session_id: request.session.session_id,
      purpose,
      project_baseline_digest: request.session.project_baseline_digest,
      profile_digest: request.session.project_profile_digest,
      policy_digest: request.session.capture_policy_digest,
      budget: {
        max_files: 10,
        max_bytes_per_source: 4096,
        max_total_bytes: 16384,
        max_summary_chars: 500,
      },
      sources: [],
      exclusions: [],
    });
    appendProjectContextBundleRecord(root, bundle);
    return { kind: "context_compiled" as const, bundle_digest: bundle.content_digest };
  };
  return {
    proposalAdapter,
    reviewAdapter,
    handlers: {
      compileContext,
      propose: proposalStages.propose,
      validate: proposalStages.validate,
      review: reviewStages.review,
      assessRisk: () => ({ kind: "risk_stable", risk_assessment_digest: contentDigest("risk") }),
    },
  };
}

export function startCommandFor(session: CaptureSessionRecord) {
  return {
    command: "start_capture" as const,
    workflow_operation_id: session.workflow_operation_id,
    iteration_id: session.iteration_id,
    intent_text: session.intent_text,
    project_profile_digest: session.project_profile_digest,
    profile_decision_digest: session.profile_decision_digest,
    capture_policy_digest: session.capture_policy_digest,
    project_baseline_digest: session.project_baseline_digest,
  };
}
