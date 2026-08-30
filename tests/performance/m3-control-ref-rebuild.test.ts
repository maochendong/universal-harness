import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertControlChain,
  buildCollaborationRecord,
  type CollaborationConnectionRecord,
  type ControlRecord,
  type LeaseRecord,
  type PrincipalSnapshotRecord,
} from "../../packages/core/src/index.js";
import {
  SqliteCoordinatorProjection,
  type CollaborationQuery,
} from "../../packages/runtime/src/index.js";

/**
 * M3 performance gate (plan M3 Task 9 step 3): a Control Ref at 10,000
 * records must rebuild into the SQLite projection deterministically — two
 * independent rebuilds from the same Git facts produce the identical
 * projection digest, the full record count and identical views. Output
 * equality is the contract; wall-clock thresholds are not asserted here
 * (the vitest.performance config already isolates this file).
 */

const digest = (letter: string): string => letter.repeat(64);

const NOW = "2026-08-29T00:00:00.000Z";
const LATER = "2026-08-29T00:05:00.000Z";
const PROJECT_ID = "project_demo";
const RECORD_COUNT = 10_000;

const createdDirectories: string[] = [];
function makeTempDir(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "harness-m3-scale-")));
  createdDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (createdDirectories.length > 0) {
    const directory = createdDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function snapshotRecord(sequence: number): PrincipalSnapshotRecord {
  return buildCollaborationRecord({
    record_kind: "principal_snapshot" as const,
    control_sequence: sequence,
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
  overrides: Partial<LeaseRecord>,
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
    host: "github.com",
    connected_at: NOW,
    target_ref: "refs/heads/main",
    control_ref: "refs/heads/harness/control",
    policy_digest: digest("c"),
  });
}

/** One principal snapshot followed by alternating grant/release lease pairs,
 * fully sealed and chain-linked — the canonical 10,000-record Control Ref. */
function scaleControlRecords(): ControlRecord[] {
  const records: ControlRecord[] = [snapshotRecord(1)];
  let fencing = 0;
  for (let sequence = 2; sequence <= RECORD_COUNT; sequence += 1) {
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
  return records;
}

const VIEW_QUERIES: readonly CollaborationQuery[] = [
  { kind: "connection_status", project_id: PROJECT_ID },
  { kind: "operations", project_id: PROJECT_ID },
  { kind: "approval_inbox", project_id: PROJECT_ID },
  { kind: "integration_conflicts", project_id: PROJECT_ID },
];

describe("control ref scale gate (10,000 records)", () => {
  it("rebuilds 10,000 control records twice with identical digests, counts and views", async () => {
    const records = scaleControlRecords();
    expect(records).toHaveLength(RECORD_COUNT);
    expect(() => assertControlChain(records)).not.toThrow();

    const rebuild = async (): Promise<{
      readonly projection: SqliteCoordinatorProjection;
      readonly digest: string;
    }> => {
      const projection = new SqliteCoordinatorProjection(join(makeTempDir(), "coordinator.sqlite"));
      await projection.rebuild({
        project_id: PROJECT_ID,
        latest_connection: connectionFixture(),
        control_records: records,
      });
      return { projection, digest: projection.projectionDigest() };
    };

    const first = await rebuild();
    const second = await rebuild();
    try {
      expect(second.digest).toBe(first.digest);

      const count = second.projection
        .unsafeDatabase()
        .prepare("SELECT COUNT(*) AS count FROM control_records")
        .get() as { count: number };
      expect(count.count).toBe(RECORD_COUNT);

      // Every view is fully reproducible from the Git facts alone.
      for (const query of VIEW_QUERIES) {
        const [firstView, secondView] = await Promise.all([
          first.projection.query(query),
          second.projection.query(query),
        ]);
        expect(secondView).toEqual(firstView);
      }
    } finally {
      first.projection.close();
      second.projection.close();
    }
  }, 120_000);
});
