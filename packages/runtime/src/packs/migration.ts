import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { parsePackPolicyField, type PackPolicyField } from "@universal-harness-internal/plugin-sdk";

import { compareToolVersions } from "../tools/definition.js";
import { PackError } from "./resolver.js";

/**
 * Pack migration (design section 5, plan Task 25 step 4). A pack upgrade may
 * rename or retype policy fields; project overrides must be transformed
 * through an explicit, versioned migration chain instead of being silently
 * dropped or reinterpreted. Each step is a pure deterministic function over
 * the override fields. A missing chain link is a typed
 * `migration_unavailable`; a failing or contract-violating step is a typed
 * `migration_failed`. Nothing is written before the whole chain validates.
 */
export interface PackMigrationStep {
  readonly from_version: string;
  readonly to_version: string;
  /** Human-readable summary shown in the upgrade preview. */
  readonly description: string;
  /** Pure transform of project override fields between the two versions. */
  migrate(fields: readonly PackPolicyField[]): readonly PackPolicyField[];
}

/** Migration steps registered per pack name. */
export type PackMigrationRegistry = Readonly<Record<string, readonly PackMigrationStep[]>>;

/**
 * Plan the exact migration chain from `fromVersion` to `toVersion`. Equal
 * versions need no migration. Any gap in the chain is a typed error -- the
 * upgrade flow refuses to guess intermediate states.
 */
export function planPackMigration(
  registry: PackMigrationRegistry,
  packName: string,
  fromVersion: string,
  toVersion: string,
): readonly PackMigrationStep[] {
  if (fromVersion === toVersion) return [];
  const steps = registry[packName] ?? [];
  const chain: PackMigrationStep[] = [];
  const seen = new Set<string>([fromVersion]);
  let current = fromVersion;
  while (current !== toVersion) {
    const next = steps.find((step) => step.from_version === current);
    if (next === undefined) {
      throw new PackError(
        "migration_unavailable",
        `no migration path for pack ${packName} from ${fromVersion} to ${toVersion}: ` +
          `missing a step from ${current}`,
        { pack: packName, from_version: fromVersion, to_version: toVersion },
      );
    }
    if (seen.has(next.to_version)) {
      throw new PackError(
        "migration_unavailable",
        `migration chain for pack ${packName} cycles at ${next.to_version}`,
      );
    }
    seen.add(next.to_version);
    chain.push(next);
    current = next.to_version;
  }
  return chain;
}

export interface PackMigrationOutcome {
  readonly fields: readonly PackPolicyField[];
  /** `from_version -> to_version` summaries of every applied step. */
  readonly applied: readonly string[];
}

/**
 * Run a planned migration chain over project override fields. A throwing step
 * or a step that emits invalid or duplicate fields is a typed
 * `migration_failed`; the input array is never mutated.
 */
export function runPackMigration(
  chain: readonly PackMigrationStep[],
  fields: readonly PackPolicyField[],
): PackMigrationOutcome {
  let current: readonly PackPolicyField[] = fields;
  const applied: string[] = [];
  for (const step of chain) {
    let next: readonly PackPolicyField[];
    try {
      next = step.migrate(current);
    } catch (error) {
      throw new PackError(
        "migration_failed",
        `migration step ${step.from_version} -> ${step.to_version} failed: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    const seenPaths = new Set<string>();
    for (const field of next) {
      try {
        parsePackPolicyField(field);
      } catch (error) {
        throw new PackError(
          "migration_failed",
          `migration step ${step.from_version} -> ${step.to_version} produced an invalid ` +
            `field: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (seenPaths.has(field.path)) {
        throw new PackError(
          "migration_failed",
          `migration step ${step.from_version} -> ${step.to_version} produced ` +
            `field ${field.path} twice`,
        );
      }
      seenPaths.add(field.path);
    }
    applied.push(`${step.from_version} -> ${step.to_version}: ${step.description}`);
    current = next;
  }
  return { fields: current, applied };
}

/** One absolute file write inside a transaction. */
export interface TransactionalWrite {
  readonly path: string;
  readonly content: string;
}

/**
 * Commit a batch of file writes atomically enough for the pack store: every
 * file is written to a temporary sibling and renamed into place, and any
 * failure restores the previous bytes (or removes newly created files) before
 * the error propagates. Callers validate everything upfront; this is the last
 * line of defense against a partially applied upgrade.
 */
export function commitTransactionalWrites(writes: readonly TransactionalWrite[]): void {
  interface AppliedWrite {
    readonly path: string;
    readonly temporary: string;
    readonly previous: string | undefined;
  }
  const applied: AppliedWrite[] = [];
  const rollback = (failed: unknown): never => {
    for (const entry of [...applied].reverse()) {
      try {
        if (entry.previous === undefined) {
          rmSync(entry.path, { force: true });
        } else {
          writeFileSync(entry.path, entry.previous, "utf8");
        }
      } finally {
        rmSync(entry.temporary, { force: true });
      }
    }
    throw failed;
  };
  for (const write of writes) {
    const temporary = `${write.path}.tmp-${String(process.pid)}`;
    try {
      const previous = existsSync(write.path) ? readFileSync(write.path, "utf8") : undefined;
      mkdirSync(dirname(write.path), { recursive: true });
      writeFileSync(temporary, write.content, "utf8");
      renameSync(temporary, write.path);
      applied.push({ path: write.path, temporary, previous });
    } catch (error) {
      // Best-effort temp cleanup: removal itself may fail (e.g. the parent
      // path is not a directory), and it must never mask the rollback.
      try {
        rmSync(temporary, { force: true });
      } catch {
        // ignore cleanup failures; rollback below restores the real state
      }
      rollback(error);
    }
  }
}

/** Compare two exact semantic versions; wraps the tool-version comparator. */
export function comparePackVersions(left: string, right: string): number {
  return compareToolVersions(left, right);
}
