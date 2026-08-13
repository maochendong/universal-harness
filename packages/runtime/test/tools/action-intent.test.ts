import { describe, expect, it } from "vitest";

import { contentDigest } from "@universal-harness-internal/core";

import {
  ActionIntentJournal,
  isActionIntentRecord,
  requestDigest,
} from "../../src/tools/action-intent.js";
import { ToolError } from "../../src/tools/definition.js";
import { isWorkingState, type WorkingState } from "../../src/workflow/working-state.js";

/**
 * External Action Intent journal (design 13.5, 15.2): intents open pending
 * before the side effect, close completed or uncertain, and only uncertain
 * intents may complete later through reconciliation. The working-state
 * projection is what checkpoints persist for resume.
 */
const OPEN_INPUT = {
  intent_id: "intent_01",
  tool: "issue_comment@1.0.0",
  request_digest: contentDigest({ body: "hello" }),
  resource: "issue:42",
  approval_digest: "a".repeat(64),
  idempotency_key: "op-1",
} as const;

describe("ActionIntentJournal", () => {
  it("opens pending intents and closes them completed or uncertain", () => {
    const journal = new ActionIntentJournal();
    const opened = journal.open(OPEN_INPUT);
    expect(opened.status).toBe("pending");
    const completed = journal.complete(opened, contentDigest({ status: "ok" }));
    expect(completed.status).toBe("completed");
    expect(completed.result_digest).toMatch(/^[a-f0-9]{64}$/u);

    const uncertain = journal.open({
      ...OPEN_INPUT,
      intent_id: "intent_02",
      idempotency_key: "op-2",
    });
    const marked = journal.markUncertain(uncertain);
    expect(marked.status).toBe("uncertain");
    expect(marked.result_digest).toBeNull();
    expect(journal.unresolved().map((intent) => intent.intent_id)).toEqual(["intent_02"]);
  });

  it("refuses illegal transitions", () => {
    const journal = new ActionIntentJournal();
    const opened = journal.open(OPEN_INPUT);
    const completed = journal.complete(opened, contentDigest(null));
    expect(() => journal.complete(completed, contentDigest(null))).toThrowError(ToolError);
    expect(() => journal.markUncertain(completed)).toThrowError(ToolError);
    expect(() => journal.open(OPEN_INPUT)).toThrowError(ToolError);
  });

  it("finds intents by idempotency key in deterministic order", () => {
    const journal = new ActionIntentJournal();
    journal.open({ ...OPEN_INPUT, intent_id: "intent_b", idempotency_key: "op-b" });
    journal.open({ ...OPEN_INPUT, intent_id: "intent_a", idempotency_key: "op-a" });
    expect(journal.all().map((intent) => intent.intent_id)).toEqual(["intent_a", "intent_b"]);
    expect(journal.findByIdempotencyKey("issue_comment@1.0.0", "op-b")?.intent_id).toBe("intent_b");
    expect(journal.findByIdempotencyKey("issue_comment@1.0.0", "missing")).toBeUndefined();
  });

  it("restores from checkpointed records and validates their shape", () => {
    const journal = new ActionIntentJournal();
    journal.open(OPEN_INPUT);
    const restored = ActionIntentJournal.restore(journal.all());
    expect(restored.all()).toEqual(journal.all());
    expect(isActionIntentRecord(journal.all()[0])).toBe(true);
    expect(isActionIntentRecord({ intent_id: 1 })).toBe(false);
  });

  it("projects into WorkingState intents a checkpoint can persist", () => {
    const journal = new ActionIntentJournal();
    journal.open(OPEN_INPUT);
    const projection = journal.workingStateIntents();
    expect(projection).toEqual([
      {
        intent_id: "intent_01",
        tool: "issue_comment@1.0.0",
        request_digest: OPEN_INPUT.request_digest,
        idempotency_key: "op-1",
        status: "pending",
      },
    ]);
    const state = {
      goal: "goal",
      baseline_commit: "0123456789abcdef",
      requirement_baseline_digest: "b".repeat(64),
      policy_digest: "c".repeat(64),
      phase: "implementation",
      confirmed_facts: [],
      rejected_hypotheses: [],
      open_questions: [],
      blockers: [],
      completed_task_ids: [],
      pending_task_ids: [],
      budget: { used_steps: 0, used_tokens: 0, ceiling_steps: 1, ceiling_tokens: 1 },
      capability_grants: [],
      approval_digests: [],
      input_digests: [],
      external_action_intents: projection,
    } satisfies WorkingState;
    expect(isWorkingState(state)).toBe(true);
  });

  it("computes stable request digests over normalized requests", () => {
    const first = requestDigest("tool@1.0.0", { b: 1, a: "x" }, undefined);
    const second = requestDigest("tool@1.0.0", { a: "x", b: 1 }, undefined);
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
  });
});
