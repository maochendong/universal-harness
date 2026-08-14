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
import { readApprovalDecisions } from "../approval/request.js";
import { latestValidCheckpoint } from "../workflow/checkpoint.js";
import type { BudgetUse } from "../workflow/working-state.js";

/**
 * Project status (design 11.2 `harness status`, plan Task 22). The report is
 * derived from authoritative state only -- ledger manifests, the materialized
 * graph and the latest valid checkpoint -- never from agent claims. The
 * derivation is pure (`deriveProjectStatus`); the collector is the single
 * place that reads disk.
 */
export interface TaskProgress {
  readonly completed: number;
  readonly total: number;
  /** First unfinished task in dependency order, when any remains. */
  readonly next_task_id?: string;
}

export interface ProjectStatus {
  readonly project_root: string;
  readonly name: string;
  readonly repository_id: string;
  readonly committed_operations: number;
  readonly last_ledger_operation: string;
  readonly graph_cache: GraphCacheStatus;
  readonly iteration?: { readonly id: string; readonly state: string };
  readonly task_progress?: TaskProgress;
  readonly control_level: ControlLevel | "none";
  readonly evaluation_coverage: { readonly evaluated: number; readonly total: number };
  readonly blockers: readonly string[];
  /** Non-blocking findings the iteration should surface but not be held by. */
  readonly warnings: readonly string[];
  readonly stale_evidence: readonly string[];
  readonly pending_approvals: readonly string[];
  readonly budget?: BudgetUse;
  readonly next_action: string;
}

/** Pure derivation input: current graph state plus optional checkpoint state. */
export interface StatusDerivationInput {
  readonly nodes: readonly NodeRecord[];
  readonly edges: readonly EdgeRecord[];
  /**
   * Approval request ids with a terminal (approve/reject) decision, read
   * from ledger decision artifacts. Approval resolution is not materialized
   * as graph edges, so callers must supply it explicitly.
   */
  readonly resolvedApprovalIds?: readonly string[];
  readonly workingState?: {
    readonly blockers: readonly string[];
    readonly budget: BudgetUse;
    readonly next_action?: string;
  };
}

