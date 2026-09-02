import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildTaskLeaseRecord,
  contentDigest,
  type FeedbackRecord,
  type RunRecord,
  type TaskLeaseRecord,
  type WaveIntegrationRecord,
} from "@universal-harness-internal/core";
import { afterEach, describe, expect, it } from "vitest";

import type { ApprovalRequestRecord } from "../../src/approval/request.js";
import { buildGateEvidence, type GateEvidenceRecord } from "../../src/gates/evidence.js";
import { normalizeGateDefinition, type GateDefinition } from "../../src/gates/provider.js";
import { actionDigest, type AdapterControlProfile } from "../../src/policy/action.js";
import { issueGrant } from "../../src/policy/capability-grant.js";
import { buildDecision, type EffectivePolicy } from "../../src/policy/decision.js";
import { taskSemanticDigest, type Protocol13TaskSpecification } from "../../src/planning/task.js";
import type { AgentRunResult } from "@universal-harness-internal/plugin-sdk";
import type { SchedulerEventSpec } from "../../src/scheduling/events.js";
import {
  bindSchedulingEvidence,
  createCandidateIntegrationController,
  schedulingEvidenceBindingOf,
  type WaveGatePort,
  type WaveIntegrationGitPort,
} from "../../src/scheduling/integration.js";
import { terminateTaskLease } from "../../src/scheduling/lease.js";
import { createInMemoryPolicyDecisionPort } from "../../src/scheduling/policy-adapters.js";
import type {
  SchedulerLiveSnapshot,
  SchedulerProjectionStore,
  TaskDagSnapshot,
} from "../../src/scheduling/ports.js";
import {
  recoverSchedulingOperation,
  type SchedulingRecoveryReport,
} from "../../src/scheduling/recovery.js";
import {
  createLocalTaskScheduler,
  type QueuedCandidateFact,
  type SchedulerAuthority,
  type SchedulerDriveInput,
  type SchedulerLedgerFacts,
  type SchedulerTransition,
} from "../../src/scheduling/scheduler.js";
import type { DriverLockHandle } from "../../src/scheduling/driver-lock.js";
import type {
  TaskExecutionWorkspace,
  TaskWorkspaceManager,
} from "../../src/scheduling/workspace-manager.js";
import { cleanupDirectories, makeTempDir } from "../bootstrap/helpers.js";
import { MANAGED_PROFILE } from "../policy/fixtures.js";

/**
 * Plan Task 10 step 7 (M4 design §16) plus two review carryovers:
 *
 * - Recovery rebuilds Plan/Lease/budget/wave from Ledger facts only; SQLite is
 *   used solely to locate residual PIDs; orphan leases are revoked, unaccepted
 *   candidate worktrees discarded, candidate-bound evidence downgraded to
 *   provisional, and candidate_validated is never restored from old evidence.
 * - P2-2 (Task 9 review): after a restart, an operation the user cancelled —
 *   proven by a durable user_cancellation terminal Run in the Ledger — is
 *   never re-driven, without relying on process memory.
 * - P2-1 (Task 7 review): the startup sweep removes only worktrees under the
 *   exact managed root that provably belong to revoked leases (the operation
 *   must be fully quiesced), and never touches foreign directories.
 */

const NOW = "2026-09-01T00:00:00.000Z";
const OPERATION_ID = "operation_recovery";
const ITERATION_ID = "iteration_recovery";
const PLAN_DIGEST = contentDigest("recovery-plan");
const BASE_COMMIT = "b".repeat(40);
const EFFECTIVE: EffectivePolicy = { fields: [], layers: [], digest: "e".repeat(64) };
const ADAPTER_MANIFEST_DIGEST = "d".repeat(64);
const CONTROL_PROFILE: AdapterControlProfile = MANAGED_PROFILE;

afterEach(cleanupDirectories);

function task(id: string): Protocol13TaskSpecification {
  return {
    id,
    objective: `Implement ${id}`,
    impact_paths: [],
    expected_outputs: [`output_${id}`],
    capabilities: [],
    tools: [],
    dependencies: [],
    risk: "low",
    budget: { steps: 10, tokens: 1000, duration_ms: 60_000 },
    write_paths: ["src"],
    exclusive_resources: [],
    acceptance: [{ description: "works", verification: "unit test" }],
    required_gates: [],
  };
}

function dagFor(tasks: readonly Protocol13TaskSpecification[]): TaskDagSnapshot {
  return {
    operation_id: OPERATION_ID,
    iteration_id: ITERATION_ID,
    plan_id: "plan_1",
    plan_digest: PLAN_DIGEST,
    baseline_commit: BASE_COMMIT,
    tasks,
    parallel_waves: tasks.length === 0 ? [] : [{ wave_index: 0, task_ids: tasks.map((t) => t.id) }],
    iteration_budget: { steps: 100, tokens: 100_000, duration_ms: 3_600_000 },
  };
}

