import type { EdgeRecord, NodeRecord } from "@universal-harness-internal/core";

import type { TaskSpecification } from "../planning/task.js";

/**
 * Context source selection (design 13.4). Sources assemble in five fixed
 * priority tiers; the tier of a source is its role for the task being
 * compiled, never a property of the node itself, so callers assign it
 * explicitly. This module is the lowest level of the context package and
 * also carries the shared error type — budget, compression, freshness and
 * the compiler all build on it.
 */
export const CONTEXT_ERROR_KINDS = ["invalid_source", "invalid_budget", "invalid_record"] as const;

export type ContextErrorKind = (typeof CONTEXT_ERROR_KINDS)[number];

export class ContextError extends Error {
  readonly kind: ContextErrorKind;

  constructor(kind: ContextErrorKind, message: string) {
    super(message);
    this.name = "ContextError";
    this.kind = kind;
  }
}

export const SOURCE_TIERS = [1, 2, 3, 4, 5] as const;

export type SourceTier = (typeof SOURCE_TIERS)[number];

export const KNOWLEDGE_LAYERS = ["L1", "L2", "L3", "L4", "L5"] as const;

export type KnowledgeLayer = (typeof KNOWLEDGE_LAYERS)[number];

/** Node types without a layer default (design 8.7) compile as "none". */
export type KnowledgeLayerTag = KnowledgeLayer | "none";

const LAYER_BY_TYPE: Readonly<Partial<Record<NodeRecord["type"], KnowledgeLayer>>> = {
  Constraint: "L1",
  Policy: "L1",
  Decision: "L2",
  Component: "L2",
  ToolDefinition: "L3",
  Gate: "L3",
  CodeArtifact: "L4",
  Test: "L4",
  Finding: "L5",
  Evidence: "L5",
  RootCauseAnalysis: "L5",
  ImprovementCandidate: "L5",
};

/** Knowledge layer default for a node type (design 8.7). */
export function knowledgeLayerFor(type: NodeRecord["type"]): KnowledgeLayerTag {
  return LAYER_BY_TYPE[type] ?? "none";
}

/** One deterministically selected graph neighbor and why it was selected. */
export interface NeighborhoodSelection {
  readonly nodeId: string;
  readonly reason: string;
  readonly depth: number;
}

export const DEFAULT_NEIGHBORHOOD_DEPTH = 1;
export const MAX_NEIGHBORHOOD_DEPTH = 3;

/**
 * Deterministic graph neighborhood selection for a task (design 13.4 tier
 * 3). Seeds are the task's expected outputs and the endpoints of every edge
 * referenced by its approved impact paths; breadth-first expansion then
 * follows edges in both directions. Iteration order is fully sorted (seeds
 * by id, frontier edges by id), so the same graph always yields the same
 * selection with the same reasons.
 */
export function selectTaskNeighborhood(
  task: TaskSpecification,
  nodes: readonly NodeRecord[],
  edges: readonly EdgeRecord[],
  maxDepth: number = DEFAULT_NEIGHBORHOOD_DEPTH,
): readonly NeighborhoodSelection[] {
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > MAX_NEIGHBORHOOD_DEPTH) {
    throw new ContextError(
      "invalid_source",
      `neighborhood depth must be an integer between 0 and ${MAX_NEIGHBORHOOD_DEPTH}`,
    );
  }
  const knownNodeIds = new Set(nodes.map((node) => node.id));
  const edgeById = new Map(edges.map((edge) => [edge.id, edge]));

  const reasons = new Map<string, string>();
  for (const output of task.expected_outputs) {
    if (knownNodeIds.has(output) && !reasons.has(output)) {
      reasons.set(output, "expected task output");
    }
  }
  for (const path of task.impact_paths) {
    for (const edgeId of path) {
      const edge = edgeById.get(edgeId);
      if (edge === undefined) continue;
      for (const endpoint of [edge.source_id, edge.target_id]) {
        if (knownNodeIds.has(endpoint) && !reasons.has(endpoint)) {
          reasons.set(endpoint, `approved impact path endpoint of ${edgeId}`);
        }
      }
    }
  }

  const selections = new Map<string, NeighborhoodSelection>();
  let frontier = [...reasons.keys()].sort();
  for (const nodeId of frontier) {
    const reason = reasons.get(nodeId);
    if (reason === undefined) continue;
    selections.set(nodeId, { nodeId, reason, depth: 0 });
  }

  const sortedEdges = [...edges].sort((left, right) => left.id.localeCompare(right.id));
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
    const next = new Map<string, string>();
    for (const fromId of frontier) {
      for (const edge of sortedEdges) {
        const neighbors: readonly string[] =
          edge.source_id === fromId
            ? [edge.target_id]
            : edge.target_id === fromId
              ? [edge.source_id]
              : [];
        for (const neighborId of neighbors) {
          if (!knownNodeIds.has(neighborId) || selections.has(neighborId) || next.has(neighborId)) {
            continue;
          }
          next.set(neighborId, `neighbor of ${fromId} via ${edge.id} (${edge.type})`);
        }
      }
    }
    const nextFrontier = [...next.keys()].sort();
    for (const nodeId of nextFrontier) {
      const reason = next.get(nodeId);
      if (reason === undefined) continue;
      selections.set(nodeId, { nodeId, reason, depth });
    }
    frontier = nextFrontier;
  }

  return [...selections.values()].sort((left, right) => left.nodeId.localeCompare(right.nodeId));
}
