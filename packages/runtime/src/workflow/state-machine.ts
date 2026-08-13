import {
  RESUMABLE_OPERATION_STATES,
  iterationStateForOperation,
  type IterationState,
  type OperationState,
} from "@universal-harness-internal/core";

/**
 * Workflow state machine (design section 10). Pure and total: no I/O, no
 * clocks. The engine persists the records these functions authorize; nothing
 * here mutates ledger state.
 *
 * Operation State chain (design 10):
 *
 * ```text
 * created -> awaiting_input -> awaiting_approval -> planned -> running -> verifying -> completed
 *                                                                  |
 *                                                                  v
 *                                                             repairing -> running
 * any nonterminal state -> blocked -> resume_state
 * any nonterminal state -> aborted (explicit cancel or typed unrecoverable reason only)
 * ```
 */
export type ResumableOperationState = (typeof RESUMABLE_OPERATION_STATES)[number];

/** Typed recoverable conditions that produce a `blocked` snapshot (design 10.3). */
export const RECOVERABLE_BLOCK_REASONS = [
  "missing_input",
  "awaiting_approval",
  "stale_evidence",
  "uncertain_external_action",
  "repairable_gate_failure",
  "budget_ceiling",
  "transient_environment_failure",
  "git_drift",
] as const;

export type RecoverableBlockReason = (typeof RECOVERABLE_BLOCK_REASONS)[number];

/**
 * Only an explicit user cancellation or a typed unrecoverable reason may
 * produce the terminal `aborted` state; interruption, EOF, timeout or a
 * single tool failure never escalate to `aborted` on their own.
 */
export const UNRECOVERABLE_ABORT_REASONS = [
  "policy_violation",
  "schema_validation_failure",
] as const;

export type AbortReason = "user_cancellation" | (typeof UNRECOVERABLE_ABORT_REASONS)[number];

export const ABORT_REASONS: readonly AbortReason[] = [
  "user_cancellation",
  ...UNRECOVERABLE_ABORT_REASONS,
];

export class InvalidStateTransition extends Error {
  readonly kind = "invalid_state_transition" as const;

  constructor(message: string) {
    super(message);
    this.name = "InvalidStateTransition";
  }
}

export function isTerminalOperationState(state: OperationState): state is "completed" | "aborted" {
  return state === "completed" || state === "aborted";
}

export function isResumableOperationState(state: OperationState): state is ResumableOperationState {
  return (RESUMABLE_OPERATION_STATES as readonly OperationState[]).includes(state);
}

/** Forward delivery chain; `repairing` is a side state off running/verifying. */
const OPERATION_CHAIN: readonly OperationState[] = [
  "created",
  "awaiting_input",
  "awaiting_approval",
  "planned",
  "running",
  "verifying",
  "completed",
];

/**
 * Whether an Operation State transition is legal. `blocked` is never a
 * direct target here — blocking must go through `blockTargetFor` so the
 * `resume_state` is always saved; likewise a blocked operation can only move
 * through `resumeTargetFor`.
 */
export function canTransitionOperation(from: OperationState, to: OperationState): boolean {
  if (from === to || isTerminalOperationState(from) || from === "blocked") return false;
  if (to === "blocked" || to === "aborted") return true;
  if (from === "repairing") return to === "running";
  if (to === "repairing") return from === "running" || from === "verifying";
  if (to === "completed") return from === "verifying";
  const fromIndex = OPERATION_CHAIN.indexOf(from);
  const toIndex = OPERATION_CHAIN.indexOf(to);
  return fromIndex >= 0 && toIndex > fromIndex;
}

export function assertOperationTransition(from: OperationState, to: OperationState): void {
  if (!canTransitionOperation(from, to)) {
    throw new InvalidStateTransition(`illegal operation transition: ${from} -> ${to}`);
  }
}

export interface BlockedOperationTarget {
  readonly state: "blocked";
  readonly resume_state: ResumableOperationState;
}