let leaseCounter = 0;

function grantedLease(
  taskSpec: Protocol13TaskSpecification,
  input: { runId: string; retryKind?: "executor_retry" | "integration_retry" } = { runId: "run" },
): TaskLeaseRecord {
  leaseCounter += 1;
  return buildTaskLeaseRecord({
    operation_id: OPERATION_ID,
    iteration_id: ITERATION_ID,
    plan_digest: PLAN_DIGEST,
    task_id: taskSpec.id,
    task_digest: taskSemanticDigest(taskSpec),
    run_id: input.runId,
    slot_id: "slot_1",
    baseline_commit: BASE_COMMIT,
    agent_adapter_digest: ADAPTER_MANIFEST_DIGEST,
    policy_digest: EFFECTIVE.digest,
    approval_digests: [],
    task_lease_record_id: `task-lease-record_recovery_${String(leaseCounter)}`,
    lease_id: `lease_${taskSpec.id}_${String(leaseCounter)}`,
    fencing_token: leaseCounter,
    state: "granted",
    attempt_number: leaseCounter,
    ...(input.retryKind === undefined ? {} : { retry_kind: input.retryKind }),
    reserved_budget: { steps: 10, tokens: 1000 },
    consumed_budget: { steps: 0, tokens: 0 },
    issued_at: NOW,
    expires_at: "2026-09-01T01:00:00.000Z",
    command_id: `command_recovery_${String(leaseCounter)}`,
  });
}

function releasedChain(taskSpec: Protocol13TaskSpecification, runId: string): TaskLeaseRecord[] {
  const granted = grantedLease(taskSpec, { runId });
  return [
    granted,
    terminateTaskLease(granted, {
      state: "released",
      consumed_budget: { steps: 1, tokens: 10 },
      command_id: `${granted.command_id}_close`,
    }),
  ];
}

function runTerminated(
  taskId: string,
  runId: string,
  reason: "completion" | "user_cancellation" | "adapter_failure",
): RunRecord {
  return {
    protocol_version: "1.3.0",
    record_kind: "run_terminated",
    run_id: runId,
    task_id: taskId,
    workflow_operation_id: OPERATION_ID,
    attempt_id: `attempt_${runId}`,
    sequence: 2,
    timestamp: NOW,
    outcome: reason === "completion" ? "handoff" : "failed",
    termination_reason: reason,
  };
}

function findingRecord(rule: string, blocks: readonly string[], blocking = true): FeedbackRecord {
  const content = {
    protocol_version: "1.3.0",
    record_kind: "feedback" as const,
    id: `finding_${rule}`,
    type: "Finding" as const,
    iteration_id: ITERATION_ID,
    status: "proposed" as const,
    summary: rule,
    created_at: NOW,
    extensions: {
      "harness.finding": {
        origin: "scheduler",
        blocking,
        violates: [],
        blocks: [...blocks],
        evidence: [],
        rule,
        severity: "error",
        actionability: "human_review",
        subject_ids: [...blocks],
        subject_digests: [],
      },
    },
  };
  return { ...content, digest: contentDigest(content) };
}

const GATE = normalizeGateDefinition({
  gate_id: "gate_unit",
  layer: "project",
  name: "unit",
  mandatory: true,
  subject_id: "task_subject",
  tool: "run_unit",
});

function candidateEvidence(
  taskSpec: Protocol13TaskSpecification,
  lease: TaskLeaseRecord,
  commit: string,
  layer: "task" | "candidate" | "wave",
): GateEvidenceRecord {
  const record = buildGateEvidence({
    evidenceId: `evidence_${layer}_${taskSpec.id}`,
    createdAt: NOW,
    outcome: {
      gate_id: GATE.gate_id,
      layer: GATE.layer,
      mandatory: GATE.mandatory,
      passed: true,
      exit_code: 0,
      summary: "ok",
      log_summary: "ok",
      artifact_hashes: {},
      subject_id: taskSpec.id,
      output_digest: contentDigest(`out:${layer}:${taskSpec.id}`),
    },
    bindings: {
      artifact_digests: [],
      code_digests: [commit],
      gate_digest: GATE.digest,
      evaluation_case_digests: [],
      policy_digest: EFFECTIVE.digest,
    },
  });
  return bindSchedulingEvidence(record, {
    plan_digest: PLAN_DIGEST,
    task_digest: taskSemanticDigest(taskSpec),
    task_id: taskSpec.id,
    run_id: lease.run_id,
    lease_id: lease.lease_id,
    fencing_token: lease.fencing_token,
    commit,
    layer,
  });
}

