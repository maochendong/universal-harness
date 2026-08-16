import type { EdgeRecord, NodeRecord } from "@universal-harness-internal/core";

import { ImpactError } from "./seeds.js";
import type { RiskLevel } from "./scoring.js";

/**
 * Relation-aware propagation (design section 9, step 2). Only the relation
 * types, directions and depths admitted by the active policy are traversed.
 * The rule table mirrors the core relation registry of design 8.3: each entry
 * fixes the propagation direction, the default risk and whether inferred
 * (proposed) edges of the relation may be followed at all.
 *
 * Direction is read from the changed node's perspective: `forward` follows
 * edges the current node sources, `inverse` follows edges that target it.
 * The design's failure chain (Evidence REFUTES Test, Test VERIFIES
 * Requirement, inverse ADDRESSES to the Decision, SHAPES the Component,
 * inverse REALIZES to the code) falls out of this table directly.
 */
export type PropagationDirection = "forward" | "inverse" | "both";

export interface PropagationRule {
  readonly type: EdgeRecord["type"];
  readonly direction: PropagationDirection;
  readonly defaultRisk: RiskLevel;
  /** Proposed inferred edges may be traversed, but only yield inspect candidates. */
  readonly allowsInference: boolean;
}

export const PROPAGATION_RULES: readonly PropagationRule[] = [
  { type: "REFUTES", direction: "forward", defaultRisk: "high", allowsInference: false },
  { type: "VIOLATES", direction: "forward", defaultRisk: "high", allowsInference: false },
  { type: "BLOCKS", direction: "forward", defaultRisk: "high", allowsInference: false },
  { type: "VERIFIES", direction: "both", defaultRisk: "medium", allowsInference: true },
  { type: "ADDRESSES", direction: "inverse", defaultRisk: "medium", allowsInference: true },
  { type: "SHAPES", direction: "forward", defaultRisk: "medium", allowsInference: true },
  { type: "REALIZES", direction: "inverse", defaultRisk: "high", allowsInference: true },
  { type: "IMPLEMENTS", direction: "inverse", defaultRisk: "medium", allowsInference: true },
  { type: "DECOMPOSES_TO", direction: "forward", defaultRisk: "medium", allowsInference: false },
  { type: "CONSTRAINED_BY", direction: "both", defaultRisk: "high", allowsInference: false },
  { type: "GOVERNED_BY", direction: "both", defaultRisk: "high", allowsInference: false },
  { type: "DEPENDS_ON", direction: "both", defaultRisk: "low", allowsInference: false },
  { type: "DERIVES_FROM", direction: "inverse", defaultRisk: "medium", allowsInference: false },
  { type: "SUPERSEDES", direction: "forward", defaultRisk: "low", allowsInference: false },
  { type: "DIAGNOSED_BY", direction: "forward", defaultRisk: "low", allowsInference: false },
  {
    type: "PROPOSES_CHANGE_TO",
    direction: "forward",
    defaultRisk: "medium",
    allowsInference: false,
  },
  { type: "MAY_IMPACT", direction: "forward", defaultRisk: "low", allowsInference: true },
];

export const DEFAULT_MAX_PROPAGATION_DEPTH = 6;
export const MAX_PROPAGATION_DEPTH = 10;

export interface PropagationPolicy {
  readonly rules: readonly PropagationRule[];
  readonly maxDepth: number;
}

export const DEFAULT_PROPAGATION_POLICY: PropagationPolicy = {
  rules: PROPAGATION_RULES,
  maxDepth: DEFAULT_MAX_PROPAGATION_DEPTH,
};

/** One hop of a shortest explanation path from the seed to a reached node. */
export interface ImpactPathStep {
  readonly edgeId: string;
  readonly relation: EdgeRecord["type"];
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly relationRisk: RiskLevel;
  /**
   * True when the edge is proposed or carries a sub-1.0 confidence. Accepted
   * inferred edges keep their original confidence (design 8.4), so they stay
   * inspect-grade even after acceptance.
   */
  readonly inferred: boolean;
  readonly confidence: number;
}

