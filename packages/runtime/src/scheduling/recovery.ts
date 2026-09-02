/**
 * Standalone scheduling recovery (M4 design §16, plan Task 10 step 7).
 *
 * After a coordinator restart the scheduler's in-memory state is gone; this
 * module rebuilds one operation's control plane from authoritative Ledger
 * facts only:
 *
 * - Orphan leases (latest record still `granted`) are revoked exactly once,
 *   keyed by `recovery_command_id`, after a best-effort cooperative pool
 *   cancel; the orphan's external effects are uncertain, so a
 *   `run_interrupted` record is committed and its output can only ever be
 *   provisional.
 * - Residual PIDs located through the disposable live projection store are
 *   terminated through the injected process port; the projection is never
 *   authoritative, only a locator.
 * - Candidate worktrees that were never accepted (every entry of
 *   `listCandidateWorktrees` — a successful acceptWave discards its worktree)
 *   are discarded through the git port.
 * - Candidate/wave-layer evidence bound to a candidate commit no accepted
 *   WaveIntegration names is downgraded: a provisional replica (same
 *   `evidence_id`, same digest — the digest covers outcome+bindings, not the
 *   provisional flag) is appended. Authoritative readers serve the latest
 *   record per `evidence_id`, so the replica supersedes the original.
 *   `candidate_validated` is never restored from old evidence; the candidate
 *   gates re-run instead.
 * - Queued candidate patches (`facts.candidate_patches`) refill the
 *   integration controller's in-memory queue; the earliest incomplete wave is
 *   rebuilt and re-validated. acceptWave is never called here — it needs a
 *   driver-supplied policy decision and command id.
 * - P2-1 (Task 7 review): the startup sweep removes only `harness-tdd-task_execution-*`
 *   directories directly under the managed root, and only once the operation
 *   is fully quiesced (no granted lease survives recovery). A cancelled
 *   operation keeps its workspaces for diagnosis (§15.2). After a restart a
 *   retained diagnostic workspace is indistinguishable from a stale one, so
 *   blocked tasks' workspaces survive the sweep — an explicit decision.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  PROTOCOL_1_3_VERSION,
  contentDigest,
  type FeedbackRecord,
  type RunRecord,
  type TaskLeaseRecord,
} from "@universal-harness-internal/core";

import type { GateEvidenceRecord } from "../gates/evidence.js";
import { schedulerRecoveredEvent } from "./events.js";
import {
  CandidateIntegrationError,
  schedulingEvidenceBindingOf,
  type CandidateIntegrationController,
  type WaveIntegrationGitPort,
} from "./integration.js";
import { buildTaskLeaseChain, terminateTaskLease } from "./lease.js";
import type { SchedulerProjectionStore, TaskDagPort, TaskDagSnapshot } from "./ports.js";
import { projectSchedulerState } from "./projection.js";
import {
  authoritativeTerminalBudget,
  isPendingCandidateLease,
  orphanRunProvenanceVerified,
  poolAttestsRunGone,
  type SchedulerAuthority,
  type SchedulerLedgerFacts,
  type SchedulerTransition,
} from "./scheduler.js";
import type { TaskCandidatePatch } from "./workspace-manager.js";

/** Directory prefix the workspace manager mints task worktrees under. */
const TASK_WORKTREE_PREFIX = "harness-tdd-task_execution-";

export interface SchedulingRecoveryProcessPort {
  terminate(pid: number): Promise<"terminated" | "not_found">;
}

export interface SchedulingRecoveryOptions {
  readonly dag_port: TaskDagPort;
  readonly authority: SchedulerAuthority;
  /** Cooperative stop seam; a dead process is already gone (unknown_run). */
  readonly pool: { cancel(runId: string): Promise<void> };
  /** Disposable live projection; only ever a PID locator, never authority. */
  readonly projections?: SchedulerProjectionStore;
  readonly git?: WaveIntegrationGitPort;
  /** When absent the candidate queue cannot be refilled after a restart. */
  readonly integration?: CandidateIntegrationController;
  /** Sweep scope for orphaned task worktrees (P2-1). */
  readonly managed_root?: string;
  readonly processes?: SchedulingRecoveryProcessPort;
  readonly now?: () => string;
}

