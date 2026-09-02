import {
  buildOperationDag,
  contentDigest,
  harnessRootFor,
  readCommittedOperations,
  type CapabilityPlanRecord,
} from "@universal-harness-internal/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApprovalRequest } from "../../src/approval/request.js";
import {
  ParallelTaskExecutionError,
  SCHEDULER_DRIFT_KINDS,
  SCHEDULER_RECOVERY_ACTIONS,
  createLedgerSchedulerAuthority,
  createParallelExecuteDagRunner,
  driveParallelTaskExecution,
  schedulerApprovalContinuation,
  schedulerDriftEffect,
  schedulerRecoveryActionFor,
  schedulerResumeCommand,
  type ParallelTaskExecutionOutcome,
  type ParallelTaskExecutionPort,
} from "../../src/orchestration/scheduler-runtime.js";
import { resolveExecuteSubgraph } from "../../src/orchestration/capability-dag-runners.js";
import { taskIntegrationQueuedEvent } from "../../src/scheduling/events.js";
import { WorkflowEngine, type WorkflowDependencies } from "../../src/workflow/operation.js";
import {
  cleanupDirectories,
  makeDeps,
  makeProjectRoot,
  makeStartInput,
} from "../workflow/helpers.js";
import type { DriverLockHandle } from "../../src/scheduling/driver-lock.js";
import {
  waveIntegrationPolicyInput,
  type CandidateIntegrationController,
  type WaveCandidate,
} from "../../src/scheduling/integration.js";
import { buildTaskLeaseChain } from "../../src/scheduling/lease.js";
import { SchedulingPortError, type TaskDagPort } from "../../src/scheduling/ports.js";
import { projectSchedulerState } from "../../src/scheduling/projection.js";
import type {
  LocalTaskScheduler,
  SchedulerAuthority,
  SchedulerDriveInput,
  SchedulerDriveResult,
  SchedulerLedgerFacts,
  SchedulerReadModel,
  SchedulerTransition,
} from "../../src/scheduling/scheduler.js";
import type { PolicyDecisionPort } from "../../src/scheduling/ports.js";
import {
  BASELINE_COMMIT,
  ITERATION_ID,
  OPERATION_ID,
  PLAN_DIGEST,
  closedLease,
  fixtureDagWithWaves,
  fixtureTask,
  gateEvidence,
  grantedLease,
  runStarted,
  runTerminated,
  waveIntegration,
} from "../scheduling/scheduler-facts.js";

/**
 * Parallel execute runtime tests (plan Task 11): the drive loop verifies the
 * active Capability resolution, Driver Lock and connected-mode M3 Operation
 * Lease before any scheduling, then alternates scheduler drives and wave
 * integration until every wave integrates, a recoverable pause occurs,
 * cancellation lands or a blocker exists.
 */

const NOW = "2026-08-31T00:00:10.000Z";
const POLICY_DIGEST = "e".repeat(64);

const tasks = [fixtureTask("task_api"), fixtureTask("task_web", ["task_api"])];
const dag = fixtureDagWithWaves(tasks, [
  { wave_index: 0, task_ids: ["task_api"] },
  { wave_index: 1, task_ids: ["task_web"] },
]);

const parallelPlan = {
  record_digest: "9".repeat(64),
  operation_dag: { nodes: buildOperationDag(new Set(["parallel_task_execution"]), "1.3.0") },
} as unknown as CapabilityPlanRecord;

function driverLock(operationId = OPERATION_ID): DriverLockHandle {
  return {
    operation_id: operationId,
    owner_token: "owner_1",
    path: "/locks/driver",
    release: () => Promise.resolve(),
  };
}

function candidateValidatedFacts(
  taskId: string,
): Pick<SchedulerLedgerFacts, "leases" | "runs" | "gate_evidence" | "candidate_patches"> {
  const granted = grantedLease(taskId, `run_${taskId}`);
  return {
    // The chain guard (buildTaskLeaseChain, reached through
    // waveIntegrationPolicyInput's budget accounting) requires one record per
    // command id, so the terminal record gets its own — matching production,
    // where grant and close commands differ by construction.
    leases: [
      granted,
      closedLease(granted, "released", { command_id: `${granted.command_id}_released` }),
    ],
    runs: [
      runStarted(taskId, `run_${taskId}`),
      runTerminated(taskId, `run_${taskId}`, "handoff", "completion"),
    ],
    gate_evidence: [gateEvidence(taskId)],
    candidate_patches: [
      {
        task_id: taskId,
        run_id: `run_${taskId}`,
        patch_locator: `ledger://patches/${taskId}`,
        patch_digest: contentDigest({ patch: taskId }),
      },
    ],
  };
}

