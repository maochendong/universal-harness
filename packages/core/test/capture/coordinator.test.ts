import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ApplyApprovalDecisionCommand,
  CaptureApprovalDecisionView,
  CaptureStageHandlers,
  CaptureStageRequest,
  CaptureStageResult,
  StartCaptureCommand,
  SubmitClarificationAnswersCommand,
} from "../../src/capture/commands.js";
import {
  createPrdCaptureCoordinator,
  type CaptureCoordinatorDeps,
} from "../../src/capture/coordinator.js";
import {
  listCaptureSessionIds,
  readCaptureBlockers,
  readCaptureCheckpoints,
  readCaptureInvocations,
  readCaptureSessionRevisions,
  readCaptureAnswers,
} from "../../src/capture/store.js";
import { createProfileDecisionRecord } from "../../src/profile/decisions.js";
import { createCaptureModelProviderBindingRecord } from "../../src/profile/records.js";
import {
  readCaptureModelProviderBindings,
  submitCaptureModelProviderBindings,
} from "../../src/profile/store.js";
import type {
  CaptureInvocationRecord,
  CaptureSessionRecord,
  ClarificationQuestionRecord,
} from "../../src/schema/capture.js";
import { bindingContractFields, createCapturePromptContractRegistry } from "../prompt/helpers.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const DIGEST_E = "e".repeat(64);
const PROPOSAL_DIGEST = "1".repeat(64);
const VALIDATION_DIGEST = "2".repeat(64);
const REVIEW_DIGEST = "3".repeat(64);
const RISK_DIGEST = "4".repeat(64);
const BUNDLE_PROPOSAL_DIGEST = "5".repeat(64);
const BUNDLE_REVIEW_DIGEST = "6".repeat(64);
const TIMESTAMP = "2026-08-19T00:00:00.000Z";
const PROJECT_ID = "project_demo-app";
const OPERATION_ID = "operation_01K1ABCDEFGHIJKLMNO";
const ITERATION_ID = "iteration_01K1ABCDEFGHIJKLMNO";

const createdRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-capture-coordinator-"));
  createdRoots.push(root);
  return root;
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function profileDecision() {
  return createProfileDecisionRecord({
    decision_kind: "project_profile_change",
    project_id: PROJECT_ID,
    actor: "human:reviewer",
    idempotency_key: `profile-decision:${PROJECT_ID}:1`,
    current_profile_id: "standard",
    decided_profile_id: "standard",
    policy_digest: DIGEST_A,
    decided_at: TIMESTAMP,
  });
}

/** Commit the Capture-scope bindings before Capture starts (design 11.1). */
function commitCaptureBindings(root: string, profileDecisionDigest: string): string[] {
  const contractFields = bindingContractFields(
    createCapturePromptContractRegistry().resolve({
      port_id: "grounded_synthesis",
      purpose: "project_discovery",
      prompt_version: "project-discovery.v1",
    }),
  );
  const record = createCaptureModelProviderBindingRecord({
    project_id: PROJECT_ID,
    profile_decision_id: profileDecision().profile_decision_id,
    profile_decision_digest: profileDecisionDigest,
    policy_digest: DIGEST_A,
    config_digest: DIGEST_E,
    baseline_digest: DIGEST_D,
    bindings: [
      {
        slot_id: "grounded_synthesis",
        purpose: "project_discovery",
        required: true,
        provider_identity: "provider_fake",
        config_digest: DIGEST_E,
        prompt_version: "project-discovery.v1",
        schema_version: "discovery-result.v1",
        budget_profile: "capture-standard",
        failure_mode: "block",
        ...contractFields,
      },
    ],
  });
  submitCaptureModelProviderBindings(root, record);
  return [record.record_digest];
}

class FakeApprovalDecisions {
  private readonly decisions = new Map<string, CaptureApprovalDecisionView>();

  put(decision: CaptureApprovalDecisionView): void {
    this.decisions.set(`${decision.request_id}/${decision.decision_id}`, decision);
  }

  read = (requestId: string, decisionId: string): CaptureApprovalDecisionView | undefined =>
    this.decisions.get(`${requestId}/${decisionId}`);
}

interface PipelineOptions {
  readonly clarifyFirstRound?: boolean;
  readonly alwaysClarify?: boolean;
  readonly omitReview?: boolean;
}