class RecoveryAuthority implements SchedulerAuthority {
  readonly leases: TaskLeaseRecord[] = [];
  readonly runs: RunRecord[] = [];
  readonly gateEvidence: GateEvidenceRecord[] = [];
  readonly approvals: ApprovalRequestRecord[] = [];
  readonly findings: FeedbackRecord[] = [];
  readonly waveIntegrations: WaveIntegrationRecord[] = [];
  readonly candidatePatches: QueuedCandidateFact[] = [];
  readonly events: SchedulerEventSpec[] = [];
  readonly batches: SchedulerTransition[][] = [];
  private readonly candidateArtifactLocators = new Map<string, string>();

  async readFacts(operationId: string): Promise<SchedulerLedgerFacts> {
    if (operationId !== OPERATION_ID) throw new Error(`unknown operation ${operationId}`);
    // The facts view is latest-per-evidence_id: a provisional replica committed
    // by recovery supersedes the original record (append-only Ledger, §16.6).
    const byEvidenceId = new Map<string, GateEvidenceRecord>();
    for (const record of this.gateEvidence) byEvidenceId.set(record.evidence_id, record);
    return {
      leases: [...this.leases],
      runs: [...this.runs],
      gate_evidence: [...byEvidenceId.values()],
      approvals: [...this.approvals],
      findings: [...this.findings],
      wave_integrations: [...this.waveIntegrations],
      candidate_patches: [...this.candidatePatches],
    };
  }

  async commit(transitions: readonly SchedulerTransition[]): Promise<void> {
    this.batches.push([...transitions]);
    for (const transition of transitions) {
      switch (transition.kind) {
        case "grant_lease":
        case "terminate_lease":
          this.leases.push(transition.record);
          break;
        case "record_run":
          this.runs.push(transition.record);
          break;
        case "request_approval":
          this.approvals.push(transition.request);
          break;
        case "create_finding":
          this.findings.push(transition.finding);
          break;
        case "append_gate_evidence":
          this.gateEvidence.push(...transition.records);
          break;
        case "record_wave_integration":
          this.waveIntegrations.push(transition.record);
          break;
        case "append_evidence":
          for (const evidence of transition.evidence) {
            if (evidence.kind === "task_candidate_patch") {
              this.candidateArtifactLocators.set(evidence.digest, evidence.locator);
            }
          }
          break;
        case "append_event":
          this.events.push(transition.event);
          if (transition.event.eventType === "TaskIntegrationQueued") {
            const taskId = transition.event.payload.task_id;
            const runId = transition.event.payload.run_id;
            const patchDigest = transition.event.payload.patch_digest;
            if (
              typeof taskId === "string" &&
              typeof runId === "string" &&
              typeof patchDigest === "string"
            ) {
              const patchLocator = this.candidateArtifactLocators.get(patchDigest);
              if (
                patchLocator !== undefined &&
                !this.candidatePatches.some(
                  (candidate) => candidate.task_id === taskId && candidate.run_id === runId,
                )
              ) {
                this.candidatePatches.push({
                  task_id: taskId,
                  run_id: runId,
                  patch_locator: patchLocator,
                  patch_digest: patchDigest,
                });
              }
            }
          }
          break;
      }
    }
  }
}

class FakePool {
  readonly cancelled: string[] = [];
  readonly runs: string[] = [];

  snapshot() {
    return [];
  }

  async run(): Promise<never> {
    throw new Error("recovery tests never start runs");
  }

  async cancel(runId: string): Promise<void> {
    this.cancelled.push(runId);
  }
}

class FakeProjections implements SchedulerProjectionStore {
  snapshot: SchedulerLiveSnapshot | null = null;

  async replace(snapshot: SchedulerLiveSnapshot): Promise<void> {
    this.snapshot = snapshot;
  }

  async read(): Promise<SchedulerLiveSnapshot | null> {
    return this.snapshot;
  }

  async clear(): Promise<void> {
    this.snapshot = null;
  }
}

class FakeGit implements WaveIntegrationGitPort {
  readonly candidateWorktrees: string[] = [];
  readonly discarded: string[] = [];
  private counter = 0;

  async createCandidateWorktree(): Promise<string> {
    this.counter += 1;
    return `recovery_candidate_${String(this.counter)}`;
  }

  async applyManagedPatch(): Promise<void> {}

  async commitCandidate(input: { task_id: string }): Promise<string> {
    return contentDigest({ candidate: input.task_id, n: this.counter }).slice(0, 40);
  }

  async discardWorktree(root: string): Promise<void> {
    this.discarded.push(root);
  }

  async readRef(): Promise<string | undefined> {
    return undefined;
  }

