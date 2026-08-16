import type { IncomingMessage, ServerResponse } from "node:http";

import {
  EDGE_STATUSES,
  NODE_STATUSES,
  NODE_TYPES,
  RELATION_TYPES,
  type EdgeRecord,
  type NodeRecord,
} from "@universal-harness-internal/core";
import type { TraversalDirection } from "@universal-harness-internal/graph";

import {
  DashboardProblem,
  applySecurityHeaders,
  asDashboardProblem,
  sendProblem,
} from "./problem.js";
import type { DashboardReadApi } from "./read-api.js";
import type { DashboardSessionStore } from "./session.js";

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.:-]{0,255}$/u;
const VALID_NODE_STATUSES = new Set<string>(NODE_STATUSES);
const VALID_EDGE_STATUSES = new Set<string>(EDGE_STATUSES);
const VALID_NODE_TYPES = new Set<string>(NODE_TYPES);
const VALID_EDGE_TYPES = new Set<string>(RELATION_TYPES);
const DIRECTIONS = new Set<TraversalDirection>(["incoming", "outgoing", "both"]);

export interface DashboardRouterOptions {
  readonly origin: string;
  readonly sessions: DashboardSessionStore;
  readonly readApi: DashboardReadApi;
}

function sendJson(response: ServerResponse, data: unknown, status = 200): void {
  applySecurityHeaders(response);
  response.statusCode = status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify({ data })}\n`);
}

function one(query: URLSearchParams, key: string): string | undefined {
  const values = query.getAll(key);
  if (values.length > 1) {
    throw new DashboardProblem(400, "invalid_query", "Bad Request", `${key} may appear once`);
  }
  return values[0];
}

function integer(
  value: string | undefined,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/u.test(value)) {
    throw new DashboardProblem(400, "invalid_query", "Bad Request", `${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new DashboardProblem(
      400,
      "invalid_query",
      "Bad Request",
      `${name} must be in ${String(minimum)}..${String(maximum)}`,
    );
  }
  return parsed;
}

function identifier(value: string | undefined, name: string): string {
  if (value === undefined || !IDENTIFIER.test(value)) {
    throw new DashboardProblem(
      400,
      "invalid_identifier",
      "Bad Request",
      `${name} is not a valid Harness identifier`,
    );
  }
  return value;
}

function decodedIdentifier(value: string, name: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new DashboardProblem(400, "invalid_identifier", "Bad Request", `${name} is malformed`);
  }
  return identifier(decoded, name);
}

function viewOf(value: string | undefined): "all" | "artifact" | "execution" | undefined {
  if (value === undefined) return undefined;
  if (value === "all" || value === "artifact" || value === "execution") return value;
  throw new DashboardProblem(400, "invalid_query", "Bad Request", "unknown graph view");
}

function directionOf(value: string | undefined): TraversalDirection | undefined {
  if (value === undefined) return undefined;
  if (DIRECTIONS.has(value as TraversalDirection)) return value as TraversalDirection;
  throw new DashboardProblem(400, "invalid_query", "Bad Request", "unknown traversal direction");
}

function validateOrigin(request: IncomingMessage, origin: string): void {
  const supplied = request.headers.origin;
  if (supplied !== undefined && supplied !== origin) {
    throw new DashboardProblem(
      403,
      "origin_mismatch",
      "Forbidden",
      "the request Origin does not match the Dashboard origin",
    );
  }
}

function queryKeys(query: URLSearchParams, allowed: ReadonlySet<string>): void {
  for (const key of query.keys()) {
    if (!allowed.has(key)) {
      throw new DashboardProblem(400, "invalid_query", "Bad Request", `unknown query field ${key}`);
    }
  }
}

