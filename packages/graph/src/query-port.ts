import type { EdgeRecord, LifecycleEvent, NodeRecord } from "@universal-harness-internal/core";
import type { DatabaseSync } from "node:sqlite";

/**
 * Versioned graph query port (design section 18 `GraphQueryPort`): paged
 * nodes, edges, events, neighborhood and path queries over the materialized
 * SQLite projection. Every result set has a deterministic total order, so
 * identical ledger input yields byte-identical pages after a rebuild.
 */
export type GraphViewName = "artifact" | "execution";

export type NodeType = NodeRecord["type"];
export type NodeStatus = NodeRecord["status"];
export type EdgeStatus = EdgeRecord["status"];

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 500;
export const DEFAULT_TRAVERSAL_DEPTH = 1;
export const MAX_TRAVERSAL_DEPTH = 10;

export interface Page<T> {
  readonly items: T[];
  /** Present exactly when more items follow; feed back as `cursor`. */
  readonly nextCursor?: string;
}

export interface NodeQuery {
  /** Restrict results to these node types (used for view scoping). */
  readonly types?: readonly NodeType[];
  readonly type?: NodeType;
  readonly status?: NodeStatus;
  readonly iterationId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface EdgeQuery {
  /** Restrict to edges whose endpoints both have one of these node types. */
  readonly nodeTypes?: readonly NodeType[];
  readonly type?: EdgeRecord["type"];
  readonly status?: EdgeStatus;
  readonly sourceId?: string;
  readonly targetId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface EventQuery {
  readonly iterationId?: string;
  readonly workflowOperationId?: string;
  readonly eventTypes?: readonly LifecycleEvent["event_type"][];
  readonly cursor?: string;
  readonly limit?: number;
}

export type TraversalDirection = "outgoing" | "incoming" | "both";

export interface TraversalOptions {
  readonly depth?: number;
  readonly direction?: TraversalDirection;
  /** Restrict traversal to edges whose endpoints are both in this type set. */
  readonly nodeTypes?: readonly NodeType[];
  readonly edgeStatuses?: readonly EdgeStatus[];
}

export interface Neighborhood {
  readonly rootId: string;
  readonly nodes: NodeRecord[];
  readonly edges: EdgeRecord[];
}

export interface GraphPath {
  readonly nodes: NodeRecord[];
  readonly edges: EdgeRecord[];
}

/** An edge crossing a view boundary, with the resolved peer on the far side. */
export interface ViewBridge {
  readonly edge: EdgeRecord;
  readonly peer: NodeRecord;
  /** "outgoing" means the bridged edge leaves the view member node. */
  readonly direction: "outgoing" | "incoming";
}

export interface GraphView {
  readonly name: GraphViewName;
  readonly nodeTypes: readonly NodeType[];
  containsNodeType(type: NodeType): boolean;
  isMember(nodeId: string): boolean;
  getNode(nodeId: string): NodeRecord | undefined;
  pageNodes(query?: NodeQuery): Page<NodeRecord>;
  pageEdges(query?: EdgeQuery): Page<EdgeRecord>;
  neighborhood(rootId: string, options?: TraversalOptions): Neighborhood;
  /** Edges incident to a member node whose far endpoint is outside the view. */
  bridges(nodeId: string): ViewBridge[];
}

export class GraphQueryError extends Error {
  readonly kind = "graph_query_error" as const;

  constructor(message: string) {
    super(message);
    this.name = "GraphQueryError";
  }
}

type SqlRow = Record<string, unknown>;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new GraphQueryError(`page limit must be an integer in 1..${MAX_PAGE_LIMIT}`);
  }
  return limit;
}

function clampDepth(depth: number | undefined): number {
  if (depth === undefined) return DEFAULT_TRAVERSAL_DEPTH;
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_TRAVERSAL_DEPTH) {
    throw new GraphQueryError(`traversal depth must be an integer in 1..${MAX_TRAVERSAL_DEPTH}`);
  }
  return depth;
}

function placeholders(count: number): string {
  return new Array(count).fill("?").join(", ");
}

function parseRecord<T>(row: SqlRow): T {
  return JSON.parse(String(row.record)) as T;
}

export function getNode(database: DatabaseSync, nodeId: string): NodeRecord | undefined {
  const row = database.prepare("SELECT record FROM nodes WHERE id = ?").get(nodeId);
  return row === undefined ? undefined : parseRecord<NodeRecord>(row as SqlRow);
}

export function getEdge(database: DatabaseSync, edgeId: string): EdgeRecord | undefined {
  const row = database.prepare("SELECT record FROM edges WHERE id = ?").get(edgeId);
  return row === undefined ? undefined : parseRecord<EdgeRecord>(row as SqlRow);
}

