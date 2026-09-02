import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  GRAPH_DATABASE_RELATIVE_PATH,
  harnessRootFor,
  readCommittedOperations,
  resolveHarnessPath,
  type EdgeRecord,
  type ModelInvocationRecord,
  type NodeRecord,
} from "@universal-harness-internal/core";
import {
  GraphQueryError,
  checkGraphCache,
  createGraphReadPorts,
  type EdgeQuery,
  type GraphReadPorts,
  type NodeQuery,
  type TraversalOptions,
} from "@universal-harness-internal/graph";
import {
  collectProjectStatus,
  latestModelInvocation,
  projectFindingGroups,
  readModelInvocationRecords,
  readPendingApprovalRequests,
  type ApprovalRequestRecord,
} from "@universal-harness-internal/runtime";

import { DashboardProblem } from "./problem.js";
import { readLocalConnection } from "./collaboration-api.js";
import {
  presentEdge,
  presentApproval,
  presentFindingGroup,
  presentModelInvocation,
  presentNode,
  presentSemanticProposal,
  presentationMap,
  type BusinessPresentation,
  type PresentationMap,
} from "./presentation.js";

export interface DashboardPage<T> {
  readonly items: readonly T[];
  readonly next_cursor?: string;
  readonly presentations: PresentationMap;
}

export interface DashboardReadApi {
  project(): unknown;
  nodes(
    query: NodeQuery & { readonly view?: "all" | "artifact" | "execution" },
  ): DashboardPage<NodeRecord>;
  edges(
    query: EdgeQuery & { readonly view?: "all" | "artifact" | "execution" },
  ): DashboardPage<EdgeRecord>;
  neighborhood(nodeId: string, options?: TraversalOptions): unknown;
  path(sourceId: string, targetId: string, options?: TraversalOptions): unknown;
  iteration(iterationId: string): unknown;
  evidence(
    query: Pick<NodeQuery, "cursor" | "limit" | "status" | "iterationId">,
  ): DashboardPage<NodeRecord>;
  findingGroups(query: {
    readonly cursor?: string;
    readonly limit?: number;
  }): DashboardPage<unknown>;
  semanticProposals(query: {
    readonly cursor?: string;
    readonly limit?: number;
  }): DashboardPage<unknown>;
  approvals(query: {
    readonly cursor?: string;
    readonly limit?: number;
  }): DashboardPage<ApprovalRequestRecord>;
  /** PG-8: model invocation observability, latest revision per invocation. */
  modelInvocations(query: {
    readonly cursor?: string;
    readonly limit?: number;
  }): DashboardPage<ModelInvocationRecord>;
}

export interface DashboardReadApiOptions {
  /** Resolved afresh by the host; absent means no authoritative active Scheduler operation. */
  readonly schedulerOperationId?: () => string | undefined;
}

function page<T>(
  value: { readonly items: T[]; readonly nextCursor?: string },
  presentations: readonly BusinessPresentation[] = [],
): DashboardPage<T> {
  return {
    items: value.items,
    ...(value.nextCursor === undefined ? {} : { next_cursor: value.nextCursor }),
    presentations: presentationMap(presentations),
  };
}

function graphResponse<T extends { readonly nodes: NodeRecord[]; readonly edges: EdgeRecord[] }>(
  value: T,
): T & { readonly presentations: PresentationMap } {
  return {
    ...value,
    presentations: presentationMap([
      ...value.nodes.map((item) => presentNode(item)),
      ...value.edges.map((item) => presentEdge(item)),
    ]),
  };
}

function unavailable(detail: string): DashboardProblem {
  return new DashboardProblem(
    503,
    "graph_cache_unavailable",
    "Service Unavailable",
    `the graph cache is unavailable: ${detail}`,
  );
}

function mapQueryError(error: unknown): never {
  if (error instanceof GraphQueryError) {
    throw new DashboardProblem(400, "invalid_query", "Bad Request", error.message);
  }
  throw error;
}

