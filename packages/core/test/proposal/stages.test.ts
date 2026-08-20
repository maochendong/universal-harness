import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CaptureStageHandlers } from "../../src/capture/commands.js";
import { createPrdCaptureCoordinator } from "../../src/capture/coordinator.js";
import { createCaptureSessionRecord } from "../../src/capture/records.js";
import {
  appendProjectContextBundleRecord,
  readProjectContextBundles,
} from "../../src/context/store.js";
import { createProjectContextBundleRecord } from "../../src/context/records.js";
import { contentDigest } from "../../src/identity/digest.js";
import { createInMemoryPrdProposalAdapter } from "../../src/proposal/in-memory.js";
import { createLegacyIntentInterpreterAdapter } from "../../src/proposal/legacy.js";
import { createCaptureProposalStageHandlers } from "../../src/proposal/stages.js";
import {
  readPrdProposalRevisions,
  readPrdValidationReports,
  readPrdEntityLineageRecords,
} from "../../src/proposal/store.js";
import type { CaptureSessionRecord } from "../../src/schema/capture.js";
import type { PrdProposalDraft } from "../../src/schema/proposal.js";
import { ADAPTER_PROFILE_DIGEST, PROMPT_VERSION_DIGEST, makeValidDraft } from "./helpers.js";

const createdRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-proposal-stages-"));
  createdRoots.push(root);
  return root;
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function makeSessionIn(root: string, intentText?: string) {
  const session = createCaptureSessionRecord({
    workflow_operation_id: "operation_01K1ABCDEFGHIJKLMNO",
    iteration_id: "iteration_01K1ABCDEFGHIJKLMNO",
    intent_text: intentText ?? "Let users export the monthly report as a CSV file.",
    project_profile_digest: "a".repeat(64),
    profile_decision_digest: "b".repeat(64),
    capture_policy_digest: "c".repeat(64),
    project_baseline_digest: "d".repeat(64),
  });
  return session;
}

/** Wire the real proposal machinery plus a scripted review/risk tail. */
function makeHandlers(
  root: string,
  proposalDrafts: readonly ((session: CaptureSessionRecord) => PrdProposalDraft)[],
  tail?: { review?: CaptureStageHandlers["review"] },
): { handlers: CaptureStageHandlers; reviewCalls: number[] } {
  let proposalCall = 0;
  const reviewCalls: number[] = [];
  const proposal = createInMemoryPrdProposalAdapter((input) => {
    const build = proposalDrafts[Math.min(proposalCall, proposalDrafts.length - 1)]!;
    proposalCall += 1;
    return { status: "proposed", draft: build(input.session) };
  });
  const stages = createCaptureProposalStageHandlers({
    projectRoot: root,
    proposal,
    adapter_profile: {
      backing: "in_memory",
      adapter_profile_digest: ADAPTER_PROFILE_DIGEST,
      prompt_version_digest: PROMPT_VERSION_DIGEST,
      producer_identity: "in-memory",
    },
  });
  return {
    reviewCalls,
    handlers: {
      compileContext: (request) => {
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
        return { kind: "context_compiled", bundle_digest: bundle.content_digest };
      },
      propose: stages.propose,
      validate: stages.validate,
      review: (request) => {
        reviewCalls.push(request.session.revision);
        return (
          tail?.review?.(request) ?? {
            kind: "review_completed",
            verdict: "accept",
            review_digest: contentDigest("review"),
          }
        );
      },
      assessRisk: () => ({ kind: "risk_stable", risk_assessment_digest: contentDigest("risk") }),
    },
  };
}

