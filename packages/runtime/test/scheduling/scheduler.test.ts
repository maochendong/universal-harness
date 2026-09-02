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
import { issueGrant, type CapabilityGrant } from "../../src/policy/capability-grant.js";
import {
  buildDecision,
  type EffectivePolicy,
  type PolicyDecision,
} from "../../src/policy/decision.js";
import { taskSemanticDigest, type Protocol13TaskSpecification } from "../../src/planning/task.js";
import {
  AgentPoolError,
  type AgentPoolCancelOutcome,
  type AgentPoolRunInput,
} from "../../src/scheduling/agent-pool.js";
import type { DriverLockHandle } from "../../src/scheduling/driver-lock.js";
import { buildTaskLeaseChain, grantTaskLease } from "../../src/scheduling/lease.js";
import {
  createInMemoryPolicyDecisionPort,
  schedulerPolicyAction,
  type SchedulerPolicyResolver,
} from "../../src/scheduling/policy-adapters.js";
import type { AgentPoolSlot, SchedulerPolicyInput } from "../../src/scheduling/ports.js";
import {
  createLocalTaskScheduler,
  type SchedulerAuthority,
  type SchedulerDriveInput,
  type SchedulerTransition,
} from "../../src/scheduling/scheduler.js";
import type { SchedulerEventSpec } from "../../src/scheduling/events.js";
import type {
  TaskExecutionWorkspace,
  TaskWorkspaceManager,
} from "../../src/scheduling/workspace-manager.js";
import { MANAGED_PROFILE } from "../policy/fixtures.js";
import {
  BASELINE_COMMIT,
  ITERATION_ID,
  OPERATION_ID,
  PLAN_DIGEST,
  fixtureDag,
} from "./scheduler-facts.js";

/**
 * Plan Task 9 step 3/5: the deterministic drive loop behind one authoritative
 * transition seam. The recording authority below plays the Ledger: every
 * commit is one ordered transition batch, and the fixtures prove that a
 * reservation + granted Lease land BEFORE the pool starts a process, that the
 * four Policy outcomes map to exactly one behavior each, and that retry,
 * cancellation and fencing follow design §15.
 */

const NOW = "2026-08-31T00:00:00.000Z";
const EFFECTIVE: EffectivePolicy = { fields: [], layers: [], digest: "e".repeat(64) };
const ADAPTER_MANIFEST_DIGEST = "d".repeat(64);

function schedTask(
  id: string,
  dependencies: readonly string[] = [],
  overrides: Partial<Protocol13TaskSpecification> = {},
): Protocol13TaskSpecification {
  return {
    id,
    objective: `Implement ${id}`,
    impact_paths: [[`impact-${id}`]],
    expected_outputs: [`${id}-output`],
    capabilities: ["code-edit"],
    tools: [],
    dependencies: [...dependencies],
    risk: "low",
    budget: { steps: 10, tokens: 1000, duration_ms: 60_000 },
    write_paths: [`src/${id}`],
    exclusive_resources: [],
    acceptance: [{ description: "works", verification: "unit test" }],
    required_gates: [],
    ...overrides,
  };
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

/** Crash-style result whose metered consumption feeds the retry budget. */
function crashResult(): AgentRunResult {
  return stubResult({
    outcome: "failed",
    termination_reason: "adapter_failure",
    completion_claimed: false,
    usage: {
      input_tokens: 60,
      output_tokens: 40,
      total_tokens: 100,
      duration_ms: 5,
      metering: "provider_reported",
    },
    budget_observations: [
      { dimension: "steps", availability: "measured", used: 2, limit: 10, enforcement: "harness" },
      {
        dimension: "tokens",
        availability: "measured",
        used: 100,
        limit: 1000,
        enforcement: "harness",
      },
    ],
  });
}

class RecordingAuthority implements SchedulerAuthority {
  readonly leases: TaskLeaseRecord[] = [];
  readonly runs: RunRecord[] = [];
  readonly approvals: ApprovalRequestRecord[] = [];
  readonly findings: FeedbackRecord[] = [];
  readonly wave_integrations: WaveIntegrationRecord[] = [];
  readonly gate_evidence: GateEvidenceRecord[] = [];
  readonly appendedEvidence: { kind: string; locator: string; digest: string }[] = [];
  readonly events: SchedulerEventSpec[] = [];
  readonly batches: SchedulerTransition[][] = [];
  rejectAtomicCancellation = false;
  private cancellationCommitCount = 0;

  async readFacts(operationId: string) {
    if (operationId !== OPERATION_ID) throw new Error(`unknown operation ${operationId}`);
    const queued = this.events
      .filter((event) => event.eventType === "TaskIntegrationQueued")
      .flatMap((event) => {
        const taskId = event.payload["task_id"];
        const runId = event.payload["run_id"];
        const patchDigest = event.payload["patch_digest"];
        const evidence = this.appendedEvidence.find(
          (entry) => entry.kind === "task_candidate_patch" && entry.digest === patchDigest,
        );
        return typeof taskId === "string" && typeof runId === "string" && evidence !== undefined
          ? [
              {
                task_id: taskId,
                run_id: runId,
                patch_locator: evidence.locator,
                patch_digest: evidence.digest,
              },
            ]
          : [];
      });
    return {
      leases: [...this.leases],
      runs: [...this.runs],
      gate_evidence: [...this.gate_evidence],
      approvals: [...this.approvals],
      findings: [...this.findings],
      wave_integrations: [...this.wave_integrations],
      candidate_patches: queued,
    };
  }

  async commit(transitions: readonly SchedulerTransition[]): Promise<void> {
    const cancellationTaskIds = new Set(
      transitions.flatMap((transition) =>
        transition.kind === "record_run" &&
        transition.record.record_kind === "run_terminated" &&
        transition.record.termination_reason === "user_cancellation"
          ? [transition.record.task_id]
          : [],
      ),
    );
    if (this.rejectAtomicCancellation && cancellationTaskIds.size > 0) {
      this.cancellationCommitCount += 1;
      // The correct implementation attempts one aggregate transaction and
      // fails before visibility. The legacy per-Lease loop instead exposes
      // its first batch and fails on the second, modelling the partial-write
      // hazard this fixture protects against.
      if (cancellationTaskIds.size > 1 || this.cancellationCommitCount === 2) {
        this.rejectAtomicCancellation = false;
        throw new Error("injected atomic cancellation commit failure");
      }
    }
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
          this.appendedEvidence.push(...transition.evidence);
          break;
        case "append_gate_evidence":
          this.gate_evidence.push(...transition.records);
          break;
        case "append_event":
          this.events.push(transition.event);
          break;
      }
    }
  }

  batchDigests(): readonly string[] {
    return this.batches.map((batch) => contentDigest(canonicalizeJson(batch)));
  }

  latestLease(taskId: string): TaskLeaseRecord | undefined {
    const chain = buildTaskLeaseChain(this.leases);
    return chain.latest_by_task.get(taskId);
  }
}

