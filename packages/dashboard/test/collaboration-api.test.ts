import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";
import {
  buildCollaborationRecord,
  canonicalizeJson,
  type CollaborationConnectionRecord,
  type IntegrationRecord,
  type RemoteApprovalDecisionRecord,
} from "@universal-harness-internal/core";
import {
  HttpCollaborationCoordinatorError,
  createNewProject,
  type CollaborationCoordinatorPort,
  type CollaborationOutcome,
  type CollaborationView,
} from "@universal-harness-internal/runtime";

import { startDashboardServer, type DashboardServer } from "../src/index.js";
import {
  createDashboardCollaborationApi,
  type DashboardCollaborationApi,
} from "../src/collaboration-api.js";

const servers: DashboardServer[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function project(name = "dashboard-collaboration"): Promise<string> {
  const parent = mkdtempSync(join(tmpdir(), "harness-dashboard-collab-"));
  roots.push(parent);
  const created = await createNewProject(
    { parentDirectory: parent, name, intent: "observe remote collaboration state" },
    { vcs: createGitVcsAdapter() },
  );
  if (!created.ok) throw new Error(created.error.message);
  return created.value.projectRoot;
}

/** Commit-shape fixture values; digests only need the schema's hex shape. */
const digest = (fill: string): string => fill.repeat(64).slice(0, 64);
const commit = (fill: string): string => fill.repeat(40).slice(0, 40);

function connectionRecord(
  projectRoot: string,
  revision: number,
  status: "active" | "disconnected" = "active",
  options: { readonly connectionId?: string; readonly effectiveAt?: string } = {},
): CollaborationConnectionRecord {
  const projectId = `project_${basename(projectRoot)}`;
  return buildCollaborationRecord({
    record_kind: "collaboration_connection",
    connection_id: options.connectionId ?? "connection_dashboard_fixture",
    project_id: projectId,
    revision,
    status,
    provider: "github",
    repository_id: "octo/dashboard",
    canonical_remote: "https://github.com/octo/dashboard.git",
    canonical_remote_digest: digest("a"),
    coordinator_origin: "https://coordinator.example.test",
    target_ref: "refs/heads/main",
    control_ref: "harness/control",
    policy_digest: digest("b"),
    actor_principal_id: "principal_reviewer",
    principal_snapshot_digest: digest("c"),
    command_id: `command_connect_rev_${String(revision)}`,
    effective_at: options.effectiveAt ?? "2026-08-29T00:00:00.000Z",
    ...(revision > 1 ? { supersedes_digest: digest("d") } : {}),
  });
}

/** Write a connection record into the local project Ledger tree. */
function seedConnection(projectRoot: string, record: CollaborationConnectionRecord): void {
  const directory = join(
    projectRoot,
    ".harness",
    "collaboration",
    "connections",
    record.connection_id,
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `rev-${String(record.revision).padStart(12, "0")}.json`),
    `${canonicalizeJson(record)}\n`,
    "utf8",
  );
}

function remoteDecision(): RemoteApprovalDecisionRecord {
  return buildCollaborationRecord({
    record_kind: "remote_approval_decision",
    control_sequence: 7,
    previous_control_record_digest: digest("e"),
    remote_decision_id: "remote_decision_fixture",
    request_id: "approval_req_fixture",
    operation_id: "operation_fixture",
    object_id: "requirement_fixture",
    object_digest: digest("f"),
    policy_digest: digest("b"),
    decision: "approve",
    principal_snapshot_digest: digest("c"),
    required_permission: "maintain",
    decided_at: "2026-08-29T01:00:00.000Z",
    command_id: "command_remote_decision",
  });
}

function integrationConflict(): IntegrationRecord {
  return buildCollaborationRecord({
    record_kind: "integration",
    integration_id: "integration_fixture",
    operation_id: "operation_fixture",
    expected_target_commit: commit("1"),
    operation_commit: commit("2"),
    lease_fencing_token: 3,
    ledger_sequence_rewrites: [],
    evidence_digests: [],
    approval_decision_digests: [],
    command_id: "command_prepare_fixture",
  });
}

