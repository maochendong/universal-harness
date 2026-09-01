import {
  buildTaskLeaseRecord,
  contentDigest,
  type FeedbackRecord,
  type RunRecord,
  type TaskLeaseRecord,
  type WaveIntegrationRecord,
} from "@universal-harness-internal/core";
import { describe, expect, it } from "vitest";

import type { ApprovalRequestRecord } from "../../src/approval/request.js";
import {
  buildGateEvidence,
  type GateEvidenceRecord,
} from "../../src/gates/evidence.js";
import { normalizeGateDefinition, type GateDefinition } from "../../src/gates/provider.js";
import { actionDigest } from "../../src/policy/action.js";
import { buildDecision, type PolicyDecision } from "../../src/policy/decision.js";
import { mergePolicyLayers } from "../../src/policy/evaluator.js";
import {
  taskSemanticDigest,
  type Protocol13TaskSpecification,
} from "../../src/planning/task.js";
import type { ParallelWave } from "../../src/planning/waves.js";
import {
  CandidateIntegrationError,
  bindSchedulingEvidence,
  createCandidateIntegrationController,
  operationRefFor,
  waveIntegrationPolicyInput,
  type CandidateIntegrationController,
  type TaskCandidateValidation,
  type ValidateTaskCandidateInput,
  type WaveGatePort,
  type WaveIntegrationGitPort,
} from "../../src/scheduling/integration.js";
import { buildTaskLeaseChain, terminateTaskLease } from "../../src/scheduling/lease.js";
import { schedulerPolicyAction } from "../../src/scheduling/policy-adapters.js";
import type { TaskDagSnapshot } from "../../src/scheduling/ports.js";
import type {
  SchedulerEventSpec,
} from "../../src/scheduling/events.js";
import type {
  SchedulerAuthority,
  SchedulerLedgerFacts,
  SchedulerTransition,
} from "../../src/scheduling/scheduler.js";
import type { TaskCandidatePatch } from "../../src/scheduling/workspace-manager.js";

/**
 * Plan Task 10 step 1/3/5 (M4 design 13/14/15): candidate patches apply in
 * Plan order onto the wave frozen base regardless of completion order; the
 * first apply failure consumes the single integration_retry while a clean
 * apply that fails a candidate gate is a semantic conflict that never touches
 * the retry budget; every Evidence binding (commit, Plan/Task digest, Run,
 * Lease fencing token, gate definition) is re-validated and any mutation
 * rejects; wave gate failure never moves the operation-local ref nor sends a
 * Task back to retry_pending; acceptance is a command_id-idempotent CAS.
 */

const NOW = "2026-09-01T00:00:00.000Z";
const OPERATION_ID = "operation_integration";
const ITERATION_ID = "iteration_integration";
const PLAN_DIGEST = contentDigest("plan");
const POLICY = mergePolicyLayers([]).effective;
const ADAPTER_MANIFEST_DIGEST = contentDigest("adapter-manifest");
const CONTROL_PROFILE = {
  control: "managed",
  trajectory_visibility: "full",
  usage_metering: true,
  side_effect_interception: true,
} as const;

const hex40 = (letter: string): string => letter.repeat(40);
const BASE_COMMIT = hex40("b");

function task(id: string, overrides: Partial<Protocol13TaskSpecification> = {}): Protocol13TaskSpecification {
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
    ...overrides,
  };
}

function dagFor(
  tasks: readonly Protocol13TaskSpecification[],
  waves: readonly ParallelWave[],
): TaskDagSnapshot {
  return {
    operation_id: OPERATION_ID,
    iteration_id: ITERATION_ID,
    plan_id: "plan_1",
    plan_digest: PLAN_DIGEST,
    baseline_commit: BASE_COMMIT,
    tasks,
    parallel_waves: waves,
    iteration_budget: { steps: 100, tokens: 100_000, duration_ms: 3_600_000 },
  };
}

let leaseCommandCounter = 0;

/** A complete granted (→ terminal) lease chain for one task attempt. */
function leaseChainFor(
  taskSpec: Protocol13TaskSpecification,
  input: { token: number; state?: "released" | "expired" | "revoked"; runId?: string },
): TaskLeaseRecord[] {
  leaseCommandCounter += 1;
  const commandId = `command_lease_${String(leaseCommandCounter)}`;
  const granted = buildTaskLeaseRecord({
    operation_id: OPERATION_ID,
    iteration_id: ITERATION_ID,
    plan_digest: PLAN_DIGEST,
    task_id: taskSpec.id,
    task_digest: taskSemanticDigest(taskSpec),
    run_id: input.runId ?? `run_${taskSpec.id}_${String(input.token)}`,
    slot_id: "slot_1",
    baseline_commit: BASE_COMMIT,
    agent_adapter_digest: ADAPTER_MANIFEST_DIGEST,
    policy_digest: POLICY.digest,
    approval_digests: [],
    task_lease_record_id: `task-lease-record_${String(leaseCommandCounter)}_granted`,
    lease_id: `lease_${taskSpec.id}_${String(input.token)}`,
    fencing_token: input.token,
    state: "granted",
    attempt_number: input.token,
    reserved_budget: { steps: 10, tokens: 1000 },
    consumed_budget: { steps: 0, tokens: 0 },
    issued_at: NOW,
    expires_at: "2026-09-01T01:00:00.000Z",
    command_id: commandId,
  });
  if (input.state === undefined) return [granted];
  const terminal = terminateTaskLease(granted, {
    state: input.state,
    consumed_budget: { steps: 1, tokens: 10 },
    command_id: `${commandId}_close`,
  });
  return [granted, terminal];
}

