import { describe, expect, it } from "vitest";

import {
  InvalidStateTransition,
  abortTargetFor,
  aggregateIterationState,
  blockTargetFor,
  canTransitionIteration,
  canTransitionOperation,
  iterationStateForOperationState,
  resumeTargetFor,
} from "../../src/index.js";

/**
 * Transition table fixtures (design section 10): the operation chain, the
 * repairing side state, blocked/resume_state, terminal states, and the
 * Operation -> Iteration mapping.
 */
describe("operation state transition table", () => {
  it("allows forward steps along the delivery chain", () => {
    expect(canTransitionOperation("created", "awaiting_input")).toBe(true);
    expect(canTransitionOperation("awaiting_input", "awaiting_approval")).toBe(true);
    expect(canTransitionOperation("awaiting_approval", "planned")).toBe(true);
    expect(canTransitionOperation("planned", "running")).toBe(true);
    expect(canTransitionOperation("running", "verifying")).toBe(true);
    expect(canTransitionOperation("verifying", "completed")).toBe(true);
  });

  it("allows skipping intake states for structured intents", () => {
    expect(canTransitionOperation("created", "planned")).toBe(true);
    expect(canTransitionOperation("awaiting_input", "planned")).toBe(true);
  });

  it("routes repair work through the repairing side state", () => {
    expect(canTransitionOperation("running", "repairing")).toBe(true);
    expect(canTransitionOperation("verifying", "repairing")).toBe(true);
    expect(canTransitionOperation("repairing", "running")).toBe(true);
    expect(canTransitionOperation("repairing", "verifying")).toBe(false);
    expect(canTransitionOperation("repairing", "completed")).toBe(false);
  });

  it("rejects backward, self and skipping-completion moves", () => {
    expect(canTransitionOperation("running", "planned")).toBe(false);
    expect(canTransitionOperation("running", "running")).toBe(false);
    expect(canTransitionOperation("running", "completed")).toBe(false);
    expect(canTransitionOperation("created", "completed")).toBe(false);
    expect(canTransitionOperation("created", "repairing")).toBe(false);
  });

  it("closes terminal states", () => {
    for (const from of ["completed", "aborted"] as const) {
      expect(canTransitionOperation(from, "running")).toBe(false);
      expect(canTransitionOperation(from, "blocked")).toBe(false);
      expect(canTransitionOperation(from, "aborted")).toBe(false);
    }
  });

  it("never leaves blocked except through resumeTargetFor", () => {
    expect(canTransitionOperation("blocked", "running")).toBe(false);
    expect(canTransitionOperation("blocked", "aborted")).toBe(false);
  });
});

describe("blocked and aborted targets", () => {
  it("saves resume_state on a recoverable failure", () => {
    expect(blockTargetFor("running", "transient_environment_failure")).toEqual({
      state: "blocked",
      resume_state: "running",
    });
    expect(blockTargetFor("awaiting_approval", "awaiting_approval")).toEqual({
      state: "blocked",
      resume_state: "awaiting_approval",
    });
  });

  it("refuses to block terminal or already blocked states", () => {
    expect(() => blockTargetFor("completed", "git_drift")).toThrow(InvalidStateTransition);
    expect(() => blockTargetFor("aborted", "git_drift")).toThrow(InvalidStateTransition);
    expect(() => blockTargetFor("blocked", "git_drift")).toThrow(InvalidStateTransition);
  });

  it("resumes exactly into the saved resume_state", () => {
    expect(resumeTargetFor("blocked", "verifying")).toBe("verifying");
    expect(() => resumeTargetFor("running", "running")).toThrow(InvalidStateTransition);
    expect(() => resumeTargetFor("blocked", undefined)).toThrow(InvalidStateTransition);
  });

  it("aborts only on explicit cancellation or typed unrecoverable reasons", () => {
    expect(abortTargetFor("running", "user_cancellation")).toBe("aborted");
    expect(abortTargetFor("planned", "policy_violation")).toBe("aborted");
    expect(abortTargetFor("verifying", "schema_validation_failure")).toBe("aborted");
    expect(() => abortTargetFor("completed", "user_cancellation")).toThrow(InvalidStateTransition);
    expect(() => abortTargetFor("running", "timeout" as never)).toThrow(InvalidStateTransition);
  });
});

describe("iteration state transitions", () => {
  it("follows the delivery lifecycle", () => {
    expect(canTransitionIteration("draft", "planned")).toBe(true);
    expect(canTransitionIteration("planned", "running")).toBe(true);
    expect(canTransitionIteration("running", "verifying")).toBe(true);
    expect(canTransitionIteration("verifying", "completed")).toBe(true);
    expect(canTransitionIteration("running", "completed")).toBe(false);
    expect(canTransitionIteration("completed", "running")).toBe(false);
  });

  it("blocks and resumes back into a delivery state", () => {
    expect(canTransitionIteration("running", "blocked")).toBe(true);
    expect(canTransitionIteration("blocked", "running")).toBe(true);
    expect(canTransitionIteration("blocked", "verifying")).toBe(true);
    expect(canTransitionIteration("blocked", "completed")).toBe(false);
    expect(canTransitionIteration("verifying", "aborted")).toBe(true);
    expect(canTransitionIteration("aborted", "draft")).toBe(false);
  });
});

describe("operation to iteration mapping", () => {
  it("matches the design mapping table", () => {
    expect(iterationStateForOperationState("created")).toBe("draft");
    expect(iterationStateForOperationState("awaiting_input")).toBe("draft");
    expect(iterationStateForOperationState("awaiting_approval")).toBe("draft");
    expect(iterationStateForOperationState("planned")).toBe("planned");
    expect(iterationStateForOperationState("running")).toBe("running");
    expect(iterationStateForOperationState("repairing")).toBe("running");
    expect(iterationStateForOperationState("verifying")).toBe("verifying");
    expect(iterationStateForOperationState("blocked")).toBe("blocked");
    expect(iterationStateForOperationState("completed")).toBe("completed");
    expect(iterationStateForOperationState("aborted")).toBe("aborted");
  });

  it("aggregates operation states deterministically", () => {
    expect(aggregateIterationState([])).toBe("draft");
    expect(aggregateIterationState(["completed", "completed"])).toBe("completed");
    expect(aggregateIterationState(["completed", "running"])).toBe("running");
    expect(aggregateIterationState(["running", "blocked"])).toBe("blocked");
    expect(aggregateIterationState(["blocked", "aborted"])).toBe("blocked");
    expect(aggregateIterationState(["aborted"])).toBe("aborted");
    expect(aggregateIterationState(["created", "planned"])).toBe("planned");
    expect(aggregateIterationState(["planned", "verifying"])).toBe("verifying");
  });
});
