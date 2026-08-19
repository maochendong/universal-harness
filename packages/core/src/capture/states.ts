import {
  CAPTURE_BLOCK_REASONS,
  CAPTURE_STATES,
  type CaptureBlockReason,
  type CaptureState,
} from "../schema/capture.js";

/**
 * Capture internal state machine (intent-to-prd design 7). The Coordinator is
 * the only writer of these transitions; the table below is the complete legal
 * edge set and anything outside it fails closed. `review_provider_required`
 * is a typed block reason, never a lifecycle state; `blocked_reason` must be
 * present exactly while the session is `blocked`.
 */
export class CaptureTransitionError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "CaptureTransitionError";
    this.kind = kind;
  }
}

export class CaptureStateInvariantError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "CaptureStateInvariantError";
    this.kind = kind;
  }
}

export function isCaptureState(value: string): value is CaptureState {
  return (CAPTURE_STATES as readonly string[]).includes(value);
}

export function isCaptureBlockReason(value: string): value is CaptureBlockReason {
  return (CAPTURE_BLOCK_REASONS as readonly string[]).includes(value);
}

export function isTerminalCaptureState(state: CaptureState): boolean {
  return state === "accepted" || state === "cancelled";
}

/**
 * Resume targets of a blocked session: the pipeline re-enters where the
 * blocker interrupted it. `intent_received` is unreachable (blocking happens
 * only after the session starts processing) and `blocked` itself is not a
 * resume target; terminal states stay terminal.
 */
const BLOCKED_RESUME_TARGETS: readonly CaptureState[] = [
  "context_compiling",
  "proposing",
  "clarification_required",
  "reviewing",
  "review_input_required",
  "risk_assessing",
  "revision_required",
  "profile_decision_required",
  "approval_required",
];

export const CAPTURE_LEGAL_TRANSITIONS: Readonly<Record<CaptureState, readonly CaptureState[]>> = {
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
  blocked: [...BLOCKED_RESUME_TARGETS, "cancelled"],
  cancelled: [],
};

export function isLegalCaptureTransition(from: CaptureState, to: CaptureState): boolean {
  return (CAPTURE_LEGAL_TRANSITIONS[from] ?? []).includes(to);
}

/** Fail-closed guard used by the Coordinator before persisting any transition. */
export function assertCaptureTransition(from: CaptureState, to: CaptureState): void {
  if (!isCaptureState(from) || !isCaptureState(to)) {
    throw new CaptureTransitionError(
      "unknown_state",
      `capture transition references unknown state: ${String(from)} -> ${String(to)}`,
    );
  }
  if (!isLegalCaptureTransition(from, to)) {
    throw new CaptureTransitionError(
      "invalid_transition",
      `illegal capture transition: ${from} -> ${to}`,
    );
  }
}

/**
 * The conditional invariant the JSON Schema cannot express: `blocked_reason`
 * is required exactly in the `blocked` state and forbidden everywhere else.
 */
export function assertCaptureStateFields(
  state: CaptureState,
  blockedReason: CaptureBlockReason | undefined,
): void {
  if (blockedReason !== undefined && !isCaptureBlockReason(blockedReason)) {
    throw new CaptureStateInvariantError(
      "unknown_blocked_reason",
      `unknown capture block reason: ${String(blockedReason)}`,
    );
  }
  if (state === "blocked" && blockedReason === undefined) {
    throw new CaptureStateInvariantError(
      "missing_blocked_reason",
      "a blocked capture session must carry a typed blocked_reason",
    );
  }
  if (state !== "blocked" && blockedReason !== undefined) {
    throw new CaptureStateInvariantError(
      "unexpected_blocked_reason",
      `blocked_reason is only legal in the blocked state, not ${state}`,
    );
  }
}
