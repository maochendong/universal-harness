import { describe, expect, it } from "vitest";

import { buildTaskLeaseRecord, type TaskLeaseRecord } from "@universal-harness-internal/core";

import type { Protocol13TaskSpecification } from "../../src/planning/task.js";
import {
  createIterationBudgetAccount,
  type IterationBudgetAccount,
} from "../../src/scheduling/budget.js";
import {
  effectiveMaxConcurrency,
  selectReadyTasks,
  type SchedulerReadinessFacts,
  type SelectReadyTasksInput,
} from "../../src/scheduling/readiness.js";
import {
  acquireTaskResources,
  emptyResourceLockTable,
  type ResourceLockTable,
} from "../../src/scheduling/resource-locks.js";
import {
  fixtureDag,
  fixtureDagWithWaves,
  grantedLease,
  pendingApproval,
  runStarted,
  runTerminated,
  waveIntegration,
} from "./scheduler-facts.js";

/**
 * Plan Task 9 step 1/2: pure readiness and concurrency clamping. Selection
 * scans the earliest incomplete wave in Plan declaration order and never sorts
 * by duration, risk or model score; a wave-0 Task awaiting approval pauses
 * alone while independent wave-0 siblings still dispatch and no wave-1 Task
 * crosses the barrier.
 */

/**
 * scheduler-facts' closedLease reuses the granted record's command_id, which
 * the authoritative lease chain rejects as a command conflict; selection
 * builds the chain, so this terminal record carries its own command id.
 */
function terminatedLease(
  granted: TaskLeaseRecord,
  state: "released" | "expired" | "revoked",
  consumed = { steps: 2, tokens: 100 },
): TaskLeaseRecord {
  const identity: Record<string, unknown> = { ...granted };
  delete identity.record_digest;
  delete identity.protocol_version;
  delete identity.record_kind;
  return buildTaskLeaseRecord({
    ...(identity as unknown as Omit<
      TaskLeaseRecord,
      "protocol_version" | "record_kind" | "record_digest"
    >),
    task_lease_record_id: `${granted.task_lease_record_id}_${state}`,
    previous_lease_record_digest: granted.record_digest,
    state,
    consumed_budget: consumed,
    command_id: `${granted.command_id}_${state}`,
  });
}

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

function facts(overrides: Partial<SchedulerReadinessFacts> = {}): SchedulerReadinessFacts {
  return {
    leases: [],
    runs: [],
    gate_evidence: [],
    approvals: [],
    findings: [],
    wave_integrations: [],
    stale_context_task_ids: [],
    ...overrides,
  };
}

function account(
  limit: { steps: number; tokens: number; duration_ms: number } = {
    steps: 100,
    tokens: 100_000,
    duration_ms: 3_600_000,
  },
  consumed: IterationBudgetAccount["consumed"] = {},
): IterationBudgetAccount {
  return {
    ...createIterationBudgetAccount({
      limit,
      iteration_deadline: "2026-08-31T01:00:00.000Z",
    }),
    consumed,
  };
}

function selection(overrides: Partial<SelectReadyTasksInput> = {}): SelectReadyTasksInput {
  return {
    dag: fixtureDag([schedTask("task_a"), schedTask("task_b")]),
    facts: facts(),
    resources: emptyResourceLockTable(),
    budget: account(),
    adapter: { unattended_eligible: true, capabilities: ["code-edit"] },
    available_slots: 2,
    effective_max_concurrency: 2,
    ...overrides,
  };
}

describe("effectiveMaxConcurrency", () => {
  it("takes the minimum positive bound across every ceiling", () => {
    expect(
      effectiveMaxConcurrency({
        runtime_requested: 4,
        profile_limit: 2,
        installation_limit: 8,
        project_limit: 3,
        local_resource_limit: 16,
        unattended_eligible: true,
      }),
    ).toBe(2);
  });

  it("lets the runtime request clamp below every policy ceiling", () => {
    expect(
      effectiveMaxConcurrency({
        runtime_requested: 1,
        profile_limit: 2,
        installation_limit: 8,
        project_limit: 3,
        local_resource_limit: 16,
        unattended_eligible: true,
      }),
    ).toBe(1);
  });

  it("ignores non-positive and non-integer bounds instead of treating them as zero", () => {
    expect(
      effectiveMaxConcurrency({
        runtime_requested: 0,
        profile_limit: 2.5,
        installation_limit: -3,
        project_limit: 3,
        local_resource_limit: 16,
        unattended_eligible: true,
      }),
    ).toBe(3);
  });

  it("falls back to the fail-safe minimum of 1 when no positive bound exists", () => {
    expect(
      effectiveMaxConcurrency({
        runtime_requested: 0,
        profile_limit: 0,
        installation_limit: 0,
        project_limit: 0,
        local_resource_limit: 0,
        unattended_eligible: true,
      }),
    ).toBe(1);
  });

  it("forces single-slot supervised execution when the adapter is not unattended-eligible", () => {
    expect(
      effectiveMaxConcurrency({
        runtime_requested: 8,
        profile_limit: 8,
        installation_limit: 8,
        project_limit: 8,
        local_resource_limit: 8,
        unattended_eligible: false,
      }),
    ).toBe(1);
  });
});

