import {
  PROTOCOL_1_3_VERSION,
  contentDigest,
  type FeedbackRecord,
  type LeaseRecord,
  type RunRecord,
  type TaskLeaseRecord,
  type WaveIntegrationRecord,
} from "@universal-harness-internal/core";
import type { AgentRunResult, AgentTaskEnvelope } from "@universal-harness-internal/plugin-sdk";

import { buildApprovalRequest, type ApprovalRequestRecord } from "../approval/request.js";
import type { GateEvidenceRecord } from "../gates/evidence.js";
import { actionDigest, type AdapterControlProfile } from "../policy/action.js";
import type { CapabilityGrant } from "../policy/capability-grant.js";
import type { PolicyDecision } from "../policy/decision.js";
import {
  taskSemanticDigest,
  type IterationBudget,
  type Protocol13TaskSpecification,
} from "../planning/task.js";

import { AgentPoolError, type LocalAgentPool } from "./agent-pool.js";
import {
  remainingBudget,
  reserveTaskBudget,
  restoreBudgetAccount,
  type BudgetAmount,
  type IterationBudgetAccount,
} from "./budget.js";
import type { DriverLockHandle } from "./driver-lock.js";
import {
  schedulerRecoveredEvent,
  taskDispatchedEvent,
  taskIntegrationQueuedEvent,
  taskLeaseGrantedEvent,
  taskRetryScheduledEvent,
  type SchedulerEventSpec,
} from "./events.js";
import {
  assertCurrentFencingToken,
  buildTaskLeaseChain,
  deriveTaskLeaseId,
  grantTaskLease,
  nextFencingToken,
  terminateTaskLease,
} from "./lease.js";
import type {
  PolicyDecisionPort,
  SchedulerPolicyInput,
  TaskDagPort,
  TaskDagSnapshot,
} from "./ports.js";
import { schedulerPolicyAction } from "./policy-adapters.js";
import { projectSchedulerState, type SchedulerStateProjection } from "./projection.js";
import {
  effectiveMaxConcurrency,
  selectReadyTasks,
  type ReadyTaskCandidate,
  type SchedulerReadinessFacts,
} from "./readiness.js";
import { rebuildResourceLocks } from "./resource-locks.js";
import type { TaskExecutionWorkspace, TaskWorkspaceManager } from "./workspace-manager.js";

/**
 * The deterministic LocalTaskScheduler (M4 design §9, plan Task 9 step 4).
 * One scheduling pass strictly follows the design order: rebuild authoritative
 * state from the Ledger → earliest incomplete wave → Plan-order scan →
 * eligibility exclusions → Adapter capability/unattended check →
 * PolicyDecisionPort → at most one digest-bound ApprovalRequest (pausing only
 * that Task) → atomic budget reservation + resource locks + granted Lease →
 * worktree/ContextBundle/CapabilityGrant/TaskEnvelope → Pool start → result
 * classification (verify / retry / block). `completion_claimed` alone never
 * changes state: a Task only leaves `running` through a classified terminal
 * classification, and only wave integration (Task 10) can mint `integrated`.
 *
 * Every write crosses exactly one seam — SchedulerAuthority.commit(), which
 * maps one ordered transition batch to one Ledger transaction. The budget
 * reservation IS the granted Lease record (the account is a pure projection
 * of Lease history), so reservation and grant are atomic by construction and
 * the pool never starts a process before that commit lands.
 *
 * Determinism: every identity (command id, lease id, run id, request id,
 * finding id) is a content digest of authoritative inputs, and the only clock
 * is the injected `now`. Replaying identical facts through a fresh process
 * reproduces byte-identical transition batches.
 */

export const SCHEDULER_ERROR_KINDS = [
  "driver_lock_mismatch",
  "recovery_required",
  "scheduling_loop_inconclusive",
] as const;

export type SchedulerErrorKind = (typeof SCHEDULER_ERROR_KINDS)[number];

/** Fail-closed rejection raised by the scheduler's own guards. */
export class SchedulerError extends Error {
  readonly kind: SchedulerErrorKind;

  constructor(kind: SchedulerErrorKind, message: string) {
    super(message);
    this.name = "SchedulerError";
    this.kind = kind;
  }
}

export interface SchedulerDriveInput {
  readonly operation_id: string;
  readonly expected_plan_digest: string;
  readonly requested_max_concurrency: number;
  readonly driver_lock: DriverLockHandle;
  /** The M3 operation Lease, when the operation runs under remote coordination. */
  readonly operation_lease?: LeaseRecord;
}

export interface SchedulerRecoverInput extends SchedulerDriveInput {
  readonly recovery_command_id: string;
}

export interface SchedulerCancelInput {
  readonly operation_id: string;
  readonly command_id: string;
  readonly reason: string;
  readonly driver_lock: DriverLockHandle;
}

export type SchedulerDriveStatus = "completed" | "paused" | "blocked" | "cancelled";

export interface SchedulerDriveResult {
  readonly status: SchedulerDriveStatus;
  readonly operation_id: string;
  readonly read_model: SchedulerReadModel;
}

/**
 * One authoritative scheduler transition. `create_finding` carries the core
 * FeedbackRecord — the repository's only Finding authority (Task 8
 * convention); `append_event` carries the pre-commit SchedulerEventSpec
 * (event id, sequence and ledger operation are assigned by the Ledger
 * transaction, so a full LifecycleEvent cannot exist yet); `record_run`
 * extends the plan's union because crash/cancel accounting needs the
 * authoritative run terminal records the projection's cancelled/retry rules
 * read.
 */
export type SchedulerTransition =
  | { readonly kind: "grant_lease"; readonly record: TaskLeaseRecord }
  | { readonly kind: "terminate_lease"; readonly record: TaskLeaseRecord }
  | {
      readonly kind: "append_evidence";
      readonly evidence: readonly {
        readonly kind: string;
        readonly locator: string;
        readonly digest: string;
      }[];
    }
  | {
      /**
       * Full gate evidence records produced by candidate/wave validation
       * (Task 10). Unlike `append_evidence` — a reference list — these records
       * are authoritative content the Ledger transaction must carry.
       */
      readonly kind: "append_gate_evidence";
      readonly records: readonly GateEvidenceRecord[];
    }
  | {
      /** The one authoritative mint of `integrated` (design §13.3/§14). */
      readonly kind: "record_wave_integration";
      readonly record: WaveIntegrationRecord;
    }
  | { readonly kind: "request_approval"; readonly request: ApprovalRequestRecord }
  | { readonly kind: "create_finding"; readonly finding: FeedbackRecord }
  | { readonly kind: "append_event"; readonly event: SchedulerEventSpec }
  | { readonly kind: "record_run"; readonly record: RunRecord };

/**
 * Recovery-view of one queued task candidate patch (Task 10): the join of the
 * TaskIntegrationQueued event (task/run identity) with the committed
 * `task_candidate_patch` evidence entry (artifact locator/digest). Production
 * authorities derive it from the Ledger; it carries no authority of its own.
 */
