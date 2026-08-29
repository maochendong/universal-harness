import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CollaborationConnectionRecord,
  ControlRecord,
  IntegrationRecord,
  LeaseRecord,
} from "@universal-harness-internal/core";
import { describe, expect, it } from "vitest";

import { COLLABORATION_CONTROL_REF } from "../../src/collaboration/connection.js";
import { collaborationFailure } from "../../src/collaboration/errors.js";
import type {
  AppendControlInput,
  AppendProjectRecordInput,
  CollaborationProjectionRecord,
  CollaborationQuery,
  CollaborationSession,
  CollaborationView,
  ConnectCommand,
  ControlSnapshotResult,
  CoordinatorProjectionPort,
  GitControlStorePort,
  PlatformIdentityPort,
  PrincipalSnapshotDraftResult,
  ProjectionRebuildInput,
  ProtectionResult,
  RemoteIdentityResult,
} from "../../src/collaboration/index.js";
import { createCollaborationCoordinator } from "../../src/collaboration/index.js";

const digest = (letter: string): string => letter.repeat(64);

const NOW = "2026-08-29T00:00:00.000Z";
const LATER = "2026-08-29T00:05:00.000Z";
const EARLIER = "2026-08-28T23:55:00.000Z";

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

interface FakePlatform {
  readonly port: PlatformIdentityPort;
  readonly calls: { discover: number; authenticate: number; inspectProtection: number };
}

function createFakePlatform(
  overrides: {
    discover?: (remote: string) => RemoteIdentityResult;
    authenticate?: () => PrincipalSnapshotDraftResult;
    protection?: () => ProtectionResult;
  } = {},
): FakePlatform {
  const calls = { discover: 0, authenticate: 0, inspectProtection: 0 };
  return {
    calls,
    port: {
      discover(remote) {
        calls.discover += 1;
        if (overrides.discover !== undefined) return Promise.resolve(overrides.discover(remote));
        if (remote.includes("unsupported")) {
          return Promise.resolve({
            status: "failed",
            failure: collaborationFailure(
              "unsupported_remote",
              `no platform adapter for ${remote}`,
            ),
          });
        }
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
        calls.authenticate += 1;
        if (overrides.authenticate !== undefined) return Promise.resolve(overrides.authenticate());
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
        calls.inspectProtection += 1;
        if (overrides.protection !== undefined) return Promise.resolve(overrides.protection());
        return Promise.resolve({ status: "protected" });
      },
    },
  };
}

interface FakeControlStore {
  readonly port: GitControlStorePort;
  readonly controlRecords: ControlRecord[];
  readonly projectRecords: (CollaborationConnectionRecord | IntegrationRecord)[];
  readonly calls: { readControl: number; appendControl: number; appendProjectRecord: number };
}

function createFakeControlStore(seedControlRecords: ControlRecord[] = []): FakeControlStore {
  const controlRecords: ControlRecord[] = [...seedControlRecords];
  const projectRecords: (CollaborationConnectionRecord | IntegrationRecord)[] = [];
  const calls = { readControl: 0, appendControl: 0, appendProjectRecord: 0 };
  const headOid = () =>
    controlRecords.length === 0 ? undefined : `oid_control_${controlRecords.length}`;
  return {
    controlRecords,
    projectRecords,
    calls,
    port: {
      readControl() {
        calls.readControl += 1;
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
      appendControl(input: AppendControlInput) {
        calls.appendControl += 1;
        if (input.expected_head_oid !== headOid()) {
          return Promise.resolve({
            status: "failed" as const,
            failure: collaborationFailure("control_ref_invalid", "stale expected head"),
          });
        }
        controlRecords.push(input.record);
        return Promise.resolve({ status: "appended" as const, head_oid: headOid() as string });
      },
      appendProjectRecord(input: AppendProjectRecordInput) {
        calls.appendProjectRecord += 1;
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
          failure: collaborationFailure("coordinator_unavailable", "not implemented in slice"),
        });
      },
      prepareCandidate() {
        return Promise.resolve({
          status: "failed" as const,
          failure: collaborationFailure("coordinator_unavailable", "not implemented in slice"),
        });
      },
      compareAndSwapTarget() {
        return Promise.resolve({
          status: "failed" as const,
          failure: collaborationFailure("coordinator_unavailable", "not implemented in slice"),
        });
      },
    },
  };
}