export interface SchedulingRecoveryInput {
  readonly operation_id: string;
  readonly expected_plan_digest?: string;
  readonly recovery_command_id: string;
}

export type SchedulingRecoveryDisposition = "preserved" | "retry_pending" | "blocked" | "cancelled";

export interface SchedulingRecoveryReport {
  readonly operation_id: string;
  /** A durable user_cancellation terminal run exists for this operation. */
  readonly cancelled: boolean;
  readonly revoked_lease_ids: readonly string[];
  readonly terminated_pids: readonly number[];
  readonly swept_worktrees: readonly string[];
  readonly discarded_candidate_worktrees: readonly string[];
  readonly downgraded_evidence_ids: readonly string[];
  readonly dispositions: readonly {
    readonly task_id: string;
    readonly disposition: SchedulingRecoveryDisposition;
  }[];
  readonly candidate_replay:
    "completed" | "skipped_blocking_findings" | "skipped_cancelled" | "not_configured";
}

function digestId(prefix: string, parts: unknown): string {
  return `${prefix}_${contentDigest(parts).slice(0, 24)}`;
}

function runInterruptedRecord(input: {
  readonly operation_id: string;
  readonly task_id: string;
  readonly run_id: string;
  readonly now: string;
}): RunRecord {
  return {
    protocol_version: PROTOCOL_1_3_VERSION,
    record_kind: "run_interrupted",
    run_id: input.run_id,
    task_id: input.task_id,
    workflow_operation_id: input.operation_id,
    attempt_id: digestId("attempt", { run_id: input.run_id }),
    sequence: 2,
    timestamp: input.now,
    outcome: "failed",
    termination_reason: "process_interruption",
    partial_evidence_ids: [],
  };
}

type TerminalRunRecord = Extract<
  RunRecord,
  { readonly record_kind: "run_terminated" | "run_interrupted" }
>;

function isTerminalRun(record: RunRecord): record is TerminalRunRecord {
  return record.record_kind === "run_terminated" || record.record_kind === "run_interrupted";
}

function findingRule(finding: FeedbackRecord): string | undefined {
  const extension = finding.extensions?.["harness.finding"];
  if (typeof extension !== "object" || extension === null) return undefined;
  const rule = (extension as { rule?: unknown }).rule;
  return typeof rule === "string" ? rule : undefined;
}

function isOpenFinding(finding: FeedbackRecord): boolean {
  return (
    finding.type === "Finding" && (finding.status === "proposed" || finding.status === "accepted")
  );
}

function unknownBudgetFinding(input: {
  readonly dag: TaskDagSnapshot;
  readonly lease: TaskLeaseRecord;
  readonly now: string;
}): FeedbackRecord {
  const content = {
    protocol_version: PROTOCOL_1_3_VERSION,
    record_kind: "feedback" as const,
    id: digestId("finding", {
      iteration_id: input.dag.iteration_id,
      task_id: input.lease.task_id,
      rule: "budget_usage_unknown",
    }),
    type: "Finding" as const,
    iteration_id: input.dag.iteration_id,
    status: "proposed" as const,
    summary:
      `task ${input.lease.task_id} ended without authoritative usage metering; ` +
      "its full reservation remains charged and automatic retry is blocked",
    created_at: input.now,
    extensions: {
      "harness.finding": {
        origin: "scheduler",
        blocking: true,
        violates: [],
        blocks: [input.lease.task_id],
        evidence: [],
        rule: "budget_usage_unknown",
        severity: "error",
        actionability: "human_review",
        subject_ids: [input.lease.task_id],
        subject_digests: [input.lease.task_digest],
      },
    },
  };
  return { ...content, digest: contentDigest(content) };
}

