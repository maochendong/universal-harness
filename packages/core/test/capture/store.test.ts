import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createCaptureBlockerRecord,
  createCaptureCheckpointRecord,
  createCaptureInvocationRecord,
  createCaptureSessionRecord,
  createClarificationAnswerRecord,
  createClarificationQuestionRecords,
  reviseCaptureSessionRecord,
} from "../../src/capture/records.js";
import {
  CaptureStoreError,
  appendCaptureAnswerRecord,
  appendCaptureBlockerRecord,
  appendCaptureCheckpointRecord,
  appendCaptureInvocationRecord,
  appendCaptureQuestionRecord,
  appendCaptureSessionRecord,
  readCaptureAnswers,
  readCaptureBlockers,
  readCaptureCheckpoints,
  readCaptureInvocations,
  readCaptureQuestions,
  readCaptureSessionRevisions,
  readLatestCaptureSession,
} from "../../src/capture/store.js";
import { sealRecordEnvelope } from "../../src/schema/envelope.js";
import { harnessRootFor, resolveHarnessPath } from "../../src/ledger/layout.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const BINDING = "1".repeat(64);
const OPERATION_ID = "operation_01K1ABCDEFGHIJKLMNO";
const ITERATION_ID = "iteration_01K1ABCDEFGHIJKLMNO";

const createdRoots: string[] = [];