export interface QueuedCandidateFact {
  readonly task_id: string;
  readonly run_id: string;
  readonly patch_locator: string;
  readonly patch_digest: string;
}

/** Authoritative Ledger facts the scheduler rebuilds from, minus the DAG. */
export interface SchedulerLedgerFacts {
  readonly leases: readonly TaskLeaseRecord[];
  readonly runs: readonly RunRecord[];
  readonly gate_evidence: readonly GateEvidenceRecord[];
  readonly approvals: readonly ApprovalRequestRecord[];
  readonly findings: readonly FeedbackRecord[];
  readonly wave_integrations: readonly WaveIntegrationRecord[];
  /** Queued candidate patches awaiting wave integration (Task 10 recovery). */
  readonly candidate_patches?: readonly QueuedCandidateFact[];
}

/**
 * The one write seam. Production wiring (Task 10/11) maps each batch to a
 * staged Ledger transaction; tests substitute a recording authority. This
 * interface stays runtime-internal and is never re-exported through the
 * public barrel.
 *
 * Read-side contract every production authority must honor:
 * - `gate_evidence` is latest-by-evidence_id: when several committed records
 *   share one evidence_id, the record written by the newest Ledger operation
 *   wins. The Task 10 recovery downgrade (re-committing the same evidence_id
 *   as a provisional copy) depends on this supersession.
 * - `candidate_patches` is a derived view (Task 10 review obligation): the
 *   TaskIntegrationQueued event (task/run identity, patch digest) joined with
 *   the committed `task_candidate_patch` evidence reference (locator), never
 *   a separately stored fact.
 */
export interface SchedulerAuthority {
  readFacts(operationId: string): Promise<SchedulerLedgerFacts>;
  commit(transitions: readonly SchedulerTransition[]): Promise<void>;
}

/** Scheduler-facing read model (Task 10 owns the public API shape). */
export interface SchedulerReadModel {
  readonly operation_id: string;
  readonly plan_digest: string;
  readonly projection: SchedulerStateProjection;
  readonly budget: {
    readonly limit: IterationBudget;
    readonly remaining: BudgetAmount;
    readonly reserved_task_ids: readonly string[];
  };
  readonly pending_approvals: readonly ApprovalRequestRecord[];
  readonly blocking_findings: readonly FeedbackRecord[];
}

export interface AssembledTaskContext {
  readonly context_bundle_id: string;
  readonly context_bundle_digest: string;
}

/**
 * The dispatch-time collaborations the scheduler orchestrates but does not
 * own: context assembly, grant issuance and envelope construction keep their
 * existing module boundaries (design §4.1). Production wiring binds the real
 * services; every callback must be deterministic in its inputs.
 */
export interface SchedulerDispatchCallbacks {
  assembleContext(input: {
    readonly task: Protocol13TaskSpecification;
    readonly run_id: string;
    readonly attempt_number: number;
  }): Promise<AssembledTaskContext>;
  issueTaskGrant(input: {
    readonly task: Protocol13TaskSpecification;
    readonly decision: PolicyDecision;
    readonly lease: TaskLeaseRecord;
    readonly reservation: BudgetAmount;
  }): CapabilityGrant;
  buildEnvelope(input: {
    readonly task: Protocol13TaskSpecification;
    readonly grant: CapabilityGrant;
    readonly context: AssembledTaskContext;
    readonly lease: TaskLeaseRecord;
    readonly workspace: TaskExecutionWorkspace;
  }): AgentTaskEnvelope;
  /** Managed evidence directory for one run; never inside the task worktree. */
  evidenceDir(input: { readonly task_id: string; readonly run_id: string }): string;
  /** Context freshness view; defaults to "nothing is stale". */
  readStaleContextTaskIds?(dag: TaskDagSnapshot, facts: SchedulerLedgerFacts): readonly string[];
}

export interface SchedulerCeilingBounds {
  readonly profile_limit: number;
  readonly installation_limit: number;
  readonly project_limit: number;
  readonly local_resource_limit: number;
}

export interface LocalTaskSchedulerOptions {
  readonly dag_port: TaskDagPort;
  readonly policy: PolicyDecisionPort;
  readonly authority: SchedulerAuthority;
  readonly pool: LocalAgentPool;
  readonly workspaces: TaskWorkspaceManager;
  readonly adapter_manifest_digest: string;
  readonly adapter_control_profile: AdapterControlProfile;
  /**
   * Capability ids the single homologous adapter can satisfy. Deviation from
   * design §10.1's `PluginManifest.capabilities` wording: AgentProviderManifest
   * declares control/metering/trajectory but no capability list, so the
   * matching input arrives here from the caller (e.g. the compiled
   * CapabilityPlan) until the manifest grows the field.
   */
  readonly adapter_capabilities: readonly string[];
  readonly unattended_eligible: boolean;
  readonly ceilings: SchedulerCeilingBounds;
  /** The effective policy digest every scheduler action pins. */
  readonly effective_policy_digest: string;
  readonly callbacks: SchedulerDispatchCallbacks;
  /** ISO clock; injectable so replays are byte-deterministic. */
  readonly now?: () => string;
}

export interface LocalTaskScheduler {
  drive(input: SchedulerDriveInput): Promise<SchedulerDriveResult>;
  recover(input: SchedulerRecoverInput): Promise<SchedulerDriveResult>;
  cancel(input: SchedulerCancelInput): Promise<SchedulerDriveResult>;
  read(operationId: string): Promise<SchedulerReadModel>;
}

/** Fencing guard for late-arriving run results (design §8.2). */
export interface SchedulerRunAcceptanceInput {
  readonly operation_id: string;
  readonly task_id: string;
  readonly fencing_token: number;
}

export interface DeterministicLocalTaskScheduler extends LocalTaskScheduler {
  acceptRunResult(input: SchedulerRunAcceptanceInput): Promise<void>;
}

const CRASH_TERMINATIONS = new Set(["adapter_failure", "timeout", "process_interruption"]);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Deterministic identifier: content-addressed by its authoritative inputs. */
function digestId(prefix: string, parts: unknown): string {
  return `${prefix}_${contentDigest(parts).slice(0, 24)}`;
}

/**
 * The iteration deadline anchored in authoritative facts: the earliest Lease
 * issuance plus the approved duration, so every pass and every replay derives
 * the identical deadline. Before the first Lease exists the drive's own clock
 * anchors it (design §8.4 leaves the anchor to the iteration start, which the
 * Ledger does not record separately for M4).
 */
export function deriveIterationDeadline(
  dag: TaskDagSnapshot,
  leases: readonly TaskLeaseRecord[],
  now: string,
): string {
  let earliest: string | undefined;
  for (const record of leases) {
    if (earliest === undefined || record.issued_at < earliest) earliest = record.issued_at;
  }
  const base = Date.parse(earliest ?? now);
  return new Date(base + dag.iteration_budget.duration_ms).toISOString();
}

