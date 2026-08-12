import { existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { VcsAdapter } from "@universal-harness-internal/plugin-sdk";
import {
  canonicalizeJson,
  contentDigest,
  harnessRootFor,
  resolveHarnessPath,
  stagingRelativePath,
  ulid,
} from "@universal-harness-internal/core";

/**
 * Shared bootstrap types and the adoption staging store.
 *
 * Bootstrap flows report outcomes as typed results instead of throwing, so
 * callers (CLI bridge, tests, later workflow stages) can distinguish user
 * correctable conditions from genuine failures. Staging documents live under
 * `.harness/staging/<operation-id>/` — local-only, Git-ignored scratch space
 * that never counts as authoritative data until an approval-bound baseline
 * commit lands.
 */
export type BootstrapErrorKind =
  | "invalid_name"
  | "parent_not_found"
  | "target_exists"
  | "path_not_found"
  | "not_a_directory"
  | "already_managed"
  | "not_a_repository"
  | "not_repository_root"
  | "no_baseline_commit"
  | "worktree_dirty"
  | "staging_not_found"
  | "staging_corrupt"
  | "approval_binding_mismatch"
  | "preview_drift"
  | "layout_conflict"
  | "vcs_failure"
  | "ledger_failure";

export interface BootstrapError {
  readonly kind: BootstrapErrorKind;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

export type BootstrapResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: BootstrapError };

export function bootstrapOk<T>(value: T): BootstrapResult<T> {
  return { ok: true, value };
}

export function bootstrapErr<T = never>(error: BootstrapError): BootstrapResult<T> {
  return { ok: false, error };
}

/** Identifier kinds minted by bootstrap flows; all match the schema pattern. */
export type BootstrapIdKind =
  "workflow" | "attempt" | "event" | "iteration" | "bootstrap" | "adopt-scan" | "adopt-baseline";

export interface BootstrapDependencies {
  readonly vcs: VcsAdapter;
  /** Injectable clock (ISO 8601 UTC) for deterministic tests. */
  readonly now?: () => string;
  /** Injectable id mint for deterministic tests; defaults to ULID-based ids. */
  readonly newId?: (kind: BootstrapIdKind) => string;
}

export function nowOf(deps: BootstrapDependencies): string {
  return (deps.now ?? (() => new Date().toISOString()))();
}

export function newIdOf(deps: BootstrapDependencies, kind: BootstrapIdKind): string {
  return (deps.newId ?? ((idKind) => `${idKind}_${ulid()}`))(kind);
}

export function projectIdFor(name: string): string {
  return `project_${name}`;
}

export function repositoryIdFor(name: string): string {
  return `repo_${name}`;
}

/** Identity stamped on harness-authored commits (never ambient git config). */
export const HARNESS_COMMIT_IDENTITY = {
  name: "Universal Harness",
  email: "harness@localhost",
} as const;

/** Deterministic pack pin until packs publish canonical content (Task 25). */
export function lockedPackForStack(stack: string): {
  readonly name: string;
  readonly version: string;
  readonly digest: string;
} {
  const name = `pack-${stack}`;
  const version = "0.0.0";
  return { name, version, digest: contentDigest({ name, pack_format: 1, version }) };
}

export const PREVIEW_DOCUMENT = "preview.json";
export const SEMANTIC_INPUT_DOCUMENT = "semantic-input.json";
export const REQUEST_DOCUMENT = "request.json";

function stagingDirectory(projectRoot: string, operationId: string): string {
  return resolveHarnessPath(harnessRootFor(projectRoot), stagingRelativePath(operationId));
}

/** Write canonical JSON documents into a fresh staging directory. */
export function writeStagedDocuments(
  projectRoot: string,
  operationId: string,
  documents: Readonly<Record<string, unknown>>,
): void {
  const directory = stagingDirectory(projectRoot, operationId);
  mkdirSync(directory, { recursive: true });
  for (const [name, document] of Object.entries(documents)) {
    writeFileSync(resolveHarnessPath(directory, name), `${canonicalizeJson(document)}\n`, "utf8");
  }
}

/** Read one staged document back, or `undefined` when it does not exist. */
export function readStagedDocument(
  projectRoot: string,
  operationId: string,
  name: string,
): unknown {
  const absolute = resolveHarnessPath(stagingDirectory(projectRoot, operationId), name);
  if (!existsSync(absolute)) return undefined;
  const raw = readFileSync(absolute, "utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function stagedOperationExists(projectRoot: string, operationId: string): boolean {
  return existsSync(stagingDirectory(projectRoot, operationId));
}

/**
 * Remove a staging directory and prune the `.harness` shell when nothing else
 * lives in it, so a rejected adoption leaves the worktree byte-identical.
 */
export function discardStagedDocuments(projectRoot: string, operationId: string): void {
  const harnessRoot = harnessRootFor(resolve(projectRoot));
  rmSync(stagingDirectory(projectRoot, operationId), { recursive: true, force: true });
  for (const directory of [resolveHarnessPath(harnessRoot, "staging"), harnessRoot]) {
    try {
      rmdirSync(directory);
    } catch {
      // Not empty: other managed or staged content lives here; keep it.
    }
  }
}

/** Stable digest over a staged preview record (no volatile fields inside). */
export function stagedPreviewDigest(preview: unknown): string {
  return contentDigest(preview);
}
