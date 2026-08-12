import { existsSync, rmSync } from "node:fs";

import { DatabaseSync } from "node:sqlite";

import {
  materializeLedger,
  verifyProjectionDigest,
  type MaterializationReport,
} from "./materializer.js";
import { GRAPH_SCHEMA_VERSION, readSchemaVersion } from "./sqlite/database.js";

/**
 * Cache recovery. The SQLite projection is disposable: a missing, corrupt,
 * incompatible or stale cache is deleted when necessary and rebuilt wholesale
 * from the authoritative Git-native ledger. `checkGraphCache` never mutates
 * anything; `rebuildGraphCache` is the explicit recovery command.
 */
export type GraphCacheStatus =
  "ok" | "missing" | "corrupt" | "unsupported_version" | "inconsistent";

export interface GraphCacheCheck {
  readonly status: GraphCacheStatus;
  readonly detail?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Diagnose a cache file without modifying it. Beyond SQLite-level integrity
 * (`PRAGMA integrity_check`), the recorded projection digest is recomputed
 * from table contents, so row-level tampering that leaves the file format
 * valid is still detected as "inconsistent".
 */
export function checkGraphCache(databasePath: string): GraphCacheCheck {
  if (databasePath === ":memory:") {
    return { status: "ok", detail: "ephemeral in-memory cache" };
  }
  if (!existsSync(databasePath)) {
    return { status: "missing", detail: `no cache file at ${databasePath}` };
  }
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(databasePath);
  } catch (error) {
    return { status: "corrupt", detail: errorMessage(error) };
  }
  try {
    const rows = database.prepare("PRAGMA integrity_check").all() as unknown as {
      integrity_check: unknown;
    }[];
    if (rows.length !== 1 || String(rows[0]?.integrity_check) !== "ok") {
      const detail = rows.map((row) => String(row.integrity_check)).join("; ");
      return { status: "corrupt", detail: detail.length > 0 ? detail : "integrity check failed" };
    }
    const version = readSchemaVersion(database);
    if (version !== undefined && version > GRAPH_SCHEMA_VERSION) {
      return {
        status: "unsupported_version",
        detail: `cache schema version ${version} is newer than supported ${GRAPH_SCHEMA_VERSION}`,
      };
    }
    if (!verifyProjectionDigest(database)) {
      return {
        status: "inconsistent",
        detail: "recorded projection digest does not match table contents",
      };
    }
    return { status: "ok" };
  } catch (error) {
    return { status: "corrupt", detail: errorMessage(error) };
  } finally {
    try {
      database.close();
    } catch {
      // Diagnosis already produced its verdict; closing must not mask it.
    }
  }
}

export interface GraphRebuild {
  readonly database: DatabaseSync;
  readonly report: MaterializationReport;
  /** Cache state found before recovery. */
  readonly recoveredFrom: GraphCacheStatus;
}

/**
 * Fully rebuild the cache from the Git ledger. Bytes SQLite cannot read
 * (corrupt file, unsupported newer schema) are deleted first; a readable but
 * inconsistent cache is replaced wholesale by the materializer's single
 * transaction. The returned projection digest is the proof of recovery: it
 * matches a fresh materialization of the same ledger exactly.
 */
export function rebuildGraphCache(options: {
  readonly projectRoot: string;
  readonly databasePath: string;
}): GraphRebuild {
  const check = checkGraphCache(options.databasePath);
  if (
    options.databasePath !== ":memory:" &&
    (check.status === "corrupt" || check.status === "unsupported_version")
  ) {
    rmSync(options.databasePath, { force: true });
  }
  const { database, report } = materializeLedger(options);
  return { database, report, recoveredFrom: check.status };
}
