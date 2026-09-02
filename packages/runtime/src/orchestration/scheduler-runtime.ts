import {
  assertSchedulingRecordSemantics,
  canonicalizeJson,
  contentDigest,
  harnessRootFor,
  PROTOCOL_1_3_VERSION,
  resolveHarnessPath,
  sha256Hex,
  transactionRequiredReaderVersion,
  validateSchema,
  type CapabilityPlanRecord,
  type CommittedOperation,
  type FeedbackRecord,
  type LeaseRecord,
  type LifecycleEvent,
  type SchedulingRecord,
  type TaskLeaseRecord,
  type WaveIntegrationRecord,
} from "@universal-harness-internal/core";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  approvalRequestArtifact,
  buildApprovalRequest,
  readPendingApprovalRequests,
} from "../approval/request.js";
import type { GateEvidenceRecord } from "../gates/evidence.js";
import { actionDigest, type AdapterControlProfile } from "../policy/action.js";
import {
  artifactDigestAllowlist,
  listArtifactFiles,
  readVerifiedArtifact,
} from "../workflow/checkpoint.js";
import {
  ledgerRepositoryFor,
  nextEventSequence,
  readCurrentOperation,
  readRunStreams,
  runRecordArtifactPath,
  type WorkflowDependencies,
} from "../workflow/operation.js";

import type { DriverLockHandle } from "../scheduling/driver-lock.js";
import {
  schedulingEvidenceBindingOf,
  waveIntegrationPolicyInput,
  type CandidateIntegrationController,
} from "../scheduling/integration.js";
import { schedulerPolicyAction } from "../scheduling/policy-adapters.js";
import type { PolicyDecisionPort, TaskDagPort, TaskDagSnapshot } from "../scheduling/ports.js";
import { projectSchedulerState } from "../scheduling/projection.js";
import {
  type LocalTaskScheduler,
  type QueuedCandidateFact,
  type SchedulerAuthority,
  type SchedulerLedgerFacts,
  type SchedulerTransition,
} from "../scheduling/scheduler.js";
import type { DagNodeRunner } from "../workflow/dag.js";
import { schedulerPhaseLifecycleEvent, type PhaseLifecycleEventSpec } from "./lifecycle-events.js";

/**
 * Parallel execute subgraph driver (M4 design §10.2/§13, plan Task 11 step
 * 2). The Capability DAG marks `execute` with the `parallel_task_execution`
 * subgraph; this module is the runner behind that marker and the only caller
 * of LocalTaskScheduler inside the vertical loop. It verifies the active
 * Capability resolution, the Driver Lock and — in connected mode — the M3
 * Operation Lease before any scheduling, then alternates scheduler drives and
 * wave integration until every wave integrates, a recoverable Approval pause
 * occurs, cancellation lands or a blocker exists.
 *
 * The driver invents no global phase: checkpoints stay on the existing
 * Workflow Engine node journal (the DAG runner commits the `execute` node
 * once, with the wave_integration binding), and Kernel `verify` remains the
 * sole gate_evidence producer — this module never mints gate evidence, it
 * only consumes the candidate/wave evidence the integration controller
 * validated.
 */

export const PARALLEL_TASK_EXECUTION_ERROR_KINDS = [
  "capability_not_active",
  "capability_plan_binding_drift",
  "driver_lock_invalid",
  "operation_lease_invalid",
  "operation_not_found",
  "invalid_event",
  "scheduling_loop_inconclusive",
] as const;

export type ParallelTaskExecutionErrorKind = (typeof PARALLEL_TASK_EXECUTION_ERROR_KINDS)[number];

/** Fail-closed rejection raised before any scheduling happens. */
export class ParallelTaskExecutionError extends Error {
  readonly kind: ParallelTaskExecutionErrorKind;

  constructor(kind: ParallelTaskExecutionErrorKind, message: string) {
    super(message);
    this.name = "ParallelTaskExecutionError";
    this.kind = kind;
  }
}

export interface ParallelTaskExecutionPort {
  run(input: {
    readonly operation_id: string;
    readonly iteration_id: string;
    readonly capability_plan_digest: string;
    readonly expected_plan_digest: string;
    readonly driver_lock: DriverLockHandle;
    /**
     * Connected mode only: the current M3 Operation Lease (design §22). The
     * port validates the same fields SchedulerDriveInput consumes, so the full
     * LeaseRecord flows straight through to the scheduler drive.
     */
    readonly operation_lease?: LeaseRecord;
  }): Promise<ParallelTaskExecutionOutcome>;
}

export interface ParallelTaskExecutionOutcome {
  readonly status: "completed" | "paused" | "blocked" | "cancelled";
  readonly operation_id: string;
  readonly wave_integration_digests: readonly string[];
  readonly scheduler_state_digest: string;
}