function expectStoreError(fn: () => void, kind: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CaptureStoreError);
    expect((error as CaptureStoreError).kind).toBe(kind);
    return;
  }
  throw new Error(`expected CaptureStoreError(${kind})`);
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-capture-store-"));
  createdRoots.push(root);
  return root;
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function sessionRecord() {
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

describe("capture session store", () => {
  it("appends revisions in order and reads them back", () => {
    const root = makeRoot();
    const revision1 = sessionRecord();
    expect(appendCaptureSessionRecord(root, revision1).appended).toBe(true);
    const revision2 = reviseCaptureSessionRecord(
      revision1,
      { state: "context_compiling" },
      revision1.budget_use,
    );
    expect(appendCaptureSessionRecord(root, revision2).appended).toBe(true);

    const revisions = readCaptureSessionRevisions(root, revision1.session_id);
    expect(revisions).toEqual([revision1, revision2]);
    expect(readLatestCaptureSession(root, revision1.session_id)).toEqual(revision2);
  });

  it("treats a byte-identical re-append as an idempotent no-op", () => {
    const root = makeRoot();
    const revision1 = sessionRecord();
    appendCaptureSessionRecord(root, revision1);
    expect(appendCaptureSessionRecord(root, revision1).appended).toBe(false);
    expect(readCaptureSessionRevisions(root, revision1.session_id)).toHaveLength(1);
  });

  it("fails closed on a divergent rewrite of a committed revision", () => {
    const root = makeRoot();
    const revision1 = sessionRecord();
    appendCaptureSessionRecord(root, revision1);
    const forged = { ...revision1, intent_text: "被篡改的意图。" };
    expect(() => appendCaptureSessionRecord(root, forged)).toThrow(CaptureStoreError);
    // The forged record also fails the envelope check before any path lookup.
    expect(readLatestCaptureSession(root, revision1.session_id)).toEqual(revision1);
  });

  it("rejects revision gaps so history never forks silently", () => {
    const root = makeRoot();
    const revision1 = sessionRecord();
    appendCaptureSessionRecord(root, revision1);
    const revision2 = reviseCaptureSessionRecord(
      revision1,
      { state: "context_compiling" },
      revision1.budget_use,
    );
    const revision3 = reviseCaptureSessionRecord(
      revision2,
      { state: "proposing" },
      revision2.budget_use,
    );
    expectStoreError(
      () => appendCaptureSessionRecord(root, revision3),
      "session_revision_conflict",
    );
  });

  it("rejects records that violate the blocked reason invariant", () => {
    const root = makeRoot();
    const revision1 = sessionRecord();
    const invalid = {
      ...revision1,
      revision: 2,
      state: "blocked",
      supersedes_digest: revision1.record_digest,
    };
    expect(() => appendCaptureSessionRecord(root, invalid as never)).toThrow(CaptureStoreError);
  });

  it("fails closed on corrupt committed bytes", () => {
    const root = makeRoot();
    const revision1 = sessionRecord();
    appendCaptureSessionRecord(root, revision1);
    const path = resolveHarnessPath(
      harnessRootFor(root),
      `artifacts/capture/sessions/${revision1.session_id}/1.json`,
    );
    writeFileSync(path, "{ not json", "utf8");
    expectStoreError(
      () => readCaptureSessionRevisions(root, revision1.session_id),
      "corrupt_record",
    );
  });
});

describe("capture artifact stores", () => {
  it("appends questions, answers, invocations, checkpoints and blockers idempotently", () => {
    const root = makeRoot();
    const session = sessionRecord();
    appendCaptureSessionRecord(root, session);

    const [question] = createClarificationQuestionRecords({
      session_id: session.session_id,
      round: 1,
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
    expect(appendCaptureQuestionRecord(root, question!).appended).toBe(true);
    expect(appendCaptureQuestionRecord(root, question!).appended).toBe(false);
    expect(readCaptureQuestions(root, session.session_id)).toEqual([question]);

    const answer = createClarificationAnswerRecord({
      session_id: session.session_id,
      question: question!,
      answer_kind: "free_text",
      value: "重复请求返回相同订单。",
      actor: "human:reviewer",
      expected_session_digest: session.record_digest,
    });
    expect(appendCaptureAnswerRecord(root, answer).appended).toBe(true);
    expect(appendCaptureAnswerRecord(root, answer).appended).toBe(false);
    expect(readCaptureAnswers(root, session.session_id)).toEqual([answer]);

    const invocation = createCaptureInvocationRecord({
      session,
      purpose: "proposal",
      binding_digests: [BINDING],
    });
    expect(appendCaptureInvocationRecord(root, invocation).appended).toBe(true);
    expect(appendCaptureInvocationRecord(root, invocation).appended).toBe(false);
    expect(readCaptureInvocations(root, session.session_id)).toEqual([invocation]);

    const checkpoint = createCaptureCheckpointRecord(session);
    expect(appendCaptureCheckpointRecord(root, checkpoint).appended).toBe(true);
    expect(readCaptureCheckpoints(root, session.session_id)).toEqual([checkpoint]);

    const blocker = createCaptureBlockerRecord({
      session,
      reason: "capture_budget_exhausted",
      resume_state: "proposing",
      detail: "澄清轮次耗尽。",
    });
    expect(appendCaptureBlockerRecord(root, blocker).appended).toBe(true);
    expect(readCaptureBlockers(root, session.session_id)).toEqual([blocker]);
  });

  it("conflicts when the same record identity is rewritten with different content", () => {
    const root = makeRoot();
    const session = sessionRecord();
    appendCaptureSessionRecord(root, session);
    const invocation = createCaptureInvocationRecord({
      session,
      purpose: "proposal",
      binding_digests: [BINDING],
    });
    appendCaptureInvocationRecord(root, invocation);
    // A properly sealed forgery: same identity, different content.
    const divergent = sealRecordEnvelope({
      ...invocation,
      binding_digests: [DIGEST_A],
    } as unknown as Record<string, unknown>);
    expectStoreError(
      () => appendCaptureInvocationRecord(root, divergent as never),
      "record_conflict",
    );
  });

  it("returns empty collections for unknown sessions", () => {
    const root = makeRoot();
    expect(readCaptureSessionRevisions(root, "capture-session_missing")).toEqual([]);
    expect(readLatestCaptureSession(root, "capture-session_missing")).toBeUndefined();
    expect(readCaptureQuestions(root, "capture-session_missing")).toEqual([]);
    expect(readCaptureAnswers(root, "capture-session_missing")).toEqual([]);
    expect(readCaptureInvocations(root, "capture-session_missing")).toEqual([]);
    expect(readCaptureCheckpoints(root, "capture-session_missing")).toEqual([]);
    expect(readCaptureBlockers(root, "capture-session_missing")).toEqual([]);
  });

  it("rejects tampered bytes on read", () => {
    const root = makeRoot();
    const session = sessionRecord();
    appendCaptureSessionRecord(root, session);
    const invocation = createCaptureInvocationRecord({
      session,
      purpose: "review",
      binding_digests: [BINDING],
    });
    appendCaptureInvocationRecord(root, invocation);
    const path = resolveHarnessPath(
      harnessRootFor(root),
      `artifacts/capture/invocations/${session.session_id}/${invocation.invocation_id}.json`,
    );
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    parsed["purpose"] = "proposal";
    writeFileSync(path, `${JSON.stringify(parsed)}\n`, "utf8");
    expect(() => readCaptureInvocations(root, session.session_id)).toThrow(CaptureStoreError);
  });
});