  async compareAndSwapRef(): Promise<boolean> {
    return true;
  }

  async sourceTreeDigest(commit: string): Promise<string> {
    return contentDigest(`tree:${commit}`);
  }

  async listCandidateWorktrees(): Promise<readonly string[]> {
    return [...this.candidateWorktrees];
  }
}

class FakeGates implements WaveGatePort {
  readonly candidateRuns: Array<{
    readonly task_id: string;
    readonly candidate_commit: string;
    readonly lease_state: TaskLeaseRecord["state"];
  }> = [];

  definitions(): readonly GateDefinition[] {
    return [GATE];
  }

  async runCandidateGates(input: {
    task: Protocol13TaskSpecification;
    candidate_commit: string;
    lease: TaskLeaseRecord;
  }): Promise<readonly GateEvidenceRecord[]> {
    this.candidateRuns.push({
      task_id: input.task.id,
      candidate_commit: input.candidate_commit,
      lease_state: input.lease.state,
    });
    return [candidateEvidence(input.task, input.lease, input.candidate_commit, "candidate")];
  }

  async runWaveGates(): Promise<readonly GateEvidenceRecord[]> {
    return [];
  }
}

function dagPortFor(dag: TaskDagSnapshot) {
  return {
    name: "stub-dag",
    async readApproved(input: {
      operation_id: string;
      expected_plan_digest?: string;
    }): Promise<TaskDagSnapshot> {
      if (
        input.expected_plan_digest !== undefined &&
        input.expected_plan_digest !== dag.plan_digest
      ) {
        throw new Error("plan digest drift");
      }
      return dag;
    },
  };
}

interface RecoveryHarness {
  readonly authority: RecoveryAuthority;
  readonly pool: FakePool;
  readonly projections: FakeProjections;
  readonly git: FakeGit;
  readonly gates: FakeGates;
  readonly dag: TaskDagSnapshot;
  readonly processes: { readonly terminated: number[] };
  readonly recover: () => Promise<SchedulingRecoveryReport>;
}

function recoveryHarness(tasks: readonly Protocol13TaskSpecification[]): RecoveryHarness {
  const authority = new RecoveryAuthority();
  const pool = new FakePool();
  const projections = new FakeProjections();
  const git = new FakeGit();
  const gates = new FakeGates();
  const dag = dagFor(tasks);
  const processes = { terminated: [] as number[] };
  const integration = createCandidateIntegrationController({
    authority,
    git,
    gates,
    effective_policy_digest: EFFECTIVE.digest,
    adapter_manifest_digest: ADAPTER_MANIFEST_DIGEST,
    adapter_control_profile: CONTROL_PROFILE,
    now: () => NOW,
  });
  const managedRoot = join(makeTempDir("harness-m4-recovery-"), "managed");
  return {
    authority,
    pool,
    projections,
    git,
    gates,
    dag,
    processes,
    recover: () =>
      recoverSchedulingOperation(
        {
          dag_port: dagPortFor(dag),
          authority,
          pool: pool as never,
          projections,
          git,
          integration,
          managed_root: managedRoot,
          processes: {
            terminate: async (pid: number) => {
              processes.terminated.push(pid);
              return "terminated" as const;
            },
          },
          now: () => NOW,
        },
        {
          operation_id: OPERATION_ID,
          expected_plan_digest: PLAN_DIGEST,
          recovery_command_id: "command_recover_1",
        },
      ),
  };
}