export interface ParallelTaskExecutionDriverOptions {
  readonly scheduler: LocalTaskScheduler;
  readonly integration: CandidateIntegrationController;
  readonly authority: SchedulerAuthority;
  readonly dag_port: TaskDagPort;
  readonly policy: PolicyDecisionPort;
  /** The accepted CapabilityPlan whose DAG marked execute parallel. */
  readonly capability_plan: CapabilityPlanRecord;
  readonly requested_max_concurrency: number;
  readonly adapter_manifest_digest: string;
  readonly adapter_control_profile: AdapterControlProfile;
  readonly effective_policy_digest: string;
  /** ISO clock; injectable so replays are byte-deterministic. */
  readonly now?: () => string;
}

function digestId(prefix: string, parts: unknown): string {
  return `${prefix}_${contentDigest(parts).slice(0, 24)}`;
}

/**
 * The current lease of one Task: highest fencing token wins, and within one
 * token the terminal record supersedes the granted one (same semantics as the
 * projection's latestLeaseByTask; the driver reads raw Ledger facts that may
 * carry a whole chain per Task, so buildTaskLeaseChain's chain invariants do
 * not apply here).
 */
function latestLeaseByTask(leases: readonly TaskLeaseRecord[]): Map<string, TaskLeaseRecord> {
  const stateRank = (state: TaskLeaseRecord["state"]): number => (state === "granted" ? 0 : 1);
  const latest = new Map<string, TaskLeaseRecord>();
  for (const record of leases) {
    const current = latest.get(record.task_id);
    if (
      current === undefined ||
      record.fencing_token > current.fencing_token ||
      (record.fencing_token === current.fencing_token &&
        stateRank(record.state) >= stateRank(current.state))
    ) {
      latest.set(record.task_id, record);
    }
  }
  return latest;
}

/** The accepted plan must mark execute with the parallel subgraph (§10.2). */
export function capabilityPlanActivatesParallel(plan: CapabilityPlanRecord): boolean {
  return plan.operation_dag.nodes.some(
    // Protocol 1.3 plans (OperationDagNodeV13Record) reach here behind the 1.1
    // static type; the persisted schema admits the parallel marker.
    (node) =>
      node.node_id === "execute" &&
      (node.subgraph as string | undefined) === "parallel_task_execution",
  );
}

/** The wave base: the baseline for wave 0, else the previous wave's candidate. */
function waveBaseCommit(
  dag: TaskDagSnapshot,
  facts: SchedulerLedgerFacts,
  waveIndex: number,
): string {
  if (waveIndex === 0) return dag.baseline_commit;
  const previous = facts.wave_integrations.find(
    (record) => record.operation_id === dag.operation_id && record.wave_index === waveIndex - 1,
  );
  return previous?.candidate_commit ?? dag.baseline_commit;
}