interface FakeHub {
  readonly log: string[];
  readonly authority: SchedulerAuthority;
  readonly integration: CandidateIntegrationController & {
    readonly accepted: readonly { readonly wave_index: number; readonly command_id: string }[];
  };
  state: {
    facts: SchedulerLedgerFacts;
  };
}

function fakeHub(initial: SchedulerLedgerFacts): FakeHub {
  const log: string[] = [];
  const state = { facts: initial };
  const accepted: { readonly wave_index: number; readonly command_id: string }[] = [];
  const authority: SchedulerAuthority = {
    readFacts: (operationId) => {
      log.push(`readFacts:${operationId}`);
      return Promise.resolve(state.facts);
    },
    commit: (transitions: readonly SchedulerTransition[]) => {
      log.push(`commit:${transitions.map((transition) => transition.kind).join("+")}`);
      for (const transition of transitions) {
        if (transition.kind === "request_approval") {
          state.facts = {
            ...state.facts,
            approvals: [...state.facts.approvals, transition.request],
          };
        }
      }
      return Promise.resolve();
    },
  };
  const integration: FakeHub["integration"] = {
    accepted,
    queueTaskCandidate: (candidate) => {
      log.push(`queue:${candidate.task_id}`);
      return Promise.resolve();
    },
    rebuildWaveCandidate: (input) => {
      log.push(`rebuild:${String(input.wave.wave_index)}`);
      const candidate: WaveCandidate = {
        wave_index: input.wave.wave_index,
        base_commit: input.expected_base_commit,
        candidate_commit: contentDigest({ candidate: input.wave.wave_index }),
        applied_task_ids: [...input.wave.task_ids],
      };
      return Promise.resolve(candidate);
    },
    validateTaskCandidate: (input) => {
      log.push(`validate:${input.task.id}`);
      return Promise.resolve({
        task_id: input.task.id,
        status: "candidate_validated" as const,
        evidence_digests: [],
      });
    },
    acceptWave: (input) => {
      log.push(`accept:${String(input.candidate.wave_index)}`);
      accepted.push({
        wave_index: input.candidate.wave_index,
        command_id: input.command_id,
      });
      const record = waveIntegration(input.candidate.wave_index, input.candidate.applied_task_ids);
      state.facts = {
        ...state.facts,
        wave_integrations: [...state.facts.wave_integrations, record],
      };
      return Promise.resolve(record);
    },
  };
  return { log, authority, integration, state };
}

function readModelOf(facts: SchedulerLedgerFacts): SchedulerReadModel {
  return {
    operation_id: OPERATION_ID,
    plan_digest: PLAN_DIGEST,
    projection: projectSchedulerState({ dag, ...facts }, null),
    budget: {
      limit: dag.iteration_budget,
      remaining: { steps: 0, tokens: 0 },
      reserved_task_ids: [],
    },
    pending_approvals: [...facts.approvals],
    blocking_findings: [],
  };
}

interface FakeScheduler {
  readonly calls: readonly SchedulerDriveInput[];
  readonly scheduler: LocalTaskScheduler;
}

/**
 * The fake scheduler mirrors the real contract: a drive only completes the
 * earliest unintegrated wave, so wave 1 facts appear only after wave 0 has a
 * WaveIntegration record.
 */
function fakeScheduler(
  hub: FakeHub,
  status: "completed" | "paused" | "blocked" | "cancelled" = "completed",
): FakeScheduler {
  const calls: SchedulerDriveInput[] = [];
  const scheduler: LocalTaskScheduler = {
    drive: (input) => {
      calls.push(input);
      hub.log.push(`drive:${input.operation_id}`);
      const integrated = new Set(
        hub.state.facts.wave_integrations
          .filter((record) => record.operation_id === OPERATION_ID)
          .map((record) => record.wave_index),
      );
      if (status === "completed" && integrated.has(0) && hub.state.facts.leases.length === 2) {
        hub.state.facts = {
          ...hub.state.facts,
          ...candidateValidatedFacts("task_web"),
          wave_integrations: hub.state.facts.wave_integrations,
        };
      }
      const result: SchedulerDriveResult = {
        status,
        operation_id: input.operation_id,
        read_model: readModelOf(hub.state.facts),
      };
      return Promise.resolve(result);
    },
    recover: () => Promise.reject(new Error("not used")),
    cancel: () => Promise.reject(new Error("not used")),
    read: () => Promise.reject(new Error("not used")),
  };
  return { calls, scheduler };
}

