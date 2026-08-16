import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  GRAPH_DATABASE_RELATIVE_PATH,
  harnessRootFor,
  resolveHarnessPath,
  type EdgeRecord,
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
import { collectProjectStatus, projectFindingGroups } from "@universal-harness-internal/runtime";

import { DashboardProblem } from "./problem.js";

export interface DashboardPage<T> {
  readonly items: readonly T[];
  readonly next_cursor?: string;
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
}

function page<T>(value: { readonly items: T[]; readonly nextCursor?: string }): DashboardPage<T> {
  return {
    items: value.items,
    ...(value.nextCursor === undefined ? {} : { next_cursor: value.nextCursor }),
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

export function createDashboardReadApi(projectRoot: string): DashboardReadApi {
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
    project: () => collectProjectStatus(projectRoot),
    nodes: (query) =>
      withPorts((ports) => {
        const { view, ...pageQuery } = query;
        return page(selected(ports, view).pageNodes(pageQuery));
      }),
    edges: (query) =>
      withPorts((ports) => {
        const { view, ...pageQuery } = query;
        return page(selected(ports, view).pageEdges(pageQuery));
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
        return ports.graph.neighborhood(nodeId, options);
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
        return result;
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
        return {
          iteration,
          graph: ports.graph.neighborhood(iterationId, { depth: 3, direction: "both" }),
          evaluations: ports.evaluation.page({ iterationId, limit: 500 }).items,
        };
      }),
    evidence: (query) =>
      withPorts((ports) => page(ports.graph.pageNodes({ ...query, type: "Evidence" }))),
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
        };
      }),
    semanticProposals: (query) => {
      const limit = query.limit ?? 50;
      if (!existsSync(semanticProposalDirectory)) return { items: [] };
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
      };
    },
  };
}
