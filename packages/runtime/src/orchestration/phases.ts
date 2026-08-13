import type { OperationState } from "@universal-harness-internal/core";

import type { CheckpointBoundary } from "../workflow/checkpoint.js";

/**
 * Orchestration phases (design sections 2 and 11.1, plan Task 23). Every
 * entry command -- `new`, `adopt`, `iterate` -- drives the same ordered phase
 * pipeline, and `resume` re-enters it at the phase recorded in the latest
 * valid checkpoint. A phase commits its outputs atomically and only then
 * advances the recorded phase, so an interruption never leaves a phase half
 * applied and a resume never repeats a committed phase.
 */
export const ORCHESTRATION_PHASES = [
  "capture",
  "impact",
  "plan",
  "context",
  "execute",
  "verify",
  "evaluate",
  "snapshot",
] as const;

export type OrchestrationPhase = (typeof ORCHESTRATION_PHASES)[number];

export function isOrchestrationPhase(value: unknown): value is OrchestrationPhase {
  return typeof value === "string" && (ORCHESTRATION_PHASES as readonly string[]).includes(value);
}

/** Position in the fixed pipeline order; unknown phases rank before capture. */
export function phaseRank(phase: OrchestrationPhase): number {
  return ORCHESTRATION_PHASES.indexOf(phase);
}

/** The phase after `phase`, or `undefined` once the pipeline is complete. */
export function nextPhase(phase: OrchestrationPhase): OrchestrationPhase | undefined {
  return ORCHESTRATION_PHASES[phaseRank(phase) + 1];
}

/**
 * Checkpoint boundary kind a phase's completion commit uses (design 10.2:
 * checkpoints land on authoritative commit, approval, task, gate and snapshot
 * boundaries).
 */
export const PHASE_CHECKPOINT_BOUNDARY: Readonly<Record<OrchestrationPhase, CheckpointBoundary>> = {
  capture: "authoritative_commit",
  impact: "authoritative_commit",
  plan: "authoritative_commit",
  context: "authoritative_commit",
  execute: "task",
  verify: "gate",
  evaluate: "authoritative_commit",
  snapshot: "snapshot",
};

/**
 * Operation state the engine must reach before a phase runs (design 10
 * delivery chain). `capture` and `impact` run while the operation awaits
 * approval of their proposals; `plan` commits mark the operation `planned`;
 * context compilation and execution run under `running`; gates, evaluation
 * and the snapshot run under `verifying`.
 */
export const PHASE_OPERATION_STATE: Readonly<Record<OrchestrationPhase, OperationState>> = {
  capture: "awaiting_approval",
  impact: "awaiting_approval",
  plan: "planned",
  context: "running",
  execute: "running",
  verify: "verifying",
  evaluate: "verifying",
  snapshot: "verifying",
};
