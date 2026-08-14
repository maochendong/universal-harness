import { existsSync, readFileSync } from "node:fs";

import {
  LedgerRepository,
  PROTOCOL_VERSION,
  canonicalizeJson,
  contentDigest,
  harnessRootFor,
  readCommittedOperations,
  resolveHarnessPath,
  ulid,
  validateSchema,
  type CommitHooks,
  type EdgeRecord,
  type LockTuning,
  type NodeRecord,
} from "@universal-harness-internal/core";
import {
  isRelationCompatible,
  materializeLedger,
  pageEdges,
  pageNodes,
} from "@universal-harness-internal/graph";

/**
 * Human-driven graph edits (design 8.5 mutation rules): a relation change a
 * human judges correct -- for example backfilling a Task -> Requirement
 * IMPLEMENTS edge the audit keeps flagging -- follows the same shape as an
 * adoption baseline: the proposal is staged with a content digest, and the
 * approval must bind that exact digest before anything lands in the ledger.
 * Nothing is ever edited in place; staging and approval are append-only
 * artifacts, the edge is a deterministic record.
 */
export const GRAPH_EDIT_ERROR_KINDS = [
  "unknown_node",
  "invalid_relation",
  "edge_exists",
  "proposal_not_found",
  "proposal_digest_mismatch",
  "no_ledger_operation",
] as const;

export type GraphEditErrorKind = (typeof GRAPH_EDIT_ERROR_KINDS)[number];

export class GraphEditError extends Error {
  readonly kind: GraphEditErrorKind;

  constructor(kind: GraphEditErrorKind, message: string) {
    super(message);
    this.name = "GraphEditError";
    this.kind = kind;
  }
}

export interface GraphEditDependencies {
  readonly projectRoot: string;
  readonly readBaseline: () => string;
  readonly now?: () => string;
  readonly hooks?: CommitHooks;
  readonly lock?: LockTuning;
}

export interface ProposedGraphEdge {
  readonly status: "staged" | "already_present";
  readonly edgeId: string;
  readonly previewDigest: string;
}

export interface ApprovedGraphEdge {
  readonly status: "committed" | "already_present";
  readonly edgeId: string;
}

function nowOf(deps: GraphEditDependencies): string {
  return (deps.now ?? (() => new Date().toISOString()))();
}

interface GraphState {
  readonly currentNodes: ReadonlyMap<string, NodeRecord>;
  readonly edges: readonly EdgeRecord[];
}

function readGraph(projectRoot: string): GraphState {
  const { database } = materializeLedger({ projectRoot, databasePath: ":memory:" });
  try {
    const nodes: NodeRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = pageNodes(database, { limit: 500, ...(cursor === undefined ? {} : { cursor }) });
      nodes.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    const edges: EdgeRecord[] = [];
    let edgeCursor: string | undefined;
    do {
      const page = pageEdges(database, {
        limit: 500,
        ...(edgeCursor === undefined ? {} : { cursor: edgeCursor }),
      });
      edges.push(...page.items);
      edgeCursor = page.nextCursor;
    } while (edgeCursor !== undefined);
    const latest = new Map<string, NodeRecord>();
    for (const node of nodes) {
      const current = latest.get(node.id);
      if (current === undefined || node.revision > current.revision) latest.set(node.id, node);
    }
    const currentNodes = new Map<string, NodeRecord>();
    for (const [id, node] of latest) {
      if (node.status !== "tombstoned") currentNodes.set(id, node);
    }
    return { currentNodes, edges };
  } finally {
    database.close();
  }
}

function isActive(edge: EdgeRecord): boolean {
  return edge.status === "proposed" || edge.status === "accepted";
}

/** Deterministic edge identity: content-derived from relation and endpoints. */
export function graphEdgeId(type: EdgeRecord["type"], sourceId: string, targetId: string): string {
  return `edge_${contentDigest({ type, source: sourceId, target: targetId }).slice(0, 16)}`;
}

