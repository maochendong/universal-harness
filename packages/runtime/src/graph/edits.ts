import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  LedgerRepository,
  PROTOCOL_VERSION,
  canonicalizeJson,
  contentDigest,
  harnessRootFor,
  parseLocator,
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
  LocalSymbolSemanticSeedProvider,
  SEMANTIC_EXTRACTOR_VERSION,
  VERSIONABLE_NODE_TYPES,
} from "@universal-harness-internal/graph";
import type {
  SemanticIndexDescriptor,
  SemanticIndexInput,
  SemanticSeedProvider,
  SemanticSeedSuggestion,
} from "@universal-harness-internal/plugin-sdk";

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
  "endpoint_revision_drift",
  "semantic_index_drift",
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
  /** Optional provider injection for conformance and failure-path tests. */
  readonly semanticProvider?: SemanticSeedProvider;
  /** Digest of semantic extraction configuration beyond the fixed extractor version. */
  readonly semanticConfigDigest?: string;
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

export interface SemanticGraphEdgeProposal extends ProposedGraphEdge {
  readonly status: "staged";
  readonly score: number;
  readonly reason: string;
  readonly sourceNodeId: string;
  readonly candidateNodeId: string;
}

export interface SemanticGraphProposalBatch {
  readonly descriptor: SemanticIndexDescriptor;
  readonly proposals: readonly SemanticGraphEdgeProposal[];
}

function nowOf(deps: GraphEditDependencies): string {
  return (deps.now ?? (() => new Date().toISOString()))();
}

function byText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
  options: {
    readonly source?: EdgeRecord["source"];
    readonly confidence?: number;
    readonly extensions?: Readonly<Record<string, unknown>>;
  } = {},
): EdgeRecord {
  const content: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "edge",
    id: graphEdgeId(input.type, input.sourceId, input.targetId),
    type: input.type,
    source_id: input.sourceId,
    target_id: input.targetId,
    status,
    source: options.source ?? "human",
    provenance: { iteration_id: iterationId, actor, timestamp: nowOf(deps) },
    confidence: options.confidence ?? 1,
    ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
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
  readonly suggestion?: SemanticSuggestionMetadata;
}

export interface SemanticSuggestionMetadata {
  readonly provider: string;
  readonly provider_version: string;
  readonly input_digest: string;
  readonly index_digest: string;
  readonly source_revision: number;
  readonly target_revision: number;
  readonly score: SemanticSeedSuggestion["score"];
  readonly features: SemanticSeedSuggestion["features"];
  readonly reason: string;
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

const VERSIONABLE_TYPES = new Set<NodeRecord["type"]>(VERSIONABLE_NODE_TYPES);

function gitCommit(projectRoot: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unborn";
  }
}

function semanticDocument(
  projectRoot: string,
  node: NodeRecord,
): SemanticIndexInput["documents"][number] {
  let content = canonicalizeJson({
    id: node.id,
    type: node.type,
    extensions: node.extensions ?? {},
  });
  let blobDigest: string | undefined;
  if (node.locator !== undefined) {
    try {
      const parsed = parseLocator(node.locator);
      if (parsed.path !== undefined) {
        const absolute = join(projectRoot, parsed.path);
        if (existsSync(absolute)) {
          // Semantic indexing is advisory. Bound memory while retaining enough
          // source text for identifiers, imports and headings.
          content = readFileSync(absolute, "utf8").slice(0, 1024 * 1024);
          try {
            blobDigest = execFileSync("git", ["hash-object", "--", parsed.path], {
              cwd: projectRoot,
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
            }).trim();
          } catch {
            blobDigest = contentDigest(content);
          }
        }
      }
    } catch {
      // A malformed or non-repository locator cannot grant filesystem access.
      // The canonical node metadata remains a deterministic fallback document.
    }
  }
  return {
    node_id: node.id,
    node_type: node.type,
    revision: node.revision,
    ...(node.locator === undefined ? {} : { locator: node.locator }),
    source_digest: node.digest,
    ...(blobDigest === undefined ? {} : { blob_digest: blobDigest }),
    content,
  };
}