const GATE = normalizeGateDefinition({
  gate_id: "gate_unit",
  layer: "project",
  name: "unit",
  mandatory: true,
  subject_id: "task_subject",
  tool: "run_unit",
});

interface EvidenceSpec {
  readonly id: string;
  readonly task: Protocol13TaskSpecification;
  readonly lease: TaskLeaseRecord;
  readonly commit: string;
  readonly layer: "task" | "candidate" | "wave";
  readonly gate?: GateDefinition;
  readonly passed?: boolean;
  readonly provisional?: boolean;
}

/** Fully bound M4 scheduling evidence (design 13.2: every freshness field). */
function schedulingEvidence(spec: EvidenceSpec): GateEvidenceRecord {
  const gate = spec.gate ?? GATE;
  const record = buildGateEvidence({
    evidenceId: spec.id,
    createdAt: NOW,
    ...(spec.provisional === true ? { provisional: true } : {}),
    outcome: {
      gate_id: gate.gate_id,
      layer: gate.layer,
      mandatory: gate.mandatory,
      passed: spec.passed ?? true,
      exit_code: spec.passed === false ? 1 : 0,
      summary: "gate ran",
      log_summary: "ok",
      artifact_hashes: {},
      subject_id: spec.task.id,
      output_digest: contentDigest(`output:${spec.id}`),
    },
    bindings: {
      artifact_digests: [],
      code_digests: [spec.commit],
      gate_digest: gate.digest,
      evaluation_case_digests: [],
      policy_digest: POLICY.digest,
    },
  });
  return bindSchedulingEvidence(record, {
    plan_digest: PLAN_DIGEST,
    task_digest: taskSemanticDigest(spec.task),
    task_id: spec.task.id,
    run_id: spec.lease.run_id,
    lease_id: spec.lease.lease_id,
    fencing_token: spec.lease.fencing_token,
    commit: spec.commit,
    layer: spec.layer,
  });
}

function evidenceRef(record: GateEvidenceRecord): { kind: string; locator: string; digest: string } {
  return { kind: "gate_result", locator: `ledger://evidence/${record.evidence_id}`, digest: record.digest };
}

class IntegrationAuthority implements SchedulerAuthority {
  readonly leases: TaskLeaseRecord[] = [];
  readonly runs: RunRecord[] = [];
  readonly gateEvidence: GateEvidenceRecord[] = [];
  readonly approvals: ApprovalRequestRecord[] = [];
  readonly findings: FeedbackRecord[] = [];
  readonly waveIntegrations: WaveIntegrationRecord[] = [];
  readonly events: SchedulerEventSpec[] = [];
  readonly batches: SchedulerTransition[][] = [];

  async readFacts(operationId: string): Promise<SchedulerLedgerFacts> {
    if (operationId !== OPERATION_ID) throw new Error(`unknown operation ${operationId}`);
    return {
      leases: [...this.leases],
      runs: [...this.runs],
      gate_evidence: [...this.gateEvidence],
      approvals: [...this.approvals],
      findings: [...this.findings],
      wave_integrations: [...this.waveIntegrations],
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
        case "append_evidence":
          break;
        case "append_gate_evidence":
          this.gateEvidence.push(...transition.records);
          break;
        case "record_wave_integration":
          this.waveIntegrations.push(transition.record);
          break;
        case "append_event":
          this.events.push(transition.event);
          break;
      }
    }
  }
}

/** Scriptable in-memory git: hex commits, ref map, apply-order recording. */
class FakeWaveGit implements WaveIntegrationGitPort {
  readonly refs = new Map<string, string>();
  readonly applied: string[] = [];
  readonly commits: string[] = [];
  readonly discarded: string[] = [];
  readonly worktreeBases: string[] = [];
  readonly failApplyFor = new Set<string>();
  casResult = true;
  private counter = 0;

  async createCandidateWorktree(input: { base_commit: string; wave_index: number }): Promise<string> {
    this.worktreeBases.push(input.base_commit);
    this.counter += 1;
    return `fake_worktree_${String(this.counter)}`;
  }

  async applyManagedPatch(input: {
    worktree_root: string;
    patch: TaskCandidatePatch;
  }): Promise<void> {
    if (this.failApplyFor.has(input.patch.task_id)) {
      throw new Error(`patch for ${input.patch.task_id} does not apply`);
    }
    this.applied.push(input.patch.task_id);
  }