export function createDashboardRouter(options: DashboardRouterOptions) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      if (request.url === undefined) {
        throw new DashboardProblem(400, "invalid_url", "Bad Request", "request URL is missing");
      }
      if (Buffer.byteLength(request.url, "utf8") > 8192) {
        throw new DashboardProblem(
          414,
          "request_target_too_large",
          "URI Too Long",
          "the Dashboard request target exceeds 8192 bytes",
        );
      }
      if (request.method !== "GET") {
        throw new DashboardProblem(
          405,
          "method_not_allowed",
          "Method Not Allowed",
          "only GET is available",
        );
      }
      const url = new URL(request.url, options.origin);
      const bootstrapToken = one(url.searchParams, "token");
      if (bootstrapToken !== undefined) {
        queryKeys(url.searchParams, new Set(["token"]));
        if (url.pathname !== "/") {
          throw new DashboardProblem(
            400,
            "invalid_bootstrap_url",
            "Bad Request",
            "the bootstrap token is only accepted at the Dashboard root",
          );
        }
        const exchanged = options.sessions.exchange(bootstrapToken);
        applySecurityHeaders(response);
        response.statusCode = 303;
        response.setHeader("cache-control", "no-store");
        response.setHeader("location", "/");
        response.setHeader("set-cookie", exchanged.cookie);
        response.end();
        return;
      }
      validateOrigin(request, options.origin);
      const session = options.sessions.authenticate(request);

      if (url.pathname === "/api/v1/session") {
        queryKeys(url.searchParams, new Set());
        sendJson(response, { csrf_token: session.csrfToken, expires_at: session.expiresAt });
        return;
      }
      if (url.pathname === "/api/v1/project") {
        queryKeys(url.searchParams, new Set());
        sendJson(response, options.readApi.project());
        return;
      }
      if (url.pathname === "/api/v1/graph/nodes") {
        queryKeys(
          url.searchParams,
          new Set(["cursor", "limit", "type", "status", "iteration", "view"]),
        );
        const status = one(url.searchParams, "status");
        const cursor = one(url.searchParams, "cursor");
        const limit = integer(one(url.searchParams, "limit"), "limit", 1, 500);
        const type = one(url.searchParams, "type");
        const iterationId = one(url.searchParams, "iteration");
        const view = viewOf(one(url.searchParams, "view"));
        if (status !== undefined && !VALID_NODE_STATUSES.has(status)) {
          throw new DashboardProblem(400, "invalid_query", "Bad Request", "unknown node status");
        }
        if (type !== undefined && !VALID_NODE_TYPES.has(type)) {
          throw new DashboardProblem(400, "invalid_query", "Bad Request", "unknown node type");
        }
        sendJson(
          response,
          options.readApi.nodes({
            ...(cursor === undefined ? {} : { cursor: identifier(cursor, "cursor") }),
            ...(limit === undefined ? {} : { limit }),
            ...(type === undefined ? {} : { type: type as NodeRecord["type"] }),
            ...(status === undefined ? {} : { status: status as NodeRecord["status"] }),
            ...(iterationId === undefined
              ? {}
              : { iterationId: identifier(iterationId, "iteration") }),
            ...(view === undefined ? {} : { view }),
          }),
        );
        return;
      }
      if (url.pathname === "/api/v1/graph/edges") {
        queryKeys(
          url.searchParams,
          new Set(["cursor", "limit", "type", "status", "source", "target", "view"]),
        );
        const status = one(url.searchParams, "status");
        const cursor = one(url.searchParams, "cursor");
        const limit = integer(one(url.searchParams, "limit"), "limit", 1, 500);
        const type = one(url.searchParams, "type");
        const sourceId = one(url.searchParams, "source");
        const targetId = one(url.searchParams, "target");
        const view = viewOf(one(url.searchParams, "view"));
        if (status !== undefined && !VALID_EDGE_STATUSES.has(status)) {
          throw new DashboardProblem(400, "invalid_query", "Bad Request", "unknown edge status");
        }
        if (type !== undefined && !VALID_EDGE_TYPES.has(type)) {
          throw new DashboardProblem(400, "invalid_query", "Bad Request", "unknown edge type");
        }
        sendJson(
          response,
          options.readApi.edges({
            ...(cursor === undefined ? {} : { cursor: identifier(cursor, "cursor") }),
            ...(limit === undefined ? {} : { limit }),
            ...(type === undefined ? {} : { type: type as EdgeRecord["type"] }),
            ...(status === undefined ? {} : { status: status as EdgeRecord["status"] }),
            ...(sourceId === undefined ? {} : { sourceId: identifier(sourceId, "source") }),
            ...(targetId === undefined ? {} : { targetId: identifier(targetId, "target") }),
            ...(view === undefined ? {} : { view }),
          }),
        );
        return;
      }
      const neighborhood = /^\/api\/v1\/graph\/neighborhood\/(.+)$/u.exec(url.pathname);
      if (neighborhood !== null) {
        queryKeys(url.searchParams, new Set(["depth", "direction"]));
        const depth = integer(one(url.searchParams, "depth"), "depth", 1, 4);
        const direction = directionOf(one(url.searchParams, "direction"));
        sendJson(
          response,
          options.readApi.neighborhood(decodedIdentifier(neighborhood[1] ?? "", "node id"), {
            ...(depth === undefined ? {} : { depth }),
            ...(direction === undefined ? {} : { direction }),
          }),
        );
        return;
      }
      if (url.pathname === "/api/v1/graph/path") {
        queryKeys(url.searchParams, new Set(["from", "to", "depth", "direction"]));
        const depth = integer(one(url.searchParams, "depth"), "depth", 1, 10);
        const direction = directionOf(one(url.searchParams, "direction"));
        sendJson(
          response,
          options.readApi.path(
            identifier(one(url.searchParams, "from"), "from"),
            identifier(one(url.searchParams, "to"), "to"),
            {
              ...(depth === undefined ? {} : { depth }),
              ...(direction === undefined ? {} : { direction }),
            },
          ),
        );
        return;
      }
      const iteration = /^\/api\/v1\/iterations\/(.+)$/u.exec(url.pathname);
      if (iteration !== null) {
        queryKeys(url.searchParams, new Set());
        sendJson(
          response,
          options.readApi.iteration(decodedIdentifier(iteration[1] ?? "", "iteration id")),
        );
        return;
      }
      if (url.pathname === "/api/v1/evidence") {
        queryKeys(url.searchParams, new Set(["cursor", "limit", "status", "iteration"]));
        const status = one(url.searchParams, "status");
        const cursor = one(url.searchParams, "cursor");
        const limit = integer(one(url.searchParams, "limit"), "limit", 1, 500);
        const iterationId = one(url.searchParams, "iteration");
        if (status !== undefined && !VALID_NODE_STATUSES.has(status)) {
          throw new DashboardProblem(
            400,
            "invalid_query",
            "Bad Request",
            "unknown evidence status",
          );
        }
        sendJson(
          response,
          options.readApi.evidence({
            ...(cursor === undefined ? {} : { cursor: identifier(cursor, "cursor") }),
            ...(limit === undefined ? {} : { limit }),
            ...(status === undefined ? {} : { status: status as NodeRecord["status"] }),
            ...(iterationId === undefined
              ? {}
              : { iterationId: identifier(iterationId, "iteration") }),
          }),
        );
        return;
      }
      if (url.pathname === "/api/v1/finding-groups") {
        queryKeys(url.searchParams, new Set(["cursor", "limit"]));
        const cursor = one(url.searchParams, "cursor");
        const limit = integer(one(url.searchParams, "limit"), "limit", 1, 500);
        sendJson(
          response,
          options.readApi.findingGroups({
            ...(cursor === undefined ? {} : { cursor: identifier(cursor, "cursor") }),
            ...(limit === undefined ? {} : { limit }),
          }),
        );
        return;
      }
      throw new DashboardProblem(404, "route_not_found", "Not Found", "Dashboard route not found");
    } catch (error) {
      sendProblem(response, asDashboardProblem(error));
    }
  };
}
