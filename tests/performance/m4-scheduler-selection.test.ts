import { describe, expect, it } from "vitest";

import type { Protocol13TaskSpecification } from "../../packages/runtime/src/planning/task.js";
import { createIterationBudgetAccount } from "../../packages/runtime/src/scheduling/budget.js";
import type { TaskDagSnapshot } from "../../packages/runtime/src/scheduling/ports.js";
import { selectReadyTasks } from "../../packages/runtime/src/scheduling/readiness.js";
import { emptyResourceLockTable } from "../../packages/runtime/src/scheduling/resource-locks.js";

import { measure, summarizeSamples } from "./helpers.js";

/**
 * M4 selection performance gate (design §25, plan Task 9 step 6): 100 warm
 * selections over a 1,000-Task Plan must hold p95 below 100 ms. The gate
 * measures the deterministic selection function itself — never a wall-clock
 * comparison between one and two Agent processes, which would assert nothing
 * about scheduling.
 */

const TASK_COUNT = 1_000;
const WARM_SELECTIONS = 5;
const MEASURED_SELECTIONS = 100;
const SELECTION_P95_THRESHOLD_MS = 100;

function perfTask(index: number): Protocol13TaskSpecification {
  const id = `task_${String(index).padStart(4, "0")}`;
  return {
    id,
    objective: `Implement ${id}`,
    impact_paths: [[`impact-${id}`]],
    expected_outputs: [`${id}-output`],
    capabilities: ["code-edit"],
    tools: [],
    dependencies: [],
    risk: "low",
    budget: { steps: 10, tokens: 1000, duration_ms: 60_000 },
    write_paths: [`src/module_${String(index)}`],
    exclusive_resources: [],
    acceptance: [{ description: "works", verification: "unit test" }],
    required_gates: [],
  };
}

function perfDag(): TaskDagSnapshot {
  const tasks = Array.from({ length: TASK_COUNT }, (_, index) => perfTask(index));
  return {
    operation_id: "operation_perf_m4",
    iteration_id: "iteration_perf_m4",
    plan_id: "plan_perf_m4",
    plan_digest: "c".repeat(64),
    baseline_commit: "0123456789abcdef0123456789abcdef01234567",
    tasks,
    parallel_waves: [{ wave_index: 0, task_ids: tasks.map((task) => task.id) }],
    iteration_budget: {
      steps: TASK_COUNT * 10,
      tokens: TASK_COUNT * 1000,
      duration_ms: 3_600_000,
    },
  };
}

describe("m4 scheduler selection performance", () => {
  it("selects from 1,000 tasks with p95 below 100ms over 100 warm selections", () => {
    const dag = perfDag();
    const facts = {
      leases: [],
      runs: [],
      gate_evidence: [],
      approvals: [],
      findings: [],
      wave_integrations: [],
      stale_context_task_ids: [],
    };
    const budget = createIterationBudgetAccount({
      limit: dag.iteration_budget,
      iteration_deadline: "2026-08-31T01:00:00.000Z",
    });
    const select = () =>
      selectReadyTasks({
        dag,
        facts,
        resources: emptyResourceLockTable(),
        budget,
        adapter: { unattended_eligible: true, capabilities: ["code-edit"] },
        available_slots: 8,
        effective_max_concurrency: 8,
      });

    for (let index = 0; index < WARM_SELECTIONS; index += 1) {
      select();
    }
    const samples: number[] = [];
    let selected: readonly { task: Protocol13TaskSpecification }[] = [];
    for (let index = 0; index < MEASURED_SELECTIONS; index += 1) {
      const sample = measure(() => select());
      selected = sample.result;
      samples.push(sample.elapsedMs);
    }
    const summary = summarizeSamples(samples);

    // Correctness pins: capacity clamp and Plan-order selection hold at scale.
    expect(selected.map((entry) => entry.task.id)).toEqual(
      Array.from({ length: 8 }, (_, index) => `task_${String(index).padStart(4, "0")}`),
    );
    expect(
      summary.p95_ms,
      `selection p95 ${String(summary.p95_ms)}ms over ${String(summary.samples)} samples ` +
        `(p50 ${String(summary.p50_ms)}ms, max ${String(summary.max_ms)}ms) exceeds ` +
        `${String(SELECTION_P95_THRESHOLD_MS)}ms`,
    ).toBeLessThan(SELECTION_P95_THRESHOLD_MS);
  });
});
