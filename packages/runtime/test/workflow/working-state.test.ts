import { describe, expect, it } from "vitest";

import {
  WorkingStateError,
  applyWorkingStateProposal,
  isWorkingState,
  workingStateDigest,
  type WorkingState,
} from "../../src/index.js";
import {
  assertWorkingStateWriter,
  createWorkingStateWriter,
  type WorkingStateWriter,
} from "../../src/workflow/working-state.js";
import { REQUIREMENT_DIGEST, POLICY_DIGEST, BASELINE } from "./helpers.js";

function baseState(): WorkingState {
  return {
    goal: "ship the demo feature",
    baseline_commit: BASELINE,
    requirement_baseline_digest: REQUIREMENT_DIGEST,
    policy_digest: POLICY_DIGEST,
    phase: "execution",
    confirmed_facts: [],
    rejected_hypotheses: [],
    open_questions: [],
    blockers: [],
    completed_task_ids: [],
    pending_task_ids: ["task_alpha", "task_beta"],
    budget: { used_steps: 1, used_tokens: 100, ceiling_steps: 10, ceiling_tokens: 1000 },
    capability_grants: [],
    approval_digests: [],
    input_digests: [],
    external_action_intents: [],
  };
}

describe("typed WorkingState proposals", () => {
  it("applies additions deterministically and deduplicates", () => {
    const state = baseState();
    const next = applyWorkingStateProposal(state, {
      add_confirmed_facts: [
        { fact: "schema frozen", evidence_id: "evidence_01" },
        { fact: "schema frozen", evidence_id: "evidence_01" },
      ],
      add_blockers: ["waiting on approval", "waiting on approval"],
      set_next_action: "collect approval",
    });
    expect(next.confirmed_facts).toEqual([{ fact: "schema frozen", evidence_id: "evidence_01" }]);
    expect(next.blockers).toEqual(["waiting on approval"]);
    expect(next.next_action).toBe("collect approval");
    // The input state is never mutated.
    expect(state.confirmed_facts).toEqual([]);
    expect(state.blockers).toEqual([]);
  });

  it("moves completed tasks out of pending exactly once", () => {
    const next = applyWorkingStateProposal(baseState(), {
      complete_task_ids: ["task_alpha"],
      add_pending_task_ids: ["task_alpha", "task_gamma"],
    });
    expect(next.completed_task_ids).toEqual(["task_alpha"]);
    expect(next.pending_task_ids).toEqual(["task_beta", "task_gamma"]);
  });

  it("accumulates budget use and enforces the ceiling", () => {
    const next = applyWorkingStateProposal(baseState(), {
      budget_use: { used_steps: 2, used_tokens: 50 },
    });
    expect(next.budget).toEqual({
      used_steps: 3,
      used_tokens: 150,
      ceiling_steps: 10,
      ceiling_tokens: 1000,
    });
    expect(() =>
      applyWorkingStateProposal(baseState(), { budget_use: { used_steps: 10 } }),
    ).toThrowError(WorkingStateError);
  });

  it("upserts external action intents by intent id", () => {
    const intent = {
      intent_id: "intent_01",
      tool: "git",
      request_digest: "c".repeat(64),
      idempotency_key: "key-01",
      status: "pending" as const,
    };
    const pending = applyWorkingStateProposal(baseState(), {
      upsert_external_action_intents: [intent],
    });
    const completed = applyWorkingStateProposal(pending, {
      upsert_external_action_intents: [{ ...intent, status: "completed" as const }],
    });
    expect(completed.external_action_intents).toEqual([{ ...intent, status: "completed" }]);
  });

  it("persists task-local context bundle digests without collapsing them", () => {
    const digests = {
      task_alpha: "a".repeat(64),
      task_beta: "b".repeat(64),
      task_gamma: "c".repeat(64),
    };
    const next = applyWorkingStateProposal(baseState(), {
      set_context_bundle_digest: digests.task_gamma,
      set_context_bundle_digests: digests,
    });
    expect(next.context_bundle_digests).toEqual(digests);
    expect(next.context_bundle_digest).toBe(digests.task_gamma);
    expect(isWorkingState(next)).toBe(true);
    expect(
      isWorkingState({ ...next, context_bundle_digests: { task_alpha: "not-a-digest" } }),
    ).toBe(false);
  });
});

describe("WorkingState writer discipline", () => {
  it("accepts only engine-issued writer tokens", () => {
    const writer = createWorkingStateWriter();
    expect(() => assertWorkingStateWriter(writer)).not.toThrow();
  });

  it("rejects forged writer tokens", () => {
    const forged = { role: "workflow-engine" } as WorkingStateWriter;
    expect(() => assertWorkingStateWriter(forged)).toThrowError(WorkingStateError);
    try {
      assertWorkingStateWriter(forged);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(WorkingStateError);
      expect((error as WorkingStateError).kind).toBe("working_state_writer_required");
    }
  });
});

describe("WorkingState digest and validation", () => {
  it("is stable for identical content and sensitive to changes", () => {
    const state = baseState();
    expect(workingStateDigest(state)).toBe(workingStateDigest(baseState()));
    expect(workingStateDigest({ ...state, phase: "verification" })).not.toBe(
      workingStateDigest(state),
    );
  });

  it("validates persisted shapes", () => {
    expect(isWorkingState(baseState())).toBe(true);
    expect(isWorkingState({ ...baseState(), goal: "" })).toBe(false);
    expect(isWorkingState({ ...baseState(), policy_digest: "not-a-digest" })).toBe(false);
    expect(isWorkingState({ ...baseState(), pending_task_ids: [42] })).toBe(false);
    expect(isWorkingState(null)).toBe(false);
  });
});
