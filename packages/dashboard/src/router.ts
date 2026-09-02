import type { IncomingMessage, ServerResponse } from "node:http";

import {
  EDGE_STATUSES,
  NODE_STATUSES,
  NODE_TYPES,
  RELATION_TYPES,
  REMOTE_APPROVAL_DECISIONS,
  type EdgeRecord,
  type NodeRecord,
} from "@universal-harness-internal/core";
import type { TraversalDirection } from "@universal-harness-internal/graph";
import type { EventStreamPort, RemoteApprovalDecision } from "@universal-harness-internal/runtime";

import type { DashboardCollaborationApi } from "./collaboration-api.js";

import {
  DashboardProblem,
  applySecurityHeaders,
  asDashboardProblem,
  sendProblem,
} from "./problem.js";
import type { DashboardReadApi } from "./read-api.js";
import type { DashboardSchedulerApi } from "./scheduler-api.js";
import type { DashboardSessionStore } from "./session.js";
import { loadDashboardAsset, type DashboardAssetName } from "./assets.js";
import { streamDashboardEvents } from "./sse.js";
import {
  DASHBOARD_APPROVAL_DECISIONS,
  DASHBOARD_FINDING_ACTIONS,
  type DashboardApprovalDecision,
  type DashboardFindingAction,
  type DashboardWriteApi,
} from "./write-api.js";

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.:-]{0,255}$/u;
const VALID_NODE_STATUSES = new Set<string>(NODE_STATUSES);
const VALID_EDGE_STATUSES = new Set<string>(EDGE_STATUSES);
const VALID_NODE_TYPES = new Set<string>(NODE_TYPES);
const VALID_EDGE_TYPES = new Set<string>(RELATION_TYPES);
const DIRECTIONS = new Set<TraversalDirection>(["incoming", "outgoing", "both"]);
const EVENT_CURSOR = /^cursor_[A-Za-z0-9_-]{1,2048}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_WRITE_BODY_BYTES = 32 * 1024;

export interface DashboardRouterOptions {
  readonly origin: string;
  readonly sessions: DashboardSessionStore;
  readonly readApi: DashboardReadApi;
  readonly schedulerApi: DashboardSchedulerApi;
  readonly eventStream: EventStreamPort;
  readonly writeApi: DashboardWriteApi;
  readonly collaborationApi: DashboardCollaborationApi;
  readonly shutdownSignal: AbortSignal;
}

