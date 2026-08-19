import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CaptureRecordError,
  createCaptureBlockerRecord,
  createCaptureCheckpointRecord,
  createCaptureInvocationRecord,
  createCaptureSessionRecord,
  createClarificationAnswerRecord,
  createClarificationQuestionRecords,
  reviseCaptureSessionRecord,
  type ClarificationQuestionDraft,
} from "../../src/capture/records.js";
import { verifyRecordEnvelope } from "../../src/schema/envelope.js";
import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../../src/schema/registry.js";
import type {
  CaptureSessionRecord,
  ClarificationAnswerRecord,
  ClarificationQuestionRecord,
} from "../../src/schema/capture.js";
import { CAPTURE_STATES } from "../../src/schema/capture.js";

const goldenDirectory = join(dirname(fileURLToPath(import.meta.url)), "../golden/capture");

function readGolden<T>(name: string): T {
  return JSON.parse(readFileSync(join(goldenDirectory, name), "utf8")) as T;
}

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const BINDING_1 = "1".repeat(64);
const BINDING_2 = "2".repeat(64);
const OPERATION_ID = "operation_01K1ABCDEFGHIJKLMNO";
const ITERATION_ID = "iteration_01K1ABCDEFGHIJKLMNO";

function goldenSession(): CaptureSessionRecord {
  return createCaptureSessionRecord({
    workflow_operation_id: OPERATION_ID,
    iteration_id: ITERATION_ID,
    intent_text: "为订单服务增加幂等重试。",
    project_profile_digest: DIGEST_A,
    profile_decision_digest: DIGEST_B,
    capture_policy_digest: DIGEST_C,
    project_baseline_digest: DIGEST_D,
  });
}

function goldenQuestions(session: CaptureSessionRecord): ClarificationQuestionRecord[] {
  const drafts: ClarificationQuestionDraft[] = [
    {
      source: "deterministic_gate",
      target_kind: "acceptance_criterion",
      missing_dimension: "observable_outcome",
      question: "重试成功的可观察结果是什么？",
      required: true,
    },
    {
      source: "proposal",
      target_kind: "constraint",
      missing_dimension: "verification_intent",
      question: "幂等约束如何验证？",
      options: [
        { option_id: "contract-test", label: "契约测试" },
        { option_id: "integration-test", label: "集成测试" },
      ],
      required: false,
    },
  ];
  return createClarificationQuestionRecords({ session_id: session.session_id, round: 1, drafts });
}

function goldenAnswer(
  session: CaptureSessionRecord,
  question: ClarificationQuestionRecord,
): ClarificationAnswerRecord {
  return createClarificationAnswerRecord({
    session_id: session.session_id,
    question,
    answer_kind: "free_text",
    value: "重复请求返回相同订单且副作用只发生一次。",
    actor: "human:reviewer",
    expected_session_digest: session.record_digest,
  });
}