export function driveParallelTaskExecution(
  options: ParallelTaskExecutionDriverOptions,
): ParallelTaskExecutionPort {
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async run(input): Promise<ParallelTaskExecutionOutcome> {
      // Binding verification precedes any scheduling (design §10.2/§16): the
      // exact accepted CapabilityPlan revision, its parallel execute marker,
      // this operation's Driver Lock and the connected-mode M3 Lease.
      if (input.capability_plan_digest !== options.capability_plan.record_digest) {
        throw new ParallelTaskExecutionError(
          "capability_plan_binding_drift",
          `capability plan digest ${input.capability_plan_digest} does not match the accepted ` +
            `revision ${options.capability_plan.record_digest}`,
        );
      }
      if (!capabilityPlanActivatesParallel(options.capability_plan)) {
        throw new ParallelTaskExecutionError(
          "capability_not_active",
          "the accepted CapabilityPlan does not activate parallel_task_execution for execute",
        );
      }
      if (input.driver_lock.operation_id !== input.operation_id) {
        throw new ParallelTaskExecutionError(
          "driver_lock_invalid",
          `driver lock belongs to operation ${input.driver_lock.operation_id}, not ${input.operation_id}`,
        );
      }
      if (input.operation_lease !== undefined) {
        const lease = input.operation_lease;
        if (
          lease.resource_kind !== "operation" ||
          lease.resource_id !== input.operation_id ||
          lease.state !== "granted" ||
          Date.parse(lease.expires_at) <= Date.parse(now())
        ) {
          throw new ParallelTaskExecutionError(
            "operation_lease_invalid",
            "connected mode requires a granted, unexpired M3 Operation Lease for this operation",
          );
        }
      }

      const digests: string[] = [];
      let lastReadModel: Awaited<ReturnType<LocalTaskScheduler["drive"]>>["read_model"] | null =
        null;
      const finish = (
        status: ParallelTaskExecutionOutcome["status"],
      ): ParallelTaskExecutionOutcome => ({
        status,
        operation_id: input.operation_id,
        wave_integration_digests: digests,
        scheduler_state_digest: contentDigest({
          operation_id: input.operation_id,
          plan_digest: input.expected_plan_digest,
          wave_integrations: digests,
          projection: lastReadModel?.projection ?? null,
        }),
      });

      // At most one integration per pass; waves plus the terminal no-op pass
      // bound the loop, and each pass either integrates or returns.
      const maxPasses = (options.capability_plan.operation_dag.nodes.length + 1) * 4 + 16;
      for (let pass = 0; ; pass += 1) {
        if (pass > maxPasses) {
          throw new ParallelTaskExecutionError(
            "scheduling_loop_inconclusive",
            `parallel execution of ${input.operation_id} did not converge`,
          );
        }
        const drive = await options.scheduler.drive({
          operation_id: input.operation_id,
          expected_plan_digest: input.expected_plan_digest,
          requested_max_concurrency: options.requested_max_concurrency,
          driver_lock: input.driver_lock,
          ...(input.operation_lease === undefined
            ? {}
            : { operation_lease: input.operation_lease }),
        });
        lastReadModel = drive.read_model;
        if (drive.status === "cancelled") return finish("cancelled");
        if (drive.status === "paused") return finish("paused");
        if (drive.status === "blocked") return finish("blocked");

        // Freshness is re-derived between waves: an approved-plan drift fails
        // closed here (SchedulingPortError plan_digest_drift propagates) and
        // invalidates every scheduling decision not yet integrated (§17).
        const dag = await options.dag_port.readApproved({
          operation_id: input.operation_id,
          expected_plan_digest: input.expected_plan_digest,
        });
        const facts = await options.authority.readFacts(input.operation_id);
        const integrated = new Set(
          facts.wave_integrations
            .filter((record) => record.operation_id === input.operation_id)
            .map((record) => record.wave_index),
        );
        const wave = [...dag.parallel_waves]
          .sort((left, right) => left.wave_index - right.wave_index)
          .find((candidate) => !integrated.has(candidate.wave_index));
        if (wave === undefined) return finish("completed");

        // Every Task of the wave must be candidate_validated (Ledger-derived)
        // or freshly verified: "verifying" with a queued patch and a released
        // lease is a completed run awaiting the layer-2 candidate gates that
        // validateTaskCandidate runs below. A provisional or unfinished
        // result — or a still-granted lease — blocks instead of integrating.
        const projection = projectSchedulerState({ dag, ...facts }, null);
        const statusOf = new Map(
          projection.tasks.map((task) => [task.task_id, task.status] as const),
        );
        const queuedByTask = new Map(
          (facts.candidate_patches ?? []).map((fact) => [fact.task_id, fact] as const),
        );
        const latestLeases = latestLeaseByTask(facts.leases);
        if (
          !wave.task_ids.every((taskId) => {
            const status = statusOf.get(taskId);
            return (
              queuedByTask.has(taskId) &&
              latestLeases.get(taskId)?.state === "released" &&
              (status === "candidate_validated" || status === "verifying")
            );
          })
        ) {
          return finish("blocked");
        }

        // Refill the in-memory integration buffer from the recovery view (the
        // queue is process-local; the Ledger is the authority).
        for (const taskId of wave.task_ids) {
          const queued = queuedByTask.get(taskId);
          if (queued === undefined) return finish("blocked");
          const lease = latestLeases.get(taskId);
          await options.integration.queueTaskCandidate({
            task_id: queued.task_id,
            baseline_commit: lease?.baseline_commit ?? dag.baseline_commit,
            changed_paths: [],
            patch_locator: queued.patch_locator,
            patch_digest: queued.patch_digest,
            source_tree_digest: "",
          });
        }
        const candidate = await options.integration.rebuildWaveCandidate({
          dag,
          wave,
          expected_base_commit: waveBaseCommit(dag, facts, wave.wave_index),
        });
        const validations = [];
        for (const taskId of wave.task_ids) {
          const task = dag.tasks.find((spec) => spec.id === taskId);
          const lease = latestLeases.get(taskId);
          if (task === undefined || lease === undefined) return finish("blocked");
          // Layer-1 evidence comes from authoritative facts only; candidate
          // and wave gates re-run inside the controller.
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
          validations.push(
            await options.integration.validateTaskCandidate({
              candidate,
              task,
              lease,
              evidence,
            }),
          );
        }

        const policyInput = waveIntegrationPolicyInput({
          dag,
          wave,
          base_commit: candidate.base_commit,
          leases: facts.leases,
          adapter_manifest_digest: options.adapter_manifest_digest,
          adapter_control_profile: options.adapter_control_profile,
          effective_policy_digest: options.effective_policy_digest,
          now: now(),
        });
        const decision = await options.policy.decide(policyInput);
        if (decision.outcome === "deny" || decision.outcome === "block") {
          return finish("blocked");
        }
        if (decision.outcome === "requires_approval" && decision.approval_digest === undefined) {
          // Exactly one digest-bound request per wave action; a resumed driver
          // facing the same unresolved decision never duplicates it.
          const objectDigest = actionDigest(schedulerPolicyAction(policyInput));
          const existing = facts.approvals.some(
            (request) => request.object_digest === objectDigest,
          );
          if (!existing) {
            await options.authority.commit([
              {
                kind: "request_approval",
                request: buildApprovalRequest({
                  requestId: digestId("approval-request", {
                    operation_id: dag.operation_id,
                    wave_index: wave.wave_index,
                    action_digest: objectDigest,
                  }),
                  workflowOperationId: dag.operation_id,
                  objectId: `wave_${String(wave.wave_index)}`,
                  objectType: "scheduler_action",
                  objectDigest,
                  baselineDigest: contentDigest({ baseline_commit: candidate.base_commit }),
                  policyDigest: decision.effective_policy_digest,
                  impactPath: [],
                  risk: policyInput.risk,
                  reason:
                    decision.reasons.join("; ").length > 0
                      ? decision.reasons.join("; ")
                      : `policy requires approval to integrate wave ${String(wave.wave_index)}`,
                  allowedDecisions: ["approve", "reject"],
                  createdAt: now(),
                  resumePhase: "execute",
                  proposedBy: "harness",
                }),
              },
            ]);
          }
          return finish("paused");
        }

        const accepted = await options.integration.acceptWave({
          dag,
          candidate,
          validations,
          policy_decision: decision,
          approval_digests:
            decision.approval_digest === undefined ? [] : [decision.approval_digest],
          command_id: digestId("command", {
            purpose: "integrate_wave",
            operation_id: dag.operation_id,
            plan_digest: dag.plan_digest,
            wave_index: wave.wave_index,
          }),
          ...(input.operation_lease === undefined
            ? {}
            : {
                operation_lease: {
                  operation_id: input.operation_lease.resource_id,
                  fencing_token: input.operation_lease.fencing_token,
                },
              }),
        });
        digests.push(accepted.record_digest);
      }
    },
  };
}

