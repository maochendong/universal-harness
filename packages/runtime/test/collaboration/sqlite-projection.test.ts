import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";

import {
  assertControlChain,
  buildCollaborationRecord,
  type CollaborationConnectionRecord,
  type ControlRecord,
  type IntegrationRecord,
  type LeaseRecord,
  type PrincipalSnapshotRecord,
  type RemoteApprovalDecisionRecord,
} from "@universal-harness-internal/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  ProjectionRebuildRequiredError,
  SqliteCoordinatorProjection,
} from "../../src/collaboration/sqlite-projection.js";

const digest = (letter: string): string => letter.repeat(64);

const NOW = "2026-08-29T00:00:00.000Z";
const LATER = "2026-08-29T00:05:00.000Z";
const PROJECT_ID = "project_demo";

const createdDirectories: string[] = [];
function makeTempDir(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "harness-projection-")));
  createdDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (createdDirectories.length > 0) {
    const directory = createdDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function snapshotRecord(sequence: number, previous?: string): PrincipalSnapshotRecord {
  return buildCollaborationRecord({
    record_kind: "principal_snapshot" as const,
    control_sequence: sequence,
    ...(previous === undefined ? {} : { previous_control_record_digest: previous }),
    snapshot_id: `snapshot_${sequence}`,
    principal_id: "principal_alice",
    provider: "github" as const,
    host: "github.com",
    subject_id: "1234567",
    repository_id: "acme/demo",
    permission: "maintain" as const,
    observed_at: NOW,
    expires_at: LATER,
    source_response_digest: digest("a"),
  });
}

function leaseRecord(
  sequence: number,
  previous: string,
  overrides: Partial<LeaseRecord> = {},
): LeaseRecord {
  return buildCollaborationRecord({
    record_kind: "lease" as const,
    control_sequence: sequence,
    previous_control_record_digest: previous,
    lease_record_id: `lease-record_${sequence}`,
    lease_id: "lease_01",
    resource_kind: "operation" as const,
    resource_id: "op_1",
    holder_principal_snapshot_digest: digest("a"),
    client_instance_id: "instance_test",
    fencing_token: 1,
    issued_at: NOW,
    expires_at: LATER,
    state: "granted" as const,
    command_id: `command_lease_${sequence}`,
    ...overrides,
  });
}

function approvalRecord(
  sequence: number,
  previous: string,
  overrides: Partial<RemoteApprovalDecisionRecord> = {},
): RemoteApprovalDecisionRecord {
  return buildCollaborationRecord({
    record_kind: "remote_approval_decision" as const,
    control_sequence: sequence,
    previous_control_record_digest: previous,
    remote_decision_id: `remote-decision_${sequence}`,
    request_id: `request_${sequence}`,
    operation_id: "op_1",
    object_id: `snapshot_${sequence}`,
    object_digest: digest("b"),
    policy_digest: digest("c"),
    decision: "approve" as const,
    principal_snapshot_digest: digest("a"),
    required_permission: "maintain" as const,
    decided_at: NOW,
    command_id: `command_decision_${sequence}`,
    ...overrides,
  });
}

function connectionFixture(): CollaborationConnectionRecord {
  return buildCollaborationRecord({
    record_kind: "collaboration_connection" as const,
    connection_id: "connection_demo",
    project_id: PROJECT_ID,
    revision: 1,
    status: "active" as const,
    provider: "github" as const,
    repository_id: "acme/demo",
    canonical_remote: "https://github.com/acme/demo.git",
    canonical_remote_digest: digest("b"),
    coordinator_origin: "https://harness.example.com",
    target_ref: "refs/heads/main",
    control_ref: "refs/heads/harness/control",
    policy_digest: digest("c"),
    actor_principal_id: "principal_alice",
    principal_snapshot_digest: digest("a"),
    command_id: "command_connect_1",
    effective_at: NOW,
  });
}

function integrationRecord(integrationId: string): IntegrationRecord {
  return buildCollaborationRecord({
    record_kind: "integration" as const,
    integration_id: integrationId,
    operation_id: "op_1",
    expected_target_commit: "0".repeat(40),
    operation_commit: "1".repeat(40),
    lease_fencing_token: 1,
    ledger_sequence_rewrites: [],
    evidence_digests: [],
    approval_decision_digests: [],
    command_id: "command_prepare_1",
  });
}

describe("SqliteCoordinatorProjection rebuild", () => {
  it("rebuilds the projection from the connection and control records", async () => {
    const connection = connectionFixture();
    const snapshot = snapshotRecord(1);
    const lease = leaseRecord(2, snapshot.record_digest);
    const approval = approvalRecord(3, lease.record_digest);
    const records: ControlRecord[] = [snapshot, lease, approval];

    const projection = new SqliteCoordinatorProjection(":memory:");
    await projection.rebuild({
      project_id: PROJECT_ID,
      latest_connection: connection,
      control_records: records,
    });

    await expect(
      projection.query({ kind: "connection_status", project_id: PROJECT_ID }),
    ).resolves.toMatchObject({
      kind: "connection_status",
      status: "active",
      connection: { record_digest: connection.record_digest },
    });
    await expect(
      projection.query({ kind: "approval_inbox", project_id: PROJECT_ID }),
    ).resolves.toMatchObject({ decisions: [approval] });
    await expect(projection.query({ kind: "operations", project_id: PROJECT_ID })).resolves.toEqual(
      { kind: "operations", project_id: PROJECT_ID, operations: [] },
    );
    projection.close();
  });

  it("rejects a rebuild whose control records do not form a valid chain", async () => {
    const projection = new SqliteCoordinatorProjection(":memory:");
    const snapshot = snapshotRecord(1);
    const broken = leaseRecord(3, digest("f"));
    await expect(
      projection.rebuild({
        project_id: PROJECT_ID,
        latest_connection: connectionFixture(),
        control_records: [snapshot, broken],
      }),
    ).rejects.toThrow();
    projection.close();
  });

  it("never writes OAuth-shaped columns and stores only projection facts", async () => {
    const projection = new SqliteCoordinatorProjection(":memory:");
    await projection.rebuild({
      project_id: PROJECT_ID,
      latest_connection: connectionFixture(),
      control_records: [snapshotRecord(1)],
    });
    const columns = projection
      .unsafeDatabase()
      .prepare(
        "SELECT name FROM pragma_table_info('connection') UNION SELECT name FROM pragma_table_info('control_records')",
      )
      .all()
      .map((row) => String((row as { name: unknown }).name));
    expect(columns.some((name) => /token|secret|credential/u.test(name))).toBe(false);
    projection.close();
  });
});

describe("SqliteCoordinatorProjection integration records", () => {
  it("rebuilds the identical digest when integration records are part of the rebuild input", async () => {
    const connection = connectionFixture();
    const snapshot = snapshotRecord(1);
    const lease = leaseRecord(2, snapshot.record_digest);
    const records: ControlRecord[] = [snapshot, lease];
    const integration = integrationRecord("integration_01");

    // Live path: rebuild from the chain, then apply the integration record
    // the way prepare/accept do.
    const live = new SqliteCoordinatorProjection(":memory:");
    await live.rebuild({
      project_id: PROJECT_ID,
      latest_connection: connection,
      control_records: records,
    });
    await live.apply(integration);
    const liveDigest = live.projectionDigest();
    live.close();

    // Delete+rebuild path: the recovered integration records arrive with the
    // rebuild input and the digest must not drift.
    const rebuilt = new SqliteCoordinatorProjection(":memory:");
    await rebuilt.rebuild({
      project_id: PROJECT_ID,
      latest_connection: connection,
      control_records: records,
      integration_records: [integration],
    });
    expect(rebuilt.projectionDigest()).toBe(liveDigest);
    await expect(
      rebuilt.query({ kind: "integration_conflicts", project_id: PROJECT_ID }),
    ).resolves.toEqual({
      kind: "integration_conflicts",
      project_id: PROJECT_ID,
      conflicts: [integration],
    });
    rebuilt.close();
  });

  it("drops integration records when the rebuild input omits them", async () => {
    const integration = integrationRecord("integration_01");
    const projection = new SqliteCoordinatorProjection(":memory:");
    await projection.rebuild({
      project_id: PROJECT_ID,
      latest_connection: connectionFixture(),
      control_records: [snapshotRecord(1)],
      integration_records: [integration],
    });
    const withRecords = projection.projectionDigest();

    // A rebuild is a delete+rebuild: without the records the rows are gone.
    await projection.rebuild({
      project_id: PROJECT_ID,
      latest_connection: connectionFixture(),
      control_records: [snapshotRecord(1)],
    });
    expect(projection.projectionDigest()).not.toBe(withRecords);
    await expect(
      projection.query({ kind: "integration_conflicts", project_id: PROJECT_ID }),
    ).resolves.toEqual({
      kind: "integration_conflicts",
      project_id: PROJECT_ID,
      conflicts: [],
    });
    projection.close();
  });
});

describe("SqliteCoordinatorProjection apply", () => {
  it("applies records incrementally after a rebuild", async () => {
    const projection = new SqliteCoordinatorProjection(":memory:");
    const snapshot = snapshotRecord(1);
    await projection.rebuild({
      project_id: PROJECT_ID,
      latest_connection: connectionFixture(),
      control_records: [snapshot],
    });

    const lease = leaseRecord(2, snapshot.record_digest);
    await projection.apply(lease);
    const disconnected = buildCollaborationRecord({
      ...connectionFixture(),
      revision: 2,
      status: "disconnected" as const,
      command_id: "command_connect_2",
      supersedes_digest: connectionFixture().record_digest,
    });
    await projection.apply(disconnected);

    await expect(
      projection.query({ kind: "connection_status", project_id: PROJECT_ID }),
    ).resolves.toMatchObject({ status: "disconnected" });
    projection.close();
  });

  it("serves a fresh projection without any rebuild as not connected", async () => {
    const projection = new SqliteCoordinatorProjection(":memory:");
    await expect(
      projection.query({ kind: "connection_status", project_id: PROJECT_ID }),
    ).resolves.toEqual({
      kind: "connection_status",
      project_id: PROJECT_ID,
      status: "not_connected",
    });
    projection.close();
  });
});

describe("SqliteCoordinatorProjection durability rules", () => {
  it("requires a rebuild when the on-disk schema version is newer", async () => {
    const path = join(makeTempDir(), "coordinator.sqlite");
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    database.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '999')").run();
    database.close();

    expect(() => new SqliteCoordinatorProjection(path)).toThrow(ProjectionRebuildRequiredError);
    try {
      new SqliteCoordinatorProjection(path);
    } catch (error) {
      expect((error as ProjectionRebuildRequiredError).code).toBe("projection_rebuild_required");
    }
  });

  it("requires a rebuild when the on-disk file is corrupt", () => {
    const path = join(makeTempDir(), "coordinator.sqlite");
    writeFileSync(path, "this is not a sqlite database at all");
    expect(() => new SqliteCoordinatorProjection(path)).toThrow(ProjectionRebuildRequiredError);
  });

  it("produces the identical projection digest after deleting the database and rebuilding from Git", async () => {
    const directory = makeTempDir();
    const path = join(directory, "coordinator.sqlite");
    const connection = connectionFixture();
    const snapshot = snapshotRecord(1);
    const lease = leaseRecord(2, snapshot.record_digest);
    const records: ControlRecord[] = [snapshot, lease];

    const first = new SqliteCoordinatorProjection(path);
    await first.rebuild({
      project_id: PROJECT_ID,
      latest_connection: connection,
      control_records: records,
    });
    const firstDigest = first.projectionDigest();
    first.close();

    // Delete the projection entirely and rebuild it from the Git facts.
    rmSync(path);
    const second = new SqliteCoordinatorProjection(path);
    await second.rebuild({
      project_id: PROJECT_ID,
      latest_connection: connection,
      control_records: records,
    });
    expect(second.projectionDigest()).toBe(firstDigest);
    second.close();
  });
});