describe("capture proposal stage wiring", () => {
  it("drives intent → proposal → gates → review → risk → approval with persisted records", async () => {
    const root = makeRoot();
    const session = makeSessionIn(root);
    const { handlers, reviewCalls } = makeHandlers(root, [makeValidDraft]);
    const coordinator = createPrdCaptureCoordinator({ projectRoot: root, handlers });
    const outcome = await coordinator.advance({
      command: "start_capture",
      workflow_operation_id: session.workflow_operation_id,
      iteration_id: session.iteration_id,
      intent_text: session.intent_text,
      project_profile_digest: session.project_profile_digest,
      profile_decision_digest: session.profile_decision_digest,
      capture_policy_digest: session.capture_policy_digest,
      project_baseline_digest: session.project_baseline_digest,
    });
    expect(outcome.status).toBe("awaiting_approval");
    expect(reviewCalls.length).toBeGreaterThan(0);
    if (outcome.status !== "awaiting_approval") throw new Error("expected approval gate");
    const current = coordinator.current(outcome.session.session_id);
    expect(current?.state).toBe("approval_required");

    const proposals = readPrdProposalRevisions(root, session.session_id);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.status).toBe("proposed");
    expect(current?.current_proposal_digest).toBe(proposals[0]?.content_digest);
    // approval object is proposal_id + content_digest
    expect(outcome.approval_object_digest).toBe(proposals[0]?.content_digest);

    const validations = readPrdValidationReports(root, session.session_id);
    expect(validations).toHaveLength(1);
    expect(validations[0]?.passed).toBe(true);

    const lineage = readPrdEntityLineageRecords(root, session.session_id);
    expect(lineage.length).toBeGreaterThan(0);
    expect(
      lineage.every((entry) => entry.proposal_content_digest === proposals[0]?.content_digest),
    ).toBe(true);
  });

  it("hard gate failure produces typed questions and never calls the reviewer", async () => {
    const root = makeRoot();
    const session = makeSessionIn(root);
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
    const { handlers, reviewCalls } = makeHandlers(root, [missingTestFirst, makeValidDraft]);
    const coordinator = createPrdCaptureCoordinator({ projectRoot: root, handlers });
    const outcome = await coordinator.advance({
      command: "start_capture",
      workflow_operation_id: session.workflow_operation_id,
      iteration_id: session.iteration_id,
      intent_text: session.intent_text,
      project_profile_digest: session.project_profile_digest,
      profile_decision_digest: session.profile_decision_digest,
      capture_policy_digest: session.capture_policy_digest,
      project_baseline_digest: session.project_baseline_digest,
    });
    expect(outcome.status).toBe("awaiting_answers");
    if (outcome.status !== "awaiting_answers") throw new Error("expected gate questions");
    expect(reviewCalls).toEqual([]);
    expect(
      outcome.questions.some(
        (question) =>
          question.source === "deterministic_gate" &&
          question.missing_dimension === "test_first_example",
      ),
    ).toBe(true);
    const validations = readPrdValidationReports(root, session.session_id);
    expect(validations).toHaveLength(1);
    expect(validations[0]?.passed).toBe(false);
    // the report names exactly the questions the coordinator issued
    expect(validations[0]?.blocking_question_ids.sort()).toEqual(
      outcome.questions.map((question) => question.question_id).sort(),
    );
  });

  it("rejects an adapter-carried criterion digest that mismatches recomputation", async () => {
    const root = makeRoot();
    const session = makeSessionIn(root);
    const tampered = (live: CaptureSessionRecord): PrdProposalDraft => {
      const draft = makeValidDraft(live);
      return {
        ...draft,
        acceptance_criteria: draft.acceptance_criteria.map((criterion) => ({
          ...criterion,
          criterion_semantic_digest: "0".repeat(64),
        })),
      };
    };
    const { handlers, reviewCalls } = makeHandlers(root, [tampered]);
    const coordinator = createPrdCaptureCoordinator({ projectRoot: root, handlers });
    const outcome = await coordinator.advance({
      command: "start_capture",
      workflow_operation_id: session.workflow_operation_id,
      iteration_id: session.iteration_id,
      intent_text: session.intent_text,
      project_profile_digest: session.project_profile_digest,
      profile_decision_digest: session.profile_decision_digest,
      capture_policy_digest: session.capture_policy_digest,
      project_baseline_digest: session.project_baseline_digest,
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("expected failure");
    expect(outcome.kind).toBe("stage_failed");
    expect(outcome.message).toMatch(/digest/iu);
    expect(reviewCalls).toEqual([]);
    expect(readPrdProposalRevisions(root, session.session_id)).toEqual([]);
  });

  it("clarification answers resume the chain and supersede the failed proposal", async () => {
    const root = makeRoot();
    const session = makeSessionIn(root);
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
    const { handlers } = makeHandlers(root, [missingTestFirst, makeValidDraft]);
    const coordinator = createPrdCaptureCoordinator({ projectRoot: root, handlers });
    const start = await coordinator.advance({
      command: "start_capture",
      workflow_operation_id: session.workflow_operation_id,
      iteration_id: session.iteration_id,
      intent_text: session.intent_text,
      project_profile_digest: session.project_profile_digest,
      profile_decision_digest: session.profile_decision_digest,
      capture_policy_digest: session.capture_policy_digest,
      project_baseline_digest: session.project_baseline_digest,
    });
    expect(start.status).toBe("awaiting_answers");
    if (start.status !== "awaiting_answers") throw new Error("expected questions");
    const resumed = await coordinator.advance({
      command: "submit_clarification_answers",
      session_id: session.session_id,
      expected_session_digest: start.session.record_digest,
      actor: "human:tester",
      answers: start.questions.map((question) => ({
        question_id: question.question_id,
        answer_kind: "free_text" as const,
        value: "given a report, exporting produces a CSV whose rows match",
      })),
    });
    expect(resumed.status).toBe("awaiting_approval");
    const proposals = readPrdProposalRevisions(root, session.session_id);
    expect(proposals).toHaveLength(2);
    expect(proposals[1]?.revision).toBe(2);
    expect(proposals[1]?.proposal_id).toBe(proposals[0]?.proposal_id);
    expect(proposals[1]?.supersedes_digest).toBe(proposals[0]?.record_digest);
  });

  it("keeps legacy interpreter output inside the full quality chain", async () => {
    const root = makeRoot();
    const session = makeSessionIn(root);
    // The classic generic wrap: one requirement, "gate suite passes"
    // verification, no test-first example — must not sail through.
    const legacy = createLegacyIntentInterpreterAdapter({
      interpreter: (intent: string) => ({
        requirements: [
          {
            statement: intent,
            acceptance: [{ description: intent, verification: "mandatory gate suite passes" }],
          },
        ],
      }),
    });
    const stages = createCaptureProposalStageHandlers({
      projectRoot: root,
      proposal: legacy,
      adapter_profile: {
        backing: "in_memory",
        adapter_profile_digest: ADAPTER_PROFILE_DIGEST,
        prompt_version_digest: PROMPT_VERSION_DIGEST,
        producer_identity: "legacy-intent-interpreter",
      },
    });
    const reviewCalls: number[] = [];
    const coordinator = createPrdCaptureCoordinator({
      projectRoot: root,
      handlers: {
        compileContext: (request) => {
          const bundle = createProjectContextBundleRecord({
            session_id: request.session.session_id,
            purpose: request.invocation?.purpose === "context_review" ? "review" : "proposal",
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
          return { kind: "context_compiled", bundle_digest: bundle.content_digest };
        },
        propose: stages.propose,
        validate: stages.validate,
        review: (request) => {
          reviewCalls.push(request.session.revision);
          return {
            kind: "review_completed",
            verdict: "accept",
            review_digest: contentDigest("review"),
          };
        },
        assessRisk: () => ({
          kind: "risk_stable",
          risk_assessment_digest: contentDigest("risk"),
        }),
      },
    });
    const outcome = await coordinator.advance({
      command: "start_capture",
      workflow_operation_id: session.workflow_operation_id,
      iteration_id: session.iteration_id,
      intent_text: session.intent_text,
      project_profile_digest: session.project_profile_digest,
      profile_decision_digest: session.profile_decision_digest,
      capture_policy_digest: session.capture_policy_digest,
      project_baseline_digest: session.project_baseline_digest,
    });
    // The legacy wrap is stopped at the hard gates: typed questions, no
    // review, no approval, no accepted PRD and no RequirementBaseline.
    expect(outcome.status).toBe("awaiting_answers");
    expect(reviewCalls).toEqual([]);
    const proposals = readPrdProposalRevisions(root, session.session_id);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.status).toBe("proposed");
    expect(proposals[0]?.input_binding.producer_identity).toBe("legacy-intent-interpreter");
    const current = coordinator.current(session.session_id);
    expect(current?.state).toBe("clarification_required");
  });

  it("reuses the persisted invocation after a crash and produces an identical proposal", async () => {
    const root = makeRoot();
    const session = makeSessionIn(root);
    const { handlers } = makeHandlers(root, [makeValidDraft]);
    let armed = true;
    const crashing = createPrdCaptureCoordinator({
      projectRoot: root,
      handlers,
      failpoint: (point) => {
        if (armed && point === "invocation.persisted") {
          armed = false;
          throw new Error("simulated crash");
        }
      },
    });
    await expect(
      crashing.advance({
        command: "start_capture",
        workflow_operation_id: session.workflow_operation_id,
        iteration_id: session.iteration_id,
        intent_text: session.intent_text,
        project_profile_digest: session.project_profile_digest,
        profile_decision_digest: session.profile_decision_digest,
        capture_policy_digest: session.capture_policy_digest,
        project_baseline_digest: session.project_baseline_digest,
      }),
    ).rejects.toThrow("simulated crash");

    const resumed = createPrdCaptureCoordinator({ projectRoot: root, handlers });
    const outcome = await resumed.advance({
      command: "resume_capture",
      session_id: session.session_id,
    });
    expect(outcome.status).toBe("awaiting_approval");
    const proposals = readPrdProposalRevisions(root, session.session_id);
    expect(proposals).toHaveLength(1);
    expect(readProjectContextBundles(root).length).toBeGreaterThan(0);
  });
});