function edgeArtifact(
  deps: GraphEditDependencies,
  input: {
    readonly type: EdgeRecord["type"];
    readonly sourceId: string;
    readonly targetId: string;
  },
  status: EdgeRecord["status"],
  actor: string,
  iterationId: string,
): EdgeRecord {
  const content: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "edge",
    id: graphEdgeId(input.type, input.sourceId, input.targetId),
    type: input.type,
    source_id: input.sourceId,
    target_id: input.targetId,
    status,
    source: "human",
    provenance: { iteration_id: iterationId, actor, timestamp: nowOf(deps) },
    confidence: 1,
  };
  const edge = { ...content, digest: contentDigest(content) };
  const validation = validateSchema("edge", edge);
  if (!validation.valid) {
    throw new GraphEditError(
      "invalid_relation",
      `invalid edge record: ${validation.errors.map((issue) => issue.message).join("; ")}`,
    );
  }
  return edge as unknown as EdgeRecord;
}

function latestOperationContext(deps: GraphEditDependencies): {
  readonly workflowOperationId: string;
  readonly attemptId: string;
} {
  const operations = readCommittedOperations(harnessRootFor(deps.projectRoot));
  const last = operations.at(-1);
  if (last === undefined) {
    throw new GraphEditError("no_ledger_operation", "no committed ledger operation");
  }
  return {
    workflowOperationId: last.manifest.workflow_operation_id,
    attemptId: last.manifest.attempt_id,
  };
}

async function commitEditArtifacts(
  deps: GraphEditDependencies,
  artifacts: readonly { readonly path: string; readonly content: string }[],
  edges: readonly EdgeRecord[],
): Promise<void> {
  const context = latestOperationContext(deps);
  const repository = new LedgerRepository({
    projectRoot: deps.projectRoot,
    readBaseline: deps.readBaseline,
    now: () => nowOf(deps),
    ...(deps.hooks === undefined ? {} : { hooks: deps.hooks }),
    ...(deps.lock === undefined ? {} : { lock: deps.lock }),
  });
  await repository.commit({
    ledger_operation_id: `ledger_${ulid()}`,
    workflow_operation_id: context.workflowOperationId,
    attempt_id: context.attemptId,
    expected_baseline: deps.readBaseline(),
    artifacts,
    edges,
    events: [],
  });
}

interface EdgeProposalDocument {
  readonly record_kind: "edge_proposal";
  readonly edge: EdgeRecord;
  readonly preview_digest: string;
  readonly proposed_by: string;
  readonly created_at: string;
}

function proposalPath(edgeId: string): string {
  return `artifacts/edge-proposals/${edgeId}.json`;
}

function validateProposal(
  state: GraphState,
  input: {
    readonly type: EdgeRecord["type"];
    readonly sourceId: string;
    readonly targetId: string;
  },
): void {
  const source = state.currentNodes.get(input.sourceId);
  const target = state.currentNodes.get(input.targetId);
  if (source === undefined || target === undefined) {
    throw new GraphEditError(
      "unknown_node",
      `unknown edge endpoint(s): ${[input.sourceId, input.targetId]
        .filter((id) => state.currentNodes.get(id) === undefined)
        .join(", ")}`,
    );
  }
  if (!isRelationCompatible(input.type, source.type, target.type)) {
    throw new GraphEditError(
      "invalid_relation",
      `relation ${input.type} is not compatible with ${source.type} -> ${target.type}`,
    );
  }
}

/**
 * Stage one edge proposal. Idempotent: an already-active identical edge
 * reports `already_present` and re-staging the same edge reuses its digest.
 */
