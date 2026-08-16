import type { TaskComplexity } from "./effective-risk.js";
import type { TaskSpecification } from "./task.js";
import { PlanningError } from "./validator.js";

export interface TaskSizeAssessment {
  readonly class: TaskComplexity;
  readonly score: number;
  readonly output_count: number;
  readonly assertion_count: number;
  readonly test_count: number;
}

export const MAX_AGENT_DAG_TASKS = 24;

/** Size by independently reviewable output and proof surface, not token guesses. */
export function assessTaskSize(task: TaskSpecification): TaskSizeAssessment {
  const assertions = task.assertions ?? [];
  const testCount = new Set(assertions.flatMap((assertion) => assertion.test_ids)).size;
  const score = task.expected_outputs.length + assertions.length * 2 + testCount;
  return {
    class: score > 16 ? "large" : score > 8 ? "medium" : "small",
    score,
    output_count: task.expected_outputs.length,
    assertion_count: assertions.length,
    test_count: testCount,
  };
}

/** Agent plans must stay bounded; large omnibus work is replanned, never silently downgraded. */
export function assertAgentPlanSize(tasks: readonly TaskSpecification[]): void {
  if (tasks.length > MAX_AGENT_DAG_TASKS) {
    throw new PlanningError(
      "dag_limit_exceeded",
      `agent plan has ${String(tasks.length)} tasks; maximum is ${String(MAX_AGENT_DAG_TASKS)}`,
    );
  }
  for (const task of tasks) {
    const size = assessTaskSize(task);
    if (size.class === "large") {
      throw new PlanningError(
        "task_too_large",
        `task ${task.id} has size score ${String(size.score)} and must be decomposed`,
      );
    }
  }
}