  async commitCandidate(input: { worktree_root: string; task_id: string; message: string }): Promise<string> {
    const commit = contentDigest({ commit: input.task_id, n: this.commits.length }).slice(0, 40);
    this.commits.push(commit);
    return commit;
  }

  async discardWorktree(root: string): Promise<void> {
    this.discarded.push(root);
  }

  async readRef(ref: string): Promise<string | undefined> {
    return this.refs.get(ref);
  }

  async compareAndSwapRef(input: {
    ref: string;
    expected: string | undefined;
    next: string;
  }): Promise<boolean> {
    if (!this.casResult) return false;
    if (this.refs.get(input.ref) !== input.expected) return false;
    this.refs.set(input.ref, input.next);
    return true;
  }

  async sourceTreeDigest(commit: string): Promise<string> {
    return contentDigest(`source-tree:${commit}`);
  }

  async listCandidateWorktrees(): Promise<readonly string[]> {
    return [];
  }
}

class FakeWaveGates implements WaveGatePort {
  candidateFailureFor = new Set<string>();
  waveFails = false;

  definitions(): readonly GateDefinition[] {
    return [GATE];
  }

  async runCandidateGates(input: {
    task: Protocol13TaskSpecification;
    candidate_commit: string;
    lease: TaskLeaseRecord;
  }): Promise<readonly GateEvidenceRecord[]> {
    const passed = !this.candidateFailureFor.has(input.task.id);
    return [
      schedulingEvidence({
        id: `evidence_candidate_${input.task.id}`,
        task: input.task,
        lease: input.lease,
        commit: input.candidate_commit,
        layer: "candidate",
        passed,
      }),
    ];
  }

  async runWaveGates(input: {
    candidate_commit: string;
    tasks: readonly Protocol13TaskSpecification[];
    leases: readonly TaskLeaseRecord[];
  }): Promise<readonly GateEvidenceRecord[]> {
    const firstTask = input.tasks[0] as Protocol13TaskSpecification;
    const firstLease = input.leases[0] as TaskLeaseRecord;
    return [
      schedulingEvidence({
        id: "evidence_wave",
        task: firstTask,
        lease: firstLease,
        commit: input.candidate_commit,
        layer: "wave",
        passed: !this.waveFails,
      }),
    ];
  }
}

function patchFor(taskSpec: Protocol13TaskSpecification, changedPaths: readonly string[] = [`src/${taskSpec.id}.ts`]): TaskCandidatePatch {
  const patch = `diff --git a/${changedPaths[0]} b/${changedPaths[0]}\n`;
  return {
    task_id: taskSpec.id,
    baseline_commit: BASE_COMMIT,
    changed_paths: changedPaths,
    patch_locator: `artifacts/${taskSpec.id}.patch`,
    patch_digest: contentDigest(patch),
    source_tree_digest: contentDigest(`tree:${taskSpec.id}`),
  };
}

interface Harness {
  readonly authority: IntegrationAuthority;
  readonly git: FakeWaveGit;
  readonly gates: FakeWaveGates;
  readonly controller: CandidateIntegrationController;
}

function harness(): Harness {
  const authority = new IntegrationAuthority();
  const git = new FakeWaveGit();
  const gates = new FakeWaveGates();
  const controller = createCandidateIntegrationController({
    authority,
    git,
    gates,
    effective_policy_digest: POLICY.digest,
    adapter_manifest_digest: ADAPTER_MANIFEST_DIGEST,
    adapter_control_profile: CONTROL_PROFILE,
    now: () => NOW,
  });
  return { authority, git, gates, controller };
}

/** Queue + rebuild the single-wave candidate for the given tasks. */
async function prepareCandidate(
  h: Harness,
  tasks: readonly Protocol13TaskSpecification[],
): Promise<{ dag: TaskDagSnapshot; wave: ParallelWave; candidateCommit: string; candidate: Awaited<ReturnType<CandidateIntegrationController["rebuildWaveCandidate"]>> }> {
  const wave: ParallelWave = { wave_index: 0, task_ids: tasks.map((t) => t.id) };
  const dag = dagFor(tasks, [wave]);
  for (const taskSpec of tasks) await h.controller.queueTaskCandidate(patchFor(taskSpec));
  const candidate = await h.controller.rebuildWaveCandidate({
    dag,
    wave,
    expected_base_commit: BASE_COMMIT,
  });
  return { dag, wave, candidateCommit: candidate.candidate_commit, candidate };
}

/** Lease chain + layer-1 task evidence preloaded as authoritative facts. */
function preloadTaskFacts(
  h: Harness,
  taskSpec: Protocol13TaskSpecification,
  candidateCommit: string,
): { lease: TaskLeaseRecord; taskEvidence: GateEvidenceRecord } {
  const chain = leaseChainFor(taskSpec, { token: 1, state: "released" });
  h.authority.leases.push(...chain);
  const released = chain[1] as TaskLeaseRecord;
  const taskEvidence = schedulingEvidence({
    id: `evidence_task_${taskSpec.id}`,
    task: taskSpec,
    lease: released,
    commit: BASE_COMMIT,
    layer: "task",
  });
  h.authority.gateEvidence.push(taskEvidence);
  void candidateCommit;
  return { lease: released, taskEvidence };
}