function fakePolicy(hub: FakeHub, decide?: PolicyDecisionPort["decide"]): PolicyDecisionPort {
  return {
    name: "fake-policy",
    decide:
      decide ??
      ((input) => {
        hub.log.push(`policy:${input.action}:${String(input.wave_index ?? "-")}`);
        return Promise.resolve({
          outcome: "allow" as const,
          reasons: [],
          action_digest: contentDigest({ action: input.action }),
          effective_policy_digest: POLICY_DIGEST,
          layers: [],
          field_traces: [],
          digest: contentDigest({ decision: input.action }),
        });
      }),
  };
}

function driverFor(
  hub: FakeHub,
  scheduler: LocalTaskScheduler,
  policy: PolicyDecisionPort,
  dagPort?: TaskDagPort,
): ParallelTaskExecutionPort {
  return driveParallelTaskExecution({
    scheduler,
    integration: hub.integration,
    authority: hub.authority,
    dag_port: dagPort ?? {
      name: "fake-dag",
      readApproved: () => {
        hub.log.push("readApproved");
        return Promise.resolve(dag);
      },
    },
    policy,
    capability_plan: parallelPlan,
    requested_max_concurrency: 2,
    adapter_manifest_digest: "d".repeat(64),
    adapter_control_profile: {
      control: "managed",
      trajectory_visibility: "full",
      usage_metering: true,
      side_effect_interception: true,
      resume_semantics: "clean_resume",
    },
    effective_policy_digest: POLICY_DIGEST,
    now: () => NOW,
  });
}

const runInput = {
  operation_id: OPERATION_ID,
  iteration_id: ITERATION_ID,
  capability_plan_digest: parallelPlan.record_digest,
  expected_plan_digest: PLAN_DIGEST,
  driver_lock: driverLock(),
} as const;