interface FakeCoordinator {
  readonly port: CollaborationCoordinatorPort;
  readonly queries: string[];
  readonly commands: string[];
}

function fakeCoordinator(handlers: {
  readonly query?: (kind: string) => CollaborationView;
  readonly execute?: (kind: string) => CollaborationOutcome;
}): FakeCoordinator {
  const queries: string[] = [];
  const commands: string[] = [];
  const port: CollaborationCoordinatorPort = {
    query: (query) => {
      queries.push(query.kind);
      const view = handlers.query?.(query.kind);
      if (view === undefined) {
        return Promise.reject(
          new HttpCollaborationCoordinatorError("coordinator_unavailable", "no view faked"),
        );
      }
      return Promise.resolve(view);
    },
    execute: (command) => {
      commands.push(command.kind);
      const outcome = handlers.execute?.(command.kind);
      if (outcome === undefined) {
        return Promise.reject(
          new HttpCollaborationCoordinatorError("coordinator_unavailable", "no outcome faked"),
        );
      }
      return Promise.resolve(outcome);
    },
  };
  return { port, queries, commands };
}

interface Harness {
  readonly server: DashboardServer;
  readonly cookie: string;
  readonly origins: string[];
  readonly fake: FakeCoordinator;
}

async function startHarness(options: {
  readonly projectRoot: string;
  readonly fake?: FakeCoordinator;
  readonly now?: () => string;
}): Promise<Harness> {
  const origins: string[] = [];
  const fake = options.fake ?? fakeCoordinator({});
  const collaborationApi: DashboardCollaborationApi = createDashboardCollaborationApi({
    projectRoot: options.projectRoot,
    now: options.now ?? (() => "2026-08-29T12:00:00.000Z"),
    newCommandId: (() => {
      let sequence = 0;
      return () => `command_dashboard_${(sequence += 1)}`;
    })(),
    portForOrigin: (origin) => {
      origins.push(origin);
      return fake.port;
    },
  });
  const server = await startDashboardServer({
    projectRoot: options.projectRoot,
    collaborationApi,
  });
  servers.push(server);
  const exchange = await fetch(server.bootstrapUrl, { redirect: "manual" });
  const cookie = (exchange.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
  return { server, cookie, origins, fake };
}

async function getJson(harness: Harness, path: string): Promise<unknown> {
  const response = await fetch(`${harness.server.origin}${path}`, {
    headers: { cookie: harness.cookie },
  });
  return ((await response.json()) as { data: unknown }).data;
}

async function postJson(
  harness: Harness,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ readonly status: number; readonly json: Record<string, unknown> }> {
  const session = await fetch(`${harness.server.origin}/api/v1/session`, {
    headers: { cookie: harness.cookie },
  });
  const csrf = ((await session.json()) as { data: { csrf_token: string } }).data.csrf_token;
  const response = await fetch(`${harness.server.origin}${path}`, {
    method: "POST",
    headers: {
      cookie: harness.cookie,
      origin: harness.server.origin,
      "content-type": "application/json",
      "x-harness-csrf": csrf,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe("Dashboard collaboration API", () => {
  it("reports a never-connected project from the local Ledger with zero remote calls", async () => {
    const projectRoot = await project();
    const harness = await startHarness({ projectRoot });

    expect(await getJson(harness, "/api/v1/collaboration/connection")).toMatchObject({
      authority: "project_ledger",
      status: "not_connected",
    });
    expect(harness.origins).toEqual([]);
    expect(harness.fake.queries).toEqual([]);

    const approvals = await fetch(`${harness.server.origin}/api/v1/collaboration/approvals`, {
      headers: { cookie: harness.cookie },
    });
    expect(approvals.status).toBe(404);
    await expect(approvals.json()).resolves.toMatchObject({
      code: "collaboration_not_connected",
    });
    expect(harness.fake.queries).toEqual([]);
  });

  it("reports a disconnected connection from the local Ledger without remote calls", async () => {
    const projectRoot = await project();
    seedConnection(projectRoot, connectionRecord(projectRoot, 2, "disconnected"));
    seedConnection(projectRoot, connectionRecord(projectRoot, 1));
    const harness = await startHarness({ projectRoot });

    expect(await getJson(harness, "/api/v1/collaboration/connection")).toMatchObject({
      authority: "project_ledger",
      status: "disconnected",
      connection: { revision: 2, status: "disconnected" },
    });
    expect(harness.origins).toEqual([]);
  });

  it("combines the Ledger connection fact with the observed coordinator status", async () => {
    const projectRoot = await project();
    const connection = connectionRecord(projectRoot, 1);
    seedConnection(projectRoot, connection);
    const fake = fakeCoordinator({
      query: (kind) => {
        if (kind !== "connection_status") throw new Error(`unexpected query ${kind}`);
        return {
          kind: "connection_status",
          project_id: connection.project_id,
          status: "active",
          connection,
        };
      },
    });
    const harness = await startHarness({ projectRoot, fake });

    const view = (await getJson(harness, "/api/v1/collaboration/connection")) as {
      remote?: Record<string, unknown>;
    };
    expect(view).toMatchObject({ authority: "project_ledger", status: "active" });
    expect(view.remote).toMatchObject({
      authority: "control_ref",
      projection_observed_at: "2026-08-29T12:00:00.000Z",
      status: "active",
    });
    expect(harness.origins).toEqual(["https://coordinator.example.test"]);
  });

  it("marks the remote view stale when the Ledger carries a newer connection revision", async () => {
    const projectRoot = await project();
    const older = connectionRecord(projectRoot, 1);
    seedConnection(projectRoot, older);
    seedConnection(projectRoot, connectionRecord(projectRoot, 2));
    const fake = fakeCoordinator({
      query: () => ({
        kind: "connection_status",
        project_id: older.project_id,
        status: "active",
        connection: older,
      }),
    });
    const harness = await startHarness({ projectRoot, fake });

    const view = (await getJson(harness, "/api/v1/collaboration/connection")) as {
      remote?: Record<string, unknown>;
    };
    expect(view).toMatchObject({ status: "active", connection: { revision: 2 } });
    expect(view.remote).toMatchObject({ status: "active", stale: true });
  });

  it("degrades the remote status to unreachable without failing the Ledger fact", async () => {
    const projectRoot = await project();
    seedConnection(projectRoot, connectionRecord(projectRoot, 1));
    const harness = await startHarness({ projectRoot });

    const view = (await getJson(harness, "/api/v1/collaboration/connection")) as {
      remote?: Record<string, unknown>;
    };
    expect(view).toMatchObject({ authority: "project_ledger", status: "active" });
    expect(view.remote).toMatchObject({ status: "unreachable" });
  });

  it("serves the remote approval inbox as Control Ref facts with a projection timestamp", async () => {
    const projectRoot = await project();
    const connection = connectionRecord(projectRoot, 1);
    seedConnection(projectRoot, connection);
    const fake = fakeCoordinator({
      query: (kind) => {
        if (kind !== "approval_inbox") throw new Error(`unexpected query ${kind}`);
        return {
          kind: "approval_inbox",
          project_id: connection.project_id,
          decisions: [remoteDecision()],
        };
      },
    });
    const harness = await startHarness({ projectRoot, fake });

    const inbox = (await getJson(harness, "/api/v1/collaboration/approvals")) as {
      decisions: Record<string, unknown>[];
    };
    expect(inbox).toMatchObject({
      authority: "control_ref",
      projection_observed_at: "2026-08-29T12:00:00.000Z",
    });
    expect(inbox.decisions).toHaveLength(1);
    expect(inbox.decisions[0]).toMatchObject({
      request_id: "approval_req_fixture",
      decision: "approve",
    });
    expect(harness.fake.queries).toEqual(["approval_inbox"]);
  });

  it("redacts credential-shaped fields from remote views", async () => {
    const projectRoot = await project();
    const connection = connectionRecord(projectRoot, 1);
    seedConnection(projectRoot, connection);
    const poisoned = {
      ...remoteDecision(),
      access_token: "gho_should_never_render",
      session_credential: "deadbeef",
    } as unknown as RemoteApprovalDecisionRecord;
    const fake = fakeCoordinator({
      query: () => ({
        kind: "approval_inbox",
        project_id: connection.project_id,
        decisions: [poisoned],
      }),
    });
    const harness = await startHarness({ projectRoot, fake });

    const inbox = (await getJson(harness, "/api/v1/collaboration/approvals")) as {
      decisions: Record<string, unknown>[];
    };
    expect(inbox.decisions[0]).not.toHaveProperty("access_token");
    expect(inbox.decisions[0]).not.toHaveProperty("session_credential");
    expect(JSON.stringify(inbox)).not.toContain("gho_should_never_render");
  });

  it("serves integration conflicts and retries one through the coordinator", async () => {
    const projectRoot = await project();
    const connection = connectionRecord(projectRoot, 1);
    seedConnection(projectRoot, connection);
    const conflict = integrationConflict();
    const fake = fakeCoordinator({
      query: (kind) => {
        if (kind !== "integration_conflicts") throw new Error(`unexpected query ${kind}`);
        return {
          kind: "integration_conflicts",
          project_id: connection.project_id,
          conflicts: [conflict],
        };
      },
      execute: (kind) => {
        if (kind !== "accept_integration") throw new Error(`unexpected command ${kind}`);
        return {
          status: "accepted",
          integration_record: conflict,
          target_commit: commit("3"),
          replayed: false,
        };
      },
    });
    const harness = await startHarness({ projectRoot, fake });

    const conflicts = (await getJson(harness, "/api/v1/collaboration/conflicts")) as {
      conflicts: Record<string, unknown>[];
    };
    expect(conflicts).toMatchObject({
      authority: "control_ref",
      projection_observed_at: "2026-08-29T12:00:00.000Z",
    });
    expect(conflicts.conflicts).toHaveLength(1);
    expect(conflicts.conflicts[0]).toMatchObject({ integration_id: "integration_fixture" });

    const retried = await postJson(
      harness,
      "/api/v1/collaboration/integrations/integration_fixture/retry",
      {},
    );
    expect(retried.status).toBe(200);
    expect(retried.json["data"]).toMatchObject({
      authority: "control_ref",
      integration_id: "integration_fixture",
      target_commit: commit("3"),
    });
    expect(harness.fake.commands).toEqual(["accept_integration"]);
  });

  it("submits a remote approval decision through the coordinator command seam", async () => {
    const projectRoot = await project();
    const connection = connectionRecord(projectRoot, 1);
    seedConnection(projectRoot, connection);
    const decision = remoteDecision();
    const fake = fakeCoordinator({
      execute: (kind) => {
        if (kind !== "submit_remote_approval") throw new Error(`unexpected command ${kind}`);
        return { status: "remote_approval", decision, replayed: false };
      },
    });
    const harness = await startHarness({ projectRoot, fake });

    const submitted = await postJson(
      harness,
      "/api/v1/collaboration/approvals/approval_req_fixture/decision",
      { decision: "approve" },
    );
    expect(submitted.status).toBe(200);
    expect(submitted.json["data"]).toMatchObject({
      authority: "control_ref",
      projection_observed_at: "2026-08-29T12:00:00.000Z",
      decision: { request_id: "approval_req_fixture", decision: "approve" },
    });
    expect(harness.fake.commands).toEqual(["submit_remote_approval"]);
  });

  it("maps coordinator failures onto typed problems", async () => {
    const projectRoot = await project();
    seedConnection(projectRoot, connectionRecord(projectRoot, 1));
    const conflict = integrationConflict();
    const failing: CollaborationCoordinatorPort = {
      query: (query) => {
        if (query.kind === "integration_conflicts") {
          return Promise.resolve({
            kind: "integration_conflicts",
            project_id: query.project_id,
            conflicts: [conflict],
          });
        }
        return Promise.reject(
          new HttpCollaborationCoordinatorError(
            "authentication_required",
            "the coordinator session expired",
          ),
        );
      },
      execute: () =>
        Promise.resolve({
          status: "failed",
          failure: {
            code: "integration_conflict",
            summary: "the candidate no longer merges",
            retryable: false,
          },
        }),
    };
    const origins: string[] = [];
    const collaborationApi = createDashboardCollaborationApi({
      projectRoot,
      portForOrigin: (origin) => {
        origins.push(origin);
        return failing;
      },
    });
    const server = await startDashboardServer({ projectRoot, collaborationApi });
    servers.push(server);
    const exchange = await fetch(server.bootstrapUrl, { redirect: "manual" });
    const cookie = (exchange.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";

    const inbox = await fetch(`${server.origin}/api/v1/collaboration/approvals`, {
      headers: { cookie },
    });
    expect(inbox.status).toBe(503);
    await expect(inbox.json()).resolves.toMatchObject({ code: "authentication_required" });

    const session = await fetch(`${server.origin}/api/v1/session`, { headers: { cookie } });
    const csrf = ((await session.json()) as { data: { csrf_token: string } }).data.csrf_token;
    const retried = await fetch(
      `${server.origin}/api/v1/collaboration/integrations/integration_fixture/retry`,
      {
        method: "POST",
        headers: {
          cookie,
          origin: server.origin,
          "content-type": "application/json",
          "x-harness-csrf": csrf,
        },
        body: JSON.stringify({}),
      },
    );
    expect(retried.status).toBe(409);
    await expect(retried.json()).resolves.toMatchObject({ code: "integration_conflict" });
  });

  it("requires the exact Origin and the session CSRF token on collaboration writes", async () => {
    const projectRoot = await project();
    seedConnection(projectRoot, connectionRecord(projectRoot, 1));
    const harness = await startHarness({ projectRoot });
    const path = "/api/v1/collaboration/approvals/approval_req_fixture/decision";

    const noOrigin = await fetch(`${harness.server.origin}${path}`, {
      method: "POST",
      headers: { cookie: harness.cookie, "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(noOrigin.status).toBe(403);
    await expect(noOrigin.json()).resolves.toMatchObject({ code: "origin_mismatch" });

    const session = await fetch(`${harness.server.origin}/api/v1/session`, {
      headers: { cookie: harness.cookie },
    });
    const csrf = ((await session.json()) as { data: { csrf_token: string } }).data.csrf_token;
    const noCsrf = await fetch(`${harness.server.origin}${path}`, {
      method: "POST",
      headers: {
        cookie: harness.cookie,
        origin: harness.server.origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(noCsrf.status).toBe(403);
    await expect(noCsrf.json()).resolves.toMatchObject({ code: "csrf_mismatch" });
    expect(csrf).toMatch(/^[a-f0-9]{64}$/u);
    expect(harness.fake.commands).toEqual([]);
  });

  it("rejects unknown collaboration decision values before reaching the coordinator", async () => {
    const projectRoot = await project();
    seedConnection(projectRoot, connectionRecord(projectRoot, 1));
    const harness = await startHarness({ projectRoot });

    const rejected = await postJson(
      harness,
      "/api/v1/collaboration/approvals/approval_req_fixture/decision",
      { decision: "shipit" },
    );
    expect(rejected.status).toBe(400);
    expect(rejected.json).toMatchObject({ code: "invalid_write" });
    expect(harness.fake.commands).toEqual([]);
  });

  it("keeps lease_fencing_token in conflict views; only exact credential keys are redacted", async () => {
    const projectRoot = await project();
    const connection = connectionRecord(projectRoot, 1);
    seedConnection(projectRoot, connection);
    const fake = fakeCoordinator({
      query: () => ({
        kind: "integration_conflicts",
        project_id: connection.project_id,
        conflicts: [integrationConflict()],
      }),
    });
    const harness = await startHarness({ projectRoot, fake });

    const conflicts = (await getJson(harness, "/api/v1/collaboration/conflicts")) as {
      conflicts: Record<string, unknown>[];
    };
    expect(conflicts.conflicts[0]).toMatchObject({
      integration_id: "integration_fixture",
      lease_fencing_token: 3,
    });
  });

  it("picks the active connection per connection id instead of the highest revision overall", async () => {
    const projectRoot = await project();
    // Old repository connection: disconnected at a high revision.
    seedConnection(
      projectRoot,
      connectionRecord(projectRoot, 1, "active", { connectionId: "connection_old_repo" }),
    );
    seedConnection(
      projectRoot,
      connectionRecord(projectRoot, 2, "disconnected", {
        connectionId: "connection_old_repo",
        effectiveAt: "2026-08-29T02:00:00.000Z",
      }),
    );
    // Reconnect to a new repository: revision restarts at 1.
    seedConnection(
      projectRoot,
      connectionRecord(projectRoot, 1, "active", {
        connectionId: "connection_new_repo",
        effectiveAt: "2026-08-29T03:00:00.000Z",
      }),
    );
    const fake = fakeCoordinator({
      query: (kind) => {
        if (kind !== "connection_status") throw new Error(`unexpected query ${kind}`);
        return {
          kind: "connection_status",
          project_id: `project_${basename(projectRoot)}`,
          status: "active",
        };
      },
    });
    const harness = await startHarness({ projectRoot, fake });

    expect(await getJson(harness, "/api/v1/collaboration/connection")).toMatchObject({
      authority: "project_ledger",
      status: "active",
      connection: { connection_id: "connection_new_repo", revision: 1 },
    });
  });

  it("fails closed with a typed problem when the connections tree holds a non-directory", async () => {
    const projectRoot = await project();
    const stray = join(projectRoot, ".harness", "collaboration", "connections");
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, "stray-file.json"), "{}\n", "utf8");
    const harness = await startHarness({ projectRoot });

    const response = await fetch(`${harness.server.origin}/api/v1/collaboration/connection`, {
      headers: { cookie: harness.cookie },
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "collaboration_ledger_invalid",
    });
  });

  it("propagates coordinator protocol violations instead of degrading to unreachable", async () => {
    const projectRoot = await project();
    const connection = connectionRecord(projectRoot, 1);
    seedConnection(projectRoot, connection);
    const fake = fakeCoordinator({
      // Wrong view kind: a protocol violation, not a transport failure.
      query: () => ({
        kind: "approval_inbox",
        project_id: connection.project_id,
        decisions: [],
      }),
    });
    const harness = await startHarness({ projectRoot, fake });

    const response = await fetch(`${harness.server.origin}/api/v1/collaboration/connection`, {
      headers: { cookie: harness.cookie },
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "coordinator_unavailable" });
  });

  it("degrades raw network errors to unreachable while keeping the Ledger fact", async () => {
    const projectRoot = await project();
    seedConnection(projectRoot, connectionRecord(projectRoot, 1));
    const failing: CollaborationCoordinatorPort = {
      query: () =>
        Promise.reject(Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" })),
      execute: () =>
        Promise.reject(Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" })),
    };
    const server = await startDashboardServer({
      projectRoot,
      collaborationApi: createDashboardCollaborationApi({
        projectRoot,
        portForOrigin: () => failing,
      }),
    });
    servers.push(server);
    const exchange = await fetch(server.bootstrapUrl, { redirect: "manual" });
    const cookie = (exchange.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";

    const response = await fetch(`${server.origin}/api/v1/collaboration/connection`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    const view = ((await response.json()) as { data: { remote?: Record<string, unknown> } }).data;
    expect(view).toMatchObject({ authority: "project_ledger", status: "active" });
    expect(view.remote).toMatchObject({ status: "unreachable" });
  });
});
