import type { DatabaseSync } from "node:sqlite";

import { createGraphView, type GraphView, type NodeType } from "../query-port.js";

/**
 * Execution Graph: the iteration-scoped orchestration view — how work ran,
 * when, and under which controls. Execution nodes are append-only runtime
 * records; the view shares Evidence and the feedback assets with the
 * Artifact Graph, so every run can be traced forward to the long-lived
 * knowledge it produced via `view.bridges(...)`.
 */
export const EXECUTION_GRAPH_NODE_TYPES = [
  "Iteration",
  "ExecutionPlan",
  "Task",
  "ContextBundle",
  "Run",
  "Checkpoint",
  "Evidence",
  "ApprovalRequest",
  "Approval",
  "Finding",
  "RootCauseAnalysis",
  "ImprovementCandidate",
  "ImpactSet",
] as const satisfies readonly NodeType[];

export function isExecutionGraphNodeType(type: NodeType): boolean {
  return (EXECUTION_GRAPH_NODE_TYPES as readonly string[]).includes(type);
}

export function createExecutionGraphView(database: DatabaseSync): GraphView {
  return createGraphView(database, {
    name: "execution",
    nodeTypes: EXECUTION_GRAPH_NODE_TYPES,
  });
}