export async function proposeGraphEdge(
  deps: GraphEditDependencies,
  input: {
    readonly type: EdgeRecord["type"];
    readonly sourceId: string;
    readonly targetId: string;
    readonly actor: string;
  },
): Promise<ProposedGraphEdge> {
  const state = readGraph(deps.projectRoot);
  validateProposal(state, input);
  const edgeId = graphEdgeId(input.type, input.sourceId, input.targetId);
  const duplicate = state.edges.find(
    (edge) =>
      edge.type === input.type &&
      edge.source_id === input.sourceId &&
      edge.target_id === input.targetId &&
      isActive(edge),
  );
  if (duplicate !== undefined) {
    return { status: "already_present", edgeId: duplicate.id, previewDigest: duplicate.digest };
  }
  const path = proposalPath(edgeId);
  const absolute = resolveHarnessPath(harnessRootFor(deps.projectRoot), path);
  // Re-staging an identical proposal is a no-op: the committed bytes (and
  // their preview digest) win over a fresh timestamp, so two proposes of the
  // same edge always present the same approval target.
  if (existsSync(absolute)) {
    const staged = JSON.parse(readFileSync(absolute, "utf8")) as EdgeProposalDocument;
    if (
      staged.edge.id === edgeId &&
      staged.edge.type === input.type &&
      staged.edge.source_id === input.sourceId &&
      staged.edge.target_id === input.targetId
    ) {
      return { status: "staged", edgeId, previewDigest: staged.preview_digest };
    }
  }
  const iterationId =
    [...state.currentNodes.values()]
      .filter((node) => node.type === "Iteration")
      .sort((left, right) => (left.id < right.id ? -1 : 1))
      .at(-1)?.id ?? "iteration_graph-edit";
  const edge = edgeArtifact(deps, input, "proposed", input.actor, iterationId);
  const proposal: EdgeProposalDocument = {
    record_kind: "edge_proposal",
    edge,
    preview_digest: contentDigest(edge),
    proposed_by: input.actor,
    created_at: nowOf(deps),
  };
  await commitEditArtifacts(deps, [{ path, content: `${canonicalizeJson(proposal)}\n` }], []);
  return { status: "staged", edgeId, previewDigest: proposal.preview_digest };
}

/**
 * Commit a staged edge proposal. The approval must bind the exact preview
 * digest (tamper binding, same shape as the adoption baseline), and the
 * graph is re-validated at approval time -- the staged proposal may predate
 * graph changes.
 */
export async function approveGraphEdge(
  deps: GraphEditDependencies,
  input: {
    readonly edgeId: string;
    readonly previewDigest: string;
    readonly actor: string;
  },
): Promise<ApprovedGraphEdge> {
  const absolute = resolveHarnessPath(harnessRootFor(deps.projectRoot), proposalPath(input.edgeId));
  if (!existsSync(absolute)) {
    throw new GraphEditError("proposal_not_found", `unknown edge proposal: ${input.edgeId}`);
  }
  const proposal = JSON.parse(readFileSync(absolute, "utf8")) as EdgeProposalDocument;
  if (
    contentDigest(proposal.edge) !== proposal.preview_digest ||
    proposal.preview_digest !== input.previewDigest
  ) {
    throw new GraphEditError(
      "proposal_digest_mismatch",
      `approval digest ${input.previewDigest} does not bind the staged proposal ${input.edgeId}`,
    );
  }
  const state = readGraph(deps.projectRoot);
  validateProposal(state, {
    type: proposal.edge.type,
    sourceId: proposal.edge.source_id,
    targetId: proposal.edge.target_id,
  });
  const duplicate = state.edges.find((edge) => edge.id === input.edgeId && isActive(edge));
  if (duplicate !== undefined) return { status: "already_present", edgeId: input.edgeId };
  const iterationId = proposal.edge.provenance.iteration_id;
  const approved = edgeArtifact(
    deps,
    {
      type: proposal.edge.type,
      sourceId: proposal.edge.source_id,
      targetId: proposal.edge.target_id,
    },
    "accepted",
    input.actor,
    iterationId,
  );
  await commitEditArtifacts(deps, [], [approved]);
  return { status: "committed", edgeId: input.edgeId };
}