type PoolScript =
  | { readonly kind: "complete"; readonly result?: Partial<AgentRunResult> }
  | { readonly kind: "crash" }
  | { readonly kind: "abortable" }
  | { readonly kind: "oblivious" }
  | { readonly kind: "hang" };

/**
 * LocalAgentPool test double. It enforces the one ordering the design makes
 * atomic: a run may only start after its granted Lease is committed — any
 * start without a committed grant flips `startedBeforeLeaseCommit`.
 */
class FakePool {
  readonly startedRuns: { task_id: string; run_id: string; slot_id: string }[] = [];
  readonly cancelled: string[] = [];
  startedBeforeLeaseCommit = false;
  private readonly slots: AgentPoolSlot[];
  private readonly controllers = new Map<string, AbortController>();
  private readonly settled = new Map<string, Promise<void>>();
  private readonly cancellationOutcomes = new Map<string, Promise<AgentPoolCancelOutcome>>();
  private readonly callsPerTask = new Map<string, number>();

  constructor(
    readonly capacity: number,
    private readonly authority: RecordingAuthority,
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
    const granted = this.authority.leases.some(
      (lease) => lease.run_id === input.run_id && lease.state === "granted",
    );
    if (!granted) this.startedBeforeLeaseCommit = true;
    const slot = this.slots.find((candidate) => candidate.state === "idle");
    if (slot === undefined) {
      throw new AgentPoolError("pool_exhausted", `no idle slot for ${input.task_id}`);
    }
    slot.state = "running";
    slot.task_id = input.task_id;
    slot.run_id = input.run_id;
    this.startedRuns.push({ task_id: input.task_id, run_id: input.run_id, slot_id: slot.slot_id });
    const callIndex = this.callsPerTask.get(input.task_id) ?? 0;
    this.callsPerTask.set(input.task_id, callIndex + 1);
    const script = this.script(input.task_id, callIndex);
    const controller = new AbortController();
    this.controllers.set(input.run_id, controller);

    const finish = (
      result: AgentRunResult,
    ): { slot_id: string; task_id: string; run_id: string; result: AgentRunResult } => {
      slot.state = "idle";
      delete slot.task_id;
      delete slot.run_id;
      this.controllers.delete(input.run_id);
      return { slot_id: slot.slot_id, task_id: input.task_id, run_id: input.run_id, result };
    };

    if (script.kind === "hang") {
      const pending = new Promise<never>(() => {});
      const tracked = pending.then(
        () => undefined,
        () => undefined,
      );
      this.settled.set(input.run_id, tracked);
      return pending;
    }
    if (script.kind === "abortable") {
      const resultPromise = new Promise<AgentRunResult>((resolve) => {
        controller.signal.addEventListener("abort", () => {
          resolve(
            stubResult({
              outcome: "partial",
              termination_reason: "user_cancellation",
              completion_claimed: false,
            }),
          );
        });
      });
      this.cancellationOutcomes.set(
        input.run_id,
        resultPromise.then((result) => ({ status: "confirmed" as const, result })),
      );
      const result = await resultPromise;
      return finish(result);
    }
    if (script.kind === "oblivious") {
      const resultPromise = new Promise<AgentRunResult>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(stubResult()));
      });
      this.cancellationOutcomes.set(
        input.run_id,
        resultPromise.then((result) => ({ status: "unconfirmed" as const, result })),
      );
      const result = await resultPromise;
      return finish(result);
    }
    if (script.kind === "crash") {
      return finish(crashResult());
    }
    return finish(stubResult(script.result ?? {}));
  }

  async cancel(runId: string): Promise<AgentPoolCancelOutcome> {
    const controller = this.controllers.get(runId);
    if (controller === undefined) {
      throw new AgentPoolError("unknown_run", `no active run ${runId}`);
    }
    this.cancelled.push(runId);
    controller.abort();
    const outcome = this.cancellationOutcomes.get(runId);
    if (outcome === undefined) {
      return { status: "failed", error: new Error(`run ${runId} has no cancellation outcome`) };
    }
    return outcome;
  }
}

