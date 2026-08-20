import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPrdCaptureCoordinator } from "../../src/capture/coordinator.js";
import { readCaptureAnswers, readCaptureInvocations } from "../../src/capture/store.js";
import {
  createPrdProposalRecord,
  createPrdValidationReportRecord,
} from "../../src/proposal/records.js";
import { runPrdHardGates } from "../../src/proposal/gates.js";
import { readPrdProposalRevisions } from "../../src/proposal/store.js";
import type { CaptureSessionRecord } from "../../src/schema/capture.js";
import type { PrdProposalDraft, PrdProposalRecord } from "../../src/schema/proposal.js";
import type { PrdReviewReportDraft } from "../../src/schema/review.js";
import { createInMemoryPrdReviewAdapter } from "../../src/review/in-memory.js";
import { createManualPrdReviewAdapter } from "../../src/review/manual.js";
import {
  ReviewRecordError,
  createPrdReviewReportRecord,
  prdReviewRubricDigest,
} from "../../src/review/records.js";
import { readPrdReviewReports } from "../../src/review/store.js";
import {
  ADAPTER_PROFILE_DIGEST,
  PROMPT_VERSION_DIGEST,
  makeBundle,
  makeSession,
  makeValidDraft,
} from "../proposal/helpers.js";
import {
  REVIEW_ADAPTER_PROFILE_DIGEST,
  REVIEW_PROMPT_VERSION_DIGEST,
  REVIEW_RUBRIC,
  makeAcceptDraft,
  makeReviewBundle,
  makeReviewPipelineHandlers,
  startCommandFor,
} from "./pipeline.js";

const createdRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-review-"));
  createdRoots.push(root);
  return root;
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

/** Build a committed proposal + passed validation for direct record tests. */
function makeProposalAndValidation(session: CaptureSessionRecord): {
  proposal: PrdProposalRecord;
  validation: ReturnType<typeof createPrdValidationReportRecord>;
} {
  const bundle = makeBundle(session);
  const { record: proposal } = createPrdProposalRecord({
    session,
    revision: 1,
    draft: makeValidDraft(session),
    proposal_context_bundle: bundle,
    answers: [],
    adapter_profile_digest: ADAPTER_PROFILE_DIGEST,
    prompt_version_digest: PROMPT_VERSION_DIGEST,
    producer_identity: "test-producer",
    invocation_id: "capture-invocation_01K1PROPOSAL00000000",
    conversation_id: "capture-conversation_01K1PROPOSAL00000",
    evidence_locator: "capture-evidence://proposal",
  });
  const outcome = runPrdHardGates(proposal.content);
  const validation = createPrdValidationReportRecord({
    session_id: session.session_id,
    proposal_digest: proposal.content_digest,
    results: outcome.results,
    blocking_question_ids: [],
  });
  return { proposal, validation };
}

function makeReportInput(session: CaptureSessionRecord) {
  const { proposal, validation } = makeProposalAndValidation(session);
  return {
    session,
    proposal,
    review_context_bundle: makeReviewBundle(session),
    validation_report: validation,
    draft: makeAcceptDraft(),
    rubric: REVIEW_RUBRIC,
    reviewer_adapter_profile_digest: REVIEW_ADAPTER_PROFILE_DIGEST,
    prompt_version_digest: REVIEW_PROMPT_VERSION_DIGEST,
    reviewer_identity: "reviewer:in-memory",
    invocation_id: "capture-invocation_01K1REVIEW0000000000",
    conversation_id: "capture-conversation_01K1REVIEW0000000",
    evidence_locator: "capture-evidence://review",
  };
}