function happyHandlers(options: PipelineOptions = {}): CaptureStageHandlers {
  return {
    compileContext: (request: CaptureStageRequest): CaptureStageResult => ({
      kind: "context_compiled",
      bundle_digest:
        request.invocation?.purpose === "context_review"
          ? BUNDLE_REVIEW_DIGEST
          : BUNDLE_PROPOSAL_DIGEST,
    }),
    propose: (request: CaptureStageRequest): CaptureStageResult => {
      const clarify =
        options.alwaysClarify === true ||
        (options.clarifyFirstRound === true && request.session.round === 0);
      if (clarify) {
        return {
          kind: "clarification_required",
          questions: [
            {
              source: "proposal",
              target_kind: "acceptance_criterion",
              missing_dimension: "observable_outcome",
              question: "重试成功的可观察结果是什么？",
              required: true,
            },
          ],
        };
      }
      return { kind: "proposal_ready", proposal_digest: PROPOSAL_DIGEST };
    },
    validate: (): CaptureStageResult => ({
      kind: "validation_passed",
      validation_digest: VALIDATION_DIGEST,
    }),
    ...(options.omitReview === true
      ? {}
      : {
          review: (): CaptureStageResult => ({
            kind: "review_completed",
            verdict: "accept" as const,
            review_digest: REVIEW_DIGEST,
          }),
        }),
    assessRisk: (): CaptureStageResult => ({
      kind: "risk_stable",
      risk_assessment_digest: RISK_DIGEST,
    }),
  };
}

function startCommand(root: string): StartCaptureCommand {
  commitCaptureBindings(root, profileDecision().record_digest);
  return {
    command: "start_capture",
    workflow_operation_id: OPERATION_ID,
    iteration_id: ITERATION_ID,
    intent_text: "为订单服务增加幂等重试。",
    project_profile_digest: DIGEST_B,
    profile_decision_digest: profileDecision().record_digest,
    capture_policy_digest: DIGEST_C,
    project_baseline_digest: DIGEST_D,
  };
}

function makeCoordinator(
  root: string,
  overrides: Partial<CaptureCoordinatorDeps> = {},
  handlers: CaptureStageHandlers = happyHandlers(),
  decisions: FakeApprovalDecisions = new FakeApprovalDecisions(),
) {
  const deps: CaptureCoordinatorDeps = {
    projectRoot: root,
    handlers,
    readApprovalDecision: decisions.read,
    ...overrides,
  };
  return { coordinator: createPrdCaptureCoordinator(deps), decisions };
}

function answerCommand(
  session: CaptureSessionRecord,
  questions: readonly ClarificationQuestionRecord[],
): SubmitClarificationAnswersCommand {
  return {
    command: "submit_clarification_answers",
    session_id: session.session_id,
    expected_session_digest: session.record_digest,
    actor: "human:reviewer",
    answers: questions
      .filter((question) => question.required)
      .map((question) => ({
        question_id: question.question_id,
        answer_kind: "free_text" as const,
        value: "重复请求返回相同订单且副作用只发生一次。",
      })),
  };
}

function applyDecisionCommand(
  session: CaptureSessionRecord,
  requestId: string,
  decisionId: string,
): ApplyApprovalDecisionCommand {
  return {
    command: "apply_approval_decision",
    session_id: session.session_id,
    expected_session_digest: session.record_digest,
    request_id: requestId,
    decision_id: decisionId,
  };
}

