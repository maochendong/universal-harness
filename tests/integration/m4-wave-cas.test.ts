import { join } from "node:path";
import { writeFileSync } from "node:fs";

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
  sourceTreeDigest,
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
import {
  cleanupDirectories,
  git,
  headOf,
  makeRepo,
  makeTempDir,
  writeTree,
} from "../../packages/runtime/test/bootstrap/helpers.js";

/**
 * Plan Task 10 step 9 (M4 design §13.4/§14): wave acceptance against a real
 * repository. The candidate is rebuilt with `git apply --index` onto a
 * detached worktree, committed under the fixed Harness identity and accepted
 * through a real `update-ref` compare-and-swap: the operation-local ref moves
 * base → candidate exactly once, the recorded source-tree digest matches the
 * real tree with the `.harness` Ledger excluded, a command_id replay never
 * advances twice, and a drifted ref rejects as baseline_drift with no force.
 */

const NOW = "2026-09-01T00:00:00.000Z";
const OPERATION_ID = "operation_m4_wave_cas";
const ITERATION_ID = "iteration_m4_wave_cas";
const PLAN_DIGEST = contentDigest("wave-cas-plan");
const POLICY = mergePolicyLayers([]).effective;
const ADAPTER_MANIFEST_DIGEST = contentDigest("adapter-manifest");
const CONTROL_PROFILE = {
  control: "managed",
  trajectory_visibility: "full",
  usage_metering: true,
  side_effect_interception: true,
} as const;
const COMMIT_IDENTITY = { name: "Harness", email: "harness@example.invalid" };

afterEach(cleanupDirectories);

const GATE = normalizeGateDefinition({
  gate_id: "gate_unit",
  layer: "project",
  name: "unit",
  mandatory: true,
  subject_id: "task_subject",
  tool: "run_unit",
});

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