function stubWorkspaces(): TaskWorkspaceManager & {
  readonly discarded: string[];
  readonly collected: string[];
} {
  const discarded: string[] = [];
  const collected: string[] = [];
  return {
    discarded,
    collected,
    async prepareTaskWorkspace(input): Promise<TaskExecutionWorkspace> {
      return {
        workspace_id: `workspace_${input.task.id}_${input.slot_id}`,
        root: `/virtual/worktrees/${input.task.id}`,
        handle: { workspace_id: `workspace_${input.task.id}_${input.slot_id}` } as never,
      };
    },
    async collectTaskCandidate(input) {
      collected.push(input.task.id);
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
      throw new Error("not used in scheduler tests");
    },
    async discardTaskWorkspace(workspaceId: string) {
      discarded.push(workspaceId);
    },
  };
}

interface Harness {
  readonly scheduler: ReturnType<typeof createLocalTaskScheduler>;
  readonly authority: RecordingAuthority;
  readonly pool: FakePool;
  readonly workspaces: ReturnType<typeof stubWorkspaces>;
  readonly policyInputs: SchedulerPolicyInput[];
}

function envelopeFor(task: Protocol13TaskSpecification): AgentTaskEnvelope {
  return {
    task_id: task.id,
    plan_id: "plan_1",
    iteration_id: ITERATION_ID,
    repository_id: "repo_1",
    objective: task.objective,
    expected_output: task.expected_outputs.join(","),
    acceptance_criteria: task.acceptance.map((criterion) => criterion.description),
    required_gate_ids: [...task.required_gates],
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
  };
}

function harness(options: {
  readonly tasks: readonly Protocol13TaskSpecification[];
  readonly script: (taskId: string, callIndex: number) => PoolScript;
  readonly resolver?: SchedulerPolicyResolver;
  readonly capacity?: number;
  readonly staleContexts?: readonly string[];
  readonly adapterCapabilities?: readonly string[];
  readonly buildEnvelopeFailsFor?: ReadonlySet<string>;
}): Harness {
  const dag = fixtureDag(options.tasks);
  const authority = new RecordingAuthority();
  const pool = new FakePool(options.capacity ?? 4, authority, options.script);
  const workspaces = stubWorkspaces();
  const policyInputs: SchedulerPolicyInput[] = [];
  const resolver: SchedulerPolicyResolver =
    options.resolver ??
    ((action) =>
      buildDecision({
        outcome: "allow",
        reasons: [],
        action_digest: actionDigest(action),
        effective: EFFECTIVE,
      }));
  const scheduler = createLocalTaskScheduler({
    dag_port: {
      name: "stub-dag",
      async readApproved(input) {
        if (
          input.expected_plan_digest !== undefined &&
          input.expected_plan_digest !== dag.plan_digest
        ) {
          throw new Error("plan digest drift");
        }
        return dag;
      },
    },
    policy: createInMemoryPolicyDecisionPort({
      resolve: (action, input) => {
        policyInputs.push(input);
        return resolver(action, input);
      },
    }),
    authority,
    pool,
    workspaces,
    adapter_manifest_digest: ADAPTER_MANIFEST_DIGEST,
    adapter_control_profile: MANAGED_PROFILE,
    adapter_capabilities: options.adapterCapabilities ?? ["code-edit"],
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
      issueTaskGrant: ({ task, lease, reservation }): CapabilityGrant =>
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
      buildEnvelope: ({ task }) => {
        if (options.buildEnvelopeFailsFor?.has(task.id)) {
          throw new Error(`envelope assembly failed for ${task.id}`);
        }
        return envelopeFor(task);
      },
      evidenceDir: ({ run_id }) => `/virtual/evidence/${run_id}`,
      readStaleContextTaskIds: () => options.staleContexts ?? [],
    },
    now: () => NOW,
  });
  return { scheduler, authority, pool, workspaces, policyInputs };
}

const driverLock: DriverLockHandle = {
  operation_id: OPERATION_ID,
  owner_token: "owner-token",
  path: "/virtual/lock",
  release: async () => {},
};

function driveInput(overrides: Partial<SchedulerDriveInput> = {}): SchedulerDriveInput {
  return {
    operation_id: OPERATION_ID,
    expected_plan_digest: PLAN_DIGEST,
    requested_max_concurrency: 2,
    driver_lock: driverLock,
    ...overrides,
  };
}

function batchKinds(authority: RecordingAuthority): readonly string[][] {
  return authority.batches.map((batch) => batch.map((transition) => transition.kind));
}