describe("parallel task execution driver", () => {
  it("alternates drive and wave integration until every wave integrates", async () => {
    const hub = fakeHub({
      leases: [],
      runs: [],
      gate_evidence: [],
      approvals: [],
      findings: [],
      wave_integrations: [],
      candidate_patches: [],
    });
    hub.state.facts = { ...hub.state.facts, ...candidateValidatedFacts("task_api") };
    const scheduler = fakeScheduler(hub);
    const port = driverFor(hub, scheduler.scheduler, fakePolicy(hub));

    const outcome = await port.run(runInput);

    expect(outcome.status).toBe("completed");
    expect(outcome.operation_id).toBe(OPERATION_ID);
    expect(outcome.wave_integration_digests).toHaveLength(2);
    expect(outcome.scheduler_state_digest).toMatch(/^[a-f0-9]{64}$/u);
    // Wave order is strict: wave 1 is never dispatched or integrated before
    // wave 0 landed its WaveIntegration record.
    expect(hub.log).toEqual([
      "drive:operation_1",
      "readApproved",
      "readFacts:operation_1",
      "queue:task_api",
      "rebuild:0",
      "readFacts:operation_1",
      "policy:integrate_wave:0",
      "accept:0",
      "drive:operation_1",
      "readApproved",
      "readFacts:operation_1",
      "queue:task_web",
      "rebuild:1",
      "readFacts:operation_1",
      "policy:integrate_wave:1",
      "accept:1",
      "drive:operation_1",
      "readApproved",
      "readFacts:operation_1",
    ]);
    expect(hub.integration.accepted[0]?.command_id).not.toBe(
      hub.integration.accepted[1]?.command_id,
    );
  });

  it("fails closed before any scheduling when the capability resolution is not parallel", async () => {
    const hub = fakeHub({
      leases: [],
      runs: [],
      gate_evidence: [],
      approvals: [],
      findings: [],
      wave_integrations: [],
    });
    const scheduler = fakeScheduler(hub);
    const notParallelPlan = {
      ...parallelPlan,
      operation_dag: { nodes: buildOperationDag(new Set(), "1.3.0") },
    } as unknown as CapabilityPlanRecord;
    const port = driveParallelTaskExecution({
      scheduler: scheduler.scheduler,
      integration: hub.integration,
      authority: hub.authority,
      dag_port: { name: "fake-dag", readApproved: () => Promise.resolve(dag) },
      policy: fakePolicy(hub),
      capability_plan: notParallelPlan,
      requested_max_concurrency: 2,
      adapter_manifest_digest: "d".repeat(64),
      adapter_control_profile: {
        control: "managed",
        trajectory_visibility: "full",
        usage_metering: true,
        side_effect_interception: true,
        resume_semantics: "clean_resume",
      },
      effective_policy_digest: POLICY_DIGEST,
      now: () => NOW,
    });

    const rejection = await port
      .run({ ...runInput, capability_plan_digest: notParallelPlan.record_digest })
      .catch((caught: unknown) => caught);
    expect(rejection).toBeInstanceOf(ParallelTaskExecutionError);
    expect((rejection as ParallelTaskExecutionError).kind).toBe("capability_not_active");
    expect(scheduler.calls).toHaveLength(0);
    expect(hub.log).toEqual([]);
  });

  it("rejects a capability plan digest drift and a foreign driver lock before driving", async () => {
    const hub = fakeHub({
      leases: [],
      runs: [],
      gate_evidence: [],
      approvals: [],
      findings: [],
      wave_integrations: [],
    });
    const scheduler = fakeScheduler(hub);
    const port = driverFor(hub, scheduler.scheduler, fakePolicy(hub));

    await expect(
      port.run({ ...runInput, capability_plan_digest: "f".repeat(64) }),
    ).rejects.toMatchObject({ kind: "capability_plan_binding_drift" });
    await expect(
      port.run({ ...runInput, driver_lock: driverLock("operation_other") }),
    ).rejects.toMatchObject({ kind: "driver_lock_invalid" });
    expect(scheduler.calls).toHaveLength(0);
  });

  it("verifies the connected-mode M3 operation lease before calling the scheduler", async () => {
    const hub = fakeHub({
      leases: [],
      runs: [],
      gate_evidence: [],
      approvals: [],
      findings: [],
      wave_integrations: [],
    });
    const scheduler = fakeScheduler(hub);
    const port = driverFor(hub, scheduler.scheduler, fakePolicy(hub));
    const lease = {
      resource_kind: "operation" as const,
      resource_id: OPERATION_ID,
      fencing_token: 7,
      state: "granted" as const,
      expires_at: "2026-08-31T01:00:00.000Z",
    };

    await expect(
      port.run({
        ...runInput,
        operation_lease: { ...lease, resource_id: "operation_other" } as never,
      }),
    ).rejects.toMatchObject({ kind: "operation_lease_invalid" });
    await expect(
      port.run({
        ...runInput,
        operation_lease: { ...lease, state: "expired" } as never,
      }),
    ).rejects.toMatchObject({ kind: "operation_lease_invalid" });
    await expect(
      port.run({
        ...runInput,
        operation_lease: { ...lease, expires_at: "2026-08-31T00:00:00.000Z" } as never,
      }),
    ).rejects.toMatchObject({ kind: "operation_lease_invalid" });
    expect(scheduler.calls).toHaveLength(0);
  });

  it("propagates an approval pause without integrating anything", async () => {
    const hub = fakeHub({
      leases: [],
      runs: [],
      gate_evidence: [],
      approvals: [],
      findings: [],
      wave_integrations: [],
      ...candidateValidatedFacts("task_api"),
    });
    const scheduler = fakeScheduler(hub, "paused");
    const port = driverFor(hub, scheduler.scheduler, fakePolicy(hub));

    const outcome = await port.run(runInput);

    expect(outcome.status).toBe("paused");
    expect(outcome.wave_integration_digests).toEqual([]);
    expect(hub.log.filter((entry) => entry.startsWith("accept"))).toEqual([]);
  });

  it("propagates cancellation without integrating anything", async () => {
    const hub = fakeHub({
      leases: [],
      runs: [],
      gate_evidence: [],
      approvals: [],
      findings: [],
      wave_integrations: [],
    });
    const scheduler = fakeScheduler(hub, "cancelled");
    const port = driverFor(hub, scheduler.scheduler, fakePolicy(hub));

    expect(await port.run(runInput)).toMatchObject({ status: "cancelled" });
  });

  it("blocks instead of accepting a wave whose tasks are not all candidate_validated", async () => {
    // task_api has a granted lease with no terminal run: still verifying.
    const granted = grantedLease("task_api", "run_task_api");
    const hub = fakeHub({
      leases: [granted],
      runs: [runStarted("task_api", "run_task_api")],
      gate_evidence: [],
      approvals: [],
      findings: [],
      wave_integrations: [],
      candidate_patches: [],
    });
    const scheduler = fakeScheduler(hub);
    const port = driverFor(hub, scheduler.scheduler, fakePolicy(hub));

    const outcome = await port.run(runInput);

    expect(outcome.status).toBe("blocked");
    expect(hub.log.filter((entry) => entry.startsWith("accept"))).toEqual([]);
  });

  it("requests one digest-bound approval when integrate_wave requires it, then accepts after approval", async () => {
    const hub = fakeHub({
      leases: [],
      runs: [],
      gate_evidence: [],
      approvals: [],
      findings: [],
      wave_integrations: [],
      ...candidateValidatedFacts("task_api"),
    });
    const scheduler = fakeScheduler(hub);
    const approvalDigest = "a".repeat(64);
    let approved = false;
    const policy = fakePolicy(hub, (input) => {
      hub.log.push(`policy:${input.action}:${String(input.wave_index ?? "-")}`);
      return Promise.resolve({
        outcome: "requires_approval" as const,
        reasons: ["wave integration requires approval"],
        action_digest: contentDigest({ action: input.action }),
        effective_policy_digest: POLICY_DIGEST,
        layers: [],
        field_traces: [],
        ...(approved ? { approval_digest: approvalDigest } : {}),
        digest: contentDigest({ decision: input.action }),
      });
    });
    const port = driverFor(hub, scheduler.scheduler, policy);

    const paused = await port.run(runInput);
    expect(paused.status).toBe("paused");
    const requests = hub.state.facts.approvals;
    expect(requests).toHaveLength(1);
    expect(requests[0]?.object_type).toBe("scheduler_action");
    expect(requests[0]?.workflow_operation_id).toBe(OPERATION_ID);
    expect(hub.integration.accepted).toHaveLength(0);

    approved = true;
    const accepted: { readonly approval_digests?: readonly string[] }[] = [];
    const acceptingIntegration: CandidateIntegrationController = {
      ...hub.integration,
      acceptWave: (input) => {
        accepted.push({ approval_digests: input.approval_digests });
        return hub.integration.acceptWave(input);
      },
    };
    const resumed = driveParallelTaskExecution({
      scheduler: scheduler.scheduler,
      integration: acceptingIntegration,
      authority: hub.authority,
      dag_port: { name: "fake-dag", readApproved: () => Promise.resolve(dag) },
      policy,
      capability_plan: parallelPlan,
      requested_max_concurrency: 2,
      adapter_manifest_digest: "d".repeat(64),
      adapter_control_profile: {
        control: "managed",
        trajectory_visibility: "full",
        usage_metering: true,
        side_effect_interception: true,
        resume_semantics: "clean_resume",
      },
      effective_policy_digest: POLICY_DIGEST,
      now: () => NOW,
    });
    const outcome = await resumed.run(runInput);
    expect(outcome.status).toBe("completed");
    expect(accepted[0]?.approval_digests).toEqual([approvalDigest]);
  });

  it("fails closed when the approved plan drifts between waves", async () => {
    const hub = fakeHub({
      leases: [],
      runs: [],
      gate_evidence: [],
      approvals: [],
      findings: [],
      wave_integrations: [],
      ...candidateValidatedFacts("task_api"),
    });
    const scheduler = fakeScheduler(hub);
    let drifted = false;
    const dagPort: TaskDagPort = {
      name: "fake-dag",
      readApproved: () => {
        if (drifted) {
          return Promise.reject(
            new SchedulingPortError("plan_digest_drift", "approved plan digest changed"),
          );
        }
        return Promise.resolve(dag);
      },
    };
    const acceptingIntegration: CandidateIntegrationController = {
      ...hub.integration,
      acceptWave: (input) => {
        drifted = true;
        return hub.integration.acceptWave(input);
      },
    };
    const port = driveParallelTaskExecution({
      scheduler: scheduler.scheduler,
      integration: acceptingIntegration,
      authority: hub.authority,
      dag_port: dagPort,
      policy: fakePolicy(hub),
      capability_plan: parallelPlan,
      requested_max_concurrency: 2,
      adapter_manifest_digest: "d".repeat(64),
      adapter_control_profile: {
        control: "managed",
        trajectory_visibility: "full",
        usage_metering: true,
        side_effect_interception: true,
        resume_semantics: "clean_resume",
      },
      effective_policy_digest: POLICY_DIGEST,
      now: () => NOW,
    });

    await expect(port.run(runInput)).rejects.toMatchObject({ kind: "plan_digest_drift" });
    expect(hub.integration.accepted).toHaveLength(1);
  });
});

