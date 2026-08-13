import {
  GRAPH_DATABASE_RELATIVE_PATH,
  harnessRootFor,
  readCommittedOperations,
  readManagedManifest,
  resolveHarnessPath,
  type EdgeRecord,
  type NodeRecord,
} from "@universal-harness-internal/core";
import {
  checkGraphCache,
  materializeLedger,
  pageEdges,
  pageNodes,
  type GraphCacheStatus,
} from "@universal-harness-internal/graph";

import type { ControlLevel } from "../policy/action.js";
import { latestValidCheckpoint } from "../workflow/checkpoint.js";
import type { BudgetUse } from "../workflow/working-state.js";

/**
 * Project status (design 11.2 `harness status`, plan Task 22). The report is
 * derived from authoritative state only -- ledger manifests, the materialized
 * graph and the latest valid checkpoint -- never from agent claims. The
 * derivation is pure (`deriveProjectStatus`); the collector is the single
 * place that reads disk.
 */
export interface ProjectStatus {
  readonly project_root: string;
  readonly name: string;
  readonly repository_id: string;
  readonly committed_operations: number;
  readonly last_ledger_operation: string;
  readonly graph_cache: GraphCacheStatus;
  readonly iteration?: { readonly id: string; readonly state: string };
  readonly control_level: ControlLevel | "none";
  readonly evaluation_coverage: { readonly evaluated: number; readonly total: number };
  readonly blockers: readonly string[];
  readonly stale_evidence: readonly string[];
  readonly pending_approvals: readonly string[];
  readonly budget?: BudgetUse;
  readonly next_action: string;
}

/** Pure derivation input: current graph state plus optional checkpoint state. */
export interface StatusDerivationInput {
  readonly nodes: readonly NodeRecord[];
  readonly edges: readonly EdgeRecord[];
  readonly workingState?: {
    readonly blockers: readonly string[];
    readonly budget: BudgetUse;
    readonly next_action?: string;
  };
}

export interface DerivedStatus {
  readonly iteration?: { readonly id: string; readonly state: string };
  readonly evaluation_coverage: { readonly evaluated: number; readonly total: number };
  readonly blockers: readonly string[];
  readonly stale_evidence: readonly string[];
  readonly pending_approvals: readonly string[];
  readonly budget?: BudgetUse;
  readonly next_action: string;
}

function byId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function currentNodes(nodes: readonly NodeRecord[]): NodeRecord[] {
  const latest = new Map<string, NodeRecord>();
  for (const node of nodes) {
    const existing = latest.get(node.id);
    if (existing === undefined || node.revision > existing.revision) latest.set(node.id, node);
  }
  return [...latest.values()]
    .filter((node) => node.status !== "tombstoned")
    .sort((left, right) => byId(left.id, right.id));
}

function isActive(edge: EdgeRecord): boolean {
  return edge.status === "proposed" || edge.status === "accepted";
}

function latestIteration(nodes: readonly NodeRecord[]): NodeRecord | undefined {
  const iterations = nodes.filter((node) => node.type === "Iteration");
  if (iterations.length === 0) return undefined;
  const open = iterations.filter(
    (node) => node.iteration_state !== "completed" && node.iteration_state !== "aborted",
  );
  // Deterministic pick: open iterations first, then the highest id.
  return (open.length > 0 ? open : iterations).at(-1);
}

function derivePendingApprovals(
  nodes: readonly NodeRecord[],
  edges: readonly EdgeRecord[],
): string[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const resolved = new Set(
    edges.filter((edge) => edge.type === "RESOLVES").map((edge) => edge.target_id),
  );
  return nodes
    .filter(
      (node) =>
        node.type === "ApprovalRequest" &&
        node.status === "proposed" &&
        !resolved.has(node.id) &&
        nodeById.has(node.id),
    )
    .map((node) => node.id);
}

function deriveBlockers(
  nodes: readonly NodeRecord[],
  edges: readonly EdgeRecord[],
  iterationId: string | undefined,
  workingStateBlockers: readonly string[],
): string[] {
  const blockers = new Set(workingStateBlockers);
  if (iterationId !== undefined) {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    for (const edge of edges) {
      if (edge.type !== "BLOCKS" || edge.target_id !== iterationId) continue;
      const finding = nodeById.get(edge.source_id);
      if (finding === undefined) continue;
      if (finding.status === "proposed" || finding.status === "accepted") {
        blockers.add(`blocking finding ${finding.id}`);
      }
    }
  }
  return [...blockers].sort(byId);
}

function deriveStaleEvidence(nodes: readonly NodeRecord[], edges: readonly EdgeRecord[]): string[] {
  const stale = new Set<string>();
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const edge of edges) {
    if (edge.type !== "SUPPORTS" && edge.type !== "REFUTES") continue;
    const evidence = nodeById.get(edge.source_id);
    if (evidence === undefined || evidence.type !== "Evidence") continue;
    if (evidence.status === "superseded") stale.add(evidence.id);
  }
  return [...stale].sort(byId);
}

function deriveEvaluationCoverage(
  nodes: readonly NodeRecord[],
  edges: readonly EdgeRecord[],
): { readonly evaluated: number; readonly total: number } {
  const evaluatedSubjects = new Set(
    edges
      .filter(
        (edge) =>
          edge.type === "EVALUATES" &&
          nodes.some((node) => node.id === edge.source_id && node.status === "accepted"),
      )
      .map((edge) => edge.target_id),
  );
  const runs = nodes.filter((node) => node.type === "Run");
  return {
    evaluated: runs.filter((run) => evaluatedSubjects.has(run.id)).length,
    total: runs.length,
  };
}

