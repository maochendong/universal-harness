import { describe, expect, it } from "vitest";

import {
  canonicalizeJson,
  contentDigest,
  type FeedbackRecord,
  type RunRecord,
  type TaskLeaseRecord,
  type WaveIntegrationRecord,
} from "@universal-harness-internal/core";
import type { AgentRunResult, AgentTaskEnvelope } from "@universal-harness-internal/plugin-sdk";

import type { ApprovalRequestRecord } from "../../src/approval/request.js";
import type { GateEvidenceRecord } from "../../src/gates/evidence.js";
import { actionDigest } from "../../src/policy/action.js";
import { issueGrant } from "../../src/policy/capability-grant.js";
import { buildDecision, type EffectivePolicy } from "../../src/policy/decision.js";
import type { Protocol13TaskSpecification } from "../../src/planning/task.js";
import { compileParallelWaves } from "../../src/planning/waves.js";
import { AgentPoolError, type AgentPoolRunInput } from "../../src/scheduling/agent-pool.js";
import type { DriverLockHandle } from "../../src/scheduling/driver-lock.js";
import type { SchedulerEventSpec } from "../../src/scheduling/events.js";
import { createInMemoryPolicyDecisionPort } from "../../src/scheduling/policy-adapters.js";
import type { AgentPoolSlot } from "../../src/scheduling/ports.js";
import {
  createLocalTaskScheduler,
  type SchedulerAuthority,
  type SchedulerTransition,
} from "../../src/scheduling/scheduler.js";
import type {
  TaskExecutionWorkspace,
  TaskWorkspaceManager,
} from "../../src/scheduling/workspace-manager.js";
import { mulberry32, randomInt } from "../context/seeds.js";
import { BASELINE_COMMIT, ITERATION_ID, OPERATION_ID, PLAN_DIGEST } from "./scheduler-facts.js";

/**
 * Plan Task 9 step 6: deterministic replay across process restart points. A
 * seeded scenario drives a random Plan; then the "process" is killed at a
 * restart point (an in-flight run that never settles) and TWO independent
 * fresh schedulers recover from the identical authoritative snapshot. Both
 * continuations must produce byte-identical transition batches — the same
 * next transition digest — and identical final authoritative state. Two
 * uninterrupted runs of the same scenario pin the same property without a
 * restart.
 */

const NOW = "2026-08-31T00:00:00.000Z";
const EFFECTIVE: EffectivePolicy = { fields: [], layers: [], digest: "e".repeat(64) };
const ADAPTER_MANIFEST_DIGEST = "d".repeat(64);
const MANAGED_CONTROL = {
  control: "managed",
  trajectory_visibility: "full",
  usage_metering: true,
  side_effect_interception: true,
} as const;

function seededTasks(seed: number, count: number): readonly Protocol13TaskSpecification[] {
  const random = mulberry32(seed);
  const tasks: Protocol13TaskSpecification[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `task_${String(index)}`;
    // Dependencies only ever point backwards, keeping the DAG acyclic.
    const dependencies: string[] = [];
    const dependencyCount = index === 0 ? 0 : randomInt(random, Math.min(3, index + 1));
    for (let d = 0; d < dependencyCount; d += 1) {
      const target = `task_${String(randomInt(random, index))}`;
      if (!dependencies.includes(target)) dependencies.push(target);
    }
    tasks.push({
      id,
      objective: `Implement ${id}`,
      impact_paths: [[`impact-${id}`]],
      expected_outputs: [`${id}-output`],
      capabilities: ["code-edit"],
      tools: [],
      dependencies,
      risk: "low",
      budget: { steps: 10, tokens: 1000, duration_ms: 60_000 },
      write_paths: [`src/${id}`],
      exclusive_resources: [],
      acceptance: [{ description: "works", verification: "unit test" }],
      required_gates: [],
    });
  }
  return tasks;
}

function stubResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    outcome: "handoff",
    termination_reason: "completion",
    completion_claimed: true,
    summary: "done",
    state_proposal: null,
    dropped_proposal_fields: [],
    change_summary: { files_changed: 0, insertions: 0, deletions: 0, paths: [] },
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