/** Preload a granted lease as if a previous process had committed it. */
function preloadGrantedLease(
  authority: RecordingAuthority,
  task: Protocol13TaskSpecification,
  runId: string,
): TaskLeaseRecord {
  const decision: PolicyDecision = buildDecision({
    outcome: "allow",
    reasons: [],
    action_digest: "0".repeat(64),
    effective: EFFECTIVE,
  });
  return grantTaskLease({
    chain: buildTaskLeaseChain(authority.leases),
    decision,
    expected_action_digest: "0".repeat(64),
    operation_id: OPERATION_ID,
    iteration_id: ITERATION_ID,
    plan_digest: PLAN_DIGEST,
    task_id: task.id,
    task_digest: taskSemanticDigest(task),
    run_id: runId,
    slot_id: "slot_1",
    baseline_commit: BASELINE_COMMIT,
    agent_adapter_digest: ADAPTER_MANIFEST_DIGEST,
    reserved_budget: { steps: task.budget.steps, tokens: task.budget.tokens },
    issued_at: NOW,
    expires_at: "2026-08-31T00:01:00.000Z",
    command_id: `command_preload_${runId}`,
  });
}

describe("drive dispatch transaction", () => {
  it("fails closed instead of releasing a Lease when a required Task Gate has no Evidence", async () => {
    const task = schedTask("task_a", [], { required_gates: ["gate_required"] });
    const { scheduler, authority } = harness({
      tasks: [task],
      script: () => ({ kind: "complete" }),
    });

    const result = await scheduler.drive(driveInput());

    expect(result.status).toBe("blocked");
    expect(authority.latestLease(task.id)?.state).toBe("revoked");
    expect(authority.gate_evidence).toEqual([]);
    expect(
      authority.findings.some(
        (finding) =>
          (finding.extensions?.["harness.finding"] as { rule?: string } | undefined)?.rule ===
          "task_gate_failed",
      ),
    ).toBe(true);
  });

  it("commits the reservation and granted Lease before the pool starts", async () => {
    const { scheduler, authority, pool } = harness({
      tasks: [schedTask("task_a")],
      script: () => ({ kind: "complete" }),
    });
    const result = await scheduler.drive(driveInput());

    expect(result.status).toBe("completed");
    expect(pool.startedBeforeLeaseCommit).toBe(false);
    expect(batchKinds(authority)).toEqual([
      ["grant_lease", "append_event"],
      ["record_run", "append_event"],
      ["record_run", "append_evidence", "append_event"],
    ]);
    const grant = authority.batches[0]?.[0];
    if (grant?.kind !== "grant_lease") throw new Error("expected a grant_lease transition");
    expect(grant.record.task_id).toBe("task_a");
    expect(grant.record.state).toBe("granted");
    expect(grant.record.fencing_token).toBe(1);
    expect(grant.record.task_digest).toBe(taskSemanticDigest(schedTask("task_a")));
    expect(grant.record.reserved_budget).toEqual({ steps: 10, tokens: 1000 });
    expect(authority.events.map((event) => event.eventType)).toEqual([
      "TaskLeaseGranted",
      "TaskDispatched",
      "TaskIntegrationQueued",
    ]);
    // completion_claimed alone changed nothing until verification ran: the
    // Lease remains granted while the Task waits for candidate validation.
    const latest = authority.latestLease("task_a");
    expect(latest?.state).toBe("granted");
    const status = result.read_model.projection.tasks.find((task) => task.task_id === "task_a");
    expect(status?.status).toBe("verifying");
  });

  it("grants every selected Lease in Plan order before classifying any result", async () => {
    const { scheduler, authority, pool } = harness({
      tasks: [schedTask("task_a"), schedTask("task_b")],
      script: () => ({ kind: "complete" }),
    });
    const result = await scheduler.drive(driveInput());

    expect(result.status).toBe("completed");
    const kinds = batchKinds(authority);
    expect(kinds.slice(0, 4)).toEqual([
      ["grant_lease", "append_event"],
      ["record_run", "append_event"],
      ["grant_lease", "append_event"],
      ["record_run", "append_event"],
    ]);
    const grants = authority.batches
      .flatMap((batch) => batch)
      .filter((transition) => transition.kind === "grant_lease");
    expect(grants.map((transition) => transition.record.task_id)).toEqual(["task_a", "task_b"]);
    expect(pool.startedRuns.map((run) => run.task_id)).toEqual(["task_a", "task_b"]);
    expect(pool.startedBeforeLeaseCommit).toBe(false);
  });
});

