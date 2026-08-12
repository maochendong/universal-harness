import { copyFileSync, existsSync } from "node:fs";

import { DatabaseSync } from "node:sqlite";

import {
  GRAPH_SCHEMA_VERSION,
  META_KEYS,
  openGraphDatabase,
  readSchemaVersion,
  writeMeta,
} from "../sqlite/database.js";
import {
  GRAPH_MIGRATIONS,
  GraphMigrationError,
  pendingMigrations,
  type GraphMigration,
} from "./registry.js";

/**
 * Migration runner for the disposable graph cache. A run is atomic at the
 * file level: the pre-run bytes are backed up, each migration step commits in
 * its own transaction together with its migration event, and any failure
 * restores the backup wholesale — a failed run leaves either the fully
 * migrated cache or the exact pre-migration bytes, never a half-upgraded one.
 *
 * Migration events are recorded inside the same transaction as the step they
 * describe, so an event exists only for a migration that authoritatively
 * succeeded. The ledger is never written here: migrations transform only the
 * rebuildable projection, and the registry in code is their source of truth.
 */
export interface MigrationStep {
  readonly version: number;
  readonly name: string;
}

export interface MigrationPlan {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly steps: readonly MigrationStep[];
  /** File the runner will snapshot before applying anything. */
  readonly backupPath: string;
}

export interface MigrationEventRecord {
  readonly version: number;
  readonly name: string;
  readonly applied_at: string;
}

export interface MigrationRunResult {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly applied: readonly MigrationStep[];
  /** Undefined when no step was needed and no backup was taken. */
  readonly backupPath: string | undefined;
  readonly events: readonly MigrationEventRecord[];
}

export interface MigrationOptions {
  readonly databasePath: string;
  readonly migrations?: readonly GraphMigration[];
  readonly targetVersion?: number;
  readonly backupPath?: string;
  /** Injectable clock so recorded migration events stay deterministic. */
  readonly now?: () => string;
}

const MIGRATION_EVENTS_DDL =
  "CREATE TABLE IF NOT EXISTS migration_events (" +
  "version INTEGER NOT NULL, " +
  "name TEXT NOT NULL, " +
  "applied_at TEXT NOT NULL, " +
  "PRIMARY KEY (version, name))";

function backupPathFor(databasePath: string, fromVersion: number, toVersion: number): string {
  return `${databasePath}.backup-v${fromVersion}-to-v${toVersion}`;
}

function peekSchemaVersion(databasePath: string): number | undefined {
  const database = new DatabaseSync(databasePath);
  try {
    return readSchemaVersion(database);
  } finally {
    database.close();
  }
}

function requireExistingCache(databasePath: string): number {
  if (databasePath === ":memory:" || !existsSync(databasePath)) {
    throw new GraphMigrationError(
      `graph cache is missing at ${databasePath}; rebuild it instead of migrating`,
    );
  }
  const version = peekSchemaVersion(databasePath);
  if (version === undefined) {
    throw new GraphMigrationError(
      `graph cache at ${databasePath} has no schema metadata; rebuild it instead of migrating`,
    );
  }
  return version;
}

/** Read-only preview of what a migration run would do. Never writes. */
export function previewMigrations(options: MigrationOptions): MigrationPlan {
  const migrations = options.migrations ?? GRAPH_MIGRATIONS;
  const targetVersion = options.targetVersion ?? GRAPH_SCHEMA_VERSION;
  const fromVersion = requireExistingCache(options.databasePath);
  const steps = pendingMigrations(migrations, fromVersion, targetVersion);
  return {
    fromVersion,
    toVersion: targetVersion,
    steps: steps.map((step) => ({ version: step.version, name: step.name })),
    backupPath:
      options.backupPath ?? backupPathFor(options.databasePath, fromVersion, targetVersion),
  };
}

function assertMigrated(database: DatabaseSync, targetVersion: number): void {
  const rows = database.prepare("PRAGMA integrity_check").all() as unknown as {
    integrity_check: unknown;
  }[];
  if (rows.length !== 1 || String(rows[0]?.integrity_check) !== "ok") {
    throw new GraphMigrationError("post-migration integrity check failed");
  }
  if (readSchemaVersion(database) !== targetVersion) {
    throw new GraphMigrationError(
      `post-migration schema version does not match target ${targetVersion}`,
    );
  }
}

/**
 * Apply pending forward migrations with backup, verification and rollback.
 * Throws GraphMigrationError; when `rolledBack` is true the cache file holds
 * the exact pre-migration bytes again.
 */
export function runMigrations(options: MigrationOptions): MigrationRunResult {
  const migrations = options.migrations ?? GRAPH_MIGRATIONS;
  const targetVersion = options.targetVersion ?? GRAPH_SCHEMA_VERSION;
  const now = options.now ?? (() => new Date().toISOString());
  const plan = previewMigrations(options);

  if (plan.steps.length === 0) {
    return {
      fromVersion: plan.fromVersion,
      toVersion: plan.toVersion,
      applied: [],
      backupPath: undefined,
      events: [],
    };
  }

  copyFileSync(options.databasePath, plan.backupPath);
  const database = new DatabaseSync(options.databasePath);
  const events: MigrationEventRecord[] = [];
  const stepsByVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  try {
    for (const step of plan.steps) {
      const migration = stepsByVersion.get(step.version) as GraphMigration;
      const appliedAt = now();
      database.exec("BEGIN");
      try {
        database.exec(MIGRATION_EVENTS_DDL);
        migration.up(database);
        writeMeta(database, META_KEYS.schemaVersion, String(migration.version));
        // The event lands only when the surrounding transaction commits, i.e.
        // only when the migration authoritatively succeeded.
        database
          .prepare("INSERT INTO migration_events (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, appliedAt);
        database.exec("COMMIT");
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // The connection may already be unusable; the file restore below decides.
        }
        throw error;
      }
      events.push({ version: migration.version, name: migration.name, applied_at: appliedAt });
    }
    assertMigrated(database, targetVersion);
    database.close();
  } catch (error) {
    try {
      database.close();
    } catch {
      // Already closed; the restore still has to run.
    }
    copyFileSync(plan.backupPath, options.databasePath);
    const cause = error instanceof Error ? error : new Error(String(error));
    throw new GraphMigrationError(
      `migration run from schema version ${plan.fromVersion} to ${plan.toVersion} failed and was rolled back: ${cause.message}`,
      { rolledBack: true, cause },
    );
  }

  return {
    fromVersion: plan.fromVersion,
    toVersion: plan.toVersion,
    applied: plan.steps,
    backupPath: plan.backupPath,
    events,
  };
}

/**
 * Open the cache at the current schema version, migrating forward first when
 * the recorded version is behind. A missing or corrupt cache is not migrated
 * here — that is recovery territory handled by `rebuildGraphCache`.
 */
export function ensureCurrentSchema(
  databasePath: string,
  options?: Omit<MigrationOptions, "databasePath">,
): DatabaseSync {
  const targetVersion = options?.targetVersion ?? GRAPH_SCHEMA_VERSION;
  if (databasePath !== ":memory:" && existsSync(databasePath)) {
    const recorded = peekSchemaVersion(databasePath);
    if (recorded !== undefined && recorded < targetVersion) {
      runMigrations({ databasePath, ...options });
    }
  }
  return openGraphDatabase(databasePath);
}
