import { type FeedbackRecord } from "@universal-harness-internal/core";
import { describe, expect, it } from "vitest";

import type {
  SchedulerProjectionStore,
  SchedulerLiveSnapshot,
} from "../../src/scheduling/ports.js";
import {
  SchedulerReadModelError,
  buildSchedulerReadModelBenchmarkFixture,
  nonParallelReasons,
  readSchedulerModel,
} from "../../src/scheduling/read-model.js";
import type { SchedulerAuthority, SchedulerLedgerFacts } from "../../src/scheduling/scheduler.js";
import {
  ITERATION_ID,
  OPERATION_ID,
  PLAN_DIGEST,
  blockingFinding,
  closedLease,
  fixtureDagWithWaves,
  fixtureTask,
  gateEvidence,
  grantedLease,
  pendingApproval,
  runStarted,
  runTerminated,
  waveIntegration,
} from "../scheduling/scheduler-facts.js";

/**
 * Scheduler Read Model tests (plan Task 11 step 5/6): the API-facing snapshot
 * joins Ledger/Graph facts first and the disposable live spool second through
 * projectSchedulerState(). Lite/inactive never fabricates tasks; a lost live
 * snapshot degrades only live_state to "rebuilding".
 */

const tasks = [fixtureTask("task_api"), fixtureTask("task_web", ["task_api"])];
const dag = fixtureDagWithWaves(tasks, [
  { wave_index: 0, task_ids: ["task_api"] },
  { wave_index: 1, task_ids: ["task_web"] },
]);

function emptyFacts(overrides: Partial<SchedulerLedgerFacts> = {}): SchedulerLedgerFacts {
  return {
    leases: [],
    runs: [],
    gate_evidence: [],
    approvals: [],
    findings: [],
    wave_integrations: [],
    candidate_patches: [],
    ...overrides,
  };
}

function authorityOf(facts: SchedulerLedgerFacts): SchedulerAuthority {
  return {
    readFacts: () => Promise.resolve(facts),
    commit: () => Promise.reject(new Error("read model never commits")),
  };
}

function validatedTaskApiFacts(): SchedulerLedgerFacts {
  const granted = grantedLease("task_api", "run_task_api");
  const released = closedLease(granted, "released", {
    command_id: `${granted.command_id}_released`,
  });
  return emptyFacts({
    leases: [granted, released],
    runs: [
      runStarted("task_api", "run_task_api"),
      runTerminated("task_api", "run_task_api", "handoff", "completion"),
    ],
    gate_evidence: [gateEvidence("task_api")],
  });
}

function liveStore(snapshot: SchedulerLiveSnapshot | null): SchedulerProjectionStore {
  return {
    replace: () => Promise.resolve(),
    read: () => Promise.resolve(snapshot),
    clear: () => Promise.resolve(),
  };
}

const LIVE: SchedulerLiveSnapshot = {
  operation_id: OPERATION_ID,
  observed_at: "2026-08-31T00:00:09.000Z",
  slots: [{ slot_id: "slot_1", state: "idle" }],
  tasks: [],
};

