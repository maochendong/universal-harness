import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { resolveHarnessPath, sha256Hex } from "@universal-harness-internal/core";

/**
 * Managed projection output (design 13.7, plan Task 22). Every projection the
 * engine writes -- human-readable views and Provider Instruction Mirrors --
 * lands inside the managed `.harness/projections/` directory and nowhere
 * else. A write that would replace bytes the engine did not generate (a
 * hand-edited mirror, or user configuration) is refused unless the caller
 * presents an explicit overwrite approval; provider files outside the managed
 * root are never touched without one (completion rule 28).
 */
export const PROJECTION_ERROR_KINDS = [
  "invalid_projection_output",
  "unmanaged_path",
  "unapproved_overwrite",
] as const;

export type ProjectionErrorKind = (typeof PROJECTION_ERROR_KINDS)[number];

export class ProjectionError extends Error {
  readonly kind: ProjectionErrorKind;

  constructor(kind: ProjectionErrorKind, message: string) {
    super(message);
    this.name = "ProjectionError";
    this.kind = kind;
  }
}

/** Root of every managed projection, relative to the harness root. */
export const MANAGED_PROJECTION_DIRECTORY = "projections";

const OUTPUT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

/** One deterministic projection output: harness-relative path plus content. */
export interface ManagedOutput {
  /** Path relative to the managed projection directory, e.g. `views/prd.md`. */
  readonly name: string;
  readonly content: string;
}

/**
 * Validate a projection output name and return its harness-relative path.
 * Anything that could escape the managed root (absolute paths, `..`, drive
 * separators) is rejected with a typed error before any path is built.
 */
export function managedProjectionPath(name: string): string {
  if (
    !OUTPUT_NAME_PATTERN.test(name) ||
    name.includes("..") ||
    name.includes("\\") ||
    name.endsWith("/")
  ) {
    throw new ProjectionError(
      "unmanaged_path",
      `projection output name ${JSON.stringify(name)} is not a managed relative path`,
    );
  }
  return `${MANAGED_PROJECTION_DIRECTORY}/${name}`;
}

export type ManagedWriteAction = "create" | "rewrite" | "noop";

export interface ManagedWritePlan {
  readonly relativePath: string;
  readonly action: ManagedWriteAction;
  /** Digest of the bytes the write would publish. */
  readonly digest: string;
  /** Digest of the bytes currently on disk, when the target exists. */
  readonly existing_digest?: string;
}

/**
 * Preview a managed write without touching disk: the caller presents this
 * plan for approval whenever the action is `rewrite` of foreign bytes.
 */
export function planManagedWrite(harnessRoot: string, output: ManagedOutput): ManagedWritePlan {
  const relativePath = managedProjectionPath(output.name);
  const digest = sha256Hex(output.content);
  const absolute = resolveHarnessPath(harnessRoot, relativePath);
  if (!existsSync(absolute)) return { relativePath, action: "create", digest };
  const existingDigest = sha256Hex(readFileSync(absolute, "utf8"));
  if (existingDigest === digest) return { relativePath, action: "noop", digest };
  return { relativePath, action: "rewrite", digest, existing_digest: existingDigest };
}

export interface ManagedWriteResult {
  readonly relativePath: string;
  readonly action: ManagedWriteAction;
  readonly digest: string;
}

/**
 * Execute a managed write. A `rewrite` over bytes that differ from the new
 * content requires `overwriteApproved: true`; without the approval the write
 * is refused and nothing on disk changes. Writes stay inside the managed
 * projection root by construction of the path.
 */
export function writeManagedOutput(
  harnessRoot: string,
  output: ManagedOutput,
  options?: { readonly overwriteApproved?: boolean },
): ManagedWriteResult {
  const plan = planManagedWrite(harnessRoot, output);
  if (plan.action === "rewrite" && options?.overwriteApproved !== true) {
    throw new ProjectionError(
      "unapproved_overwrite",
      `refusing to overwrite ${plan.relativePath}: existing bytes (digest ${plan.existing_digest ?? "unknown"}) differ from the generated projection; approve the preview first`,
    );
  }
  if (plan.action === "noop") {
    return { relativePath: plan.relativePath, action: "noop", digest: plan.digest };
  }
  const absolute = resolveHarnessPath(harnessRoot, plan.relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, output.content, "utf8");
  return {
    relativePath: plan.relativePath,
    action: plan.action,
    digest: plan.digest,
  };
}
