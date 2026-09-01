import {
  contentDigest,
  type FeedbackRecord,
  type LeaseRecord,
} from "@universal-harness-internal/core";

import type { ApprovalRequestRecord } from "../approval/request.js";
import type { IterationBudget, Protocol13TaskSpecification } from "../planning/task.js";
import type { ParallelWave } from "../planning/waves.js";

import { restoreBudgetAccount } from "./budget.js";
import type {
  AgentPoolSlot,
  SchedulerProjectionStore,
  TaskDagPort,
  TaskDagSnapshot,
} from "./ports.js";
import { projectSchedulerState, type TaskSchedulingStatus } from "./projection.js";
import {
  deriveIterationDeadline,
  type SchedulerAuthority,
  type SchedulerLedgerFacts,
} from "./scheduler.js";

/**
 * API-facing Scheduler Read Model (M4 design §19.2/§19.3, plan Task 11 step
 * 5/6). One snapshot joins the Operation, the approved Plan/waves, the Task
 * projection, the Slot live projection, Budget/reservations, pending
 * Approvals and blocking Findings for the Dashboard Read API and `harness
 * status`. The join reads Ledger/Graph first (TaskDagPort +
 * SchedulerAuthority), the disposable SQLite/live spool second
 * (SchedulerProjectionStore), and merges both through
 * projectSchedulerState() — Dashboard callers never read SQLite, worktrees
 * or raw traces directly.
 *
 * Naming deviation from the plan: scheduler.ts already owns the name
 * `SchedulerReadModel` for the drive-internal read model, so this API-facing
 * shape is exported under the plan-frozen name here and the barrel keeps both
 * apart (see packages/runtime/src/index.ts). `FindingRecord` does not exist
 * in this repository — FeedbackRecord with type "Finding" is the finding
 * authority, so `findings` carries FeedbackRecord.
 */

export interface SchedulerTaskProjection {
  readonly task_id: string;
  readonly title: string;
  /** Wave the approved Plan assigns; -1 marks a Task with no wave binding. */
  readonly wave_index: number;
  readonly status: TaskSchedulingStatus;
  readonly authority: "ledger" | "provisional";
  readonly dependency_ids: readonly string[];
  readonly non_parallel_reasons: readonly string[];
  readonly current_lease_digest?: string;
  readonly current_run_id?: string;
  readonly retry_kind?: "executor_retry" | "integration_retry";
}

export interface SchedulerReadModel {
  readonly capability_status: "active" | "inactive_by_profile";
  readonly operation: {
    readonly operation_id: string;
    readonly iteration_id: string;
    readonly status: string;
    /**
     * Additive to the plan's interface block: the live-projection health
     * (design §19.2). "rebuilding" when the live snapshot is lost — Tasks
     * keep their Ledger-derived status and never degrade to failed/success.
     */
    readonly live_state: "observed" | "rebuilding";
  };
  readonly plan: {
    readonly plan_id: string;
    readonly plan_digest: string;
    readonly waves: readonly ParallelWave[];
  } | null;
  readonly tasks: readonly SchedulerTaskProjection[];
  readonly slots: readonly AgentPoolSlot[];
  readonly budget: {
    readonly limit: IterationBudget;
    readonly consumed_steps: number;
    readonly consumed_tokens: number;
    readonly reserved_steps: number;
    readonly reserved_tokens: number;
  };
  readonly approvals: readonly ApprovalRequestRecord[];
  readonly findings: readonly FeedbackRecord[];
  readonly presentation_map: Readonly<Record<string, string>>;
  readonly digest: string;
}

export const SCHEDULER_READ_MODEL_ERROR_KINDS = ["scheduler_sources_missing"] as const;

export type SchedulerReadModelErrorKind = (typeof SCHEDULER_READ_MODEL_ERROR_KINDS)[number];

/** Fail-closed rejection raised when an active read lacks its sources. */
export class SchedulerReadModelError extends Error {
  readonly kind: SchedulerReadModelErrorKind;

  constructor(kind: SchedulerReadModelErrorKind, message: string) {
    super(message);
    this.name = "SchedulerReadModelError";
    this.kind = kind;
  }
}

