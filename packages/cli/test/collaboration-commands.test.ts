import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPackLock,
  createProjectManifest,
  initializeManagedLayout,
  type CollaborationConnectionRecord,
  type RemoteApprovalDecisionRecord,
} from "@universal-harness-internal/core";
import type {
  CollaborationCommand,
  CollaborationOutcome,
  CollaborationQuery,
  CollaborationSession,
  CollaborationView,
  CollaborationCoordinatorPort,
} from "@universal-harness-internal/runtime";

import {
  EXIT_CODES,
  createOrchestratedRuntimeService,
  createStubRuntimeService,
  runCli,
  type CliIo,
  type ConnectRequest,
  type CoordinatorHostRequest,
  type DisconnectRequest,
  type IntegrateRequest,
  type SyncRequest,
} from "../src/index.js";
import { serializeCollaborationClientState } from "../src/runtime/collaboration-client.js";

/**
 * CLI contract tests for the M3 remote collaboration commands (plan Task 7
 * steps 4-5): the routes parse flags, delegate to the typed runtime facade and
 * reject malformed invocations with the usage exit code. Remote routing (an
 * active cached connection switches approve/iterate/sync onto the Coordinator
 * port) is pinned here with a recording port; every domain rule stays in the
 * runtime coordinator tests.
 */

const NOW = "2026-08-29T00:00:00.000Z";
const digest = (letter: string): string => letter.repeat(64);

const CONNECTION: CollaborationConnectionRecord = {
  protocol_version: "1.2.0",
  record_kind: "collaboration_connection",
  connection_id: "connection_01",
  project_id: "project_demo",
  revision: 1,
  status: "active",
  provider: "github",
  repository_id: "acme/demo",
  canonical_remote: "https://github.com/acme/demo",
  canonical_remote_digest: digest("a"),
  coordinator_origin: "https://coordinator.example.com",
  target_ref: "refs/heads/main",
  control_ref: "refs/heads/harness/control",
  policy_digest: digest("b"),
  actor_principal_id: "principal_alice",
  principal_snapshot_digest: digest("c"),
  command_id: "command_connect_01",
  effective_at: NOW,
  record_digest: digest("d"),
};

const REMOTE_DECISION: RemoteApprovalDecisionRecord = {
  protocol_version: "1.2.0",
  record_kind: "remote_approval_decision",
  control_sequence: 3,
  previous_control_record_digest: digest("2"),
  remote_decision_id: "remote_decision_01",
  request_id: "request_01",
  operation_id: "operation_01",
  object_id: "object_01",
  object_digest: digest("e"),
  policy_digest: digest("b"),
  decision: "approve",
  principal_snapshot_digest: digest("c"),
  required_permission: "maintain",
  decided_at: NOW,
  command_id: "command_approve_01",
  record_digest: digest("f"),
};

interface Captured {
  readonly io: CliIo;
  stdout(): string;
  stderr(): string;
}

function captureIo(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      writeStdout: (text) => out.push(text),
      writeStderr: (text) => err.push(text),
      isInteractive: false,
    },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

const createdRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  createdRoots.push(directory);
  return directory;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "gc.auto=0", ...args], {
    cwd,
    encoding: "utf8",
  });
}

/** Managed project on a real git repo with an approved HTTPS origin remote. */
function makeManagedRepo(): string {
  const root = makeTempDir("harness-cli-collab-");
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Harness Test");
  git(root, "config", "user.email", "harness-test@example.com");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "index.ts"), "export const answer = 42;\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "initial commit");
  git(root, "remote", "add", "origin", "https://github.com/acme/demo.git");
  initializeManagedLayout({
    projectRoot: root,
    manifest: createProjectManifest({ name: "demo", repositoryId: "repo.demo", now: () => NOW }),
    packLock: createPackLock([{ name: "pack-generic", version: "0.1.0", digest: "a".repeat(64) }]),
  });
  return root;
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined)
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

const CLIENT_CACHE_RELATIVE = join(".harness", "cache", "collaboration-client.json");

/** Local client locator cache, serialized exactly the way connect writes it. */
function writeClientCache(projectRoot: string, connection: CollaborationConnectionRecord): void {
  mkdirSync(join(projectRoot, ".harness", "cache"), { recursive: true });
  writeFileSync(
    join(projectRoot, CLIENT_CACHE_RELATIVE),
    serializeCollaborationClientState({
      version: 1,
      client_instance_id: "instance_test",
      connection,
      leases: {},
      integrations: {},
    }),
    "utf8",
  );
}