describe("PrdCaptureCoordinator happy path", () => {
  it("drives intent to approval_required with a fully persisted trail", async () => {
    const root = makeRoot();
    const { coordinator } = makeCoordinator(root);
    const outcome = await coordinator.advance(startCommand(root));

    expect(outcome.status).toBe("awaiting_approval");
    if (outcome.status !== "awaiting_approval") throw new Error("unreachable");
    expect(outcome.session.state).toBe("approval_required");
    expect(outcome.approval_object_digest).toBe(PROPOSAL_DIGEST);
    expect(outcome.session.current_proposal_digest).toBe(PROPOSAL_DIGEST);
    expect(outcome.session.current_validation_digest).toBe(VALIDATION_DIGEST);
    expect(outcome.session.current_review_digest).toBe(REVIEW_DIGEST);
    expect(outcome.session.current_risk_assessment_digest).toBe(RISK_DIGEST);
    expect(outcome.session.proposal_context_bundle_digest).toBe(BUNDLE_PROPOSAL_DIGEST);
    expect(outcome.session.review_context_bundle_digest).toBe(BUNDLE_REVIEW_DIGEST);
    expect(outcome.session.current_approval_request_id).toBe(outcome.approval_request_id);
    expect(outcome.session.blocked_reason).toBeUndefined();

    const sessionId = outcome.session.session_id;
    const revisions = readCaptureSessionRevisions(root, sessionId);
    expect(revisions.map((revision) => revision.state)).toEqual([
      "intent_received",
      "context_compiling",
      "proposing",
      "validating",
      "context_compiling",
      "reviewing",
      "risk_assessing",
      "approval_required",
    ]);
    // Supersedes chain links every revision to its predecessor.
    for (let index = 1; index < revisions.length; index += 1) {
      expect(revisions[index]!.supersedes_digest).toBe(revisions[index - 1]!.record_digest);
      expect(revisions[index]!.revision).toBe(index + 1);
    }
    // One checkpoint per committed revision, mirroring its state.
    const checkpoints = readCaptureCheckpoints(root, sessionId);
    expect(checkpoints).toHaveLength(revisions.length);
    expect(checkpoints.at(-1)!.state).toBe("approval_required");
    expect(checkpoints.at(-1)!.session_digest).toBe(outcome.session.record_digest);

    // Invocations: proposal/review contexts plus proposal and review stages.
    const invocations = readCaptureInvocations(root, sessionId);
    expect(invocations.map((invocation) => invocation.purpose).sort()).toEqual([
      "context_proposal",
      "context_review",
      "proposal",
      "review",
    ]);
    expect(outcome.session.budget_use).toEqual({
      clarification_rounds: 0,
      proposal_invocations: 1,
      review_invocations: 1,
    });
  });

  it("re-issuing the identical start command is an idempotent no-op", async () => {
    const root = makeRoot();
    const { coordinator } = makeCoordinator(root);
    const command = startCommand(root);
    const first = await coordinator.advance(command);
    const second = await coordinator.advance(command);
    expect(second.status).toBe("already_applied");
    if (first.status !== "awaiting_approval" || second.status !== "already_applied") {
      throw new Error("unreachable");
    }
    expect(second.session.session_id).toBe(first.session.session_id);
    expect(readCaptureSessionRevisions(root, first.session.session_id)).toHaveLength(8);
  });
});

describe("invocation barrier", () => {
  it("persists Operation, Session and all Capture-scope binding digests before any model call", async () => {
    const root = makeRoot();
    const observations: Array<{
      purpose: CaptureInvocationRecord["purpose"];
      sessionPersisted: boolean;
      invocationPersisted: boolean;
      bindingsPersisted: boolean;
      operationBound: boolean;
    }> = [];
    const instrument = (
      purpose: CaptureInvocationRecord["purpose"],
      request: CaptureStageRequest,
    ): void => {
      const invocation = request.invocation;
      expect(invocation).toBeDefined();
      if (invocation === undefined) return;
      const session = readCaptureSessionRevisions(root, invocation.session_id).at(-1);
      const persistedInvocations = readCaptureInvocations(root, invocation.session_id);
      const bindingDigests = readCaptureModelProviderBindings(root).map(
        (binding) => binding.record_digest,
      );
      observations.push({
        purpose,
        sessionPersisted:
          session !== undefined && session.record_digest === invocation.session_digest,
        invocationPersisted: persistedInvocations.some(
          (candidate) => candidate.record_digest === invocation.record_digest,
        ),
        bindingsPersisted: invocation.binding_digests.every((digest) =>
          bindingDigests.includes(digest),
        ),
        operationBound: invocation.workflow_operation_id === OPERATION_ID,
      });
      expect(purpose).toBe(invocation.purpose);
    };
    const base = happyHandlers();
    const instrumented: CaptureStageHandlers = {
      compileContext: (request) => {
        instrument(request.invocation!.purpose, request);
        return base.compileContext!(request);
      },
      propose: (request) => {
        instrument("proposal", request);
        return base.propose!(request);
      },
      validate: (request) => base.validate!(request),
      review: (request) => {
        instrument("review", request);
        return base.review!(request);
      },
      assessRisk: (request) => base.assessRisk!(request),
    };
    const { coordinator } = makeCoordinator(root, {}, instrumented);
    const outcome = await coordinator.advance(startCommand(root));
    expect(outcome.status).toBe("awaiting_approval");
    expect(observations).toHaveLength(4);
    for (const observation of observations) {
      expect(observation, observation.purpose).toEqual({
        purpose: observation.purpose,
        sessionPersisted: true,
        invocationPersisted: true,
        bindingsPersisted: true,
        operationBound: true,
      });
    }
  });

  it("fails closed at start when a required Capture-scope binding is missing", async () => {
    const root = makeRoot();
    // Standard/Governed declare the Capture-scope bindings as required; the
    // coordinator must not infer them from elsewhere or fabricate them.
    const { coordinator } = makeCoordinator(root, { requireCaptureBindings: true });
    const command = {
      ...startCommand(root),
      profile_decision_digest: DIGEST_E, // no bindings committed for this decision
    };
    const outcome = await coordinator.advance(command);
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.kind).toBe("binding_missing");
    expect(readCaptureSessionRevisions(root, "capture-session_anything")).toEqual([]);
  });
});

