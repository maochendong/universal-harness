import type {
  FeedbackRecord,
  RunRecord,
  TaskLeaseRecord,
  WaveIntegrationRecord,
} from "@universal-harness-internal/core";

import type { ApprovalRequestRecord } from "../approval/request.js";
import type { GateEvidenceRecord } from "../gates/evidence.js";
import { taskSemanticDigest, type Protocol13TaskSpecification } from "../planning/task.js";

import { remainingBudget, type BudgetAmount, type IterationBudgetAccount } from "./budget.js";
import { buildTaskLeaseChain, nextFencingToken } from "./lease.js";
import type { TaskDagSnapshot } from "./ports.js";
import { projectSchedulerState } from "./projection.js";
import {
  ResourceLockError,
  acquireTaskResources,
  type ResourceLockTable,
} from "./resource-locks.js";

/**
 * Pure readiness selection and concurrency clamping (M4 design §9/§10.1, plan
 * Task 9 step 2). Everything here is a deterministic function of the approved
 * Plan plus authoritative facts: no clocks, no I/O, no mutation of the inputs.
 *
 * Selection reuses the Task 8 status projection so the read model and the
 * dispatcher can never disagree about what is `ready`. The scan visits only
 * the earliest incomplete wave, in Plan declaration order, and returns at most
 * `min(available_slots, effective_max_concurrency)` candidates. Exclusions are
 * deterministic and terminal for the pass: unintegrated dependencies and
 * later waves (projection), stale context, exhausted Task/iteration budget,
 * conflicting runtime resource locks, adapter capability mismatch, and any
 * Task with an active or current Lease. Ordering is the Plan's own — never
 * duration, risk or model score (design §9).
 */

/** Every bound that clamps local concurrency (design §8.4/§10.2). */
export interface EffectiveConcurrencyInput {
  readonly runtime_requested: number;
  readonly profile_limit: number;
  readonly installation_limit: number;
  readonly project_limit: number;
  readonly local_resource_limit: number;
  readonly unattended_eligible: boolean;
}

/**
 * The effective concurrency ceiling: the minimum positive integer bound; a
 * non-positive or non-integer bound is no bound at all (the policy evaluator
 * blocks undeclared/invalid ceilings upstream, so a zero here never means
 * "stop everything"). When every bound is absent the fail-safe minimum is 1.
 * An adapter that is not unattended-eligible always forces single-slot
 * supervised execution (design §10.1). Lowering any ceiling only affects
 * future Leases — this function never touches a running Task.
 */
export function effectiveMaxConcurrency(input: EffectiveConcurrencyInput): number {
  if (!input.unattended_eligible) return 1;
  const bounds = [
    input.runtime_requested,
    input.profile_limit,
    input.installation_limit,
    input.project_limit,
    input.local_resource_limit,
  ].filter((bound) => Number.isInteger(bound) && bound > 0);
  if (bounds.length === 0) return 1;
  return Math.min(...bounds);
}

/**
 * Authoritative facts readiness reasons about, beyond the DAG itself. This is
 * exactly the projection's fact set plus the stale-context view: the context
 * compiler/freshness layer owns bundle state, so staleness arrives already
 * evaluated (the scheduler never re-interprets bundle internals).
 */
export interface SchedulerReadinessFacts {
  readonly leases: readonly TaskLeaseRecord[];
  readonly runs: readonly RunRecord[];
  readonly gate_evidence: readonly GateEvidenceRecord[];
  readonly approvals: readonly ApprovalRequestRecord[];
  readonly findings: readonly FeedbackRecord[];
  readonly wave_integrations: readonly WaveIntegrationRecord[];
  /** Tasks whose latest assembled context bundle is stale against current bindings. */
  readonly stale_context_task_ids: readonly string[];
}

/** The adapter facts readiness may check before a Lease is written. */
export interface ReadinessAdapterProfile {
  readonly unattended_eligible: boolean;
  /** Capability ids the single homologous adapter can satisfy (design §10.1). */
  readonly capabilities: readonly string[];
}

/** One dispatchable Task with everything the dispatch transaction needs. */
export interface ReadyTaskCandidate {
  readonly task: Protocol13TaskSpecification;
  readonly task_digest: string;
  readonly wave_index: number;
  /**
   * Set when the Task's latest attempt failed recoverably and the single
   * permitted executor retry is still unconsumed (design §15.1). Integration
   * retries are minted by the scheduler's integration-retry synthesis (Task
   * 10), not by selection, but share this field so the granted Lease records
   * the kind either way.
   */
  readonly retry_kind?: "executor_retry" | "integration_retry";
  /** The next attempt number and fencing token the granted Lease must carry. */
  readonly attempt_number: number;
  readonly fencing_token: number;
  /** The exact steps/tokens to reserve: the Task's remaining original budget. */
  readonly reservation: BudgetAmount;
}

