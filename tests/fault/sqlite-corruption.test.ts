import { rmSync } from "node:fs";
import { join } from "node:path";

import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  GraphMigrationError,
  type GraphMigration,
} from "../../packages/graph/src/migrations/registry.js";
import { runMigrations } from "../../packages/graph/src/migrations/runner.js";
import { materializeLedger } from "../../packages/graph/src/materializer.js";
import { pageEdges, pageNodes } from "../../packages/graph/src/query-port.js";
import { checkGraphCache, rebuildGraphCache } from "../../packages/graph/src/rebuild.js";
import { commitScenario, makeProjectRoot } from "../../packages/graph/test/fixtures.js";
import { SimulatedProcessKill, corruptFile } from "../helpers/fault-injection.js";

/**
 * Cache fault injection: the SQLite projection must never be a single point
 * of failure. Corrupt, tampered or deleted caches are diagnosed without
 * mutation and fully rebuilt from the Git-native ledger, reproducing the
 * exact projection digest of the original materialization.
 */
const FIXED_NOW = "2026-08-12T00:00:00.000Z";

async function materializedScenario(): Promise<{
  projectRoot: string;
  databasePath: string;
  projectionDigest: string;
  nodeRows: unknown[];
  edgeRows: unknown[];
}> {
  const projectRoot = makeProjectRoot();
  await commitScenario(projectRoot);
  const databasePath = join(projectRoot, ".harness", "cache", "graph.db");
  const { database, report } = materializeLedger({ projectRoot, databasePath });
  const nodeRows = pageNodes(database, { limit: 500 }).items;
  const edgeRows = pageEdges(database, { limit: 500 }).items;
  database.close();
  return {
    projectRoot,
    databasePath,
    projectionDigest: report.projectionDigest,
    nodeRows,
    edgeRows,
  };
}

function metaValue(databasePath: string, key: string): string | undefined {
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

describe("sqlite corruption fault injection", () => {
  it("detects a corrupt cache file and rebuilds an identical projection", async () => {
    const scenario = await materializedScenario();
    expect(checkGraphCache(scenario.databasePath).status).toBe("ok");

    corruptFile(scenario.databasePath);
    expect(checkGraphCache(scenario.databasePath).status).toBe("corrupt");

    const rebuilt = rebuildGraphCache({
      projectRoot: scenario.projectRoot,
      databasePath: scenario.databasePath,
    });
    try {
      expect(rebuilt.recoveredFrom).toBe("corrupt");
      expect(rebuilt.report.projectionDigest).toBe(scenario.projectionDigest);
      expect(pageNodes(rebuilt.database, { limit: 500 }).items).toEqual(scenario.nodeRows);
      expect(pageEdges(rebuilt.database, { limit: 500 }).items).toEqual(scenario.edgeRows);
      expect(checkGraphCache(scenario.databasePath).status).toBe("ok");
    } finally {
      rebuilt.database.close();
    }
  });

  it("recovers a deleted cache file from the ledger alone", async () => {
    const scenario = await materializedScenario();
    rmSync(scenario.databasePath);
    expect(checkGraphCache(scenario.databasePath).status).toBe("missing");

    const rebuilt = rebuildGraphCache({
      projectRoot: scenario.projectRoot,
      databasePath: scenario.databasePath,
    });
    try {
      expect(rebuilt.recoveredFrom).toBe("missing");
      expect(rebuilt.report.projectionDigest).toBe(scenario.projectionDigest);
      expect(pageNodes(rebuilt.database, { limit: 500 }).items).toEqual(scenario.nodeRows);
    } finally {
      rebuilt.database.close();
    }
  });

  it("detects row-level tampering the file integrity check cannot see", async () => {
    const scenario = await materializedScenario();

    // UPDATEs keep the file format perfectly valid; only the projection
    // digest cross-check can catch this class of damage.
    const tampered = new DatabaseSync(scenario.databasePath);
    tampered.prepare("UPDATE nodes SET digest = 'sha256:tampered' WHERE id = 'decision_01'").run();
    tampered.close();

    const check = checkGraphCache(scenario.databasePath);
    expect(check.status).toBe("inconsistent");

    const rebuilt = rebuildGraphCache({
      projectRoot: scenario.projectRoot,
      databasePath: scenario.databasePath,
    });
    try {
      expect(rebuilt.recoveredFrom).toBe("inconsistent");
      expect(rebuilt.report.projectionDigest).toBe(scenario.projectionDigest);
      expect(checkGraphCache(scenario.databasePath).status).toBe("ok");
    } finally {
      rebuilt.database.close();
    }
  });

  it("rolls back an interrupted migration run and records no events", async () => {
    const scenario = await materializedScenario();
    const addV2Table: GraphMigration = {
      version: 2,
      name: "add-v2-table",
      up: (database) => {
        database.exec("CREATE TABLE v2_marker (id TEXT PRIMARY KEY)");
      },
    };
    const killedV3: GraphMigration = {
      version: 3,
      name: "killed-mid-apply",
      up: (database) => {
        database.exec("CREATE TABLE v3_partial (id TEXT PRIMARY KEY)");
        throw new SimulatedProcessKill("validation.completed");
      },
    };

    let caught: unknown;
    try {
      runMigrations({
        databasePath: scenario.databasePath,
        migrations: [addV2Table, killedV3],
        targetVersion: 3,
        now: () => FIXED_NOW,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GraphMigrationError);
    expect((caught as GraphMigrationError).rolledBack).toBe(true);
    expect((caught as GraphMigrationError).cause).toBeInstanceOf(SimulatedProcessKill);

    // The interrupted run left the exact pre-migration bytes: no partial
    // table, no schema bump, and no migration event — events exist only for
    // authoritatively successful migrations.
    expect(metaValue(scenario.databasePath, "schema_version")).toBe("1");
    expect(tableNames(scenario.databasePath)).not.toContain("v2_marker");
    expect(tableNames(scenario.databasePath)).not.toContain("v3_partial");
    expect(tableNames(scenario.databasePath)).not.toContain("migration_events");

    // Recovery is unaffected by the failed run.
    const rebuilt = rebuildGraphCache({
      projectRoot: scenario.projectRoot,
      databasePath: scenario.databasePath,
    });
    try {
      expect(rebuilt.report.projectionDigest).toBe(scenario.projectionDigest);
    } finally {
      rebuilt.database.close();
    }
  });

  it("recovers from backup bytes alone after a failed migration", async () => {
    const scenario = await materializedScenario();
    const broken: GraphMigration = {
      version: 2,
      name: "broken",
      up: () => {
        throw new SimulatedProcessKill("shards.renamed");
      },
    };
    let backupPath: string | undefined;
    try {
      runMigrations({
        databasePath: scenario.databasePath,
        migrations: [broken],
        targetVersion: 2,
        now: () => FIXED_NOW,
      });
    } catch (error) {
      backupPath = join(scenario.databasePath + ".backup-v1-to-v2");
      expect((error as GraphMigrationError).rolledBack).toBe(true);
    }
    expect(backupPath).toBeDefined();
    // The backup snapshot is itself a healthy, fully queryable cache.
    expect(checkGraphCache(backupPath as string).status).toBe("ok");
    expect(metaValue(backupPath as string, "projection_digest")).toBe(scenario.projectionDigest);
  });
});
