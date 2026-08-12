import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { DatabaseSync } from "node:sqlite";

/**
 * SQLite cache for the materialized graph. The schema lives in `schema.sql`
 * next to this module (copied to `dist/sqlite/` by `scripts/copy-schema.mjs`
 * at build time) so the DDL has exactly one source of truth. The database is
 * always a disposable projection: nothing written here is authoritative.
 */
export const GRAPH_SCHEMA_VERSION = 1;

export const META_KEYS = {
  schemaVersion: "schema_version",
  protocolVersion: "protocol_version",
  /** Cursor metadata: the highest committed ledger sequence materialized. */
  lastSequence: "last_sequence",
  operationCount: "operation_count",
  nodeCount: "node_count",
  edgeCount: "edge_count",
  eventCount: "event_count",
  /** Deterministic digest of the projected state; identical after a rebuild. */
  projectionDigest: "projection_digest",
} as const;

export type MetaKey = (typeof META_KEYS)[keyof typeof META_KEYS];

function schemaDdl(): string {
  return readFileSync(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8");
}

/**
 * Schema version recorded in an open database, or undefined when the meta
 * table does not exist yet (a fresh database).
 */
export function readSchemaVersion(database: DatabaseSync): number | undefined {
  const table = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get();
  if (table === undefined) return undefined;
  const recorded = readMeta(database, META_KEYS.schemaVersion);
  return recorded === undefined ? undefined : Number(recorded);
}

/**
 * Open (creating when needed) a graph database and apply the schema.
 * Pass ":memory:" for an ephemeral database. A schema created by a newer
 * GRAPH_SCHEMA_VERSION is rejected so a stale cache is never read silently;
 * an older recorded version is rejected too — the caller must migrate the
 * cache forward with the migration runner or rebuild it from the ledger,
 * never silently reuse or overwrite it.
 */
export function openGraphDatabase(databasePath: string): DatabaseSync {
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }
  const database = new DatabaseSync(databasePath);
  try {
    const recorded = readSchemaVersion(database);
    if (recorded !== undefined && recorded > GRAPH_SCHEMA_VERSION) {
      throw new GraphDatabaseError(
        `graph cache schema version ${recorded} is newer than supported ${GRAPH_SCHEMA_VERSION}; rebuild the cache`,
      );
    }
    if (recorded !== undefined && recorded < GRAPH_SCHEMA_VERSION) {
      throw new GraphDatabaseError(
        `graph cache schema version ${recorded} is older than ${GRAPH_SCHEMA_VERSION}; run graph migrations or rebuild the cache`,
      );
    }
    database.exec(schemaDdl());
    writeMeta(database, META_KEYS.schemaVersion, String(GRAPH_SCHEMA_VERSION));
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export class GraphDatabaseError extends Error {
  readonly kind = "graph_database_error" as const;

  constructor(message: string) {
    super(message);
    this.name = "GraphDatabaseError";
  }
}

export function readMeta(database: DatabaseSync, key: MetaKey): string | undefined {
  const row = database.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row === undefined ? undefined : String((row as { value: unknown }).value);
}

export function writeMeta(database: DatabaseSync, key: MetaKey, value: string): void {
  database
    .prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

/** Drop every projected row; meta cursor keys are rewritten by the caller. */
export function clearProjection(database: DatabaseSync): void {
  database.exec(
    "DELETE FROM operations; DELETE FROM nodes; DELETE FROM edges; DELETE FROM events;",
  );
}
