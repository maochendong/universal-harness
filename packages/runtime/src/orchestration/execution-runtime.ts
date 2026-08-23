import type { AgentRunResult } from "@universal-harness-internal/plugin-sdk";

import type { TaskSpecification } from "../planning/task.js";
import type { AbortReason, RecoverableBlockReason } from "../workflow/state-machine.js";
import type { OrchestrationPhase } from "./phases.js";
import { OrchestrationError, type OrchestratorDependencies } from "./pipeline-types.js";
import type { ExecutionBinding } from "./execution-binding.js";

/** Resolve the only execution authority; implementation work never defaults. */
export function resolveExecutionBinding(deps: OrchestratorDependencies): ExecutionBinding {
  if (deps.execution !== undefined) return deps.execution;
  if (deps.execute !== undefined) {
    return {
      kind: "agent",
      name: "legacy-unproven-agent",
      deterministic: false,
      execute: deps.execute,
    };
  }
  throw new OrchestrationError(
    "configuration",
    "executor_required: implementation work requires an explicit agent or deterministic workflow execution binding",
  );
}

/** Deterministic Kahn ordering over accepted Task dependencies. */
export function orderExecutionTasks(
  tasks: readonly TaskSpecification[],
): readonly TaskSpecification[] {
  const byTaskId = new Map(tasks.map((task) => [task.id, task]));
  const indegree = new Map<string, number>(tasks.map((task) => [task.id, 0]));
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!byTaskId.has(dependency)) continue;
      indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), task.id]);
    }
  }
  const ready = tasks
    .map((task) => task.id)
    .filter((id) => (indegree.get(id) ?? 0) === 0)
    .sort();
  const ordered: TaskSpecification[] = [];
  while (ready.length > 0) {
    const next = ready.shift() as string;
    ordered.push(byTaskId.get(next) as TaskSpecification);
    for (const dependent of (dependents.get(next) ?? []).sort()) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        const insertAt = ready.findIndex((id) => id > dependent);
        ready.splice(insertAt === -1 ? ready.length : insertAt, 0, dependent);
      }
    }
  }
  return ordered;
}

export type RunFailureDisposition =
  | { readonly reason: RecoverableBlockReason; readonly resumePhase: OrchestrationPhase }
  | { readonly abort: AbortReason };

/** One authoritative adapter-failure -> workflow recovery policy. */
export function classifyRunFailure(result: AgentRunResult): RunFailureDisposition {
  switch (result.outcome) {
    case "correct_block":
      return { abort: "policy_violation" };
    case "partial":
      return { reason: "budget_ceiling", resumePhase: "execute" };
    case "clarification_required":
      return { reason: "missing_input", resumePhase: "capture" };
    case "handoff":
      return { reason: "missing_input", resumePhase: "execute" };
    default:
      return { reason: "transient_environment_failure", resumePhase: "execute" };
  }
}