async function validateOne(
  h: Harness,
  dag: TaskDagSnapshot,
  candidate: Awaited<ReturnType<CandidateIntegrationController["rebuildWaveCandidate"]>>,
  taskSpec: Protocol13TaskSpecification,
): Promise<TaskCandidateValidation> {
  const { lease, taskEvidence } = preloadTaskFacts(h, taskSpec, candidate.candidate_commit);
  const input: ValidateTaskCandidateInput = {
    candidate,
    task: taskSpec,
    lease,
    evidence: [evidenceRef(taskEvidence)],
  };
  void dag;
  return h.controller.validateTaskCandidate(input);
}

function allowWaveDecision(dag: TaskDagSnapshot, wave: ParallelWave, baseCommit: string, authority: IntegrationAuthority): PolicyDecision {
  const input = waveIntegrationPolicyInput({
    dag,
    wave,
    base_commit: baseCommit,
    leases: authority.leases,
    adapter_manifest_digest: ADAPTER_MANIFEST_DIGEST,
    adapter_control_profile: CONTROL_PROFILE,
    effective_policy_digest: POLICY.digest,
    now: NOW,
  });
  return buildDecision({
    outcome: "allow",
    reasons: ["allowed"],
    action_digest: actionDigest(schedulerPolicyAction(input)),
    effective: POLICY,
  });
}

function findingRules(authority: IntegrationAuthority): readonly string[] {
  return authority.findings.map(
    (finding) =>
      (finding.extensions?.["harness.finding"] as { rule?: string } | undefined)?.rule ?? "",
  );
}