/** The connected-mode M3 Operation Lease the port validates before scheduling. */
export type ParallelOperationLease = NonNullable<
  Parameters<ParallelTaskExecutionPort["run"]>[0]["operation_lease"]
>;

/**
 * DAG runner adapter for an execute node marked `parallel_task_execution`
 * (plan Task 11 step 1/2). The accepted subgraph marker is the only
 * activation authority; any other node fails closed without touching the
 * port. A completed outcome commits the node with the wave_integration
 * binding exactly once; pause/block/cancel map to a non-committing blocked
 * result so a resume re-enters execute through the same node.
 */
export function createParallelExecuteDagRunner(ports: {
  readonly parallelExecution: ParallelTaskExecutionPort;
  readonly iterationId: () => string;
  readonly driverLock: () => DriverLockHandle;
  readonly operationLease?: () => ParallelOperationLease | undefined;
}): DagNodeRunner {
  return async (context) => {
    if (context.node.subgraph !== "parallel_task_execution") {
      return {
        status: "blocked",
        reason: "parallel_execute_not_active",
        detail: "the accepted DAG does not mark this execute node parallel_task_execution",
      };
    }
    const executionPlan = context.inputs["execution_plan"];
    if (executionPlan === undefined) {
      return {
        status: "blocked",
        reason: "parallel_execute_input_missing",
        detail: "the parallel execute node consumes no execution_plan binding",
      };
    }
    const operationLease = ports.operationLease?.();
    const outcome = await ports.parallelExecution.run({
      operation_id: context.operation_id,
      iteration_id: ports.iterationId(),
      capability_plan_digest: context.plan_digest,
      expected_plan_digest: executionPlan,
      driver_lock: ports.driverLock(),
      ...(operationLease === undefined ? {} : { operation_lease: operationLease }),
    });
    if (outcome.status !== "completed") {
      return {
        status: "blocked",
        reason: `parallel_execute_${outcome.status}`,
        detail:
          `parallel execution ${outcome.status} for ${outcome.operation_id}; ` +
          `resume with: ${schedulerResumeCommand(outcome.operation_id)}`,
      };
    }
    return {
      status: "committed",
      produces: [
        {
          kind: "wave_integration",
          digest: contentDigest({
            operation_id: outcome.operation_id,
            wave_integration_digests: outcome.wave_integration_digests,
            scheduler_state_digest: outcome.scheduler_state_digest,
          }),
        },
      ],
    };
  };
}

// --- Findings, recovery actions and wake-up (design §21) ----------------------

/**
 * The single recommended recovery action per typed scheduler blocker (design
 * §21, plan Task 11 step 4). There is deliberately no generic "ignore and
 * continue" entry.
 */
export const SCHEDULER_RECOVERY_ACTIONS = {
  approval_missing: "open_approval",
  budget_exhausted: "submit_budget_policy_proposal",
  executor_failed: "inspect_retry",
  integration_conflict: "inspect_candidate_conflict",
  undeclared_write: "revise_plan_resources",
  baseline_drift: "return_to_impact_and_plan",
  wave_gate_failed: "open_gate_evidence_and_replan",
  adapter_ineligible: "change_adapter_or_supervise",
} as const;

export type SchedulerBlockerKind = keyof typeof SCHEDULER_RECOVERY_ACTIONS;
export type SchedulerRecoveryAction = (typeof SCHEDULER_RECOVERY_ACTIONS)[SchedulerBlockerKind];