export function createDashboardReadApi(
  projectRoot: string,
  options: DashboardReadApiOptions = {},
): DashboardReadApi {
  const semanticProposalDirectory = resolveHarnessPath(
    harnessRootFor(projectRoot),
    "artifacts/edge-proposals",
  );
  const databasePath = resolveHarnessPath(
    harnessRootFor(projectRoot),
    GRAPH_DATABASE_RELATIVE_PATH,
  );
  const fingerprint = (): string | undefined => {
    try {
      const stat = statSync(databasePath);
      return `${String(stat.dev)}:${String(stat.ino)}:${String(stat.size)}:${String(stat.mtimeMs)}`;
    } catch {
      return undefined;
    }
  };
  // The server validates the full projection before constructing this API.
  // Direct library users get the same validation here. Subsequent healthy
  // reads reuse that verdict until the SQLite file identity changes; a
  // changed/missing file is fully checked again before any row is served.
  let verifiedFingerprint =
    checkGraphCache(databasePath).status === "ok" ? fingerprint() : undefined;
  const withPorts = <T>(read: (ports: GraphReadPorts) => T): T => {
    const currentFingerprint = fingerprint();
    if (currentFingerprint === undefined || currentFingerprint !== verifiedFingerprint) {
      const check = checkGraphCache(databasePath);
      if (check.status !== "ok") throw unavailable(check.detail ?? check.status);
      verifiedFingerprint = fingerprint();
    }
    let database: DatabaseSync;
    try {
      database = new DatabaseSync(databasePath, { readOnly: true });
    } catch {
      throw unavailable("SQLite could not open the projection");
    }
    try {
      return read(createGraphReadPorts(database));
    } catch (error) {
      if (error instanceof DashboardProblem) throw error;
      if (error instanceof GraphQueryError) mapQueryError(error);
      throw unavailable("SQLite could not read a verified projection");
    } finally {
      database.close();
    }
  };
  const selected = (ports: GraphReadPorts, view: "all" | "artifact" | "execution" | undefined) =>
    view === "artifact" ? ports.artifact : view === "execution" ? ports.execution : ports.graph;

  return {
    project: () => {
      const status = collectProjectStatus(projectRoot);
      const schedulerOperationId = options.schedulerOperationId?.();
      // M3 (design §18.2): the local Ledger's connection fact rides along so
      // the Overview can render Connection Status without a second request.
      // Never-connected projects keep the exact pre-M3 payload (§19.3).
      const connection = readLocalConnection(projectRoot);
      return {
        ...status,
        ...(schedulerOperationId === undefined
          ? {}
          : { scheduler_operation_id: schedulerOperationId }),
        ...(connection === undefined
          ? {}
          : {
              collaboration: {
                authority: "project_ledger" as const,
                status: connection.status,
                connection_id: connection.connection_id,
                coordinator_origin: connection.coordinator_origin,
              },
            }),
      };
    },
    nodes: (query) =>
      withPorts((ports) => {
        const { view, ...pageQuery } = query;
        const result = selected(ports, view).pageNodes(pageQuery);
        return page(
          result,
          result.items.map((item) => presentNode(item)),
        );
      }),
    edges: (query) =>
      withPorts((ports) => {
        const { view, ...pageQuery } = query;
        const result = selected(ports, view).pageEdges(pageQuery);
        return page(
          result,
          result.items.map((item) => presentEdge(item)),
        );
      }),
    neighborhood: (nodeId, options) =>
      withPorts((ports) => {
        if (ports.graph.getNode(nodeId) === undefined) {
          throw new DashboardProblem(
            404,
            "node_not_found",
            "Not Found",
            `graph node ${nodeId} does not exist`,
          );
        }
        return graphResponse(ports.graph.neighborhood(nodeId, options));
      }),
    path: (sourceId, targetId, options) =>
      withPorts((ports) => {
        if (
          ports.graph.getNode(sourceId) === undefined ||
          ports.graph.getNode(targetId) === undefined
        ) {
          throw new DashboardProblem(
            404,
            "node_not_found",
            "Not Found",
            "one or both graph path endpoints do not exist",
          );
        }
        const result = ports.graph.shortestPath(sourceId, targetId, options);
        if (result === undefined) {
          throw new DashboardProblem(
            404,
            "path_not_found",
            "Not Found",
            `no graph path exists from ${sourceId} to ${targetId}`,
          );
        }
        return graphResponse(result);
      }),
    iteration: (iterationId) =>
      withPorts((ports) => {
        const iteration = ports.graph.getNode(iterationId);
        if (iteration?.type !== "Iteration") {
          throw new DashboardProblem(
            404,
            "iteration_not_found",
            "Not Found",
            `iteration ${iterationId} does not exist`,
          );
        }
        const graph = ports.graph.neighborhood(iterationId, { depth: 3, direction: "both" });
        const evaluations = ports.evaluation.page({ iterationId, limit: 500 }).items;
        return {
          iteration,
          graph,
          evaluations,
          presentations: presentationMap([
            presentNode(iteration),
            ...graph.nodes.map((item) => presentNode(item)),
            ...graph.edges.map((item) => presentEdge(item)),
            ...evaluations.map((item) =>
              presentNode({
                id: item.evidenceId,
                digest: item.evidenceDigest,
                type: "Evidence",
                status: item.status,
                summary: item.passed ? "评估已通过。" : "评估未通过。",
                extensions: {
                  "harness.evaluation": {
                    passed: item.passed,
                    freshness: item.fresh ? "fresh" : "stale",
                    provisional: item.provisional,
                  },
                },
              }),
            ),
          ]),
        };
      }),
    evidence: (query) =>
      withPorts((ports) => {
        const result = ports.graph.pageNodes({ ...query, type: "Evidence" });
        return page(
          result,
          result.items.map((item) => presentNode(item)),
        );
      }),
    findingGroups: (query) =>
      withPorts((ports) => {
        const findings: NodeRecord[] = [];
        let cursor: string | undefined;
        do {
          const findingsPage = ports.graph.pageNodes({
            type: "Finding",
            limit: 500,
            ...(cursor === undefined ? {} : { cursor }),
          });
          findings.push(...findingsPage.items);
          cursor = findingsPage.nextCursor;
        } while (cursor !== undefined);
        const limit = query.limit ?? 50;
        const groups = projectFindingGroups(findings).filter(
          (group) => query.cursor === undefined || group.group_id > query.cursor,
        );
        const items = groups.slice(0, limit);
        const last = items.at(-1);
        return {
          items,
          ...(groups.length > limit && last !== undefined ? { next_cursor: last.group_id } : {}),
          presentations: presentationMap(items.map((item) => presentFindingGroup(item))),
        };
      }),
    semanticProposals: (query) => {
      const limit = query.limit ?? 50;
      if (!existsSync(semanticProposalDirectory)) return { items: [], presentations: {} };
      const proposals = readdirSync(semanticProposalDirectory)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .flatMap((name) => {
          try {
            const value = JSON.parse(
              readFileSync(resolveHarnessPath(semanticProposalDirectory, name), "utf8"),
            ) as {
              edge?: { id?: string; source_id?: string; target_id?: string; confidence?: number };
              preview_digest?: string;
              suggestion?: { score?: { millionths?: number }; reason?: string };
            };
            if (
              value.edge?.id === undefined ||
              value.edge.source_id === undefined ||
              value.edge.target_id === undefined ||
              value.preview_digest === undefined ||
              value.suggestion?.score?.millionths === undefined
            ) {
              return [];
            }
            return [
              {
                edge_id: value.edge.id,
                source_node_id: value.edge.source_id,
                candidate_node_id: value.edge.target_id,
                score: value.suggestion.score.millionths,
                reason: value.suggestion.reason ?? "semantic feature overlap",
                preview_digest: value.preview_digest,
                approve_command: `harness graph approve-edge ${value.edge.id} --digest ${value.preview_digest}`,
              },
            ];
          } catch {
            return [];
          }
        })
        .filter((proposal) => query.cursor === undefined || proposal.edge_id > query.cursor);
      const items = proposals.slice(0, limit);
      const last = items.at(-1);
      return {
        items,
        ...(proposals.length > limit && last !== undefined ? { next_cursor: last.edge_id } : {}),
        presentations: presentationMap(items.map((item) => presentSemanticProposal(item))),
      };
    },
    approvals: (query) => {
      const limit = query.limit ?? 50;
      const approvals = readPendingApprovalRequests(
        harnessRootFor(projectRoot),
        readCommittedOperations(harnessRootFor(projectRoot)),
      );
      const start =
        query.cursor === undefined
          ? 0
          : Math.max(
              0,
              approvals.findIndex((approval) => approval.request_id === query.cursor) + 1,
            );
      const items = approvals.slice(start, start + limit);
      const last = items.at(-1);
      return {
        items,
        ...(start + items.length < approvals.length && last !== undefined
          ? { next_cursor: last.request_id }
          : {}),
        presentations: presentationMap(items.map((item) => presentApproval({ ...item }))),
      };
    },
    modelInvocations: (query) => {
      const limit = query.limit ?? 50;
      const records = readModelInvocationRecords(projectRoot);
      const latestByInvocation = new Map<string, ModelInvocationRecord>();
      for (const record of records) {
        latestByInvocation.set(
          record.invocation_id,
          latestModelInvocation(records, record.invocation_id) ?? record,
        );
      }
      const latest = [...latestByInvocation.values()].sort((left, right) =>
        left.invocation_id.localeCompare(right.invocation_id),
      );
      const start =
        query.cursor === undefined
          ? 0
          : Math.max(0, latest.findIndex((record) => record.invocation_id === query.cursor) + 1);
      const items = latest.slice(start, start + limit);
      const last = items.at(-1);
      return {
        items,
        ...(start + items.length < latest.length && last !== undefined
          ? { next_cursor: last.invocation_id }
          : {}),
        presentations: presentationMap(items.map((item) => presentModelInvocation({ ...item }))),
      };
    },
  };
}