describe("rebuildWaveCandidate", () => {
  it("applies queued patches in Plan order, from the wave frozen base", async () => {
    const h = harness();
    const taskA = task("task_a");
    const taskB = task("task_b");
    const wave: ParallelWave = { wave_index: 0, task_ids: ["task_a", "task_b"] };
    const dag = dagFor([taskA, taskB], [wave]);

    // Task B completes before Task A: completion order is irrelevant.
    await h.controller.queueTaskCandidate(patchFor(taskB));
    await h.controller.queueTaskCandidate(patchFor(taskA));
    const prepared = await h.controller.rebuildWaveCandidate({
      dag,
      wave,
      expected_base_commit: BASE_COMMIT,
    });

    expect(prepared.applied_task_ids).toEqual(["task_a", "task_b"]);
    expect(prepared.base_commit).toBe(BASE_COMMIT);
    expect(prepared.wave_index).toBe(0);
    expect(h.git.worktreeBases).toEqual([BASE_COMMIT]);
    expect(h.git.applied).toEqual(["task_a", "task_b"]);
  });

  it("rejects a rebuilt wave whose expected base drifted", async () => {
    const h = harness();
    const taskA = task("task_a");
    const wave: ParallelWave = { wave_index: 0, task_ids: ["task_a"] };
    const dag = dagFor([taskA], [wave]);
    await h.controller.queueTaskCandidate(patchFor(taskA));
    await expect(
      h.controller.rebuildWaveCandidate({ dag, wave, expected_base_commit: hex40("d") }),
    ).rejects.toMatchObject({ kind: "wave_base_mismatch" });
  });

  it("fails closed when a wave task has no queued candidate", async () => {
    const h = harness();
    const taskA = task("task_a");
    const taskB = task("task_b");
    const wave: ParallelWave = { wave_index: 0, task_ids: ["task_a", "task_b"] };
    const dag = dagFor([taskA, taskB], [wave]);
    await h.controller.queueTaskCandidate(patchFor(taskA));
    await expect(
      h.controller.rebuildWaveCandidate({ dag, wave, expected_base_commit: BASE_COMMIT }),
    ).rejects.toMatchObject({ kind: "missing_candidate" });
  });

  it("consumes the single integration_retry on the first apply failure and blocks on the second", async () => {
    const h = harness();
    const taskA = task("task_a");
    const wave: ParallelWave = { wave_index: 0, task_ids: ["task_a"] };
    const dag = dagFor([taskA], [wave]);
    const chain = leaseChainFor(taskA, { token: 1, state: "released" });
    h.authority.leases.push(...chain);
    await h.controller.queueTaskCandidate(patchFor(taskA));
    h.git.failApplyFor.add("task_a");

    await expect(
      h.controller.rebuildWaveCandidate({ dag, wave, expected_base_commit: BASE_COMMIT }),
    ).rejects.toMatchObject({ kind: "integration_conflict" });
    // First failure: exactly one integration_retry is scheduled; nothing blocks yet.
    expect(
      h.authority.events.filter((event) => event.eventType === "TaskRetryScheduled"),
    ).toHaveLength(1);
    expect(h.authority.events[0]?.payload.retry_kind).toBe("integration_retry");
    expect(findingRules(h.authority)).toEqual(["integration_retry_scheduled"]);
    expect(h.git.discarded).toHaveLength(1);

    // Second failure of the same class: the retry budget is exhausted and the
    // Task blocks; no second retry is ever scheduled.
    await expect(
      h.controller.rebuildWaveCandidate({ dag, wave, expected_base_commit: BASE_COMMIT }),
    ).rejects.toMatchObject({ kind: "integration_conflict" });
    expect(
      h.authority.events.filter((event) => event.eventType === "TaskRetryScheduled"),
    ).toHaveLength(1);
    expect(findingRules(h.authority)).toEqual([
      "integration_retry_scheduled",
      "integration_conflict",
    ]);
    const blocking = h.authority.findings[1];
    expect(
      (blocking?.extensions?.["harness.finding"] as { blocking?: boolean }).blocking,
    ).toBe(true);
  });

  it("treats an operation-local ref drift at rebuild time as baseline_drift, never a retry", async () => {
    const h = harness();
    const taskA = task("task_a");
    const wave: ParallelWave = { wave_index: 0, task_ids: ["task_a"] };
    const dag = dagFor([taskA], [wave]);
    await h.controller.queueTaskCandidate(patchFor(taskA));
    h.git.refs.set(operationRefFor(OPERATION_ID), hex40("e"));
    await expect(
      h.controller.rebuildWaveCandidate({ dag, wave, expected_base_commit: BASE_COMMIT }),
    ).rejects.toMatchObject({ kind: "baseline_drift" });
    expect(h.authority.events.filter((e) => e.eventType === "TaskRetryScheduled")).toHaveLength(0);
  });

  it("builds wave N>0 on the accepted candidate commit of wave N-1", async () => {
    const h = harness();
    const taskA = task("task_a");
    const taskB = task("task_b", { dependencies: ["task_a"] });
    const wave0: ParallelWave = { wave_index: 0, task_ids: ["task_a"] };
    const wave1: ParallelWave = { wave_index: 1, task_ids: ["task_b"] };
    const dag = dagFor([taskA, taskB], [wave0, wave1]);
    const wave0Commit = hex40("f");
    h.authority.waveIntegrations.push({
      protocol_version: "1.3.0",
      record_kind: "wave_integration",
      wave_integration_id: "wave-integration_0",
      operation_id: OPERATION_ID,
      iteration_id: ITERATION_ID,
      plan_digest: PLAN_DIGEST,
      wave_index: 0,
      task_ids: ["task_a"],
      base_commit: BASE_COMMIT,
      candidate_commit: wave0Commit,
      accepted_source_tree_digest: contentDigest("tree0"),
      task_lease_digests: [contentDigest("l0")],
      task_evidence_digests: [contentDigest("e0")],
      candidate_gate_evidence_digests: [contentDigest("c0")],
      wave_gate_evidence_digests: [contentDigest("w0")],
      policy_digest: POLICY.digest,
      approval_digests: [],
      command_id: "command_wave_0",
      integrated_at: NOW,
      record_digest: "",
    } as WaveIntegrationRecord);
    h.git.refs.set(operationRefFor(OPERATION_ID), wave0Commit);

    await h.controller.queueTaskCandidate(patchFor(taskB));
    const prepared = await h.controller.rebuildWaveCandidate({
      dag,
      wave: wave1,
      expected_base_commit: wave0Commit,
    });
    expect(prepared.base_commit).toBe(wave0Commit);
    expect(h.git.worktreeBases).toEqual([wave0Commit]);
  });
});