describe("clarification loop", () => {
  it("collects answers, advances on the last required answer and stays idempotent", async () => {
    const root = makeRoot();
    const { coordinator } = makeCoordinator(root, {}, happyHandlers({ clarifyFirstRound: true }));
    const started = await coordinator.advance(startCommand(root));
    expect(started.status).toBe("awaiting_answers");
    if (started.status !== "awaiting_answers") throw new Error("unreachable");
    expect(started.session.state).toBe("clarification_required");
    expect(started.session.round).toBe(1);
    expect(started.questions).toHaveLength(1);
    expect(started.session.pending_question_ids).toEqual([started.questions[0]!.question_id]);

    // Expected digest conflict: typed conflict, nothing persisted.
    const conflict = await coordinator.advance({
      ...answerCommand(started.session, started.questions),
      expected_session_digest: DIGEST_E,
    });
    expect(conflict.status).toBe("conflict");
    if (conflict.status !== "conflict") throw new Error("unreachable");
    expect(conflict.expected_session_digest).toBe(DIGEST_E);
    expect(conflict.actual_session_digest).toBe(started.session.record_digest);
    expect(readCaptureAnswers(root, started.session.session_id)).toEqual([]);

    const answered = await coordinator.advance(answerCommand(started.session, started.questions));
    expect(answered.status).toBe("awaiting_approval");
    if (answered.status !== "awaiting_approval") throw new Error("unreachable");
    const sessionId = answered.session.session_id;
    expect(readCaptureAnswers(root, sessionId)).toHaveLength(1);
    expect(answered.session.pending_question_ids).toEqual([]);
    expect(answered.session.round).toBe(1);
    expect(answered.session.budget_use.clarification_rounds).toBe(1);

    // Replaying the same command against the moved-on session is a no-op, not
    // a conflict: the answer records are already persisted and consumed.
    const replayed = await coordinator.advance(answerCommand(started.session, started.questions));
    expect(replayed.status).toBe("already_applied");
    expect(readCaptureAnswers(root, sessionId)).toHaveLength(1);

    // CLI/Dashboard alternation: a fresh coordinator over the same store
    // reconstructs the identical state with no in-memory carry-over.
    const fresh = makeCoordinator(root);
    const resumed = await fresh.coordinator.advance({
      command: "resume_capture",
      session_id: sessionId,
    });
    expect(resumed.status).toBe("awaiting_approval");
  });

  it("rejects answers to unknown or non-pending questions", async () => {
    const root = makeRoot();
    const { coordinator } = makeCoordinator(root, {}, happyHandlers({ clarifyFirstRound: true }));
    const started = await coordinator.advance(startCommand(root));
    if (started.status !== "awaiting_answers") throw new Error("unreachable");
    const outcome = await coordinator.advance({
      command: "submit_clarification_answers",
      session_id: started.session.session_id,
      expected_session_digest: started.session.record_digest,
      actor: "human:reviewer",
      answers: [
        {
          question_id: "clarification-question_00000000-0000-0000-0000-000000000000",
          answer_kind: "free_text",
          value: "答非所问。",
        },
      ],
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.kind).toBe("unknown_question");
  });

  it("blocks with capture_budget_exhausted when the round budget runs out and recovers after a budget raise", async () => {
    const root = makeRoot();
    const handlers = happyHandlers({ alwaysClarify: true });
    const first = makeCoordinator(root, { budget: { maxClarificationRounds: 1 } }, handlers);
    const started = await first.coordinator.advance(startCommand(root));
    if (started.status !== "awaiting_answers") throw new Error("unreachable");

    const answered = await first.coordinator.advance(
      answerCommand(started.session, started.questions),
    );
    expect(answered.status).toBe("blocked");
    if (answered.status !== "blocked") throw new Error("unreachable");
    expect(answered.session.state).toBe("blocked");
    expect(answered.session.blocked_reason).toBe("capture_budget_exhausted");
    expect(answered.blocker.reason).toBe("capture_budget_exhausted");
    expect(answered.blocker.resume_state).toBe("proposing");

    // Resume without a budget change stays blocked and appends nothing.
    const stillBlocked = await first.coordinator.advance({
      command: "resume_capture",
      session_id: started.session.session_id,
    });
    expect(stillBlocked.status).toBe("blocked");
    const revisionCount = readCaptureSessionRevisions(root, started.session.session_id).length;

    // The user raises the budget (policy change) and resumes explicitly.
    const raised = makeCoordinator(root, { budget: { maxClarificationRounds: 3 } }, handlers);
    const recovered = await raised.coordinator.advance({
      command: "resume_capture",
      session_id: started.session.session_id,
    });
    expect(recovered.status).toBe("awaiting_answers");
    if (recovered.status !== "awaiting_answers") throw new Error("unreachable");
    expect(recovered.session.round).toBe(2);
    expect(recovered.session.blocked_reason).toBeUndefined();
    expect(readCaptureSessionRevisions(root, started.session.session_id).length).toBeGreaterThan(
      revisionCount,
    );
  });
});

describe("review provider blocker", () => {
  it("preserves a required model failure as a versioned blocker and resumes the same session", async () => {
    const root = makeRoot();
    let providerAvailable = false;
    const handlers = happyHandlers();
    const recoveringHandlers: CaptureStageHandlers = {
      ...handlers,
      propose: (request) =>
        providerAvailable
          ? handlers.propose!(request)
          : {
              kind: "stage_failed",
              failure: {
                code: "provider_unavailable",
                summary: "managed provider is unavailable",
                retryable: true,
              },
            },
    };
    const { coordinator } = makeCoordinator(root, {}, recoveringHandlers);

    const blocked = await coordinator.advance(startCommand(root));
    expect(blocked.status).toBe("blocked");
    if (blocked.status !== "blocked") throw new Error("unreachable");
    expect(blocked.session.blocked_reason).toBe("managed_model_failure");
    expect(blocked.blocker).toMatchObject({
      reason: "managed_model_failure",
      resume_state: "proposing",
      failure_schema_version: "managed-model-failure.v1",
      failure_code: "provider_unavailable",
    });
    const sessionId = blocked.session.session_id;
    expect(readCaptureInvocations(root, sessionId)).toHaveLength(2);

    providerAvailable = true;
    const resumed = await coordinator.advance({
      command: "resume_capture",
      session_id: sessionId,
    });
    expect(resumed.status).toBe("awaiting_approval");
    expect(resumed.session.session_id).toBe(sessionId);
  });

  it("blocks with the typed review_provider_required reason and recovers after configuration", async () => {
    const root = makeRoot();
    const withoutReview = makeCoordinator(root, {}, happyHandlers({ omitReview: true }));
    const outcome = await withoutReview.coordinator.advance(startCommand(root));
    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") throw new Error("unreachable");
    expect(outcome.session.state).toBe("blocked");
    expect(outcome.session.blocked_reason).toBe("review_provider_required");
    expect(outcome.blocker.reason).toBe("review_provider_required");
    expect(outcome.blocker.resume_state).toBe("reviewing");

    // The blocker is persisted as a typed record; the session never carries
    // review_provider_required as a state.
    const blockers = readCaptureBlockers(root, outcome.session.session_id);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.reason).toBe("review_provider_required");
    expect(
      readCaptureSessionRevisions(root, outcome.session.session_id).every(
        (revision) => revision.state !== ("review_provider_required" as never),
      ),
    ).toBe(true);

    // Resume before configuring a provider: still blocked, no new revision.
    const before = readCaptureSessionRevisions(root, outcome.session.session_id).length;
    const unchanged = await withoutReview.coordinator.advance({
      command: "resume_capture",
      session_id: outcome.session.session_id,
    });
    expect(unchanged.status).toBe("blocked");
    expect(readCaptureSessionRevisions(root, outcome.session.session_id)).toHaveLength(before);

    // The user configures a provider (or chooses Manual Review) and resumes.
    const withReview = makeCoordinator(root, {}, happyHandlers());
    const resumed = await withReview.coordinator.advance({
      command: "resume_capture",
      session_id: outcome.session.session_id,
    });
    expect(resumed.status).toBe("awaiting_approval");
    if (resumed.status !== "awaiting_approval") throw new Error("unreachable");
    expect(resumed.session.state).toBe("approval_required");
    expect(resumed.session.blocked_reason).toBeUndefined();
  });
});