/** Build the complete digest-bound input for a rebuildable semantic index. */
function semanticIndexInput(deps: GraphEditDependencies, state: GraphState): SemanticIndexInput {
  const nodes = [...state.currentNodes.values()]
    .filter((node) => VERSIONABLE_TYPES.has(node.type))
    .sort((left, right) => byText(left.id, right.id));
  const graphSourceDigest = contentDigest(
    nodes.map((node) => ({
      id: node.id,
      type: node.type,
      revision: node.revision,
      digest: node.digest,
      ...(node.locator === undefined ? {} : { locator: node.locator }),
    })),
  );
  return {
    protocol_version: 1,
    project_id:
      [...state.currentNodes.values()]
        .filter((node) => node.type === "Project")
        .sort((left, right) => byText(left.id, right.id))
        .at(-1)?.id ?? "project_local",
    git_commit: gitCommit(deps.projectRoot),
    graph_source_digest: graphSourceDigest,
    extractor_version: SEMANTIC_EXTRACTOR_VERSION,
    config_digest: deps.semanticConfigDigest ?? contentDigest({ threshold: 350_000, top_k: 10 }),
    documents: nodes.map((node) => semanticDocument(deps.projectRoot, node)),
  };
}

export function buildSemanticIndexInput(deps: GraphEditDependencies): SemanticIndexInput {
  return semanticIndexInput(deps, readGraph(deps.projectRoot));
}

function semanticMetadata(suggestion: SemanticSeedSuggestion): SemanticSuggestionMetadata {
  return {
    provider: suggestion.provider,
    provider_version: suggestion.provider_version,
    input_digest: suggestion.input_digest,
    index_digest: suggestion.index_digest,
    source_revision: suggestion.source_revision,
    target_revision: suggestion.candidate_revision,
    score: suggestion.score,
    features: suggestion.features,
    reason: suggestion.reason,
  };
}

function proposalDigest(edge: EdgeRecord, suggestion?: SemanticSuggestionMetadata): string {
  return suggestion === undefined ? contentDigest(edge) : contentDigest({ edge, suggestion });
}

/**
 * Build semantic candidates and stage every proposal in one Ledger transaction.
 * No graph edge is submitted here; only explicit approval can activate one.
 */