/** Candidate replay stops while a wave-level failure Finding is open. */
const REPLAY_BLOCKING_RULES = new Set(["wave_gate_failed", "baseline_drift"]);

export async function recoverSchedulingOperation(
  options: SchedulingRecoveryOptions,
  input: SchedulingRecoveryInput,
): Promise<SchedulingRecoveryReport> {
  const now = options.now ?? (() => new Date().toISOString());
  const dag = await options.dag_port.readApproved({
    operation_id: input.operation_id,
    ...(input.expected_plan_digest === undefined
      ? {}
      : { expected_plan_digest: input.expected_plan_digest }),
  });
  const { authority } = options;

  const initialFacts = await authority.readFacts(input.operation_id);
  // P2-2: cancellation survives restart — proven by a durable terminal run,
  // never by process memory.
  const cancelled = initialFacts.runs.some(
    (record) =>
      record.workflow_operation_id === input.operation_id &&
      isTerminalRun(record) &&
      record.termination_reason === "user_cancellation",
  );

  // 1. Revoke orphan leases. A completed Run whose patch is durably queued
  // still owns its granted Lease through candidate validation; process loss
  // does not make that authority orphaned.
  const chain = buildTaskLeaseChain(initialFacts.leases);
  const orphaned = [...chain.latest_by_task.values()]
    .filter(
      (record) => record.state === "granted" && !isPendingCandidateLease(initialFacts, record),
    )
    .sort((left, right) => left.task_id.localeCompare(right.task_id));
  const revokedLeaseIds: string[] = [];
  if (orphaned.length > 0) {
    const transitions: SchedulerTransition[] = [];
    for (const lease of orphaned) {
      const runAttestedGone = await poolAttestsRunGone(options.pool, lease.run_id);
      const observedBudget = authoritativeTerminalBudget(initialFacts, lease);
      const budgetUnknown = observedBudget === undefined;
      // Same dual-proof settlement as recover(): a provenance-verified run the
      // pool attests is gone is a known process interruption and settles like
      // an unmetered executor crash (exactly one executor retry on the Task
      // remainder); anything less fails closed with the full reservation
      // charged and a blocking budget_usage_unknown Finding.
      const usageUnknowable =
        budgetUnknown &&
        !(
          runAttestedGone &&
          orphanRunProvenanceVerified({
            facts: initialFacts,
            lease,
            operation_id: dag.operation_id,
          })
        );
      if (budgetUnknown) {
        transitions.push({
          kind: "record_run",
          record: runInterruptedRecord({
            operation_id: dag.operation_id,
            task_id: lease.task_id,
            run_id: lease.run_id,
            now: now(),
          }),
        });
      }
      transitions.push({
        kind: "terminate_lease",
        record: terminateTaskLease(lease, {
          state: "revoked",
          consumed_budget:
            observedBudget ?? (usageUnknowable ? lease.reserved_budget : lease.consumed_budget),
          command_id: digestId("command", {
            purpose: "recovery-revoke",
            recovery_command_id: input.recovery_command_id,
            task_id: lease.task_id,
            attempt_number: lease.attempt_number,
          }),
        }),
      });
      if (usageUnknowable) {
        transitions.push({
          kind: "create_finding",
          finding: unknownBudgetFinding({ dag, lease, now: now() }),
        });
      }
      revokedLeaseIds.push(lease.lease_id);
    }
    transitions.push({
      kind: "append_event",
      event: schedulerRecoveredEvent({
        operation_id: dag.operation_id,
        recovered_tasks: orphaned.map((lease) => lease.task_id),
        released_leases: orphaned.map((lease) => lease.lease_id),
        note: "coordinator restart: orphaned leases revoked",
      }),
    });
    await authority.commit(transitions);
  }

  // 2. Terminate residual PIDs the disposable projection still locates.
  const terminatedPids: number[] = [];
  if (options.projections !== undefined && options.processes !== undefined) {
    const snapshot = await options.projections.read(input.operation_id);
    if (snapshot !== null) {
      const revokedTasks = new Set(orphaned.map((lease) => lease.task_id));
      for (const observation of snapshot.tasks) {
        if (!revokedTasks.has(observation.task_id) || observation.pid === null) continue;
        const outcome = await options.processes.terminate(observation.pid);
        if (outcome === "terminated") terminatedPids.push(observation.pid);
      }
    }
  }

  const facts = await authority.readFacts(input.operation_id);

  // 3. Discard candidate worktrees: every entry the git port still lists is
  // unaccepted by definition (acceptWave discards its worktree on success).
  const discardedCandidateWorktrees: string[] = [];
  if (options.git !== undefined) {
    for (const root of await options.git.listCandidateWorktrees({
      operation_id: input.operation_id,
    })) {
      await options.git.discardWorktree(root);
      discardedCandidateWorktrees.push(root);
    }
  }

  // 4. Downgrade candidate/wave evidence whose bound commit no accepted
  // WaveIntegration names. The provisional replica shares evidence_id and
  // digest; the facts view serves the latest record per evidence_id.
  const acceptedCommits = new Set(
    facts.wave_integrations
      .filter((record) => record.operation_id === input.operation_id)
      .map((record) => record.candidate_commit),
  );
  const downgraded: GateEvidenceRecord[] = [];
  for (const record of facts.gate_evidence) {
    if (record.provisional) continue;
    const binding = schedulingEvidenceBindingOf(record);
    if (binding === undefined) continue;
    if (binding.layer !== "candidate" && binding.layer !== "wave") continue;
    if (acceptedCommits.has(binding.commit)) continue;
    downgraded.push({ ...record, provisional: true });
  }
  if (downgraded.length > 0) {
    await authority.commit([{ kind: "append_gate_evidence", records: downgraded }]);
  }

  // 5. Candidate replay into the integration controller (never acceptWave).
  const candidateReplay = await replayCandidates(options, dag, cancelled, facts);

  // 6. P2-1 sweep: only a fully quiesced, non-cancelled operation, only the
  // manager's own task worktrees directly under the managed root.
  const sweptWorktrees: string[] = [];
  if (!cancelled && options.git !== undefined && options.managed_root !== undefined) {
    const quiescedChain = buildTaskLeaseChain(facts.leases);
    const quiesced = [...quiescedChain.latest_by_task.values()].every(
      (record) => record.state !== "granted",
    );
    if (quiesced) {
      let entries: string[];
      try {
        entries = await readdir(options.managed_root);
      } catch {
        entries = [];
      }
      for (const entry of entries.sort()) {
        if (!entry.startsWith(TASK_WORKTREE_PREFIX)) continue;
        const root = join(options.managed_root, entry);
        await options.git.discardWorktree(root);
        sweptWorktrees.push(root);
      }
    }
  }

  // 7. Dispositions from the authority-only projection of post-recovery facts.
  const finalFacts = await authority.readFacts(input.operation_id);
  const projection = projectSchedulerState(
    {
      dag,
      leases: finalFacts.leases,
      runs: finalFacts.runs,
      gate_evidence: finalFacts.gate_evidence,
      approvals: finalFacts.approvals,
      findings: finalFacts.findings,
      wave_integrations: finalFacts.wave_integrations,
    },
    null,
  );
  const dispositions = projection.tasks.map((task) => ({
    task_id: task.task_id,
    disposition:
      task.status === "cancelled"
        ? ("cancelled" as const)
        : task.status === "blocked"
          ? ("blocked" as const)
          : task.status === "retry_pending"
            ? ("retry_pending" as const)
            : ("preserved" as const),
  }));

  return {
    operation_id: input.operation_id,
    cancelled,
    revoked_lease_ids: revokedLeaseIds,
    terminated_pids: terminatedPids,
    swept_worktrees: sweptWorktrees,
    discarded_candidate_worktrees: discardedCandidateWorktrees,
    downgraded_evidence_ids: downgraded.map((record) => record.evidence_id),
    dispositions,
    candidate_replay: candidateReplay,
  };
}