function readClientCache(projectRoot: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(projectRoot, CLIENT_CACHE_RELATIVE), "utf8")) as Record<
    string,
    unknown
  >;
}

interface RecordedExecute {
  readonly command: CollaborationCommand;
  readonly session: CollaborationSession;
}

function recordingPort(handlers: {
  readonly execute?: (command: CollaborationCommand) => CollaborationOutcome;
  readonly query?: (query: CollaborationQuery) => CollaborationView;
}): {
  readonly port: CollaborationCoordinatorPort;
  readonly calls: RecordedExecute[];
  readonly queries: CollaborationQuery[];
} {
  const calls: RecordedExecute[] = [];
  const queries: CollaborationQuery[] = [];
  const port: CollaborationCoordinatorPort = {
    execute(command, session) {
      calls.push({ command, session });
      return Promise.resolve(
        handlers.execute?.(command) ?? {
          status: "failed",
          failure: {
            code: "coordinator_unavailable",
            summary: "unhandled command",
            retryable: false,
          },
        },
      );
    },
    query(query) {
      queries.push(query);
      return Promise.resolve(
        handlers.query?.(query) ?? {
          kind: "connection_status",
          project_id: query.project_id,
          status: "active",
        },
      );
    },
  };
  return { port, calls, queries };
}

describe("collaboration command routes", () => {
  it("delegates connect with the coordinator origin and project root", async () => {
    const requests: ConnectRequest[] = [];
    const runtime = {
      ...createStubRuntimeService(),
      connect: (request: ConnectRequest) => {
        requests.push(request);
        return Promise.resolve({
          command: "connect",
          status: "ok" as const,
          message: "connected",
          data: {},
        });
      },
    };
    const projectRoot = makeManagedRepo();
    const captured = captureIo();
    const exitCode = await runCli(
      ["connect", "--coordinator", "https://coordinator.example.com", "--json"],
      { io: captured.io, cwd: projectRoot, runtime },
    );
    expect(exitCode).toBe(EXIT_CODES.ok);
    expect(requests).toEqual([
      { projectRoot, coordinatorOrigin: "https://coordinator.example.com" },
    ]);
  });

  it("delegates disconnect and sync with the project root", async () => {
    const disconnects: DisconnectRequest[] = [];
    const syncs: SyncRequest[] = [];
    const runtime = {
      ...createStubRuntimeService(),
      disconnect: (request: DisconnectRequest) => {
        disconnects.push(request);
        return Promise.resolve({
          command: "disconnect",
          status: "ok" as const,
          message: "",
          data: {},
        });
      },
      sync: (request: SyncRequest) => {
        syncs.push(request);
        return Promise.resolve({ command: "sync", status: "ok" as const, message: "", data: {} });
      },
    };
    const projectRoot = makeManagedRepo();
    for (const argv of [["disconnect"], ["sync"]]) {
      const captured = captureIo();
      const exitCode = await runCli([...argv, "--json"], {
        io: captured.io,
        cwd: projectRoot,
        runtime,
      });
      expect(exitCode).toBe(EXIT_CODES.ok);
    }
    expect(disconnects).toEqual([{ projectRoot }]);
    expect(syncs).toEqual([{ projectRoot }]);
  });

  it("delegates integrate prepare and accept with the typed target id", async () => {
    const requests: IntegrateRequest[] = [];
    const runtime = {
      ...createStubRuntimeService(),
      integrate: (request: IntegrateRequest) => {
        requests.push(request);
        return Promise.resolve({
          command: "integrate",
          status: "ok" as const,
          message: "",
          data: {},
        });
      },
    };
    const projectRoot = makeManagedRepo();
    for (const argv of [
      ["integrate", "prepare", "operation_01"],
      ["integrate", "accept", "integration_01"],
    ]) {
      const captured = captureIo();
      const exitCode = await runCli([...argv, "--json"], {
        io: captured.io,
        cwd: projectRoot,
        runtime,
      });
      expect(exitCode).toBe(EXIT_CODES.ok);
    }
    expect(requests).toEqual([
      { projectRoot, action: "prepare", targetId: "operation_01" },
      { projectRoot, action: "accept", targetId: "integration_01" },
    ]);
  });

  it("delegates the coordinator host command with parsed host options", async () => {
    const requests: CoordinatorHostRequest[] = [];
    const runtime = {
      ...createStubRuntimeService(),
      coordinator: (request: CoordinatorHostRequest) => {
        requests.push(request);
        return Promise.resolve({
          command: "coordinator",
          status: "ok" as const,
          message: "listening",
          data: { origin: "https://127.0.0.1:4443" },
        });
      },
    };
    const tlsDir = makeTempDir("harness-cli-coordinator-tls-");
    const cert = join(tlsDir, "cert.pem");
    const key = join(tlsDir, "key.pem");
    const config = join(tlsDir, "coordinator.json");
    const captured = captureIo();
    const exitCode = await runCli(
      [
        "coordinator",
        "--host",
        "127.0.0.1",
        "--port",
        "4443",
        "--tls-cert",
        cert,
        "--tls-key",
        key,
        "--config",
        config,
        "--json",
      ],
      { io: captured.io, cwd: "/", runtime },
    );
    expect(exitCode).toBe(EXIT_CODES.ok);
    expect(requests).toEqual([
      { host: "127.0.0.1", port: 4443, tlsCert: cert, tlsKey: key, configPath: config },
    ]);
  });
});