describe("recoverSchedulingOperation", () => {
  it("retains the full reservation and blocks when orphan usage has no terminal measurement", async () => {
    const taskA = task("task_a");
    const h = recoveryHarness([taskA]);
    const orphan = grantedLease(taskA, { runId: "run_orphan_unknown_usage" });
    h.authority.leases.push(orphan);

    const report = await h.recover();

    const revoked = h.authority.leases.find(
      (record) => record.lease_id === orphan.lease_id && record.state === "revoked",
    );
    expect(revoked?.consumed_budget).toEqual(orphan.reserved_budget);
    expect(report.dispositions).toEqual([{ task_id: taskA.id, disposition: "blocked" }]);
    expect(
      h.authority.findings.some(
        (finding) =>
          (finding.extensions?.["harness.finding"] as { rule?: string } | undefined)?.rule ===
          "budget_usage_unknown",
      ),
    ).toBe(true);
  });

  it("revokes orphan leases, terminates located PIDs and reports retry_pending dispositions", async () => {
    const taskA = task("task_a");
    const h = recoveryHarness([taskA]);
    const orphan = grantedLease(taskA, { runId: "run_orphan_a" });
    h.authority.leases.push(orphan);
    h.authority.runs.push({
      ...runTerminated(taskA.id, orphan.run_id, "adapter_failure"),
      extensions: { "harness.scheduler": { consumed_budget: { steps: 1, tokens: 10 } } },
    });
    h.projections.snapshot = {
      operation_id: OPERATION_ID,
      observed_at: NOW,
      slots: [],
      tasks: [
        {
          task_id: "task_a",
          pid: 4242,
          heartbeat_at: NOW,
          output_tail: null,
          steps: null,
          tokens: null,
          duration_ms: 1,
          worktree_id: "worktree_stub",
        },
      ],
    };

    const report = await h.recover();

    expect(report.revoked_lease_ids).toEqual([orphan.lease_id]);
    expect(report.terminated_pids).toEqual([4242]);
    expect(h.pool.cancelled).toEqual(["run_orphan_a"]);
    const revoked = h.authority.leases.at(-1);
    expect(revoked?.state).toBe("revoked");
    expect(revoked?.fencing_token).toBe(orphan.fencing_token);
    expect(
      h.authority.runs.some(
        (record) => record.run_id === orphan.run_id && record.record_kind === "run_interrupted",
      ),
    ).toBe(false);
    expect(revoked?.consumed_budget).toEqual({ steps: 1, tokens: 10 });
    expect(h.authority.events.map((event) => event.eventType)).toContain("SchedulerRecovered");
    expect(report.dispositions).toEqual([{ task_id: "task_a", disposition: "retry_pending" }]);
    expect(report.candidate_replay).toBe("completed");
  });

  it("blocks a recovered task whose single retry was already consumed", async () => {
    const taskA = task("task_a");
    const h = recoveryHarness([taskA]);
    // Attempt 1 (plain) expired; the executor retry (attempt 2) crashed orphan.
    const first = grantedLease(taskA, { runId: "run_a_1" });
    h.authority.leases.push(
      first,
      terminateTaskLease(first, {
        state: "expired",
        consumed_budget: { steps: 1, tokens: 10 },
        command_id: `${first.command_id}_close`,
      }),
    );
    const second = grantedLease(taskA, { runId: "run_a_2", retryKind: "executor_retry" });
    h.authority.leases.push(second);

    const report = await h.recover();
    expect(report.revoked_lease_ids).toEqual([second.lease_id]);
    expect(report.dispositions).toEqual([{ task_id: "task_a", disposition: "blocked" }]);
  });

  it("discards unaccepted candidate worktrees and downgrades their evidence to provisional", async () => {
    const taskA = task("task_a");
    const h = recoveryHarness([taskA]);
    const [granted, released] = releasedChain(taskA, "run_a_1");
    h.authority.leases.push(granted, released);
    const unacceptedCommit = "c".repeat(40);
    const acceptedCommit = "d".repeat(40);
    // Candidate-layer evidence bound to a candidate commit that was never accepted.
    h.authority.gateEvidence.push(
      candidateEvidence(taskA, released, unacceptedCommit, "candidate"),
    );
    // Task-layer evidence and evidence of an accepted wave survive untouched.
    const taskLayer = candidateEvidence(taskA, released, BASE_COMMIT, "task");
    h.authority.gateEvidence.push(taskLayer);
    h.authority.waveIntegrations.push({
      protocol_version: "1.3.0",
      record_kind: "wave_integration",
      wave_integration_id: "wave-integration_other",
      operation_id: OPERATION_ID,
      iteration_id: ITERATION_ID,
      plan_digest: PLAN_DIGEST,
      wave_index: 1,
      task_ids: ["task_other"],
      base_commit: BASE_COMMIT,
      candidate_commit: acceptedCommit,
      accepted_source_tree_digest: contentDigest("tree"),
      task_lease_digests: [contentDigest("l")],
      task_evidence_digests: [contentDigest("e")],
      candidate_gate_evidence_digests: [contentDigest("c")],
      wave_gate_evidence_digests: [contentDigest("w")],
      policy_digest: EFFECTIVE.digest,
      approval_digests: [],
      command_id: "command_other_wave",
      integrated_at: NOW,
      record_digest: contentDigest("record"),
    } as WaveIntegrationRecord);
    h.git.candidateWorktrees.push("/managed/candidates/wave-0-abc");

    const report = await h.recover();

    expect(report.discarded_candidate_worktrees).toEqual(["/managed/candidates/wave-0-abc"]);
    expect(h.git.discarded).toEqual(["/managed/candidates/wave-0-abc"]);
    expect(report.downgraded_evidence_ids).toEqual([`evidence_candidate_${taskA.id}`]);
    // The facts view now serves the provisional replica; the task layer is intact.
    const facts = await h.authority.readFacts(OPERATION_ID);
    const candidateRecord = facts.gate_evidence.find(
      (record) => record.evidence_id === `evidence_candidate_${taskA.id}`,
    );
    expect(candidateRecord?.provisional).toBe(true);
    const taskRecord = facts.gate_evidence.find(
      (record) => record.evidence_id === `evidence_task_${taskA.id}`,
    );
    expect(taskRecord?.provisional).toBe(false);
  });

  it("never replays the candidate while a wave_gate_failed finding is open", async () => {
    const taskA = task("task_a");
    const h = recoveryHarness([taskA]);
    const [granted, released] = releasedChain(taskA, "run_a_1");
    h.authority.leases.push(granted, released);
    h.authority.findings.push(findingRecord("wave_gate_failed", []));
    h.authority.candidatePatches.push({
      task_id: "task_a",
      run_id: "run_a_1",
      patch_locator: "/virtual/task_a.patch",
      patch_digest: contentDigest("patch-a"),
    });

    const report = await h.recover();

    expect(report.candidate_replay).toBe("skipped_blocking_findings");
    // No candidate gate rerun, no TaskCandidateValidated from old evidence.
    expect(h.authority.events.map((event) => event.eventType)).not.toContain(
      "TaskCandidateValidated",
    );
  });

  it("downgrades and fully revalidates a released unaccepted candidate", async () => {
    const taskA = task("task_a");
    const h = recoveryHarness([taskA]);
    const [granted, released] = releasedChain(taskA, "run_a_1");
    const unacceptedCommit = "c".repeat(40);
    h.authority.leases.push(granted, released);
    h.authority.gateEvidence.push(
      candidateEvidence(taskA, released, BASE_COMMIT, "task"),
      candidateEvidence(taskA, released, unacceptedCommit, "candidate"),
    );
    h.authority.candidatePatches.push({
      task_id: taskA.id,
      run_id: released.run_id,
      patch_locator: "/virtual/task_a.patch",
      patch_digest: contentDigest("patch-a"),
    });

    const report = await h.recover();

    expect(report.downgraded_evidence_ids).toEqual([`evidence_candidate_${taskA.id}`]);
    expect(report.candidate_replay).toBe("completed");
    expect(h.gates.candidateRuns).toEqual([
      {
        task_id: taskA.id,
        candidate_commit: unacceptedCommit,
        lease_state: "released",
      },
    ]);
    const recovered = await h.authority.readFacts(OPERATION_ID);
    const candidate = recovered.gate_evidence.find(
      (record) => record.evidence_id === `evidence_candidate_${taskA.id}`,
    );
    expect(candidate?.provisional).toBe(false);
    expect(schedulingEvidenceBindingOf(candidate as GateEvidenceRecord)?.commit).toBe(
      unacceptedCommit,
    );
    expect(h.authority.events.map((event) => event.eventType)).toContain("TaskCandidateValidated");
  });

  it("replays valid queued patches in Plan order and reruns candidate gates", async () => {
    const taskA = task("task_a");
    const h = recoveryHarness([taskA]);
    const granted = grantedLease(taskA, { runId: "run_a_1" });
    h.authority.leases.push(granted);
    h.authority.runs.push({
      ...runTerminated(taskA.id, granted.run_id, "completion"),
      extensions: { "harness.scheduler": { consumed_budget: { steps: 1, tokens: 10 } } },
    });
    h.authority.gateEvidence.push(candidateEvidence(taskA, granted, BASE_COMMIT, "task"));
    h.authority.candidatePatches.push({
      task_id: "task_a",
      run_id: "run_a_1",
      patch_locator: "/virtual/task_a.patch",
      patch_digest: contentDigest("patch-a"),
    });

    const report = await h.recover();

    expect(report.candidate_replay).toBe("completed");
    expect(report.revoked_lease_ids).toEqual([]);
    // The candidate validation reran and wrote fresh evidence + event; the old
    // candidate state was never resurrected.
    expect(h.authority.events.map((event) => event.eventType)).toContain("TaskCandidateValidated");
    expect(h.authority.leases.at(-1)?.state).toBe("released");
  });

  it("sweeps only managed-root task worktrees of the quiesced operation (P2-1)", async () => {
    const taskA = task("task_a");
    const h = recoveryHarness([taskA]);
    const orphan = grantedLease(taskA, { runId: "run_orphan_a" });
    h.authority.leases.push(orphan);
    const managedRoot = join(makeTempDir("harness-m4-sweep-"), "managed");
    const orphanWorktree = join(managedRoot, "harness-tdd-task_execution-abc123");
    const foreign = join(managedRoot, "someone-elses-dir");
    mkdirSync(orphanWorktree, { recursive: true });
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "keep.txt"), "keep\n", "utf8");

    const report = await recoverSchedulingOperation(
      {
        dag_port: dagPortFor(h.dag),
        authority: h.authority,
        pool: h.pool as never,
        git: h.git,
        managed_root: managedRoot,
        now: () => NOW,
      },
      {
        operation_id: OPERATION_ID,
        expected_plan_digest: PLAN_DIGEST,
        recovery_command_id: "command_recover_sweep",
      },
    );

    // The orphan lease was revoked first, so the operation is quiesced and the
    // sweep provably removes only the manager's own task_execution worktree.
    expect(report.swept_worktrees).toEqual([orphanWorktree]);
    expect(h.git.discarded).toContain(orphanWorktree);
    expect(h.git.discarded).not.toContain(foreign);
  });
});

