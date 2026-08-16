import type { DatabaseSync } from "node:sqlite";

import type { EdgeRecord, LifecycleEvent, NodeRecord } from "@universal-harness-internal/core";

import {
  getEdge,
  getNode,
  neighborhood,
  pageEdges,
  pageEvents,
  pageNodes,
  shortestPath,
  type EdgeQuery,
  type EventQuery,
  type GraphPath,
  type GraphView,
  type Neighborhood,
  type NodeQuery,
  type Page,
  type TraversalOptions,
} from "./query-port.js";
import { createArtifactGraphView } from "./views/artifact-graph.js";
import { createExecutionGraphView } from "./views/execution-graph.js";
import { createEvaluationReadPort, type EvaluationReadPort } from "./evaluation-read-port.js";

export interface GraphQueryPort {
  getNode(nodeId: string): NodeRecord | undefined;
  getEdge(edgeId: string): EdgeRecord | undefined;
  pageNodes(query?: NodeQuery): Page<NodeRecord>;
  pageEdges(query?: EdgeQuery): Page<EdgeRecord>;
  pageEvents(query?: EventQuery): Page<LifecycleEvent>;
  neighborhood(rootId: string, options?: TraversalOptions): Neighborhood;
  shortestPath(
    sourceId: string,
    targetId: string,
    options?: TraversalOptions,
  ): GraphPath | undefined;
}

export interface GraphReadPorts {
  readonly graph: GraphQueryPort;
  readonly artifact: GraphView;
  readonly execution: GraphView;
  readonly evaluation: EvaluationReadPort;
}

export function createGraphQueryPort(database: DatabaseSync): GraphQueryPort {
  return {
    getNode: (nodeId) => getNode(database, nodeId),
    getEdge: (edgeId) => getEdge(database, edgeId),
    pageNodes: (query) => pageNodes(database, query),
    pageEdges: (query) => pageEdges(database, query),
    pageEvents: (query) => pageEvents(database, query),
    neighborhood: (rootId, options) => neighborhood(database, rootId, options),
    shortestPath: (sourceId, targetId, options) =>
      shortestPath(database, sourceId, targetId, options),
  };
}

export function createGraphReadPorts(database: DatabaseSync): GraphReadPorts {
  return {
    graph: createGraphQueryPort(database),
    artifact: createArtifactGraphView(database),
    execution: createExecutionGraphView(database),
    evaluation: createEvaluationReadPort(database),
  };
}