describe("policy outcomes", () => {
  it("requires_approval creates one digest-bound request and pauses only that Task", async () => {
    const approvalDigest = "a".repeat(64);
    let approved = false;
    const { scheduler, authority, pool } = harness({
      tasks: [schedTask("task_a"), schedTask("task_b")],
      script: () => ({ kind: "complete" }),
      resolver: (action, input) => {
        const isTaskB = input.task_digest === taskSemanticDigest(schedTask("task_b"));
        if (isTaskB && !approved) {
          return buildDecision({
            outcome: "requires_approval",
            reasons: ["high-risk dispatch"],
            action_digest: actionDigest(action),
            effective: EFFECTIVE,
          });
        }
        if (isTaskB && approved) {
          return buildDecision({
            outcome: "requires_approval",
            reasons: ["high-risk dispatch"],
            action_digest: actionDigest(action),
            effective: EFFECTIVE,
            approval_digest: approvalDigest,
          });
        }
        return buildDecision({
          outcome: "allow",
          reasons: [],
          action_digest: actionDigest(action),
          effective: EFFECTIVE,
        });
      },
    });

    const first = await scheduler.drive(driveInput());
    expect(first.status).toBe("paused");
    // Only task_b paused: task_a was dispatched and classified normally.
    expect(pool.startedRuns.map((run) => run.task_id)).toEqual(["task_a"]);
    expect(authority.latestLease("task_b")).toBeUndefined();
    expect(authority.approvals).toHaveLength(1);
    const request = authority.approvals[0];
    expect(request?.object_id).toBe("task_b");
    expect(request?.object_type).toBe("scheduler_action");
    // The request binds the exact normalized dispatch action digest.
    const boundInput = schedulerPolicyAction({
      action: "dispatch_task",
      operation_id: OPERATION_ID,
      iteration_id: ITERATION_ID,
      plan_digest: PLAN_DIGEST,
      task_digest: taskSemanticDigest(schedTask("task_b")),
      wave_index: 0,
      baseline_commit: BASELINE_COMMIT,
      risk: "low",
      capabilities: ["code-edit"],
      tools: [],
      write_paths: ["src/task_b"],
      exclusive_resources: [],
      task_remaining_budget: { steps: 10, tokens: 1000, duration_ms: 60_000 },
      // task_a's reservation landed first in the same pass, so task_b's
      // decision input sees the post-reservation iteration remainder.
      iteration_remaining_budget: { steps: 90, tokens: 99_000, duration_ms: 3_600_000 },
      adapter_manifest_digest: ADAPTER_MANIFEST_DIGEST,
      adapter_control_profile: MANAGED_PROFILE,
      effective_policy_digest: EFFECTIVE.digest,
    });
    expect(request?.object_digest).toBe(actionDigest(boundInput));
    const projection = first.read_model.projection.tasks;
    expect(projection.find((task) => task.task_id === "task_b")?.status).toBe("awaiting_approval");
    expect(projection.find((task) => task.task_id === "task_a")?.status).toBe("verifying");

    // The human approves elsewhere; the request leaves the pending set and
    // the next drive grants the Lease with the approval binding recorded.
    approved = true;
    authority.approvals.length = 0;
    const second = await scheduler.drive(driveInput());
    expect(second.status).toBe("completed");
    const lease = authority.latestLease("task_b");
    expect(lease?.state).toBe("granted");
    expect(
      authority.leases.find((record) => record.task_id === "task_b")?.approval_digests,
    ).toEqual([approvalDigest]);
  });

  it("deny produces a blocking Finding and no Lease", async () => {
    const { scheduler, authority, pool } = harness({
      tasks: [schedTask("task_a")],
      script: () => ({ kind: "complete" }),
      resolver: (action) =>
        buildDecision({
          outcome: "deny",
          reasons: ["dispatch denied by project policy"],
          action_digest: actionDigest(action),
          effective: EFFECTIVE,
        }),
    });
    const result = await scheduler.drive(driveInput());

    expect(result.status).toBe("blocked");
    expect(pool.startedRuns).toEqual([]);
    expect(authority.leases).toEqual([]);
    expect(authority.approvals).toEqual([]);
    expect(authority.findings).toHaveLength(1);
    const extension = authority.findings[0]?.extensions?.["harness.finding"] as {
      blocking: boolean;
      blocks: string[];
      rule: string;
    };
    expect(extension.blocking).toBe(true);
    expect(extension.blocks).toEqual(["task_a"]);
    expect(extension.rule).toBe("policy_denial");
    expect(
      result.read_model.projection.tasks.find((task) => task.task_id === "task_a")?.status,
    ).toBe("blocked");
  });

  it("block produces a policy-conflict Finding and can never consume an Approval", async () => {
    const { scheduler, authority, pool } = harness({
      tasks: [schedTask("task_a")],
      script: () => ({ kind: "complete" }),
      resolver: (action) =>
        buildDecision({
          outcome: "block",
          reasons: ["conflicting policy layers"],
          action_digest: actionDigest(action),
          effective: EFFECTIVE,
          // A forged binding must not matter: block has no approval path.
          approval_digest: "a".repeat(64),
        }),
    });
    const result = await scheduler.drive(driveInput());

    expect(result.status).toBe("blocked");
    expect(pool.startedRuns).toEqual([]);
    expect(authority.leases).toEqual([]);
    expect(authority.approvals).toEqual([]);
    const extension = authority.findings[0]?.extensions?.["harness.finding"] as { rule: string };
    expect(extension.rule).toBe("policy_conflict");
  });
});

