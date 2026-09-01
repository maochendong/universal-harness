import {
  appendProjectContextBundleRecord,
  createCaptureAcceptanceStageHandler,
  createCaptureProposalStageHandlers,
  createCaptureReviewStageHandlers,
  createCaptureRiskStageHandlers,
  createInMemoryPrdProposalAdapter,
  createInMemoryPrdReviewAdapter,
  createPrdCaptureCoordinator,
  createProjectContextBundleRecord,
  readManagedManifest,
  type CaptureSessionRecord,
  type CaptureStageRequest,
  type PrdProposalDraft,
  type PrdReviewReportDraft,
  type PrdReviewRubric,
} from "@universal-harness-internal/core";

import {
  readBridgedCaptureApprovalDecision,
  type CaptureCoordinatorSeam,
} from "../../src/index.js";
import { FIXED_NOW, headOf } from "../bootstrap/helpers.js";

/**
 * Shared coordinated-capture fixture: a capture seam whose coordinator drives
 * a session from start to the human approval route with the real
 * proposal/review/risk/acceptance stages and in-memory model adapters; the
 * approval decision is consumed through the engine bridge on resume.
 */

export const CAPTURE_POLICY_DIGEST = "9".repeat(64);
const PROPOSAL_ADAPTER_PROFILE_DIGEST = "e".repeat(64);
const PROPOSAL_PROMPT_VERSION_DIGEST = "f".repeat(64);
const REVIEW_ADAPTER_PROFILE_DIGEST = "7".repeat(64);
const REVIEW_PROMPT_VERSION_DIGEST = "8".repeat(64);

const REVIEW_RUBRIC: PrdReviewRubric = {
  rubric_id: "capture-review-rubric",
  dimensions: [
    { dimension_id: "clarity", prompt: "Is every requirement unambiguous?" },
    { dimension_id: "completeness", prompt: "Does the PRD cover the intent?" },
    { dimension_id: "testability", prompt: "Is every criterion observable?" },
  ],
  mandatory_dimension_ids: ["clarity", "completeness", "testability"],
};

/** A draft that passes every hard gate: one must-change requirement, one atomic criterion. */
function validDraft(session: CaptureSessionRecord): PrdProposalDraft {
  const binding = {
    source_kind: "intent" as const,
    source_id: "intent",
    source_digest: session.intent_digest,
  };
  return {
    schema_version: "1.1.0",
    intent: { text: session.intent_text, digest: session.intent_digest },
    problem_statement: "Users cannot archive monthly reports outside the application.",
    goals: [
      {
        draft_key: "goal-1",
        lineage: { kind: "new" },
        proposed_source_bindings: [binding],
        statement: "Users can export the monthly report as a CSV file.",
      },
    ],
    non_goals: [],
    actors: [],
    scenarios: [],
    requirements: [
      {
        draft_key: "req-1",
        lineage: { kind: "new" },
        proposed_source_bindings: [binding],
        statement: "The user can export the monthly report as a CSV file.",
        priority: "must",
        change_kind: "must_change",
        scenario_ids: [],
        acceptance_criterion_ids: ["criterion-1"],
      },
    ],
    constraints: [],
    acceptance_criteria: [
      {
        draft_key: "criterion-1",
        lineage: { kind: "new" },
        proposed_source_bindings: [binding],
        requirement_id: "req-1",
        precondition: "a monthly report exists for the user",
        action: "the user exports the report as CSV",
        observable_outcome: "a CSV file containing the report rows is produced",
        verification_intent: "compare the exported CSV rows with the report data",
        test_first_example:
          "given an existing report, exporting produces a CSV whose rows match the report",
        scenario_kind: "primary",
      },
    ],
    assumptions: [],
    dependencies: [],
    risks: [],
    open_questions: [],
    glossary: [],
    context_source_refs: [],
  };
}

function acceptDraft(): PrdReviewReportDraft {
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

/**
 * A capture seam whose coordinator drives a session from start to the human
 * approval route with the real proposal/review/risk/acceptance stages; the
 * approval decision is consumed through the engine bridge on resume.
 */
export function completingCaptureSeam(projectRoot: string): CaptureCoordinatorSeam {
  const proposalStages = createCaptureProposalStageHandlers({
    projectRoot,
    proposal: createInMemoryPrdProposalAdapter((input) => ({
      status: "proposed" as const,
      draft: validDraft(input.session),
    })),
    adapter_profile: {
      backing: "in_memory",
      adapter_profile_digest: PROPOSAL_ADAPTER_PROFILE_DIGEST,
      prompt_version_digest: PROPOSAL_PROMPT_VERSION_DIGEST,
      producer_identity: "in-memory-proposal",
    },
  });
  const reviewStages = createCaptureReviewStageHandlers({
    projectRoot,
    review: createInMemoryPrdReviewAdapter(() => ({
      status: "completed" as const,
      report: acceptDraft(),
    })),
    rubric: REVIEW_RUBRIC,
    adapter_profile: {
      backing: "in_memory",
      adapter_profile_digest: REVIEW_ADAPTER_PROFILE_DIGEST,
      prompt_version_digest: REVIEW_PROMPT_VERSION_DIGEST,
      reviewer_identity: "in-memory-review",
    },
  });
  const risk = createCaptureRiskStageHandlers({
    projectRoot,
    policy: {
      project_id: `project_${readManagedManifest(projectRoot).name}`,
      profile_id: "standard",
      allow_policy_auto_approval: false,
      policy_actor: "policy:capture-standard@1",
    },
    policy_digest: CAPTURE_POLICY_DIGEST,
  });
  const accept = createCaptureAcceptanceStageHandler({
    projectRoot,
    readBaseline: () => headOf(projectRoot),
    policy_digest: CAPTURE_POLICY_DIGEST,
    now: () => FIXED_NOW,
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
    appendProjectContextBundleRecord(projectRoot, bundle);
    return { kind: "context_compiled" as const, bundle_digest: bundle.content_digest };
  };
  return {
    coordinator: createPrdCaptureCoordinator({
      projectRoot,
      handlers: {
        compileContext,
        propose: proposalStages.propose,
        validate: proposalStages.validate,
        review: reviewStages.review,
        assessRisk: risk.assessRisk,
        accept,
      },
      readApprovalDecision: (requestId, decisionId) =>
        readBridgedCaptureApprovalDecision(projectRoot, requestId, decisionId),
    }),
    session_context: {
      project_profile_digest: "a".repeat(64),
      profile_decision_digest: "b".repeat(64),
      capture_policy_digest: "c".repeat(64),
      project_baseline_digest: "d".repeat(64),
    },
  };
}