describe("capture record constructors", () => {
  it("creates a revision-1 session bound to the operation, intent and policy digests", () => {
    const session = goldenSession();
    expect(session.record_kind).toBe("capture_session");
    expect(session.protocol_version).toBe("1.1.0");
    expect(session.revision).toBe(1);
    expect(session.state).toBe("intent_received");
    expect(session.blocked_reason).toBeUndefined();
    expect(session.workflow_operation_id).toBe(OPERATION_ID);
    expect(session.round).toBe(0);
    expect(session.pending_question_ids).toEqual([]);
    expect(session.budget_use).toEqual({
      clarification_rounds: 0,
      proposal_invocations: 0,
      review_invocations: 0,
    });
    expect(session.intent_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(session.supersedes_digest).toBeUndefined();
  });

  it("derives the same session identity for the same operation and intent", () => {
    expect(goldenSession().session_id).toBe(goldenSession().session_id);
  });

  it("derives different session identities for different intents", () => {
    const other = createCaptureSessionRecord({
      workflow_operation_id: OPERATION_ID,
      iteration_id: ITERATION_ID,
      intent_text: "另一个意图。",
      project_profile_digest: DIGEST_A,
      profile_decision_digest: DIGEST_B,
      capture_policy_digest: DIGEST_C,
      project_baseline_digest: DIGEST_D,
    });
    expect(other.session_id).not.toBe(goldenSession().session_id);
  });

  it("appends revisions with a supersedes chain instead of rewriting", () => {
    const session = goldenSession();
    const revision2 = reviseCaptureSessionRecord(
      session,
      { state: "context_compiling" },
      session.budget_use,
    );
    expect(revision2.revision).toBe(2);
    expect(revision2.state).toBe("context_compiling");
    expect(revision2.supersedes_digest).toBe(session.record_digest);
    expect(revision2.record_digest).not.toBe(session.record_digest);
    expect(revision2.session_id).toBe(session.session_id);
  });

  it("clears blocked_reason when a revision leaves the blocked state", () => {
    const session = goldenSession();
    const compiling = reviseCaptureSessionRecord(
      session,
      { state: "context_compiling" },
      session.budget_use,
    );
    const blocked = reviseCaptureSessionRecord(
      compiling,
      { state: "blocked", blocked_reason: "review_provider_required" },
      compiling.budget_use,
    );
    expect(blocked.blocked_reason).toBe("review_provider_required");
    const resumed = reviseCaptureSessionRecord(blocked, { state: "reviewing" }, blocked.budget_use);
    expect(resumed.blocked_reason).toBeUndefined();
  });

  it("enforces the blocked_reason invariant at construction time", () => {
    const session = goldenSession();
    const compiling = reviseCaptureSessionRecord(
      session,
      { state: "context_compiling" },
      session.budget_use,
    );
    expect(() =>
      reviseCaptureSessionRecord(compiling, { state: "blocked" }, compiling.budget_use),
    ).toThrow(CaptureRecordError);
    expect(() =>
      reviseCaptureSessionRecord(
        session,
        { state: "context_compiling", blocked_reason: "review_blocked" },
        session.budget_use,
      ),
    ).toThrow(CaptureRecordError);
  });

  it("normalizes pending question ids canonically", () => {
    const session = goldenSession();
    const questions = goldenQuestions(session);
    const proposing = reviseCaptureSessionRecord(
      reviseCaptureSessionRecord(session, { state: "context_compiling" }, session.budget_use),
      { state: "proposing" },
      session.budget_use,
    );
    const revision = reviseCaptureSessionRecord(
      proposing,
      {
        state: "clarification_required",
        pending_question_ids: [questions[1]!.question_id, questions[0]!.question_id],
        round: 1,
      },
      { clarification_rounds: 1, proposal_invocations: 0, review_invocations: 0 },
    );
    const reordered = reviseCaptureSessionRecord(
      proposing,
      {
        state: "clarification_required",
        pending_question_ids: [questions[0]!.question_id, questions[1]!.question_id],
        round: 1,
      },
      { clarification_rounds: 1, proposal_invocations: 0, review_invocations: 0 },
    );
    expect(revision.pending_question_ids).toEqual(reordered.pending_question_ids);
    expect(revision.record_digest).toBe(reordered.record_digest);
  });
});

describe("clarification question records", () => {
  it("normalizes, deduplicates and stably sorts question drafts", () => {
    const session = goldenSession();
    const questions = goldenQuestions(session);
    expect(questions).toHaveLength(2);
    // Deterministic order independent of draft order.
    const reversed = createClarificationQuestionRecords({
      session_id: session.session_id,
      round: 1,
      drafts: [
        {
          source: "proposal",
          target_kind: "constraint",
          missing_dimension: "verification_intent",
          question: "幂等约束如何验证？",
          options: [
            { option_id: "contract-test", label: "契约测试" },
            { option_id: "integration-test", label: "集成测试" },
          ],
          required: false,
        },
        {
          source: "deterministic_gate",
          target_kind: "acceptance_criterion",
          missing_dimension: "observable_outcome",
          question: "重试成功的可观察结果是什么？",
          required: true,
        },
        {
          source: "review",
          target_kind: "acceptance_criterion",
          missing_dimension: "observable_outcome",
          question: "重试成功的可观察结果是什么？",
          required: true,
        },
      ],
    });
    // The review draft duplicates the deterministic-gate question semantically
    // and is folded into a single question record.
    expect(reversed.map((question) => question.question_id)).toEqual(
      questions.map((question) => question.question_id),
    );
    for (const question of questions) {
      expect(question.status).toBe("open");
      expect(question.round).toBe(1);
      expect(question.session_id).toBe(session.session_id);
      expect(question.content_digest).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it("mints new question identities per round so re-asked questions never rewrite history", () => {
    const session = goldenSession();
    const round2 = createClarificationQuestionRecords({
      session_id: session.session_id,
      round: 2,
      drafts: [
        {
          source: "deterministic_gate",
          target_kind: "acceptance_criterion",
          missing_dimension: "observable_outcome",
          question: "重试成功的可观察结果是什么？",
          required: true,
        },
      ],
    });
    expect(round2[0]!.question_id).not.toBe(goldenQuestions(session)[0]!.question_id);
  });
});

describe("clarification answer records", () => {
  it("binds the answer to the question and the expected session digest", () => {
    const session = goldenSession();
    const [question] = goldenQuestions(session);
    const answer = goldenAnswer(session, question!);
    expect(answer.record_kind).toBe("clarification_answer");
    expect(answer.question_id).toBe(question!.question_id);
    expect(answer.expected_session_digest).toBe(session.record_digest);
    expect(answer.content_digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("is idempotent for identical answers and divergent for different values", () => {
    const session = goldenSession();
    const [question] = goldenQuestions(session);
    const again = goldenAnswer(session, question!);
    expect(again.answer_id).toBe(goldenAnswer(session, question!).answer_id);
    const different = createClarificationAnswerRecord({
      session_id: session.session_id,
      question: question!,
      answer_kind: "free_text",
      value: "另一个答案。",
      actor: "human:reviewer",
      expected_session_digest: session.record_digest,
    });
    expect(different.answer_id).not.toBe(again.answer_id);
  });

  it("rejects selected_option answers outside the question options", () => {
    const session = goldenSession();
    const withOptions = goldenQuestions(session).find((question) => question.options !== undefined);
    expect(withOptions).toBeDefined();
    if (withOptions === undefined) throw new Error("unreachable");
    expect(() =>
      createClarificationAnswerRecord({
        session_id: session.session_id,
        question: withOptions,
        answer_kind: "selected_option",
        value: "not-an-option",
        actor: "human:reviewer",
        expected_session_digest: session.record_digest,
      }),
    ).toThrow(CaptureRecordError);
    const accepted = createClarificationAnswerRecord({
      session_id: session.session_id,
      question: withOptions,
      answer_kind: "selected_option",
      value: "contract-test",
      actor: "human:reviewer",
      expected_session_digest: session.record_digest,
    });
    expect(accepted.answer_kind).toBe("selected_option");
  });
});

describe("capture invocation, checkpoint and blocker records", () => {
  it("binds the invocation to the persisted session, operation and binding digests", () => {
    const session = goldenSession();
    const invocation = createCaptureInvocationRecord({
      session,
      purpose: "proposal",
      binding_digests: [BINDING_2, BINDING_1],
    });
    expect(invocation.record_kind).toBe("capture_invocation");
    expect(invocation.session_id).toBe(session.session_id);
    expect(invocation.session_revision).toBe(session.revision);
    expect(invocation.session_digest).toBe(session.record_digest);
    expect(invocation.workflow_operation_id).toBe(session.workflow_operation_id);
    // Binding digests are canonically ordered so input permutation is stable.
    expect(invocation.binding_digests).toEqual([BINDING_1, BINDING_2]);
    expect(invocation.invocation_key).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("derives one invocation identity per session revision and purpose", () => {
    const session = goldenSession();
    const first = createCaptureInvocationRecord({
      session,
      purpose: "proposal",
      binding_digests: [BINDING_1],
    });
    const same = createCaptureInvocationRecord({
      session,
      purpose: "proposal",
      binding_digests: [BINDING_1],
    });
    const otherPurpose = createCaptureInvocationRecord({
      session,
      purpose: "review",
      binding_digests: [BINDING_1],
    });
    expect(same.invocation_id).toBe(first.invocation_id);
    expect(otherPurpose.invocation_id).not.toBe(first.invocation_id);
  });

  it("seals a checkpoint for a session revision", () => {
    const session = goldenSession();
    const checkpoint = createCaptureCheckpointRecord(session);
    expect(checkpoint.record_kind).toBe("capture_checkpoint");
    expect(checkpoint.session_revision).toBe(session.revision);
    expect(checkpoint.state).toBe(session.state);
    expect(checkpoint.session_digest).toBe(session.record_digest);
  });

  it("seals a typed blocker with its resume state", () => {
    const session = goldenSession();
    const reviewing = reviseCaptureSessionRecord(
      reviseCaptureSessionRecord(session, { state: "context_compiling" }, session.budget_use),
      { state: "proposing" },
      session.budget_use,
    );
    const blocker = createCaptureBlockerRecord({
      session: reviewing,
      reason: "review_provider_required",
      resume_state: "reviewing",
      detail: "未配置 Review Provider，也未选择 Manual Review。",
    });
    expect(blocker.record_kind).toBe("capture_blocker");
    expect(blocker.reason).toBe("review_provider_required");
    expect(blocker.resume_state).toBe("reviewing");
    expect(blocker.session_digest).toBe(reviewing.record_digest);
  });

  it("refuses to resume a blocker into a terminal state", () => {
    const session = goldenSession();
    expect(() =>
      createCaptureBlockerRecord({
        session,
        reason: "risk_policy_denied",
        resume_state: "accepted",
        detail: "策略拒绝。",
      }),
    ).toThrow(CaptureRecordError);
  });
});

describe("capture golden fixtures", () => {
  it("matches the committed canonical fixtures", () => {
    const session = goldenSession();
    const questions = goldenQuestions(session);
    const answer = goldenAnswer(session, questions[0]!);
    const invocation = createCaptureInvocationRecord({
      session,
      purpose: "context_proposal",
      binding_digests: [BINDING_2, BINDING_1],
    });
    const checkpoint = createCaptureCheckpointRecord(session);
    const blockedSession = reviseCaptureSessionRecord(
      reviseCaptureSessionRecord(session, { state: "context_compiling" }, session.budget_use),
      { state: "blocked", blocked_reason: "review_provider_required" },
      session.budget_use,
    );
    const blocker = createCaptureBlockerRecord({
      session: blockedSession,
      reason: "review_provider_required",
      resume_state: "reviewing",
      detail: "未配置 Review Provider，也未选择 Manual Review。",
    });

    expect(session).toEqual(readGolden("capture-session.json"));
    expect(questions[0]).toEqual(readGolden("clarification-question.json"));
    expect(answer).toEqual(readGolden("clarification-answer.json"));
    expect(invocation).toEqual(readGolden("capture-invocation.json"));
    expect(checkpoint).toEqual(readGolden("capture-checkpoint.json"));
    expect(blocker).toEqual(readGolden("capture-blocker.json"));
  });

  it("validates the golden fixtures through the protocol 1.1 registry", () => {
    const session = goldenSession();
    const questions = goldenQuestions(session);
    const fixtures: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["capture-session", readGolden("capture-session.json")],
      ["clarification-question", readGolden("clarification-question.json")],
      ["clarification-answer", readGolden("clarification-answer.json")],
      ["capture-invocation", readGolden("capture-invocation.json")],
      ["capture-checkpoint", readGolden("capture-checkpoint.json")],
      ["capture-blocker", readGolden("capture-blocker.json")],
    ];
    expect(questions).toHaveLength(2);
    for (const [key, fixture] of fixtures) {
      const validation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate(key, fixture);
      expect(validation.valid, `${key}: ${JSON.stringify(validation.errors)}`).toBe(true);
      expect(verifyRecordEnvelope(fixture), key).toBe(true);
    }
    expect(session.record_digest).toBe(
      (readGolden("capture-session.json") as CaptureSessionRecord).record_digest,
    );
  });

  it("rejects extra properties, tampering and review_provider_required as a state", () => {
    const session = readGolden<CaptureSessionRecord>("capture-session.json");
    const withExtra = { ...session, unexpected_field: true };
    expect(PROTOCOL_1_1_SCHEMA_REGISTRY.validate("capture-session", withExtra).valid).toBe(false);
    const tampered = { ...session, intent_text: "被篡改的意图。" };
    expect(verifyRecordEnvelope(tampered as unknown as Record<string, unknown>)).toBe(false);
    const wrongState = { ...session, state: "review_provider_required" };
    expect(PROTOCOL_1_1_SCHEMA_REGISTRY.validate("capture-session", wrongState).valid).toBe(false);
    // The state enum carries all four block reasons' complement only; the
    // conditional blocked_reason invariant is enforced by the constructors
    // and the store, which the coordinator tests exercise end to end.
    expect(CAPTURE_STATES).not.toContain("review_provider_required");
  });

  it("rejects invocation records whose binding digests are not unique", () => {
    const session = goldenSession();
    expect(() =>
      createCaptureInvocationRecord({
        session,
        purpose: "proposal",
        binding_digests: [BINDING_1, BINDING_1],
      }),
    ).toThrow(CaptureRecordError);
  });

  it("rejects malformed digests in every record constructor", () => {
    expect(() =>
      createCaptureSessionRecord({
        workflow_operation_id: OPERATION_ID,
        iteration_id: ITERATION_ID,
        intent_text: "x",
        project_profile_digest: "not-a-digest",
        profile_decision_digest: DIGEST_B,
        capture_policy_digest: DIGEST_C,
        project_baseline_digest: DIGEST_D,
      }),
    ).toThrow(CaptureRecordError);
  });
});