describe("approval decision consumption", () => {
  async function driveToApproval(root: string, decisions: FakeApprovalDecisions) {
    const { coordinator } = makeCoordinator(root, {}, happyHandlers(), decisions);
    const outcome = await coordinator.advance(startCommand(root));
    if (outcome.status !== "awaiting_approval") throw new Error("unreachable");
    return { coordinator, session: outcome.session, requestId: outcome.approval_request_id };
  }

  function decision(
    requestId: string,
    decisionId: string,
    value: "approve" | "reject" | "defer",
    reason?: string,
  ): CaptureApprovalDecisionView {
    return {
      decision_id: decisionId,
      request_id: requestId,
      decision: value,
      object_digest: PROPOSAL_DIGEST,
      actor: "human:approver",
      ...(reason === undefined ? {} : { reason }),
    };
  }

  it("consumes a persisted approve decision exactly once", async () => {
    const root = makeRoot();
    const decisions = new FakeApprovalDecisions();
    const { coordinator, session, requestId } = await driveToApproval(root, decisions);
    decisions.put(decision(requestId, "approval-decision_approve1", "approve"));

    const applied = await coordinator.advance(
      applyDecisionCommand(session, requestId, "approval-decision_approve1"),
    );
    expect(applied.status).toBe("accepted");
    if (applied.status !== "accepted") throw new Error("unreachable");
    expect(applied.session.state).toBe("accepted");
    expect(applied.session.applied_approval_decision_id).toBe("approval-decision_approve1");

    // Re-applying the persisted decision is an idempotent no-op.
    const before = readCaptureSessionRevisions(root, session.session_id).length;
    const replayed = await coordinator.advance(
      applyDecisionCommand(session, requestId, "approval-decision_approve1"),
    );
    expect(replayed.status).toBe("already_applied");
    expect(readCaptureSessionRevisions(root, session.session_id)).toHaveLength(before);
  });

  it("recovers when the decision was committed but the consumption crashed", async () => {
    const root = makeRoot();
    const decisions = new FakeApprovalDecisions();
    let crashesLeft = 1;
    const { coordinator } = makeCoordinator(
      root,
      {
        failpoint: (point) => {
          if (point === "decision.consumed" && crashesLeft > 0) {
            crashesLeft -= 1;
            throw new Error("simulated process crash");
          }
        },
      },
      happyHandlers(),
      decisions,
    );
    const started = await coordinator.advance(startCommand(root));
    if (started.status !== "awaiting_approval") throw new Error("unreachable");
    decisions.put(decision(started.approval_request_id, "approval-decision_crash1", "approve"));

    // The crash happens after the decision is read but before the consumption
    // revision is appended: the decision stays committed but unconsumed.
    await expect(
      coordinator.advance(
        applyDecisionCommand(
          started.session,
          started.approval_request_id,
          "approval-decision_crash1",
        ),
      ),
    ).rejects.toThrow("simulated process crash");
    expect(readCaptureSessionRevisions(root, started.session.session_id).at(-1)!.state).toBe(
      "approval_required",
    );

    // A fresh coordinator (process restart) finds the unconsumed decision and
    // consumes it idempotently.
    const restarted = makeCoordinator(root, {}, happyHandlers(), decisions);
    const consumed = await restarted.coordinator.advance(
      applyDecisionCommand(
        restarted.coordinator.current(started.session.session_id)!,
        started.approval_request_id,
        "approval-decision_crash1",
      ),
    );
    expect(consumed.status).toBe("accepted");
    const appliedRevisions = readCaptureSessionRevisions(root, started.session.session_id).filter(
      (revision) => revision.applied_approval_decision_id === "approval-decision_crash1",
    );
    expect(appliedRevisions).toHaveLength(1);
  });

  it("rejects decisions bound to a different object, request or nothing at all", async () => {
    const root = makeRoot();
    const decisions = new FakeApprovalDecisions();
    const { coordinator, session, requestId } = await driveToApproval(root, decisions);

    const missing = await coordinator.advance(
      applyDecisionCommand(session, requestId, "approval-decision_missing"),
    );
    expect(missing.status).toBe("failed");
    if (missing.status !== "failed") throw new Error("unreachable");
    expect(missing.kind).toBe("approval_decision_not_found");

    decisions.put({
      ...decision(requestId, "approval-decision_drift1", "approve"),
      object_digest: DIGEST_E,
    });
    const drifted = await coordinator.advance(
      applyDecisionCommand(session, requestId, "approval-decision_drift1"),
    );
    expect(drifted.status).toBe("failed");
    if (drifted.status !== "failed") throw new Error("unreachable");
    expect(drifted.kind).toBe("approval_binding_mismatch");

    const otherRequest = "approval-request_00000000-0000-0000-0000-000000000000";
    decisions.put(decision(otherRequest, "approval-decision_wrongreq", "approve"));
    const wrongRequest = await coordinator.advance(
      applyDecisionCommand(session, otherRequest, "approval-decision_wrongreq"),
    );
    expect(wrongRequest.status).toBe("failed");
    if (wrongRequest.status !== "failed") throw new Error("unreachable");
    expect(wrongRequest.kind).toBe("approval_request_mismatch");

    const conflicts = await coordinator.advance({
      ...applyDecisionCommand(session, requestId, "approval-decision_wrongreq"),
      expected_session_digest: DIGEST_E,
    });
    expect(conflicts.status).toBe("conflict");
  });

  it("maps reject to revision_required and defer to approval_deferred with re-signed resume", async () => {
    const root = makeRoot();
    const decisions = new FakeApprovalDecisions();
    const { coordinator, session, requestId } = await driveToApproval(root, decisions);

    // Reject without a reason is not a legal decision consumption.
    decisions.put(decision(requestId, "approval-decision_noreason", "reject"));
    const noReason = await coordinator.advance(
      applyDecisionCommand(session, requestId, "approval-decision_noreason"),
    );
    expect(noReason.status).toBe("failed");
    if (noReason.status !== "failed") throw new Error("unreachable");
    expect(noReason.kind).toBe("reject_reason_required");

    decisions.put(decision(requestId, "approval-decision_reject1", "reject", "范围过大。"));
    const rejected = await coordinator.advance(
      applyDecisionCommand(session, requestId, "approval-decision_reject1"),
    );
    expect(rejected.status).toBe("revision_required");
    if (rejected.status !== "revision_required") throw new Error("unreachable");
    expect(rejected.session.state).toBe("revision_required");
    // A reject-driven revision_required waits for the user instead of looping.
    const stillWaiting = await coordinator.advance({
      command: "resume_capture",
      session_id: session.session_id,
    });
    expect(stillWaiting.status).toBe("revision_required");

    // The user explicitly requests the revision loop and the pipeline re-runs.
    const revised = await coordinator.advance({
      command: "request_prd_revision",
      session_id: session.session_id,
      expected_session_digest: rejected.session.record_digest,
      updated_intent_text: "缩小范围：仅覆盖订单创建重试。",
    });
    expect(revised.status).toBe("awaiting_approval");
    if (revised.status !== "awaiting_approval") throw new Error("unreachable");
    expect(revised.session.intent_text).toBe("缩小范围：仅覆盖订单创建重试。");

    // Defer parks the session; resume re-signs the approval request.
    decisions.put(decision(revised.approval_request_id, "approval-decision_defer1", "defer"));
    const deferred = await coordinator.advance(
      applyDecisionCommand(
        revised.session,
        revised.approval_request_id,
        "approval-decision_defer1",
      ),
    );
    expect(deferred.status).toBe("approval_deferred");
    if (deferred.status !== "approval_deferred") throw new Error("unreachable");
    expect(deferred.session.state).toBe("approval_deferred");

    const reSigned = await coordinator.advance({
      command: "resume_capture",
      session_id: session.session_id,
    });
    expect(reSigned.status).toBe("awaiting_approval");
    if (reSigned.status !== "awaiting_approval") throw new Error("unreachable");
    expect(reSigned.approval_request_id).not.toBe(revised.approval_request_id);

    // A decision bound to the superseded request no longer applies.
    decisions.put(decision(revised.approval_request_id, "approval-decision_stale", "approve"));
    const stale = await coordinator.advance(
      applyDecisionCommand(
        reSigned.session,
        revised.approval_request_id,
        "approval-decision_stale",
      ),
    );
    expect(stale.status).toBe("failed");
    if (stale.status !== "failed") throw new Error("unreachable");
    expect(stale.kind).toBe("approval_request_mismatch");
  });
});

