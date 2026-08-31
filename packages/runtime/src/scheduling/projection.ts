import type {
  FeedbackRecord,
  RunRecord,
  TaskLeaseRecord,
  WaveIntegrationRecord,
} from "@universal-harness-internal/core";

import type { ApprovalRequestRecord } from "../approval/request.js";
import type { GateEvidenceRecord } from "../gates/evidence.js";
import type {
  AgentPoolSlot,
  SchedulerLiveSnapshot,
  SchedulerTaskLiveObservation,
  TaskDagSnapshot,
} from "./ports.js";

/**
 * Authoritative Task status projection (M4 design §7, plan Task 8 step 4).
 * A pure function: approved Plan + Ledger facts decide every Task status;
 * the disposable live snapshot only decorates PID, heartbeat, output tail,
 * worktree locator and current step. Deterministic precedence, first match
 * wins:
 *
 *   1. integrated           — a WaveIntegrationRecord names the Task; nothing
 *                             else (least of all an agent completion claim)
 *                             ever produces it.
 *   2. cancelled            — the lease is terminal AND the run's terminal
 *                             record carries user_cancellation: the user
 *                             cancelled and the side effects are reconciled.
 *   3. blocked              — an open blocking Finding names the Task, or the
 *                             latest attempt ended unrecoverably (policy
 *                             denial, gate failure, manual stop, or a failure
 *                             after the single permitted retry was consumed).
 *                             An open blocker beats any stale live PID.
 *   4. running / verifying  — the lease is still granted: no terminal run
 *                             record means the agent executes; a terminal one
 *                             means assertions and gates are being verified.
 *   5. candidate_validated  — released lease plus valid (non-provisional,
 *                             passed) candidate Evidence.
 *   6. integration_queued   — local verification passed (valid evidence) but
 *                             the lease is not released yet.
 *   7. verifying            — a completion-claimed terminal run without
 *                             validating evidence yet.
 *   8. retry_pending        — the latest attempt failed recoverably and the
 *                             retry budget is unconsumed.
 *   9. awaiting_approval    — a pending Approval request names the Task.
 *  10. ready                — dependencies integrated and the Task belongs to
 *                             the earliest incomplete wave.
 *  11. waiting_dependency   — everything else.
 *
 * Provisional evidence is labeled `provisional` and never advances a Task or
 * satisfies a dependency: only wave integration does that. When the live
 * snapshot is absent the projection reports `live_state: "rebuilding"` — the
 * authority-derived statuses are unaffected and never degrade to
 * failed/success guesses.
 */

export const TASK_SCHEDULING_STATUSES = [
  "waiting_dependency",
  "ready",
  "awaiting_approval",
  "running",
  "verifying",
  "integration_queued",
  "candidate_validated",
  "retry_pending",
  "integrated",
  "blocked",
  "cancelled",
] as const;

export type TaskSchedulingStatus = (typeof TASK_SCHEDULING_STATUSES)[number];

export interface SchedulerAuthorityFacts {
  readonly dag: TaskDagSnapshot;
  readonly leases: readonly TaskLeaseRecord[];
  readonly runs: readonly RunRecord[];
  readonly gate_evidence: readonly GateEvidenceRecord[];
  /**
   * Pending (unresolved) approval requests — the same view the approval
   * service's pendingRequests() produces. A resolved request never appears
   * here.
   */
  readonly approvals: readonly ApprovalRequestRecord[];
  /** Feedback records; only open (`proposed`/`accepted`) Findings block. */
  readonly findings: readonly FeedbackRecord[];
  readonly wave_integrations: readonly WaveIntegrationRecord[];
}

export interface TaskStatusProjection {
  readonly task_id: string;
  readonly wave_index: number | null;
  readonly status: TaskSchedulingStatus;
  /**
   * `true` when the Task's latest validating evidence is provisional only;
   * a provisional result never satisfies dependencies or candidate gates.
   */
  readonly provisional: boolean;
  readonly live: SchedulerTaskLiveObservation | null;
}

export interface SchedulerStateProjection {
  readonly operation_id: string;
  readonly plan_digest: string;
  readonly baseline_commit: string;
  readonly live_state: "observed" | "rebuilding";
  readonly observed_at: string | null;
  readonly slots: readonly AgentPoolSlot[];
  readonly tasks: readonly TaskStatusProjection[];
}

const TERMINAL_LEASE_STATES = new Set(["released", "expired", "revoked"]);

/** Termination reasons that never auto-retry (design §7, global constraint). */
const NON_RETRYABLE_TERMINATIONS = new Set(["policy_denial", "gate_failure", "manual_stop"]);

interface TerminalRunRecord {
  readonly outcome: string;
  readonly termination_reason: string;
}

function latestLeaseByTask(leases: readonly TaskLeaseRecord[]): Map<string, TaskLeaseRecord> {
  const latest = new Map<string, TaskLeaseRecord>();
  for (const record of leases) {
    latest.set(record.task_id, record);
  }
  return latest;
}

/** Latest record per run chain, then the chain with the highest sequence. */
function latestRunRecord(runs: readonly RunRecord[], taskId: string): RunRecord | undefined {
  const byRun = new Map<string, RunRecord>();
  for (const record of runs) {
    if (record.task_id !== taskId) continue;
    const current = byRun.get(record.run_id);
    if (
      current === undefined ||
      record.sequence > current.sequence ||
      (record.sequence === current.sequence && record.record_kind > current.record_kind)
    ) {
      byRun.set(record.run_id, record);
    }
  }
  return [...byRun.values()].sort((left, right) =>
    left.sequence === right.sequence
      ? left.run_id < right.run_id
        ? -1
        : 1
      : left.sequence - right.sequence,
  )[0];
}