describe("collaboration usage errors", () => {
  it("rejects connect without --coordinator, with a non-HTTPS origin or with positionals", async () => {
    const projectRoot = makeManagedRepo();
    for (const argv of [
      ["connect"],
      ["connect", "--coordinator", "http://coordinator.example.com"],
      ["connect", "--coordinator", "https://coordinator.example.com", "extra"],
    ]) {
      const captured = captureIo();
      const exitCode = await runCli([...argv, "--json"], {
        io: captured.io,
        cwd: projectRoot,
        runtime: createStubRuntimeService(),
      });
      expect(exitCode).toBe(EXIT_CODES.usage);
      expect(JSON.parse(captured.stderr())["category"]).toBe("usage_error");
    }
  });

  it("rejects disconnect and sync positionals", async () => {
    const projectRoot = makeManagedRepo();
    for (const argv of [
      ["disconnect", "extra"],
      ["sync", "extra"],
    ]) {
      const captured = captureIo();
      const exitCode = await runCli(argv, {
        io: captured.io,
        cwd: projectRoot,
        runtime: createStubRuntimeService(),
      });
      expect(exitCode).toBe(EXIT_CODES.usage);
    }
  });

  it("rejects malformed integrate invocations", async () => {
    const projectRoot = makeManagedRepo();
    for (const argv of [
      ["integrate"],
      ["integrate", "explode", "operation_01"],
      ["integrate", "prepare"],
      ["integrate", "prepare", "not an id"],
      ["integrate", "accept", "integration_01", "extra"],
    ]) {
      const captured = captureIo();
      const exitCode = await runCli(argv, {
        io: captured.io,
        cwd: projectRoot,
        runtime: createStubRuntimeService(),
      });
      expect(exitCode).toBe(EXIT_CODES.usage);
    }
  });

  it("rejects coordinator invocations without TLS material or config", async () => {
    const tlsDir = makeTempDir("harness-cli-coordinator-tls-");
    const cert = join(tlsDir, "cert.pem");
    const key = join(tlsDir, "key.pem");
    const config = join(tlsDir, "coordinator.json");
    for (const argv of [
      ["coordinator", "--port", "4443", "--tls-key", key, "--config", config],
      ["coordinator", "--port", "4443", "--tls-cert", cert, "--config", config],
      ["coordinator", "--port", "4443", "--tls-cert", cert, "--tls-key", key],
      ["coordinator", "--tls-cert", cert, "--tls-key", key, "--config", config],
      ["coordinator", "--port", "70000", "--tls-cert", cert, "--tls-key", key, "--config", config],
      [
        "coordinator",
        "--host",
        "not a host!",
        "--port",
        "4443",
        "--tls-cert",
        cert,
        "--tls-key",
        key,
        "--config",
        config,
      ],
      [
        "coordinator",
        "--port",
        "4443",
        "--tls-cert",
        "relative/cert.pem",
        "--tls-key",
        key,
        "--config",
        config,
      ],
    ]) {
      const captured = captureIo();
      const exitCode = await runCli([...argv, "--json"], {
        io: captured.io,
        cwd: "/",
        runtime: createStubRuntimeService(),
      });
      expect(exitCode).toBe(EXIT_CODES.usage);
      expect(JSON.parse(captured.stderr())["category"]).toBe("usage_error");
    }
  });

  it("rejects TLS material inside a managed project", async () => {
    const projectRoot = makeManagedRepo();
    const tlsDir = makeTempDir("harness-cli-coordinator-tls-");
    const captured = captureIo();
    const exitCode = await runCli(
      [
        "coordinator",
        "--port",
        "4443",
        "--tls-cert",
        join(projectRoot, "cert.pem"),
        "--tls-key",
        join(tlsDir, "key.pem"),
        "--config",
        join(tlsDir, "coordinator.json"),
        "--json",
      ],
      { io: captured.io, cwd: "/", runtime: createStubRuntimeService() },
    );
    expect(exitCode).toBe(EXIT_CODES.usage);
    expect(JSON.parse(captured.stderr())["category"]).toBe("usage_error");
  });

  it("rejects TLS material symlinked into a managed project", async () => {
    const projectRoot = makeManagedRepo();
    const tlsDir = makeTempDir("harness-cli-coordinator-tls-");
    writeFileSync(join(projectRoot, "real-cert.pem"), "cert\n", "utf8");
    symlinkSync(join(projectRoot, "real-cert.pem"), join(tlsDir, "cert.pem"));
    const captured = captureIo();
    const exitCode = await runCli(
      [
        "coordinator",
        "--port",
        "4443",
        "--tls-cert",
        join(tlsDir, "cert.pem"),
        "--tls-key",
        join(tlsDir, "key.pem"),
        "--config",
        join(tlsDir, "coordinator.json"),
        "--json",
      ],
      { io: captured.io, cwd: "/", runtime: createStubRuntimeService() },
    );
    expect(exitCode).toBe(EXIT_CODES.usage);
    expect(JSON.parse(captured.stderr())["category"]).toBe("usage_error");
  });
});