export function pageNodes(database: DatabaseSync, query: NodeQuery = {}): Page<NodeRecord> {
  const limit = clampLimit(query.limit);
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (query.types !== undefined) {
    conditions.push(`type IN (${placeholders(query.types.length)})`);
    params.push(...query.types);
  }
  if (query.type !== undefined) {
    conditions.push("type = ?");
    params.push(query.type);
  }
  if (query.status !== undefined) {
    conditions.push("status = ?");
    params.push(query.status);
  }
  if (query.iterationId !== undefined) {
    conditions.push("iteration_id = ?");
    params.push(query.iterationId);
  }
  if (query.cursor !== undefined) {
    conditions.push("id > ?");
    params.push(query.cursor);
  }
  const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
  const rows = database
    .prepare(`SELECT id, record FROM nodes ${where} ORDER BY id ASC LIMIT ?`)
    .all(...params, limit + 1) as unknown as SqlRow[];
  const pageRows = rows.slice(0, limit);
  const items = pageRows.map((row) => parseRecord<NodeRecord>(row));
  const last = pageRows[pageRows.length - 1];
  return {
    items,
    ...(rows.length > limit && last !== undefined ? { nextCursor: String(last.id) } : {}),
  };
}

export function pageEdges(database: DatabaseSync, query: EdgeQuery = {}): Page<EdgeRecord> {
  const limit = clampLimit(query.limit);
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (query.nodeTypes !== undefined) {
    const inList = placeholders(query.nodeTypes.length);
    conditions.push(
      `source_id IN (SELECT id FROM nodes WHERE type IN (${inList})) AND target_id IN (SELECT id FROM nodes WHERE type IN (${inList}))`,
    );
    params.push(...query.nodeTypes, ...query.nodeTypes);
  }
  if (query.type !== undefined) {
    conditions.push("type = ?");
    params.push(query.type);
  }
  if (query.status !== undefined) {
    conditions.push("status = ?");
    params.push(query.status);
  }
  if (query.sourceId !== undefined) {
    conditions.push("source_id = ?");
    params.push(query.sourceId);
  }
  if (query.targetId !== undefined) {
    conditions.push("target_id = ?");
    params.push(query.targetId);
  }
  if (query.cursor !== undefined) {
    conditions.push("id > ?");
    params.push(query.cursor);
  }
  const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
  const rows = database
    .prepare(`SELECT id, record FROM edges ${where} ORDER BY id ASC LIMIT ?`)
    .all(...params, limit + 1) as unknown as SqlRow[];
  const pageRows = rows.slice(0, limit);
  const items = pageRows.map((row) => parseRecord<EdgeRecord>(row));
  const last = pageRows[pageRows.length - 1];
  return {
    items,
    ...(rows.length > limit && last !== undefined ? { nextCursor: String(last.id) } : {}),
  };
}

function encodeEventCursor(row: SqlRow): string {
  return Buffer.from(
    JSON.stringify([Number(row.operation_sequence), Number(row.sequence), String(row.event_id)]),
    "utf8",
  ).toString("base64");
}

function decodeEventCursor(cursor: string): [number, number, string] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64").toString("utf8"));
  } catch {
    throw new GraphQueryError("invalid event cursor");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    typeof parsed[0] !== "number" ||
    typeof parsed[1] !== "number" ||
    typeof parsed[2] !== "string"
  ) {
    throw new GraphQueryError("invalid event cursor");
  }
  return [parsed[0], parsed[1], parsed[2]];
}

/**
 * Page lifecycle events in their deterministic global order: ledger manifest
 * sequence, then the event's sequence within its operation, then event id.
 */
export function pageEvents(database: DatabaseSync, query: EventQuery = {}): Page<LifecycleEvent> {
  const limit = clampLimit(query.limit);
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (query.iterationId !== undefined) {
    conditions.push("iteration_id = ?");
    params.push(query.iterationId);
  }
  if (query.workflowOperationId !== undefined) {
    conditions.push("workflow_operation_id = ?");
    params.push(query.workflowOperationId);
  }
  if (query.eventTypes !== undefined) {
    conditions.push(`event_type IN (${placeholders(query.eventTypes.length)})`);
    params.push(...query.eventTypes);
  }
  if (query.cursor !== undefined) {
    const [operationSequence, sequence, eventId] = decodeEventCursor(query.cursor);
    conditions.push(
      "(operation_sequence > ? OR (operation_sequence = ? AND sequence > ?) OR (operation_sequence = ? AND sequence = ? AND event_id > ?))",
    );
    params.push(
      operationSequence,
      operationSequence,
      sequence,
      operationSequence,
      sequence,
      eventId,
    );
  }
  const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
  const rows = database
    .prepare(
      `SELECT event_id, operation_sequence, sequence, record FROM events ${where} ORDER BY operation_sequence ASC, sequence ASC, event_id ASC LIMIT ?`,
    )
    .all(...params, limit + 1) as unknown as SqlRow[];
  const pageRows = rows.slice(0, limit);
  const items = pageRows.map((row) => parseRecord<LifecycleEvent>(row));
  const last = pageRows[pageRows.length - 1];
  return {
    items,
    ...(rows.length > limit && last !== undefined ? { nextCursor: encodeEventCursor(last) } : {}),
  };
}