/**
 * Finding rules the scheduler/integration layer mints, normalized onto the
 * typed blocker vocabulary before the single-action lookup.
 */
const FINDING_RULE_ALIASES: Readonly<Record<string, SchedulerBlockerKind>> = {
  approval_missing: "approval_missing",
  budget_exhausted: "budget_exhausted",
  executor_failed: "executor_failed",
  retry_exhausted: "executor_failed",
  integration_conflict: "integration_conflict",
  undeclared_write: "undeclared_write",
  write_set_violation: "undeclared_write",
  baseline_drift: "baseline_drift",
  wave_gate_failed: "wave_gate_failed",
  adapter_ineligible: "adapter_ineligible",
  capability_mismatch: "adapter_ineligible",
};

/**
 * The one recovery action a scheduler Finding rule maps to, or undefined when
 * the rule is not a scheduler blocker (design §21: no invented fallback).
 */
export function schedulerRecoveryActionFor(rule: string): SchedulerRecoveryAction | undefined {
  const blocker = FINDING_RULE_ALIASES[rule];
  return blocker === undefined ? undefined : SCHEDULER_RECOVERY_ACTIONS[blocker];
}

/** The exact resume command a dead driver projects (design §19.5/§20). */
export function schedulerResumeCommand(operationId: string): string {
  return `harness resume ${operationId}`;
}

/**
 * Approval arrival continuation (design §19.5, plan Task 11 step 4): a live
 * driver is woken in place; without a driver the projection is the exact
 * resume command, never a silent no-op.
 */
export function schedulerApprovalContinuation(input: {
  readonly driver_live: boolean;
  readonly operation_id: string;
}):
  { readonly kind: "wake_driver" } | { readonly kind: "resume_command"; readonly command: string } {
  return input.driver_live
    ? { kind: "wake_driver" }
    : { kind: "resume_command", command: schedulerResumeCommand(input.operation_id) };
}

// --- Scheduling invalidation (design §17, plan Task 11 step 3) ----------------

/**
 * Drift kinds that invalidate scheduling state. Any of these changes makes
 * every not-yet-integrated scheduling decision stale before the next Lease
 * and degrades in-flight results to provisional before verification or
 * integration. Design/Impact/Profile legacy invalidation is unchanged and
 * lives in orchestration/invalidation.ts — never here.
 */
export const SCHEDULER_DRIFT_KINDS = [
  "plan",
  "task",
  "resource",
  "budget",
  "policy",
  "approval",
  "adapter",
  "baseline",
  "gate_definition",
  "context_source",
] as const;

export type SchedulerDriftKind = (typeof SCHEDULER_DRIFT_KINDS)[number];

export interface SchedulerDriftEffect {
  /** Pending (not yet leased) scheduling decisions never survive a drift. */
  readonly pending_decisions: "invalidated";
  /** In-flight atomic calls may finish; their results are provisional only. */
  readonly in_flight_results: "provisional";
  /** Where the pipeline re-enters when the drift changes Task semantics. */
  readonly reentry: "impact" | "plan";
}

/** The effect of one scheduling drift kind; the same for every 1.3 driver. */
export function schedulerDriftEffect(kind: SchedulerDriftKind): SchedulerDriftEffect {
  return {
    pending_decisions: "invalidated",
    in_flight_results: "provisional",
    reentry: kind === "baseline" ? "impact" : "plan",
  };
}

// --- Production Ledger authority (plan Task 11; Task 10 review obligation) ----

/**
 * Artifact layout of the production SchedulerAuthority. Task leases, wave
 * integrations and scheduler evidence-reference batches live under
 * `artifacts/scheduling/<operation>/`; gate evidence reuses the existing
 * `artifacts/evidence/<evidence_id>/<digest>.json` layout, approval requests
 * the existing ApprovalService layout, findings the existing findings layout
 * and run records the existing run streams — so every other reader of the
 * vertical loop observes scheduler writes through its own established path.
 */
const SCHEDULING_ARTIFACT_ROOT = "artifacts/scheduling";

interface SchedulingArtifactRefs {
  readonly leases: readonly string[];
  readonly waves: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly findings: readonly string[];
}

function listSchedulingArtifacts(harnessRoot: string, operationId: string): SchedulingArtifactRefs {
  const list = (kind: string): string[] =>
    listArtifactFiles(harnessRoot, `${SCHEDULING_ARTIFACT_ROOT}/${operationId}/${kind}`);
  return {
    leases: list("leases"),
    waves: list("waves"),
    evidenceRefs: list("evidence-refs"),
    findings: list("findings"),
  };
}

function parseJsonArtifact(
  harnessRoot: string,
  relative: string,
  allowed: ReadonlySet<string>,
): unknown | undefined {
  try {
    return JSON.parse(readVerifiedArtifact(harnessRoot, relative, allowed)) as unknown;
  } catch {
    // Orphan bytes of an interrupted commit are not authoritative.
    return undefined;
  }
}