describe("crash and resume", () => {
  it("reuses the persisted invocation after a crash between commit and dispatch", async () => {
    const root = makeRoot();
    let invocationCommits = 0;
    let proposeCalls = 0;
    let handledInvocationId: string | undefined;
    const handlers: CaptureStageHandlers = {
      ...happyHandlers(),
      propose: (request) => {
        proposeCalls += 1;
        handledInvocationId = request.invocation?.invocation_id;
        return { kind: "proposal_ready", proposal_digest: PROPOSAL_DIGEST };
      },
    };
    const first = makeCoordinator(
      root,
      {
        failpoint: (point) => {
          if (point === "invocation.persisted") {
            invocationCommits += 1;
            // Crash on the second invocation commit: the proposal-purpose
            // invocation is persisted but the handler never ran.
            if (invocationCommits === 2) {
              throw new Error("simulated process crash");
            }
          }
        },
      },
      handlers,
    );
    await expect(first.coordinator.advance(startCommand(root))).rejects.toThrow(
      "simulated process crash",
    );

    const sessionId = listCaptureSessionIds(root)[0]!;
    const proposalInvocations = readCaptureInvocations(root, sessionId).filter(
      (invocation) => invocation.purpose === "proposal",
    );
    expect(proposalInvocations).toHaveLength(1);
    expect(proposeCalls).toBe(0);

    // Process restart: a fresh coordinator resumes from the store alone and
    // reuses the persisted invocation instead of minting a duplicate.
    const restarted = makeCoordinator(root, {}, handlers);
    const resumed = await restarted.coordinator.advance({
      command: "resume_capture",
      session_id: sessionId,
    });
    expect(resumed.status).toBe("awaiting_approval");
    expect(
      readCaptureInvocations(root, sessionId).filter(
        (invocation) => invocation.purpose === "proposal",
      ),
    ).toHaveLength(1);
    expect(proposeCalls).toBe(1);
    expect(handledInvocationId).toBe(proposalInvocations[0]!.invocation_id);
  });
});

