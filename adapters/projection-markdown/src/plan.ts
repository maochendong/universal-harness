import type { NodeRecord } from "@universal-harness-internal/core";

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

function planField(node: NodeRecord, field: string): unknown {
  const extension = node.extensions?.[PLAN_EXTENSION_KEY];
  if (typeof extension !== "object" || extension === null) return undefined;
  return (extension as Record<string, unknown>)[field];
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Plan projection (design 13.7): the ExecutionPlan with its execution mode
 * and one section per contained Task, including dependencies, risk, budget
 * and acceptance criteria from the declarative Task Specification.
 */
export function renderPlanProjection(graph: ProjectionGraph): ProjectionDocument {
  const nodes = currentNodeMap(graph);
  const edges = activeEdges(graph);
  const sources: ProjectionSource[] = [];
  const body: string[] = [];

  const plans = nodesOfType(nodes, "ExecutionPlan");
  if (plans.length === 0) {
    body.push("# Execution Plan", "", "No execution plan recorded yet.");
    return buildProjectionDocument("plan", sources, body);
  }

  for (const plan of plans) {
    sources.push({ id: plan.id, revision: plan.revision });
    const mode = planField(plan, "mode");
    const modeReason = planField(plan, "mode_reason");
    body.push(`# Execution Plan ${plan.id} (revision ${plan.revision})`, "");
    if (typeof mode === "string") {
      const reason = typeof modeReason === "string" ? `: ${modeReason}` : "";
      body.push(`Mode: ${mode}${reason}`, "");
    }
    const tasks = edgesFrom(edges, plan.id, "CONTAINS")
      .map((edge) => nodes.get(edge.target_id))
      .filter((node): node is NodeRecord => node !== undefined && node.type === "Task");
    if (tasks.length === 0) {
      body.push("No tasks in this plan.", "");
      continue;
    }
    for (const task of tasks) {
      sources.push({ id: task.id, revision: task.revision });
      const objective = extensionText(task, PLAN_EXTENSION_KEY, "objective");
      const risk = planField(task, "risk");
      body.push(`## Task ${task.id}`, "");
      if (objective !== undefined) body.push(objective, "");
      if (typeof risk === "string") body.push(`Risk: ${risk}`, "");
      const budget = planField(task, "budget");
      if (typeof budget === "object" && budget !== null) {
        const record = budget as Record<string, unknown>;
        if (typeof record.steps === "number" && typeof record.tokens === "number") {
          body.push(`Budget: ${record.steps} steps, ${record.tokens} tokens`, "");
        }
      }
      const dependencies = edgesFrom(edges, task.id, "DEPENDS_ON")
        .map((edge) => edge.target_id)
        .sort();
      if (dependencies.length > 0) {
        body.push(`Depends on: ${dependencies.join(", ")}`, "");
      }
      const implementsTargets = edgesFrom(edges, task.id, "IMPLEMENTS")
        .map((edge) => edge.target_id)
        .sort();
      if (implementsTargets.length > 0) {
        body.push(`Implements: ${implementsTargets.join(", ")}`, "");
      }
      const requiredGates = stringList(planField(task, "required_gates"));
      if (requiredGates.length > 0) {
        body.push(`Required gates: ${[...requiredGates].sort().join(", ")}`, "");
      }
      const acceptance = planField(task, "acceptance");
      if (Array.isArray(acceptance) && acceptance.length > 0) {
        body.push("Acceptance:", "");
        for (const criterion of acceptance) {
          if (typeof criterion !== "object" || criterion === null) continue;
          const record = criterion as Record<string, unknown>;
          const description = typeof record.description === "string" ? record.description : "";
          const verification = typeof record.verification === "string" ? record.verification : "";
          body.push(`- ${description} (verified by: ${verification})`);
        }
        body.push("");
      }
    }
    // Pull in IMPLEMENTS targets as sources: the plan view explains them.
    for (const task of tasks) {
      for (const edge of edgesFrom(edges, task.id, "IMPLEMENTS")) {
        const target = nodes.get(edge.target_id);
        if (target !== undefined) sources.push({ id: target.id, revision: target.revision });
      }
    }
  }

  return buildProjectionDocument("plan", sources, body);
}