function nextActionFor(status: {
  readonly iteration?: { readonly id: string; readonly state: string };
  readonly blockers: readonly string[];
  readonly staleEvidence: readonly string[];
  readonly pendingApprovals: readonly string[];
  readonly workingStateNextAction?: string;
}): string {
  if (status.pendingApprovals.length > 0) {
    return `resolve approval request ${status.pendingApprovals[0]}`;
  }
  if (status.blockers.length > 0) {
    return `repair blocker: ${status.blockers[0]}`;
  }
  if (status.staleEvidence.length > 0) {
    return `re-run gates; stale evidence ${status.staleEvidence[0]} no longer reflects current state`;
  }
  if (status.iteration === undefined) return "record an intent with harness new or harness adopt";
  switch (status.iteration.state) {
    case "draft":
    case "planned":
      return `run iteration ${status.iteration.id}`;
    case "running":
    case "verifying":
      return status.workingStateNextAction ?? `continue iteration ${status.iteration.id}`;
    case "blocked":
      return `resume iteration ${status.iteration.id} from its last checkpoint`;
    case "completed":
    case "aborted":
      return "start the next iteration with harness iterate";
    default:
      return `continue iteration ${status.iteration.id}`;
  }
}

/**
 * Derive status facets from graph state. Blockers, stale evidence, pending
 * approvals and evaluation coverage all come from edges and node statuses, so
 * the report cannot be talked into looking healthier than the ledger is.
 */
export function deriveProjectStatus(input: StatusDerivationInput): DerivedStatus {
  const nodes = currentNodes(input.nodes);
  const edges = input.edges.filter(isActive);
  const iteration = latestIteration(nodes);
  const pendingApprovals = derivePendingApprovals(nodes, edges);
  const blockers = deriveBlockers(nodes, edges, iteration?.id, input.workingState?.blockers ?? []);
  const staleEvidence = deriveStaleEvidence(nodes, edges);
  const coverage = deriveEvaluationCoverage(nodes, edges);
  const nextAction = nextActionFor({
    ...(iteration === undefined
      ? {}
      : { iteration: { id: iteration.id, state: iteration.iteration_state ?? "draft" } }),
    blockers,
    staleEvidence,
    pendingApprovals,
    ...(input.workingState?.next_action === undefined
      ? {}
      : { workingStateNextAction: input.workingState.next_action }),
  });
  return {
    ...(iteration === undefined
      ? {}
      : { iteration: { id: iteration.id, state: iteration.iteration_state ?? "draft" } }),
    evaluation_coverage: coverage,
    blockers,
    stale_evidence: staleEvidence,
    pending_approvals: pendingApprovals,
    ...(input.workingState === undefined ? {} : { budget: input.workingState.budget }),
    next_action: nextAction,
  };
}

/**
 * Assemble the full status report for a managed project: identity and ledger
 * size from core, cache health from the graph package, and everything else
 * derived from an ephemeral in-memory materialization (the cache on disk is
 * diagnosed, never trusted as the source of the report).
 */
export function collectProjectStatus(projectRoot: string): ProjectStatus {
  const manifest = readManagedManifest(projectRoot);
  const harnessRoot = harnessRootFor(projectRoot);
  const operations = readCommittedOperations(harnessRoot);
  const cache = checkGraphCache(resolveHarnessPath(harnessRoot, GRAPH_DATABASE_RELATIVE_PATH));
  const { database } = materializeLedger({ projectRoot, databasePath: ":memory:" });
  try {
    const nodes: NodeRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = pageNodes(database, {
        limit: 500,
        ...(cursor === undefined ? {} : { cursor }),
      });
      nodes.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    const edgeRows: EdgeRecord[] = [];
    let edgeCursor: string | undefined;
    do {
      const page = pageEdges(database, {
        limit: 500,
        ...(edgeCursor === undefined ? {} : { cursor: edgeCursor }),
      });
      edgeRows.push(...page.items);
      edgeCursor = page.nextCursor;
    } while (edgeCursor !== undefined);
    const edges = edgeRows;
    const lastOperation = operations.at(-1);
    const checkpoint =
      lastOperation === undefined
        ? undefined
        : latestValidCheckpoint(
            harnessRoot,
            operations,
            lastOperation.manifest.workflow_operation_id,
          );
    const derived = deriveProjectStatus({
      nodes,
      edges,
      ...(checkpoint === undefined
        ? {}
        : {
            workingState: {
              blockers: checkpoint.workingState.blockers,
              budget: checkpoint.workingState.budget,
              ...(checkpoint.workingState.next_action === undefined
                ? {}
                : { next_action: checkpoint.workingState.next_action }),
            },
          }),
    });
    return {
      project_root: projectRoot,
      name: manifest.name,
      repository_id: manifest.repository_id,
      committed_operations: operations.length,
      last_ledger_operation: lastOperation?.manifest.ledger_operation_id ?? "none",
      graph_cache: cache.status,
      ...derived,
      control_level: "none",
    };
  } finally {
    database.close();
  }
}
