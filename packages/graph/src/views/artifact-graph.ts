import type { DatabaseSync } from "node:sqlite";

import { createGraphView, type GraphView, type NodeType } from "../query-port.js";

/**
 * Artifact Graph: the long-lived, revision-bearing engineering knowledge
 * view — what the system is and why. It shares ledger identities with the
 * Execution Graph through the bridge node types below (Evidence and the
 * feedback assets), so every artifact can be traced back to the runs and
 * approvals that produced it via `view.bridges(...)`.
 */
export const ARTIFACT_GRAPH_NODE_TYPES = [
  "Project",
  "Repository",
  "Intent",
  "Requirement",
  "Constraint",
  "Decision",
  "Component",
  "CodeArtifact",
  "Policy",
  "ToolDefinition",
  "Test",
  "EvaluationCase",
  "Gate",
  "Evidence",
  "Finding",
  "RootCauseAnalysis",
  "ImprovementCandidate",
  "ImpactSet",
] as const satisfies readonly NodeType[];

export function isArtifactGraphNodeType(type: NodeType): boolean {
  return (ARTIFACT_GRAPH_NODE_TYPES as readonly string[]).includes(type);
}

export function createArtifactGraphView(database: DatabaseSync): GraphView {
  return createGraphView(database, {
    name: "artifact",
    nodeTypes: ARTIFACT_GRAPH_NODE_TYPES,
  });
}