function schedulingEvidence(spec: {
  readonly id: string;
  readonly task: Protocol13TaskSpecification;
  readonly lease: TaskLeaseRecord;
  readonly commit: string;
  readonly layer: "task" | "candidate" | "wave";
}): GateEvidenceRecord {
  const record = buildGateEvidence({
    evidenceId: spec.id,
    createdAt: NOW,
    outcome: {
      gate_id: GATE.gate_id,
      layer: GATE.layer,
      mandatory: GATE.mandatory,
      passed: true,
      exit_code: 0,
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

class CasAuthority implements SchedulerAuthority {
  readonly leases: TaskLeaseRecord[] = [];
  readonly runs: RunRecord[] = [];
  readonly gateEvidence: GateEvidenceRecord[] = [];
  readonly approvals: ApprovalRequestRecord[] = [];
  readonly findings: FeedbackRecord[] = [];
  readonly waveIntegrations: WaveIntegrationRecord[] = [];
  readonly events: SchedulerEventSpec[] = [];

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

class CasGates implements WaveGatePort {
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
      }),
    ];
  }
}

interface RepoHarness {
  readonly repositoryRoot: string;
  readonly base: string;
  readonly ref: string;
  readonly authority: CasAuthority;
  readonly git: WaveIntegrationGitPort;
  readonly controller: CandidateIntegrationController;
  readonly taskSpec: Protocol13TaskSpecification;
  readonly dag: TaskDagSnapshot;
  readonly wave: ParallelWave;
}

/**
 * A real repository with one committed file plus a real `git diff` patch
 * artifact for the task's change (produced in the repo, then reverted).
 */
function repoHarness(): RepoHarness & {
  readonly patchLocator: string;
  readonly patchText: string;
} {
  const repositoryRoot = makeRepo({ "src/task_a.ts": "original\n" });
  const base = headOf(repositoryRoot);
  writeTree(repositoryRoot, { "src/task_a.ts": "original\nimplemented\n" });
  const patchText = git(repositoryRoot, "diff");
  git(repositoryRoot, "checkout", "--", "src/task_a.ts");
  const patchLocator = join(makeTempDir("harness-m4-cas-patch-"), "task_a.patch");
  writeFileSync(patchLocator, patchText, "utf8");
  const authority = new CasAuthority();
  const managedRoot = join(makeTempDir("harness-m4-cas-"), "managed");
  const gitPort = createGitWaveIntegrationGit({
    repositoryRoot,
    managedRoot,
    commitIdentity: COMMIT_IDENTITY,
  });
  const taskSpec = task("task_a");
  const wave: ParallelWave = { wave_index: 0, task_ids: ["task_a"] };
  const dag: TaskDagSnapshot = {
    operation_id: OPERATION_ID,
    iteration_id: ITERATION_ID,
    plan_id: "plan_1",
    plan_digest: PLAN_DIGEST,
    baseline_commit: base,
    tasks: [taskSpec],
    parallel_waves: [wave],
    iteration_budget: { steps: 100, tokens: 100_000, duration_ms: 3_600_000 },
  };
  const controller = createCandidateIntegrationController({
    authority,
    git: gitPort,
    gates: new CasGates(),
    effective_policy_digest: POLICY.digest,
    adapter_manifest_digest: ADAPTER_MANIFEST_DIGEST,
    adapter_control_profile: CONTROL_PROFILE,
    now: () => NOW,
  });
  return {
    repositoryRoot,
    base,
    ref: operationRefFor(OPERATION_ID),
    authority,
    git: gitPort,
    controller,
    taskSpec,
    dag,
    wave,
    patchLocator,
    patchText,
  };
}

/** Queue → rebuild → validate the single-task wave against the real repo. */
async function prepareValidated(
  h: RepoHarness & { readonly patchLocator: string; readonly patchText: string },
): Promise<{
  readonly candidate: WaveCandidate;
  readonly validation: TaskCandidateValidation;
  readonly decision: PolicyDecision;
  readonly lease: TaskLeaseRecord;
}> {
  const granted = buildTaskLeaseRecord({
    operation_id: OPERATION_ID,
    iteration_id: ITERATION_ID,
    plan_digest: PLAN_DIGEST,
    task_id: h.taskSpec.id,
    task_digest: taskSemanticDigest(h.taskSpec),
    run_id: "run_task_a_1",
    slot_id: "slot_1",
    baseline_commit: h.base,
    agent_adapter_digest: ADAPTER_MANIFEST_DIGEST,
    policy_digest: POLICY.digest,
    approval_digests: [],
    task_lease_record_id: "task-lease-record_cas_1_granted",
    lease_id: "lease_task_a_1",
    fencing_token: 1,
    state: "granted",
    attempt_number: 1,
    reserved_budget: { steps: 10, tokens: 1000 },
    consumed_budget: { steps: 0, tokens: 0 },
    issued_at: NOW,
    expires_at: "2026-09-01T01:00:00.000Z",
    command_id: "command_cas_lease_1",
  });
  const lease = terminateTaskLease(granted, {
    state: "released",
    consumed_budget: { steps: 1, tokens: 10 },
    command_id: "command_cas_lease_1_close",
  });
  h.authority.leases.push(granted, lease);
  const taskEvidence = schedulingEvidence({
    id: "evidence_task_task_a",
    task: h.taskSpec,
    lease,
    commit: h.base,
    layer: "task",
  });
  h.authority.gateEvidence.push(taskEvidence);

  await h.controller.queueTaskCandidate({
    task_id: h.taskSpec.id,
    baseline_commit: h.base,
    changed_paths: ["src/task_a.ts"],
    patch_locator: h.patchLocator,
    patch_digest: contentDigest(h.patchText),
    source_tree_digest: contentDigest("tree"),
  });
  const candidate = await h.controller.rebuildWaveCandidate({
    dag: h.dag,
    wave: h.wave,
    expected_base_commit: h.base,
  });
  const validation = await h.controller.validateTaskCandidate({
    candidate,
    task: h.taskSpec,
    lease,
    evidence: [
      {
        kind: "gate_result",
        locator: "ledger://evidence/evidence_task_task_a",
        digest: taskEvidence.digest,
      },
    ],
  });
  expect(validation.status).toBe("candidate_validated");
  const policyInput = waveIntegrationPolicyInput({
    dag: h.dag,
    wave: h.wave,
    base_commit: h.base,
    leases: h.authority.leases,
    adapter_manifest_digest: ADAPTER_MANIFEST_DIGEST,
    adapter_control_profile: CONTROL_PROFILE,
    effective_policy_digest: POLICY.digest,
    now: NOW,
  });
  const decision = buildDecision({
    outcome: "allow",
    reasons: ["allowed"],
    action_digest: actionDigest(schedulerPolicyAction(policyInput)),
    effective: POLICY,
  });
  return { candidate, validation, decision, lease };
}

describe("m4 wave acceptance CAS against a real repository", () => {
  it("moves the operation ref base → candidate and records the real source tree digest", async () => {
    const h = repoHarness();
    const prepared = await prepareValidated(h);

    expect(await h.git.readRef(h.ref)).toBeUndefined();
    const accepted = await h.controller.acceptWave({
      dag: h.dag,
      candidate: prepared.candidate,
      validations: [prepared.validation],
      policy_decision: prepared.decision,
      approval_digests: [],
      command_id: "command_wave_cas_accept",
    });

    // The real update-ref CAS moved the operation-local ref exactly to the
    // candidate commit, and the candidate worktree is discarded.
    expect(accepted.base_commit).toBe(h.base);
    expect(accepted.candidate_commit).toBe(prepared.candidate.candidate_commit);
    expect(await h.git.readRef(h.ref)).toBe(prepared.candidate.candidate_commit);
    expect(git(h.repositoryRoot, "rev-parse", h.ref).trim()).toBe(
      prepared.candidate.candidate_commit,
    );
    expect(await h.git.listCandidateWorktrees()).toEqual([]);
    // The recorded digest matches the real source tree of the candidate,
    // excluding the .harness Ledger content.
    expect(accepted.accepted_source_tree_digest).toBe(
      await sourceTreeDigest(h.repositoryRoot, prepared.candidate.candidate_commit, {
        excludeHarnessLedger: true,
      }),
    );
    expect(h.authority.waveIntegrations).toHaveLength(1);
    expect(h.authority.events.map((event) => event.eventType)).toContain("WaveIntegrated");
  });

  it("replays the same command_id without a second record and completes a lost ref move", async () => {
    const h = repoHarness();
    const prepared = await prepareValidated(h);
    const input = {
      dag: h.dag,
      candidate: prepared.candidate,
      validations: [prepared.validation],
      policy_decision: prepared.decision,
      approval_digests: [] as readonly string[],
      command_id: "command_wave_cas_replay",
    };
    const accepted = await h.controller.acceptWave(input);
    expect(await h.git.readRef(h.ref)).toBe(prepared.candidate.candidate_commit);

    const replayed = await h.controller.acceptWave(input);
    expect(replayed.record_digest).toBe(accepted.record_digest);
    expect(h.authority.waveIntegrations).toHaveLength(1);

    // Lost CAS response: the Ledger holds the record, the ref still holds the
    // base; the replay completes exactly the recorded move.
    git(h.repositoryRoot, "update-ref", h.ref, h.base);
    const completed = await h.controller.acceptWave(input);
    expect(completed.record_digest).toBe(accepted.record_digest);
    expect(await h.git.readRef(h.ref)).toBe(prepared.candidate.candidate_commit);
    expect(h.authority.waveIntegrations).toHaveLength(1);
  });

  it("rejects acceptance when the operation ref drifted, without force or retry", async () => {
    const h = repoHarness();
    const prepared = await prepareValidated(h);
    // A concurrent writer moved the operation ref to an unrelated commit.
    writeTree(h.repositoryRoot, { "src/other.ts": "other\n" });
    git(h.repositoryRoot, "add", "-A");
    git(h.repositoryRoot, "commit", "-m", "unrelated");
    const drifted = headOf(h.repositoryRoot);
    git(h.repositoryRoot, "update-ref", h.ref, drifted);

    await expect(
      h.controller.acceptWave({
        dag: h.dag,
        candidate: prepared.candidate,
        validations: [prepared.validation],
        policy_decision: prepared.decision,
        approval_digests: [],
        command_id: "command_wave_cas_drift",
      }),
    ).rejects.toMatchObject({ kind: "baseline_drift" });

    // No force, no record, no retry consumption.
    expect(await h.git.readRef(h.ref)).toBe(drifted);
    expect(h.authority.waveIntegrations).toEqual([]);
    expect(h.authority.events.filter((event) => event.eventType === "TaskRetryScheduled")).toEqual(
      [],
    );
    expect(
      h.authority.findings.map(
        (finding) =>
          (finding.extensions?.["harness.finding"] as { rule?: string } | undefined)?.rule,
      ),
    ).toEqual(["baseline_drift"]);
  });
});
