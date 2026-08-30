import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

import type {
  CollaborationConnectionRecord,
  ControlRecord,
  IntegrationRecord,
} from "@universal-harness-internal/core";
import { describe, expect, it } from "vitest";

import { collaborationFailure } from "../../src/collaboration/errors.js";
import type {
  CollaborationCommand,
  CollaborationProjectionRecord,
  CollaborationQuery,
  CollaborationSession,
  CollaborationView,
  ConnectCommand,
  ControlSnapshotResult,
  CoordinatorProjectionPort,
  GitControlStorePort,
  PlatformIdentityPort,
  ProjectionRebuildInput,
} from "../../src/collaboration/index.js";
import { createCollaborationCoordinator } from "../../src/collaboration/index.js";
import {
  HttpCollaborationCoordinatorError,
  createHttpCollaborationCoordinatorAdapter,
  createNodeHttpsFetch,
} from "../../src/collaboration/http-client.js";
import {
  createCoordinatorOAuthBridge,
  startCollaborationCoordinatorServer,
  type CollaborationCoordinatorServer,
} from "../../src/collaboration/http-server.js";

/**
 * HTTPS transport parity and security tests (plan M3 Task 7). The same typed
 * command/query fixtures run against the in-process Coordinator and against an
 * HTTP client adapter fronting the same Coordinator behind `node:https`; both
 * must produce equal typed outcomes. The negative cases pin the transport
 * security contract: canonical HTTPS origins only, JSON content type, body
 * size cap, Origin/CSRF protection, one-time OAuth state and redacted error
 * text. No domain rule is re-implemented or re-tested here — the coordinator
 * unit tests own those.
 */

const digest = (letter: string): string => letter.repeat(64);

const NOW = "2026-08-29T00:00:00.000Z";
const LATER = "2026-08-29T00:05:00.000Z";

const CERT = readFileSync(new URL("./fixtures/localhost-cert.pem", import.meta.url), "utf8");
const KEY = readFileSync(new URL("./fixtures/localhost-key.pem", import.meta.url), "utf8");

const session = (principal_id: string): CollaborationSession => ({
  principal_id,
  client_instance_id: "instance_test",
});

function connectCommand(overrides: Partial<ConnectCommand> = {}): ConnectCommand {
  return {
    kind: "connect",
    command_id: "command_connect_1",
    project_id: "project_demo",
    canonical_remote: "https://github.com/acme/demo.git",
    target_ref: "refs/heads/main",
    coordinator_origin: "https://harness.example.com",
    policy_digest: digest("1"),
    ...overrides,
  };
}

/** Instant-auth fake platform: no OAuth dance, fixed facts. */
function createInstantPlatform(): PlatformIdentityPort {
  return {
    discover(remote) {
      return Promise.resolve({
        status: "resolved",
        identity: {
          provider: "github",
          host: "github.com",
          repository_id: "acme/demo",
          canonical_remote: remote,
          canonical_remote_digest: digest("r"),
        },
      });
    },
    authenticate(input) {
      return Promise.resolve({
        status: "authenticated",
        snapshot: {
          principal_id: input.principal_id,
          provider: input.provider,
          host: input.host,
          subject_id: "1234567",
          repository_id: input.repository_id,
          permission: "maintain",
          observed_at: NOW,
          expires_at: LATER,
          source_response_digest: digest("s"),
        },
      });
    },
    inspectControlRefProtection() {
      return Promise.resolve({ status: "protected" });
    },
  };
}

