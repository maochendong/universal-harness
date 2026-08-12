import type { DatabaseSync } from "node:sqlite";

/**
 * Forward-only cache schema migrations. A migration transforms the disposable
 * SQLite projection from `version - 1` to `version`; it never touches the
 * Git-native ledger, and a rebuilt cache re-applies the same migrations
 * deterministically. M1 ships at schema version 1, so the production registry
 * is empty — the runner is exercised through injected migrations in tests.
 */
export interface GraphMigration {
  /** Schema version this migration produces. Must be contiguous from 1. */
  readonly version: number;
  readonly name: string;
  readonly up: (database: DatabaseSync) => void;
}

export const GRAPH_MIGRATIONS: readonly GraphMigration[] = [];

export class GraphMigrationError extends Error {
  readonly kind = "graph_migration_error" as const;
  /** True when a failed run restored the pre-migration backup bytes. */
  readonly rolledBack: boolean;

  constructor(
    message: string,
    options?: { readonly rolledBack?: boolean; readonly cause?: unknown },
  ) {
    super(message, options === undefined ? undefined : { cause: options.cause });
    this.name = "GraphMigrationError";
    this.rolledBack = options?.rolledBack ?? false;
  }
}

/**
 * Select the ordered migration steps that take a cache from `fromVersion` to
 * `toVersion`. The registry must offer an unbroken chain — a gap means there
 * is no migration path and the cache must be rebuilt instead.
 */
export function pendingMigrations(
  migrations: readonly GraphMigration[],
  fromVersion: number,
  toVersion: number,
): GraphMigration[] {
  if (fromVersion > toVersion) {
    throw new GraphMigrationError(
      `cache schema version ${fromVersion} is newer than target ${toVersion}; rebuild the cache`,
    );
  }
  const steps = migrations
    .filter((migration) => migration.version > fromVersion && migration.version <= toVersion)
    .sort((left, right) => left.version - right.version);
  let expected = fromVersion + 1;
  for (const step of steps) {
    if (step.version !== expected) {
      throw new GraphMigrationError(
        `no migration path from schema version ${fromVersion} to ${toVersion}: version ${expected} is missing; rebuild the cache`,
      );
    }
    expected += 1;
  }
  if (steps.length !== toVersion - fromVersion) {
    throw new GraphMigrationError(
      `no migration path from schema version ${fromVersion} to ${toVersion}; rebuild the cache`,
    );
  }
  return steps;
}