// --- Scheduler-level durable cancellation and integration retry -------------

function stubResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    outcome: "handoff",
    termination_reason: "completion",
    completion_claimed: true,
    summary: "done",
    tool_activity: { total_calls: 0, governed_calls: 0, by_tool: {} },
    usage: {
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      duration_ms: 1,
      metering: "unmetered",
    },
    evidence: [],
    undeclared_writes: [],
    ...overrides,
  };
}

function stubWorkspaces(): TaskWorkspaceManager {
  let collectCounter = 0;
  return {
    async prepareTaskWorkspace(input): Promise<TaskExecutionWorkspace> {
      return {
        workspace_id: `workspace_${input.task.id}_${input.slot_id}`,
        root: `/virtual/worktrees/${input.task.id}`,
        handle: { workspace_id: `workspace_${input.task.id}_${input.slot_id}` } as never,
      };
    },
    async collectTaskCandidate(input) {
      collectCounter += 1;
      return {
        task_id: input.task.id,
        baseline_commit: BASE_COMMIT,
        changed_paths: [...input.task.write_paths],
        patch_locator: `/virtual/artifacts/${input.task.id}.patch`,
        patch_digest: contentDigest({ patch: input.task.id, n: collectCounter }),
        source_tree_digest: contentDigest({ tree: input.task.id }),
      };
    },
    async collectStrictTddCandidate() {
      throw new Error("not used");
    },
    async discardTaskWorkspace() {},
  };
}