function createFakeControlStore(): GitControlStorePort & {
  readonly controlRecords: ControlRecord[];
  readonly projectRecords: (CollaborationConnectionRecord | IntegrationRecord)[];
} {
  const controlRecords: ControlRecord[] = [];
  const projectRecords: (CollaborationConnectionRecord | IntegrationRecord)[] = [];
  const headOid = () =>
    controlRecords.length === 0 ? undefined : `oid_control_${controlRecords.length}`;
  return {
    controlRecords,
    projectRecords,
    readControl() {
      const head = headOid();
      const latest = [...projectRecords]
        .reverse()
        .find(
          (record): record is CollaborationConnectionRecord =>
            record.record_kind === "collaboration_connection",
        );
      const snapshot: ControlSnapshotResult = {
        status: "ok",
        snapshot: {
          ...(head === undefined ? {} : { control_head_oid: head }),
          control_records: [...controlRecords],
          ...(latest === undefined ? {} : { latest_connection: latest }),
        },
      };
      return Promise.resolve(snapshot);
    },
    appendControl(input) {
      if (input.expected_head_oid !== headOid()) {
        return Promise.resolve({
          status: "failed" as const,
          failure: collaborationFailure("control_ref_cas_failed", "stale expected head", true),
        });
      }
      controlRecords.push(input.record);
      return Promise.resolve({ status: "appended" as const, head_oid: headOid() as string });
    },
    appendProjectRecord(input) {
      projectRecords.push(input.record);
      return Promise.resolve({
        status: "committed" as const,
        commit: String(projectRecords.length).padStart(16, "0"),
      });
    },
    listOperationHeads() {
      return Promise.resolve({ status: "ok" as const, heads: [] });
    },
    compareAndSwapOperation() {
      return Promise.resolve({
        status: "failed" as const,
        failure: collaborationFailure("coordinator_unavailable", "unused in transport tests"),
      });
    },
    prepareCandidate() {
      return Promise.resolve({
        status: "failed" as const,
        failure: collaborationFailure("coordinator_unavailable", "unused in transport tests"),
      });
    },
    readCandidate() {
      return Promise.resolve({
        status: "failed" as const,
        failure: collaborationFailure("coordinator_unavailable", "unused in transport tests"),
      });
    },
    readIntegrationRecord() {
      return Promise.resolve({
        status: "failed" as const,
        failure: collaborationFailure("coordinator_unavailable", "unused in transport tests"),
      });
    },
    compareAndSwapTarget() {
      return Promise.resolve({
        status: "failed" as const,
        failure: collaborationFailure("coordinator_unavailable", "unused in transport tests"),
      });
    },
  };
}

/** Minimal in-memory projection: enough to serve the four frozen queries. */
function createFakeProjection(): CoordinatorProjectionPort & {
  readonly rebuilds: ProjectionRebuildInput[];
} {
  let connection: CollaborationConnectionRecord | undefined;
  let control: ControlRecord[] = [];
  const rebuilds: ProjectionRebuildInput[] = [];
  return {
    rebuilds,
    rebuild(input) {
      rebuilds.push(input);
      connection = input.latest_connection;
      control = [...input.control_records];
      return Promise.resolve();
    },
    apply(record: CollaborationProjectionRecord) {
      if (record.record_kind === "collaboration_connection") {
        connection = record as CollaborationConnectionRecord;
      } else {
        control = [...control, record as ControlRecord];
      }
      return Promise.resolve();
    },
    query(query: CollaborationQuery): Promise<CollaborationView> {
      switch (query.kind) {
        case "connection_status":
          return Promise.resolve({
            kind: "connection_status",
            project_id: query.project_id,
            status: connection?.status ?? "not_connected",
            ...(connection === undefined ? {} : { connection }),
          });
        case "operations":
          return Promise.resolve({
            kind: "operations",
            project_id: query.project_id,
            operations: [],
          });
        case "approval_inbox":
          return Promise.resolve({
            kind: "approval_inbox",
            project_id: query.project_id,
            decisions: control.filter(
              (record) => record.record_kind === "remote_approval_decision",
            ) as never,
          });
        case "integration_conflicts":
          return Promise.resolve({
            kind: "integration_conflicts",
            project_id: query.project_id,
            conflicts: [],
          });
      }
    },
  };
}

function createHarness(platform: PlatformIdentityPort = createInstantPlatform()) {
  const projection = createFakeProjection();
  const coordinator = createCollaborationCoordinator({
    platform,
    controlStore: createFakeControlStore(),
    projection,
    now: () => NOW,
  });
  return { coordinator, projection, platform };
}