async function replayCandidates(
  options: SchedulingRecoveryOptions,
  dag: TaskDagSnapshot,
  cancelled: boolean,
  facts: SchedulerLedgerFacts,
): Promise<SchedulingRecoveryReport["candidate_replay"]> {
  if (cancelled) return "skipped_cancelled";
  const controller = options.integration;
  if (controller === undefined) return "not_configured";
  if (
    facts.findings.some(
      (finding) => isOpenFinding(finding) && REPLAY_BLOCKING_RULES.has(findingRule(finding) ?? ""),
    )
  ) {
    return "skipped_blocking_findings";
  }

  // Refill the in-memory queue from the recovery view. changed_paths and
  // source_tree_digest were attested at collection time; the re-apply verifies
  // the patch by digest, so the rebuilt patch needs neither.
  const chain = buildTaskLeaseChain(facts.leases);
  for (const queued of facts.candidate_patches ?? []) {
    const lease = chain.latest_by_task.get(queued.task_id);
    const patch: TaskCandidatePatch = {
      task_id: queued.task_id,
      baseline_commit: lease?.baseline_commit ?? dag.baseline_commit,
      changed_paths: [],
      patch_locator: queued.patch_locator,
      patch_digest: queued.patch_digest,
      source_tree_digest: "",
    };
    await controller.queueTaskCandidate(patch);
  }

  const integratedWaves = new Set(
    facts.wave_integrations
      .filter((record) => record.operation_id === dag.operation_id)
      .map((record) => record.wave_index),
  );
  const wave = [...dag.parallel_waves]
    .sort((left, right) => left.wave_index - right.wave_index)
    .find((candidate) => !integratedWaves.has(candidate.wave_index));
  if (wave === undefined) return "completed";
  const queuedTasks = new Set((facts.candidate_patches ?? []).map((fact) => fact.task_id));
  if (!wave.task_ids.every((taskId) => queuedTasks.has(taskId))) {
    // The wave is only partially queued; the missing tasks still dispatch
    // through the normal drive loop.
    return "completed";
  }
  const base =
    wave.wave_index === 0
      ? dag.baseline_commit
      : (facts.wave_integrations.find(
          (record) =>
            record.operation_id === dag.operation_id && record.wave_index === wave.wave_index - 1,
        )?.candidate_commit ?? dag.baseline_commit);

  try {
    const candidate = await controller.rebuildWaveCandidate({
      dag,
      wave,
      expected_base_commit: base,
    });
    for (const taskId of wave.task_ids) {
      const task = dag.tasks.find((spec) => spec.id === taskId);
      const lease = chain.latest_by_task.get(taskId);
      if (task === undefined || lease === undefined) continue;
      // Layer-1 evidence comes from authoritative facts only; old candidate
      // verdicts never restore candidate_validated — the gates re-run.
      const evidence = facts.gate_evidence
        .filter((record) => {
          if (record.provisional) return false;
          const binding = schedulingEvidenceBindingOf(record);
          return binding?.layer === "task" && binding.task_id === taskId;
        })
        .map((record) => ({
          kind: "gate_result",
          locator: `ledger://evidence/${record.evidence_id}`,
          digest: record.digest,
        }));
      await controller.validateTaskCandidate({
        candidate,
        task,
        lease,
        evidence,
        ...(lease.state === "released" ? { revalidate_released: true } : {}),
      });
    }
  } catch (error) {
    // Conflict accounting (retry scheduling, blocking Findings) already landed
    // in the Ledger inside the controller; recovery itself never fails closed
    // on a replay conflict.
    if (error instanceof CandidateIntegrationError) return "completed";
    throw error;
  }
  return "completed";
}