class ReplayAuthority implements SchedulerAuthority {
  readonly leases: TaskLeaseRecord[] = [];
  readonly runs: RunRecord[] = [];
  readonly approvals: ApprovalRequestRecord[] = [];
  readonly findings: FeedbackRecord[] = [];
  readonly wave_integrations: WaveIntegrationRecord[] = [];
  readonly gate_evidence: GateEvidenceRecord[] = [];
  readonly events: SchedulerEventSpec[] = [];
  readonly batches: SchedulerTransition[][] = [];

  static cloneOf(other: ReplayAuthority): ReplayAuthority {
    const clone = new ReplayAuthority();
    clone.leases.push(...other.leases);
    clone.runs.push(...other.runs);
    clone.approvals.push(...other.approvals);
    clone.findings.push(...other.findings);
    clone.wave_integrations.push(...other.wave_integrations);
    clone.gate_evidence.push(...other.gate_evidence);
    clone.events.push(...other.events);
    clone.batches.push(...other.batches.map((batch) => [...batch]));
    return clone;
  }

  async readFacts(operationId: string) {
    if (operationId !== OPERATION_ID) throw new Error(`unknown operation ${operationId}`);
    return {
      leases: [...this.leases],
      runs: [...this.runs],
      gate_evidence: [...this.gate_evidence],
      approvals: [...this.approvals],
      findings: [...this.findings],
      wave_integrations: [...this.wave_integrations],
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
        case "append_event":
          this.events.push(transition.event);
          break;
        case "append_evidence":
          break;
      }
    }
  }

  batchDigests(): readonly string[] {
    return this.batches.map((batch) => contentDigest(canonicalizeJson(batch)));
  }

  factsDigest(): string {
    return contentDigest(
      canonicalizeJson({
        leases: this.leases,
        runs: this.runs,
        approvals: this.approvals,
        findings: this.findings,
        wave_integrations: this.wave_integrations,
      }),
    );
  }
}

type PoolScript =
  { readonly kind: "complete" } | { readonly kind: "crash" } | { readonly kind: "hang" };

class ReplayPool {
  private readonly slots: AgentPoolSlot[];
  private readonly callsPerTask = new Map<string, number>();

  constructor(
    readonly capacity: number,
    private readonly script: (taskId: string, callIndex: number) => PoolScript,
  ) {
    this.slots = Array.from({ length: capacity }, (_, index) => ({
      slot_id: `slot_${String(index + 1)}`,
      state: "idle" as const,
    }));
  }

  snapshot(): readonly AgentPoolSlot[] {
    return this.slots.map((slot) => ({ ...slot }));
  }

  async run(input: AgentPoolRunInput) {
    const slot = this.slots.find((candidate) => candidate.state === "idle");
    if (slot === undefined) {
      throw new AgentPoolError("pool_exhausted", `no idle slot for ${input.task_id}`);
    }
    slot.state = "running";
    slot.task_id = input.task_id;
    slot.run_id = input.run_id;
    const callIndex = this.callsPerTask.get(input.task_id) ?? 0;
    this.callsPerTask.set(input.task_id, callIndex + 1);
    const script = this.script(input.task_id, callIndex);
    const finish = (result: AgentRunResult) => {
      slot.state = "idle";
      delete slot.task_id;
      delete slot.run_id;
      return { slot_id: slot.slot_id, task_id: input.task_id, run_id: input.run_id, result };
    };
    if (script.kind === "hang") {
      return new Promise<never>(() => {});
    }
    if (script.kind === "crash") {
      return finish(stubResult({ outcome: "failed", termination_reason: "adapter_failure" }));
    }
    return finish(stubResult());
  }

  async cancel(runId: string): Promise<void> {
    throw new AgentPoolError("unknown_run", `no active run ${runId}`);
  }
}