describe("executor retry and fencing", () => {
  it("retries a crashed executor once on the remaining Task budget", async () => {
    const { scheduler, authority, policyInputs } = harness({
      tasks: [schedTask("task_a")],
      script: (_taskId, callIndex) => (callIndex === 0 ? { kind: "crash" } : { kind: "complete" }),
    });
    const result = await scheduler.drive(driveInput());

    expect(result.status).toBe("completed");
    const retryDecision = policyInputs.find((input) => input.action === "retry_task");
    expect(retryDecision?.retry_kind).toBe("executor_retry");
    expect(retryDecision?.task_remaining_budget).toEqual({
      steps: 8,
      tokens: 900,
      duration_ms: 60_000,
    });

    const leases = authority.leases.filter((record) => record.task_id === "task_a");
    const grantedRetry = leases.find(
      (record) => record.state === "granted" && record.attempt_number === 2,
    );
    expect(grantedRetry?.retry_kind).toBe("executor_retry");
    expect(grantedRetry?.fencing_token).toBe(2);
    expect(grantedRetry?.reserved_budget).toEqual({ steps: 8, tokens: 900 });
    const expiredFirst = leases.find(
      (record) => record.state === "expired" && record.attempt_number === 1,
    );
    expect(expiredFirst?.consumed_budget).toEqual({ steps: 2, tokens: 100 });
    expect(authority.events.map((event) => event.eventType)).toContain("TaskRetryScheduled");
    expect(
      result.read_model.projection.tasks.find((task) => task.task_id === "task_a")?.status,
    ).toBe("verifying");
  });

  it("blocks the Task after the second crash and keeps the consumed budget accounted", async () => {
    const { scheduler, authority } = harness({
      tasks: [schedTask("task_a")],
      script: () => ({ kind: "crash" }),
    });
    const result = await scheduler.drive(driveInput());

    expect(result.status).toBe("blocked");
    const grants = authority.leases.filter(
      (record) => record.task_id === "task_a" && record.state === "granted",
    );
    expect(grants.map((record) => record.attempt_number)).toEqual([1, 2]);
    // The retry consumed exactly the original budget minus the first crash.
    expect(grants[1]?.reserved_budget).toEqual({ steps: 8, tokens: 900 });
    const finding = authority.findings.at(-1);
    const extension = finding?.extensions?.["harness.finding"] as {
      rule: string;
      blocks: string[];
    };
    expect(extension.rule).toBe("retry_exhausted");
    expect(extension.blocks).toEqual(["task_a"]);
    expect(
      result.read_model.projection.tasks.find((task) => task.task_id === "task_a")?.status,
    ).toBe("blocked");
    // Budget accounting: both crashes settled against the original Task budget.
    expect(result.read_model.budget.remaining).toEqual({
      steps: 100 - 4,
      tokens: 100_000 - 200,
    });
  });

  it("rejects results carrying a stale fencing token", async () => {
    const { scheduler } = harness({
      tasks: [schedTask("task_a")],
      script: (_taskId, callIndex) => (callIndex === 0 ? { kind: "crash" } : { kind: "complete" }),
    });
    await scheduler.drive(driveInput());

    await expect(
      scheduler.acceptRunResult({
        operation_id: OPERATION_ID,
        task_id: "task_a",
        fencing_token: 1,
      }),
    ).rejects.toThrow(/fencing token/u);
    await expect(
      scheduler.acceptRunResult({
        operation_id: OPERATION_ID,
        task_id: "task_a",
        fencing_token: 1,
      }),
    ).rejects.toMatchObject({ kind: "stale_fencing_token" });
    await expect(
      scheduler.acceptRunResult({
        operation_id: OPERATION_ID,
        task_id: "task_a",
        fencing_token: 2,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("cancellation", () => {
  it("stops new Leases, cancels the active run and revokes the Lease", async () => {
    const task = schedTask("task_a");
    const { scheduler, authority, pool, workspaces } = harness({
      tasks: [task],
      script: () => ({ kind: "abortable" }),
    });
    const lease = preloadGrantedLease(authority, task, "run_cancel_a");
    authority.leases.push(lease);
    const runPromise = pool.run({
      task_id: task.id,
      run_id: "run_cancel_a",
      workspace_root: "/virtual/worktrees/task_a",
      evidence_dir: "/virtual/evidence/run_cancel_a",
      envelope: envelopeFor(task),
      mode: "unattended",
    });
    void runPromise;

    const result = await scheduler.cancel({
      operation_id: OPERATION_ID,
      command_id: "command_cancel_1",
      reason: "user requested abort",
      driver_lock: driverLock,
    });
    await runPromise;

    expect(result.status).toBe("cancelled");
    expect(pool.cancelled).toEqual(["run_cancel_a"]);
    const batch = authority.batches.at(-1);
    expect(batch?.map((transition) => transition.kind)).toEqual(["record_run", "terminate_lease"]);
    const terminal = authority.latestLease("task_a");
    expect(terminal?.state).toBe("revoked");
    const run = authority.runs.at(-1);
    expect(run?.record_kind).toBe("run_terminated");
    if (run?.record_kind === "run_terminated") {
      expect(run.termination_reason).toBe("user_cancellation");
    }
    expect(
      result.read_model.projection.tasks.find((entry) => entry.task_id === "task_a")?.status,
    ).toBe("cancelled");
    // Diagnostic workspaces and evidence are preserved; nothing is deleted.
    expect(workspaces.discarded).toEqual([]);

    // A cancelled operation never earns a new Lease from this scheduler.
    const batchesBefore = authority.batches.length;
    const again = await scheduler.drive(driveInput());
    expect(again.status).toBe("cancelled");
    expect(authority.batches.length).toBe(batchesBefore);
  });

  it("commits all confirmed cancellations as one authoritative batch", async () => {
    const { scheduler, authority, pool } = harness({
      tasks: [schedTask("task_a"), schedTask("task_b")],
      script: () => ({ kind: "abortable" }),
    });
    const drive = scheduler.drive(driveInput());
    while (pool.startedRuns.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const cancellation = await scheduler.cancel({
      operation_id: OPERATION_ID,
      command_id: "command_cancel_atomic",
      reason: "user requested abort",
      driver_lock: driverLock,
    });
    await drive;

    expect(cancellation.status).toBe("cancelled");
    const terminalBatch = authority.batches.at(-1);
    expect(terminalBatch?.map((transition) => transition.kind)).toEqual([
      "record_run",
      "terminate_lease",
      "record_run",
      "terminate_lease",
    ]);
  });

  it("exposes no partial cancellation and lets drive classify once when the atomic commit fails", async () => {
    const { scheduler, authority, pool } = harness({
      tasks: [schedTask("task_a"), schedTask("task_b")],
      script: () => ({ kind: "abortable" }),
    });
    const drive = scheduler.drive(driveInput());
    while (pool.startedRuns.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    authority.rejectAtomicCancellation = true;

    await expect(
      scheduler.cancel({
        operation_id: OPERATION_ID,
        command_id: "command_cancel_atomic_failure",
        reason: "user requested abort",
        driver_lock: driverLock,
      }),
    ).rejects.toThrow("injected atomic cancellation commit failure");
    await drive;

    const terminalRuns = authority.runs.filter(
      (run): run is Extract<RunRecord, { record_kind: "run_terminated" }> =>
        run.record_kind === "run_terminated",
    );
    expect(terminalRuns.map((run) => run.task_id).sort()).toEqual(["task_a", "task_b"]);
    const terminalLeases = authority.leases.filter((lease) => lease.state !== "granted");
    expect(terminalLeases.map((lease) => lease.task_id).sort()).toEqual(["task_a", "task_b"]);
  });

  it("records uncertain external effects when the process cannot confirm termination", async () => {
    const task = schedTask("task_a");
    const { scheduler, authority } = harness({
      tasks: [task],
      script: () => ({ kind: "complete" }),
    });
    const lease = preloadGrantedLease(authority, task, "run_ghost_a");
    authority.leases.push(lease);

    const result = await scheduler.cancel({
      operation_id: OPERATION_ID,
      command_id: "command_cancel_2",
      reason: "user requested abort",
      driver_lock: driverLock,
    });

    expect(result.status).toBe("unconfirmed");
    expect(authority.latestLease("task_a")?.state).toBe("granted");
    const finding = authority.findings.at(-1);
    const extension = finding?.extensions?.["harness.finding"] as { rule: string };
    expect(extension.rule).toBe("cancellation_uncertain");
    expect(
      result.read_model.projection.tasks.find((entry) => entry.task_id === "task_a")?.status,
    ).toBe("blocked");
  });

  it("lets the drive owner classify normal completion when the adapter ignores cancellation", async () => {
    const { scheduler, authority, pool } = harness({
      tasks: [schedTask("task_a")],
      script: () => ({ kind: "oblivious" }),
    });
    const drive = scheduler.drive(driveInput());
    while (pool.startedRuns.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const cancellation = await scheduler.cancel({
      operation_id: OPERATION_ID,
      command_id: "command_cancel_unconfirmed",
      reason: "user requested abort",
      driver_lock: driverLock,
    });
    await drive;

    expect(cancellation.status).toBe("unconfirmed");
    expect(authority.latestLease("task_a")?.state).toBe("granted");
    expect(authority.runs.at(-1)).toMatchObject({
      record_kind: "run_terminated",
      termination_reason: "completion",
    });
    expect(
      authority.runs.some(
        (run) =>
          run.record_kind === "run_terminated" && run.termination_reason === "user_cancellation",
      ),
    ).toBe(false);
    const finding = authority.findings.find(
      (candidate) =>
        (candidate.extensions?.["harness.finding"] as { rule?: string } | undefined)?.rule ===
        "cancellation_uncertain",
    );
    expect(finding).toBeDefined();
  });
});

describe("recovery", () => {
  it("keeps an orphan's unmeasured reservation charged and blocks automatic retry", async () => {
    const task = schedTask("task_a");
    const { scheduler, authority, pool } = harness({
      tasks: [task],
      script: () => ({ kind: "complete" }),
    });
    const lease = preloadGrantedLease(authority, task, "run_orphan_unknown_usage");
    authority.leases.push(lease);

    const recovered = await scheduler.recover({
      ...driveInput(),
      recovery_command_id: "command_recovery_unknown_usage",
    });

    const revoked = authority.leases.find(
      (record) => record.lease_id === lease.lease_id && record.state === "revoked",
    );
    expect(revoked?.consumed_budget).toEqual(lease.reserved_budget);
    expect(pool.startedRuns).toEqual([]);
    expect(recovered.status).toBe("blocked");
    expect(recovered.read_model.budget.remaining).toEqual({
      steps: 100 - lease.reserved_budget.steps,
      tokens: 100_000 - lease.reserved_budget.tokens,
    });
    expect(
      authority.findings.some(
        (finding) =>
          (finding.extensions?.["harness.finding"] as { rule?: string } | undefined)?.rule ===
          "budget_usage_unknown",
      ),
    ).toBe(true);
  });

  it("fails closed when a granted Lease has no live driver, then recover() revokes and retries", async () => {
    const task = schedTask("task_a");
    const { scheduler, authority } = harness({
      tasks: [task],
      script: () => ({ kind: "complete" }),
    });
    const lease = preloadGrantedLease(authority, task, "run_orphan_a");
    authority.leases.push(lease);
    authority.runs.push({
      protocol_version: "1.3.0",
      record_kind: "run_terminated",
      run_id: lease.run_id,
      task_id: task.id,
      workflow_operation_id: OPERATION_ID,
      attempt_id: "attempt_run_orphan_a",
      sequence: 2,
      timestamp: NOW,
      outcome: "failed",
      termination_reason: "adapter_failure",
      extensions: { "harness.scheduler": { consumed_budget: { steps: 2, tokens: 100 } } },
    });

    await expect(scheduler.drive(driveInput())).rejects.toMatchObject({
      name: "SchedulerError",
      kind: "recovery_required",
    });

    const recovered = await scheduler.recover({
      ...driveInput(),
      recovery_command_id: "command_recovery_1",
    });
    expect(recovered.status).toBe("completed");

    const recoveryBatch = authority.batches[0];
    expect(recoveryBatch?.map((transition) => transition.kind)).toEqual([
      "terminate_lease",
      "append_event",
    ]);
    expect(
      authority.runs.some(
        (record) => record.run_id === lease.run_id && record.record_kind === "run_interrupted",
      ),
    ).toBe(false);
    const revoked = authority.leases.find(
      (record) => record.lease_id === lease.lease_id && record.state === "revoked",
    );
    expect(revoked).toBeDefined();
    expect(authority.events.map((event) => event.eventType)).toContain("SchedulerRecovered");

    // The recovered Task re-dispatched with the next fencing token and the
    // single executor retry consumed.
    const retryGrant = authority.leases.find(
      (record) =>
        record.task_id === "task_a" && record.state === "granted" && record.attempt_number === 2,
    );
    expect(retryGrant?.fencing_token).toBe(2);
    expect(retryGrant?.retry_kind).toBe("executor_retry");
    expect(
      recovered.read_model.projection.tasks.find((entry) => entry.task_id === "task_a")?.status,
    ).toBe("verifying");

    // Replaying the same recovery command is a no-op: no second revocation.
    const batchesBefore = authority.batches.length;
    const again = await scheduler.recover({
      ...driveInput(),
      recovery_command_id: "command_recovery_1",
    });
    expect(again.status).toBe("completed");
    expect(authority.batches.length).toBe(batchesBefore);
  });
});

describe("dispatch preparation failures and readiness blocking", () => {
  it("revokes the just-granted Lease and blocks when envelope assembly fails", async () => {
    const { scheduler, authority, pool } = harness({
      tasks: [schedTask("task_a")],
      script: () => ({ kind: "complete" }),
      buildEnvelopeFailsFor: new Set(["task_a"]),
    });
    const result = await scheduler.drive(driveInput());

    expect(result.status).toBe("blocked");
    expect(pool.startedRuns).toEqual([]);
    expect(batchKinds(authority)).toEqual([
      ["grant_lease", "append_event"],
      ["terminate_lease", "create_finding"],
    ]);
    const latest = authority.latestLease("task_a");
    expect(latest?.state).toBe("revoked");
    const extension = authority.findings[0]?.extensions?.["harness.finding"] as { rule: string };
    expect(extension.rule).toBe("dispatch_preparation_failed");
  });

  it("blocks a ready Task whose context is stale instead of dispatching it", async () => {
    const { scheduler, authority, pool } = harness({
      tasks: [schedTask("task_a")],
      script: () => ({ kind: "complete" }),
      staleContexts: ["task_a"],
    });
    const result = await scheduler.drive(driveInput());

    expect(result.status).toBe("blocked");
    expect(pool.startedRuns).toEqual([]);
    expect(authority.leases).toEqual([]);
    const extension = authority.findings[0]?.extensions?.["harness.finding"] as { rule: string };
    expect(extension.rule).toBe("stale_context");
  });

  it("blocks a ready Task the homologous adapter cannot serve", async () => {
    const { scheduler, authority, pool } = harness({
      tasks: [schedTask("task_a")],
      script: () => ({ kind: "complete" }),
      adapterCapabilities: [],
    });
    const result = await scheduler.drive(driveInput());

    expect(result.status).toBe("blocked");
    expect(pool.startedRuns).toEqual([]);
    const extension = authority.findings[0]?.extensions?.["harness.finding"] as { rule: string };
    expect(extension.rule).toBe("capability_mismatch");
  });
});

describe("driver binding", () => {
  it("rejects a drive under another operation's driver lock", async () => {
    const { scheduler } = harness({
      tasks: [schedTask("task_a")],
      script: () => ({ kind: "complete" }),
    });
    await expect(
      scheduler.drive(
        driveInput({
          driver_lock: { ...driverLock, operation_id: "operation_other" },
        }),
      ),
    ).rejects.toMatchObject({ name: "SchedulerError", kind: "driver_lock_mismatch" });
  });
});
