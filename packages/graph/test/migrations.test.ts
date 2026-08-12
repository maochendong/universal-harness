import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  GRAPH_MIGRATIONS,
  GraphMigrationError,
  pendingMigrations,
  type GraphMigration,
} from "../src/migrations/registry.js";
import { ensureCurrentSchema, previewMigrations, runMigrations } from "../src/migrations/runner.js";
import {
  GRAPH_SCHEMA_VERSION,
  openGraphDatabase,
  readSchemaVersion,
} from "../src/sqlite/database.js";

/**
 * Migration runner behavior: preview is read-only, apply is backed up and
 * verified, failure restores the pre-run bytes wholesale, and a migration
 * event exists only for a migration that authoritatively succeeded.
 */
const FIXED_NOW = "2026-08-12T00:00:00.000Z";

function makeDatabasePath(): string {
  return join(mkdtempSync(join(tmpdir(), "harness-migrations-")), "graph.db");
}

function createCurrentSchemaCache(databasePath: string): void {
  const database = openGraphDatabase(databasePath);
  database.close();
}

const addAuditTable: GraphMigration = {
  version: 2,
  name: "add-audit-table",
  up: (database) => {
    database.exec("CREATE TABLE audit_log (id TEXT PRIMARY KEY)");
  },
};

const addAuditIndex: GraphMigration = {
  version: 3,
  name: "add-audit-index",
  up: (database) => {
    database.exec("CREATE INDEX audit_log_id_idx ON audit_log (id)");
  },
};

function readMetaValue(databasePath: string, key: string): string | undefined {
  const database = new DatabaseSync(databasePath);
  try {
    const row = database.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row === undefined ? undefined : String((row as { value: unknown }).value);
  } finally {
    database.close();
  }
}

function tableNames(databasePath: string): string[] {
  const database = new DatabaseSync(databasePath);
  try {
    const rows = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as unknown as { name: string }[];
    return rows.map((row) => row.name);
  } finally {
    database.close();
  }
}

function migrationEvents(
  databasePath: string,
): { version: number; name: string; applied_at: string }[] {
  const database = new DatabaseSync(databasePath);
  try {
    const table = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_events'")
      .get();
    if (table === undefined) return [];
    return database
      .prepare("SELECT version, name, applied_at FROM migration_events ORDER BY version")
      .all() as unknown as { version: number; name: string; applied_at: string }[];
  } finally {
    database.close();
  }
}

describe("pendingMigrations", () => {
  it("selects the contiguous chain between two versions", () => {
    const steps = pendingMigrations([addAuditIndex, addAuditTable], 1, 3);
    expect(steps.map((step) => step.version)).toEqual([2, 3]);
  });

  it("returns no steps when the cache is already at the target", () => {
    expect(pendingMigrations([addAuditTable], 2, 2)).toEqual([]);
  });

  it("blocks when the registry cannot reach the target version", () => {
    expect(() => pendingMigrations([addAuditIndex], 1, 3)).toThrowError(GraphMigrationError);
    expect(() => pendingMigrations([], 1, 2)).toThrowError(/no migration path/);
  });

  it("blocks targets older than the recorded version", () => {
    expect(() => pendingMigrations([addAuditTable], 3, 2)).toThrowError(/newer than target/);
  });
});

describe("previewMigrations", () => {
  it("reports the pending steps without writing anything", () => {
    const databasePath = makeDatabasePath();
    createCurrentSchemaCache(databasePath);

    const plan = previewMigrations({
      databasePath,
      migrations: [addAuditTable, addAuditIndex],
      targetVersion: 3,
    });
    expect(plan.fromVersion).toBe(GRAPH_SCHEMA_VERSION);
    expect(plan.toVersion).toBe(3);
    expect(plan.steps).toEqual([
      { version: 2, name: "add-audit-table" },
      { version: 3, name: "add-audit-index" },
    ]);

    // Read-only: no schema bump, no backup, no migration tables.
    expect(readMetaValue(databasePath, "schema_version")).toBe(String(GRAPH_SCHEMA_VERSION));
    expect(tableNames(databasePath)).not.toContain("audit_log");
    expect(tableNames(databasePath)).not.toContain("migration_events");
    expect(existsSync(plan.backupPath)).toBe(false);
  });

  it("refuses to preview a missing cache", () => {
    expect(() =>
      previewMigrations({ databasePath: makeDatabasePath(), migrations: [addAuditTable] }),
    ).toThrowError(/missing/);
  });
});