interface FakeProjection {
  readonly port: CoordinatorProjectionPort;
  readonly applied: CollaborationProjectionRecord[];
  readonly rebuilds: ProjectionRebuildInput[];
  failOnApply: boolean;
}

function createFakeProjection(): FakeProjection {
  const applied: CollaborationProjectionRecord[] = [];
  const rebuilds: ProjectionRebuildInput[] = [];
  const fake: FakeProjection = {
    applied,
    rebuilds,
    failOnApply: false,
    port: {
      rebuild(input) {
        rebuilds.push(input);
        return Promise.resolve();
      },
      apply(record) {
        if (fake.failOnApply) return Promise.reject(new Error("sqlite write failed"));
        applied.push(record);
        return Promise.resolve();
      },
      query(query: CollaborationQuery): Promise<CollaborationView> {
        if (query.kind === "connection_status") {
          const latest = [...applied]
            .reverse()
            .find(
              (record): record is CollaborationConnectionRecord =>
                record.record_kind === "collaboration_connection" &&
                record.project_id === query.project_id,
            );
          return Promise.resolve({
            kind: "connection_status",
            project_id: query.project_id,
            status: latest === undefined ? "not_connected" : latest.status,
            ...(latest === undefined ? {} : { connection: latest }),
          });
        }
        if (query.kind === "operations") {
          return Promise.resolve({
            kind: "operations",
            project_id: query.project_id,
            operations: [],
          });
        }
        if (query.kind === "approval_inbox") {
          return Promise.resolve({
            kind: "approval_inbox",
            project_id: query.project_id,
            decisions: [],
          });
        }
        return Promise.resolve({
          kind: "integration_conflicts",
          project_id: query.project_id,
          conflicts: [],
        });
      },
    },
  };
  return fake;
}

function createHarness(
  overrides: {
    platform?: FakePlatform;
    controlStore?: FakeControlStore;
    projection?: FakeProjection;
  } = {},
) {
  const platform = overrides.platform ?? createFakePlatform();
  const controlStore = overrides.controlStore ?? createFakeControlStore();
  const projection = overrides.projection ?? createFakeProjection();
  const coordinator = createCollaborationCoordinator({
    platform: platform.port,
    controlStore: controlStore.port,
    projection: projection.port,
    now: () => NOW,
  });
  return { coordinator, platform, controlStore, projection };
}

function liveLeaseRecord(): LeaseRecord {
  return {
    protocol_version: "1.2.0",
    record_kind: "lease",
    control_sequence: 1,
    lease_record_id: "lease-record_01",
    lease_id: "lease_01",
    resource_kind: "operation",
    resource_id: "operation_01",
    holder_principal_snapshot_digest: digest("s"),
    client_instance_id: "instance_test",
    fencing_token: 1,
    issued_at: NOW,
    expires_at: LATER,
    state: "granted",
    command_id: "command_lease_1",
    record_digest: digest("l"),
  };
}