function terminalRunOf(record: RunRecord | undefined): TerminalRunRecord | undefined {
  if (
    record !== undefined &&
    (record.record_kind === "run_terminated" || record.record_kind === "run_interrupted")
  ) {
    return record;
  }
  return undefined;
}

interface EvidenceReading {
  readonly valid: boolean;
  readonly provisionalOnly: boolean;
}

/** Candidate evidence bound to the Task: passed, and counted only when final. */
function readCandidateEvidence(
  evidence: readonly GateEvidenceRecord[],
  taskId: string,
): EvidenceReading {
  let valid = false;
  let provisionalOnly = false;
  for (const record of evidence) {
    if (record.subject_id !== taskId || record.evidence_type !== "gate_result") continue;
    const extension = record.extensions?.["harness.gate"];
    if (typeof extension !== "object" || extension === null) continue;
    const passed = (extension as { passed?: unknown }).passed === true;
    if (!passed) continue;
    if (record.provisional) {
      provisionalOnly = true;
    } else {
      valid = true;
    }
  }
  return { valid, provisionalOnly: provisionalOnly && !valid };
}

function hasOpenBlocker(findings: readonly FeedbackRecord[], taskId: string): boolean {
  for (const finding of findings) {
    if (finding.type !== "Finding") continue;
    if (finding.status !== "proposed" && finding.status !== "accepted") continue;
    const subject = finding.extensions?.["harness.finding"];
    if (typeof subject !== "object" || subject === null) continue;
    const parsed = subject as { blocking?: unknown; blocks?: unknown };
    if (
      parsed.blocking === true &&
      Array.isArray(parsed.blocks) &&
      parsed.blocks.includes(taskId)
    ) {
      return true;
    }
  }
  return false;
}

export function projectSchedulerState(
  facts: SchedulerAuthorityFacts,
  live: SchedulerLiveSnapshot | null,
): SchedulerStateProjection {
  const { dag } = facts;
  const integratedTaskIds = new Set<string>();
  for (const record of facts.wave_integrations) {
    if (record.operation_id !== dag.operation_id) continue;
    for (const taskId of record.task_ids) integratedTaskIds.add(taskId);
  }

  const waveOfTask = new Map<string, number>();
  for (const wave of dag.parallel_waves) {
    for (const taskId of wave.task_ids) waveOfTask.set(taskId, wave.wave_index);
  }
  const incompleteWaves = dag.parallel_waves
    .filter((wave) => wave.task_ids.some((taskId) => !integratedTaskIds.has(taskId)))
    .map((wave) => wave.wave_index);
  const earliestIncompleteWave = incompleteWaves.length === 0 ? null : Math.min(...incompleteWaves);

  const latestLeases = latestLeaseByTask(facts.leases);
  const liveByTask = new Map<string, SchedulerTaskLiveObservation>(
    live === null ? [] : live.tasks.map((observation) => [observation.task_id, observation]),
  );

  const tasks: TaskStatusProjection[] = dag.tasks.map((task) => {
    const lease = latestLeases.get(task.id);
    const terminalRun = terminalRunOf(latestRunRecord(facts.runs, task.id));
    const evidence = readCandidateEvidence(facts.gate_evidence, task.id);
    const waveIndex = waveOfTask.get(task.id) ?? null;

    let status: TaskSchedulingStatus;
    if (integratedTaskIds.has(task.id)) {
      status = "integrated";
    } else if (
      lease !== undefined &&
      TERMINAL_LEASE_STATES.has(lease.state) &&
      terminalRun?.termination_reason === "user_cancellation"
    ) {
      status = "cancelled";
    } else if (hasOpenBlocker(facts.findings, task.id)) {
      status = "blocked";
    } else if (lease?.state === "granted") {
      status =
        terminalRun === undefined ? "running" : evidence.valid ? "integration_queued" : "verifying";
    } else if (lease !== undefined && TERMINAL_LEASE_STATES.has(lease.state)) {
      if (terminalRun === undefined) {
        // Crash window: the lease closed without a terminal run record.
        status = lease.retry_kind === undefined ? "retry_pending" : "blocked";
      } else if (
        terminalRun.termination_reason === "completion" &&
        terminalRun.outcome === "handoff"
      ) {
        status = lease.state === "released" && evidence.valid ? "candidate_validated" : "verifying";
      } else if (NON_RETRYABLE_TERMINATIONS.has(terminalRun.termination_reason)) {
        status = "blocked";
      } else if (lease.retry_kind !== undefined) {
        // The single permitted retry was already consumed by this attempt.
        status = "blocked";
      } else {
        status = "retry_pending";
      }
    } else if (facts.approvals.some((request) => request.object_id === task.id)) {
      status = "awaiting_approval";
    } else {
      const dependenciesIntegrated = task.dependencies.every((dependency) =>
        integratedTaskIds.has(dependency),
      );
      status =
        dependenciesIntegrated && waveIndex !== null && waveIndex === earliestIncompleteWave
          ? "ready"
          : "waiting_dependency";
    }

    return {
      task_id: task.id,
      wave_index: waveIndex,
      status,
      provisional: evidence.provisionalOnly,
      live: liveByTask.get(task.id) ?? null,
    };
  });

  return {
    operation_id: dag.operation_id,
    plan_digest: dag.plan_digest,
    baseline_commit: dag.baseline_commit,
    live_state: live === null ? "rebuilding" : "observed",
    observed_at: live?.observed_at ?? null,
    slots: live === null ? [] : live.slots,
    tasks,
  };
}