describe("cancellation and invalid commands", () => {
  it("cancels from any non-terminal state and is idempotent", async () => {
    const root = makeRoot();
    const { coordinator } = makeCoordinator(root, {}, happyHandlers({ clarifyFirstRound: true }));
    const started = await coordinator.advance(startCommand(root));
    if (started.status !== "awaiting_answers") throw new Error("unreachable");

    const cancelled = await coordinator.advance({
      command: "cancel_capture",
      session_id: started.session.session_id,
    });
    expect(cancelled.status).toBe("cancelled");
    if (cancelled.status !== "cancelled") throw new Error("unreachable");
    expect(cancelled.session.state).toBe("cancelled");

    const before = readCaptureSessionRevisions(root, started.session.session_id).length;
    const again = await coordinator.advance({
      command: "cancel_capture",
      session_id: started.session.session_id,
    });
    expect(again.status).toBe("already_applied");
    expect(readCaptureSessionRevisions(root, started.session.session_id)).toHaveLength(before);

    // Terminal sessions reject every other command without writes.
    const late = await coordinator.advance(answerCommand(started.session, started.questions));
    expect(late.status).toBe("failed");
    if (late.status !== "failed") throw new Error("unreachable");
    expect(late.kind).toBe("invalid_transition");
  });

  it("fails closed on commands that do not match the current state", async () => {
    const root = makeRoot();
    const { coordinator } = makeCoordinator(root);
    const outcome = await coordinator.advance(startCommand(root));
    if (outcome.status !== "awaiting_approval") throw new Error("unreachable");

    // Answers are only legal while clarification is pending.
    const answers = await coordinator.advance({
      command: "submit_clarification_answers",
      session_id: outcome.session.session_id,
      expected_session_digest: outcome.session.record_digest,
      actor: "human:reviewer",
      answers: [],
    });
    expect(answers.status).toBe("failed");
    if (answers.status !== "failed") throw new Error("unreachable");
    expect(answers.kind).toBe("invalid_transition");

    // Revision requests are only legal from revision_required.
    const revision = await coordinator.advance({
      command: "request_prd_revision",
      session_id: outcome.session.session_id,
      expected_session_digest: outcome.session.record_digest,
    });
    expect(revision.status).toBe("failed");
    if (revision.status !== "failed") throw new Error("unreachable");
    expect(revision.kind).toBe("invalid_transition");

    // Unknown sessions fail closed.
    const missing = await coordinator.advance({
      command: "resume_capture",
      session_id: "capture-session_00000000-0000-0000-0000-000000000000",
    });
    expect(missing.status).toBe("failed");
    if (missing.status !== "failed") throw new Error("unreachable");
    expect(missing.kind).toBe("session_not_found");
  });
});