export interface SelectReadyTasksInput {
  readonly dag: TaskDagSnapshot;
  readonly facts: SchedulerReadinessFacts;
  /**
   * Runtime lock table rebuilt from the currently granted Leases
   * (rebuildResourceLocks). Selection acquires into a working copy so
   * candidates chosen earlier in the same pass also exclude later ones.
   */
  readonly resources: ResourceLockTable;
  /** Iteration budget account restored from the authoritative Lease records. */
  readonly budget: IterationBudgetAccount;
  readonly adapter: ReadinessAdapterProfile;
  readonly available_slots: number;
  readonly effective_max_concurrency: number;
}

/**
 * Select the Tasks the next scheduling pass may dispatch. Deterministic in
 * every input: identical facts always yield the identical candidate list,
 * including reservation amounts, attempt numbers and fencing tokens.
 */
export function selectReadyTasks(input: SelectReadyTasksInput): readonly ReadyTaskCandidate[] {
  const capacity = Math.min(input.available_slots, input.effective_max_concurrency);
  if (!Number.isInteger(capacity) || capacity < 1) return [];

  const { dag, facts } = input;
  const chain = buildTaskLeaseChain(facts.leases);
  const projection = projectSchedulerState(
    {
      dag,
      leases: facts.leases,
      runs: facts.runs,
      gate_evidence: facts.gate_evidence,
      approvals: facts.approvals,
      findings: facts.findings,
      wave_integrations: facts.wave_integrations,
    },
    null,
  );

  const staleContexts = new Set(facts.stale_context_task_ids);
  const adapterCapabilities = new Set(input.adapter.capabilities);
  const available = remainingBudget(input.budget);

  let table = input.resources;
  let slotsLeft = capacity;
  let stepsLeft = available.steps;
  let tokensLeft = available.tokens;
  const selected: ReadyTaskCandidate[] = [];

  // projection.tasks is in Plan declaration order; filtering preserves it.
  for (const status of projection.tasks) {
    if (slotsLeft === 0) break;
    if (status.status !== "ready" && status.status !== "retry_pending") continue;
    const task = dag.tasks.find((candidate) => candidate.id === status.task_id);
    if (task === undefined) continue;

    // Stale context: the bundle no longer reflects current sources/bindings,
    // so a dispatch under it would execute against drifted inputs (§9 step 4).
    if (staleContexts.has(task.id)) continue;

    // Homologous capability match (§10.1): an adapter that cannot satisfy the
    // Task is never swapped out silently; the Task simply is not dispatched.
    if (!task.capabilities.every((capability) => adapterCapabilities.has(capability))) {
      continue;
    }

    // A retry only ever spends the original Task budget's remainder (§15.1).
    const consumed = input.budget.consumed[task.id] ?? { steps: 0, tokens: 0 };
    const reservation: BudgetAmount = {
      steps: task.budget.steps - consumed.steps,
      tokens: task.budget.tokens - consumed.tokens,
    };
    if (reservation.steps <= 0 || reservation.tokens <= 0) continue;
    if (reservation.steps > stepsLeft || reservation.tokens > tokensLeft) continue;

    const fencingToken = nextFencingToken(chain, task.id);
    const latest = chain.latest_by_task.get(task.id);
    try {
      table = acquireTaskResources(table, {
        task_id: task.id,
        fencing_token: fencingToken,
        write_paths: task.write_paths,
        exclusive_resources: task.exclusive_resources,
      });
    } catch (error) {
      if (error instanceof ResourceLockError) continue;
      throw error;
    }

    stepsLeft -= reservation.steps;
    tokensLeft -= reservation.tokens;
    slotsLeft -= 1;
    selected.push({
      task,
      task_digest: taskSemanticDigest(task),
      wave_index: status.wave_index ?? 0,
      ...(status.status === "retry_pending" ? { retry_kind: "executor_retry" as const } : {}),
      attempt_number: (latest?.attempt_number ?? 0) + 1,
      fencing_token: fencingToken,
      reservation,
    });
  }
  return selected;
}