describe("collaboration coordinator connect", () => {
  it("connects and projects the active connection", async () => {
    const { coordinator, controlStore } = createHarness();
    const outcome = await coordinator.execute(connectCommand(), session("principal_alice"));

    expect(outcome).toMatchObject({ status: "connected", connection: { revision: 1 } });
    if (outcome.status !== "connected") throw new Error("expected connected outcome");
    expect(outcome.replayed).toBe(false);
    expect(outcome.projection_rebuild_required).toBeUndefined();
    expect(outcome.connection).toMatchObject({
      protocol_version: "1.2.0",
      record_kind: "collaboration_connection",
      project_id: "project_demo",
      status: "active",
      provider: "github",
      repository_id: "acme/demo",
      canonical_remote: "https://github.com/acme/demo.git",
      coordinator_origin: "https://harness.example.com",
      target_ref: "refs/heads/main",
      control_ref: COLLABORATION_CONTROL_REF,
      policy_digest: digest("1"),
      actor_principal_id: "principal_alice",
      command_id: "command_connect_1",
      effective_at: NOW,
    });
    expect(outcome.connection.connection_id).toMatch(/^connection_[a-f0-9]{24}$/);
    expect(outcome.connection.supersedes_digest).toBeUndefined();

    // The PrincipalSnapshot is appended to the Control Ref before the project record.
    expect(controlStore.controlRecords).toHaveLength(1);
    expect(controlStore.controlRecords[0]).toMatchObject({
      record_kind: "principal_snapshot",
      control_sequence: 1,
      principal_id: "principal_alice",
      repository_id: "acme/demo",
      permission: "maintain",
    });
    expect(outcome.connection.principal_snapshot_digest).toBe(
      controlStore.controlRecords[0]?.record_digest,
    );

    await expect(
      coordinator.query(
        { kind: "connection_status", project_id: "project_demo" },
        session("principal_alice"),
      ),
    ).resolves.toMatchObject({ kind: "connection_status", status: "active" });
  });

  it("rejects a non-HTTPS coordinator origin without any remote side effect", async () => {
    const { coordinator, platform, controlStore } = createHarness();
    const outcome = await coordinator.execute(
      connectCommand({ coordinator_origin: "http://harness.example.com" }),
      session("principal_alice"),
    );

    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "invalid_coordinator_origin" },
    });
    expect(platform.calls).toEqual({ discover: 0, authenticate: 0, inspectProtection: 0 });
    expect(controlStore.calls.readControl).toBe(0);
  });

  it("rejects origins with userinfo or query without any remote side effect", async () => {
    const { coordinator, platform } = createHarness();
    for (const coordinator_origin of [
      "https://alice@harness.example.com",
      "https://alice:secret@harness.example.com",
      "https://harness.example.com?token=1",
    ]) {
      const outcome = await coordinator.execute(
        connectCommand({ coordinator_origin }),
        session("principal_alice"),
      );
      expect(outcome, coordinator_origin).toMatchObject({
        status: "failed",
        failure: { code: "invalid_coordinator_origin" },
      });
    }
    expect(platform.calls.discover).toBe(0);
  });

  it("fails closed on an unsupported remote", async () => {
    const { coordinator, controlStore } = createHarness();
    const outcome = await coordinator.execute(
      connectCommand({ canonical_remote: "https://unsupported.example.com/acme/demo.git" }),
      session("principal_alice"),
    );

    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "unsupported_remote" },
    });
    expect(controlStore.calls.appendControl).toBe(0);
    expect(controlStore.calls.appendProjectRecord).toBe(0);
  });

  it("fails closed when the platform permission snapshot is already stale", async () => {
    const platform = createFakePlatform({
      authenticate: () => ({
        status: "authenticated",
        snapshot: {
          principal_id: "principal_alice",
          provider: "github",
          host: "github.com",
          subject_id: "1234567",
          repository_id: "acme/demo",
          permission: "maintain",
          observed_at: EARLIER,
          expires_at: EARLIER,
          source_response_digest: digest("s"),
        },
      }),
    });
    const { coordinator, controlStore } = createHarness({ platform });
    const outcome = await coordinator.execute(connectCommand(), session("principal_alice"));

    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "permission_snapshot_stale" },
    });
    expect(controlStore.calls.appendProjectRecord).toBe(0);
  });

  it("fails closed when Control Ref protection cannot be proven", async () => {
    const platform = createFakePlatform({
      protection: () => ({
        status: "unprotected",
        failure: collaborationFailure(
          "control_ref_unprotected",
          "platform cannot prove the control ref is protected",
        ),
      }),
    });
    const { coordinator, controlStore } = createHarness({ platform });
    const outcome = await coordinator.execute(connectCommand(), session("principal_alice"));

    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "control_ref_unprotected" },
    });
    expect(controlStore.calls.appendControl).toBe(0);
    expect(controlStore.calls.appendProjectRecord).toBe(0);
  });

  it("rejects an authenticated principal that does not own the session", async () => {
    const platform = createFakePlatform({
      authenticate: () => ({
        status: "authenticated",
        snapshot: {
          principal_id: "principal_mallory",
          provider: "github",
          host: "github.com",
          subject_id: "999",
          repository_id: "acme/demo",
          permission: "admin",
          observed_at: NOW,
          expires_at: LATER,
          source_response_digest: digest("s"),
        },
      }),
    });
    const { coordinator } = createHarness({ platform });
    const outcome = await coordinator.execute(connectCommand(), session("principal_alice"));

    expect(outcome).toMatchObject({ status: "failed", failure: { code: "permission_denied" } });
  });

  it("returns the existing revision for a repeated command_id without new facts", async () => {
    const { coordinator, controlStore } = createHarness();
    const first = await coordinator.execute(connectCommand(), session("principal_alice"));
    const second = await coordinator.execute(connectCommand(), session("principal_alice"));

    expect(first.status).toBe("connected");
    expect(second).toMatchObject({ status: "connected", replayed: true });
    if (first.status === "connected" && second.status === "connected") {
      expect(second.connection.record_digest).toBe(first.connection.record_digest);
      expect(second.connection.revision).toBe(1);
    }
    expect(controlStore.calls.appendControl).toBe(1);
    expect(controlStore.calls.appendProjectRecord).toBe(1);
  });

  it("returns the existing revision for a semantically identical reconnect", async () => {
    const { coordinator, controlStore } = createHarness();
    await coordinator.execute(connectCommand(), session("principal_alice"));
    const second = await coordinator.execute(
      connectCommand({ command_id: "command_connect_2" }),
      session("principal_alice"),
    );

    expect(second).toMatchObject({
      status: "connected",
      replayed: true,
      connection: { revision: 1, command_id: "command_connect_1" },
    });
    expect(controlStore.calls.appendProjectRecord).toBe(1);
  });

  it("fails closed when reconnecting an active project with drifted semantics", async () => {
    const { coordinator } = createHarness();
    await coordinator.execute(connectCommand(), session("principal_alice"));
    const outcome = await coordinator.execute(
      connectCommand({
        command_id: "command_connect_2",
        canonical_remote: "https://github.com/acme/other.git",
      }),
      session("principal_alice"),
    );

    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "remote_identity_drift" },
    });
  });

  it("survives a projection failure with projection_rebuild_required and no Git retry", async () => {
    const projection = createFakeProjection();
    projection.failOnApply = true;
    const { coordinator, controlStore } = createHarness({ projection });

    const outcome = await coordinator.execute(connectCommand(), session("principal_alice"));

    expect(outcome).toMatchObject({
      status: "connected",
      projection_rebuild_required: true,
      connection: { revision: 1 },
    });
    expect(controlStore.calls.appendControl).toBe(1);
    expect(controlStore.calls.appendProjectRecord).toBe(1);
  });

  it("never reads or writes CapabilityPlan or Profile files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "harness-collab-"));
    const profilePath = join(directory, "profile.json");
    const capabilityPlanPath = join(directory, "capability-plan.json");
    writeFileSync(profilePath, JSON.stringify({ profile: "governed" }));
    writeFileSync(capabilityPlanPath, JSON.stringify({ capability_plan: "digest" }));
    const before = [profilePath, capabilityPlanPath].map((path) => ({
      content: readFileSync(path, "utf8"),
      mtimeMs: statSync(path).mtimeMs,
    }));

    const { coordinator } = createHarness();
    const outcome = await coordinator.execute(connectCommand(), session("principal_alice"));
    expect(outcome.status).toBe("connected");

    const after = [profilePath, capabilityPlanPath].map((path) => ({
      content: readFileSync(path, "utf8"),
      mtimeMs: statSync(path).mtimeMs,
    }));
    expect(after).toEqual(before);
  });
});