describe("scheduler recovery actions", () => {
  it("freezes the typed blocker to recovery action map", () => {
    expect(SCHEDULER_RECOVERY_ACTIONS).toEqual({
      approval_missing: "open_approval",
      budget_exhausted: "submit_budget_policy_proposal",
      executor_failed: "inspect_retry",
      integration_conflict: "inspect_candidate_conflict",
      undeclared_write: "revise_plan_resources",
      baseline_drift: "return_to_impact_and_plan",
      wave_gate_failed: "open_gate_evidence_and_replan",
      adapter_ineligible: "change_adapter_or_supervise",
    });
  });

  it("maps scheduler finding rules to their single recovery action", () => {
    expect(schedulerRecoveryActionFor("budget_exhausted")).toBe("submit_budget_policy_proposal");
    expect(schedulerRecoveryActionFor("integration_conflict")).toBe("inspect_candidate_conflict");
    expect(schedulerRecoveryActionFor("undeclared_write")).toBe("revise_plan_resources");
    expect(schedulerRecoveryActionFor("write_set_violation")).toBe("revise_plan_resources");
    expect(schedulerRecoveryActionFor("wave_gate_failed")).toBe("open_gate_evidence_and_replan");
    expect(schedulerRecoveryActionFor("capability_mismatch")).toBe("change_adapter_or_supervise");
    expect(schedulerRecoveryActionFor("retry_exhausted")).toBe("inspect_retry");
    expect(schedulerRecoveryActionFor("baseline_drift")).toBe("return_to_impact_and_plan");
    expect(schedulerRecoveryActionFor("unknown_rule")).toBeUndefined();
  });

  it("projects the exact resume command for a dead driver", () => {
    expect(schedulerResumeCommand("operation_123")).toBe("harness resume operation_123");
  });
});