describe("validateTaskCandidate", () => {
  it("validates a fully bound candidate and writes TaskCandidateValidated", async () => {
    const h = harness();
    const taskA = task("task_a");
    const { dag, candidate } = await prepareCandidate(h, [taskA]);
    void dag;
    const validation = await validateOne(h, dagFor([taskA], [{ wave_index: 0, task_ids: ["task_a"] }]), candidate, taskA);
    expect(validation.status).toBe("candidate_validated");
    expect(validation.task_id).toBe("task_a");
    expect(validation.evidence_digests.length).toBe(2);
    expect(h.authority.events.map((event) => event.eventType)).toContain("TaskCandidateValidated");
  });

  it("rejects when the lease is not the current one for the task", async () => {
    const h = harness();
    const taskA = task("task_a");
    const { candidate } = await prepareCandidate(h, [taskA]);
    const { lease, taskEvidence } = preloadTaskFacts(h, taskA, candidate.candidate_commit);
    // A newer attempt superseded the validating lease.
    h.authority.leases.push(...leaseChainFor(taskA, { token: 2, state: "released", runId: "run_task_a_2" }));
    await expect(
      h.controller.validateTaskCandidate({
        candidate,
        task: taskA,
        lease,
        evidence: [evidenceRef(taskEvidence)],
      }),
    ).rejects.toMatchObject({ kind: "lease_not_current" });
  });

  it.each(["expired", "revoked"] as const)("rejects a %s lease", async (state) => {
    const h = harness();
    const taskA = task("task_a");
    const { candidate } = await prepareCandidate(h, [taskA]);
    const chain = leaseChainFor(taskA, { token: 1, state });
    h.authority.leases.push(...chain);
    const terminal = chain[1] as TaskLeaseRecord;
    const taskEvidence = schedulingEvidence({
      id: "evidence_task_a",
      task: taskA,
      lease: terminal,
      commit: BASE_COMMIT,
      layer: "task",
    });
    h.authority.gateEvidence.push(taskEvidence);
    await expect(
      h.controller.validateTaskCandidate({
        candidate,
        task: taskA,
        lease: terminal,
        evidence: [evidenceRef(taskEvidence)],
      }),
    ).rejects.toMatchObject({ kind: "lease_not_released" });
  });

  it("rejects candidate evidence bound to a mutated field", async () => {
    const h = harness();
    const taskA = task("task_a");
    const { candidate } = await prepareCandidate(h, [taskA]);
    const { lease, taskEvidence } = preloadTaskFacts(h, taskA, candidate.candidate_commit);

    const mutate = (record: GateEvidenceRecord, field: string, value: unknown): GateEvidenceRecord => {
      const binding = {
        ...(record.extensions?.["harness.scheduling"] as Record<string, unknown>),
        [field]: value,
      };
      return {
        ...record,
        extensions: { ...record.extensions, "harness.scheduling": binding },
      };
    };

    const mutations: readonly GateEvidenceRecord[] = [
      mutate(taskEvidence, "commit", hex40("0")),
      mutate(taskEvidence, "plan_digest", contentDigest("other-plan")),
      mutate(taskEvidence, "task_digest", contentDigest("other-task")),
      mutate(taskEvidence, "run_id", "run_other"),
      mutate(taskEvidence, "fencing_token", 99),
    ];
    for (const mutated of mutations) {
      const fresh = harness();
      const { candidate: freshCandidate } = await prepareCandidate(fresh, [taskA]);
      const facts = preloadTaskFacts(fresh, taskA, freshCandidate.candidate_commit);
      fresh.authority.gateEvidence.length = 0;
      fresh.authority.gateEvidence.push(mutated);
      await expect(
        fresh.controller.validateTaskCandidate({
          candidate: freshCandidate,
          task: taskA,
          lease: facts.lease,
          evidence: [evidenceRef(mutated)],
        }),
      ).rejects.toMatchObject({ kind: "evidence_binding_mismatch" });
      void lease;
    }
  });

  it("rejects evidence bound to a drifted gate definition digest", async () => {
    const h = harness();
    const taskA = task("task_a");
    const { candidate } = await prepareCandidate(h, [taskA]);
    const { lease } = preloadTaskFacts(h, taskA, candidate.candidate_commit);
    const staleGate = normalizeGateDefinition({
      gate_id: "gate_unit",
      layer: "project",
      name: "unit",
      mandatory: true,
      subject_id: "task_subject",
      tool: "run_unit",
      version: "0.9-older",
    });
    const staleEvidence = schedulingEvidence({
      id: "evidence_task_a",
      task: taskA,
      lease,
      commit: BASE_COMMIT,
      layer: "task",
      gate: staleGate,
    });
    h.authority.gateEvidence.length = 0;
    h.authority.gateEvidence.push(staleEvidence);
    await expect(
      h.controller.validateTaskCandidate({
        candidate,
        task: taskA,
        lease,
        evidence: [evidenceRef(staleEvidence)],
      }),
    ).rejects.toMatchObject({ kind: "evidence_stale" });
  });

  it("rejects provisional evidence", async () => {
    const h = harness();
    const taskA = task("task_a");
    const { candidate } = await prepareCandidate(h, [taskA]);
    const { lease } = preloadTaskFacts(h, taskA, candidate.candidate_commit);
    const provisional = schedulingEvidence({
      id: "evidence_task_a",
      task: taskA,
      lease,
      commit: BASE_COMMIT,
      layer: "task",
      provisional: true,
    });
    h.authority.gateEvidence.length = 0;
    h.authority.gateEvidence.push(provisional);
    await expect(
      h.controller.validateTaskCandidate({
        candidate,
        task: taskA,
        lease,
        evidence: [evidenceRef(provisional)],
      }),
    ).rejects.toMatchObject({ kind: "evidence_binding_mismatch" });
  });

  it("treats a clean apply with a failing candidate gate as a semantic conflict, never a retry", async () => {
    const h = harness();
    const taskA = task("task_a");
    const { candidate } = await prepareCandidate(h, [taskA]);
    h.gates.candidateFailureFor.add("task_a");
    const validation = await validateOne(
      h,
      dagFor([taskA], [{ wave_index: 0, task_ids: ["task_a"] }]),
      candidate,
      taskA,
    );
    expect(validation.status).toBe("blocked");
    expect(findingRules(h.authority)).toEqual(["candidate_gate_failed"]);
    // Semantic conflict never consumes the integration retry.
    expect(h.authority.events.filter((e) => e.eventType === "TaskRetryScheduled")).toHaveLength(0);
    expect(h.authority.events.map((e) => e.eventType)).not.toContain("TaskCandidateValidated");
  });

  it("rejects a queued patch that writes outside the declared write set", async () => {
    const h = harness();
    const taskA = task("task_a");
    const wave: ParallelWave = { wave_index: 0, task_ids: ["task_a"] };
    const dag = dagFor([taskA], [wave]);
    await h.controller.queueTaskCandidate(patchFor(taskA, ["etc/passwd"]));
    const candidate = await h.controller.rebuildWaveCandidate({
      dag,
      wave,
      expected_base_commit: BASE_COMMIT,
    });
    await expect(validateOne(h, dag, candidate, taskA)).rejects.toMatchObject({
      kind: "undeclared_write",
    });
  });
});