function replayWorkspaces(): TaskWorkspaceManager {
  return {
    async prepareTaskWorkspace(input): Promise<TaskExecutionWorkspace> {
      return {
        workspace_id: `workspace_${input.task.id}_${input.slot_id}`,
        root: `/virtual/worktrees/${input.task.id}`,
        handle: { workspace_id: `workspace_${input.task.id}_${input.slot_id}` } as never,
      };
    },
    async collectTaskCandidate(input) {
      return {
        task_id: input.task.id,
        baseline_commit: BASELINE_COMMIT,
        changed_paths: input.task.write_paths,
        patch_locator: `/virtual/artifacts/${input.task.id}.patch`,
        patch_digest: contentDigest({ patch: input.task.id }),
        source_tree_digest: contentDigest({ tree: input.task.id }),
      };
    },
    async collectStrictTddCandidate() {
      throw new Error("not used in replay tests");
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

function scenario(seed: number) {
  const tasks = seededTasks(seed, 8);
  const waves = compileParallelWaves(tasks);
  const dag = {
    operation_id: OPERATION_ID,
    iteration_id: ITERATION_ID,
    plan_id: "plan_1",
    plan_digest: PLAN_DIGEST,
    baseline_commit: BASELINE_COMMIT,
    tasks,
    parallel_waves: waves,
    iteration_budget: { steps: 10_000, tokens: 10_000_000, duration_ms: 3_600_000 },
  };
  const random = mulberry32(seed ^ 0x9e3779b9);
  // Seeded crash plan: roughly a quarter of the tasks crash their first
  // executor attempt, exercising retry scheduling under replay.
  const crashOnce = new Set(tasks.filter(() => randomInt(random, 4) === 0).map((task) => task.id));
  return { dag, crashOnce };
}

function freshScheduler(options: {
  readonly dag: ReturnType<typeof scenario>["dag"];
  readonly authority: ReplayAuthority;
  readonly script: (taskId: string, callIndex: number) => PoolScript;
  readonly pool?: ReplayPool;
}) {
  return createLocalTaskScheduler({
    dag_port: {
      name: "stub-dag",
      async readApproved() {
        return options.dag;
      },
    },
    policy: createInMemoryPolicyDecisionPort({
      resolve: (action) =>
        buildDecision({
          outcome: "allow",
          reasons: [],
          action_digest: actionDigest(action),
          effective: EFFECTIVE,
        }),
    }),
    authority: options.authority,
    pool: options.pool ?? new ReplayPool(4, options.script),
    workspaces: replayWorkspaces(),
    adapter_manifest_digest: ADAPTER_MANIFEST_DIGEST,
    adapter_control_profile: MANAGED_CONTROL,
    adapter_capabilities: ["code-edit"],
    unattended_eligible: true,
    ceilings: {
      profile_limit: 2,
      installation_limit: 8,
      project_limit: 8,
      local_resource_limit: 8,
    },
    effective_policy_digest: EFFECTIVE.digest,
    callbacks: {
      assembleContext: async ({ task, run_id }) => ({
        context_bundle_id: `context-bundle_${contentDigest({ bundle: task.id, run_id }).slice(0, 12)}`,
        context_bundle_digest: contentDigest({ bundle: task.id, run_id }),
      }),
      issueTaskGrant: ({ task, lease, reservation }) =>
        issueGrant(
          {
            grant_id: `grant_${task.id}_${String(lease.attempt_number)}`,
            task_id: task.id,
            capabilities: [...task.capabilities],
            read_paths: [...task.write_paths],
            write_paths: [...task.write_paths],
            phase: "execute",
            budget: reservation,
          },
          EFFECTIVE,
        ),
      buildEnvelope: ({ task }): AgentTaskEnvelope => ({
        task_id: task.id,
        plan_id: "plan_1",
        iteration_id: ITERATION_ID,
        repository_id: "repo_1",
        objective: task.objective,
        expected_output: task.expected_outputs.join(","),
        acceptance_criteria: [],
        required_gate_ids: [],
        allowed_read_paths: [...task.write_paths],
        proposed_write_paths: [...task.write_paths],
        state_proposal_fields: [],
        baseline_commit: BASELINE_COMMIT,
        input_digest: contentDigest({ input: task.id }),
        digest: contentDigest({ envelope: task.id }),
        loop_policy: {
          max_steps: task.budget.steps,
          max_tokens: task.budget.tokens,
          max_duration_ms: task.budget.duration_ms,
        },
      }),
      evidenceDir: ({ run_id }) => `/virtual/evidence/${run_id}`,
    },
    now: () => NOW,
  });
}

function driveInput() {
  return {
    operation_id: OPERATION_ID,
    expected_plan_digest: PLAN_DIGEST,
    requested_max_concurrency: 2,
    driver_lock: driverLock,
  };
}

async function waitFor(condition: () => boolean, attempts = 200): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (condition()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error("condition never became true");
}

describe("deterministic replay", () => {
  it.each([11, 23, 42])(
    "replays scenario seed %i byte-identically in two independent processes",
    async (seed) => {
      const { dag, crashOnce } = scenario(seed);
      const script =
        (crashed: Set<string>) =>
        (taskId: string, callIndex: number): PoolScript => {
          if (crashed.has(taskId) && callIndex === 0) return { kind: "crash" };
          return { kind: "complete" };
        };
      const authorityA = new ReplayAuthority();
      const schedulerA = freshScheduler({ dag, authority: authorityA, script: script(crashOnce) });
      const resultA = await schedulerA.drive(driveInput());

      const authorityB = new ReplayAuthority();
      const schedulerB = freshScheduler({ dag, authority: authorityB, script: script(crashOnce) });
      const resultB = await schedulerB.drive(driveInput());

      expect(resultA.status).toBe("completed");
      expect(resultB.status).toBe("completed");
      expect(authorityA.batchDigests()).toEqual(authorityB.batchDigests());
      expect(authorityA.factsDigest()).toBe(authorityB.factsDigest());
    },
  );

  it.each([7, 19])(
    "restarts at an in-flight kill point with the same next transition digest (seed %i)",
    async (seed) => {
      const { dag, crashOnce } = scenario(seed);
      // The first task in Plan order never settles: the "process" dies with
      // its Lease granted and its run started but unclassified.
      const hungTaskId = dag.tasks[0]?.id as string;
      const hungRunId = `run_${contentDigest({
        operation_id: OPERATION_ID,
        task_id: hungTaskId,
        attempt_number: 1,
      }).slice(0, 24)}`;
      const killedAuthority = new ReplayAuthority();
      const killedScheduler = freshScheduler({
        dag,
        authority: killedAuthority,
        script: (taskId, callIndex) => {
          if (taskId === hungTaskId && callIndex === 0) return { kind: "hang" };
          if (crashOnce.has(taskId) && callIndex === 0) return { kind: "crash" };
          return { kind: "complete" };
        },
      });
      const abandoned = killedScheduler.drive(driveInput());
      // The abandoned drive never settles; silence its (impossible) rejection.
      void abandoned.catch(() => undefined);
      await waitFor(() =>
        killedAuthority.runs.some(
          (record) => record.run_id === hungRunId && record.record_kind === "run_started",
        ),
      );
      // Let every other in-flight classification land before the snapshot.
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      const snapshot = ReplayAuthority.cloneOf(killedAuthority);

      // Two independent processes recover the identical snapshot. Tasks whose
      // attempts were already in flight when the process died complete after
      // recovery — their seeded crash allowance was spent pre-kill; only
      // never-started tasks still crash their first attempt.
      const startedPreKill = new Set(snapshot.leases.map((record) => record.task_id));
      const continuation =
        (crashSet: Set<string>) =>
        (taskId: string, callIndex: number): PoolScript => {
          if (startedPreKill.has(taskId)) return { kind: "complete" };
          if (crashSet.has(taskId) && callIndex === 0) return { kind: "crash" };
          return { kind: "complete" };
        };
      const authorityA = ReplayAuthority.cloneOf(snapshot);
      const schedulerA = freshScheduler({
        dag,
        authority: authorityA,
        script: continuation(crashOnce),
      });
      const authorityB = ReplayAuthority.cloneOf(snapshot);
      const schedulerB = freshScheduler({
        dag,
        authority: authorityB,
        script: continuation(crashOnce),
      });
      const [resultA, resultB] = await Promise.all([
        schedulerA.recover({ ...driveInput(), recovery_command_id: "command_recovery_prop" }),
        schedulerB.recover({ ...driveInput(), recovery_command_id: "command_recovery_prop" }),
      ]);

      expect(resultA.status).toBe("completed");
      expect(resultB.status).toBe("completed");
      // The shared prefix plus both continuations are byte-identical: the
      // same facts decide the same next transition in any process.
      expect(authorityA.batchDigests()).toEqual(authorityB.batchDigests());
      expect(authorityA.batchDigests().length).toBeGreaterThan(snapshot.batches.length);
      expect(authorityA.factsDigest()).toBe(authorityB.factsDigest());
      // The killed attempt was revoked and retried exactly once.
      const hungLeases = authorityA.leases.filter((record) => record.task_id === hungTaskId);
      expect(
        hungLeases.some((record) => record.state === "revoked" && record.attempt_number === 1),
      ).toBe(true);
      expect(
        hungLeases.some(
          (record) =>
            record.state === "granted" &&
            record.attempt_number === 2 &&
            record.retry_kind === "executor_retry",
        ),
      ).toBe(true);
    },
  );
});