describe("parallel execute DAG runner", () => {
  const parallelContext = (subgraph?: "parallel_task_execution") => ({
    operation_id: OPERATION_ID,
    plan_digest: parallelPlan.record_digest,
    node: {
      node_id: "execute",
      node_kind: "kernel" as const,
      depends_on: ["context"],
      consumes: ["context_bundle", "execution_plan"] as const,
      produces: ["wave_integration"] as const,
      checkpoint: true,
      ...(subgraph === undefined ? {} : { subgraph }),
    },
    inputs: { context_bundle: "a".repeat(64), execution_plan: PLAN_DIGEST },
  });

  it("routes an active parallel execute node through the port exactly once", async () => {
    const outcome: ParallelTaskExecutionOutcome = {
      status: "completed",
      operation_id: OPERATION_ID,
      wave_integration_digests: ["1".repeat(64), "2".repeat(64)],
      scheduler_state_digest: "3".repeat(64),
    };
    const run = vi.fn().mockResolvedValue(outcome);
    // One memoized handle: the assertion pins the exact argument object, and a
    // fresh handle per call would differ only by its release closure identity.
    const lock = driverLock();
    const runner = createParallelExecuteDagRunner({
      parallelExecution: { run },
      iterationId: () => ITERATION_ID,
      driverLock: () => lock,
    });

    const result = await runner(parallelContext("parallel_task_execution"));

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({
      operation_id: OPERATION_ID,
      iteration_id: ITERATION_ID,
      capability_plan_digest: parallelPlan.record_digest,
      expected_plan_digest: PLAN_DIGEST,
      driver_lock: lock,
    });
    expect(result.status).toBe("committed");
    // execute produces the wave_integration binding exactly once; verify stays
    // the only gate_evidence producer (enforced by the DAG itself).
    expect(result).toMatchObject({
      produces: [{ kind: "wave_integration" }],
    });
  });

  it("fails closed when invoked for a node whose subgraph is not parallel", async () => {
    const run = vi.fn();
    const runner = createParallelExecuteDagRunner({
      parallelExecution: { run },
      iterationId: () => ITERATION_ID,
      driverLock: () => driverLock(),
    });

    await expect(runner(parallelContext())).resolves.toMatchObject({
      status: "blocked",
      reason: "parallel_execute_not_active",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("maps pause, block and cancellation outcomes without committing", async () => {
    const outcomes: Record<string, ParallelTaskExecutionOutcome> = {
      paused: {
        status: "paused",
        operation_id: OPERATION_ID,
        wave_integration_digests: [],
        scheduler_state_digest: "3".repeat(64),
      },
      blocked: {
        status: "blocked",
        operation_id: OPERATION_ID,
        wave_integration_digests: [],
        scheduler_state_digest: "3".repeat(64),
      },
      cancelled: {
        status: "cancelled",
        operation_id: OPERATION_ID,
        wave_integration_digests: [],
        scheduler_state_digest: "3".repeat(64),
      },
    };
    for (const [name, outcome] of Object.entries(outcomes)) {
      const runner = createParallelExecuteDagRunner({
        parallelExecution: { run: () => Promise.resolve(outcome) },
        iterationId: () => ITERATION_ID,
        driverLock: () => driverLock(),
      });
      const result = await runner(parallelContext("parallel_task_execution"));
      expect(result.status, name).toBe("blocked");
      expect(result).not.toMatchObject({ produces: expect.anything() });
    }
  });
});

describe("execute subgraph resolution", () => {
  it("pins the three activation combinations", () => {
    expect(resolveExecuteSubgraph(new Set(["parallel_task_execution", "strict_tdd"]))).toBe(
      "parallel_task_execution",
    );
    expect(resolveExecuteSubgraph(new Set(["strict_tdd"]))).toBe("strict_tdd");
    expect(resolveExecuteSubgraph(new Set())).toBeUndefined();
  });
});

describe("wave integration policy binding", () => {
  it("normalizes the exact integrate_wave action the driver decides", () => {
    const chain = buildTaskLeaseChain([]);
    expect(chain.records).toEqual([]);
    const input = waveIntegrationPolicyInput({
      dag,
      wave: dag.parallel_waves[0]!,
      base_commit: BASELINE_COMMIT,
      leases: [],
      adapter_manifest_digest: "d".repeat(64),
      adapter_control_profile: {
        control: "managed",
        trajectory_visibility: "full",
        usage_metering: true,
        side_effect_interception: true,
        resume_semantics: "clean_resume",
      },
      effective_policy_digest: POLICY_DIGEST,
      now: NOW,
    });
    expect(input.action).toBe("integrate_wave");
    expect(input.wave_index).toBe(0);
    expect(input.plan_digest).toBe(PLAN_DIGEST);
  });
});

// --- Production Ledger authority (Task 10 review obligations a/b) -------------

describe("ledger scheduler authority", () => {
  afterEach(() => {
    cleanupDirectories();
  });

  async function startedOperation(): Promise<{
    deps: WorkflowDependencies;
    operationId: string;
  }> {
    const projectRoot = makeProjectRoot();
    const deps = makeDeps(projectRoot, { now: () => NOW });
    const engine = new WorkflowEngine(deps);
    const started = await engine.startOperation(makeStartInput());
    return { deps, operationId: started.operation.workflow_operation_id };
  }

  function authorityFor(deps: WorkflowDependencies, operationId: string) {
    return createLedgerSchedulerAuthority({ deps, operation_id: operationId });
  }

  it("commits one transition batch as one 1.3-pinned transaction and reads the facts back", async () => {
    const { deps, operationId } = await startedOperation();
    const authority = authorityFor(deps, operationId);
    const lease = grantedLease("task_api", "run_task_api", {
      operation_id: operationId,
      iteration_id: "iteration_t0001",
    } as never);
    const run = {
      ...runStarted("task_api", "run_task_api"),
      workflow_operation_id: operationId,
    };
    const evidence = gateEvidence("task_api");
    const queued = taskIntegrationQueuedEvent({
      operation_id: operationId,
      task_id: "task_api",
      run_id: "run_task_api",
      patch_digest: "f".repeat(64),
    });
    const request = buildApprovalRequest({
      requestId: "request_wave_0",
      workflowOperationId: operationId,
      objectId: "wave_0",
      objectType: "scheduler_action",
      objectDigest: contentDigest({ action: "integrate_wave" }),
      baselineDigest: "2".repeat(64),
      policyDigest: POLICY_DIGEST,
      impactPath: [],
      risk: "low",
      reason: "policy requires approval to integrate wave 0",
      allowedDecisions: ["approve", "reject"],
      createdAt: NOW,
      resumePhase: "execute",
      proposedBy: "harness",
    });

    await authority.commit([
      { kind: "grant_lease", record: lease },
      { kind: "record_run", record: run },
      { kind: "append_gate_evidence", records: [evidence] },
      {
        kind: "append_evidence",
        evidence: [
          {
            kind: "task_candidate_patch",
            locator: "ledger://patches/task_api",
            digest: "f".repeat(64),
          },
        ],
      },
      { kind: "append_event", event: queued },
      { kind: "request_approval", request },
    ]);

    // The 1.3 reader gate: the transaction pins the exact protocol version.
    const operations = readCommittedOperations(harnessRootFor(deps.projectRoot));
    expect(operations.at(-1)?.manifest.required_reader_version).toBe("1.3.0");

    const facts = await authority.readFacts(operationId);
    expect(facts.leases.map((record) => record.task_lease_record_id)).toEqual([
      lease.task_lease_record_id,
    ]);
    expect(facts.runs.map((record) => record.run_id)).toEqual(["run_task_api"]);
    expect(facts.gate_evidence.map((record) => record.evidence_id)).toEqual(["evidence_task_api"]);
    expect(facts.approvals.map((record) => record.request_id)).toEqual(["request_wave_0"]);
    // candidate_patches is the derived join of the TaskIntegrationQueued
    // event with the committed task_candidate_patch evidence reference.
    expect(facts.candidate_patches).toEqual([
      {
        task_id: "task_api",
        run_id: "run_task_api",
        patch_locator: "ledger://patches/task_api",
        patch_digest: "f".repeat(64),
      },
    ]);
  });

  it("reads the latest committed record per evidence_id (provisional downgrade supersedes)", async () => {
    const { deps, operationId } = await startedOperation();
    const authority = authorityFor(deps, operationId);
    const original = gateEvidence("task_api", { passed: true });
    await authority.commit([{ kind: "append_gate_evidence", records: [original] }]);
    // Task 10 recovery re-commits the same evidence_id as a provisional copy.
    const downgraded = { ...original, provisional: true };
    await authority.commit([{ kind: "append_gate_evidence", records: [downgraded] }]);

    const facts = await authority.readFacts(operationId);
    expect(facts.gate_evidence).toHaveLength(1);
    expect(facts.gate_evidence[0]?.digest).toBe(original.digest);
    expect(facts.gate_evidence[0]?.provisional).toBe(true);
  });

  it("derives no candidate patch when the queued event lacks its evidence reference", async () => {
    const { deps, operationId } = await startedOperation();
    const authority = authorityFor(deps, operationId);
    await authority.commit([
      {
        kind: "append_event",
        event: taskIntegrationQueuedEvent({
          operation_id: operationId,
          task_id: "task_api",
          run_id: "run_task_api",
          patch_digest: "f".repeat(64),
        }),
      },
    ]);

    const facts = await authority.readFacts(operationId);
    expect(facts.candidate_patches).toEqual([]);
  });

  it("fails closed when committing for an unknown operation", async () => {
    const projectRoot = makeProjectRoot();
    const deps = makeDeps(projectRoot, { now: () => NOW });
    const authority = createLedgerSchedulerAuthority({ deps });
    const lease = grantedLease("task_api", "run_task_api");
    await expect(authority.commit([{ kind: "grant_lease", record: lease }])).rejects.toMatchObject({
      name: "ParallelTaskExecutionError",
      kind: "operation_not_found",
    });
  });
});

describe("approval arrival continuation (design §19.5)", () => {
  it("wakes a live driver in place", () => {
    expect(
      schedulerApprovalContinuation({ driver_live: true, operation_id: OPERATION_ID }),
    ).toEqual({ kind: "wake_driver" });
  });

  it("projects the exact resume command when no driver is live", () => {
    expect(
      schedulerApprovalContinuation({ driver_live: false, operation_id: OPERATION_ID }),
    ).toEqual({ kind: "resume_command", command: schedulerResumeCommand(OPERATION_ID) });
    expect(schedulerResumeCommand(OPERATION_ID)).toBe(`harness resume ${OPERATION_ID}`);
  });
});

describe("scheduling drift invalidation (design §17)", () => {
  it("invalidates pending decisions and degrades in-flight results for every drift kind", () => {
    expect(SCHEDULER_DRIFT_KINDS.length).toBeGreaterThan(0);
    for (const kind of SCHEDULER_DRIFT_KINDS) {
      expect(schedulerDriftEffect(kind)).toEqual({
        pending_decisions: "invalidated",
        in_flight_results: "provisional",
        reentry: kind === "baseline" ? "impact" : "plan",
      });
    }
  });

  it("re-enters at impact only for baseline drift; every other kind re-enters at plan", () => {
    expect(schedulerDriftEffect("baseline").reentry).toBe("impact");
    for (const kind of SCHEDULER_DRIFT_KINDS.filter((kind) => kind !== "baseline")) {
      expect(schedulerDriftEffect(kind).reentry).toBe("plan");
    }
  });
});