describe("SqliteCoordinatorProjection scale gate", () => {
  it("validates and rebuilds 10,000 control records without truncation", async () => {
    // 10,000 canonical records: one principal snapshot followed by alternating
    // grant/release pairs, each fully sealed and chain-linked.
    const records: ControlRecord[] = [snapshotRecord(1)];
    let fencing = 0;
    for (let sequence = 2; sequence <= 10_000; sequence += 1) {
      const previous = records[records.length - 1] as ControlRecord;
      if (sequence % 2 === 0) {
        fencing += 1;
        records.push(
          leaseRecord(sequence, previous.record_digest, {
            lease_id: `lease_${fencing}`,
            fencing_token: fencing,
            state: "granted",
          }),
        );
      } else {
        records.push(
          leaseRecord(sequence, previous.record_digest, {
            lease_id: `lease_${fencing}`,
            fencing_token: fencing,
            state: "released",
          }),
        );
      }
    }
    expect(records).toHaveLength(10_000);
    expect(() => assertControlChain(records)).not.toThrow();

    const path = join(makeTempDir(), "coordinator.sqlite");
    const projection = new SqliteCoordinatorProjection(path);
    await projection.rebuild({
      project_id: PROJECT_ID,
      latest_connection: connectionFixture(),
      control_records: records,
    });
    const digestBeforeDelete = projection.projectionDigest();
    projection.close();

    // Delete and rebuild from the same Git facts: identical digest, full count.
    rmSync(path);
    const rebuilt = new SqliteCoordinatorProjection(path);
    await rebuilt.rebuild({
      project_id: PROJECT_ID,
      latest_connection: connectionFixture(),
      control_records: records,
    });
    expect(rebuilt.projectionDigest()).toBe(digestBeforeDelete);
    const count = rebuilt
      .unsafeDatabase()
      .prepare("SELECT COUNT(*) AS count FROM control_records")
      .get() as { count: number };
    expect(count.count).toBe(10_000);
    rebuilt.close();
  }, 120_000);
});
