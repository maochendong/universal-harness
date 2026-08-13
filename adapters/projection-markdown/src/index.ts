import { contentDigest, type EdgeRecord, type NodeRecord } from "@universal-harness-internal/core";
import type {
  ProjectionDocument,
  ProjectionGraph,
  ProjectionSource,
} from "@universal-harness-internal/plugin-sdk";

/**
 * Markdown projection adapter (design 13.7, plan Task 22). Markdown is a
 * human-readable projection of the authoritative graph, never a store: every
 * view is a pure function of node and edge records, carries its source node
 * ids with revisions plus a generation digest, and regenerates byte-identical
 * output from the same ledger state.
 *
 * The contract types (`ProjectionGraph`, `ProjectionSource`,
 * `ProjectionDocument`) live in the Plugin SDK since Task 24 and are
 * re-exported here, so every projection provider shares one definition.
 *
 * Extension keys are duplicated here on purpose: the adapter depends on core
 * and plugin-sdk only, so the runtime-owned extension key strings are stated
 * as local constants instead of imported across the dependency boundary.
 */
export const REQUIREMENTS_EXTENSION_KEY = "harness.requirements";
export const PLAN_EXTENSION_KEY = "harness.plan";

export type { ProjectionDocument, ProjectionGraph, ProjectionSource };

function byId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Current revision per node id: the highest revision wins, tombstoned
 * revisions remove the node from the projection entirely.
 */
export function currentNodeMap(graph: ProjectionGraph): ReadonlyMap<string, NodeRecord> {
  const latest = new Map<string, NodeRecord>();
  for (const node of graph.nodes) {
    const existing = latest.get(node.id);
    if (existing === undefined || node.revision > existing.revision) latest.set(node.id, node);
  }
  const current = new Map<string, NodeRecord>();
  for (const [id, node] of latest) {
    if (node.status !== "tombstoned") current.set(id, node);
  }
  return current;
}

/** Edges that still carry graph semantics, in deterministic id order. */
export function activeEdges(graph: ProjectionGraph): readonly EdgeRecord[] {
  return graph.edges
    .filter((edge) => edge.status === "proposed" || edge.status === "accepted")
    .sort((left, right) => byId(left.id, right.id));
}

/** Active edges leaving `sourceId`, optionally of one relation type. */
export function edgesFrom(
  edges: readonly EdgeRecord[],
  sourceId: string,
  type?: EdgeRecord["type"],
): readonly EdgeRecord[] {
  return edges.filter(
    (edge) => edge.source_id === sourceId && (type === undefined || edge.type === type),
  );
}

/** Active edges arriving at `targetId`, optionally of one relation type. */
export function edgesTo(
  edges: readonly EdgeRecord[],
  targetId: string,
  type?: EdgeRecord["type"],
): readonly EdgeRecord[] {
  return edges.filter(
    (edge) => edge.target_id === targetId && (type === undefined || edge.type === type),
  );
}

/** Nodes of one type with a current revision, sorted by id. */
export function nodesOfType(
  nodes: ReadonlyMap<string, NodeRecord>,
  type: NodeRecord["type"],
): readonly NodeRecord[] {
  return [...nodes.values()].filter((node) => node.type === type).sort(byNodeId);
}

function byNodeId(left: NodeRecord, right: NodeRecord): number {
  return byId(left.id, right.id);
}

/** Read a string field of a node extension, or undefined when absent. */
export function extensionText(
  node: NodeRecord,
  extensionKey: string,
  field: string,
): string | undefined {
  const extension = node.extensions?.[extensionKey];
  if (typeof extension !== "object" || extension === null) return undefined;
  const value = (extension as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

/** Read a list-of-objects field of a node extension, or an empty list. */
export function extensionEntries(
  node: NodeRecord,
  extensionKey: string,
  field: string,
): readonly Record<string, unknown>[] {
  const extension = node.extensions?.[extensionKey];
  if (typeof extension !== "object" || extension === null) return [];
  const value = (extension as Record<string, unknown>)[field];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
  );
}

/**
 * Assemble a projection document: the generation digest binds the view name,
 * the exact source id/revision set and the body, so any upstream revision
 * change produces a new digest and drift detection can prove staleness.
 */
export function buildProjectionDocument(
  view: string,
  sources: readonly { readonly id: string; readonly revision: number }[],
  bodyLines: readonly string[],
): ProjectionDocument {
  const deduped = new Map<string, number>();
  for (const source of sources) {
    const existing = deduped.get(source.id);
    if (existing === undefined || source.revision > existing)
      deduped.set(source.id, source.revision);
  }
  const orderedSources = [...deduped.entries()]
    .map(([id, revision]) => ({ id, revision }))
    .sort((left, right) => byId(left.id, right.id));
  const body = bodyLines.join("\n");
  const generationDigest = contentDigest({ view, sources: orderedSources, body });
  const header = [
    "<!-- harness:projection",
    `view: ${view}`,
    `generation_digest: ${generationDigest}`,
    "sources:",
    ...orderedSources.map((source) => `- ${source.id} r${source.revision}`),
    "-->",
  ];
  return {
    view,
    sources: orderedSources,
    generation_digest: generationDigest,
    markdown: `${[...header, "", body].join("\n")}\n`,
  };
}

export { renderPrdProjection } from "./prd.js";
export { renderArchitectureProjection } from "./architecture.js";
export { renderSpecificationProjection } from "./spec.js";
export { renderPlanProjection } from "./plan.js";
export { renderSnapshotProjection, type SnapshotViewInput } from "./snapshot.js";

export const workspacePackageName =
  "@universal-harness-internal/adapter-projection-markdown" as const;
