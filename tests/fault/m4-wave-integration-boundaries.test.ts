import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { contentDigest } from "../../packages/core/src/identity/digest.js";
import { buildTaskLeaseRecord } from "../../packages/core/src/scheduling/records.js";
import type { FeedbackRecord } from "../../packages/core/src/schema/feedback.js";
import type { RunRecord } from "../../packages/core/src/schema/runtime.js";
import type {
  TaskLeaseRecord,
  WaveIntegrationRecord,
} from "../../packages/core/src/schema/scheduling.js";
import type { ApprovalRequestRecord } from "../../packages/runtime/src/approval/request.js";
import {
  buildGateEvidence,
  type GateEvidenceRecord,
} from "../../packages/runtime/src/gates/evidence.js";
import {
  normalizeGateDefinition,
  type GateDefinition,
} from "../../packages/runtime/src/gates/provider.js";
import { actionDigest } from "../../packages/runtime/src/policy/action.js";
import { buildDecision, type PolicyDecision } from "../../packages/runtime/src/policy/decision.js";
import { mergePolicyLayers } from "../../packages/runtime/src/policy/evaluator.js";
import {
  taskSemanticDigest,
  type Protocol13TaskSpecification,
} from "../../packages/runtime/src/planning/task.js";
import type { ParallelWave } from "../../packages/runtime/src/planning/waves.js";
import type { SchedulerEventSpec } from "../../packages/runtime/src/scheduling/events.js";
import {
  bindSchedulingEvidence,
  createCandidateIntegrationController,
  createGitWaveIntegrationGit,
  operationRefFor,
  waveIntegrationPolicyInput,
  type CandidateIntegrationController,
  type TaskCandidateValidation,
  type WaveCandidate,
  type WaveGatePort,
  type WaveIntegrationGitPort,
} from "../../packages/runtime/src/scheduling/integration.js";
import { terminateTaskLease } from "../../packages/runtime/src/scheduling/lease.js";
import { schedulerPolicyAction } from "../../packages/runtime/src/scheduling/policy-adapters.js";
import type { TaskDagSnapshot } from "../../packages/runtime/src/scheduling/ports.js";
import type {
  SchedulerAuthority,
  SchedulerLedgerFacts,
  SchedulerTransition,
} from "../../packages/runtime/src/scheduling/scheduler.js";
import type { TaskCandidatePatch } from "../../packages/runtime/src/scheduling/workspace-manager.js";
import {
  cleanupDirectories,
  headOf,
  makeRepo,
  makeTempDir,
} from "../../packages/runtime/test/bootstrap/helpers.js";

/**
 * Plan Task 10 step 8 (M4 design §13.4/§15.1): failure-boundary evidence for
 * wave integration.
 *
 * - A patch that does not apply consumes the single integration retry exactly
 *   once, then blocks; a digest mismatch is a hard integrity failure that
 *   never touches the retry budget.
 * - A clean apply that fails a candidate/wave gate is a semantic conflict: it
 *   blocks through Findings and never consumes the retry nor moves the ref.
 * - The acceptance CAS is command_id-idempotent: a lost CAS response is
 *   completed on replay without a second record, a drifted ref rejects as
 *   baseline_drift instead of reporting a false success, and a lost CAS race
 *   still leaves the committed record for reconciliation.
 */

const NOW = "2026-09-01T00:00:00.000Z";
const OPERATION_ID = "operation_m4_wave_fault";
const ITERATION_ID = "iteration_m4_wave_fault";
const PLAN_DIGEST = contentDigest("wave-fault-plan");
const POLICY = mergePolicyLayers([]).effective;
const ADAPTER_MANIFEST_DIGEST = contentDigest("adapter-manifest");
const CONTROL_PROFILE = {
  control: "managed",
  trajectory_visibility: "full",
  usage_metering: true,
  side_effect_interception: true,
} as const;

const hex40 = (letter: string): string => letter.repeat(40);

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