describe("createPrdReviewReportRecord", () => {
  it("seals a deterministic report bound to the reviewed facts", () => {
    const session = makeSession();
    const input = makeReportInput(session);
    const first = createPrdReviewReportRecord(input);
    const second = createPrdReviewReportRecord(makeReportInput(session));
    expect(first.report_digest).toBe(second.report_digest);
    expect(first.review_report_id).toBe(second.review_report_id);
    expect(first.proposal_digest).toBe(input.proposal.content_digest);
  });

  it("rejects any independence violation against the proposal invocation", () => {
    const session = makeSession();
    const input = makeReportInput(session);
    const proposalBinding = input.proposal.input_binding;
    for (const patch of [
      { invocation_id: proposalBinding.invocation_id },
      { conversation_id: proposalBinding.conversation_id },
      { reviewer_adapter_profile_digest: proposalBinding.adapter_profile_digest },
      { prompt_version_digest: proposalBinding.prompt_version_digest },
    ]) {
      try {
        createPrdReviewReportRecord({ ...input, ...patch });
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ReviewRecordError);
        expect((error as ReviewRecordError).kind).toBe("independence_violation");
      }
    }
  });

  it("rejects an accept verdict with an unresolved critical finding", () => {
    const session = makeSession();
    const input = makeReportInput(session);
    const draft: PrdReviewReportDraft = {
      ...makeAcceptDraft(),
      findings: [
        {
          finding_id: "finding-1",
          severity: "critical",
          target_kind: "requirement",
          target_id: input.proposal.content.requirements[0]!.id,
          message: "the requirement cannot be verified as stated",
        },
      ],
    };
    expect(() => createPrdReviewReportRecord({ ...input, draft })).toThrow(/critical/iu);
  });

  it("rejects a clarify verdict without questions and findings targeting foreign entities", () => {
    const session = makeSession();
    const input = makeReportInput(session);
    expect(() =>
      createPrdReviewReportRecord({
        ...input,
        draft: { ...makeAcceptDraft(), verdict: "clarify" },
      }),
    ).toThrow(/clarify/iu);
    expect(() =>
      createPrdReviewReportRecord({
        ...input,
        draft: {
          ...makeAcceptDraft(),
          verdict: "revise",
          findings: [
            {
              finding_id: "finding-x",
              severity: "warning",
              target_kind: "requirement",
              target_id: "prd-requirement_doesnotexist",
              message: "foreign target",
            },
          ],
        },
      }),
    ).toThrow(/not part of the reviewed proposal/iu);
  });

  it("requires every mandatory rubric dimension", () => {
    const session = makeSession();
    const input = makeReportInput(session);
    const draft: PrdReviewReportDraft = {
      ...makeAcceptDraft(),
      dimensions: makeAcceptDraft().dimensions.filter(
        (dimension) => dimension.dimension_id !== "testability",
      ),
    };
    expect(() => createPrdReviewReportRecord({ ...input, draft })).toThrow(/mandatory/iu);
  });
});

describe("PrdReviewPort adapters", () => {
  it("manual adapter asks for rubric input, then folds it into a deterministic draft", async () => {
    const session = makeSession();
    const adapter = createManualPrdReviewAdapter();
    const { proposal, validation } = makeProposalAndValidation(session);
    const base = {
      session,
      proposal,
      review_context_bundle: makeReviewBundle(session),
      validation_report: validation,
      rubric: REVIEW_RUBRIC,
      profile: {
        backing: "manual",
        adapter_profile_digest: REVIEW_ADAPTER_PROFILE_DIGEST,
        prompt_version_digest: REVIEW_PROMPT_VERSION_DIGEST,
        reviewer_identity: "human:reviewer",
      },
      invocation: {
        invocation_id: "capture-invocation_01K1REVIEW0000000000",
        conversation_id: "capture-conversation_01K1REVIEW0000000",
        evidence_locator: "capture-evidence://review",
      },
    };
    const needsInput = await adapter.review(base);
    expect(needsInput.status).toBe("input_required");
    if (needsInput.status !== "input_required") throw new Error("expected input request");
    expect(needsInput.questions.map((question) => question.dimension_id).sort()).toEqual(
      ["clarity", "completeness", "testability"].sort(),
    );

    const manualInput = {
      protocol_version: "1.1.0",
      record_kind: "manual_review_input",
      manual_review_input_id: "manual-review-input_test",
      session_id: session.session_id,
      review_invocation_id: base.invocation.invocation_id,
      reviewer_actor: "human:reviewer",
      rubric_digest: prdReviewRubricDigest(REVIEW_RUBRIC),
      dimension_inputs: [
        { dimension_id: "clarity", status: "satisfied", notes: "clear" },
        { dimension_id: "completeness", status: "deficient", notes: "missing failure scenario" },
        { dimension_id: "testability", status: "satisfied", notes: "observable" },
      ],
      expected_session_digest: session.record_digest,
      record_digest: "0".repeat(64),
    } as const;
    const completed = await adapter.review({ ...base, manual_input: manualInput as never });
    expect(completed.status).toBe("completed");
    if (completed.status !== "completed") throw new Error("expected a report");
    expect(completed.report.verdict).toBe("revise");
    expect(completed.report.findings).toHaveLength(1);
    expect(completed.report.findings[0]?.finding_id).toBe("manual-completeness");
  });
});

