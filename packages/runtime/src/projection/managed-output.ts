import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { contentDigest, resolveHarnessPath, sha256Hex } from "@universal-harness-internal/core";

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

export interface ManagedWriteOptions {
  readonly overwriteApproved?: boolean;
  /**
   * Permit replacing a Markdown Projection only when its embedded source
   * manifest and generation digest prove that the existing bytes are exactly
   * a previous Harness render. This is deliberately narrower than broad
   * overwrite approval and does not apply to provider mirrors or arbitrary
   * files under the managed directory.
   */
  readonly rewriteVerifiedProjection?: boolean;
}

const PROJECTION_START = "<!-- harness:projection\n";
const PROJECTION_HEADER_END = "\n-->\n\n";
const PROJECTION_VIEW = /^view: ([A-Za-z0-9][A-Za-z0-9._-]*)$/u;
const PROJECTION_DIGEST = /^generation_digest: ([a-f0-9]{64})$/u;
const PROJECTION_SOURCE = /^- ([A-Za-z0-9][A-Za-z0-9._:-]*) r([1-9][0-9]*)$/u;

/**
 * Verify the self-describing header emitted by the Markdown Projection
 * adapter. A hand edit changes the independently recomputed generation
 * digest, while a previous untouched render remains safe to replace with a
 * newer graph-derived view.
 */
export function isVerifiedHarnessProjection(content: string): boolean {
  if (!content.startsWith(PROJECTION_START) || !content.endsWith("\n")) return false;
  const headerEnd = content.indexOf(PROJECTION_HEADER_END, PROJECTION_START.length);
  if (headerEnd < 0) return false;
  const header = content.slice(PROJECTION_START.length, headerEnd).split("\n");
  if (header.length < 3 || header[2] !== "sources:") return false;
  const viewMatch = PROJECTION_VIEW.exec(header[0] ?? "");
  const digestMatch = PROJECTION_DIGEST.exec(header[1] ?? "");
  if (viewMatch === null || digestMatch === null) return false;
  const sources: { id: string; revision: number }[] = [];
  for (const line of header.slice(3)) {
    const source = PROJECTION_SOURCE.exec(line);
    if (source === null) return false;
    sources.push({ id: source[1] as string, revision: Number(source[2]) });
  }
  const ordered = [...sources].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  if (
    ordered.some(
      (source, index) =>
        source.id !== sources[index]?.id ||
        source.revision !== sources[index]?.revision ||
        (index > 0 && source.id === ordered[index - 1]?.id),
    )
  ) {
    return false;
  }
  const bodyStart = headerEnd + PROJECTION_HEADER_END.length;
  const body = content.slice(bodyStart, -1);
  return (
    contentDigest({ view: viewMatch[1] as string, sources, body }) === (digestMatch[1] as string)
  );
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
  options?: ManagedWriteOptions,
): ManagedWriteResult {
  const plan = planManagedWrite(harnessRoot, output);
  const verifiedProjectionRewrite =
    plan.action === "rewrite" &&
    options?.rewriteVerifiedProjection === true &&
    isVerifiedHarnessProjection(
      readFileSync(resolveHarnessPath(harnessRoot, plan.relativePath), "utf8"),
    );
  if (
    plan.action === "rewrite" &&
    options?.overwriteApproved !== true &&
    !verifiedProjectionRewrite
  ) {
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
