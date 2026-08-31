import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  assertControlChain,
  contentDigest,
  type CollaborationConnectionRecord,
  type ControlRecord,
  type IntegrationRecord,
  type LeaseRecord,
  type RemoteApprovalDecisionRecord,
} from "@universal-harness-internal/core";

import type {
  CollaborationQuery,
  CollaborationView,
  CoordinatorProjectionPort,
  ProjectionRebuildInput,
} from "./port.js";

/**
 * Disposable SQLite projection of the collaboration state (spec §12). Git is
 * the only authority: this database caches the latest connection, the Control
 * Ref records and the derived Lease/Approval/Operation views so queries stay
 * local. It may be deleted at any time and rebuilt from Git; it never stores
 * OAuth tokens or raw platform responses, and it never extends a Lease's
 * `expires_at`.
 *
 * `rebuild`/`apply` signal failure by rejecting; the Coordinator maps that to
 * `projection_rebuild_required` on the authoritative outcome. A schema version
 * mismatch or a corrupt file blocks the Coordinator's write mode instead of
 * silently creating a second source of truth.
 */

export const COORDINATOR_PROJECTION_SCHEMA_VERSION = 1;

const META_SCHEMA_VERSION = "schema_version";
const META_LAST_CONTROL_SEQUENCE = "last_control_sequence";
const META_PROJECTION_DIGEST = "projection_digest";

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS connection (
  project_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL,
  record_digest TEXT NOT NULL,
  record_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS control_records (
  control_sequence INTEGER PRIMARY KEY,
  record_kind TEXT NOT NULL,
  record_digest TEXT NOT NULL UNIQUE,
  record_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS leases (
  lease_record_id TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  state TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  record_digest TEXT NOT NULL UNIQUE,
  record_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS leases_resource ON leases (resource_kind, resource_id);
CREATE TABLE IF NOT EXISTS approvals (
  remote_decision_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  record_digest TEXT NOT NULL UNIQUE,
  record_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS operation_heads (
  project_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  head_oid TEXT NOT NULL,
  PRIMARY KEY (project_id, operation_id)
);
CREATE TABLE IF NOT EXISTS integration_conflicts (
  integration_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  record_digest TEXT NOT NULL UNIQUE,
  record_json TEXT NOT NULL
);
`;

/** The projection cannot serve this database; delete it and rebuild from Git. */
export class ProjectionRebuildRequiredError extends Error {
  readonly code = "projection_rebuild_required" as const;
  readonly reason: string;

  constructor(reason: string) {
    super(`SQLite coordinator projection must be rebuilt from Git: ${reason}`);
    this.name = "ProjectionRebuildRequiredError";
    this.reason = reason;
  }
}

type Row = Record<string, unknown>;

export class SqliteCoordinatorProjection implements CoordinatorProjectionPort {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    let database: DatabaseSync;
    try {
      database = new DatabaseSync(path);
    } catch (error) {
      throw new ProjectionRebuildRequiredError(
        error instanceof Error ? error.message : "database cannot be opened",
      );
    }
    try {
      const recorded = readMetaValue(database, META_SCHEMA_VERSION);
      if (recorded !== undefined && Number(recorded) !== COORDINATOR_PROJECTION_SCHEMA_VERSION) {
        throw new ProjectionRebuildRequiredError(
          `schema version ${recorded} does not match ${COORDINATOR_PROJECTION_SCHEMA_VERSION}`,
        );
      }
      database.exec(DDL);
      writeMeta(database, META_SCHEMA_VERSION, String(COORDINATOR_PROJECTION_SCHEMA_VERSION));
    } catch (error) {
      database.close();
      if (error instanceof ProjectionRebuildRequiredError) throw error;
      throw new ProjectionRebuildRequiredError(
        error instanceof Error ? error.message : "schema cannot be applied",
      );
    }
    this.database = database;
  }

  /** Test/inspection escape hatch; production code must use the port methods. */
  unsafeDatabase(): DatabaseSync {
    return this.database;
  }

  close(): void {
    this.database.close();
  }

  /**
   * Deterministic digest over every projected fact. Deleting the database and
   * rebuilding it from the same Git records produces the identical digest.
   */
  projectionDigest(): string {
    const connection = this.database
      .prepare(
        "SELECT project_id, status, revision, record_digest FROM connection ORDER BY project_id",
      )
      .all();
    const control = this.database
      .prepare(
        "SELECT control_sequence, record_kind, record_digest FROM control_records ORDER BY control_sequence",
      )
      .all();
    const operationHeads = this.database
      .prepare(
        "SELECT project_id, operation_id, head_oid FROM operation_heads ORDER BY project_id, operation_id",
      )
      .all();
    const conflicts = this.database
      .prepare(
        "SELECT integration_id, record_digest FROM integration_conflicts ORDER BY integration_id",
      )
      .all();
    return contentDigest({
      connection,
      control,
      operation_heads: operationHeads,
      integration_conflicts: conflicts,
      last_control_sequence: Number(readMeta(this.database, META_LAST_CONTROL_SEQUENCE) ?? "0"),
    });
  }

  async rebuild(input: ProjectionRebuildInput): Promise<void> {
    // The projection only ever mirrors a chain that Git already validated;
    // validating again here keeps a corrupt caller input from materializing.
    if (input.control_records.length > 0) {
      assertControlChain([...input.control_records]);
    }
    this.database.exec("BEGIN");
    try {
      for (const table of [
        "connection",
        "control_records",
        "leases",
        "approvals",
        "operation_heads",
        "integration_conflicts",
      ]) {
        this.database.exec(`DELETE FROM ${table}`);
      }
      if (input.latest_connection !== undefined) {
        this.insertConnection(input.latest_connection);
      }
      for (const record of input.control_records) {
        this.insertControlRecord(record);
      }
      // IntegrationRecords live outside the Control Ref chain; the
      // Coordinator recovers them from the staging refs and the Target tree.
      for (const record of input.integration_records ?? []) {
        this.insertIntegration(record);
      }
      // The cursor moves only after every row landed (spec §12).
      const last = input.control_records[input.control_records.length - 1];
      writeMeta(this.database, META_LAST_CONTROL_SEQUENCE, String(last?.control_sequence ?? 0));
      writeMeta(this.database, META_PROJECTION_DIGEST, this.projectionDigest());
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  apply(record: Parameters<CoordinatorProjectionPort["apply"]>[0]): Promise<void> {
    this.database.exec("BEGIN");
    try {
      if (record.record_kind === "collaboration_connection") {
        this.insertConnection(record as CollaborationConnectionRecord);
      } else if (record.record_kind === "integration") {
        this.insertIntegration(record as IntegrationRecord);
      } else {
        const control = record as ControlRecord;
        this.insertControlRecord(control);
        const current = Number(readMeta(this.database, META_LAST_CONTROL_SEQUENCE) ?? "0");
        writeMeta(
          this.database,
          META_LAST_CONTROL_SEQUENCE,
          String(Math.max(current, control.control_sequence)),
        );
      }
      writeMeta(this.database, META_PROJECTION_DIGEST, this.projectionDigest());
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return Promise.resolve();
  }

  query(query: CollaborationQuery): Promise<CollaborationView> {
    switch (query.kind) {
      case "connection_status": {
        const row = this.database
          .prepare("SELECT record_json FROM connection WHERE project_id = ?")
          .get(query.project_id) as Row | undefined;
        if (row === undefined) {
          return Promise.resolve({
            kind: "connection_status",
            project_id: query.project_id,
            status: "not_connected",
          });
        }
        const connection = JSON.parse(String(row.record_json)) as CollaborationConnectionRecord;
        return Promise.resolve({
          kind: "connection_status",
          project_id: query.project_id,
          status: connection.status,
          connection,
        });
      }
      case "operations": {
        const rows = this.database
          .prepare(
            "SELECT operation_id, head_oid FROM operation_heads WHERE project_id = ? ORDER BY operation_id",
          )
          .all(query.project_id) as Row[];
        return Promise.resolve({
          kind: "operations",
          project_id: query.project_id,
          operations: rows.map((row) => ({
            operation_id: String(row.operation_id),
            head_oid: String(row.head_oid),
          })),
        });
      }
      case "approval_inbox": {
        const rows = this.database
          .prepare("SELECT record_json FROM approvals ORDER BY rowid")
          .all() as Row[];
        return Promise.resolve({
          kind: "approval_inbox",
          project_id: query.project_id,
          decisions: rows.map(
            (row) => JSON.parse(String(row.record_json)) as RemoteApprovalDecisionRecord,
          ),
        });
      }
      case "integration_conflicts": {
        const rows = this.database
          .prepare("SELECT record_json FROM integration_conflicts ORDER BY rowid")
          .all() as Row[];
        return Promise.resolve({
          kind: "integration_conflicts",
          project_id: query.project_id,
          conflicts: rows.map((row) => JSON.parse(String(row.record_json)) as IntegrationRecord),
        });
      }
    }
  }

  private insertConnection(record: CollaborationConnectionRecord): void {
    this.database
      .prepare(
        "INSERT OR REPLACE INTO connection (project_id, status, revision, record_digest, record_json) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        record.project_id,
        record.status,
        record.revision,
        record.record_digest,
        JSON.stringify(record),
      );
  }

  private insertControlRecord(record: ControlRecord): void {
    this.database
      .prepare(
        "INSERT OR REPLACE INTO control_records (control_sequence, record_kind, record_digest, record_json) VALUES (?, ?, ?, ?)",
      )
      .run(
        record.control_sequence,
        record.record_kind,
        record.record_digest,
        JSON.stringify(record),
      );
    if (record.record_kind === "lease") {
      const lease = record as LeaseRecord;
      this.database
        .prepare(
          "INSERT OR REPLACE INTO leases (lease_record_id, lease_id, resource_kind, resource_id, fencing_token, state, expires_at, record_digest, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          lease.lease_record_id,
          lease.lease_id,
          lease.resource_kind,
          lease.resource_id,
          lease.fencing_token,
          lease.state,
          lease.expires_at,
          lease.record_digest,
          JSON.stringify(lease),
        );
    }
    if (record.record_kind === "remote_approval_decision") {
      const decision = record as RemoteApprovalDecisionRecord;
      this.database
        .prepare(
          "INSERT OR REPLACE INTO approvals (remote_decision_id, request_id, operation_id, decision, record_digest, record_json) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          decision.remote_decision_id,
          decision.request_id,
          decision.operation_id,
          decision.decision,
          decision.record_digest,
          JSON.stringify(decision),
        );
    }
  }

  private insertIntegration(record: IntegrationRecord): void {
    this.database
      .prepare(
        "INSERT OR REPLACE INTO integration_conflicts (integration_id, operation_id, record_digest, record_json) VALUES (?, ?, ?, ?)",
      )
      .run(
        record.integration_id,
        record.operation_id,
        record.record_digest,
        JSON.stringify(record),
      );
  }
}

function metaTableExists(database: DatabaseSync): boolean {
  return (
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
      .get() !== undefined
  );
}

function readMetaValue(database: DatabaseSync, key: string): string | undefined {
  if (!metaTableExists(database)) return undefined;
  return readMeta(database, key);
}

function readMeta(database: DatabaseSync, key: string): string | undefined {
  const row = database.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
  return row === undefined ? undefined : String(row.value);
}

function writeMeta(database: DatabaseSync, key: string, value: string): void {
  database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}