/**
 * Recursively list evidence record files: `artifacts/evidence/<id>/<digest>.json`.
 * Multiple committed records may share one evidence_id; the reader keeps the
 * one from the latest committed Ledger operation (see readFacts below).
 */
function listEvidenceArtifacts(harnessRoot: string): string[] {
  const root = resolveHarnessPath(harnessRoot, "artifacts/evidence");
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root).sort()) {
    const directory = join(root, entry);
    for (const name of readdirSync(directory)
      .filter((candidate) => candidate.endsWith(".json"))
      .sort()) {
      files.push(`artifacts/evidence/${entry}/${name}`);
    }
  }
  return files;
}

/**
 * Derive the queued-candidate recovery view from Ledger facts (Task 10 review
 * obligation; contract: scheduler.ts QueuedCandidateFact). The
 * TaskIntegrationQueued event carries task/run identity and the patch digest;
 * the committed `task_candidate_patch` evidence-reference entry carries the
 * artifact locator. The join is by patch digest, in Ledger event order; a
 * queued event without its evidence reference (or vice versa) yields no fact.
 */
export function deriveQueuedCandidatePatches(
  events: readonly LifecycleEvent[],
  evidenceRefs: readonly {
    readonly kind: string;
    readonly locator: string;
    readonly digest: string;
  }[],
): QueuedCandidateFact[] {
  const locatorByDigest = new Map<string, string>();
  for (const entry of evidenceRefs) {
    if (entry.kind !== "task_candidate_patch") continue;
    locatorByDigest.set(entry.digest, entry.locator);
  }
  const facts: QueuedCandidateFact[] = [];
  for (const event of events) {
    if (event.event_type !== "TaskIntegrationQueued") continue;
    const payload = event.payload;
    const taskId = payload["task_id"];
    const runId = payload["run_id"];
    const patchDigest = payload["patch_digest"];
    if (
      typeof taskId !== "string" ||
      typeof runId !== "string" ||
      typeof patchDigest !== "string"
    ) {
      continue;
    }
    const locator = locatorByDigest.get(patchDigest);
    if (locator === undefined) continue;
    facts.push({
      task_id: taskId,
      run_id: runId,
      patch_locator: locator,
      patch_digest: patchDigest,
    });
  }
  return facts;
}

export interface LedgerSchedulerAuthorityOptions {
  readonly deps: WorkflowDependencies;
  /**
   * Operation binding for batches whose transitions carry no operation
   * identity of their own (evidence-only downgrade batches, e.g. the Task 10
   * recovery path). A transition that does name an operation must match it.
   */
  readonly operation_id?: string;
}

function eventFromSpec(
  spec: {
    readonly eventType: LifecycleEvent["event_type"];
    readonly protocolVersion?: string;
    readonly payload: Record<string, unknown>;
  },
  context: {
    readonly eventId: string;
    readonly projectId: string;
    readonly iterationId: string;
    readonly workflowOperationId: string;
    readonly ledgerOperationId: string;
    readonly sequence: number;
    readonly timestamp: string;
  },
): LifecycleEvent {
  const event = {
    protocol_version: spec.protocolVersion ?? PROTOCOL_1_3_VERSION,
    record_kind: "event",
    event_id: context.eventId,
    event_type: spec.eventType,
    project_id: context.projectId,
    iteration_id: context.iterationId,
    workflow_operation_id: context.workflowOperationId,
    ledger_operation_id: context.ledgerOperationId,
    sequence: context.sequence,
    timestamp: context.timestamp,
    payload: spec.payload,
  };
  const validation = validateSchema("event", event);
  if (!validation.valid) {
    const detail = validation.errors
      .map((issue) => `${issue.instancePath}: ${issue.message}`)
      .join("; ");
    throw new ParallelTaskExecutionError(
      "invalid_event",
      `invalid scheduler lifecycle event: ${detail}`,
    );
  }
  return event as unknown as LifecycleEvent;
}

/**
 * The production SchedulerAuthority (plan Task 11): commit() maps one ordered
 * transition batch to exactly one staged Ledger transaction; readFacts()
 * rebuilds the authoritative view from committed manifests only. Orphan
 * artifact bytes no committed manifest references are skipped, never trusted.
 *
 * Read-side semantics the Task 10 recovery downgrade relies on:
 * - gate evidence is read latest-by-evidence_id: when several committed
 *   records share an evidence_id, the one written by the newest Ledger
 *   operation wins (a provisional replacement supersedes its predecessor);
 * - candidate_patches is a derived view (deriveQueuedCandidatePatches), never
 *   stored: the TaskIntegrationQueued event joins the committed
 *   task_candidate_patch evidence reference by patch digest.
 */