const driverLock: DriverLockHandle = {
  operation_id: OPERATION_ID,
  owner_token: "owner-token",
  path: "/virtual/lock",
  release: async () => {},
};

function schedulerHarness(
  tasks: readonly Protocol13TaskSpecification[],
  authority: RecoveryAuthority,
  script: (taskId: string) => AgentRunResult,
) {
  const dag = dagFor(tasks);
  const pool = {
    runs: [] as string[],
    snapshot: () => [{ slot_id: "slot_1", state: "idle" as const }],
    async run(input: { task_id: string; run_id: string }) {
      this.runs.push(input.run_id);
      return {
        slot_id: "slot_1",
        task_id: input.task_id,
        run_id: input.run_id,
        result: script(input.task_id),
      };
    },
    async cancel() {},
  };
  const scheduler = createLocalTaskScheduler({
    dag_port: dagPortFor(dag),
    policy: createInMemoryPolicyDecisionPort({
      resolve: (action) =>
        buildDecision({
          outcome: "allow",
          reasons: [],
          action_digest: actionDigest(action),
          effective: EFFECTIVE,
        }),
    }),
    authority,
    pool: pool as never,
    workspaces: stubWorkspaces(),
    adapter_manifest_digest: ADAPTER_MANIFEST_DIGEST,
    adapter_control_profile: CONTROL_PROFILE,
    adapter_capabilities: [],
    unattended_eligible: true,
    ceilings: {
      profile_limit: 2,
      installation_limit: 8,
      project_limit: 8,
      local_resource_limit: 8,
    },
    effective_policy_digest: EFFECTIVE.digest,
    callbacks: {
      assembleContext: async ({ task: taskSpec, run_id }) => ({
        context_bundle_id: `context-bundle_${run_id}`,
        context_bundle_digest: contentDigest({ bundle: taskSpec.id, run_id }),
      }),
      issueTaskGrant: ({ task: taskSpec, lease, reservation }) =>
        issueGrant(
          {
            grant_id: `grant_${taskSpec.id}_${String(lease.attempt_number)}`,
            task_id: taskSpec.id,
            capabilities: [...taskSpec.capabilities],
            read_paths: [...taskSpec.write_paths],
            write_paths: [...taskSpec.write_paths],
            phase: "execute",
            budget: reservation,
          },
          EFFECTIVE,
        ),
      buildEnvelope: ({ task: taskSpec }) =>
        ({
          task_id: taskSpec.id,
          plan_id: "plan_1",
          iteration_id: ITERATION_ID,
          repository_id: "repo_1",
          objective: taskSpec.objective,
          expected_output: taskSpec.expected_outputs.join(","),
          acceptance_criteria: [],
          required_gate_ids: [],
          allowed_read_paths: [...taskSpec.write_paths],
          proposed_write_paths: [...taskSpec.write_paths],
          state_proposal_fields: [],
          baseline_commit: BASE_COMMIT,
          input_digest: contentDigest({ input: taskSpec.id }),
          digest: contentDigest({ envelope: taskSpec.id }),
          loop_policy: {
            max_steps: taskSpec.budget.steps,
            max_tokens: taskSpec.budget.tokens,
            max_duration_ms: taskSpec.budget.duration_ms,
          },
        }) as never,
      evidenceDir: ({ run_id }) => `/virtual/evidence/${run_id}`,
    },
    now: () => NOW,
  });
  const driveInput: SchedulerDriveInput = {
    operation_id: OPERATION_ID,
    expected_plan_digest: PLAN_DIGEST,
    requested_max_concurrency: 1,
    driver_lock: driverLock,
  };
  return { scheduler, pool, driveInput, dag };
}

