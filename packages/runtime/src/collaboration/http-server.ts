import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";

import { collaborationFailure } from "./errors.js";
import { OAUTH_SESSION_TTL_MS } from "./oauth-session.js";
import type {
  CollaborationCommand,
  CollaborationCoordinatorPort,
  CollaborationOutcome,
  CollaborationQuery,
  CollaborationSession,
  ConnectCommand,
  PlatformIdentityPort,
} from "./port.js";

/**
 * Thin HTTPS server for the Coordinator transport (plan M3 Task 7). The HTTP
 * layer only decodes the versioned command/query union, authenticates the
 * transport session (Origin/CSRF guards, one-time OAuth state, Secure +
 * HttpOnly + SameSite cookie), calls the port and encodes the typed result.
 * No permission, Lease, Approval or Integration rule lives here.
 *
 * Deferred OAuth connect flow (plan Task 7 step 2): a command that reaches the
 * platform authorization seam does not block the request; the endpoint answers
 * `authentication_required` with a random in-memory `oauth_session_id` and a
 * coordinator-local `authorization_url`, the background flow completes once
 * the browser callback consumes the state exactly once, and the client polls a
 * connection-status query bound to the same session id. The provider access
 * token never leaves the platform Adapter's process memory, and unexpected
 * internal errors are answered with a generic body so token-shaped text never
 * crosses the wire.
 */

const COMMANDS_PATH = "/api/v1/collaboration/commands";
const QUERIES_PATH = "/api/v1/collaboration/queries";
const OAUTH_ROUTE = /^\/oauth\/(github|gitlab|gitee)\/(start|callback)$/u;
const SESSION_COOKIE = "harness_coordinator_session";
const CSRF_HEADER = "x-harness-csrf";
const DEFAULT_BODY_LIMIT_BYTES = 128 * 1024;
const FLOW_RETENTION_MS = OAUTH_SESSION_TTL_MS;

const PROVIDERS = ["github", "gitlab", "gitee"] as const;
type ProviderName = (typeof PROVIDERS)[number];

// --- OAuth bridge --------------------------------------------------------------

export interface PendingAuthorization {
  readonly state: string;
  readonly provider: ProviderName;
  readonly authorize_url: string;
  readonly promise: Promise<string>;
  resolve(callbackUrl: string): void;
}

export interface CoordinatorOAuthBridge {
  /**
   * Server-side platform `authorize` seam: registers the pending authorization
   * and resolves with the full callback URL once the browser delivers it.
   * Rejects when the session TTL passes without a callback.
   */
  authorize(authorizeUrl: string, provider?: string): Promise<string>;
  /** Consume the state exactly once; resolves the pending authorization. */
  handleCallback(callbackUrl: string): boolean;
  /** Await the next authorization request (transport flow correlation). */
  nextAuthorizationRequest(): Promise<PendingAuthorization>;
  /** Look up the pending (unresolved) authorization by state. */
  pendingFor(state: string): PendingAuthorization | undefined;
}

export interface CoordinatorOAuthBridgeOptions {
  readonly now?: () => string;
  readonly ttl_ms?: number;
}