export async function proposeSemanticImpactEdges(
  deps: GraphEditDependencies,
  input: {
    readonly sourceNodeIds: readonly string[];
    readonly actor: string;
    readonly thresholdMillionths?: number;
    readonly topK?: number;
  },
): Promise<SemanticGraphProposalBatch> {
  const state = readGraph(deps.projectRoot);
  for (const sourceNodeId of input.sourceNodeIds) {
    if (state.currentNodes.get(sourceNodeId) === undefined) {
      throw new GraphEditError("unknown_node", `unknown semantic source node: ${sourceNodeId}`);
    }
  }
  const provider = deps.semanticProvider ?? new LocalSymbolSemanticSeedProvider(deps.projectRoot);
  const descriptor = await provider.buildIndex(semanticIndexInput(deps, state));
  const suggestions = await provider.suggest({
    descriptor,
    source_node_ids: input.sourceNodeIds,
    threshold_millionths: input.thresholdMillionths ?? 350_000,
    top_k: input.topK ?? 10,
  });
  const iterationId =
    [...state.currentNodes.values()]
      .filter((node) => node.type === "Iteration")
      .sort((left, right) => byText(left.id, right.id))
      .at(-1)?.id ?? "iteration_graph-edit";
  const artifacts: { path: string; content: string }[] = [];
  const proposals: SemanticGraphEdgeProposal[] = [];
  for (const suggestion of suggestions) {
    const edgeInput = {
      type: "MAY_IMPACT" as const,
      sourceId: suggestion.source_node_id,
      targetId: suggestion.candidate_node_id,
    };
    validateProposal(state, edgeInput);
    if (
      state.edges.some(
        (edge) =>
          edge.type === edgeInput.type &&
          edge.source_id === edgeInput.sourceId &&
          edge.target_id === edgeInput.targetId &&
          isActive(edge),
      )
    ) {
      continue;
    }
    const edge = edgeArtifact(deps, edgeInput, "proposed", input.actor, iterationId, {
      source: "tool",
      confidence: suggestion.score.millionths / 1_000_000,
      extensions: {
        "harness.semantic": {
          provider: suggestion.provider,
          provider_version: suggestion.provider_version,
          input_digest: suggestion.input_digest,
          index_digest: suggestion.index_digest,
          features: suggestion.features,
        },
      },
    });
    const suggestionMetadata = semanticMetadata(suggestion);
    const path = proposalPath(edge.id);
    const absolute = resolveHarnessPath(harnessRootFor(deps.projectRoot), path);
    let proposal: EdgeProposalDocument | undefined;
    if (existsSync(absolute)) {
      try {
        const existing = JSON.parse(readFileSync(absolute, "utf8")) as EdgeProposalDocument;
        if (
          existing.edge.id === edge.id &&
          existing.suggestion !== undefined &&
          canonicalizeJson(existing.suggestion) === canonicalizeJson(suggestionMetadata) &&
          existing.preview_digest === proposalDigest(existing.edge, existing.suggestion)
        ) {
          proposal = existing;
        }
      } catch {
        // Replace invalid proposal bytes through the same atomic Ledger commit.
      }
    }
    if (proposal === undefined) {
      proposal = {
        record_kind: "edge_proposal",
        edge,
        preview_digest: proposalDigest(edge, suggestionMetadata),
        proposed_by: input.actor,
        created_at: nowOf(deps),
        suggestion: suggestionMetadata,
      };
      artifacts.push({ path, content: `${canonicalizeJson(proposal)}\n` });
    }
    proposals.push({
      status: "staged",
      edgeId: edge.id,
      previewDigest: proposal.preview_digest,
      score: suggestion.score.millionths,
      reason: suggestion.reason,
      sourceNodeId: suggestion.source_node_id,
      candidateNodeId: suggestion.candidate_node_id,
    });
  }
  if (artifacts.length > 0) await commitEditArtifacts(deps, artifacts, []);
  return { descriptor, proposals };
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
      staged.suggestion === undefined &&
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
    preview_digest: proposalDigest(edge),
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
    proposalDigest(proposal.edge, proposal.suggestion) !== proposal.preview_digest ||
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
  if (proposal.suggestion !== undefined) {
    const source = state.currentNodes.get(proposal.edge.source_id) as NodeRecord;
    const target = state.currentNodes.get(proposal.edge.target_id) as NodeRecord;
    if (
      source.revision !== proposal.suggestion.source_revision ||
      target.revision !== proposal.suggestion.target_revision
    ) {
      throw new GraphEditError(
        "endpoint_revision_drift",
        `semantic proposal ${input.edgeId} endpoint revision drifted; regenerate impact suggestions`,
      );
    }
    const provider = deps.semanticProvider ?? new LocalSymbolSemanticSeedProvider(deps.projectRoot);
    let descriptor: SemanticIndexDescriptor;
    try {
      descriptor = await provider.buildIndex(semanticIndexInput(deps, state));
    } catch (error) {
      throw new GraphEditError(
        "semantic_index_drift",
        `semantic proposal ${input.edgeId} cannot rebuild its index: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      descriptor.provider !== proposal.suggestion.provider ||
      descriptor.provider_version !== proposal.suggestion.provider_version ||
      descriptor.input_digest !== proposal.suggestion.input_digest ||
      descriptor.index_digest !== proposal.suggestion.index_digest
    ) {
      throw new GraphEditError(
        "semantic_index_drift",
        `semantic proposal ${input.edgeId} provider or index drifted; regenerate impact suggestions`,
      );
    }
  }
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
    {
      source: proposal.edge.source,
      confidence: proposal.edge.confidence,
      ...(proposal.edge.extensions === undefined ? {} : { extensions: proposal.edge.extensions }),
    },
  );
  await commitEditArtifacts(deps, [], [approved]);
  return { status: "committed", edgeId: input.edgeId };
}