describe("collaboration runtime routing", () => {
  it("connects through the injected port and caches the connection locator", async () => {
    const { port, calls } = recordingPort({
      execute: (command) =>
        command.kind === "connect"
          ? { status: "connected", connection: CONNECTION, replayed: false }
          : {
              status: "failed",
              failure: { code: "coordinator_unavailable", summary: "unexpected", retryable: false },
            },
    });
    const projectRoot = makeManagedRepo();
    const captured = captureIo();
    const runtime = createOrchestratedRuntimeService({
      cwd: projectRoot,
      io: captured.io,
      collaboration: { portForOrigin: () => port },
    });
    const exitCode = await runCli(
      ["connect", "--coordinator", "https://coordinator.example.com", "--json"],
      { io: captured.io, cwd: projectRoot, runtime },
    );
    expect(exitCode).toBe(EXIT_CODES.ok);
    const result = JSON.parse(captured.stdout()) as Record<string, unknown>;
    expect(result["status"]).toBe("ok");
    expect(result["data"]).toMatchObject({
      connection_id: "connection_01",
      coordinator_origin: "https://coordinator.example.com",
      actor_principal_id: "principal_alice",
      replayed: false,
    });
    // The CLI cannot know its principal before OAuth; the empty principal asks
    // the transport to bind the authenticated one.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.session.principal_id).toBe("");
    expect(calls[0]?.command).toMatchObject({
      kind: "connect",
      project_id: "project_demo",
      canonical_remote: "https://github.com/acme/demo",
      target_ref: "refs/heads/main",
      coordinator_origin: "https://coordinator.example.com",
    });
    const cache = readClientCache(projectRoot);
    expect(cache["version"]).toBe(1);
    expect(typeof cache["client_instance_id"]).toBe("string");
    expect(cache["connection"]).toMatchObject({
      connection_id: "connection_01",
      status: "active",
      actor_principal_id: "principal_alice",
    });
    // The cache can carry the Coordinator session credential: owner-only 0600.
    // POSIX permission bits do not exist on Windows (chmod is a no-op there and
    // the mode reads back 0666), so the mode check only applies elsewhere; the
    // file's existence and content are asserted above on every platform.
    if (process.platform !== "win32") {
      expect(statSync(join(projectRoot, CLIENT_CACHE_RELATIVE)).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps a failed connect outcome local: no cache, typed failure", async () => {
    const { port } = recordingPort({
      execute: () => ({
        status: "failed",
        failure: { code: "permission_denied", summary: "maintain required", retryable: false },
      }),
    });
    const projectRoot = makeManagedRepo();
    const captured = captureIo();
    const runtime = createOrchestratedRuntimeService({
      cwd: projectRoot,
      io: captured.io,
      collaboration: { portForOrigin: () => port },
    });
    const exitCode = await runCli(
      ["connect", "--coordinator", "https://coordinator.example.com", "--json"],
      { io: captured.io, cwd: projectRoot, runtime },
    );
    expect(exitCode).toBe(EXIT_CODES.operationFailed);
    const result = JSON.parse(captured.stdout()) as Record<string, unknown>;
    expect(result["status"]).toBe("failed");
    expect(result["data"]).toMatchObject({ kind: "permission_denied" });
    expect(existsSync(join(projectRoot, CLIENT_CACHE_RELATIVE))).toBe(false);
  });

  it("fails sync, disconnect and integrate without an active connection", async () => {
    const projectRoot = makeManagedRepo();
    const captured = captureIo();
    const runtime = createOrchestratedRuntimeService({ cwd: projectRoot, io: captured.io });
    for (const argv of [["sync"], ["disconnect"], ["integrate", "prepare", "operation_01"]]) {
      const attempt = captureIo();
      const exitCode = await runCli([...argv, "--json"], {
        io: attempt.io,
        cwd: projectRoot,
        runtime,
      });
      expect(exitCode).toBe(EXIT_CODES.operationFailed);
      const result = JSON.parse(attempt.stdout()) as Record<string, unknown>;
      expect(result["status"]).toBe("failed");
      expect(result["data"]).toMatchObject({ kind: "not_connected" });
    }
  });

  it("syncs through the coordinator and queries the approval inbox", async () => {
    const { port, calls, queries } = recordingPort({
      execute: (command) =>
        command.kind === "sync_now"
          ? { status: "synced", project_id: command.project_id }
          : {
              status: "failed",
              failure: { code: "coordinator_unavailable", summary: "unexpected", retryable: false },
            },
      query: (query) =>
        query.kind === "approval_inbox"
          ? { kind: "approval_inbox", project_id: query.project_id, decisions: [] }
          : { kind: "connection_status", project_id: query.project_id, status: "active" },
    });
    const projectRoot = makeManagedRepo();
    writeClientCache(projectRoot, CONNECTION);
    const captured = captureIo();
    const runtime = createOrchestratedRuntimeService({
      cwd: projectRoot,
      io: captured.io,
      collaboration: { portForOrigin: () => port },
    });
    const exitCode = await runCli(["sync", "--json"], {
      io: captured.io,
      cwd: projectRoot,
      runtime,
    });
    expect(exitCode).toBe(EXIT_CODES.ok);
    const result = JSON.parse(captured.stdout()) as Record<string, unknown>;
    expect(result["data"]).toMatchObject({
      project_id: "project_demo",
      inbox_decisions: 0,
      materialized: 0,
      failures: [],
    });
    expect(calls[0]?.command).toMatchObject({ kind: "sync_now", project_id: "project_demo" });
    expect(calls[0]?.session.principal_id).toBe("principal_alice");
    expect(queries).toEqual([{ kind: "approval_inbox", project_id: "project_demo" }]);
  });

  it("disconnects through the coordinator and clears the cached locator", async () => {
    const { port, calls } = recordingPort({
      execute: (command) =>
        command.kind === "disconnect"
          ? {
              status: "disconnected",
              connection: { ...CONNECTION, status: "disconnected" },
              replayed: false,
            }
          : {
              status: "failed",
              failure: { code: "coordinator_unavailable", summary: "unexpected", retryable: false },
            },
    });
    const projectRoot = makeManagedRepo();
    writeClientCache(projectRoot, CONNECTION);
    const captured = captureIo();
    const runtime = createOrchestratedRuntimeService({
      cwd: projectRoot,
      io: captured.io,
      collaboration: { portForOrigin: () => port },
    });
    const exitCode = await runCli(["disconnect", "--json"], {
      io: captured.io,
      cwd: projectRoot,
      runtime,
    });
    expect(exitCode).toBe(EXIT_CODES.ok);
    expect(calls[0]?.command).toMatchObject({ kind: "disconnect", project_id: "project_demo" });
    const cache = readClientCache(projectRoot);
    expect(cache["connection"]).toBeUndefined();
    expect(cache["client_instance_id"]).toBe("instance_test");
  });

  it("routes approve through the coordinator when the connection is active", async () => {
    const { port, calls } = recordingPort({
      execute: (command) =>
        command.kind === "submit_remote_approval"
          ? { status: "remote_approval", decision: REMOTE_DECISION, replayed: false }
          : {
              status: "failed",
              failure: { code: "coordinator_unavailable", summary: "unexpected", retryable: false },
            },
    });
    const projectRoot = makeManagedRepo();
    writeClientCache(projectRoot, CONNECTION);
    const captured = captureIo();
    const runtime = createOrchestratedRuntimeService({
      cwd: projectRoot,
      io: captured.io,
      collaboration: { portForOrigin: () => port },
    });
    const exitCode = await runCli(["approve", "request_01", "--decision", "approve", "--json"], {
      io: captured.io,
      cwd: projectRoot,
      runtime,
    });
    expect(exitCode).toBe(EXIT_CODES.ok);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toMatchObject({
      kind: "submit_remote_approval",
      request_id: "request_01",
      decision: "approve",
    });
    expect(calls[0]?.session).toEqual({
      principal_id: "principal_alice",
      client_instance_id: "instance_test",
    });
    const result = JSON.parse(captured.stdout()) as Record<string, unknown>;
    expect(result["data"]).toMatchObject({
      request_id: "request_01",
      decision: "approve",
      remote_decision_id: "remote_decision_01",
    });
  });

  it("gates a connected iterate on the operation lease before any local work", async () => {
    const { port, calls } = recordingPort({
      execute: () => ({
        status: "failed",
        failure: {
          code: "lease_unavailable",
          summary: "another client holds the lease",
          retryable: true,
        },
      }),
    });
    const projectRoot = makeManagedRepo();
    writeClientCache(projectRoot, CONNECTION);
    const captured = captureIo();
    const runtime = createOrchestratedRuntimeService({
      cwd: projectRoot,
      io: captured.io,
      collaboration: { portForOrigin: () => port },
    });
    const exitCode = await runCli(["iterate", "next change", "--profile", "lite", "--json"], {
      io: captured.io,
      cwd: projectRoot,
      runtime,
    });
    expect(exitCode).toBe(EXIT_CODES.operationFailed);
    const result = JSON.parse(captured.stdout()) as Record<string, unknown>;
    expect(result["data"]).toMatchObject({ kind: "lease_unavailable" });
    // The lease refused: no local iteration ran and nothing was published.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toMatchObject({ kind: "acquire_operation_lease" });
    const acquire = calls[0]?.command;
    if (acquire?.kind !== "acquire_operation_lease") throw new Error("expected acquire");
    expect(acquire.operation_id).toMatch(/^workflow_/u);
  });

  it("fails coordinator startup on a malformed provider config", async () => {
    const tlsDir = makeTempDir("harness-cli-coordinator-tls-");
    const cert = join(tlsDir, "cert.pem");
    const key = join(tlsDir, "key.pem");
    copyFileSync(
      new URL("../../runtime/test/collaboration/fixtures/localhost-cert.pem", import.meta.url),
      cert,
    );
    copyFileSync(
      new URL("../../runtime/test/collaboration/fixtures/localhost-key.pem", import.meta.url),
      key,
    );
    const config = join(tlsDir, "coordinator.json");
    writeFileSync(
      config,
      `${JSON.stringify({ version: 1, remote: "https://github.com/acme/demo" })}\n`,
      "utf8",
    );
    const captured = captureIo();
    const runtime = createOrchestratedRuntimeService({ cwd: "/", io: captured.io });
    const exitCode = await runCli(
      [
        "coordinator",
        "--host",
        "127.0.0.1",
        "--port",
        "4443",
        "--tls-cert",
        cert,
        "--tls-key",
        key,
        "--config",
        config,
        "--json",
      ],
      { io: captured.io, cwd: "/", runtime },
    );
    expect(exitCode).toBe(EXIT_CODES.operationFailed);
    const result = JSON.parse(captured.stdout()) as Record<string, unknown>;
    expect(result["status"]).toBe("failed");
    expect(result["data"]).toMatchObject({ kind: "configuration" });
  });
});