export interface DerivedStatus {
  readonly iteration?: { readonly id: string; readonly state: string };
  readonly task_progress?: TaskProgress;
  readonly evaluation_coverage: { readonly evaluated: number; readonly total: number };
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
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

/**
 * Working-state blocker strings created when an operation blocked on an
 * approval request (`approval request <id> awaiting a decision`). Once the
 * request is resolved the checkpoint's working state may still carry the
 * string, so status derivation must drop it instead of reporting a phantom
 * blocker next to an empty pending-approval list.
 */
const APPROVAL_BLOCKER_PATTERN = /^approval request (\S+) awaiting a decision$/;

/**
 * A Finding only holds its iteration when its bound subject says so. Gate and
 * cascade findings predate the flag, so a missing `harness.finding` extension
 * (or a missing flag) defaults to blocking; only an explicit
 * `blocking: false` -- the shape audit warnings carry -- demotes the finding
 * to a warning.
 */
function findingIsBlocking(node: NodeRecord): boolean {
  const extension = node.extensions?.["harness.finding"];
  if (typeof extension !== "object" || extension === null) return true;
  return (extension as Record<string, unknown>).blocking !== false;
}

function deriveBlockers(
  nodes: readonly NodeRecord[],
  edges: readonly EdgeRecord[],
  iterationId: string | undefined,
  workingStateBlockers: readonly string[],
  resolvedApprovalIds: ReadonlySet<string>,
): { readonly blockers: string[]; readonly warnings: string[] } {
  const liveWorkingStateBlockers = workingStateBlockers.filter((blocker) => {
    const match = APPROVAL_BLOCKER_PATTERN.exec(blocker);
    return match === null || !resolvedApprovalIds.has(match[1] ?? "");
  });
  const blockers = new Set(liveWorkingStateBlockers);
  const warnings = new Set<string>();
  if (iterationId !== undefined) {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    for (const edge of edges) {
      if (edge.type !== "BLOCKS" || edge.target_id !== iterationId) continue;
      const finding = nodeById.get(edge.source_id);
      if (finding === undefined) continue;
      if (finding.status === "proposed" || finding.status === "accepted") {
        if (findingIsBlocking(finding)) blockers.add(`blocking finding ${finding.id}`);
        else warnings.add(`warning finding ${finding.id}`);
      }
    }
  }
  return { blockers: [...blockers].sort(byId), warnings: [...warnings].sort(byId) };
}

/**
 * Open non-blocking findings are project-level warnings: they stay visible in
 * status until the finding is resolved, regardless of which iteration raised
 * them (a non-blocking finding carries no BLOCKS edge by definition).
 */
function deriveWarnings(nodes: readonly NodeRecord[]): string[] {
  return nodes
    .filter(
      (node) =>
        node.type === "Finding" &&
        (node.status === "proposed" || node.status === "accepted") &&
        !findingIsBlocking(node),
    )
    .map((node) => `warning finding ${node.id}`)
    .sort(byId);
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

/**
 * Task progress of the iteration's latest ExecutionPlan (card T2): tasks the
 * execute phase marked accepted over the total, plus the first unfinished
 * task in dependency order. Pure graph derivation -- the accepted revision
 * is the only completion signal status trusts.
 */
function deriveTaskProgress(
  nodes: readonly NodeRecord[],
  edges: readonly EdgeRecord[],
  iterationId: string | undefined,
): TaskProgress | undefined {
  if (iterationId === undefined) return undefined;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const plan = nodes
    .filter((node) => node.type === "ExecutionPlan" && node.provenance.iteration_id === iterationId)
    .sort((left, right) => byId(left.id, right.id))
    .at(-1);
  if (plan === undefined) return undefined;
  const taskIds = edges
    .filter((edge) => edge.type === "CONTAINS" && edge.source_id === plan.id)
    .map((edge) => edge.target_id)
    .filter((id) => nodeById.get(id)?.type === "Task");
  if (taskIds.length === 0) return undefined;
  const members = new Set(taskIds);
  const indegree = new Map<string, number>(taskIds.map((id) => [id, 0]));
  const dependents = new Map<string, string[]>();
  for (const edge of edges) {
    if (
      edge.type !== "DEPENDS_ON" ||
      !members.has(edge.source_id) ||
      !members.has(edge.target_id)
    ) {
      continue;
    }
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
  for (const id of taskIds.filter((id) => !ordered.includes(id)).sort(byId)) ordered.push(id);
  const completed = taskIds.filter((id) => nodeById.get(id)?.status === "accepted").length;
  const nextTaskId = ordered.find((id) => nodeById.get(id)?.status !== "accepted");
  return {
    completed,
    total: taskIds.length,
    ...(nextTaskId === undefined ? {} : { next_task_id: nextTaskId }),
  };
}

function nextActionFor(status: {
  readonly iteration?: { readonly id: string; readonly state: string };
  readonly taskProgress?: TaskProgress;
  readonly blockers: readonly string[];
  readonly staleEvidence: readonly string[];
  readonly pendingApprovals: readonly string[];
  readonly workingStateNextAction?: string;
}): string {
  if (status.pendingApprovals.length > 0) {
    return `resolve approval request ${status.pendingApprovals[0]}`;
  }
  const progress = status.taskProgress;
  const progressText =
    progress !== undefined && progress.completed < progress.total
      ? ` (task ${String(progress.completed)}/${String(progress.total)}${
          progress.next_task_id === undefined ? "" : `: ${progress.next_task_id}`
        })`
      : undefined;
  if (status.blockers.length > 0) {
    return `repair blocker: ${status.blockers[0]}${progressText ?? ""}`;
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
      return progressText !== undefined
        ? `continue iteration ${status.iteration.id}${progressText}`
        : (status.workingStateNextAction ?? `continue iteration ${status.iteration.id}`);
    case "blocked":
      return progressText !== undefined
        ? `resume iteration ${status.iteration.id}${progressText}`
        : `resume iteration ${status.iteration.id} from its last checkpoint`;
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
  const resolvedApprovalIds = new Set([
    ...edges.filter((edge) => edge.type === "RESOLVES").map((edge) => edge.target_id),
    ...(input.resolvedApprovalIds ?? []),
  ]);
  const { blockers, warnings } = deriveBlockers(
    nodes,
    edges,
    iteration?.id,
    input.workingState?.blockers ?? [],
    resolvedApprovalIds,
  );
  const allWarnings = [...new Set([...warnings, ...deriveWarnings(nodes)])].sort(byId);
  const staleEvidence = deriveStaleEvidence(nodes, edges);
  const coverage = deriveEvaluationCoverage(nodes, edges);
  const taskProgress = deriveTaskProgress(nodes, edges, iteration?.id);
  const nextAction = nextActionFor({
    ...(iteration === undefined
      ? {}
      : { iteration: { id: iteration.id, state: iteration.iteration_state ?? "draft" } }),
    ...(taskProgress === undefined ? {} : { taskProgress }),
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
    ...(taskProgress === undefined ? {} : { task_progress: taskProgress }),
    evaluation_coverage: coverage,
    blockers,
    warnings: allWarnings,
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
    const workflowOperationId = lastOperation?.manifest.workflow_operation_id;
    const checkpoint =
      lastOperation === undefined || workflowOperationId === undefined
        ? undefined
        : latestValidCheckpoint(harnessRoot, operations, workflowOperationId);
    // Approval resolution lives in decision artifacts, not in materialized
    // graph edges; without this, resolved requests linger as phantom blockers.
    // Decisions may be committed under a different workflow operation than the
    // latest one, so every operation's allowlist gets a chance to vouch.
    const workflowOperationIds = [
      ...new Set(operations.map((operation) => operation.manifest.workflow_operation_id)),
    ];
    const resolvedApprovalIds = workflowOperationIds.flatMap((operationId) =>
      readApprovalDecisions(harnessRoot, operations, operationId)
        .filter((decision) => decision.decision === "approve" || decision.decision === "reject")
        .map((decision) => decision.request_id),
    );
    const derived = deriveProjectStatus({
      nodes,
      edges,
      resolvedApprovalIds,
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
