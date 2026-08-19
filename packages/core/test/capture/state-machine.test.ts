import { describe, expect, it } from "vitest";

import {
  CAPTURE_BLOCK_REASONS,
  CAPTURE_STATES,
  type CaptureBlockReason,
  type CaptureState,
} from "../../src/schema/capture.js";
import {
  CAPTURE_LEGAL_TRANSITIONS,
  CaptureStateInvariantError,
  CaptureTransitionError,
  assertCaptureStateFields,
  assertCaptureTransition,
  isCaptureBlockReason,
  isCaptureState,
  isLegalCaptureTransition,
  isTerminalCaptureState,
} from "../../src/capture/states.js";

/**
 * The capture internal state machine (intent-to-prd design 7). Fifteen
 * lifecycle states; every legal edge is enumerated here and the matrix test
 * pins both the legal and the illegal directions.
 */
const EXPECTED_TRANSITIONS: Readonly<Record<CaptureState, readonly CaptureState[]>> = {
  intent_received: ["context_compiling", "cancelled"],
  context_compiling: ["proposing", "reviewing", "blocked", "cancelled"],
  proposing: ["validating", "clarification_required", "blocked", "cancelled"],
  validating: ["clarification_required", "revision_required", "context_compiling", "cancelled"],
  clarification_required: ["context_compiling", "blocked", "cancelled"],
  reviewing: [
    "review_input_required",
    "clarification_required",
    "revision_required",
    "blocked",
    "risk_assessing",
    "cancelled",
  ],
  review_input_required: ["reviewing", "cancelled"],
  risk_assessing: ["blocked", "profile_decision_required", "approval_required", "cancelled"],
  revision_required: ["context_compiling", "cancelled"],
  profile_decision_required: ["context_compiling", "cancelled"],
  approval_required: ["accepted", "revision_required", "approval_deferred", "cancelled"],
  approval_deferred: ["approval_required", "cancelled"],
  accepted: [],
  blocked: [
    "context_compiling",
    "proposing",
    "clarification_required",
    "reviewing",
    "review_input_required",
    "risk_assessing",
    "revision_required",
    "profile_decision_required",
    "approval_required",
    "cancelled",
  ],
  cancelled: [],
};

describe("capture state vocabulary", () => {
  it("defines exactly the fifteen lifecycle states of the design", () => {
    expect([...CAPTURE_STATES].sort()).toEqual(
      [
        "accepted",
        "approval_deferred",
        "approval_required",
        "blocked",
        "cancelled",
        "clarification_required",
        "context_compiling",
        "intent_received",
        "profile_decision_required",
        "proposing",
        "review_input_required",
        "reviewing",
        "revision_required",
        "risk_assessing",
        "validating",
      ].sort(),
    );
  });

  it("defines exactly the four typed block reasons", () => {
    expect([...CAPTURE_BLOCK_REASONS].sort()).toEqual(
      [
        "capture_budget_exhausted",
        "review_blocked",
        "review_provider_required",
        "risk_policy_denied",
      ].sort(),
    );
  });

  it("never accepts review_provider_required as a lifecycle state", () => {
    expect(isCaptureState("review_provider_required")).toBe(false);
    expect(isCaptureState("blocked")).toBe(true);
    expect(isCaptureBlockReason("review_provider_required")).toBe(true);
    expect(isCaptureBlockReason("blocked")).toBe(false);
  });
});

describe("capture transition matrix", () => {
  it("matches the registered legal transitions exactly", () => {
    for (const from of CAPTURE_STATES) {
      expect(
        [...(CAPTURE_LEGAL_TRANSITIONS[from] ?? [])].sort(),
        `transitions from ${from}`,
      ).toEqual([...EXPECTED_TRANSITIONS[from]].sort());
    }
  });

  it("classifies every ordered state pair as legal or illegal", () => {
    for (const from of CAPTURE_STATES) {
      for (const to of CAPTURE_STATES) {
        const expected = EXPECTED_TRANSITIONS[from].includes(to);
        expect(isLegalCaptureTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it("grants no exit from terminal states", () => {
    expect(isTerminalCaptureState("accepted")).toBe(true);
    expect(isTerminalCaptureState("cancelled")).toBe(true);
    for (const terminal of ["accepted", "cancelled"] as const) {
      for (const to of CAPTURE_STATES) {
        expect(isLegalCaptureTransition(terminal, to), `${terminal} -> ${to}`).toBe(false);
      }
    }
  });

  it("allows cancellation from every non-terminal state", () => {
    for (const from of CAPTURE_STATES) {
      expect(isLegalCaptureTransition(from, "cancelled"), `${from} -> cancelled`).toBe(
        !isTerminalCaptureState(from),
      );
    }
  });

  it("fails closed on unknown states", () => {
    expect(() =>
      assertCaptureTransition("review_provider_required" as CaptureState, "blocked"),
    ).toThrow(CaptureTransitionError);
    expect(() =>
      assertCaptureTransition("proposing", "review_provider_required" as CaptureState),
    ).toThrow(CaptureTransitionError);
    expect(() => assertCaptureTransition("proposing", "accepted")).toThrow(CaptureTransitionError);
  });
});

describe("blocked reason invariants", () => {
  function expectInvariantError(fn: () => void, kind: string): void {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(CaptureStateInvariantError);
      expect((error as CaptureStateInvariantError).kind).toBe(kind);
      return;
    }
    throw new Error(`expected CaptureStateInvariantError(${kind})`);
  }

  it("requires blocked_reason if and only if the state is blocked", () => {
    expect(() => assertCaptureStateFields("blocked", "review_provider_required")).not.toThrow();
    expectInvariantError(
      () => assertCaptureStateFields("blocked", undefined),
      "missing_blocked_reason",
    );
    for (const state of CAPTURE_STATES) {
      if (state === "blocked") continue;
      expect(() => assertCaptureStateFields(state, undefined), state).not.toThrow();
      expectInvariantError(
        () => assertCaptureStateFields(state, "review_blocked"),
        "unexpected_blocked_reason",
      );
    }
  });

  it("rejects unknown block reasons", () => {
    expectInvariantError(
      () => assertCaptureStateFields("blocked", "provider_sick" as CaptureBlockReason),
      "unknown_blocked_reason",
    );
  });
});