describe("capture review stage wiring", () => {
  it("hard gate failures never call the reviewer", async () => {
    const root = makeRoot();
    const session = makeSession();
    const missingTestFirst = (live: CaptureSessionRecord): PrdProposalDraft => {
      const draft = makeValidDraft(live);
      return {
        ...draft,
        acceptance_criteria: draft.acceptance_criteria.map((criterion) => {
          const copy = { ...criterion };
          Reflect.deleteProperty(copy, "test_first_example");
          return copy;
        }),
      };
    };
    const { handlers, reviewAdapter } = makeReviewPipelineHandlers(root, {
      proposalDrafts: [missingTestFirst],
    });
    const coordinator = createPrdCaptureCoordinator({ projectRoot: root, handlers });
    const outcome = await coordinator.advance(startCommandFor(session));
    expect(outcome.status).toBe("awaiting_answers");
    expect(reviewAdapter.invocations).toEqual([]);
    expect(readPrdReviewReports(root, session.session_id)).toEqual([]);
  });

  it("keeps proposal and review invocation, conversation, prompt, bundle and evidence independent", async () => {
    const root = makeRoot();
    const session = makeSession();
    const { handlers, reviewAdapter } = makeReviewPipelineHandlers(root, {
      proposalDrafts: [makeValidDraft],
    });
    const coordinator = createPrdCaptureCoordinator({ projectRoot: root, handlers });
    const outcome = await coordinator.advance(startCommandFor(session));
    expect(outcome.status).toBe("awaiting_approval");
    expect(reviewAdapter.invocations).toHaveLength(1);

    const proposal = readPrdProposalRevisions(root, session.session_id).at(-1);
    const review = readPrdReviewReports(root, session.session_id).at(-1);
    expect(proposal).toBeDefined();
    expect(review).toBeDefined();
    if (proposal === undefined || review === undefined) throw new Error("expected records");
    const binding = proposal.input_binding;
    expect(review.invocation_id).not.toBe(binding.invocation_id);
    expect(review.conversation_id).not.toBe(binding.conversation_id);
    expect(review.prompt_version_digest).not.toBe(binding.prompt_version_digest);
    expect(review.reviewer_adapter_profile_digest).not.toBe(binding.adapter_profile_digest);
    expect(review.review_context_bundle_digest).not.toBe(binding.proposal_context_bundle_digest);
    expect(review.evidence_locator).not.toBe(binding.evidence_locator);
    expect(review.proposal_digest).toBe(proposal.content_digest);
  });

  it("routes revise back through a fresh proposal and keeps the old report", async () => {
    const root = makeRoot();
    const session = makeSession();
    const reviseDraft: PrdReviewReportDraft = {
      ...makeAcceptDraft(),
      verdict: "revise",
      findings: [
        {
          finding_id: "finding-ambiguity",
          severity: "warning",
          target_kind: "prd_section",
          message: "the export scope is ambiguous",
        },
      ],
    };
    const { handlers, proposalAdapter } = makeReviewPipelineHandlers(root, {
      proposalDrafts: [makeValidDraft, makeValidDraft],
      reviewResults: [reviseDraft, makeAcceptDraft()],
    });
    const coordinator = createPrdCaptureCoordinator({ projectRoot: root, handlers });
    const outcome = await coordinator.advance(startCommandFor(session));
    expect(outcome.status).toBe("awaiting_approval");
    expect(proposalAdapter.invocations).toHaveLength(2);
    const reports = readPrdReviewReports(root, session.session_id);
    expect(reports.map((report) => report.verdict).sort()).toEqual(["accept", "revise"]);
  });

  it("routes clarify to typed review questions", async () => {
    const root = makeRoot();
    const session = makeSession();
    const clarifyDraft: PrdReviewReportDraft = {
      verdict: "clarify",
      dimensions: makeAcceptDraft().dimensions,
      findings: [],
      suggested_questions: [
        {
          target_kind: "acceptance_criterion",
          missing_dimension: "observable_outcome",
          question: "导出失败时用户看到什么？",
          required: true,
        },
      ],
    };
    const { handlers } = makeReviewPipelineHandlers(root, {
      proposalDrafts: [makeValidDraft],
      reviewResults: [clarifyDraft],
    });
    const coordinator = createPrdCaptureCoordinator({ projectRoot: root, handlers });
    const outcome = await coordinator.advance(startCommandFor(session));
    expect(outcome.status).toBe("awaiting_answers");
    if (outcome.status !== "awaiting_answers") throw new Error("expected questions");
    expect(outcome.questions.some((question) => question.source === "review")).toBe(true);
  });

  it("blocks with review_blocked on a blocked verdict", async () => {
    const root = makeRoot();
    const session = makeSession();
    const blockedDraft: PrdReviewReportDraft = { ...makeAcceptDraft(), verdict: "blocked" };
    const { handlers } = makeReviewPipelineHandlers(root, {
      proposalDrafts: [makeValidDraft],
      reviewResults: [blockedDraft],
    });
    const coordinator = createPrdCaptureCoordinator({ projectRoot: root, handlers });
    const outcome = await coordinator.advance(startCommandFor(session));
    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") throw new Error("expected blocked");
    expect(outcome.blocker.reason).toBe("review_blocked");
  });

  it("blocks with review_provider_required when no review provider exists, then resumes", async () => {
    const root = makeRoot();
    const session = makeSession();
    const { handlers } = makeReviewPipelineHandlers(root, { proposalDrafts: [makeValidDraft] });
    const withoutReview = { ...handlers };
    delete (withoutReview as { review?: unknown }).review;
    const first = createPrdCaptureCoordinator({ projectRoot: root, handlers: withoutReview });
    const outcome = await first.advance(startCommandFor(session));
    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") throw new Error("expected blocked");
    expect(outcome.blocker.reason).toBe("review_provider_required");

    const second = createPrdCaptureCoordinator({ projectRoot: root, handlers });
    const resumed = await second.advance({
      command: "resume_capture",
      session_id: session.session_id,
    });
    expect(resumed.status).toBe("awaiting_approval");
    expect(readPrdReviewReports(root, session.session_id)).toHaveLength(1);
  });

  it("serves manual review input through the typed command without touching clarification answers", async () => {
    const root = makeRoot();
    const session = makeSession();
    const manual = createManualPrdReviewAdapter();
    const { handlers } = makeReviewPipelineHandlers(root, {
      proposalDrafts: [makeValidDraft],
      reviewAdapter: createInMemoryPrdReviewAdapter((input) => manual.review(input)),
    });
    const coordinator = createPrdCaptureCoordinator({ projectRoot: root, handlers });
    const waiting = await coordinator.advance(startCommandFor(session));
    expect(waiting.status).toBe("review_input_required");
    if (waiting.status !== "review_input_required") throw new Error("expected review input wait");

    const reviewInvocation = readCaptureInvocations(root, session.session_id)
      .filter((invocation) => invocation.purpose === "review")
      .at(-1);
    expect(reviewInvocation).toBeDefined();
    if (reviewInvocation === undefined) throw new Error("expected a review invocation");

    const submitted = await coordinator.advance({
      command: "submit_manual_review_input",
      session_id: session.session_id,
      expected_session_digest: waiting.session.record_digest,
      review_invocation_id: reviewInvocation.invocation_id,
      reviewer_actor: "human:reviewer",
      rubric_digest: prdReviewRubricDigest(REVIEW_RUBRIC),
      dimension_inputs: REVIEW_RUBRIC.dimensions.map((dimension) => ({
        dimension_id: dimension.dimension_id,
        status: "satisfied" as const,
        notes: "reviewed",
      })),
    });
    expect(submitted.status).toBe("awaiting_approval");
    // The manual rubric input never leaks into clarification answers.
    expect(readCaptureAnswers(root, session.session_id)).toEqual([]);
    const reports = readPrdReviewReports(root, session.session_id);
    expect(reports.at(-1)?.verdict).toBe("accept");
  });

  it("rejects a manual review input bound to a foreign invocation", async () => {
    const root = makeRoot();
    const session = makeSession();
    const manual = createManualPrdReviewAdapter();
    const { handlers } = makeReviewPipelineHandlers(root, {
      proposalDrafts: [makeValidDraft],
      reviewAdapter: createInMemoryPrdReviewAdapter((input) => manual.review(input)),
    });
    const coordinator = createPrdCaptureCoordinator({ projectRoot: root, handlers });
    const waiting = await coordinator.advance(startCommandFor(session));
    if (waiting.status !== "review_input_required") throw new Error("expected review input wait");
    const rejected = await coordinator.advance({
      command: "submit_manual_review_input",
      session_id: session.session_id,
      expected_session_digest: waiting.session.record_digest,
      review_invocation_id: "capture-invocation_foreign",
      reviewer_actor: "human:reviewer",
      rubric_digest: prdReviewRubricDigest(REVIEW_RUBRIC),
      dimension_inputs: [{ dimension_id: "clarity", status: "satisfied", notes: "ok" }],
    });
    expect(rejected.status).toBe("failed");
    if (rejected.status !== "failed") throw new Error("expected failure");
    expect(rejected.kind).toBe("invalid_command");
  });
});