/**
 * Read side of the model. `capability` is the caller-resolved Profile/
 * CapabilityPlan answer (profile-modules.ts owns that derivation); everything
 * else this module reads itself. The TaskDagPort and SchedulerAuthority are
 * mandatory for an active capability — an active read without authority would
 * have to invent tasks, which this model never does.
 */
export interface SchedulerReadModelSources {
  readonly capability: "active" | "inactive_by_profile";
  readonly operation_id: string;
  readonly dag_port?: TaskDagPort;
  readonly authority?: SchedulerAuthority;
  /** SQLite/live spool projection store; absent means live state is lost. */
  readonly live?: SchedulerProjectionStore;
  /** ISO clock; injectable so replays are byte-deterministic. */
  readonly now?: () => string;
}

function isOpenBlockingFinding(finding: FeedbackRecord): boolean {
  if (finding.type !== "Finding") return false;
  if (finding.status !== "proposed" && finding.status !== "accepted") return false;
  const extension = finding.extensions?.["harness.finding"];
  if (typeof extension !== "object" || extension === null) return false;
  return (extension as { blocking?: unknown }).blocking === true;
}

function findingRule(finding: FeedbackRecord): string | undefined {
  const extension = finding.extensions?.["harness.finding"];
  if (typeof extension !== "object" || extension === null) return undefined;
  const rule = (extension as { rule?: unknown }).rule;
  return typeof rule === "string" ? rule : undefined;
}

/** Overall operation status from the Task projection, precedence fixed. */
function operationStatusOf(statuses: readonly TaskSchedulingStatus[]): string {
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("awaiting_approval")) return "paused";
  if (
    statuses.some((status) =>
      [
        "running",
        "verifying",
        "integration_queued",
        "candidate_validated",
        "ready",
        "retry_pending",
      ].includes(status),
    )
  ) {
    return "running";
  }
  if (statuses.length > 0 && statuses.every((s) => s === "integrated" || s === "cancelled")) {
    return "completed";
  }
  return "idle";
}

/**
 * Why a Task cannot run in parallel with its wave peers: same-wave
 * dependencies, overlapping declared write paths and exclusive resource
 * claims. Deterministic order: peer task ids sorted, reason kinds in listed
 * order. An empty list means the Task parallelizes freely within its wave.
 */
export function nonParallelReasons(
  task: Protocol13TaskSpecification,
  dag: {
    readonly tasks: readonly Protocol13TaskSpecification[];
    readonly parallel_waves: readonly ParallelWave[];
  },
): readonly string[] {
  const reasons: string[] = [];
  const wave = dag.parallel_waves.find((candidate) => candidate.task_ids.includes(task.id));
  if (wave === undefined) return ["no_wave_assignment"];
  const peers = wave.task_ids.filter((taskId) => taskId !== task.id);
  const peerSet = new Set(peers);
  for (const dependency of [...task.dependencies].sort()) {
    if (peerSet.has(dependency)) reasons.push(`depends_on_wave_peer:${dependency}`);
  }
  for (const peerId of [...peers].sort()) {
    const peer = dag.tasks.find((candidate) => candidate.id === peerId);
    if (peer === undefined) continue;
    if (task.write_paths.some((path) => peer.write_paths.includes(path))) {
      reasons.push(`write_path_overlap:${peerId}`);
    }
    if (task.exclusive_resources.some((resource) => peer.exclusive_resources.includes(resource))) {
      reasons.push(`exclusive_resource_conflict:${peerId}`);
    }
  }
  if (
    task.exclusive_resources.length > 0 &&
    !reasons.some((r) => r.startsWith("exclusive_resource_conflict:"))
  ) {
    reasons.push("exclusive_resources");
  }
  return reasons;
}

function finalize(model: Omit<SchedulerReadModel, "digest">): SchedulerReadModel {
  return { ...model, digest: contentDigest(model) };
}

/**
 * Build the one-snapshot Scheduler Read Model for an operation. Inactive
 * (Lite profile / parallel module off) returns capability_status
 * "inactive_by_profile" with an empty projection — no fabricated tasks. A
 * lost live snapshot degrades only `live_state` to "rebuilding".
 */