function dagFor(
  tasks: readonly Protocol13TaskSpecification[],
  waves: readonly ParallelWave[],
  baseline: string,
): TaskDagSnapshot {
  return {
    operation_id: OPERATION_ID,
    iteration_id: ITERATION_ID,
    plan_id: "plan_1",
    plan_digest: PLAN_DIGEST,
    baseline_commit: baseline,
    tasks,
    parallel_waves: waves,
    iteration_budget: { steps: 100, tokens: 100_000, duration_ms: 3_600_000 },
  };
}

let leaseCommandCounter = 0;

function leaseChainFor(
  taskSpec: Protocol13TaskSpecification,
  input: { token: number; baseline: string },
): TaskLeaseRecord[] {
  leaseCommandCounter += 1;
  const commandId = `command_fault_lease_${String(leaseCommandCounter)}`;
  const granted = buildTaskLeaseRecord({
    operation_id: OPERATION_ID,
    iteration_id: ITERATION_ID,
    plan_digest: PLAN_DIGEST,
    task_id: taskSpec.id,
    task_digest: taskSemanticDigest(taskSpec),
    run_id: `run_${taskSpec.id}_${String(input.token)}`,
    slot_id: "slot_1",
    baseline_commit: input.baseline,
    agent_adapter_digest: ADAPTER_MANIFEST_DIGEST,
    policy_digest: POLICY.digest,
    approval_digests: [],
    task_lease_record_id: `task-lease-record_fault_${String(leaseCommandCounter)}_granted`,
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
  const released = terminateTaskLease(granted, {
    state: "released",
    consumed_budget: { steps: 1, tokens: 10 },
    command_id: `${commandId}_close`,
  });
  return [granted, released];
}

const GATE = normalizeGateDefinition({
  gate_id: "gate_unit",
  layer: "project",
  name: "unit",
  mandatory: true,
  subject_id: "task_subject",
  tool: "run_unit",
});

function schedulingEvidence(spec: {
  readonly id: string;
  readonly task: Protocol13TaskSpecification;
  readonly lease: TaskLeaseRecord;
  readonly commit: string;
  readonly layer: "task" | "candidate" | "wave";
  readonly passed?: boolean;
}): GateEvidenceRecord {
  const passed = spec.passed ?? true;
  const record = buildGateEvidence({
    evidenceId: spec.id,
    createdAt: NOW,
    outcome: {
      gate_id: GATE.gate_id,
      layer: GATE.layer,
      mandatory: GATE.mandatory,
      passed,
      exit_code: passed ? 0 : 1,
      summary: "gate ran",
      log_summary: "ok",
      artifact_hashes: {},
      subject_id: spec.task.id,
      output_digest: contentDigest(`output:${spec.id}`),
    },
    bindings: {
      artifact_digests: [],
      code_digests: [spec.commit],
      gate_digest: GATE.digest,
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

class FaultAuthority implements SchedulerAuthority {
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
        case "append_gate_evidence":
          this.gateEvidence.push(...transition.records);
          break;
        case "record_wave_integration":
          this.waveIntegrations.push(transition.record);
          break;
        case "append_evidence":
          break;
        case "append_event":
          this.events.push(transition.event);
          break;
      }
    }
  }
}

/** Scriptable in-memory git with a CAS call counter for replay assertions. */
class FaultGit implements WaveIntegrationGitPort {
  readonly refs = new Map<string, string>();
  casResult = true;
  casCalls = 0;
  private counter = 0;

  async createCandidateWorktree(): Promise<string> {
    this.counter += 1;
    return `fault_worktree_${String(this.counter)}`;
  }

  async applyManagedPatch(): Promise<void> {}

  async commitCandidate(input: { task_id: string }): Promise<string> {
    return contentDigest({ fault_commit: input.task_id, n: this.counter }).slice(0, 40);
  }

  async discardWorktree(): Promise<void> {}

  async readRef(ref: string): Promise<string | undefined> {
    return this.refs.get(ref);
  }

  async compareAndSwapRef(input: {
    ref: string;
    expected: string | undefined;
    next: string;
  }): Promise<boolean> {
    this.casCalls += 1;
    if (!this.casResult) return false;
    if (this.refs.get(input.ref) !== input.expected) return false;
    this.refs.set(input.ref, input.next);
    return true;
  }

  async sourceTreeDigest(commit: string): Promise<string> {
    return contentDigest(`fault-tree:${commit}`);
  }

  async listCandidateWorktrees(): Promise<readonly string[]> {
    return [];
  }
}

class FaultGates implements WaveGatePort {
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
    return [
      schedulingEvidence({
        id: `evidence_candidate_${input.task.id}`,
        task: input.task,
        lease: input.lease,
        commit: input.candidate_commit,
        layer: "candidate",
        passed: !this.candidateFailureFor.has(input.task.id),
      }),
    ];
  }

  async runWaveGates(input: {
    candidate_commit: string;
    tasks: readonly Protocol13TaskSpecification[];
    leases: readonly TaskLeaseRecord[];
  }): Promise<readonly GateEvidenceRecord[]> {
    return [
      schedulingEvidence({
        id: "evidence_wave",
        task: input.tasks[0] as Protocol13TaskSpecification,
        lease: input.leases[0] as TaskLeaseRecord,
        commit: input.candidate_commit,
        layer: "wave",
        passed: !this.waveFails,
      }),
    ];
  }
}

const FAKE_BASE = hex40("b");

function patchFor(taskSpec: Protocol13TaskSpecification, baseline = FAKE_BASE): TaskCandidatePatch {
  const patch = `diff --git a/src/${taskSpec.id}.ts b/src/${taskSpec.id}.ts\n`;
  return {
    task_id: taskSpec.id,
    baseline_commit: baseline,
    changed_paths: [`src/${taskSpec.id}.ts`],
    patch_locator: `artifacts/${taskSpec.id}.patch`,
    patch_digest: contentDigest(patch),
    source_tree_digest: contentDigest(`tree:${taskSpec.id}`),
  };
}

interface FakeHarness {
  readonly authority: FaultAuthority;
  readonly git: FaultGit;
  readonly gates: FaultGates;
  readonly controller: CandidateIntegrationController;
}

function fakeHarness(): FakeHarness {
  const authority = new FaultAuthority();
  const git = new FaultGit();
  const gates = new FaultGates();
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

interface Prepared {
  readonly dag: TaskDagSnapshot;
  readonly wave: ParallelWave;
  readonly candidate: WaveCandidate;
  readonly validation: TaskCandidateValidation;
  readonly decision: PolicyDecision;
}

/** Full queue → rebuild → validate pipeline for a single-task wave. */
async function prepareValidated(
  h: FakeHarness,
  taskSpec: Protocol13TaskSpecification,
): Promise<Prepared> {
  const wave: ParallelWave = { wave_index: 0, task_ids: [taskSpec.id] };
  const dag = dagFor([taskSpec], [wave], FAKE_BASE);
  h.authority.leases.push(...leaseChainFor(taskSpec, { token: 1, baseline: FAKE_BASE }));
  const released = h.authority.leases[1] as TaskLeaseRecord;
  h.authority.gateEvidence.push(
    schedulingEvidence({
      id: `evidence_task_${taskSpec.id}`,
      task: taskSpec,
      lease: released,
      commit: FAKE_BASE,
      layer: "task",
    }),
  );
  await h.controller.queueTaskCandidate(patchFor(taskSpec));
  const candidate = await h.controller.rebuildWaveCandidate({
    dag,
    wave,
    expected_base_commit: FAKE_BASE,
  });
  const validation = await h.controller.validateTaskCandidate({
    candidate,
    task: taskSpec,
    lease: released,
    evidence: [
      {
        kind: "gate_result",
        locator: `ledger://evidence/evidence_task_${taskSpec.id}`,
        digest: (h.authority.gateEvidence[0] as GateEvidenceRecord).digest,
      },
    ],
  });
  expect(validation.status).toBe("candidate_validated");
  const decision = allowWaveDecision(dag, wave, h.authority);
  return { dag, wave, candidate, validation, decision };
}

function allowWaveDecision(
  dag: TaskDagSnapshot,
  wave: ParallelWave,
  authority: FaultAuthority,
): PolicyDecision {
  const input = waveIntegrationPolicyInput({
    dag,
    wave,
    base_commit: FAKE_BASE,
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

function findingRules(authority: FaultAuthority): readonly string[] {
  return authority.findings.map(
    (finding) =>
      (finding.extensions?.["harness.finding"] as { rule?: string } | undefined)?.rule ?? "",
  );
}

function retryEvents(authority: FaultAuthority): readonly SchedulerEventSpec[] {
  return authority.events.filter((event) => event.eventType === "TaskRetryScheduled");
}

describe("m4 wave integration failure boundaries", () => {
  it("consumes the single integration retry on a real apply failure, then blocks", async () => {
    const repositoryRoot = makeRepo({ "src/task_a.ts": "original\n" });
    const base = headOf(repositoryRoot);
    const managedRoot = join(makeTempDir("harness-m4-fault-"), "managed");
    const gitPort = createGitWaveIntegrationGit({
      repositoryRoot,
      managedRoot,
      commitIdentity: { name: "Harness", email: "harness@example.invalid" },
    });
    const authority = new FaultAuthority();
    const controller = createCandidateIntegrationController({
      authority,
      git: gitPort,
      gates: new FaultGates(),
      effective_policy_digest: POLICY.digest,
      adapter_manifest_digest: ADAPTER_MANIFEST_DIGEST,
      adapter_control_profile: CONTROL_PROFILE,
      now: () => NOW,
    });
    const taskA = task("task_a");
    const wave: ParallelWave = { wave_index: 0, task_ids: ["task_a"] };
    const dag = dagFor([taskA], [wave], base);
    // Context lines name content the tree does not contain: `git apply
    // --index` fails against the real candidate worktree.
    const badPatch = [
      "diff --git a/src/task_a.ts b/src/task_a.ts",
      "--- a/src/task_a.ts",
      "+++ b/src/task_a.ts",
      "@@ -1 +1 @@",
      "-this content does not exist in the tree",
      "+replacement",
      "",
    ].join("\n");
    const locator = join(makeTempDir("harness-m4-fault-patch-"), "task_a.patch");
    writeFileSync(locator, badPatch, "utf8");
    await controller.queueTaskCandidate({
      task_id: "task_a",
      baseline_commit: base,
      changed_paths: ["src/task_a.ts"],
      patch_locator: locator,
      patch_digest: contentDigest(badPatch),
      source_tree_digest: contentDigest("tree"),
    });

    const ref = operationRefFor(OPERATION_ID);
    await expect(
      controller.rebuildWaveCandidate({ dag, wave, expected_base_commit: base }),
    ).rejects.toMatchObject({ kind: "integration_conflict" });
    // First failure: the single integration retry is scheduled through a
    // non-blocking Finding; the ref never moved and the worktree is gone.
    expect(retryEvents(authority)).toHaveLength(1);
    expect(retryEvents(authority)[0]).toMatchObject({
      payload: { retry_kind: "integration_retry" },
    });
    expect(findingRules(authority)).toEqual(["integration_retry_scheduled"]);
    expect(authority.findings[0]).toMatchObject({
      extensions: { "harness.finding": { blocking: false } },
    });
    expect(await gitPort.readRef(ref)).toBeUndefined();
    expect(await gitPort.listCandidateWorktrees()).toEqual([]);

    // Second failure of the same class: blocked, no second retry.
    await expect(
      controller.rebuildWaveCandidate({ dag, wave, expected_base_commit: base }),
    ).rejects.toMatchObject({ kind: "integration_conflict" });
    expect(retryEvents(authority)).toHaveLength(1);
    expect(findingRules(authority)).toEqual([
      "integration_retry_scheduled",
      "integration_conflict",
    ]);
    expect(authority.findings[1]).toMatchObject({
      extensions: { "harness.finding": { blocking: true } },
    });
    expect(await gitPort.readRef(ref)).toBeUndefined();
  });

  it("treats a patch digest mismatch as an integrity failure that never schedules a retry", async () => {
    const repositoryRoot = makeRepo({ "src/task_a.ts": "original\n" });
    const base = headOf(repositoryRoot);
    const gitPort = createGitWaveIntegrationGit({
      repositoryRoot,
      managedRoot: join(makeTempDir("harness-m4-fault-"), "managed"),
      commitIdentity: { name: "Harness", email: "harness@example.invalid" },
    });
    const authority = new FaultAuthority();
    const controller = createCandidateIntegrationController({
      authority,
      git: gitPort,
      gates: new FaultGates(),
      effective_policy_digest: POLICY.digest,
      adapter_manifest_digest: ADAPTER_MANIFEST_DIGEST,
      adapter_control_profile: CONTROL_PROFILE,
      now: () => NOW,
    });
    const taskA = task("task_a");
    const wave: ParallelWave = { wave_index: 0, task_ids: ["task_a"] };
    const dag = dagFor([taskA], [wave], base);
    const locator = join(makeTempDir("harness-m4-fault-patch-"), "task_a.patch");
    writeFileSync(locator, "diff --git a/src/task_a.ts b/src/task_a.ts\n", "utf8");
    await controller.queueTaskCandidate({
      task_id: "task_a",
      baseline_commit: base,
      changed_paths: ["src/task_a.ts"],
      patch_locator: locator,
      // The committed digest does not match the artifact bytes.
      patch_digest: contentDigest("some other content"),
      source_tree_digest: contentDigest("tree"),
    });

    await expect(
      controller.rebuildWaveCandidate({ dag, wave, expected_base_commit: base }),
    ).rejects.toMatchObject({ kind: "patch_digest_mismatch" });
    expect(retryEvents(authority)).toEqual([]);
    expect(findingRules(authority)).toEqual([]);
  });

  it("blocks on a candidate gate failure without consuming the integration retry", async () => {
    const h = fakeHarness();
    const taskA = task("task_a");
    const wave: ParallelWave = { wave_index: 0, task_ids: ["task_a"] };
    const dag = dagFor([taskA], [wave], FAKE_BASE);
    h.authority.leases.push(...leaseChainFor(taskA, { token: 1, baseline: FAKE_BASE }));
    const released = h.authority.leases[1] as TaskLeaseRecord;
    const taskEvidence = schedulingEvidence({
      id: "evidence_task_task_a",
      task: taskA,
      lease: released,
      commit: FAKE_BASE,
      layer: "task",
    });
    h.authority.gateEvidence.push(taskEvidence);
    await h.controller.queueTaskCandidate(patchFor(taskA));
    const candidate = await h.controller.rebuildWaveCandidate({
      dag,
      wave,
      expected_base_commit: FAKE_BASE,
    });
    h.gates.candidateFailureFor.add("task_a");

    const validation = await h.controller.validateTaskCandidate({
      candidate,
      task: taskA,
      lease: released,
      evidence: [
        {
          kind: "gate_result",
          locator: "ledger://evidence/evidence_task_task_a",
          digest: taskEvidence.digest,
        },
      ],
    });

    // Semantic conflict: blocked through a Finding; the retry budget is
    // untouched and the ref never moved.
    expect(validation.status).toBe("blocked");
    expect(findingRules(h.authority)).toEqual(["candidate_gate_failed"]);
    expect(retryEvents(h.authority)).toEqual([]);
    expect(h.git.refs.size).toBe(0);
  });

  it("keeps the ref unchanged and never retries when a mandatory wave gate fails", async () => {
    const h = fakeHarness();
    const prepared = await prepareValidated(h, task("task_a"));
    h.gates.waveFails = true;

    await expect(
      h.controller.acceptWave({
        dag: prepared.dag,
        candidate: prepared.candidate,
        validations: [prepared.validation],
        policy_decision: prepared.decision,
        approval_digests: [],
        command_id: "command_fault_wave_gate",
      }),
    ).rejects.toMatchObject({ kind: "wave_gate_failed" });

    expect(findingRules(h.authority)).toEqual(["wave_gate_failed"]);
    expect(h.authority.waveIntegrations).toEqual([]);
    expect(h.git.refs.size).toBe(0);
    expect(retryEvents(h.authority)).toEqual([]);
    expect(h.git.casCalls).toBe(0);
  });

  it("commits the wave record before the CAS and reports a lost CAS race for reconciliation", async () => {
    const h = fakeHarness();
    const prepared = await prepareValidated(h, task("task_a"));
    h.git.casResult = false;

    await expect(
      h.controller.acceptWave({
        dag: prepared.dag,
        candidate: prepared.candidate,
        validations: [prepared.validation],
        policy_decision: prepared.decision,
        approval_digests: [],
        command_id: "command_fault_cas_loss",
      }),
    ).rejects.toMatchObject({ kind: "ref_cas_failed" });

    // The authoritative record exists; the failure is a baseline_drift
    // Finding for reconciliation, never a silent ref force.
    expect(h.authority.waveIntegrations).toHaveLength(1);
    expect(findingRules(h.authority)).toEqual(["baseline_drift"]);
    expect(h.git.refs.size).toBe(0);
  });

  it("replays a command_id without advancing twice and completes a lost ref move", async () => {
    const h = fakeHarness();
    const prepared = await prepareValidated(h, task("task_a"));
    const ref = operationRefFor(OPERATION_ID);
    const input = {
      dag: prepared.dag,
      candidate: prepared.candidate,
      validations: [prepared.validation],
      policy_decision: prepared.decision,
      approval_digests: [] as readonly string[],
      command_id: "command_fault_replay",
    };

    const accepted = await h.controller.acceptWave(input);
    expect(h.git.refs.get(ref)).toBe(prepared.candidate.candidate_commit);
    const batchesAfterAccept = h.authority.batches.length;
    const casAfterAccept = h.git.casCalls;

    // Replay after full success: the ref already holds the candidate, so the
    // existing record is returned with no new commit and no second CAS.
    const replayed = await h.controller.acceptWave(input);
    expect(replayed.record_digest).toBe(accepted.record_digest);
    expect(h.authority.batches).toHaveLength(batchesAfterAccept);
    expect(h.git.casCalls).toBe(casAfterAccept);
    expect(h.authority.waveIntegrations).toHaveLength(1);

    // Lost CAS response: the Ledger recorded acceptance but the ref still
    // holds the base. The replay completes exactly the recorded move — not a
    // false success, not a second record.
    h.git.refs.set(ref, prepared.candidate.base_commit);
    const completed = await h.controller.acceptWave(input);
    expect(completed.record_digest).toBe(accepted.record_digest);
    expect(h.git.refs.get(ref)).toBe(prepared.candidate.candidate_commit);
    expect(h.git.casCalls).toBe(casAfterAccept + 1);
    expect(h.authority.waveIntegrations).toHaveLength(1);
    expect(findingRules(h.authority)).toEqual([]);

    // The ref drifted to a third value: the replay rejects instead of
    // reporting a false success.
    h.git.refs.set(ref, hex40("e"));
    await expect(h.controller.acceptWave(input)).rejects.toMatchObject({
      kind: "baseline_drift",
    });
    expect(h.git.refs.get(ref)).toBe(hex40("e"));
    expect(h.authority.waveIntegrations).toHaveLength(1);
  });

  it("ref drift before acceptance is baseline_drift and never consumes the retry", async () => {
    const h = fakeHarness();
    const prepared = await prepareValidated(h, task("task_a"));
    // A concurrent writer moved the operation ref off the wave base.
    h.git.refs.set(operationRefFor(OPERATION_ID), hex40("f"));

    await expect(
      h.controller.acceptWave({
        dag: prepared.dag,
        candidate: prepared.candidate,
        validations: [prepared.validation],
        policy_decision: prepared.decision,
        approval_digests: [],
        command_id: "command_fault_drift",
      }),
    ).rejects.toMatchObject({ kind: "baseline_drift" });

    expect(findingRules(h.authority)).toEqual(["baseline_drift"]);
    expect(h.authority.waveIntegrations).toEqual([]);
    expect(retryEvents(h.authority)).toEqual([]);
    expect(h.git.casCalls).toBe(0);
    // No force: the drifted ref is untouched.
    expect(h.git.refs.get(operationRefFor(OPERATION_ID))).toBe(hex40("f"));
  });
});