export interface PropagationReach {
  readonly nodeId: string;
  /** Shortest explanation path from the seed; empty for the seed node itself. */
  readonly path: readonly ImpactPathStep[];
}

interface TraversableEdge {
  readonly edge: EdgeRecord;
  readonly rule: PropagationRule;
  readonly peerId: string;
}

function traversableEdges(
  nodeId: string,
  edgesByEndpoint: ReadonlyMap<string, EdgeRecord[]>,
  rulesByType: ReadonlyMap<string, PropagationRule>,
): TraversableEdge[] {
  const results: TraversableEdge[] = [];
  for (const edge of edgesByEndpoint.get(nodeId) ?? []) {
    const rule = rulesByType.get(edge.type);
    if (rule === undefined) continue;
    if (edge.status === "rejected" || edge.status === "superseded") continue;
    if (edge.status === "proposed" && !rule.allowsInference) continue;
    const isSource = edge.source_id === nodeId;
    if (rule.direction === "forward" && !isSource) continue;
    if (rule.direction === "inverse" && isSource) continue;
    results.push({ edge, rule, peerId: isSource ? edge.target_id : edge.source_id });
  }
  results.sort((left, right) => (left.edge.id < right.edge.id ? -1 : 1));
  return results;
}

/**
 * Breadth-first propagation from the seed node. Frontier nodes and their
 * edges are expanded in id order, so the first path recorded for a node is
 * the deterministic shortest explanation path on every rebuild. Edges whose
 * endpoints are missing from the node set are ignored rather than failing:
 * integrity checking is the ledger's job, not the impact engine's.
 */
export function propagateImpact(
  seedNodeId: string,
  nodes: readonly NodeRecord[],
  edges: readonly EdgeRecord[],
  policy: PropagationPolicy = DEFAULT_PROPAGATION_POLICY,
): PropagationReach[] {
  if (
    !Number.isInteger(policy.maxDepth) ||
    policy.maxDepth < 1 ||
    policy.maxDepth > MAX_PROPAGATION_DEPTH
  ) {
    throw new ImpactError(`propagation depth must be an integer in 1..${MAX_PROPAGATION_DEPTH}`);
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (!nodeIds.has(seedNodeId)) {
    throw new ImpactError(`change seed references unknown node ${seedNodeId}`);
  }
  const rulesByType = new Map(policy.rules.map((rule) => [rule.type, rule]));
  const edgesByEndpoint = new Map<string, EdgeRecord[]>();
  for (const edge of edges) {
    if (!nodeIds.has(edge.source_id) || !nodeIds.has(edge.target_id)) continue;
    for (const endpoint of [edge.source_id, edge.target_id]) {
      const bucket = edgesByEndpoint.get(endpoint) ?? [];
      bucket.push(edge);
      edgesByEndpoint.set(endpoint, bucket);
    }
  }

  const reachByNode = new Map<string, PropagationReach>();
  reachByNode.set(seedNodeId, { nodeId: seedNodeId, path: [] });
  let frontier = [seedNodeId];
  for (let depth = 0; depth < policy.maxDepth && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const nodeId of [...frontier].sort()) {
      const parent = reachByNode.get(nodeId) as PropagationReach;
      for (const { edge, rule, peerId } of traversableEdges(nodeId, edgesByEndpoint, rulesByType)) {
        if (reachByNode.has(peerId)) continue;
        const step: ImpactPathStep = {
          edgeId: edge.id,
          relation: edge.type,
          fromNodeId: nodeId,
          toNodeId: peerId,
          relationRisk: rule.defaultRisk,
          inferred: edge.status === "proposed" || edge.confidence < 1,
          confidence: edge.confidence,
        };
        reachByNode.set(peerId, { nodeId: peerId, path: [...parent.path, step] });
        next.push(peerId);
      }
    }
    frontier = next;
  }
  return [...reachByNode.values()].sort((left, right) => (left.nodeId < right.nodeId ? -1 : 1));
}