describe("selectReadyTasks", () => {
  it("scans the earliest incomplete wave in Plan declaration order", () => {
    const selected = selectReadyTasks(selection());
    expect(selected.map((entry) => entry.task.id)).toEqual(["task_a", "task_b"]);
    expect(selected.every((entry) => entry.wave_index === 0)).toBe(true);
    expect(selected.map((entry) => entry.reservation)).toEqual([
      { steps: 10, tokens: 1000 },
      { steps: 10, tokens: 1000 },
    ]);
  });

  it("lets independent wave-0 tasks dispatch while one awaits approval, and holds the wave barrier", () => {
    const dag = fixtureDagWithWaves(
      [schedTask("task_a"), schedTask("task_b"), schedTask("task_c", ["task_b"])],
      [
        { wave_index: 0, task_ids: ["task_a", "task_b"] },
        { wave_index: 1, task_ids: ["task_c"] },
      ],
    );
    const selected = selectReadyTasks(
      selection({ dag, facts: facts({ approvals: [pendingApproval("task_a")] }) }),
    );
    expect(selected.map((entry) => entry.task.id)).toEqual(["task_b"]);
  });

  it("dispatches wave-1 tasks only after every wave-0 task integrated", () => {
    const dag = fixtureDagWithWaves(
      [schedTask("task_a"), schedTask("task_b", ["task_a"])],
      [
        { wave_index: 0, task_ids: ["task_a"] },
        { wave_index: 1, task_ids: ["task_b"] },
      ],
    );
    const selected = selectReadyTasks(
      selection({ dag, facts: facts({ wave_integrations: [waveIntegration(0, ["task_a"])] }) }),
    );
    expect(selected.map((entry) => [entry.task.id, entry.wave_index])).toEqual([["task_b", 1]]);
  });

  it("excludes tasks whose assembled context is stale", () => {
    const selected = selectReadyTasks(
      selection({ facts: facts({ stale_context_task_ids: ["task_a"] }) }),
    );
    expect(selected.map((entry) => entry.task.id)).toEqual(["task_b"]);
  });

  it("excludes tasks whose original Task budget is already consumed", () => {
    const selected = selectReadyTasks(
      selection({
        budget: account(undefined, { task_a: { steps: 10, tokens: 1000 } }),
      }),
    );
    expect(selected.map((entry) => entry.task.id)).toEqual(["task_b"]);
  });

  it("excludes tasks that no longer fit the remaining iteration budget", () => {
    const selected = selectReadyTasks(
      selection({ budget: account({ steps: 15, tokens: 100_000, duration_ms: 3_600_000 }) }),
    );
    expect(selected.map((entry) => entry.task.id)).toEqual(["task_a"]);
    expect(selected[0]?.reservation).toEqual({ steps: 10, tokens: 1000 });
  });

  it("excludes tasks conflicting with a held resource lock", () => {
    const held: ResourceLockTable = acquireTaskResources(emptyResourceLockTable(), {
      task_id: "task_elsewhere",
      fencing_token: 7,
      write_paths: ["src/task_a"],
      exclusive_resources: [],
    });
    const selected = selectReadyTasks(selection({ resources: held }));
    expect(selected.map((entry) => entry.task.id)).toEqual(["task_b"]);
  });

  it("excludes tasks whose capabilities the adapter cannot satisfy", () => {
    const selected = selectReadyTasks(
      selection({ adapter: { unattended_eligible: true, capabilities: [] } }),
    );
    expect(selected).toEqual([]);
  });

  it("excludes tasks with an active or current lease", () => {
    const lease = grantedLease("task_a", "run_a");
    const selected = selectReadyTasks(
      selection({ facts: facts({ leases: [lease], runs: [runStarted("task_a", "run_a")] }) }),
    );
    expect(selected.map((entry) => entry.task.id)).toEqual(["task_b"]);
  });

  it("keeps Plan declaration order even when a middle task is excluded", () => {
    const dag = fixtureDag([schedTask("task_a"), schedTask("task_b"), schedTask("task_c")]);
    const selected = selectReadyTasks(
      selection({
        dag,
        facts: facts({ stale_context_task_ids: ["task_b"] }),
        available_slots: 3,
        effective_max_concurrency: 3,
      }),
    );
    expect(selected.map((entry) => entry.task.id)).toEqual(["task_a", "task_c"]);
  });

  it("clamps the selection to the lower of free slots and effective concurrency", () => {
    const dag = fixtureDag([schedTask("task_a"), schedTask("task_b"), schedTask("task_c")]);
    expect(
      selectReadyTasks(selection({ dag, available_slots: 1, effective_max_concurrency: 3 })).map(
        (entry) => entry.task.id,
      ),
    ).toEqual(["task_a"]);
    expect(
      selectReadyTasks(selection({ dag, available_slots: 3, effective_max_concurrency: 2 })).map(
        (entry) => entry.task.id,
      ),
    ).toEqual(["task_a", "task_b"]);
    expect(
      selectReadyTasks(selection({ dag, available_slots: 0, effective_max_concurrency: 2 })),
    ).toEqual([]);
  });

  it("re-dispatches a retry-pending task once with executor_retry and only the remaining budget", () => {
    const granted = grantedLease("task_a", "run_a");
    const expired = terminatedLease(granted, "expired");
    const selected = selectReadyTasks(
      selection({
        facts: facts({
          leases: [granted, expired],
          runs: [
            runStarted("task_a", "run_a"),
            runTerminated("task_a", "run_a", "failed", "adapter_failure"),
          ],
        }),
        budget: account(undefined, { task_a: { steps: 2, tokens: 100 } }),
      }),
    );
    expect(selected.map((entry) => entry.task.id)).toEqual(["task_a", "task_b"]);
    const retry = selected[0];
    expect(retry?.retry_kind).toBe("executor_retry");
    expect(retry?.attempt_number).toBe(2);
    expect(retry?.fencing_token).toBe(granted.fencing_token + 1);
    expect(retry?.reservation).toEqual({ steps: 8, tokens: 900 });
  });
});