describe("durable cancellation across restart (P2-2)", () => {
  it("never re-drives an operation with a durable user_cancellation terminal run", async () => {
    const taskA = task("task_a");
    const authority = new RecoveryAuthority();
    // Ledger facts as the pre-restart cancel() left them: revoked lease plus a
    // user_cancellation terminal run. The new process remembers nothing.
    const [granted] = releasedChain(taskA, "run_cancelled_a");
    authority.leases.push(
      granted,
      terminateTaskLease(granted, {
        state: "revoked",
        consumed_budget: { steps: 1, tokens: 10 },
        command_id: `${granted.command_id}_cancel`,
      }),
    );
    authority.runs.push(runTerminated("task_a", "run_cancelled_a", "user_cancellation"));

    const { scheduler, pool, driveInput } = schedulerHarness([taskA], authority, () =>
      stubResult(),
    );
    const driven = await scheduler.drive(driveInput);
    expect(driven.status).toBe("cancelled");
    expect(pool.runs).toEqual([]);
    expect(authority.batches).toEqual([]);

    const recovered = await scheduler.recover({
      ...driveInput,
      recovery_command_id: "command_recover_cancelled",
    });
    expect(recovered.status).toBe("cancelled");
    expect(pool.runs).toEqual([]);
  });

  it("still drives an operation whose terminal runs carry no user cancellation", async () => {
    const taskA = task("task_a");
    const authority = new RecoveryAuthority();
    const { scheduler, pool, driveInput } = schedulerHarness([taskA], authority, () =>
      stubResult(),
    );
    const result = await scheduler.drive(driveInput);
    expect(result.status).toBe("completed");
    expect(pool.runs.length).toBe(1);
  });
});

describe("integration retry re-dispatch", () => {
  it("re-dispatches a completed task with an open integration_retry_scheduled signal, once", async () => {
    const taskA = task("task_a");
    const authority = new RecoveryAuthority();
    // Attempt 1 completed and queued a candidate; the controller's rebuild
    // failed to apply it and scheduled the single integration retry.
    const [granted, released] = releasedChain(taskA, "run_a_1");
    authority.leases.push(granted, released);
    authority.runs.push(runTerminated("task_a", "run_a_1", "completion"));
    authority.gateEvidence.push(candidateEvidence(taskA, released, BASE_COMMIT, "task"));
    authority.findings.push(findingRecord("integration_retry_scheduled", ["task_a"], false));

    const { scheduler, pool, driveInput } = schedulerHarness([taskA], authority, () =>
      stubResult(),
    );
    const result = await scheduler.drive(driveInput);

    expect(result.status).toBe("completed");
    expect(pool.runs.length).toBe(1);
    const grants = authority.batches
      .flat()
      .filter((transition) => transition.kind === "grant_lease");
    expect(grants).toHaveLength(1);
    const grant = grants[0];
    if (grant?.kind !== "grant_lease") throw new Error("expected a grant");
    expect(grant.record.retry_kind).toBe("integration_retry");
    expect(grant.record.attempt_number).toBe(released.attempt_number + 1);
    expect(grant.record.fencing_token).toBeGreaterThan(released.fencing_token);

    // The retry was consumed: a second drive never grants a third attempt.
    const batchesBefore = authority.batches.length;
    const again = await scheduler.drive(driveInput);
    expect(
      authority.batches
        .slice(batchesBefore)
        .flat()
        .filter((transition) => transition.kind === "grant_lease"),
    ).toHaveLength(0);
    expect(again.status).not.toBe("completed");
  });
});