export function createCoordinatorOAuthBridge(
  options: CoordinatorOAuthBridgeOptions = {},
): CoordinatorOAuthBridge {
  const now = options.now ?? (() => new Date().toISOString());
  const ttlMs = options.ttl_ms ?? OAUTH_SESSION_TTL_MS;
  const pending = new Map<string, PendingAuthorization>();
  const waiters: ((request: PendingAuthorization) => void)[] = [];
  return {
    authorize(authorizeUrl, provider) {
      let state: string | null;
      try {
        state = new URL(authorizeUrl).searchParams.get("state");
      } catch {
        return Promise.reject(new Error("oauth authorize url is not a URL"));
      }
      if (state === null || state === "") {
        return Promise.reject(new Error("oauth authorize url carries no state"));
      }
      if (pending.has(state)) {
        return Promise.reject(new Error("duplicate oauth state"));
      }
      // Fail closed on an unknown provider instead of silently coercing it.
      if (provider !== undefined && !(PROVIDERS as readonly string[]).includes(provider)) {
        return Promise.reject(new Error(`unsupported oauth provider: ${provider}`));
      }
      let resolvePromise!: (callbackUrl: string) => void;
      let rejectPromise!: (error: Error) => void;
      const promise = new Promise<string>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });
      const entry: PendingAuthorization = {
        state,
        provider: provider === undefined ? "github" : (provider as ProviderName),
        authorize_url: authorizeUrl,
        promise,
        resolve: resolvePromise,
      };
      pending.set(state, entry);
      for (const waiter of waiters.splice(0)) waiter(entry);
      const expiresAt = Date.parse(now()) + ttlMs;
      const timer = setTimeout(() => {
        if (pending.delete(state)) {
          rejectPromise(new Error("oauth authorization timed out"));
        }
      }, ttlMs);
      // An already-expired bridge (frozen clocks in tests) rejects immediately.
      if (expiresAt <= Date.parse(now())) {
        clearTimeout(timer);
        if (pending.delete(state)) {
          rejectPromise(new Error("oauth authorization timed out"));
        }
      }
      promise.catch(() => undefined).finally(() => clearTimeout(timer));
      return promise;
    },
    handleCallback(callbackUrl) {
      let state: string | null;
      try {
        state = new URL(callbackUrl).searchParams.get("state");
      } catch {
        return false;
      }
      if (state === null) return false;
      const entry = pending.get(state);
      // Every callback consumes the state: replay finds nothing behind.
      pending.delete(state ?? "");
      if (entry === undefined) return false;
      entry.resolve(callbackUrl);
      return true;
    },
    nextAuthorizationRequest() {
      return new Promise<PendingAuthorization>((resolve) => waiters.push(resolve));
    },
    pendingFor(state) {
      return pending.get(state);
    },
  };
}

// --- Server --------------------------------------------------------------------

export interface CollaborationCoordinatorServerOptions {
  readonly coordinator: CollaborationCoordinatorPort;
  /** Host-owned TLS material; the coordinator never serves plain HTTP. */
  readonly tls: { readonly cert: string | Buffer; readonly key: string | Buffer };
  readonly host?: string;
  readonly port?: number;
  /** OAuth session bridge; required to serve the deferred authorization flow. */
  readonly bridge?: CoordinatorOAuthBridge;
  /**
   * Platform identity port used by the transport to authenticate the connect
   * session (discover + OAuth) before delegating to the Coordinator; the
   * Coordinator keeps every permission and protection check.
   */
  readonly platform?: PlatformIdentityPort;
  readonly body_limit_bytes?: number;
  readonly now?: () => string;
}

export interface CollaborationCoordinatorServer {
  readonly host: string;
  readonly port: number;
  readonly origin: string;
  close(): Promise<void>;
}

interface TransportSession {
  readonly id: string;
  readonly csrfToken: string;
  readonly expiresAt: number;
}

/**
 * Bearer credential the connect response issues; held only in server memory
 * and bound to the authenticated principal it was minted for (spec §17.1).
 */
interface SessionCredential {
  readonly principal_id: string;
  readonly expiresAt: number;
}

type FlowEntry =
  | {
      readonly phase: "awaiting_authorization";
      readonly provider: ProviderName;
      readonly authorizeUrl: string;
      readonly state: string;
      readonly transportSession: TransportSession;
      readonly expiresAt: number;
    }
  | {
      readonly phase: "completed";
      readonly outcome: CollaborationOutcome;
      /** Bearer credential minted for a completed connect, if any. */
      readonly credential?: string;
      readonly expiresAt: number;
    };

type TransportErrorCode =
  | "authentication_required"
  | "bad_request"
  | "body_too_large"
  | "coordinator_unavailable"
  | "csrf_mismatch"
  | "not_found"
  | "origin_forbidden"
  | "unsupported_media_type";

function sendJson(
  response: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    ...extraHeaders,
  });
  response.end(body);
}

function sendTransportError(
  response: ServerResponse,
  status: number,
  error: TransportErrorCode,
): void {
  sendJson(response, status, { type: "error", error });
}

function cookiesOf(request: IncomingMessage): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name !== "" && value !== "") result.set(name, value);
  }
  return result;
}

function secretEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Light wire validation of the versioned command union (domain rules stay behind the port). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const COMMAND_FIELDS: Readonly<Record<string, readonly string[]>> = {
  connect: ["canonical_remote", "target_ref", "coordinator_origin", "policy_digest"],
  disconnect: [],
  acquire_operation_lease: ["operation_id"],
  renew_operation_lease: ["lease_id"],
  release_operation_lease: ["lease_id"],
  publish_operation_candidate: ["operation_id", "candidate_commit"],
  submit_remote_approval: ["request_id", "decision"],
  prepare_integration: ["operation_id"],
  accept_integration: ["integration_id", "expected_target_commit"],
  sync_now: [],
};

const QUERY_KINDS = new Set([
  "connection_status",
  "operations",
  "approval_inbox",
  "integration_conflicts",
]);

function isValidCommand(value: unknown): value is CollaborationCommand {
  if (!isRecord(value)) return false;
  if (typeof value["kind"] !== "string") return false;
  const required = COMMAND_FIELDS[value["kind"]];
  if (required === undefined) return false;
  if (typeof value["command_id"] !== "string" || typeof value["project_id"] !== "string") {
    return false;
  }
  if (
    value["kind"] === "publish_operation_candidate" &&
    typeof value["fencing_token"] !== "number"
  ) {
    return false;
  }
  return required.every((field) => typeof value[field] === "string");
}

function isValidQuery(value: unknown): value is CollaborationQuery {
  return (
    isRecord(value) &&
    typeof value["kind"] === "string" &&
    QUERY_KINDS.has(value["kind"]) &&
    typeof value["project_id"] === "string"
  );
}

function isValidSession(value: unknown): value is CollaborationSession {
  return (
    isRecord(value) &&
    typeof value["principal_id"] === "string" &&
    typeof value["client_instance_id"] === "string" &&
    value["client_instance_id"] !== ""
  );
}

