import type { EdgeRecord, NodeRecord } from "@universal-harness-internal/core";

import {
  PLAN_EXTENSION_KEY,
  activeEdges,
  buildProjectionDocument,
  currentNodeMap,
  edgesFrom,
  extensionText,
  nodesOfType,
  type ProjectionDocument,
  type ProjectionGraph,
  type ProjectionSource,
} from "./index.js";

/**
 * Tasks projection (design 13.7; comparative design direction 1): a
 * SpecKit-style task list -- numbered T001..., checkboxed from authoritative
 * completion state, dependency-annotated and `[P]`-marked for parallel
 * siblings. The graph is the only source of truth: the rendered file is a
 * disposable view under `.harness/projections/views/`, never editable state.
 */
export interface TasksProjectionOptions {
  /**
   * Task ids proven complete by committed snapshots (task outcome
   * `success`). Supplied by the caller; the graph alone does not carry run
   * outcomes, and this list is exactly what keeps the checkbox honest.
   */
  readonly completedTasks?: readonly string[];
}

function byId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Deterministic topological order over one plan's task ids: Kahn's
 * algorithm with the smallest ready id first, so numbering is stable across
 * runs. A cycle (already forbidden by graph integrity) degrades to id order
 * for the remaining tasks instead of dropping them.
 */
function orderTasks(taskIds: readonly string[], edges: readonly EdgeRecord[]): string[] {
  const members = new Set(taskIds);
  const indegree = new Map<string, number>(taskIds.map((id) => [id, 0]));
  const dependents = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.type !== "DEPENDS_ON") continue;
    if (!members.has(edge.source_id) || !members.has(edge.target_id)) continue;
    indegree.set(edge.source_id, (indegree.get(edge.source_id) ?? 0) + 1);
    dependents.set(edge.target_id, [...(dependents.get(edge.target_id) ?? []), edge.source_id]);
  }
  const ready = taskIds.filter((id) => (indegree.get(id) ?? 0) === 0).sort(byId);
  const ordered: string[] = [];
  while (ready.length > 0) {
    const next = ready.shift() as string;
    ordered.push(next);
    for (const dependent of (dependents.get(next) ?? []).sort(byId)) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        const insertAt = ready.findIndex((id) => id > dependent);
        ready.splice(insertAt === -1 ? ready.length : insertAt, 0, dependent);
      }
    }
  }
  const leftover = taskIds.filter((id) => !ordered.includes(id)).sort(byId);
  return [...ordered, ...leftover];
}

function taskNumber(index: number): string {
  return `T${String(index + 1).padStart(3, "0")}`;
}

/** Render the SpecKit-style task list for every committed ExecutionPlan. */
export function renderTasksProjection(
  graph: ProjectionGraph,
  options?: TasksProjectionOptions,
): ProjectionDocument {
  const nodes = currentNodeMap(graph);
  const edges = activeEdges(graph);
  const completed = new Set(options?.completedTasks ?? []);
  const sources: ProjectionSource[] = [];
  const body: string[] = [
    "# Tasks",
    "",
    "Generated from the authoritative graph -- do not edit. Regenerate with `harness snapshot`.",
    "",
  ];

  const plans = nodesOfType(nodes, "ExecutionPlan");
  if (plans.length === 0) {
    body.push("No execution plan recorded yet.");
    return buildProjectionDocument("tasks", sources, body);
  }

  for (const plan of plans) {
    sources.push({ id: plan.id, revision: plan.revision });
    body.push(`## Plan ${plan.id} (revision ${plan.revision})`, "");
    const tasks = edgesFrom(edges, plan.id, "CONTAINS")
      .map((edge) => nodes.get(edge.target_id))
      .filter((node): node is NodeRecord => node !== undefined && node.type === "Task");
    if (tasks.length === 0) {
      body.push("No tasks in this plan.", "");
      continue;
    }
    const orderedIds = orderTasks(tasks.map((task) => task.id).sort(byId), edges);
    const numberById = new Map(orderedIds.map((id, index) => [id, taskNumber(index)]));
    const rootIds = new Set(
      orderedIds.filter((id) => edgesFrom(edges, id, "DEPENDS_ON").length === 0),
    );
    for (const id of orderedIds) {
      const task = nodes.get(id) as NodeRecord;
      sources.push({ id: task.id, revision: task.revision });
      const checkbox = completed.has(id) ? "[x]" : "[ ]";
      // [P] marks a dependency-free task that has at least one
      // dependency-free sibling: a genuinely parallel wave, never a lone task.
      const parallel = rootIds.has(id) && rootIds.size > 1 ? " [P]" : "";
      const objective = extensionText(task, PLAN_EXTENSION_KEY, "objective") ?? task.id;
      const dependencies = edgesFrom(edges, id, "DEPENDS_ON")
        .map((edge) => numberById.get(edge.target_id) ?? edge.target_id)
        .sort(byId);
      const depends = dependencies.length > 0 ? ` (depends on ${dependencies.join(", ")})` : "";
      body.push(`- ${checkbox} ${numberById.get(id) ?? id}${parallel} ${objective}${depends}`);
    }
    body.push("");
  }

  return buildProjectionDocument("tasks", sources, body);
}