describe("readSchedulerModel", () => {
  it("joins operation, plan/waves, task projection, slots, budget and findings in one snapshot", async () => {
    const model = await readSchedulerModel({
      capability: "active",
      operation_id: OPERATION_ID,
      dag_port: { name: "fake-dag", readApproved: () => Promise.resolve(dag) },
      authority: authorityOf(validatedTaskApiFacts()),
      live: liveStore(LIVE),
      now: () => "2026-08-31T00:00:10.000Z",
    });

    expect(model).toMatchObject({
      capability_status: "active",
      operation: {
        operation_id: OPERATION_ID,
        iteration_id: ITERATION_ID,
        live_state: "observed",
      },
      plan: { plan_id: "plan_1", plan_digest: PLAN_DIGEST },
      budget: { limit: dag.iteration_budget },
    });
    expect(model.plan?.waves).toHaveLength(2);
    expect(model.tasks[0]).toMatchObject({
      task_id: "task_api",
      title: "Implement task_api",
      wave_index: 0,
      status: "candidate_validated",
      authority: "ledger",
      dependency_ids: [],
      current_run_id: "run_task_api",
    });
    expect(model.tasks[0]?.current_lease_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(model.tasks[1]).toMatchObject({
      task_id: "task_web",
      wave_index: 1,
      status: "waiting_dependency",
      dependency_ids: ["task_api"],
    });
    // The released lease settled its reservation into consumption.
    expect(model.budget.consumed_steps).toBe(1);
    expect(model.budget.consumed_tokens).toBe(10);
    expect(model.budget.reserved_steps).toBe(0);
    expect(model.slots).toEqual(LIVE.slots);
    expect(model.presentation_map["task:task_api"]).toBe("Implement task_api");
    expect(model.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("never fabricates tasks for an inactive (Lite) capability", async () => {
    const model = await readSchedulerModel({
      capability: "inactive_by_profile",
      operation_id: OPERATION_ID,
    });

    expect(model).toMatchObject({
      capability_status: "inactive_by_profile",
      operation: { operation_id: OPERATION_ID, status: "inactive_by_profile" },
      plan: null,
      tasks: [],
      slots: [],
      approvals: [],
      findings: [],
    });
  });

  it("fails closed when an active read lacks its authority sources", async () => {
    const error = await readSchedulerModel({
      capability: "active",
      operation_id: OPERATION_ID,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SchedulerReadModelError);
    expect((error as SchedulerReadModelError).kind).toBe("scheduler_sources_missing");
  });

  it("degrades only live_state when the live spool is lost", async () => {
    const model = await readSchedulerModel({
      capability: "active",
      operation_id: OPERATION_ID,
      dag_port: { name: "fake-dag", readApproved: () => Promise.resolve(dag) },
      authority: authorityOf(validatedTaskApiFacts()),
      live: liveStore(null),
      now: () => "2026-08-31T00:00:10.000Z",
    });

    expect(model.operation.live_state).toBe("rebuilding");
    expect(model.slots).toEqual([]);
    // Authority-derived statuses are unaffected: never a failed/success guess.
    expect(model.tasks[0]?.status).toBe("candidate_validated");
  });

  it("labels provisional-only evidence as provisional authority, never advancing the task", async () => {
    const facts = validatedTaskApiFacts();
    const provisional: SchedulerLedgerFacts = {
      ...facts,
      gate_evidence: [gateEvidence("task_api", { provisional: true })],
    };
    const model = await readSchedulerModel({
      capability: "active",
      operation_id: OPERATION_ID,
      dag_port: { name: "fake-dag", readApproved: () => Promise.resolve(dag) },
      authority: authorityOf(provisional),
      now: () => "2026-08-31T00:00:10.000Z",
    });

    expect(model.tasks[0]).toMatchObject({ task_id: "task_api", authority: "provisional" });
    expect(model.tasks[0]?.status).not.toBe("candidate_validated");
  });

  it("carries pending approvals, blocking findings and the retry/lease bindings", async () => {
    const retryGranted = grantedLease("task_web", "run_task_web", {
      retry_kind: "executor_retry",
      attempt_number: 2,
      fencing_token: 9,
      command_id: "command_retry_web",
    });
    const finding: FeedbackRecord = {
      ...blockingFinding("task_web"),
      extensions: {
        "harness.finding": {
          origin: "scheduler",
          blocking: true,
          violates: [],
          blocks: ["task_web"],
          evidence: [],
          rule: "budget_exhausted",
        },
      },
    };
    const model = await readSchedulerModel({
      capability: "active",
      operation_id: OPERATION_ID,
      dag_port: { name: "fake-dag", readApproved: () => Promise.resolve(dag) },
      authority: authorityOf(
        emptyFacts({
          leases: [retryGranted],
          approvals: [pendingApproval("task_web")],
          findings: [finding],
        }),
      ),
      now: () => "2026-08-31T00:00:10.000Z",
    });

    expect(model.approvals.map((request) => request.request_id)).toEqual(["request_task_web"]);
    expect(model.findings.map((entry) => entry.id)).toEqual(["finding_task_web"]);
    expect(model.presentation_map["finding:finding_task_web"]).toBe("budget_exhausted");
    expect(model.tasks[1]).toMatchObject({
      task_id: "task_web",
      status: "blocked",
      retry_kind: "executor_retry",
      current_run_id: "run_task_web",
    });
    expect(model.operation.status).toBe("blocked");
  });

  it("projects an integrated task from the WaveIntegration record alone", async () => {
    const model = await readSchedulerModel({
      capability: "active",
      operation_id: OPERATION_ID,
      dag_port: { name: "fake-dag", readApproved: () => Promise.resolve(dag) },
      authority: authorityOf(emptyFacts({ wave_integrations: [waveIntegration(0, ["task_api"])] })),
      now: () => "2026-08-31T00:00:10.000Z",
    });

    expect(model.tasks[0]).toMatchObject({ task_id: "task_api", status: "integrated" });
    expect(model.tasks[1]).toMatchObject({ task_id: "task_web", status: "ready" });
    expect(model.operation.status).toBe("running");
  });
});

describe("nonParallelReasons", () => {
  it("reports same-wave dependencies, write overlaps and exclusive resources deterministically", () => {
    const a = { ...fixtureTask("task_a"), write_paths: ["src/shared"] };
    const b = {
      ...fixtureTask("task_b"),
      dependencies: ["task_a"],
      write_paths: ["src/shared"],
      exclusive_resources: ["db"],
    };
    const peerConflict = {
      ...fixtureTask("task_c"),
      exclusive_resources: ["db"],
    };
    const wide = fixtureDagWithWaves(
      [a, b, peerConflict],
      [{ wave_index: 0, task_ids: ["task_a", "task_b", "task_c"] }],
    );
    expect(nonParallelReasons(b, wide)).toEqual([
      "depends_on_wave_peer:task_a",
      "write_path_overlap:task_a",
      "exclusive_resource_conflict:task_c",
    ]);
    expect(nonParallelReasons(a, wide)).toEqual(["write_path_overlap:task_b"]);
  });

  it("marks a task without a wave binding", () => {
    const lone = fixtureTask("task_lone");
    const sequential = fixtureDagWithWaves([lone], []);
    expect(nonParallelReasons(lone, sequential)).toEqual(["no_wave_assignment"]);
  });
});

describe("benchmark fixture (Task 14 exposes the <250ms gate)", () => {
  it("joins a 1,000-task projection without pathological cost", async () => {
    const { dag: benchDag, facts } = buildSchedulerReadModelBenchmarkFixture({
      task_count: 1000,
      integrated_waves: 100,
    });
    const started = performance.now();
    const model = await readSchedulerModel({
      capability: "active",
      operation_id: benchDag.operation_id,
      dag_port: { name: "bench-dag", readApproved: () => Promise.resolve(benchDag) },
      authority: authorityOf(facts),
      now: () => "2026-08-31T00:00:10.000Z",
    });
    const elapsed = performance.now() - started;

    expect(model.tasks).toHaveLength(1000);
    expect(model.tasks.filter((task) => task.status === "integrated")).toHaveLength(400);
    expect(model.tasks[400]?.status).toBe("ready");
    expect(model.digest).toMatch(/^[a-f0-9]{64}$/u);
    // Sanity bound only (10x the Task 14 gate): catches accidental quadratic
    // joins here; the real <250ms release gate lives in Task 14.
    expect(elapsed).toBeLessThan(2500);
  });
});