interface RunningServer {
  readonly server: CollaborationCoordinatorServer;
  readonly origin: string;
  close(): Promise<void>;
}

async function startServer(
  harness: ReturnType<typeof createHarness>,
  options: {
    readonly bridge?: ReturnType<typeof createCoordinatorOAuthBridge>;
    readonly withPlatform?: boolean;
  } = {},
): Promise<RunningServer> {
  const server = await startCollaborationCoordinatorServer({
    coordinator: harness.coordinator,
    tls: { cert: CERT, key: KEY },
    host: "127.0.0.1",
    port: 0,
    ...(options.bridge === undefined ? {} : { bridge: options.bridge }),
    ...(options.withPlatform === false ? {} : { platform: harness.platform }),
  });
  return {
    server,
    origin: server.origin,
    close: () => server.close(),
  };
}

interface RawResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/** Raw HTTP(S) request helper for wire-level negative cases. */
function rawRequest(
  transport: "http" | "https",
  method: string,
  url: string,
  options: { readonly headers?: Record<string, string>; readonly body?: string } = {},
): Promise<RawResponse> {
  const target = new URL(url);
  const requestFn = transport === "https" ? httpsRequest : httpRequest;
  return new Promise((resolvePromise, rejectPromise) => {
    const request = requestFn(
      {
        method,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        ...(transport === "https" ? { ca: CERT } : {}),
        headers: options.headers ?? {},
        rejectUnauthorized: transport === "https",
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolvePromise({
            status: response.statusCode ?? 0,
            headers: response.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", rejectPromise);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

const https = (
  method: string,
  url: string,
  options?: { headers?: Record<string, string>; body?: string },
) => rawRequest("https", method, url, options);

describe("collaboration HTTP transport parity", () => {
  it("produces equal typed outcomes and views over in-process and HTTP ports", async () => {
    const local = createHarness();
    const remote = createHarness();
    const running = await startServer(remote);
    try {
      const adapter = createHttpCollaborationCoordinatorAdapter({
        origin: running.origin,
        ca: CERT,
      });
      const commands: CollaborationCommand[] = [
        connectCommand(),
        { kind: "sync_now", command_id: "command_sync_1", project_id: "project_demo" },
        { kind: "disconnect", command_id: "command_disconnect_1", project_id: "project_demo" },
      ];
      for (const command of commands) {
        const localOutcome = await local.coordinator.execute(command, session("principal_alice"));
        const remoteOutcome = await adapter.execute(command, session("principal_alice"));
        expect(remoteOutcome).toEqual(localOutcome);
      }
      const queries: CollaborationQuery[] = [
        { kind: "connection_status", project_id: "project_demo" },
        { kind: "operations", project_id: "project_demo" },
        { kind: "approval_inbox", project_id: "project_demo" },
        { kind: "integration_conflicts", project_id: "project_demo" },
      ];
      for (const query of queries) {
        const localView = await local.coordinator.query(query, session("principal_alice"));
        const remoteView = await adapter.query(query, session("principal_alice"));
        expect(remoteView).toEqual(localView);
      }
      // sync_now rebuilt the disposable projection from authoritative state.
      expect(remote.projection.rebuilds.length).toBeGreaterThan(0);
    } finally {
      await running.close();
    }
  });

  it("keeps typed domain failures identical across the wire", async () => {
    const local = createHarness();
    const remote = createHarness();
    const running = await startServer(remote);
    try {
      const adapter = createHttpCollaborationCoordinatorAdapter({
        origin: running.origin,
        ca: CERT,
      });
      // The transport only serves authenticated sessions: connect first so the
      // adapter holds the bearer credential its later commands present. The
      // in-process port connects too so both sides evaluate the same state.
      const connect = connectCommand({ command_id: "command_connect_failures" });
      await adapter.execute(connect, session("principal_alice"));
      await local.coordinator.execute(connect, session("principal_alice"));
      // Releasing an unknown lease fails closed the same way on both ports.
      const command: CollaborationCommand = {
        kind: "release_operation_lease",
        command_id: "command_release_missing",
        project_id: "project_demo",
        lease_id: "lease_missing",
      };
      expect(await adapter.execute(command, session("principal_alice"))).toEqual(
        await local.coordinator.execute(command, session("principal_alice")),
      );
      expect(await adapter.execute(command, session("principal_alice"))).toMatchObject({
        status: "failed",
      });
      // Invalid coordinator origin inside the command fails identically.
      const invalid = connectCommand({
        command_id: "command_connect_bad_origin",
        coordinator_origin: "http://harness.example.com",
      });
      expect(await adapter.execute(invalid, session("principal_alice"))).toEqual(
        await local.coordinator.execute(invalid, session("principal_alice")),
      );
    } finally {
      await running.close();
    }
  });
});

describe("collaboration HTTP transport security", () => {
  it("rejects non-canonical or plain-HTTP coordinator origins in the client", () => {
    for (const origin of [
      "http://example.com",
      "https://user@example.com",
      "https://example.com?x=1",
      "https://example.com#frag",
      "https://example.com/path",
      "not-a-url",
    ]) {
      expect(() => createHttpCollaborationCoordinatorAdapter({ origin })).toThrow(
        expect.objectContaining({
          code: "invalid_coordinator_origin",
        }) as unknown as Error,
      );
    }
    expect(() =>
      createHttpCollaborationCoordinatorAdapter({ origin: "http://example.com" }),
    ).toThrow(HttpCollaborationCoordinatorError);
  });

  it("refuses to start without TLS material", async () => {
    const harness = createHarness();
    await expect(
      // @ts-expect-error tls is mandatory at the type level; runtime must fail closed too
      startCollaborationCoordinatorServer({ coordinator: harness.coordinator, port: 0 }),
    ).rejects.toThrow(/tls/i);
  });

  it("does not answer plain HTTP on the TLS port", async () => {
    const running = await startServer(createHarness());
    try {
      const httpOrigin = running.origin.replace("https://", "http://");
      await expect(
        rawRequest("http", "POST", `${httpOrigin}/api/v1/collaboration/commands`, { body: "{}" }),
      ).rejects.toThrow();
    } finally {
      await running.close();
    }
  });

  it("rejects non-JSON content types", async () => {
    const running = await startServer(createHarness());
    try {
      const response = await https("POST", `${running.origin}/api/v1/collaboration/commands`, {
        headers: { "content-type": "text/plain" },
        body: "hello",
      });
      expect(response.status).toBe(415);
      expect(JSON.parse(response.body)).toMatchObject({
        type: "error",
        error: "unsupported_media_type",
      });
    } finally {
      await running.close();
    }
  });

  it("rejects media types that only carry an application/json prefix", async () => {
    const running = await startServer(createHarness());
    try {
      for (const contentType of [
        "application/jsonx",
        "application/json-seq",
        "application/JSONP",
      ]) {
        const response = await https("POST", `${running.origin}/api/v1/collaboration/commands`, {
          headers: { "content-type": contentType },
          body: "{}",
        });
        expect(response.status, contentType).toBe(415);
        expect(JSON.parse(response.body)).toMatchObject({
          type: "error",
          error: "unsupported_media_type",
        });
      }
    } finally {
      await running.close();
    }
  });

  it("accepts application/json with parameters or case variants", async () => {
    const running = await startServer(createHarness());
    try {
      for (const contentType of ["application/json; charset=utf-8", "Application/JSON"]) {
        const response = await https("POST", `${running.origin}/api/v1/collaboration/commands`, {
          headers: { "content-type": contentType },
          body: JSON.stringify({ command: connectCommand(), session: session("principal_alice") }),
        });
        expect(response.status, contentType).toBe(200);
        expect(JSON.parse(response.body)).toMatchObject({
          type: "outcome",
          outcome: { status: "connected" },
        });
      }
    } finally {
      await running.close();
    }
  });

  it("rejects oversized bodies", async () => {
    const running = await startServer(createHarness());
    try {
      const response = await https("POST", `${running.origin}/api/v1/collaboration/commands`, {
        headers: { "content-type": "application/json" },
        body: `{"pad":"${"x".repeat(256 * 1024)}"}`,
      });
      expect(response.status).toBe(413);
      expect(JSON.parse(response.body)).toMatchObject({ type: "error", error: "body_too_large" });
    } finally {
      await running.close();
    }
  });

  it("rejects a foreign Origin header", async () => {
    const running = await startServer(createHarness());
    try {
      const response = await https("POST", `${running.origin}/api/v1/collaboration/commands`, {
        headers: { "content-type": "application/json", origin: "https://evil.example.com" },
        body: "{}",
      });
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body)).toMatchObject({
        type: "error",
        error: "origin_forbidden",
      });
    } finally {
      await running.close();
    }
  });

  it("requires a CSRF token on cookie-bearing mutations", async () => {
    const bridge = createCoordinatorOAuthBridge({ now: () => NOW });
    // Drive a connect far enough to mint a browser session cookie: the fake
    // platform asks the bridge for authorization, so the command endpoint
    // answers authentication_required with a flow-bound start URL.
    const deferredPlatform: PlatformIdentityPort = {
      ...createInstantPlatform(),
      authenticate(input) {
        void input;
        return bridge
          .authorize("https://provider.example/authorize?state=state_csrf", "github")
          .then(() => ({
            status: "authenticated" as const,
            snapshot: {
              principal_id: "principal_alice",
              provider: "github" as const,
              host: "github.com",
              subject_id: "1234567",
              repository_id: "acme/demo",
              permission: "maintain" as const,
              observed_at: NOW,
              expires_at: LATER,
              source_response_digest: digest("s"),
            },
          }));
      },
    };
    const running = await startServer(createHarness(deferredPlatform), { bridge });
    try {
      const envelope = await https("POST", `${running.origin}/api/v1/collaboration/commands`, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command: connectCommand(),
          session: session(""),
        }),
      });
      expect(envelope.status).toBe(401);
      const startUrl = (JSON.parse(envelope.body) as { authorization_url: string })
        .authorization_url;
      const started = await https("GET", startUrl);
      expect(started.status).toBe(302);
      const setCookie = started.headers["set-cookie"];
      const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie) ?? "";
      expect(cookie).toMatch(/Secure/u);
      expect(cookie).toMatch(/HttpOnly/u);
      expect(cookie).toMatch(/SameSite=Strict/u);
      // A mutation carrying the cookie but no CSRF token is rejected.
      const mutation = await https("POST", `${running.origin}/api/v1/collaboration/commands`, {
        headers: {
          "content-type": "application/json",
          cookie: cookie.split(";")[0] ?? "",
        },
        body: "{}",
      });
      expect(mutation.status).toBe(403);
      expect(JSON.parse(mutation.body)).toMatchObject({ type: "error", error: "csrf_mismatch" });
      await running.close();
    } finally {
      await running.close();
    }
  });

  it("consumes each OAuth state exactly once", async () => {
    const harness = createHarness();
    const bridge = createCoordinatorOAuthBridge({ now: () => NOW });
    const running = await startServer(harness, { bridge });
    try {
      const authorized = bridge.authorize(
        "https://provider.example/authorize?state=state_once",
        "github",
      );
      const callbackUrl = `${running.origin}/oauth/github/callback?code=code_1&state=state_once`;
      const first = await https("GET", callbackUrl);
      expect(first.status).toBe(200);
      await expect(authorized).resolves.toContain("code=code_1");
      const replayed = await https("GET", callbackUrl);
      expect(replayed.status).toBe(401);
      expect(JSON.parse(replayed.body)).toMatchObject({
        type: "error",
        error: "authentication_required",
      });
      // The callback response never echoes the authorization code.
      expect(first.body).not.toContain("code_1");
    } finally {
      await running.close();
    }
  });

  it("never leaks token-shaped text from internal errors", async () => {
    const leaking = createCollaborationCoordinator({
      platform: createInstantPlatform(),
      controlStore: createFakeControlStore(),
      projection: createFakeProjection(),
      now: () => NOW,
    });
    const crashing = {
      execute(command: CollaborationCommand, sessionArg: CollaborationSession) {
        if (command.kind === "sync_now") {
          throw new Error("upstream said access_token=gho_secretABCDEF123456 in 500 body");
        }
        return leaking.execute(command, sessionArg);
      },
      query: (query: CollaborationQuery, _session: CollaborationSession) =>
        leaking.query(query, _session),
    };
    const running = await startServer({ ...createHarness(), coordinator: crashing });
    try {
      // Connect first: the issued bearer credential authenticates the mutation.
      const connected = await https("POST", `${running.origin}/api/v1/collaboration/commands`, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command: connectCommand(),
          session: session("principal_alice"),
        }),
      });
      expect(connected.status).toBe(200);
      const credential = (JSON.parse(connected.body) as { session_credential?: string })
        .session_credential;
      expect(typeof credential).toBe("string");
      const response = await https("POST", `${running.origin}/api/v1/collaboration/commands`, {
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credential ?? ""}`,
        },
        body: JSON.stringify({
          command: { kind: "sync_now", command_id: "c1", project_id: "project_demo" },
          session: session("principal_alice"),
        }),
      });
      expect(response.status).toBe(500);
      expect(response.body).not.toContain("gho_secretABCDEF123456");
      expect(JSON.parse(response.body)).toMatchObject({
        type: "error",
        error: "coordinator_unavailable",
      });
    } finally {
      await running.close();
    }
  });

  it("requires the connect-issued bearer credential on every later command and query", async () => {
    const running = await startServer(createHarness());
    try {
      const post = (
        path: string,
        body: unknown,
        headers: Record<string, string> = {},
      ): Promise<RawResponse> =>
        https("POST", `${running.origin}${path}`, {
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        });
      // A command without a credential never reaches the coordinator.
      const unauthenticated = await post("/api/v1/collaboration/commands", {
        command: { kind: "sync_now", command_id: "c_unauth", project_id: "project_demo" },
        session: session("principal_alice"),
      });
      expect(unauthenticated.status).toBe(401);
      expect(JSON.parse(unauthenticated.body)).toMatchObject({
        type: "error",
        error: "authentication_required",
      });

      // Connect as alice: the response issues the session credential.
      const connected = await post("/api/v1/collaboration/commands", {
        command: connectCommand(),
        session: session("principal_alice"),
      });
      expect(connected.status).toBe(200);
      const credential = (JSON.parse(connected.body) as { session_credential?: string })
        .session_credential;
      expect(typeof credential).toBe("string");

      // A forged token is rejected.
      const forged = await post(
        "/api/v1/collaboration/commands",
        {
          command: { kind: "sync_now", command_id: "c_forged", project_id: "project_demo" },
          session: session("principal_alice"),
        },
        { authorization: "Bearer forged_token" },
      );
      expect(forged.status).toBe(401);
      expect(JSON.parse(forged.body)).toMatchObject({
        type: "error",
        error: "authentication_required",
      });

      // Alice's credential does not authenticate a self-asserted eve session.
      const impersonated = await post(
        "/api/v1/collaboration/queries",
        {
          query: { kind: "connection_status", project_id: "project_demo" },
          session: session("principal_eve"),
        },
        { authorization: `Bearer ${credential ?? ""}` },
      );
      expect(impersonated.status).toBe(401);

      // The genuine binding is served.
      const genuine = await post(
        "/api/v1/collaboration/queries",
        {
          query: { kind: "connection_status", project_id: "project_demo" },
          session: session("principal_alice"),
        },
        { authorization: `Bearer ${credential ?? ""}` },
      );
      expect(genuine.status).toBe(200);
      expect(JSON.parse(genuine.body)).toMatchObject({ type: "view" });
    } finally {
      await running.close();
    }
  });

  it("rejects an unknown OAuth provider instead of coercing it", async () => {
    const bridge = createCoordinatorOAuthBridge({ now: () => NOW });
    await expect(
      bridge.authorize(
        "https://provider.example/authorize?state=state_unknown",
        "gitlab-enterprise",
      ),
    ).rejects.toThrow(/unsupported oauth provider/u);
  });
});

describe("collaboration HTTP OAuth connect flow", () => {
  it("drives the deferred browser flow and binds the OAuth principal", async () => {
    const bridge = createCoordinatorOAuthBridge({ now: () => NOW });
    // A registry-shaped fake: the first authenticate suspends on the bridge
    // until the browser callback arrives; later calls reuse the live session
    // (the registry token-reuse short-circuit) and answer instantly.
    let authorized = false;
    const authenticatedSnapshot = (principalId: string) => ({
      status: "authenticated" as const,
      snapshot: {
        principal_id: principalId,
        provider: "github" as const,
        host: "github.com",
        subject_id: "1234567",
        repository_id: "acme/demo",
        permission: "maintain" as const,
        observed_at: NOW,
        expires_at: LATER,
        source_response_digest: digest("s"),
      },
    });
    const platform: PlatformIdentityPort = {
      ...createInstantPlatform(),
      authenticate(input) {
        if (authorized) {
          return Promise.resolve(authenticatedSnapshot(input.principal_id));
        }
        return bridge
          .authorize("https://provider.example/authorize?state=state_flow", "github")
          .then(() => {
            authorized = true;
            return authenticatedSnapshot("principal_oauth");
          });
      },
    };
    const harness = createHarness(platform);
    const running = await startServer(harness, { bridge });
    try {
      const adapter = createHttpCollaborationCoordinatorAdapter({
        origin: running.origin,
        ca: CERT,
        poll_interval_ms: 10,
        // The host's browser driver: follow the coordinator-local start URL,
        // then deliver the provider callback bound to the same state.
        authorize: async (authorizationUrl) => {
          const started = await https("GET", authorizationUrl);
          expect(started.status).toBe(302);
          const location = started.headers["location"];
          expect(typeof location).toBe("string");
          const state = new URL(location as string).searchParams.get("state");
          expect(state).toBe("state_flow");
          const cookieHeader = started.headers["set-cookie"];
          const cookie = (Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader) ?? "";
          const callback = await https(
            "GET",
            `${running.origin}/oauth/github/callback?code=code_flow&state=${state ?? ""}`,
            { headers: { cookie: cookie.split(";")[0] ?? "" } },
          );
          expect(callback.status).toBe(200);
        },
      });
      // The CLI cannot know the OAuth principal before connecting; the empty
      // principal asks the transport to bind the authenticated one.
      const outcome = await adapter.execute(connectCommand(), session(""));
      expect(outcome).toMatchObject({
        status: "connected",
        connection: { actor_principal_id: "principal_oauth", status: "active" },
      });
      const view = await adapter.query(
        { kind: "connection_status", project_id: "project_demo" },
        session("principal_oauth"),
      );
      expect(view).toMatchObject({ kind: "connection_status", status: "active" });
    } finally {
      await running.close();
    }
  });
});

describe("node:https platform fetch", () => {
  it("serves the PlatformFetch seam over real TLS", async () => {
    const running = await startServer(createHarness());
    try {
      const fetch = createNodeHttpsFetch({ ca: CERT });
      // Connect first: queries present the issued bearer credential.
      const connected = await fetch({
        method: "POST",
        url: `${running.origin}/api/v1/collaboration/commands`,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command: connectCommand(),
          session: session("principal_alice"),
        }),
      });
      expect(connected.status).toBe(200);
      const credential = (JSON.parse(connected.body) as { session_credential?: string })
        .session_credential;
      expect(typeof credential).toBe("string");
      const response = await fetch({
        method: "POST",
        url: `${running.origin}/api/v1/collaboration/queries`,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credential ?? ""}`,
        },
        body: JSON.stringify({
          query: { kind: "connection_status", project_id: "project_demo" },
          session: session("principal_alice"),
        }),
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({
        type: "view",
        view: { kind: "connection_status", status: "active" },
      });
    } finally {
      await running.close();
    }
  });
});