export async function readSchedulerModel(
  sources: SchedulerReadModelSources,
): Promise<SchedulerReadModel> {
  const now = sources.now ?? (() => new Date().toISOString());
  if (sources.capability === "inactive_by_profile") {
    return finalize({
      capability_status: "inactive_by_profile",
      operation: {
        operation_id: sources.operation_id,
        iteration_id: "",
        status: "inactive_by_profile",
        live_state: "rebuilding",
      },
      plan: null,
      tasks: [],
      slots: [],
      budget: {
        limit: { steps: 0, tokens: 0, duration_ms: 0 },
        consumed_steps: 0,
        consumed_tokens: 0,
        reserved_steps: 0,
        reserved_tokens: 0,
      },
      approvals: [],
      findings: [],
      presentation_map: {},
    });
  }
  if (sources.dag_port === undefined || sources.authority === undefined) {
    throw new SchedulerReadModelError(
      "scheduler_sources_missing",
      "an active scheduler read requires the TaskDagPort and SchedulerAuthority sources",
    );
  }

  // Ledger/Graph first: the approved DAG, then the authoritative facts.
  const dag = await sources.dag_port.readApproved({ operation_id: sources.operation_id });
  const facts: SchedulerLedgerFacts = await sources.authority.readFacts(sources.operation_id);
  // Live spool second; it only ever decorates the projection.
  const live = sources.live === undefined ? null : await sources.live.read(sources.operation_id);
  const projection = projectSchedulerState({ dag, ...facts }, live);

  const account = restoreBudgetAccount({
    limit: dag.iteration_budget,
    iteration_deadline: deriveIterationDeadline(dag, facts.leases, now()),
    records: facts.leases,
  });
  const consumed = Object.values(account.consumed).reduce(
    (sum, amount) => ({ steps: sum.steps + amount.steps, tokens: sum.tokens + amount.tokens }),
    { steps: 0, tokens: 0 },
  );
  const reserved = Object.values(account.reservations).reduce(
    (sum, amount) => ({ steps: sum.steps + amount.steps, tokens: sum.tokens + amount.tokens }),
    { steps: 0, tokens: 0 },
  );

  const statusByTask = new Map(projection.tasks.map((task) => [task.task_id, task] as const));
  const tasks: SchedulerTaskProjection[] = dag.tasks.map((task) => {
    const status = statusByTask.get(task.id);
    const lease = latestLeaseOf(facts, task.id);
    return {
      task_id: task.id,
      title: task.objective,
      wave_index: status?.wave_index ?? -1,
      status: status?.status ?? "waiting_dependency",
      authority: status?.provisional === true ? "provisional" : "ledger",
      dependency_ids: [...task.dependencies],
      non_parallel_reasons: nonParallelReasons(task, dag),
      ...(lease === undefined
        ? {}
        : { current_lease_digest: lease.record_digest, current_run_id: lease.run_id }),
      ...(lease?.retry_kind === undefined ? {} : { retry_kind: lease.retry_kind }),
    };
  });

  const findings = facts.findings.filter(isOpenBlockingFinding);
  const presentation_map: Record<string, string> = {};
  for (const task of tasks) presentation_map[`task:${task.task_id}`] = task.title;
  for (const finding of findings) {
    const rule = findingRule(finding);
    if (rule !== undefined) presentation_map[`finding:${finding.id}`] = rule;
  }

  return finalize({
    capability_status: "active",
    operation: {
      operation_id: dag.operation_id,
      iteration_id: dag.iteration_id,
      status: operationStatusOf(tasks.map((task) => task.status)),
      live_state: projection.live_state,
    },
    plan: { plan_id: dag.plan_id, plan_digest: dag.plan_digest, waves: dag.parallel_waves },
    tasks,
    slots: projection.slots,
    budget: {
      limit: dag.iteration_budget,
      consumed_steps: consumed.steps,
      consumed_tokens: consumed.tokens,
      reserved_steps: reserved.steps,
      reserved_tokens: reserved.tokens,
    },
    approvals: [...facts.approvals],
    findings,
    presentation_map,
  });
}