interface IncidentEdge {
  readonly edge: EdgeRecord;
  readonly peerId: string;
}

/**
 * Edges incident to a node set, in deterministic edge-id order. When
 * `nodeTypes` is given, only intra-set edges (both endpoints in the set) are
 * returned; cross-view traceability goes through `bridges` instead.
 */
function incidentEdges(
  database: DatabaseSync,
  nodeIds: readonly string[],
  direction: TraversalDirection,
  nodeTypes: readonly NodeType[] | undefined,
  edgeStatuses: readonly EdgeStatus[] | undefined,
): IncidentEdge[] {
  if (nodeIds.length === 0) return [];
  const inList = placeholders(nodeIds.length);
  const statements: string[] = [];
  const params: (string | number)[] = [];
  const statusFilter =
    edgeStatuses === undefined ? "" : ` AND status IN (${placeholders(edgeStatuses.length)})`;
  const statusParams = edgeStatuses === undefined ? [] : [...edgeStatuses];
  const typeFilter = (peerColumn: string): string =>
    nodeTypes === undefined
      ? ""
      : ` AND ${peerColumn} IN (SELECT id FROM nodes WHERE type IN (${placeholders(nodeTypes.length)}))`;
  const typeParams = nodeTypes === undefined ? [] : [...nodeTypes];
  if (direction !== "incoming") {
    statements.push(
      `SELECT record, target_id AS peer FROM edges WHERE source_id IN (${inList})${statusFilter}${typeFilter("target_id")}`,
    );
    params.push(...nodeIds, ...statusParams, ...typeParams);
  }
  if (direction !== "outgoing") {
    statements.push(
      `SELECT record, source_id AS peer FROM edges WHERE target_id IN (${inList})${statusFilter}${typeFilter("source_id")}`,
    );
    params.push(...nodeIds, ...statusParams, ...typeParams);
  }
  const rows = database
    .prepare(
      `SELECT record, peer FROM (${statements.join(" UNION ALL ")}) ORDER BY json_extract(record, '$.id') ASC`,
    )
    .all(...params) as unknown as { record: unknown; peer: unknown }[];
  const seen = new Set<string>();
  const results: IncidentEdge[] = [];
  for (const row of rows) {
    const edge = JSON.parse(String(row.record)) as EdgeRecord;
    if (seen.has(edge.id)) continue;
    seen.add(edge.id);
    results.push({ edge, peerId: String(row.peer) });
  }
  return results;
}

/**
 * Breadth-first neighborhood expansion with deterministic ordering: edges are
 * followed in edge-id order at every depth, and result sets are sorted by id.
 */
export function neighborhood(
  database: DatabaseSync,
  rootId: string,
  options: TraversalOptions = {},
): Neighborhood {
  const depth = clampDepth(options.depth);
  const direction = options.direction ?? "both";
  const nodeById = new Map<string, NodeRecord>();
  const edgeById = new Map<string, EdgeRecord>();
  const root = getNode(database, rootId);
  if (root !== undefined) nodeById.set(root.id, root);
  let frontier = [rootId];
  const visited = new Set(frontier);
  for (let level = 0; level < depth && frontier.length > 0; level += 1) {
    const next: string[] = [];
    for (const incident of incidentEdges(
      database,
      frontier,
      direction,
      options.nodeTypes,
      options.edgeStatuses,
    )) {
      edgeById.set(incident.edge.id, incident.edge);
      if (visited.has(incident.peerId)) continue;
      visited.add(incident.peerId);
      const peer = getNode(database, incident.peerId);
      if (peer !== undefined) nodeById.set(peer.id, peer);
      next.push(incident.peerId);
    }
    frontier = next;
  }
  const byId = <T extends { id: string }>(left: T, right: T): number =>
    left.id < right.id ? -1 : 1;
  return {
    rootId,
    nodes: [...nodeById.values()].sort(byId),
    edges: [...edgeById.values()].sort(byId),
  };
}