describe("collaboration coordinator disconnect", () => {
  it("appends a disconnected revision that supersedes the active record", async () => {
    const { coordinator } = createHarness();
    const connected = await coordinator.execute(connectCommand(), session("principal_alice"));
    if (connected.status !== "connected") throw new Error("expected connected outcome");

    const outcome = await coordinator.execute(
      { kind: "disconnect", command_id: "command_disconnect_1", project_id: "project_demo" },
      session("principal_alice"),
    );

    expect(outcome).toMatchObject({
      status: "disconnected",
      replayed: false,
      connection: {
        revision: 2,
        status: "disconnected",
        connection_id: connected.connection.connection_id,
        command_id: "command_disconnect_1",
        supersedes_digest: connected.connection.record_digest,
      },
    });

    await expect(
      coordinator.query(
        { kind: "connection_status", project_id: "project_demo" },
        session("principal_alice"),
      ),
    ).resolves.toMatchObject({ kind: "connection_status", status: "disconnected" });
  });

  it("returns the existing disconnected revision for a repeated command_id", async () => {
    const { coordinator, controlStore } = createHarness();
    await coordinator.execute(connectCommand(), session("principal_alice"));
    const command = {
      kind: "disconnect",
      command_id: "command_disconnect_1",
      project_id: "project_demo",
    } as const;
    const first = await coordinator.execute(command, session("principal_alice"));
    const second = await coordinator.execute(command, session("principal_alice"));

    expect(first.status).toBe("disconnected");
    expect(second).toMatchObject({ status: "disconnected", replayed: true });
    if (first.status === "disconnected" && second.status === "disconnected") {
      expect(second.connection.record_digest).toBe(first.connection.record_digest);
    }
    expect(controlStore.calls.appendProjectRecord).toBe(2);
  });

  it("reports a no-op when disconnecting an already disconnected project", async () => {
    const { coordinator, controlStore } = createHarness();
    await coordinator.execute(connectCommand(), session("principal_alice"));
    await coordinator.execute(
      { kind: "disconnect", command_id: "command_disconnect_1", project_id: "project_demo" },
      session("principal_alice"),
    );

    const outcome = await coordinator.execute(
      { kind: "disconnect", command_id: "command_disconnect_2", project_id: "project_demo" },
      session("principal_alice"),
    );

    // A no-op is not an idempotent replay: no new fact is appended.
    expect(outcome).toMatchObject({
      status: "disconnected",
      replayed: false,
      connection: { revision: 2, command_id: "command_disconnect_1" },
    });
    expect(controlStore.calls.appendProjectRecord).toBe(2);
  });

  it("refuses to disconnect while a live lease exists", async () => {
    const controlStore = createFakeControlStore();
    const { coordinator } = createHarness({ controlStore });
    await coordinator.execute(connectCommand(), session("principal_alice"));
    controlStore.controlRecords.push(liveLeaseRecord());

    const outcome = await coordinator.execute(
      { kind: "disconnect", command_id: "command_disconnect_1", project_id: "project_demo" },
      session("principal_alice"),
    );

    expect(outcome).toMatchObject({ status: "failed", failure: { code: "lease_unavailable" } });
    expect(controlStore.projectRecords).toHaveLength(1);
  });

  it("fails closed when the project was never connected", async () => {
    const { coordinator, controlStore } = createHarness();
    const outcome = await coordinator.execute(
      { kind: "disconnect", command_id: "command_disconnect_1", project_id: "project_demo" },
      session("principal_alice"),
    );

    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "coordinator_unavailable" },
    });
    expect(controlStore.calls.appendProjectRecord).toBe(0);
  });
});

describe("collaboration coordinator command routing", () => {
  it("reports a typed failure for commands outside the connection and lease slices", async () => {
    const { coordinator } = createHarness();
    await coordinator.execute(connectCommand(), session("principal_alice"));

    const outcome = await coordinator.execute(
      {
        kind: "submit_remote_approval",
        command_id: "command_decision_1",
        project_id: "project_demo",
        request_id: "request_01",
        decision: "approve",
      },
      session("principal_alice"),
    );

    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "coordinator_unavailable" },
    });
  });

  it("routes remote commands on an unconnected project to a typed failure", async () => {
    const { coordinator } = createHarness();
    const outcome = await coordinator.execute(
      { kind: "sync_now", command_id: "command_sync_1", project_id: "project_demo" },
      session("principal_alice"),
    );

    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "coordinator_unavailable" },
    });
  });

  it("projects not_connected for a project without any connection record", async () => {
    const { coordinator } = createHarness();
    await expect(
      coordinator.query(
        { kind: "connection_status", project_id: "project_demo" },
        session("principal_alice"),
      ),
    ).resolves.toMatchObject({ kind: "connection_status", status: "not_connected" });
  });
});
