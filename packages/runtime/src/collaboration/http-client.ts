import { request as httpsRequest } from "node:https";

import { collaborationFailure, type CollaborationFailure } from "./errors.js";
import { normalizeCoordinatorOrigin } from "./connection.js";
import { OAUTH_SESSION_TTL_MS } from "./oauth-session.js";
import type {
  CollaborationCommand,
  CollaborationCoordinatorPort,
  CollaborationOutcome,
  CollaborationQuery,
  CollaborationSession,
  CollaborationView,
} from "./port.js";
import type {
  PlatformFetch,
  PlatformHttpRequest,
  PlatformHttpResponse,
} from "./platform-adapters.js";

/**
 * Thin HTTPS client for the Coordinator transport (plan M3 Task 7). The
 * adapter serializes the versioned command/query unions, speaks only canonical
 * HTTPS origins, passes typed outcomes/views through untouched and maps
 * transport failures onto the frozen `coordinator_unavailable` /
 * `authentication_required` codes. No permission, Lease, Approval or
 * Integration logic lives here.
 *
 * Deferred OAuth: when the command endpoint answers `authentication_required`
 * with an `oauth_session_id` and `authorization_url`, the adapter invokes the
 * host-injected `authorize` driver (the CLI prints the URL; the Dashboard
 * redirects), then polls a connection-status query bound to the same session
 * id until the server-side flow completes. The provider access token never
 * crosses this boundary.
 */

/** Transport-level error with a frozen collaboration code; never carries server text. */
export class HttpCollaborationCoordinatorError extends Error {
  readonly code: CollaborationFailure["code"];

  constructor(code: CollaborationFailure["code"], summary: string) {
    super(summary);
    this.name = "HttpCollaborationCoordinatorError";
    this.code = code;
  }
}