/**
 * Deterministic shortest path between two nodes: breadth-first with neighbors
 * expanded in edge-id order, so ties resolve identically on every rebuild.
 */
export function shortestPath(
  database: DatabaseSync,
  sourceId: string,
  targetId: string,
  options: TraversalOptions = {},
): GraphPath | undefined {
  const maxDepth = clampDepth(options.depth ?? MAX_TRAVERSAL_DEPTH);
  const direction = options.direction ?? "both";
  if (sourceId === targetId) {
    const node = getNode(database, sourceId);
    return node === undefined ? undefined : { nodes: [node], edges: [] };
  }
  const parent = new Map<string, { previousId: string; edgeId: string }>();
  let frontier = [sourceId];
  const visited = new Set(frontier);
  for (let level = 0; level < maxDepth && frontier.length > 0; level += 1) {
    const next: string[] = [];
    for (const incident of incidentEdges(
      database,
      frontier,
      direction,
      options.nodeTypes,
      options.edgeStatuses,
    )) {
      if (visited.has(incident.peerId)) continue;
      visited.add(incident.peerId);
      parent.set(incident.peerId, {
        previousId: frontierOf(incident.edge, incident.peerId),
        edgeId: incident.edge.id,
      });
      if (incident.peerId === targetId) {
        return buildPath(database, sourceId, targetId, parent);
      }
      next.push(incident.peerId);
    }
    frontier = next;
  }
  return undefined;
}

function frontierOf(edge: EdgeRecord, peerId: string): string {
  return edge.source_id === peerId ? edge.target_id : edge.source_id;
}

function buildPath(
  database: DatabaseSync,
  sourceId: string,
  targetId: string,
  parent: ReadonlyMap<string, { previousId: string; edgeId: string }>,
): GraphPath | undefined {
  const nodeIds: string[] = [targetId];
  const edgeIds: string[] = [];
  let current = targetId;
  while (current !== sourceId) {
    const step = parent.get(current);
    if (step === undefined) return undefined;
    edgeIds.push(step.edgeId);
    nodeIds.push(step.previousId);
    current = step.previousId;
  }
  nodeIds.reverse();
  edgeIds.reverse();
  const nodes = nodeIds.map((id) => getNode(database, id)).filter((n) => n !== undefined);
  const edges = edgeIds.map((id) => getEdge(database, id)).filter((e) => e !== undefined);
  return { nodes, edges };
}

export interface GraphViewDefinition {
  readonly name: GraphViewName;
  readonly nodeTypes: readonly NodeType[];
}

/**
 * Bind the query port to one logical view. A view is a query boundary over
 * the shared projection, never a separate store: member nodes and intra-view
 * edges are filtered by node type, and `bridges` exposes the edges that cross
 * the boundary so the two views remain mutually traceable through their
 * shared ledger identities.
 */
export function createGraphView(
  database: DatabaseSync,
  definition: GraphViewDefinition,
): GraphView {
  const memberTypes = new Set<string>(definition.nodeTypes);
  return {
    name: definition.name,
    nodeTypes: definition.nodeTypes,
    containsNodeType: (type) => memberTypes.has(type),
    isMember: (nodeId) => {
      const node = getNode(database, nodeId);
      return node !== undefined && memberTypes.has(node.type);
    },
    getNode: (nodeId) => {
      const node = getNode(database, nodeId);
      return node !== undefined && memberTypes.has(node.type) ? node : undefined;
    },
    pageNodes: (query = {}) =>
      pageNodes(database, { ...query, types: query.types ?? definition.nodeTypes }),
    pageEdges: (query = {}) =>
      pageEdges(database, { ...query, nodeTypes: query.nodeTypes ?? definition.nodeTypes }),
    neighborhood: (rootId, options = {}) =>
      neighborhood(database, rootId, { ...options, nodeTypes: definition.nodeTypes }),
    bridges: (nodeId) => {
      const node = getNode(database, nodeId);
      if (node === undefined || !memberTypes.has(node.type)) {
        throw new GraphQueryError(
          `node ${nodeId} is not a member of the ${definition.name} graph view`,
        );
      }
      const results: ViewBridge[] = [];
      for (const direction of ["outgoing", "incoming"] as const) {
        for (const incident of incidentEdges(database, [nodeId], direction, undefined, undefined)) {
          const peer = getNode(database, incident.peerId);
          if (peer === undefined || memberTypes.has(peer.type)) continue;
          results.push({ edge: incident.edge, peer, direction });
        }
      }
      return results.sort((left, right) => (left.edge.id < right.edge.id ? -1 : 1));
    },
  };
}