function sendJson(response: ServerResponse, data: unknown, status = 200): void {
  applySecurityHeaders(response);
  response.statusCode = status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify({ data })}\n`);
}

function sendAsset(response: ServerResponse, name: DashboardAssetName): void {
  const asset = loadDashboardAsset(name);
  applySecurityHeaders(response);
  response.statusCode = 200;
  response.setHeader("cache-control", asset.cacheControl);
  response.setHeader("content-type", asset.contentType);
  response.setHeader("content-length", asset.body.byteLength);
  response.end(asset.body);
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

function lastEventCursor(request: IncomingMessage): string | undefined {
  const supplied = request.headers["last-event-id"];
  if (supplied === undefined) return undefined;
  if (Array.isArray(supplied) || !EVENT_CURSOR.test(supplied)) {
    throw new DashboardProblem(
      400,
      "invalid_event_cursor",
      "Bad Request",
      "Last-Event-ID is not a valid event cursor",
    );
  }
  return supplied;
}

function queryKeys(query: URLSearchParams, allowed: ReadonlySet<string>): void {
  for (const key of query.keys()) {
    if (!allowed.has(key)) {
      throw new DashboardProblem(400, "invalid_query", "Bad Request", `unknown query field ${key}`);
    }
  }
}

function writeOrigin(request: IncomingMessage, origin: string): void {
  if (request.headers.origin !== origin) {
    throw new DashboardProblem(
      403,
      "origin_mismatch",
      "Forbidden",
      "Dashboard writes require the exact same Origin",
    );
  }
}

function stringHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = stringHeader(request, "content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw new DashboardProblem(
      415,
      "unsupported_media_type",
      "Unsupported Media Type",
      "Dashboard writes require application/json",
    );
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
    bytes += chunk.byteLength;
    if (bytes > MAX_WRITE_BODY_BYTES) {
      throw new DashboardProblem(
        413,
        "write_body_too_large",
        "Content Too Large",
        `Dashboard write bodies may not exceed ${String(MAX_WRITE_BODY_BYTES)} bytes`,
      );
    }
    chunks.push(chunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new DashboardProblem(400, "invalid_json", "Bad Request", "request body is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DashboardProblem(
      400,
      "invalid_write",
      "Bad Request",
      "request body must be a JSON object",
    );
  }
  return parsed as Record<string, unknown>;
}

function bodyKeys(body: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw new DashboardProblem(400, "invalid_write", "Bad Request", `unknown field ${key}`);
    }
  }
}

function bodyString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value === "") {
    throw new DashboardProblem(400, "invalid_write", "Bad Request", `${key} must be a string`);
  }
  return value;
}

function actor(body: Record<string, unknown>): string {
  const value = bodyString(body, "actor");
  const hasControl = [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
  if (value.length > 256 || hasControl) {
    throw new DashboardProblem(400, "invalid_write", "Bad Request", "actor is invalid");
  }
  return value;
}

function expectedDigest(body: Record<string, unknown>): string {
  const value = bodyString(body, "expected_digest");
  if (!DIGEST.test(value)) {
    throw new DashboardProblem(
      400,
      "invalid_write",
      "Bad Request",
      "expected_digest must be a SHA-256 digest",
    );
  }
  return value;
}

function bodyPositiveInteger(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new DashboardProblem(400, "invalid_write", "Bad Request", `${key} must be positive`);
  }
  return value as number;
}

function unavailableSchedulerWrite(): never {
  throw new DashboardProblem(
    503,
    "write_operations_unavailable",
    "Unavailable",
    "this Dashboard host did not configure the requested Scheduler write service",
  );
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
      if (request.method !== "GET" && request.method !== "POST") {
        throw new DashboardProblem(
          405,
          "method_not_allowed",
          "Method Not Allowed",
          "only GET and controlled POST operations are available",
        );
      }
      const url = new URL(request.url, options.origin);
      const bootstrapToken = one(url.searchParams, "token");
      if (bootstrapToken !== undefined) {
        if (request.method !== "GET") {
          throw new DashboardProblem(
            405,
            "method_not_allowed",
            "Method Not Allowed",
            "the bootstrap exchange requires GET",
          );
        }
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

      if (request.method === "POST") {
        queryKeys(url.searchParams, new Set());
        writeOrigin(request, options.origin);
        options.sessions.assertCsrf(session, stringHeader(request, "x-harness-csrf"));
        const body = await readJsonBody(request);
        const approval = /^\/api\/v1\/approvals\/(.+)\/decision$/u.exec(url.pathname);
        if (approval !== null) {
          bodyKeys(body, new Set(["decision", "expected_digest", "actor"]));
          const decision = bodyString(body, "decision");
          if (!DASHBOARD_APPROVAL_DECISIONS.some((value) => value === decision)) {
            throw new DashboardProblem(
              400,
              "invalid_write",
              "Bad Request",
              "decision must be approve, reject or defer",
            );
          }
          sendJson(
            response,
            await options.writeApi.decideApproval({
              requestId: decodedIdentifier(approval[1] ?? "", "approval id"),
              decision: decision as DashboardApprovalDecision,
              expectedDigest: expectedDigest(body),
              actor: actor(body),
            }),
          );
          return;
        }
        const workflow = /^\/api\/v1\/workflows\/(.+)\/resume$/u.exec(url.pathname);
        if (workflow !== null) {
          bodyKeys(body, new Set(["expected_digest", "actor"]));
          sendJson(
            response,
            await options.writeApi.resumeWorkflow({
              workflowOperationId: decodedIdentifier(workflow[1] ?? "", "workflow id"),
              expectedDigest: expectedDigest(body),
              actor: actor(body),
            }),
          );
          return;
        }
        const schedulerCancel = /^\/api\/v1\/scheduler\/operations\/(.+)\/cancel$/u.exec(
          url.pathname,
        );
        if (schedulerCancel !== null) {
          bodyKeys(body, new Set(["expected_digest", "actor"]));
          const cancel = options.writeApi.cancelSchedulerOperation;
          if (cancel === undefined) unavailableSchedulerWrite();
          sendJson(
            response,
            await cancel({
              operationId: decodedIdentifier(schedulerCancel[1] ?? "", "operation id"),
              expectedDigest: expectedDigest(body),
              actor: actor(body),
            }),
          );
          return;
        }
        if (url.pathname === "/api/v1/scheduler/policy-proposals") {
          bodyKeys(
            body,
            new Set([
              "operation_id",
              "proposal_kind",
              "expected_digest",
              "actor",
              "max_concurrency",
              "steps",
              "tokens",
              "duration_ms",
            ]),
          );
          const proposalKind = bodyString(body, "proposal_kind");
          if (proposalKind !== "budget" && proposalKind !== "concurrency") {
            throw new DashboardProblem(
              400,
              "invalid_write",
              "Bad Request",
              "proposal_kind must be budget or concurrency",
            );
          }
          const propose = options.writeApi.proposeSchedulerPolicy;
          if (propose === undefined) unavailableSchedulerWrite();
          sendJson(
            response,
            await propose({
              operationId: identifier(bodyString(body, "operation_id"), "operation_id"),
              proposalKind,
              expectedDigest: expectedDigest(body),
              actor: actor(body),
              ...(proposalKind === "concurrency"
                ? { maxConcurrency: bodyPositiveInteger(body, "max_concurrency") }
                : {
                    budget: {
                      steps: bodyPositiveInteger(body, "steps"),
                      tokens: bodyPositiveInteger(body, "tokens"),
                      durationMs: bodyPositiveInteger(body, "duration_ms"),
                    },
                  }),
            }),
          );
          return;
        }
        const finding = /^\/api\/v1\/finding-groups\/(.+)\/resolve$/u.exec(url.pathname);
        if (finding !== null) {
          bodyKeys(body, new Set(["action", "expected_digest", "actor", "evidence_id"]));
          const action = bodyString(body, "action");
          if (!DASHBOARD_FINDING_ACTIONS.some((value) => value === action)) {
            throw new DashboardProblem(
              400,
              "invalid_write",
              "Bad Request",
              "action must be accept, close or supersede",
            );
          }
          const evidenceId = body["evidence_id"];
          if (evidenceId !== undefined && typeof evidenceId !== "string") {
            throw new DashboardProblem(
              400,
              "invalid_write",
              "Bad Request",
              "evidence_id must be a Harness identifier",
            );
          }
          sendJson(
            response,
            await options.writeApi.resolveFindingGroup({
              groupId: decodedIdentifier(finding[1] ?? "", "finding group id"),
              action: action as DashboardFindingAction,
              expectedDigest: expectedDigest(body),
              actor: actor(body),
              ...(evidenceId === undefined
                ? {}
                : { evidenceId: identifier(evidenceId as string, "evidence_id") }),
            }),
          );
          return;
        }
        const collaborationApproval = /^\/api\/v1\/collaboration\/approvals\/(.+)\/decision$/u.exec(
          url.pathname,
        );
        if (collaborationApproval !== null) {
          bodyKeys(body, new Set(["decision"]));
          const decision = bodyString(body, "decision");
          if (!REMOTE_APPROVAL_DECISIONS.some((value) => value === decision)) {
            throw new DashboardProblem(
              400,
              "invalid_write",
              "Bad Request",
              "decision must be approve, reject or defer",
            );
          }
          sendJson(
            response,
            await options.collaborationApi.submitRemoteApproval({
              requestId: decodedIdentifier(collaborationApproval[1] ?? "", "approval id"),
              decision: decision as RemoteApprovalDecision,
            }),
          );
          return;
        }
        const collaborationRetry = /^\/api\/v1\/collaboration\/integrations\/(.+)\/retry$/u.exec(
          url.pathname,
        );
        if (collaborationRetry !== null) {
          bodyKeys(body, new Set());
          sendJson(
            response,
            await options.collaborationApi.retryIntegration({
              integrationId: decodedIdentifier(collaborationRetry[1] ?? "", "integration id"),
            }),
          );
          return;
        }
        throw new DashboardProblem(
          404,
          "route_not_found",
          "Not Found",
          "Dashboard write route not found",
        );
      }

      if (url.pathname === "/events") {
        queryKeys(url.searchParams, new Set(["iteration", "workflow"]));
        const iterationId = one(url.searchParams, "iteration");
        const workflowOperationId = one(url.searchParams, "workflow");
        const disconnected = new AbortController();
        const abort = (): void => disconnected.abort();
        request.once("aborted", abort);
        response.once("close", abort);
        options.shutdownSignal.addEventListener("abort", abort, { once: true });
        const cursor = lastEventCursor(request);
        try {
          await streamDashboardEvents({
            response,
            eventStream: options.eventStream,
            signal: disconnected.signal,
            ...(cursor === undefined ? {} : { cursor }),
            ...(iterationId === undefined
              ? {}
              : { iterationId: identifier(iterationId, "iteration") }),
            ...(workflowOperationId === undefined
              ? {}
              : { workflowOperationId: identifier(workflowOperationId, "workflow") }),
          });
        } finally {
          request.off("aborted", abort);
          response.off("close", abort);
          options.shutdownSignal.removeEventListener("abort", abort);
        }
        return;
      }

      if (url.pathname === "/") {
        queryKeys(url.searchParams, new Set());
        sendAsset(response, "dashboard.html");
        return;
      }
      if (url.pathname === "/assets/dashboard.css") {
        queryKeys(url.searchParams, new Set());
        sendAsset(response, "dashboard.css");
        return;
      }
      if (url.pathname === "/assets/dashboard.js") {
        queryKeys(url.searchParams, new Set());
        sendAsset(response, "dashboard.js");
        return;
      }

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
      if (url.pathname === "/api/v1/scheduler") {
        queryKeys(url.searchParams, new Set(["operation_id"]));
        const operationId = identifier(one(url.searchParams, "operation_id"), "operation_id");
        sendJson(response, await options.schedulerApi.read({ operation_id: operationId }));
        return;
      }
      if (url.pathname === "/api/v1/approvals") {
        queryKeys(url.searchParams, new Set(["cursor", "limit"]));
        const cursor = one(url.searchParams, "cursor");
        const limit = integer(one(url.searchParams, "limit"), "limit", 1, 500);
        sendJson(
          response,
          options.readApi.approvals({
            ...(cursor === undefined ? {} : { cursor: identifier(cursor, "cursor") }),
            ...(limit === undefined ? {} : { limit }),
          }),
        );
        return;
      }
      if (url.pathname === "/api/v1/model-invocations") {
        queryKeys(url.searchParams, new Set(["cursor", "limit"]));
        const cursor = one(url.searchParams, "cursor");
        const limit = integer(one(url.searchParams, "limit"), "limit", 1, 500);
        sendJson(
          response,
          options.readApi.modelInvocations({
            ...(cursor === undefined ? {} : { cursor: identifier(cursor, "cursor") }),
            ...(limit === undefined ? {} : { limit }),
          }),
        );
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
      if (url.pathname === "/api/v1/semantic-proposals") {
        queryKeys(url.searchParams, new Set(["cursor", "limit"]));
        const cursor = one(url.searchParams, "cursor");
        const limit = integer(one(url.searchParams, "limit"), "limit", 1, 500);
        sendJson(
          response,
          options.readApi.semanticProposals({
            ...(cursor === undefined ? {} : { cursor: identifier(cursor, "cursor") }),
            ...(limit === undefined ? {} : { limit }),
          }),
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
      if (url.pathname === "/api/v1/collaboration/connection") {
        queryKeys(url.searchParams, new Set());
        sendJson(response, await options.collaborationApi.connection());
        return;
      }
      if (url.pathname === "/api/v1/collaboration/approvals") {
        queryKeys(url.searchParams, new Set());
        sendJson(response, await options.collaborationApi.remoteApprovals());
        return;
      }
      if (url.pathname === "/api/v1/collaboration/conflicts") {
        queryKeys(url.searchParams, new Set());
        sendJson(response, await options.collaborationApi.integrationConflicts());
        return;
      }
      throw new DashboardProblem(404, "route_not_found", "Not Found", "Dashboard route not found");
    } catch (error) {
      sendProblem(response, asDashboardProblem(error));
    }
  };
}