/**
 * What one run provably consumed. Harness-observed budget observations win;
 * provider-reported tokens are the fallback; an unmetered axis settles as 0 —
 * never as the full reservation, which would make the single executor retry
 * unaffordable and report consumption nobody measured (design §15.1/§18).
 */
export function meteredConsumption(result: AgentRunResult): BudgetAmount {
  const observed = (dimension: "steps" | "tokens"): number | null => {
    const observation = result.budget_observations?.find(
      (candidate) => candidate.dimension === dimension,
    );
    return observation !== undefined && observation.used !== null ? observation.used : null;
  };
  const steps = observed("steps") ?? 0;
  const tokens = observed("tokens") ?? result.usage.total_tokens ?? 0;
  return {
    steps: Math.max(0, Math.floor(steps)),
    tokens: Math.max(0, Math.floor(tokens)),
  };
}

function isOpenBlockingFinding(finding: FeedbackRecord): boolean {
  if (finding.type !== "Finding") return false;
  if (finding.status !== "proposed" && finding.status !== "accepted") return false;
  const extension = finding.extensions?.["harness.finding"];
  if (typeof extension !== "object" || extension === null) return false;
  return (extension as { blocking?: unknown }).blocking === true;
}

function openFindingRule(finding: FeedbackRecord): string | undefined {
  if (finding.type !== "Finding") return undefined;
  if (finding.status !== "proposed" && finding.status !== "accepted") return undefined;
  const extension = finding.extensions?.["harness.finding"];
  if (typeof extension !== "object" || extension === null) return undefined;
  const rule = (extension as { rule?: unknown }).rule;
  return typeof rule === "string" ? rule : undefined;
}

/** Open Findings (blocking or not) carrying `rule` that name the Task. */
function hasOpenFindingRule(
  findings: readonly FeedbackRecord[],
  rule: string,
  taskId: string,
): boolean {
  return findings.some((finding) => {
    if (openFindingRule(finding) !== rule) return false;
    const extension = finding.extensions?.["harness.finding"];
    const blocks = (extension as { blocks?: unknown }).blocks;
    return Array.isArray(blocks) && blocks.includes(taskId);
  });
}

/**
 * P2-2: user cancellation is durable §15.2 state — a terminal Run with
 * termination_reason user_cancellation in the Ledger, never process memory.
 */
function hasDurableCancellation(facts: SchedulerLedgerFacts, operationId: string): boolean {
  return facts.runs.some(
    (record) =>
      record.workflow_operation_id === operationId &&
      (record.record_kind === "run_terminated" || record.record_kind === "run_interrupted") &&
      record.termination_reason === "user_cancellation",
  );
}