export function createLedgerSchedulerAuthority(
  options: LedgerSchedulerAuthorityOptions,
): SchedulerAuthority {
  const { deps } = options;
  const now = deps.now ?? (() => new Date().toISOString());

  const committedOperations = (): {
    readonly repository: ReturnType<typeof ledgerRepositoryFor>;
    readonly operations: readonly CommittedOperation[];
  } => {
    const repository = ledgerRepositoryFor(deps);
    return { repository, operations: repository.operations() };
  };

  return {
    async readFacts(operationId) {
      const { repository, operations } = committedOperations();
      const harnessRoot = harnessRootFor(deps.projectRoot);
      const allowed = artifactDigestAllowlist(operations, operationId);

      const refs = listSchedulingArtifacts(harnessRoot, operationId);
      const leases: TaskLeaseRecord[] = [];
      for (const relative of refs.leases) {
        const parsed = parseJsonArtifact(harnessRoot, relative, allowed);
        if (typeof parsed !== "object" || parsed === null) continue;
        const candidate = parsed as TaskLeaseRecord;
        if (candidate.record_kind !== "task_lease" || candidate.operation_id !== operationId) {
          continue;
        }
        // Read-side semantic check: a syntactically valid but impossible
        // lease chain fails closed instead of being projected.
        assertSchedulingRecordSemantics(candidate as SchedulingRecord);
        leases.push(candidate);
      }
      // buildTaskLeaseChain validates in Ledger encounter order; artifact
      // filenames are digest-derived, so re-derive the chain order: fencing
      // tokens strictly increase per Task, and within one lease the granted
      // record always precedes its terminal transition.
      const leaseStateRank = (state: TaskLeaseRecord["state"]): number =>
        state === "granted" ? 0 : 1;
      leases.sort(
        (left, right) =>
          left.fencing_token - right.fencing_token ||
          leaseStateRank(left.state) - leaseStateRank(right.state),
      );
      const waves: WaveIntegrationRecord[] = [];
      for (const relative of refs.waves) {
        const parsed = parseJsonArtifact(harnessRoot, relative, allowed);
        if (typeof parsed !== "object" || parsed === null) continue;
        const candidate = parsed as WaveIntegrationRecord;
        if (
          candidate.record_kind !== "wave_integration" ||
          candidate.operation_id !== operationId
        ) {
          continue;
        }
        assertSchedulingRecordSemantics(candidate as SchedulingRecord);
        waves.push(candidate);
      }

      // Evidence, latest-by-evidence_id: the Ledger operation sequence that
      // committed each record decides; a newer committed record with the same
      // evidence_id (e.g. the recovery provisional downgrade) supersedes.
      const sequenceOf = new Map<string, number>();
      for (const operation of operations) {
        if (operation.manifest.workflow_operation_id !== operationId) continue;
        for (const digest of operation.manifest.artifact_digests) {
          sequenceOf.set(digest, operation.manifest.sequence);
        }
      }
      const evidenceById = new Map<
        string,
        { readonly sequence: number; readonly record: GateEvidenceRecord }
      >();
      for (const relative of listEvidenceArtifacts(harnessRoot)) {
        let bytes: string;
        try {
          bytes = readVerifiedArtifact(harnessRoot, relative, allowed);
        } catch {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(bytes) as unknown;
        } catch {
          continue;
        }
        if (typeof parsed !== "object" || parsed === null) continue;
        const candidate = parsed as GateEvidenceRecord;
        if (candidate.record_kind !== "evidence") continue;
        const sequence = sequenceOf.get(sha256Hex(bytes)) ?? 0;
        const current = evidenceById.get(candidate.evidence_id);
        if (current === undefined || sequence >= current.sequence) {
          evidenceById.set(candidate.evidence_id, { sequence, record: candidate });
        }
      }

      const evidenceRefEntries: {
        readonly kind: string;
        readonly locator: string;
        readonly digest: string;
      }[] = [];
      for (const relative of refs.evidenceRefs) {
        const parsed = parseJsonArtifact(harnessRoot, relative, allowed);
        if (!Array.isArray(parsed)) continue;
        for (const entry of parsed as readonly {
          kind?: unknown;
          locator?: unknown;
          digest?: unknown;
        }[]) {
          if (
            typeof entry === "object" &&
            entry !== null &&
            typeof entry.kind === "string" &&
            typeof entry.locator === "string" &&
            typeof entry.digest === "string"
          ) {
            evidenceRefEntries.push({
              kind: entry.kind,
              locator: entry.locator,
              digest: entry.digest,
            });
          }
        }
      }

      const findings: FeedbackRecord[] = [];
      for (const relative of refs.findings) {
        const parsed = parseJsonArtifact(harnessRoot, relative, allowed);
        if (typeof parsed !== "object" || parsed === null) continue;
        const candidate = parsed as FeedbackRecord;
        if (!validateSchema("feedback", candidate).valid) continue;
        findings.push(candidate);
      }

      const runs = readRunStreams(deps, operationId).flatMap((stream) => stream.records);
      const operationEvents = repository
        .replay()
        .events.filter((event) => event.workflow_operation_id === operationId);

      return {
        leases,
        runs,
        gate_evidence: [...evidenceById.values()].map((entry) => entry.record),
        approvals: readPendingApprovalRequests(harnessRoot, operations).filter(
          (request) => request.workflow_operation_id === operationId,
        ),
        findings,
        wave_integrations: waves,
        candidate_patches: deriveQueuedCandidatePatches(operationEvents, evidenceRefEntries),
      };
    },

    async commit(transitions) {
      if (transitions.length === 0) return;
      const named = transitionsOperationId(transitions);
      const operationId = named !== "" ? named : (options.operation_id ?? "");
      if (options.operation_id !== undefined && named !== "" && named !== options.operation_id) {
        throw new ParallelTaskExecutionError(
          "operation_not_found",
          `authority is bound to ${options.operation_id}; the batch names ${named}`,
        );
      }
      const operation = readCurrentOperation(deps, operationId);
      if (operation === undefined) {
        throw new ParallelTaskExecutionError(
          "operation_not_found",
          `unknown workflow operation ${operationId}`,
        );
      }
      const artifacts: { path: string; content: string }[] = [];
      const eventSpecs: PhaseLifecycleEventSpec[] = [];
      const json = (record: unknown): string => `${canonicalizeJson(record)}\n`;
      for (const transition of transitions) {
        switch (transition.kind) {
          case "grant_lease":
          case "terminate_lease":
            artifacts.push({
              path: `${SCHEDULING_ARTIFACT_ROOT}/${operationId}/leases/${transition.record.task_lease_record_id}.json`,
              content: json(transition.record),
            });
            break;
          case "record_wave_integration":
            artifacts.push({
              path: `${SCHEDULING_ARTIFACT_ROOT}/${operationId}/waves/${transition.record.wave_integration_id}.json`,
              content: json(transition.record),
            });
            break;
          case "append_gate_evidence":
            for (const record of transition.records) {
              artifacts.push({
                path: `artifacts/evidence/${record.evidence_id}/${record.digest}.json`,
                content: json(record),
              });
            }
            break;
          case "append_evidence":
            artifacts.push({
              path: `${SCHEDULING_ARTIFACT_ROOT}/${operationId}/evidence-refs/${digestId("refs", transition.evidence)}.json`,
              content: json(transition.evidence),
            });
            break;
          case "request_approval":
            artifacts.push(approvalRequestArtifact(transition.request));
            break;
          case "create_finding":
            artifacts.push({
              path: `artifacts/findings/${transition.finding.id}/${transition.finding.status}.json`,
              content: json(transition.finding),
            });
            break;
          case "record_run":
            artifacts.push({
              path: runRecordArtifactPath(
                transition.record.run_id,
                transition.record.sequence,
                transition.record.record_kind,
              ),
              content: json(transition.record),
            });
            break;
          case "append_event":
            eventSpecs.push(schedulerPhaseLifecycleEvent(transition.event));
            break;
        }
      }
      const timestamp = now();
      const newId =
        deps.newId ??
        ((kind: string) =>
          `${kind}_${contentDigest({ t: timestamp, n: artifacts.length, kind }).slice(0, 16)}`);
      const ledgerOperationId = newId("ledger");
      const firstSequence = nextEventSequence(deps, operationId);
      const projectId = projectIdOfOperation(operation);
      const events = eventSpecs.map((spec, index) =>
        eventFromSpec(spec, {
          eventId: newId("event"),
          projectId,
          iterationId: operation.iteration_id,
          workflowOperationId: operationId,
          ledgerOperationId,
          sequence: firstSequence + index,
          timestamp,
        }),
      );
      const transactionInput = {
        ledger_operation_id: ledgerOperationId,
        workflow_operation_id: operationId,
        attempt_id: operation.attempt_id,
        expected_baseline: deps.readBaseline(),
        artifacts,
        events,
      };
      const requiredReaderVersion = transactionRequiredReaderVersion(transactionInput);
      await ledgerRepositoryFor(deps).commit({
        ...transactionInput,
        ...(requiredReaderVersion === undefined
          ? {}
          : { required_reader_version: requiredReaderVersion }),
      });
    },
  };
}

/** Every scheduler transition batch names its operation through its records. */
function transitionsOperationId(transitions: readonly SchedulerTransition[]): string {
  for (const transition of transitions) {
    switch (transition.kind) {
      case "grant_lease":
      case "terminate_lease":
        return transition.record.operation_id;
      case "record_wave_integration":
        return transition.record.operation_id;
      case "record_run":
        return transition.record.workflow_operation_id;
      case "request_approval":
        return transition.request.workflow_operation_id;
      case "append_event":
        return typeof transition.event.payload["operation_id"] === "string"
          ? (transition.event.payload["operation_id"] as string)
          : "";
      case "create_finding":
        if (transition.operation_id !== undefined) return transition.operation_id;
        break;
      default:
        break;
    }
  }
  return "";
}

function projectIdOfOperation(operation: {
  readonly extensions?: Record<string, unknown>;
}): string {
  const extension = operation.extensions?.["harness.workflow"];
  if (typeof extension === "object" && extension !== null) {
    const projectId = (extension as { project_id?: unknown }).project_id;
    if (typeof projectId === "string") return projectId;
  }
  return "project_unknown";
}