export interface HttpCollaborationCoordinatorAdapterOptions {
  /** Canonical HTTPS origin of the Coordinator; anything else throws. */
  readonly origin: string;
  /** Host driver for the deferred OAuth browser step (open or print the URL). */
  readonly authorize?: (authorizationUrl: string) => void | Promise<void>;
  /**
   * Bearer credential a previous connect issued; presented on every command
   * and query so the coordinator can bind them to the authenticated
   * principal (spec §17.1).
   */
  readonly session_credential?: string;
  /** Called with the bearer credential each time a connect response issues one. */
  readonly on_session_credential?: (credential: string) => void;
  /** PEM CA/self-signed certificate to trust (self-hosted coordinators). */
  readonly ca?: string;
  readonly poll_interval_ms?: number;
  readonly auth_timeout_ms?: number;
  readonly request_timeout_ms?: number;
  /** Injectable sleep for deterministic tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

interface WireResponse {
  readonly status: number;
  readonly body: string;
}

const COMMANDS_PATH = "/api/v1/collaboration/commands";
const QUERIES_PATH = "/api/v1/collaboration/queries";
const MAX_RESPONSE_BYTES = 1024 * 1024;

interface AuthenticationRequiredEnvelope {
  readonly type: "authentication_required";
  readonly oauth_session_id: string;
  readonly authorization_url: string;
}

function isAuthenticationRequiredEnvelope(value: unknown): value is AuthenticationRequiredEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record["type"] === "authentication_required" &&
    typeof record["oauth_session_id"] === "string" &&
    typeof record["authorization_url"] === "string"
  );
}

function postJson(
  origin: string,
  path: string,
  payload: unknown,
  options: { readonly ca?: string; readonly timeoutMs: number; readonly credential?: string },
): Promise<WireResponse> {
  const target = new URL(origin);
  const body = JSON.stringify(payload);
  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpsRequest(
      {
        method: "POST",
        hostname: target.hostname,
        port: target.port === "" ? "443" : target.port,
        path,
        ca: options.ca,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "content-length": String(Buffer.byteLength(body)),
          ...(options.credential === undefined
            ? {}
            : { authorization: `Bearer ${options.credential}` }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_RESPONSE_BYTES) {
            request.destroy(new Error("coordinator response exceeded the size limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolvePromise({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new Error("coordinator request timed out"));
    });
    request.on("error", rejectPromise);
    request.write(body);
    request.end();
  });
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function unavailable(summary: string): CollaborationOutcome {
  return {
    status: "failed",
    failure: collaborationFailure("coordinator_unavailable", summary, true),
  };
}

/**
 * Map a typed transport error envelope onto a failed outcome; only the frozen
 * `authentication_required` code survives, everything else collapses onto
 * `coordinator_unavailable` (retryable). Returns undefined for non-envelopes.
 */
function failureFromErrorEnvelope(
  record: Record<string, unknown> | undefined,
  summaryPrefix: string,
): CollaborationOutcome | undefined {
  if (record?.["type"] !== "error") return undefined;
  const code =
    record["error"] === "authentication_required"
      ? "authentication_required"
      : "coordinator_unavailable";
  return {
    status: "failed",
    failure: collaborationFailure(
      code,
      `${summaryPrefix}: ${String(record["error"])}`,
      code === "coordinator_unavailable",
    ),
  };
}

/**
 * Real `node:https` implementation of the injected `PlatformFetch` seam (plan
 * M3 Task 7). Host-owned; never persists or logs request/response material.
 */
export function createNodeHttpsFetch(
  options: { readonly ca?: string; readonly timeout_ms?: number } = {},
): PlatformFetch {
  const timeoutMs = options.timeout_ms ?? 15_000;
  return (request: PlatformHttpRequest): Promise<PlatformHttpResponse> => {
    const target = new URL(request.url);
    return new Promise((resolvePromise, rejectPromise) => {
      const wire = httpsRequest(
        {
          method: request.method,
          hostname: target.hostname,
          port: target.port === "" ? "443" : target.port,
          path: `${target.pathname}${target.search}`,
          ca: options.ca,
          headers: { ...request.headers },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let received = 0;
          response.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > MAX_RESPONSE_BYTES) {
              wire.destroy(new Error("platform response exceeded the size limit"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () =>
            resolvePromise({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      wire.setTimeout(timeoutMs, () => {
        wire.destroy(new Error("platform request timed out"));
      });
      wire.on("error", rejectPromise);
      if (request.body !== undefined) wire.write(request.body);
      wire.end();
    });
  };
}

export function createHttpCollaborationCoordinatorAdapter(
  options: HttpCollaborationCoordinatorAdapterOptions,
): CollaborationCoordinatorPort {
  const normalized = normalizeCoordinatorOrigin(options.origin);
  if (normalized.status === "failed") {
    throw new HttpCollaborationCoordinatorError(
      normalized.failure.code,
      normalized.failure.summary,
    );
  }
  const origin = normalized.origin;
  const timeoutMs = options.request_timeout_ms ?? 30_000;
  const pollIntervalMs = options.poll_interval_ms ?? 1_000;
  const authTimeoutMs = options.auth_timeout_ms ?? OAUTH_SESSION_TTL_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let sessionCredential = options.session_credential;

  /** Capture the bearer credential a connect response (or its poll) issued. */
  function captureSessionCredential(record: Record<string, unknown> | undefined): void {
    const credential = record?.["session_credential"];
    if (typeof credential === "string" && credential !== "") {
      sessionCredential = credential;
      options.on_session_credential?.(credential);
    }
  }

  async function post(
    path: string,
    payload: unknown,
  ): Promise<{ readonly status: number; readonly json: unknown }> {
    let response: WireResponse;
    try {
      response = await postJson(origin, path, payload, {
        ...(options.ca === undefined ? {} : { ca: options.ca }),
        timeoutMs,
        ...(sessionCredential === undefined ? {} : { credential: sessionCredential }),
      });
    } catch (error) {
      throw new HttpCollaborationCoordinatorError(
        "coordinator_unavailable",
        `coordinator request failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    return { status: response.status, json: parseJson(response.body) };
  }

  /** Poll the connection-status query bound to a deferred OAuth flow. */
  async function pollFlow(
    command: CollaborationCommand,
    session: CollaborationSession,
    envelope: AuthenticationRequiredEnvelope,
  ): Promise<CollaborationOutcome> {
    const deadline = Date.now() + authTimeoutMs;
    let current = envelope;
    for (;;) {
      if (Date.now() > deadline) {
        return {
          status: "failed",
          failure: collaborationFailure(
            "authentication_required",
            "oauth authorization did not complete before the session expired",
          ),
        };
      }
      await sleep(pollIntervalMs);
      let response: { readonly status: number; readonly json: unknown };
      try {
        response = await post(QUERIES_PATH, {
          query: { kind: "connection_status", project_id: command.project_id },
          session,
          oauth_session_id: current.oauth_session_id,
        });
      } catch (error) {
        if (error instanceof HttpCollaborationCoordinatorError) {
          return {
            status: "failed",
            failure: collaborationFailure(error.code, error.message, true),
          };
        }
        throw error;
      }
      if (isAuthenticationRequiredEnvelope(response.json)) {
        current = response.json;
        continue;
      }
      const record = response.json as Record<string, unknown> | undefined;
      if (response.status === 200 && record?.["type"] === "outcome") {
        captureSessionCredential(record);
        return record["outcome"] as CollaborationOutcome;
      }
      const flowFailure = failureFromErrorEnvelope(record, "oauth flow ended with");
      if (flowFailure !== undefined) return flowFailure;
      return unavailable("coordinator returned an unexpected response to the oauth poll");
    }
  }

  return {
    async execute(command: CollaborationCommand, session: CollaborationSession) {
      let response: { readonly status: number; readonly json: unknown };
      try {
        response = await post(COMMANDS_PATH, { command, session });
      } catch (error) {
        if (error instanceof HttpCollaborationCoordinatorError) {
          return {
            status: "failed",
            failure: collaborationFailure(error.code, error.message, true),
          };
        }
        throw error;
      }
      const record = response.json as Record<string, unknown> | undefined;
      if (response.status === 200 && record?.["type"] === "outcome") {
        captureSessionCredential(record);
        return record["outcome"] as CollaborationOutcome;
      }
      if (isAuthenticationRequiredEnvelope(response.json)) {
        if (options.authorize === undefined) {
          return {
            status: "failed",
            failure: collaborationFailure(
              "authentication_required",
              "the coordinator requires oauth authorization but no authorize driver is configured",
            ),
          };
        }
        await options.authorize(response.json.authorization_url);
        return pollFlow(command, session, response.json);
      }
      const commandFailure = failureFromErrorEnvelope(
        record,
        "coordinator transport rejected the command",
      );
      if (commandFailure !== undefined) return commandFailure;
      return unavailable("coordinator returned an unexpected response");
    },

    async query(
      query: CollaborationQuery,
      session: CollaborationSession,
    ): Promise<CollaborationView> {
      const response = await post(QUERIES_PATH, { query, session });
      const record = response.json as Record<string, unknown> | undefined;
      if (response.status === 200 && record?.["type"] === "view") {
        return record["view"] as CollaborationView;
      }
      const queryFailure = failureFromErrorEnvelope(record, "the coordinator rejected the query");
      if (queryFailure !== undefined && queryFailure.status === "failed") {
        throw new HttpCollaborationCoordinatorError(
          queryFailure.failure.code,
          queryFailure.failure.summary,
        );
      }
      throw new HttpCollaborationCoordinatorError(
        "coordinator_unavailable",
        "the coordinator query failed",
      );
    },
  };
}