describe("acceptWave", () => {
  async function validatedWave(taskIds: readonly string[]): Promise<{
    h: Harness;
    dag: TaskDagSnapshot;
    wave: ParallelWave;
    candidate: Awaited<ReturnType<CandidateIntegrationController["rebuildWaveCandidate"]>>;
    validations: readonly TaskCandidateValidation[];
  }> {
    const h = harness();
    const tasks = taskIds.map((id) => task(id));
    const wave: ParallelWave = { wave_index: 0, task_ids: [...taskIds] };
    const dag = dagFor(tasks, [wave]);
    for (const taskSpec of tasks) await h.controller.queueTaskCandidate(patchFor(taskSpec));
    const candidate = await h.controller.rebuildWaveCandidate({
      dag,
      wave,
      expected_base_commit: BASE_COMMIT,
    });
    const validations: TaskCandidateValidation[] = [];
    for (const taskSpec of tasks) {
      const { lease, taskEvidence } = preloadTaskFacts(h, taskSpec, candidate.candidate_commit);
      validations.push(
        await h.controller.validateTaskCandidate({
          candidate,
          task: taskSpec,
          lease,
          evidence: [evidenceRef(taskEvidence)],
        }),
      );
    }
    return { h, dag, wave, candidate, validations };
  }

  it("commits the WaveIntegrationRecord and CASes the operation-local ref once", async () => {
    const { h, dag, wave, candidate, validations } = await validatedWave(["task_a", "task_b"]);
    const decision = allowWaveDecision(dag, wave, candidate.base_commit, h.authority);
    const accepted = await h.controller.acceptWave({
      dag,
      candidate,
      validations,
      policy_decision: decision,
      approval_digests: [],
      command_id: "command_integrate_wave_0",
    });

    expect(accepted.operation_id).toBe(OPERATION_ID);
    expect(accepted.wave_index).toBe(0);
    expect(accepted.task_ids).toEqual(["task_a", "task_b"]);
    expect(accepted.base_commit).toBe(BASE_COMMIT);
    expect(accepted.candidate_commit).toBe(candidate.candidate_commit);
    expect(accepted.accepted_source_tree_digest).toBe(
      contentDigest(`source-tree:${candidate.candidate_commit}`),
    );
    expect(accepted.command_id).toBe("command_integrate_wave_0");
    expect(h.git.refs.get(operationRefFor(OPERATION_ID))).toBe(candidate.candidate_commit);
    expect(h.authority.waveIntegrations).toHaveLength(1);
    expect(h.authority.events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["WaveGateCompleted", "WaveIntegrated"]),
    );
  });

  it("discovers an accepted record on command_id replay instead of advancing twice", async () => {
    const { h, dag, candidate, validations } = await validatedWave(["task_a"]);
    const wave: ParallelWave = { wave_index: 0, task_ids: ["task_a"] };
    const decision = allowWaveDecision(dag, wave, candidate.base_commit, h.authority);
    const first = await h.controller.acceptWave({
      dag,
      candidate,
      validations,
      policy_decision: decision,
      approval_digests: [],
      command_id: "command_integrate_wave_0",
    });
    const batchesAfterFirst = h.authority.batches.length;

    // Lost response: the caller retries the identical command.
    const replayed = await h.controller.acceptWave({
      dag,
      candidate,
      validations,
      policy_decision: decision,
      approval_digests: [],
      command_id: "command_integrate_wave_0",
    });
    expect(replayed.record_digest).toBe(first.record_digest);
    expect(h.authority.waveIntegrations).toHaveLength(1);
    expect(h.authority.batches.length).toBe(batchesAfterFirst);
    expect(h.git.refs.get(operationRefFor(OPERATION_ID))).toBe(candidate.candidate_commit);
  });

  it("refuses a command_id replay with different content", async () => {
    const { h, dag, candidate, validations } = await validatedWave(["task_a"]);
    const wave: ParallelWave = { wave_index: 0, task_ids: ["task_a"] };
    const decision = allowWaveDecision(dag, wave, candidate.base_commit, h.authority);
    await h.controller.acceptWave({
      dag,
      candidate,
      validations,
      policy_decision: decision,
      approval_digests: [],
      command_id: "command_integrate_wave_0",
    });
    const otherCandidate = { ...candidate, candidate_commit: hex40("1") };
    await expect(
      h.controller.acceptWave({
        dag,
        candidate: otherCandidate,
        validations,
        policy_decision: decision,
        approval_digests: [],
        command_id: "command_integrate_wave_0",
      }),
    ).rejects.toMatchObject({ kind: "command_conflict" });
  });

  it("fails baseline_drift without retry when the operation ref moved before acceptance", async () => {
    const { h, dag, wave, candidate, validations } = await validatedWave(["task_a"]);
    h.git.refs.set(operationRefFor(OPERATION_ID), hex40("9"));
    const decision = allowWaveDecision(dag, wave, candidate.base_commit, h.authority);
    await expect(
      h.controller.acceptWave({
        dag,
        candidate,
        validations,
        policy_decision: decision,
        approval_digests: [],
        command_id: "command_integrate_wave_0",
      }),
    ).rejects.toMatchObject({ kind: "baseline_drift" });
    expect(findingRules(h.authority)).toEqual(["baseline_drift"]);
    expect(h.authority.waveIntegrations).toHaveLength(0);
    expect(h.git.refs.get(operationRefFor(OPERATION_ID))).toBe(hex40("9"));
    expect(h.authority.events.filter((e) => e.eventType === "TaskRetryScheduled")).toHaveLength(0);
  });

  it("wave gate failure leaves the ref unchanged, records wave_gate_failed and never retries tasks", async () => {
    const { h, dag, wave, candidate, validations } = await validatedWave(["task_a"]);
    h.gates.waveFails = true;
    const decision = allowWaveDecision(dag, wave, candidate.base_commit, h.authority);
    await expect(
      h.controller.acceptWave({
        dag,
        candidate,
        validations,
        policy_decision: decision,
        approval_digests: [],
        command_id: "command_integrate_wave_0",
      }),
    ).rejects.toMatchObject({ kind: "wave_gate_failed" });
    expect(findingRules(h.authority)).toEqual(["wave_gate_failed"]);
    expect(h.git.refs.get(operationRefFor(OPERATION_ID))).toBeUndefined();
    expect(h.authority.waveIntegrations).toHaveLength(0);
    // No lease or run transition: validated Tasks never return to retry_pending.
    expect(
      h.authority.batches.flat().some((t) => t.kind === "terminate_lease" || t.kind === "record_run"),
    ).toBe(false);
    const completed = h.authority.events.find((e) => e.eventType === "WaveGateCompleted");
    expect(completed?.payload.passed).toBe(false);
  });

  it("rejects a wave whose validation set is incomplete", async () => {
    const { h, dag, wave, candidate } = await validatedWave(["task_a", "task_b"]);
    const decision = allowWaveDecision(dag, wave, candidate.base_commit, h.authority);
    await expect(
      h.controller.acceptWave({
        dag,
        candidate,
        validations: [],
        policy_decision: decision,
        approval_digests: [],
        command_id: "command_integrate_wave_0",
      }),
    ).rejects.toMatchObject({ kind: "candidate_not_validated" });
  });

  it("revalidates lease currency at acceptance: a newer attempt fences the validated lease", async () => {
    const { h, dag, wave, candidate, validations } = await validatedWave(["task_a"]);
    // A retry attempt was granted after validation: the validated token is stale.
    const taskA = task("task_a");
    h.authority.leases.push(...leaseChainFor(taskA, { token: 2, runId: "run_task_a_2" }));
    const decision = allowWaveDecision(dag, wave, candidate.base_commit, h.authority);
    await expect(
      h.controller.acceptWave({
        dag,
        candidate,
        validations,
        policy_decision: decision,
        approval_digests: [],
        command_id: "command_integrate_wave_0",
      }),
    ).rejects.toMatchObject({ kind: "lease_not_current" });
    expect(h.authority.waveIntegrations).toHaveLength(0);
    expect(h.git.refs.get(operationRefFor(OPERATION_ID))).toBeUndefined();
  });

  it("rejects a denied policy decision without touching the ref", async () => {
    const { h, dag, wave, candidate, validations } = await validatedWave(["task_a"]);
    const input = waveIntegrationPolicyInput({
      dag,
      wave,
      base_commit: candidate.base_commit,
      leases: h.authority.leases,
      adapter_manifest_digest: ADAPTER_MANIFEST_DIGEST,
      adapter_control_profile: CONTROL_PROFILE,
      effective_policy_digest: POLICY.digest,
      now: NOW,
    });
    const denied = buildDecision({
      outcome: "deny",
      reasons: ["policy denies wave integration"],
      action_digest: actionDigest(schedulerPolicyAction(input)),
      effective: POLICY,
    });
    await expect(
      h.controller.acceptWave({
        dag,
        candidate,
        validations,
        policy_decision: denied,
        approval_digests: [],
        command_id: "command_integrate_wave_0",
      }),
    ).rejects.toMatchObject({ kind: "policy_not_allowed" });
    expect(h.git.refs.get(operationRefFor(OPERATION_ID))).toBeUndefined();
    expect(h.authority.waveIntegrations).toHaveLength(0);
  });
});
