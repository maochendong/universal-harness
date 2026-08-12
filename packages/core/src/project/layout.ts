import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { harnessRootFor, resolveHarnessPath } from "../ledger/layout.js";
import {
  parseProjectManifest,
  serializeProjectManifest,
  type ProjectManifest,
} from "./manifest.js";
import { parsePackLock, serializePackLock, type PackLock } from "./lockfile.js";

/**
 * Managed project layout (design section 7). Initialization writes only
 * inside `.harness`, and every path goes through `resolveHarnessPath`, so no
 * managed write can escape the project control plane; the root `.gitignore`
 * of an adopted project is never touched. Managed files are authoritative
 * Git-committed data; local-only state (`cache/`, `staging/`, `raw-traces/`,
 * generated provider mirrors) is excluded by the managed `.gitignore`, and
 * immutable ledger shards and operation manifests carry `-merge` in the
 * managed `.gitattributes` so Git never text-merges (let alone union-merges)
 * Edge, Event or Ledger Operation Manifest content.
 */
export const MANIFEST_RELATIVE_PATH = "manifest.yaml";
export const PACK_LOCK_RELATIVE_PATH = "harness.lock";
export const MANAGED_GITIGNORE_RELATIVE_PATH = ".gitignore";
export const MANAGED_GITATTRIBUTES_RELATIVE_PATH = ".gitattributes";
export const GRAPH_DATABASE_RELATIVE_PATH = "cache/graph.db";

export const MANAGED_GITIGNORE_CONTENT = [
  "# Managed by Universal Harness: local-only state never enters Git.",
  "cache/",
  "staging/",
  "raw-traces/",
  "generated/providers/",
  "",
].join("\n");

export const MANAGED_GITATTRIBUTES_CONTENT = [
  "# Managed by Universal Harness: immutable ledger shards and operation",
  "# manifests never text-merge; digest conflicts block in `harness graph check`.",
  "ledger/** -merge",
  "events/** -merge",
  "",
].join("\n");

/** Authoritative artifact families, one directory per core node kind. */
export const ARTIFACT_DIRECTORIES = [
  "artifacts/repositories",
  "artifacts/intents",
  "artifacts/requirements",
  "artifacts/constraints",
  "artifacts/decisions",
  "artifacts/components",
  "artifacts/plans",
  "artifacts/tasks",
  "artifacts/tests",
  "artifacts/eval-cases",
  "artifacts/contexts",
  "artifacts/runs",
  "artifacts/evidence",
  "artifacts/findings",
  "artifacts/root-causes",
  "artifacts/approvals",
  "artifacts/improvements",
  "artifacts/iterations",
] as const;

export const MANAGED_DIRECTORIES = [
  ...ARTIFACT_DIRECTORIES,
  "ledger/edges",
  "ledger/operations",
  "events",
  "checkpoints",
  "packs/upstream",
  "packs/project",
  "policies",
  "views",
  "generated/providers",
  "raw-traces",
  "cache",
  "staging",
  "locks",
] as const;

export class ProjectLayoutError extends Error {
  readonly kind = "project_layout_error" as const;

  constructor(message: string) {
    super(message);
    this.name = "ProjectLayoutError";
  }
}

/** Existing managed content differs; initialization never overwrites it. */
export class ManagedFileConflictError extends Error {
  readonly kind = "managed_file_conflict" as const;
  readonly relativePath: string;

  constructor(relativePath: string) {
    super(`managed file already exists with different content: .harness/${relativePath}`);
    this.name = "ManagedFileConflictError";
    this.relativePath = relativePath;
  }
}

export interface ManagedLayoutInit {
  /** Managed relative paths written during this call. */
  readonly created: readonly string[];
  /** Managed relative paths already present with identical content. */
  readonly reused: readonly string[];
}

function writeManagedFile(
  harnessRoot: string,
  relativePath: string,
  content: string,
  outcome: { created: string[]; reused: string[] },
): void {
  const absolute = resolveHarnessPath(harnessRoot, relativePath);
  if (existsSync(absolute)) {
    if (readFileSync(absolute, "utf8") === content) {
      outcome.reused.push(relativePath);
      return;
    }
    throw new ManagedFileConflictError(relativePath);
  }
  writeFileSync(absolute, content, "utf8");
  outcome.created.push(relativePath);
}

/**
 * Create the managed control plane inside `projectRoot`. Only paths under
 * `.harness` are touched. Re-running with identical manifest and lock
 * content is an idempotent no-op; diverging managed files block with a
 * typed conflict instead of being silently overwritten.
 */
export function initializeManagedLayout(options: {
  readonly projectRoot: string;
  readonly manifest: ProjectManifest;
  readonly packLock: PackLock;
}): ManagedLayoutInit {
  const harnessRoot = harnessRootFor(resolve(options.projectRoot));
  const created: string[] = [];
  const reused: string[] = [];
  const outcome = { created, reused };
  for (const directory of MANAGED_DIRECTORIES) {
    mkdirSync(resolveHarnessPath(harnessRoot, directory), { recursive: true });
  }
  writeManagedFile(
    harnessRoot,
    MANIFEST_RELATIVE_PATH,
    serializeProjectManifest(options.manifest),
    outcome,
  );
  writeManagedFile(
    harnessRoot,
    PACK_LOCK_RELATIVE_PATH,
    serializePackLock(options.packLock),
    outcome,
  );
  writeManagedFile(
    harnessRoot,
    MANAGED_GITIGNORE_RELATIVE_PATH,
    MANAGED_GITIGNORE_CONTENT,
    outcome,
  );
  writeManagedFile(
    harnessRoot,
    MANAGED_GITATTRIBUTES_RELATIVE_PATH,
    MANAGED_GITATTRIBUTES_CONTENT,
    outcome,
  );
  return { created, reused };
}

/**
 * Walk up from `startDirectory` looking for `.harness/manifest.yaml`.
 * Returns the managed project root, or `undefined` outside any project.
 */
export function findProjectRoot(startDirectory: string): string | undefined {
  let current = resolve(startDirectory);
  for (;;) {
    if (existsSync(join(harnessRootFor(current), MANIFEST_RELATIVE_PATH))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function readManagedManifest(projectRoot: string): ProjectManifest {
  const absolute = resolveHarnessPath(harnessRootFor(projectRoot), MANIFEST_RELATIVE_PATH);
  if (!existsSync(absolute)) {
    throw new ProjectLayoutError(`not a managed project (no manifest): ${projectRoot}`);
  }
  return parseProjectManifest(readFileSync(absolute, "utf8"));
}

export function readManagedPackLock(projectRoot: string): PackLock {
  const absolute = resolveHarnessPath(harnessRootFor(projectRoot), PACK_LOCK_RELATIVE_PATH);
  if (!existsSync(absolute)) {
    throw new ProjectLayoutError(`managed project has no pack lock: ${projectRoot}`);
  }
  return parsePackLock(readFileSync(absolute, "utf8"));
}