describe("runMigrations", () => {
  it("applies pending steps, verifies, and records one event per step", () => {
    const databasePath = makeDatabasePath();
    createCurrentSchemaCache(databasePath);

    const result = runMigrations({
      databasePath,
      migrations: [addAuditTable, addAuditIndex],
      targetVersion: 3,
      now: () => FIXED_NOW,
    });

    expect(result.applied).toEqual([
      { version: 2, name: "add-audit-table" },
      { version: 3, name: "add-audit-index" },
    ]);
    expect(result.events).toEqual([
      { version: 2, name: "add-audit-table", applied_at: FIXED_NOW },
      { version: 3, name: "add-audit-index", applied_at: FIXED_NOW },
    ]);
    expect(readMetaValue(databasePath, "schema_version")).toBe("3");
    expect(tableNames(databasePath)).toContain("audit_log");
    expect(migrationEvents(databasePath)).toEqual(result.events);

    // The backup holds the exact pre-run state.
    expect(result.backupPath).toBeDefined();
    expect(readMetaValue(result.backupPath as string, "schema_version")).toBe(
      String(GRAPH_SCHEMA_VERSION),
    );
    expect(tableNames(result.backupPath as string)).not.toContain("audit_log");
  });

  it("takes no backup and records nothing when already at the target", () => {
    const databasePath = makeDatabasePath();
    createCurrentSchemaCache(databasePath);

    const result = runMigrations({ databasePath, migrations: [addAuditTable] });
    expect(result.applied).toEqual([]);
    expect(result.backupPath).toBeUndefined();
    expect(migrationEvents(databasePath)).toEqual([]);
  });

  it("rolls the whole run back when a step fails midway", () => {
    const databasePath = makeDatabasePath();
    createCurrentSchemaCache(databasePath);
    const broken: GraphMigration = {
      version: 3,
      name: "broken-step",
      up: () => {
        throw new Error("simulated crash inside migration");
      },
    };

    let caught: unknown;
    try {
      runMigrations({
        databasePath,
        migrations: [addAuditTable, broken],
        targetVersion: 3,
        now: () => FIXED_NOW,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GraphMigrationError);
    expect((caught as GraphMigrationError).rolledBack).toBe(true);
    // Pre-run bytes restored: the successful first step and its event are gone.
    expect(readMetaValue(databasePath, "schema_version")).toBe(String(GRAPH_SCHEMA_VERSION));
    expect(tableNames(databasePath)).not.toContain("audit_log");
    expect(migrationEvents(databasePath)).toEqual([]);
    // The cache is still a healthy current-schema database.
    const reopened = openGraphDatabase(databasePath);
    reopened.close();
  });
});

describe("ensureCurrentSchema", () => {
  it("migrates an older recorded version forward before opening", () => {
    const databasePath = makeDatabasePath();
    createCurrentSchemaCache(databasePath);
    // Simulate a cache recorded before schema version 1 existed.
    const raw = new DatabaseSync(databasePath);
    raw.prepare("UPDATE meta SET value = '0' WHERE key = 'schema_version'").run();
    raw.close();

    const baseline: GraphMigration = {
      version: 1,
      name: "baseline-marker",
      up: (database) => {
        database.exec("CREATE TABLE baseline_marker (id TEXT PRIMARY KEY)");
      },
    };
    const database = ensureCurrentSchema(databasePath, {
      migrations: [baseline],
      now: () => FIXED_NOW,
    });
    try {
      expect(readSchemaVersion(database)).toBe(GRAPH_SCHEMA_VERSION);
    } finally {
      database.close();
    }
    expect(tableNames(databasePath)).toContain("baseline_marker");
    expect(migrationEvents(databasePath)).toEqual([
      { version: 1, name: "baseline-marker", applied_at: FIXED_NOW },
    ]);
  });

  it("opens a current cache without touching it", () => {
    const databasePath = makeDatabasePath();
    createCurrentSchemaCache(databasePath);
    const database = ensureCurrentSchema(databasePath);
    database.close();
    expect(migrationEvents(databasePath)).toEqual([]);
  });

  it("leaves the production registry empty at schema version 1", () => {
    expect(GRAPH_MIGRATIONS).toEqual([]);
  });
});