function latestLeaseOf(
  facts: SchedulerLedgerFacts,
  taskId: string,
): SchedulerLedgerFacts["leases"][number] | undefined {
  let latest: SchedulerLedgerFacts["leases"][number] | undefined;
  const rank = (state: string): number => (state === "granted" ? 0 : 1);
  for (const record of facts.leases) {
    if (record.task_id !== taskId) continue;
    if (
      latest === undefined ||
      record.fencing_token > latest.fencing_token ||
      (record.fencing_token === latest.fencing_token && rank(record.state) >= rank(latest.state))
    ) {
      latest = record;
    }
  }
  return latest;
}

// --- Internal benchmark fixture (plan Task 11 step 6; Task 14 gates <250ms) ---

/**
 * Deterministic N-Task fixture for the read-model benchmark Task 14 exposes
 * as the <250ms release gate. Waves hold up to `waveSize` independent tasks;
 * the first `integratedCount` tasks carry a committed WaveIntegration record.
 * Records are shaped by hand (not the sealed builders) because the benchmark
 * measures projection/read joins, not record construction.
 */
export function buildSchedulerReadModelBenchmarkFixture(input: {
  readonly task_count: number;
  readonly wave_size?: number;
  readonly integrated_waves?: number;
}): {
  readonly dag: TaskDagSnapshot;
  readonly facts: SchedulerLedgerFacts;
} {
  const waveSize = input.wave_size ?? 4;
  const tasks: Protocol13TaskSpecification[] = [];
  for (let index = 0; index < input.task_count; index += 1) {
    tasks.push({
      id: `task_${String(index).padStart(4, "0")}`,
      objective: `Benchmark task ${String(index)}`,
      impact_paths: [[`impact-${String(index)}`]],
      expected_outputs: [`output-${String(index)}`],
      capabilities: ["code-edit"],
      tools: [],
      dependencies: [],
      risk: "low",
      budget: { steps: 10, tokens: 1000, duration_ms: 60_000 },
      write_paths: [`src/bench/${String(index)}`],
      exclusive_resources: [],
      acceptance: [{ description: "works", verification: "unit test" }],
      required_gates: [],
    });
  }
  const waves: ParallelWave[] = [];
  for (let start = 0; start < tasks.length; start += waveSize) {
    waves.push({
      wave_index: waves.length,
      task_ids: tasks.slice(start, start + waveSize).map((task) => task.id),
    });
  }
  const dag: TaskDagSnapshot = {
    operation_id: "operation_bench",
    iteration_id: "iteration_bench",
    plan_id: "plan_bench",
    plan_digest: contentDigest({ plan: "bench", tasks: input.task_count }),
    baseline_commit: "0123456789abcdef0123456789abcdef01234567",
    tasks,
    parallel_waves: waves,
    iteration_budget: {
      steps: input.task_count * 10,
      tokens: input.task_count * 1000,
      duration_ms: 3_600_000,
    },
  };
  const integratedWaves = input.integrated_waves ?? 0;
  const wave_integrations = waves.slice(0, integratedWaves).map(
    (wave) =>
      ({
        protocol_version: "1.3.0",
        record_kind: "wave_integration",
        wave_integration_id: `wave-integration_${String(wave.wave_index)}`,
        operation_id: dag.operation_id,
        iteration_id: dag.iteration_id,
        plan_digest: dag.plan_digest,
        wave_index: wave.wave_index,
        task_ids: [...wave.task_ids],
        base_commit: dag.baseline_commit,
        candidate_commit: contentDigest({ candidate: wave.wave_index }).slice(0, 40),
        accepted_source_tree_digest: contentDigest({ tree: wave.wave_index }),
        task_lease_digests: [],
        task_evidence_digests: [],
        candidate_gate_evidence_digests: [],
        wave_gate_evidence_digests: [],
        policy_digest: "e".repeat(64),
        approval_digests: [],
        command_id: `command_integrate_${String(wave.wave_index)}`,
        integrated_at: "2026-08-31T00:00:05.000Z",
        record_digest: contentDigest({ wave_integration: wave.wave_index }),
      }) as SchedulerLedgerFacts["wave_integrations"][number],
  );
  return {
    dag,
    facts: {
      leases: [],
      runs: [],
      gate_evidence: [],
      approvals: [],
      findings: [],
      wave_integrations,
      candidate_patches: [],
    },
  };
}

/** Re-export convenience for wiring signatures that name the M3 lease. */
export type { LeaseRecord };
