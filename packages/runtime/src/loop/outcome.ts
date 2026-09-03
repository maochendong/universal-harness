import type { RUN_OUTCOMES, TerminationReason } from "@universal-harness-internal/core";

import { LoopError } from "./policy.js";

/**
 * Run outcome and termination (design 13.3, 10.2). Every terminated run ends
 * with exactly one outcome; the termination reason is recorded independently
 * and both live only on the terminal record. A model completion signal can
 * never produce `success` directly: it moves the run into `verifying`, and
 * only current mandatory evidence may produce the terminal `success`.
 * Partial output is appended separately as evidence/proposal records and is
 * never embedded in the terminal record (the run record schemas are strict,
 * so this is also enforced at the wire level).
 */
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export type { TerminationReason };

export const LOOP_RUN_PHASES = ["running", "verifying", "terminated"] as const;

export type LoopRunPhase = (typeof LOOP_RUN_PHASES)[number];

export interface TerminalDecision {
  readonly outcome: RunOutcome;
  readonly termination_reason: TerminationReason;
  readonly detail: string;
}

/**
 * Partial run output. On a non-success exit the controller returns these so
 * the caller can append them as separate evidence/proposal records before
 * the terminal record -- never inside it.
 */
export interface PartialOutput {
  readonly summary: string;
  readonly evidence_ids: readonly string[];
}

export function completionDecision(verified: boolean): TerminalDecision {
  return verified
    ? {
        outcome: "success",
        termination_reason: "completion",
        detail: "completion signal verified against current mandatory evidence",
      }
    : {
        outcome: "failed",
        termination_reason: "gate_failure",
        detail: "completion signal could not be verified against current mandatory evidence",
      };
}

export function budgetCeilingDecision(kind: "steps" | "tokens"): TerminalDecision {
  return {
    outcome: "partial",
    termination_reason: "budget_ceiling",
    detail: `loop ${kind} ceiling reached`,
  };
}

export function repeatDetectionDecision(fingerprint: string): TerminalDecision {
  return {
    outcome: "partial",
    termination_reason: "repeat_detection",
    detail: `repeated action without state or evidence progress (fingerprint ${fingerprint})`,
  };
}

export function timeoutDecision(): TerminalDecision {
  return {
    outcome: "partial",
    termination_reason: "timeout",
    detail: "loop duration ceiling reached",
  };
}

export function adapterFailureDecision(detail: string): TerminalDecision {
  return { outcome: "failed", termination_reason: "adapter_failure", detail };
}

export function cancellationDecision(): TerminalDecision {
  return {
    outcome: "handoff",
    termination_reason: "user_cancellation",
    detail: "run cancelled by the user",
  };
}

/**
 * The run phase machine. Legal flows: `running -> verifying -> terminated`
 * (completion path) and `running -> terminated` (every ceiling, failure or
 * cancellation path). `success` decisions may only be minted by `verify`;
 * `terminate` rejects them, so no caller can self-report success. The second
 * terminal transition always throws, which is how every exit path appends
 * exactly one terminal record.
 */
export class LoopPhaseMachine {
  private phaseValue: LoopRunPhase = "running";
  private terminalValue: TerminalDecision | undefined;

  get phase(): LoopRunPhase {
    return this.phaseValue;
  }

  get terminal(): TerminalDecision | undefined {
    return this.terminalValue;
  }

  /** A structured completion signal only ever enters `verifying`. */
  signalCompletion(): void {
    if (this.phaseValue !== "running") {
      throw new LoopError(
        "invalid_loop_phase",
        `completion signal is only valid while running, not ${this.phaseValue}`,
      );
    }
    this.phaseValue = "verifying";
  }

  /**
   * The only path to `success`: mandatory-evidence verification inside
   * `verifying`. Produces and records the terminal decision.
   */
  verify(evidenceCurrent: boolean): TerminalDecision {
    if (this.phaseValue !== "verifying") {
      throw new LoopError(
        "invalid_loop_phase",
        `evidence verification requires the verifying phase, not ${this.phaseValue}`,
      );
    }
    return this.terminateInternal(completionDecision(evidenceCurrent));
  }

  /** Terminate from `running` or `verifying`; never with a success outcome. */
  terminate(decision: TerminalDecision): TerminalDecision {
    if (decision.outcome === "success") {
      throw new LoopError(
        "invalid_loop_phase",
        "a success outcome can only be produced by evidence verification, never directly",
      );
    }
    return this.terminateInternal(decision);
  }

  private terminateInternal(decision: TerminalDecision): TerminalDecision {
    if (this.phaseValue === "terminated") {
      throw new LoopError(
        "loop_already_terminated",
        "the run already has a terminal decision; exactly one terminal record may be appended",
      );
    }
    this.phaseValue = "terminated";
    this.terminalValue = decision;
    return decision;
  }
}