export function createLocalTaskScheduler(
  options: LocalTaskSchedulerOptions,
): DeterministicLocalTaskScheduler {
  const now = options.now ?? (() => new Date().toISOString());
  const { authority, pool } = options;
  /** Process-local cancellation memory; durable cancellation is §15.2 state. */
  const cancelledOperations = new Set<string>();

  const assertDriverLock = (lock: DriverLockHandle, operationId: string): void => {
    if (lock.operation_id !== operationId) {
      throw new SchedulerError(
        "driver_lock_mismatch",
        `driver lock belongs to operation ${lock.operation_id}, not ${operationId}`,
      );
    }
  };

  const readinessFacts = (facts: SchedulerLedgerFacts): SchedulerReadinessFacts => ({
    ...facts,
    stale_context_task_ids: [],
  });

  const rebuildAccount = (
    dag: TaskDagSnapshot,
    facts: SchedulerLedgerFacts,
  ): IterationBudgetAccount =>
    restoreBudgetAccount({
      limit: dag.iteration_budget,
      iteration_deadline: deriveIterationDeadline(dag, facts.leases, now()),
      records: facts.leases,
    });

  const buildReadModel = async (
    dag: TaskDagSnapshot,
    facts: SchedulerLedgerFacts,
  ): Promise<SchedulerReadModel> => {
    const account = rebuildAccount(dag, facts);
    const projection = projectSchedulerState(
      { dag, ...facts },
      {
        operation_id: dag.operation_id,
        observed_at: now(),
        slots: pool.snapshot(),
        tasks: [],
      },
    );
    return {
      operation_id: dag.operation_id,
      plan_digest: dag.plan_digest,
      projection,
      budget: {
        limit: dag.iteration_budget,
        remaining: remainingBudget(account),
        reserved_task_ids: Object.keys(account.reservations).sort(),
      },
      pending_approvals: [...facts.approvals],
      blocking_findings: facts.findings.filter(isOpenBlockingFinding),
    };
  };

  const blockingFinding = (input: {
    readonly dag: TaskDagSnapshot;
    readonly task_id: string;
    readonly task_digest: string;
    readonly rule: string;
    readonly summary: string;
  }): FeedbackRecord => {
    const content = {
      protocol_version: PROTOCOL_1_3_VERSION,
      record_kind: "feedback" as const,
      id: digestId("finding", {
        iteration_id: input.dag.iteration_id,
        task_id: input.task_id,
        rule: input.rule,
      }),
      type: "Finding" as const,
      iteration_id: input.dag.iteration_id,
      status: "proposed" as const,
      summary: input.summary,
      created_at: now(),
      extensions: {
        "harness.finding": {
          origin: "scheduler",
          blocking: true,
          violates: [],
          blocks: [input.task_id],
          evidence: [],
          rule: input.rule,
          severity: "error",
          actionability: "human_review",
          subject_ids: [input.task_id],
          subject_digests: [input.task_digest],
        },
      },
    };
    return { ...content, digest: contentDigest(content) };
  };

  const runStartedRecord = (input: {
    readonly operation_id: string;
    readonly task_id: string;
    readonly run_id: string;
    readonly context_bundle_id: string;
  }): RunRecord => ({
    protocol_version: PROTOCOL_1_3_VERSION,
    record_kind: "run_started",
    run_id: input.run_id,
    task_id: input.task_id,
    workflow_operation_id: input.operation_id,
    attempt_id: digestId("attempt", { run_id: input.run_id }),
    sequence: 1,
    timestamp: now(),
    context_bundle_id: input.context_bundle_id,
  });

  const runTerminatedRecord = (input: {
    readonly operation_id: string;
    readonly task_id: string;
    readonly run_id: string;
    readonly outcome:
      "success" | "correct_block" | "clarification_required" | "handoff" | "partial" | "failed";
    readonly termination_reason:
      | "completion"
      | "gate_failure"
      | "policy_denial"
      | "budget_ceiling"
      | "repeat_detection"
      | "timeout"
      | "adapter_failure"
      | "user_cancellation"
      | "manual_stop"
      | "process_interruption";
  }): RunRecord => ({
    protocol_version: PROTOCOL_1_3_VERSION,
    record_kind: "run_terminated",
    run_id: input.run_id,
    task_id: input.task_id,
    workflow_operation_id: input.operation_id,
    attempt_id: digestId("attempt", { run_id: input.run_id }),
    sequence: 2,
    timestamp: now(),
    outcome: input.outcome,
    termination_reason: input.termination_reason,
  });

  const runInterruptedRecord = (input: {
    readonly operation_id: string;
    readonly task_id: string;
    readonly run_id: string;
  }): RunRecord => ({
    protocol_version: PROTOCOL_1_3_VERSION,
    record_kind: "run_interrupted",
    run_id: input.run_id,
    task_id: input.task_id,
    workflow_operation_id: input.operation_id,
    attempt_id: digestId("attempt", { run_id: input.run_id }),
    sequence: 2,
    timestamp: now(),
    outcome: "failed",
    termination_reason: "process_interruption",
    partial_evidence_ids: [],
  });

  interface DispatchEntry {
    readonly candidate: ReadyTaskCandidate;
    readonly lease: TaskLeaseRecord;
    readonly grant: CapabilityGrant;
    readonly workspace: TaskExecutionWorkspace;
    readonly run_id: string;
    readonly settled: Promise<
      | { readonly ok: true; readonly result: AgentRunResult }
      | { readonly ok: false; readonly error: unknown }
    >;
  }

  const classifyRun = async (
    dag: TaskDagSnapshot,
    entry: DispatchEntry,
    settled: Awaited<DispatchEntry["settled"]>,
  ): Promise<void> => {
    const { candidate, lease } = entry;
    const task = candidate.task;
    const closeCommand = (purpose: string): string =>
      digestId("command", {
        purpose,
        operation_id: dag.operation_id,
        plan_digest: dag.plan_digest,
        task_id: task.id,
        attempt_number: lease.attempt_number,
      });
    // The adapter outcome is recorded as claimed, except `success`: only the
    // Harness may mint a terminal success after evidence verification, so a
    // claimed success degrades to a handoff claim.
    const terminated = (
      outcome: AgentRunResult["outcome"],
      reason:
        | "completion"
        | "gate_failure"
        | "policy_denial"
        | "budget_ceiling"
        | "repeat_detection"
        | "timeout"
        | "adapter_failure"
        | "user_cancellation"
        | "manual_stop"
        | "process_interruption",
    ): SchedulerTransition => ({
      kind: "record_run",
      record: runTerminatedRecord({
        operation_id: dag.operation_id,
        task_id: task.id,
        run_id: entry.run_id,
        outcome: outcome === "success" ? "handoff" : outcome,
        termination_reason: reason,
      }),
    });

    if (!settled.ok) {
      // The adapter threw: an executor crash with no measurable consumption.
      await classifyCrash(dag, entry, { steps: 0, tokens: 0 }, [
        terminated("failed", "adapter_failure"),
      ]);
      return;
    }

    const result = settled.result;
    const consumed = meteredConsumption(result);

    if (result.undeclared_writes.length > 0) {
      // Undeclared writes never auto-retry (design §15.1).
      await authority.commit([
        terminated(result.outcome, result.termination_reason),
        {
          kind: "terminate_lease",
          record: terminateTaskLease(lease, {
            state: "revoked",
            consumed_budget: consumed,
            command_id: closeCommand("undeclared-write-revoke"),
          }),
        },
        {
          kind: "create_finding",
          finding: blockingFinding({
            dag,
            task_id: task.id,
            task_digest: candidate.task_digest,
            rule: "undeclared_write",
            summary:
              `task ${task.id} wrote outside its declared write set: ` +
              result.undeclared_writes.join(", "),
          }),
        },
      ]);
      return;
    }

    if (result.termination_reason === "user_cancellation") {
      await authority.commit([
        terminated(result.outcome, "user_cancellation"),
        {
          kind: "terminate_lease",
          record: terminateTaskLease(lease, {
            state: "revoked",
            consumed_budget: consumed,
            command_id: closeCommand("cancellation-revoke"),
          }),
        },
      ]);
      return;
    }

    if (CRASH_TERMINATIONS.has(result.termination_reason)) {
      const reason = result.termination_reason as
        "adapter_failure" | "timeout" | "process_interruption";
      await classifyCrash(dag, entry, consumed, [terminated(result.outcome, reason)]);
      return;
    }

    if (result.termination_reason === "completion" && result.completion_claimed) {
      // The claim alone changes nothing: the workspace manager re-derives the
      // candidate from the worktree and attests the write set first.
      try {
        const patch = await options.workspaces.collectTaskCandidate({
          task,
          workspace: entry.workspace,
          task_grant: entry.grant,
        });
        await authority.commit([
          terminated(result.outcome, "completion"),
          {
            kind: "append_evidence",
            evidence: [
              ...result.evidence.map((evidence) => ({
                kind: evidence.kind,
                locator: evidence.locator,
                digest: evidence.digest,
              })),
              {
                kind: "task_candidate_patch",
                locator: patch.patch_locator,
                digest: patch.patch_digest,
              },
            ],
          },
          {
            kind: "terminate_lease",
            record: terminateTaskLease(lease, {
              state: "released",
              consumed_budget: consumed,
              command_id: closeCommand("completion-release"),
            }),
          },
          {
            kind: "append_event",
            event: taskIntegrationQueuedEvent({
              operation_id: dag.operation_id,
              task_id: task.id,
              run_id: entry.run_id,
              patch_digest: patch.patch_digest,
            }),
          },
        ]);
      } catch (error) {
        // Write-set/policy violations keep the workspace as diagnostic
        // evidence; the Task blocks without consuming a retry (§12/§15.1).
        await authority.commit([
          terminated("failed", "policy_denial"),
          {
            kind: "terminate_lease",
            record: terminateTaskLease(lease, {
              state: "revoked",
              consumed_budget: consumed,
              command_id: closeCommand("write-set-revoke"),
            }),
          },
          {
            kind: "create_finding",
            finding: blockingFinding({
              dag,
              task_id: task.id,
              task_digest: candidate.task_digest,
              rule: "write_set_violation",
              summary: `task ${task.id} candidate failed write-set attestation: ${messageOf(error)}`,
            }),
          },
        ]);
      }
      return;
    }

    // Any other terminal result is not retryable at the scheduler level.
    await authority.commit([
      terminated(result.outcome, result.termination_reason),
      {
        kind: "terminate_lease",
        record: terminateTaskLease(lease, {
          state: "released",
          consumed_budget: consumed,
          command_id: closeCommand("terminal-release"),
        }),
      },
      {
        kind: "create_finding",
        finding: blockingFinding({
          dag,
          task_id: task.id,
          task_digest: candidate.task_digest,
          rule: `run_${result.termination_reason}`,
          summary: `task ${task.id} terminated with ${result.termination_reason}: ${result.summary}`,
        }),
      },
    ]);
  };

  /** Crash classification: one executor retry on the remaining budget, then blocked. */
  const classifyCrash = async (
    dag: TaskDagSnapshot,
    entry: DispatchEntry,
    consumed: BudgetAmount,
    runTransitions: readonly SchedulerTransition[],
  ): Promise<void> => {
    const { candidate, lease } = entry;
    const task = candidate.task;
    const closeCommand = (purpose: string): string =>
      digestId("command", {
        purpose,
        operation_id: dag.operation_id,
        plan_digest: dag.plan_digest,
        task_id: task.id,
        attempt_number: lease.attempt_number,
      });
    const wasRetry = lease.retry_kind !== undefined;
    const remainingSteps = candidate.reservation.steps - consumed.steps;
    const remainingTokens = candidate.reservation.tokens - consumed.tokens;
    if (!wasRetry && remainingSteps > 0 && remainingTokens > 0) {
      await authority.commit([
        ...runTransitions,
        {
          kind: "terminate_lease",
          record: terminateTaskLease(lease, {
            state: "expired",
            consumed_budget: consumed,
            command_id: closeCommand("crash-expire"),
          }),
        },
        {
          kind: "append_event",
          event: taskRetryScheduledEvent({
            operation_id: dag.operation_id,
            task_id: task.id,
            retry_kind: "executor_retry",
            attempt_number: lease.attempt_number + 1,
            reason: "executor crashed; the single executor retry is scheduled",
          }),
        },
      ]);
      return;
    }
    await authority.commit([
      ...runTransitions,
      {
        kind: "terminate_lease",
        record: terminateTaskLease(lease, {
          state: "expired",
          consumed_budget: consumed,
          command_id: closeCommand("crash-expire"),
        }),
      },
      {
        kind: "create_finding",
        finding: blockingFinding({
          dag,
          task_id: task.id,
          task_digest: candidate.task_digest,
          rule: wasRetry ? "retry_exhausted" : "budget_exhausted",
          summary: wasRetry
            ? `task ${task.id} crashed again after its executor retry; no further automatic recovery`
            : `task ${task.id} has no remaining budget for its executor retry`,
        }),
      },
    ]);
  };

  const dispatchCandidate = async (
    dag: TaskDagSnapshot,
    facts: SchedulerLedgerFacts,
    account: IterationBudgetAccount,
    candidate: ReadyTaskCandidate,
    slotId: string,
  ): Promise<{ readonly entry?: DispatchEntry; readonly account: IterationBudgetAccount }> => {
    const task = candidate.task;
    const deadline = deriveIterationDeadline(dag, facts.leases, now());
    const iterationRemaining = remainingBudget(account);
    const policyInput: SchedulerPolicyInput = {
      action: candidate.retry_kind === undefined ? "dispatch_task" : "retry_task",
      operation_id: dag.operation_id,
      iteration_id: dag.iteration_id,
      plan_digest: dag.plan_digest,
      task_digest: candidate.task_digest,
      wave_index: candidate.wave_index,
      baseline_commit: dag.baseline_commit,
      risk: task.risk,
      capabilities: task.capabilities,
      tools: task.tools,
      write_paths: task.write_paths,
      exclusive_resources: task.exclusive_resources,
      task_remaining_budget: {
        steps: candidate.reservation.steps,
        tokens: candidate.reservation.tokens,
        duration_ms: task.budget.duration_ms,
      },
      iteration_remaining_budget: {
        steps: iterationRemaining.steps,
        tokens: iterationRemaining.tokens,
        duration_ms: Math.max(0, Date.parse(deadline) - Date.parse(now())),
      },
      adapter_manifest_digest: options.adapter_manifest_digest,
      adapter_control_profile: options.adapter_control_profile,
      ...(candidate.retry_kind === undefined ? {} : { retry_kind: candidate.retry_kind }),
      effective_policy_digest: options.effective_policy_digest,
    };
    const expectedActionDigest = actionDigest(schedulerPolicyAction(policyInput));
    const decision = await options.policy.decide(policyInput);

    if (decision.outcome === "deny") {
      await authority.commit([
        {
          kind: "create_finding",
          finding: blockingFinding({
            dag,
            task_id: task.id,
            task_digest: candidate.task_digest,
            rule: "policy_denial",
            summary: `dispatch of task ${task.id} denied: ${decision.reasons.join("; ")}`,
          }),
        },
      ]);
      return { account };
    }
    if (decision.outcome === "block") {
      // block is not deny: no approval can convert it, only a re-formed
      // conflict-free effective policy may retry the action (design §11).
      await authority.commit([
        {
          kind: "create_finding",
          finding: blockingFinding({
            dag,
            task_id: task.id,
            task_digest: candidate.task_digest,
            rule: "policy_conflict",
            summary: `dispatch of task ${task.id} blocked by a policy conflict: ${decision.reasons.join("; ")}`,
          }),
        },
      ]);
      return { account };
    }
    if (decision.outcome === "requires_approval" && decision.approval_digest === undefined) {
      // Exactly one digest-bound request; only this Task pauses.
      const request = buildApprovalRequest({
        requestId: digestId("approval-request", {
          operation_id: dag.operation_id,
          task_id: task.id,
          action_digest: expectedActionDigest,
        }),
        workflowOperationId: dag.operation_id,
        objectId: task.id,
        objectType: "scheduler_action",
        objectDigest: expectedActionDigest,
        baselineDigest: contentDigest({ baseline_commit: dag.baseline_commit }),
        policyDigest: decision.effective_policy_digest,
        impactPath: [],
        risk: task.risk,
        reason:
          decision.reasons.join("; ").length > 0
            ? decision.reasons.join("; ")
            : `policy requires approval to dispatch task ${task.id}`,
        allowedDecisions: ["approve", "reject"],
        createdAt: now(),
        resumePhase: "execute",
        proposedBy: "harness",
      });
      await authority.commit([{ kind: "request_approval", request }]);
      return { account };
    }

    // allow (or requires_approval satisfied by its approval digest): reserve
    // budget and grant the Lease in one authoritative commit before any
    // process starts.
    const commandId = digestId("command", {
      purpose: candidate.retry_kind === undefined ? "dispatch" : candidate.retry_kind,
      operation_id: dag.operation_id,
      plan_digest: dag.plan_digest,
      task_id: task.id,
      attempt_number: candidate.attempt_number,
    });
    const leaseId = deriveTaskLeaseId(task.id, candidate.attempt_number, commandId);
    const reservation = reserveTaskBudget(account, {
      task_id: task.id,
      lease_id: leaseId,
      fencing_token: candidate.fencing_token,
      task_budget: task.budget,
      task_remaining_duration_ms: task.budget.duration_ms,
      steps: candidate.reservation.steps,
      tokens: candidate.reservation.tokens,
      now: now(),
    });
    const runId = digestId("run", {
      operation_id: dag.operation_id,
      task_id: task.id,
      attempt_number: candidate.attempt_number,
    });
    const lease = grantTaskLease({
      chain: buildTaskLeaseChain(facts.leases),
      decision,
      expected_action_digest: expectedActionDigest,
      operation_id: dag.operation_id,
      iteration_id: dag.iteration_id,
      plan_digest: dag.plan_digest,
      task_id: task.id,
      task_digest: candidate.task_digest,
      run_id: runId,
      slot_id: slotId,
      baseline_commit: dag.baseline_commit,
      agent_adapter_digest: options.adapter_manifest_digest,
      reserved_budget: reservation.reserved_budget,
      issued_at: now(),
      expires_at: reservation.expires_at,
      command_id: commandId,
      ...(candidate.retry_kind === undefined ? {} : { retry_kind: candidate.retry_kind }),
    });
    await authority.commit([
      { kind: "grant_lease", record: lease },
      {
        kind: "append_event",
        event: taskLeaseGrantedEvent({
          operation_id: dag.operation_id,
          task_id: task.id,
          lease_id: lease.lease_id,
          slot_id: slotId,
          fencing_token: lease.fencing_token,
          plan_digest: dag.plan_digest,
        }),
      },
    ]);

    try {
      // design §9 step 9: worktree → ContextBundle → CapabilityGrant → envelope.
      const workspace = await options.workspaces.prepareTaskWorkspace({
        task,
        baseline_commit: dag.baseline_commit,
        slot_id: slotId,
      });
      const context = await options.callbacks.assembleContext({
        task,
        run_id: runId,
        attempt_number: candidate.attempt_number,
      });
      const grant = options.callbacks.issueTaskGrant({
        task,
        decision,
        lease,
        reservation: reservation.reserved_budget,
      });
      const envelope = options.callbacks.buildEnvelope({
        task,
        grant,
        context,
        lease,
        workspace,
      });
      // design §9 step 10: the pool starts only after the Lease commit landed.
      const runPromise = pool.run({
        task_id: task.id,
        run_id: runId,
        workspace_root: workspace.root,
        evidence_dir: options.callbacks.evidenceDir({ task_id: task.id, run_id: runId }),
        envelope,
        mode: options.unattended_eligible ? "unattended" : "supervised",
      });
      // Wrap immediately so a fast rejection is never unhandled while later
      // candidates are still being dispatched.
      const settled = runPromise.then(
        (outcome) => ({ ok: true as const, result: outcome.result }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await authority.commit([
        {
          kind: "record_run",
          record: runStartedRecord({
            operation_id: dag.operation_id,
            task_id: task.id,
            run_id: runId,
            context_bundle_id: context.context_bundle_id,
          }),
        },
        {
          kind: "append_event",
          event: taskDispatchedEvent({
            operation_id: dag.operation_id,
            task_id: task.id,
            run_id: runId,
            slot_id: slotId,
            attempt_number: candidate.attempt_number,
            worktree_root: workspace.root,
          }),
        },
      ]);
      return {
        entry: {
          candidate,
          lease,
          grant,
          workspace,
          run_id: runId,
          settled,
        },
        account: reservation.account,
      };
    } catch (error) {
      // Preparation failed after the grant committed: close the fresh Lease
      // and block the Task instead of leaving an orphan for recovery.
      await authority.commit([
        {
          kind: "terminate_lease",
          record: terminateTaskLease(lease, {
            state: "revoked",
            consumed_budget: { steps: 0, tokens: 0 },
            command_id: digestId("command", {
              purpose: "dispatch-preparation-revoke",
              operation_id: dag.operation_id,
              task_id: task.id,
              attempt_number: candidate.attempt_number,
            }),
          }),
        },
        {
          kind: "create_finding",
          finding: blockingFinding({
            dag,
            task_id: task.id,
            task_digest: candidate.task_digest,
            rule: "dispatch_preparation_failed",
            summary: `task ${task.id} dispatch preparation failed: ${messageOf(error)}`,
          }),
        },
      ]);
      return { account: reservation.account };
    }
  };

  const statusOf = (readModel: SchedulerReadModel): SchedulerDriveStatus => {
    const statuses = readModel.projection.tasks.map((task) => task.status);
    if (statuses.includes("blocked")) return "blocked";
    if (statuses.includes("awaiting_approval")) return "paused";
    if (
      statuses.includes("running") ||
      statuses.includes("ready") ||
      statuses.includes("retry_pending")
    ) {
      // Work remains but nothing was dispatchable this pass; a human or a
      // later driver must move it. Not reachable after the blocking pass
      // converted every persistent exclusion into a Finding.
      return "paused";
    }
    return "completed";
  };

  /**
   * Integration retry synthesis (design §13.4/§15.1): a Task whose candidate
   * failed to apply once carries an open non-blocking
   * `integration_retry_scheduled` Finding and stays `verifying` — ordinary
   * readiness never selects it again. Exactly one re-dispatch is synthesized
   * here, on the latest integrated commit, with the retry kind recorded on the
   * Lease so a later pass (or a recovered process) can never spend it twice.
   */
  const synthesizeIntegrationRetries = (
    dag: TaskDagSnapshot,
    facts: SchedulerLedgerFacts,
    account: IterationBudgetAccount,
    capacity: number,
  ): ReadyTaskCandidate[] => {
    if (!Number.isInteger(capacity) || capacity < 1) return [];
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
    const available = remainingBudget(account);
    let stepsLeft = available.steps;
    let tokensLeft = available.tokens;
    let slotsLeft = capacity;
    const selected: ReadyTaskCandidate[] = [];
    for (const status of projection.tasks) {
      if (slotsLeft === 0) break;
      if (status.status !== "verifying") continue;
      if (!hasOpenFindingRule(facts.findings, "integration_retry_scheduled", status.task_id)) {
        continue;
      }
      const consumedRetry = chain.records.some(
        (record) => record.task_id === status.task_id && record.retry_kind === "integration_retry",
      );
      if (consumedRetry) continue;
      const task = dag.tasks.find((candidate) => candidate.id === status.task_id);
      if (task === undefined) continue;
      // The retry only ever spends the original Task budget's remainder (§15.1).
      const consumed = account.consumed[task.id] ?? { steps: 0, tokens: 0 };
      const reservation: BudgetAmount = {
        steps: task.budget.steps - consumed.steps,
        tokens: task.budget.tokens - consumed.tokens,
      };
      if (reservation.steps <= 0 || reservation.tokens <= 0) continue;
      if (reservation.steps > stepsLeft || reservation.tokens > tokensLeft) continue;
      const latest = chain.latest_by_task.get(task.id);
      stepsLeft -= reservation.steps;
      tokensLeft -= reservation.tokens;
      slotsLeft -= 1;
      selected.push({
        task,
        task_digest: taskSemanticDigest(task),
        wave_index: status.wave_index ?? 0,
        retry_kind: "integration_retry",
        attempt_number: (latest?.attempt_number ?? 0) + 1,
        fencing_token: nextFencingToken(chain, task.id),
        reservation,
      });
    }
    return selected;
  };

  const executeDrive = async (
    input: SchedulerDriveInput,
    dag: TaskDagSnapshot,
  ): Promise<SchedulerDriveResult> => {
    // Two retry kinds per Task (executor + integration) plus the initial
    // attempt bound the pass count.
    const maxPasses = dag.tasks.length * 3 + 2;
    /** Integration retries spent by this drive; see the blocking pass below. */
    const retriedThisDrive = new Set<string>();
    for (let pass = 0; ; pass += 1) {
      if (pass > maxPasses) {
        throw new SchedulerError(
          "scheduling_loop_inconclusive",
          `operation ${input.operation_id} did not converge after ${String(maxPasses)} passes`,
        );
      }
      const facts = await authority.readFacts(input.operation_id);
      const staleIds = options.callbacks.readStaleContextTaskIds?.(dag, facts) ?? [];
      const chain = buildTaskLeaseChain(facts.leases);
      const account = rebuildAccount(dag, facts);
      const table = rebuildResourceLocks(dag.tasks, chain);
      const effective = effectiveMaxConcurrency({
        runtime_requested: input.requested_max_concurrency,
        profile_limit: options.ceilings.profile_limit,
        installation_limit: options.ceilings.installation_limit,
        project_limit: options.ceilings.project_limit,
        local_resource_limit: options.ceilings.local_resource_limit,
        unattended_eligible: options.unattended_eligible,
      });
      const idleSlots = pool
        .snapshot()
        .filter((slot) => slot.state === "idle")
        .map((slot) => slot.slot_id);
      const selected = selectReadyTasks({
        dag,
        facts: { ...readinessFacts(facts), stale_context_task_ids: staleIds },
        resources: table,
        budget: account,
        adapter: {
          unattended_eligible: options.unattended_eligible,
          capabilities: options.adapter_capabilities,
        },
        available_slots: idleSlots.length,
        effective_max_concurrency: effective,
      });
      const dispatchable =
        selected.length > 0
          ? selected
          : synthesizeIntegrationRetries(
              dag,
              facts,
              account,
              Math.min(idleSlots.length, effective),
            );
      if (dispatchable.length === 0) break;

      const running: DispatchEntry[] = [];
      let workingAccount = account;
      let slotCursor = 0;
      for (const candidate of dispatchable) {
        // Slot identity is pre-assigned in scan order; the pool hands out the
        // same first-idle slot because runs start in this exact order.
        const slotId = idleSlots[slotCursor] ?? `slot_${String(slotCursor + 1)}`;
        slotCursor += 1;
        if (candidate.retry_kind === "integration_retry") {
          // The blocking pass must not judge a retry this drive just spent:
          // the controller has not re-attempted the apply yet.
          retriedThisDrive.add(candidate.task.id);
        }
        const dispatched = await dispatchCandidate(dag, facts, workingAccount, candidate, slotId);
        workingAccount = dispatched.account;
        if (dispatched.entry !== undefined) running.push(dispatched.entry);
      }
      // design §9 step 11: classify results in Plan order, after every slot
      // of the pass started — never at first-completion time.
      for (const entry of running) {
        const settled = await entry.settled;
        await classifyRun(dag, entry, settled);
      }
    }

    // Blocking pass: every ready/retry_pending Task still standing was excluded
    // for a persistent reason (stale context, capability mismatch, exhausted
    // budget). Convert it into an actionable Finding instead of dispatching
    // silently or looping forever (design §10.1/§15.1).
    const finalFacts = await authority.readFacts(input.operation_id);
    const finalStaleIds = options.callbacks.readStaleContextTaskIds?.(dag, finalFacts) ?? [];
    const finalAccount = rebuildAccount(dag, finalFacts);
    const finalChain = buildTaskLeaseChain(finalFacts.leases);
    const finalProjection = projectSchedulerState({ dag, ...finalFacts }, null);
    // A Task still verifying with its single integration retry consumed is
    // stuck: mint the blocking integration_conflict Finding exactly once
    // (design §13.4: one retry, then blocked).
    for (const status of finalProjection.tasks) {
      if (status.status !== "verifying") continue;
      if (!hasOpenFindingRule(finalFacts.findings, "integration_retry_scheduled", status.task_id)) {
        continue;
      }
      const consumedRetry = finalChain.records.some(
        (record) => record.task_id === status.task_id && record.retry_kind === "integration_retry",
      );
      if (!consumedRetry) continue;
      if (retriedThisDrive.has(status.task_id)) continue;
      if (hasOpenFindingRule(finalFacts.findings, "integration_conflict", status.task_id)) continue;
      const task = dag.tasks.find((candidate) => candidate.id === status.task_id);
      if (task === undefined) continue;
      await authority.commit([
        {
          kind: "create_finding",
          finding: blockingFinding({
            dag,
            task_id: task.id,
            task_digest: taskSemanticDigest(task),
            rule: "integration_conflict",
            summary:
              `task ${task.id} is still unintegrated after its single integration retry; ` +
              "no further automatic recovery",
          }),
        },
      ]);
    }
    const adapterCapabilities = new Set(options.adapter_capabilities);
    for (const status of finalProjection.tasks) {
      if (status.status !== "ready" && status.status !== "retry_pending") continue;
      const task = dag.tasks.find((candidate) => candidate.id === status.task_id);
      if (task === undefined) continue;
      const taskDigest = taskSemanticDigest(task);
      let rule: string | undefined;
      let summary: string | undefined;
      if (finalStaleIds.includes(task.id)) {
        rule = "stale_context";
        summary = `task ${task.id} context bundle is stale against current sources/bindings`;
      } else if (!task.capabilities.every((capability) => adapterCapabilities.has(capability))) {
        rule = "capability_mismatch";
        summary =
          `task ${task.id} requires capabilities the configured adapter cannot satisfy: ` +
          task.capabilities.filter((capability) => !adapterCapabilities.has(capability)).join(", ");
      } else {
        const consumed = finalAccount.consumed[task.id] ?? { steps: 0, tokens: 0 };
        const remainder = {
          steps: task.budget.steps - consumed.steps,
          tokens: task.budget.tokens - consumed.tokens,
        };
        const availableNow = remainingBudget(finalAccount);
        if (
          remainder.steps <= 0 ||
          remainder.tokens <= 0 ||
          remainder.steps > availableNow.steps ||
          remainder.tokens > availableNow.tokens
        ) {
          rule = "budget_exhausted";
          summary = `task ${task.id} has insufficient remaining Task/iteration budget to dispatch`;
        }
      }
      if (rule === undefined || summary === undefined) continue;
      await authority.commit([
        {
          kind: "create_finding",
          finding: blockingFinding({
            dag,
            task_id: task.id,
            task_digest: taskDigest,
            rule,
            summary,
          }),
        },
      ]);
    }

    const readModel = await buildReadModel(dag, await authority.readFacts(input.operation_id));
    return { status: statusOf(readModel), operation_id: input.operation_id, read_model: readModel };
  };

  const cancelledResult = async (
    dag: TaskDagSnapshot,
    operationId: string,
  ): Promise<SchedulerDriveResult> => ({
    status: "cancelled",
    operation_id: operationId,
    read_model: await buildReadModel(dag, await authority.readFacts(operationId)),
  });

  return {
    async drive(input) {
      assertDriverLock(input.driver_lock, input.operation_id);
      const dag = await options.dag_port.readApproved({
        operation_id: input.operation_id,
        expected_plan_digest: input.expected_plan_digest,
      });
      if (cancelledOperations.has(input.operation_id)) {
        return cancelledResult(dag, input.operation_id);
      }
      // A granted Lease at drive entry belongs to a dead driver: fail closed
      // and route through recover() (design §16).
      const facts = await authority.readFacts(input.operation_id);
      // P2-2: a durable user_cancellation terminal Run cancels the operation
      // for every future process, not just this one.
      if (hasDurableCancellation(facts, input.operation_id)) {
        return cancelledResult(dag, input.operation_id);
      }
      const chain = buildTaskLeaseChain(facts.leases);
      const orphaned = [...chain.latest_by_task.values()].filter(
        (record) => record.state === "granted",
      );
      if (orphaned.length > 0) {
        throw new SchedulerError(
          "recovery_required",
          `operation ${input.operation_id} has ${String(orphaned.length)} granted lease(s) ` +
            "without a live driver; run recover() before driving again",
        );
      }
      return executeDrive(input, dag);
    },

    async recover(input) {
      assertDriverLock(input.driver_lock, input.operation_id);
      const dag = await options.dag_port.readApproved({
        operation_id: input.operation_id,
        expected_plan_digest: input.expected_plan_digest,
      });
      if (cancelledOperations.has(input.operation_id)) {
        return cancelledResult(dag, input.operation_id);
      }
      const facts = await authority.readFacts(input.operation_id);
      if (hasDurableCancellation(facts, input.operation_id)) {
        return cancelledResult(dag, input.operation_id);
      }
      const chain = buildTaskLeaseChain(facts.leases);
      const orphaned = [...chain.latest_by_task.values()]
        .filter((record) => record.state === "granted")
        .sort((left, right) => left.task_id.localeCompare(right.task_id));
      if (orphaned.length > 0) {
        const transitions: SchedulerTransition[] = [];
        for (const lease of orphaned) {
          // Best-effort cooperative stop; a dead process is already gone.
          try {
            await pool.cancel(lease.run_id);
          } catch (error) {
            if (!(error instanceof AgentPoolError && error.kind === "unknown_run")) throw error;
          }
          // The orphan's external effects are uncertain: the interruption is
          // authoritative, its output can only ever be provisional (§16).
          transitions.push({
            kind: "record_run",
            record: runInterruptedRecord({
              operation_id: dag.operation_id,
              task_id: lease.task_id,
              run_id: lease.run_id,
            }),
          });
          transitions.push({
            kind: "terminate_lease",
            record: terminateTaskLease(lease, {
              state: "revoked",
              consumed_budget: lease.consumed_budget,
              command_id: digestId("command", {
                purpose: "recovery-revoke",
                recovery_command_id: input.recovery_command_id,
                task_id: lease.task_id,
                attempt_number: lease.attempt_number,
              }),
            }),
          });
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
      return executeDrive(input, dag);
    },

    async cancel(input) {
      assertDriverLock(input.driver_lock, input.operation_id);
      cancelledOperations.add(input.operation_id);
      const dag = await options.dag_port.readApproved({ operation_id: input.operation_id });
      const facts = await authority.readFacts(input.operation_id);
      const chain = buildTaskLeaseChain(facts.leases);
      const active = [...chain.latest_by_task.values()]
        .filter((record) => record.state === "granted")
        .sort((left, right) => left.task_id.localeCompare(right.task_id));
      for (const lease of active) {
        let confirmed = true;
        try {
          // Cooperative cancellation: the adapter's own result is the only
          // termination accounting; intent alone proves nothing (§15.2).
          await pool.cancel(lease.run_id);
        } catch (error) {
          if (error instanceof AgentPoolError && error.kind === "unknown_run") {
            confirmed = false;
          } else {
            throw error;
          }
        }
        const transitions: SchedulerTransition[] = [
          {
            kind: "record_run",
            record: runTerminatedRecord({
              operation_id: dag.operation_id,
              task_id: lease.task_id,
              run_id: lease.run_id,
              outcome: "partial",
              termination_reason: "user_cancellation",
            }),
          },
          {
            kind: "terminate_lease",
            record: terminateTaskLease(lease, {
              state: "revoked",
              consumed_budget: lease.consumed_budget,
              command_id: digestId("command", {
                purpose: "cancel-revoke",
                command_id: input.command_id,
                task_id: lease.task_id,
                attempt_number: lease.attempt_number,
              }),
            }),
          },
        ];
        if (!confirmed) {
          // Uncertain external effects follow the existing semantics: they
          // must be reconciled before any retry, so the Task also earns a
          // blocking Finding alongside its cancelled projection. The lease
          // binds a Task of the approved plan, so the lookup always succeeds.
          const cancelledTask = dag.tasks.find((candidate) => candidate.id === lease.task_id);
          if (cancelledTask === undefined) {
            throw new SchedulerError(
              "scheduling_loop_inconclusive",
              `lease ${lease.lease_id} names task ${lease.task_id}, which has no specification in the approved plan`,
            );
          }
          transitions.push({
            kind: "create_finding",
            finding: blockingFinding({
              dag,
              task_id: cancelledTask.id,
              task_digest: lease.task_digest,
              rule: "cancellation_uncertain",
              summary:
                `cancellation of task ${lease.task_id} could not be confirmed (run ${lease.run_id} ` +
                "was not live); reconcile external side effects before any retry",
            }),
          });
        }
        await authority.commit(transitions);
      }
      // Diagnostic evidence and worktrees are preserved: nothing is discarded.
      return cancelledResult(dag, input.operation_id);
    },

    async read(operationId) {
      const dag = await options.dag_port.readApproved({ operation_id: operationId });
      return buildReadModel(dag, await authority.readFacts(operationId));
    },

    async acceptRunResult(input) {
      // Only the current fencing token's output may enter verification or
      // integration; anything older fails closed here (design §8.2/§16).
      const facts = await authority.readFacts(input.operation_id);
      const chain = buildTaskLeaseChain(facts.leases);
      assertCurrentFencingToken(chain, input.task_id, input.fencing_token);
    },
  };
}