export async function startCollaborationCoordinatorServer(
  options: CollaborationCoordinatorServerOptions,
): Promise<CollaborationCoordinatorServer> {
  if (
    options.tls === undefined ||
    options.tls.cert === undefined ||
    options.tls.key === undefined
  ) {
    throw new Error("the coordinator server requires TLS certificate and key material");
  }
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 0;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new Error("coordinator port must be an integer in 0..65535");
  }
  const bodyLimit = options.body_limit_bytes ?? DEFAULT_BODY_LIMIT_BYTES;
  const nowMs = () => Date.parse(options.now?.() ?? new Date().toISOString());

  const flows = new Map<string, FlowEntry>();
  const transportSessions = new Map<string, TransportSession>();
  const sessionCredentials = new Map<string, SessionCredential>();

  function sweep(): void {
    const at = nowMs();
    for (const [id, flow] of flows) {
      if (flow.expiresAt <= at) flows.delete(id);
    }
    for (const [id, session] of transportSessions) {
      if (session.expiresAt <= at) transportSessions.delete(id);
    }
    for (const [token, credential] of sessionCredentials) {
      if (credential.expiresAt <= at) sessionCredentials.delete(token);
    }
  }

  function mintTransportSession(): TransportSession {
    const session: TransportSession = {
      id: randomBytes(32).toString("hex"),
      csrfToken: randomBytes(32).toString("hex"),
      expiresAt: nowMs() + FLOW_RETENTION_MS,
    };
    transportSessions.set(session.id, session);
    return session;
  }

  function mintSessionCredential(principalId: string): string {
    const token = randomBytes(32).toString("hex");
    sessionCredentials.set(token, {
      principal_id: principalId,
      expiresAt: nowMs() + FLOW_RETENTION_MS,
    });
    return token;
  }

  /**
   * Every command and query after connect presents the bearer credential the
   * connect response issued; it is bound in memory to the authenticated
   * principal, so a self-asserted session principal alone cannot impersonate
   * another client (spec §17.1).
   */
  function assertSessionCredential(
    request: IncomingMessage,
    session: CollaborationSession,
  ): boolean {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
    const entry = sessionCredentials.get(header.slice("Bearer ".length));
    return (
      entry !== undefined &&
      entry.expiresAt > nowMs() &&
      entry.principal_id === session.principal_id
    );
  }

  function sessionCookie(session: TransportSession): string {
    const maxAge = Math.max(0, Math.floor((session.expiresAt - nowMs()) / 1000));
    return `${SESSION_COOKIE}=${session.id}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${String(maxAge)}`;
  }

  /** Cookie-bearing browser calls must pass Origin and CSRF checks (spec §17.1). */
  function assertBrowserGuards(
    request: IncomingMessage,
    origin: string,
  ): TransportErrorCode | undefined {
    const originHeader = request.headers.origin;
    if (originHeader !== undefined && originHeader !== origin) return "origin_forbidden";
    const cookieId = cookiesOf(request).get(SESSION_COOKIE);
    if (cookieId === undefined) return undefined;
    const session = transportSessions.get(cookieId);
    if (session === undefined || session.expiresAt <= nowMs()) return "authentication_required";
    const csrf = request.headers[CSRF_HEADER];
    if (typeof csrf !== "string" || !secretEquals(csrf, session.csrfToken)) {
      return "csrf_mismatch";
    }
    return undefined;
  }

  function readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
      const chunks: Buffer[] = [];
      let received = 0;
      let overflowed = false;
      request.on("data", (chunk: Buffer) => {
        if (overflowed) return;
        received += chunk.length;
        if (received > bodyLimit) {
          overflowed = true;
          // Drain the rest of the body so the 413 response still reaches the
          // client on a live socket; destroying the request would reset it.
          request.removeAllListeners("data");
          request.resume();
          rejectPromise(Object.assign(new Error("body_too_large"), { code: "body_too_large" }));
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        if (!overflowed) resolvePromise(Buffer.concat(chunks).toString("utf8"));
      });
      request.on("error", rejectPromise);
    });
  }

  function isBodyTooLarge(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "body_too_large"
    );
  }

  /**
   * The shared request prelude: browser guards, media type, body limit and
   * JSON parsing. On any rejection the transport error is already written and
   * the caller returns without touching the response again.
   */
  async function readValidatedPayload(
    request: IncomingMessage,
    response: ServerResponse,
    origin: string,
  ): Promise<Record<string, unknown> | undefined> {
    sweep();
    const guardFailure = assertBrowserGuards(request, origin);
    if (guardFailure !== undefined) {
      sendTransportError(
        response,
        guardFailure === "authentication_required" ? 401 : 403,
        guardFailure,
      );
      return undefined;
    }
    const contentType = request.headers["content-type"];
    // Media type is case-insensitive and may carry parameters; a bare prefix
    // match would both reject `Application/JSON` and accept `application/jsonx`.
    const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") {
      sendTransportError(response, 415, "unsupported_media_type");
      return undefined;
    }
    let raw: string;
    try {
      raw = await readBody(request);
    } catch (error) {
      if (isBodyTooLarge(error)) {
        sendTransportError(response, 413, "body_too_large");
      } else {
        sendTransportError(response, 400, "bad_request");
      }
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) {
        sendTransportError(response, 400, "bad_request");
        return undefined;
      }
      return parsed;
    } catch {
      sendTransportError(response, 400, "bad_request");
      return undefined;
    }
  }

  /**
   * Connect pre-flight: authenticate the session against the platform (the
   * shared OAuth authorization module), then bind the self-asserted session
   * principal to the authenticated one. An empty principal id asks the
   * transport to bind whatever principal the OAuth flow proves. The effective
   * session is returned alongside the outcome so a successful connect mints
   * its bearer credential for the bound principal.
   */
  async function runConnectFlow(
    platform: PlatformIdentityPort,
    command: ConnectCommand,
    session: CollaborationSession,
  ): Promise<{ outcome: CollaborationOutcome; session: CollaborationSession }> {
    const identity = await platform.discover(command.canonical_remote);
    if (identity.status === "failed") {
      return { outcome: { status: "failed", failure: identity.failure }, session };
    }
    const authenticated = await platform.authenticate({
      provider: identity.identity.provider,
      host: identity.identity.host,
      repository_id: identity.identity.repository_id,
      principal_id: session.principal_id,
    });
    if (authenticated.status === "failed") {
      return { outcome: { status: "failed", failure: authenticated.failure }, session };
    }
    const bound: CollaborationSession =
      session.principal_id === ""
        ? { ...session, principal_id: authenticated.snapshot.principal_id }
        : session;
    return { outcome: await options.coordinator.execute(command, bound), session: bound };
  }

  async function handleCommand(
    request: IncomingMessage,
    response: ServerResponse,
    origin: string,
  ): Promise<void> {
    const payload = await readValidatedPayload(request, response, origin);
    if (payload === undefined) return;
    if (!isValidCommand(payload["command"]) || !isValidSession(payload["session"])) {
      sendTransportError(response, 400, "bad_request");
      return;
    }
    const command = payload["command"];
    const session = payload["session"];
    // Connect is the credential-issuing command; every other command presents
    // the bearer credential bound to its session principal.
    if (command.kind !== "connect" && !assertSessionCredential(request, session)) {
      sendTransportError(response, 401, "authentication_required");
      return;
    }

    const bridge = options.bridge;
    const authorizationWaiter = bridge?.nextAuthorizationRequest();
    const flowId = randomBytes(16).toString("hex");
    const flowPromise: Promise<{
      outcome: CollaborationOutcome;
      session: CollaborationSession;
    }> =
      command.kind === "connect" && options.platform !== undefined
        ? runConnectFlow(options.platform, command, session)
        : options.coordinator.execute(command, session).then((outcome) => ({ outcome, session }));
    const completed = flowPromise.then(
      (executed) => ({
        kind: "outcome" as const,
        outcome: executed.outcome,
        credential:
          command.kind === "connect" && executed.outcome.status === "connected"
            ? mintSessionCredential(executed.session.principal_id)
            : undefined,
      }),
      () => ({
        kind: "outcome" as const,
        outcome: {
          status: "failed" as const,
          failure: collaborationFailure(
            "coordinator_unavailable",
            "the coordinator command failed internally",
            true,
          ),
        },
        credential: undefined,
      }),
    );
    void completed.then((result) => {
      flows.set(flowId, {
        phase: "completed",
        outcome: result.outcome,
        ...(result.credential === undefined ? {} : { credential: result.credential }),
        expiresAt: nowMs() + FLOW_RETENTION_MS,
      });
    });

    const raced = await Promise.race([
      completed,
      ...(authorizationWaiter === undefined
        ? []
        : [
            authorizationWaiter.then(
              (authorization) => ({ kind: "authorization" as const, authorization }),
              () => ({ kind: "authorization_failed" as const }),
            ),
          ]),
    ]);
    if (raced.kind === "outcome") {
      sendJson(response, 200, {
        type: "outcome",
        outcome: raced.outcome,
        ...(raced.credential === undefined ? {} : { session_credential: raced.credential }),
      });
      return;
    }
    if (raced.kind === "authorization_failed") {
      sendTransportError(response, 401, "authentication_required");
      return;
    }
    const authorization = raced.authorization;
    const transportSession = mintTransportSession();
    flows.set(flowId, {
      phase: "awaiting_authorization",
      provider: authorization.provider,
      authorizeUrl: authorization.authorize_url,
      state: authorization.state,
      transportSession,
      expiresAt: nowMs() + FLOW_RETENTION_MS,
    });
    sendJson(response, 401, {
      type: "authentication_required",
      oauth_session_id: flowId,
      authorization_url: `${origin}/oauth/${authorization.provider}/start?flow=${encodeURIComponent(flowId)}`,
    });
  }

  async function handleQuery(
    request: IncomingMessage,
    response: ServerResponse,
    origin: string,
  ): Promise<void> {
    const payload = await readValidatedPayload(request, response, origin);
    if (payload === undefined) return;
    if (!isValidQuery(payload["query"]) || !isValidSession(payload["session"])) {
      sendTransportError(response, 400, "bad_request");
      return;
    }
    const flowId = payload["oauth_session_id"];
    if (flowId !== undefined) {
      if (typeof flowId !== "string") {
        sendTransportError(response, 400, "bad_request");
        return;
      }
      const flow = flows.get(flowId);
      if (flow === undefined) {
        sendTransportError(response, 401, "authentication_required");
        return;
      }
      if (flow.phase === "awaiting_authorization") {
        sendJson(response, 401, {
          type: "authentication_required",
          oauth_session_id: flowId,
          authorization_url: `${origin}/oauth/${flow.provider}/start?flow=${encodeURIComponent(flowId)}`,
        });
        return;
      }
      sendJson(response, 200, {
        type: "outcome",
        outcome: flow.outcome,
        ...(flow.credential === undefined ? {} : { session_credential: flow.credential }),
      });
      return;
    }
    // A plain query presents the bearer credential bound to its principal.
    if (!assertSessionCredential(request, payload["session"])) {
      sendTransportError(response, 401, "authentication_required");
      return;
    }
    const view = await options.coordinator.query(payload["query"], payload["session"]);
    sendJson(response, 200, { type: "view", view });
  }

  function handleOAuth(
    request: IncomingMessage,
    response: ServerResponse,
    match: RegExpExecArray,
    origin: string,
  ): void {
    sweep();
    const provider = match[1] as ProviderName;
    const action = match[2];
    const target = new URL(request.url ?? "/", origin);
    if (action === "start") {
      const flowId = target.searchParams.get("flow") ?? "";
      const flow = flows.get(flowId);
      if (
        flow === undefined ||
        flow.phase !== "awaiting_authorization" ||
        flow.provider !== provider
      ) {
        sendTransportError(response, 404, "not_found");
        return;
      }
      response.writeHead(302, {
        location: flow.authorizeUrl,
        "set-cookie": sessionCookie(flow.transportSession),
      });
      response.end();
      return;
    }
    // callback: the state binds the browser session; both are consumed once.
    const state = target.searchParams.get("state") ?? "";
    const flow = [...flows.values()].find(
      (entry) => entry.phase === "awaiting_authorization" && entry.state === state,
    );
    if (flow !== undefined && flow.phase === "awaiting_authorization") {
      const cookieId = cookiesOf(request).get(SESSION_COOKIE);
      if (cookieId === undefined || !secretEquals(cookieId, flow.transportSession.id)) {
        sendTransportError(response, 401, "authentication_required");
        return;
      }
    }
    const callbackUrl = `${origin}${request.url ?? ""}`;
    if (options.bridge === undefined || !options.bridge.handleCallback(callbackUrl)) {
      sendTransportError(response, 401, "authentication_required");
      return;
    }
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("authorization complete; return to the CLI\n");
  }

  const router = (request: IncomingMessage, response: ServerResponse): void => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : requestedPort;
    const origin = `https://${host.includes(":") ? `[${host}]` : host}:${String(port)}`;
    const path = new URL(request.url ?? "/", origin).pathname;
    const oauthMatch = OAUTH_ROUTE.exec(path);
    const handled = (async (): Promise<void> => {
      if (request.method === "POST" && path === COMMANDS_PATH) {
        await handleCommand(request, response, origin);
        return;
      }
      if (request.method === "POST" && path === QUERIES_PATH) {
        await handleQuery(request, response, origin);
        return;
      }
      if (request.method === "GET" && oauthMatch !== null) {
        handleOAuth(request, response, oauthMatch, origin);
        return;
      }
      sendTransportError(response, 404, "not_found");
    })();
    handled.catch(() => {
      // Internal errors never leak text: token-shaped details stay process-local.
      if (!response.headersSent) {
        sendTransportError(response, 500, "coordinator_unavailable");
      } else {
        response.end();
      }
    });
  };

  const server: Server = createServer({ cert: options.tls.cert, key: options.tls.key }, router);
  server.maxHeadersCount = 64;
  server.requestTimeout = 120_000;
  server.headersTimeout = 10_000;

  const port = await new Promise<number>((resolvePromise, rejectPromise) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      rejectPromise(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        rejectPromise(new Error("coordinator server did not expose a TCP address"));
        return;
      }
      resolvePromise(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(requestedPort, host);
  });

  let closed = false;
  return {
    host,
    port,
    origin: `https://${host.includes(":") ? `[${host}]` : host}:${String(port)}`,
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise((resolvePromise, rejectPromise) => {
        server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error)));
      });
    },
  };
}