/** Recoverable failure -> `blocked`, saving the state to resume into. */
export function blockTargetFor(
  current: OperationState,
  reason: RecoverableBlockReason,
): BlockedOperationTarget {
  if (!(RECOVERABLE_BLOCK_REASONS as readonly string[]).includes(reason)) {
    throw new InvalidStateTransition(`unknown recoverable block reason: ${JSON.stringify(reason)}`);
  }
  if (!isResumableOperationState(current)) {
    throw new InvalidStateTransition(
      `cannot block operation in state ${current}; only nonterminal resumable states produce a blocked snapshot`,
    );
  }
  return { state: "blocked", resume_state: current };
}

/** `blocked` resumes exactly into its saved `resume_state`. */
export function resumeTargetFor(
  current: OperationState,
  resumeState: ResumableOperationState | undefined,
): ResumableOperationState {
  if (current !== "blocked" || resumeState === undefined) {
    throw new InvalidStateTransition(
      `cannot resume operation in state ${current}; only a blocked operation with a saved resume_state can resume`,
    );
  }
  return resumeState;
}

/** Explicit cancellation or typed unrecoverable reason -> terminal `aborted`. */
export function abortTargetFor(current: OperationState, reason: AbortReason): "aborted" {
  if (!(ABORT_REASONS as readonly string[]).includes(reason)) {
    throw new InvalidStateTransition(`unknown abort reason: ${JSON.stringify(reason)}`);
  }
  if (isTerminalOperationState(current)) {
    throw new InvalidStateTransition(`cannot abort operation in terminal state ${current}`);
  }
  return "aborted";
}

export function isTerminalIterationState(state: IterationState): state is "completed" | "aborted" {
  return state === "completed" || state === "aborted";
}

const ITERATION_CHAIN: readonly IterationState[] = [
  "draft",
  "planned",
  "running",
  "verifying",
  "completed",
];

/**
 * Iteration State expresses the business delivery lifecycle only (design 10).
 * A blocked iteration resumes back into a delivery state, mirroring the
 * operation-level `resume_state` mapping.
 */
export function canTransitionIteration(from: IterationState, to: IterationState): boolean {
  if (from === to || isTerminalIterationState(from)) return false;
  if (to === "blocked" || to === "aborted") return true;
  if (from === "blocked") return to !== "completed";
  if (to === "completed") return from === "verifying";
  const fromIndex = ITERATION_CHAIN.indexOf(from);
  const toIndex = ITERATION_CHAIN.indexOf(to);
  return fromIndex >= 0 && toIndex > fromIndex;
}

export function assertIterationTransition(from: IterationState, to: IterationState): void {
  if (!canTransitionIteration(from, to)) {
    throw new InvalidStateTransition(`illegal iteration transition: ${from} -> ${to}`);
  }
}

/** Operation State -> Iteration State mapping (frozen in core schema). */
export function iterationStateForOperationState(state: OperationState): IterationState {
  return iterationStateForOperation(state);
}

const ITERATION_ACTIVE_ORDER: readonly IterationState[] = [
  "draft",
  "planned",
  "running",
  "verifying",
];

/**
 * Aggregate the Iteration State from the operation states of one iteration
 * (design 10 mapping table). Deterministic precedence: `completed` only when
 * every operation completed; a paused iteration reports `blocked`; an
 * aborted operation reports `aborted` unless another operation is paused;
 * otherwise the most advanced active delivery state wins. Agents never set
 * this directly.
 */
export function aggregateIterationState(states: readonly OperationState[]): IterationState {
  if (states.length === 0) return "draft";
  if (states.every((state) => state === "completed")) return "completed";
  if (states.some((state) => state === "blocked")) return "blocked";
  if (states.some((state) => state === "aborted")) return "aborted";
  let aggregate: IterationState = "draft";
  for (const state of states) {
    if (state === "completed") continue;
    const mapped = iterationStateForOperationState(state);
    if (ITERATION_ACTIVE_ORDER.indexOf(mapped) > ITERATION_ACTIVE_ORDER.indexOf(aggregate)) {
      aggregate = mapped;
    }
  }
  return aggregate;
}
