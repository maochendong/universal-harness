import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  LedgerRepository,
  PROTOCOL_VERSION,
  canonicalizeJson,
  contentDigest,
  harnessRootFor,
  readCommittedOperations,
  resolveHarnessPath,
  sha256Hex,
  type NodeRecord,
} from "@universal-harness-internal/core";

import type { SnapshotRecord } from "./builder.js";

export const SNAPSHOT_ANCHOR_ERROR_KINDS = [
  "snapshot_not_found",
  "snapshot_not_completed",
  "commit_not_found",
  "evidence_mismatch",
  "anchor_conflict",
] as const;

export type SnapshotAnchorErrorKind = (typeof SNAPSHOT_ANCHOR_ERROR_KINDS)[number];

export class SnapshotAnchorError extends Error {
  readonly kind: SnapshotAnchorErrorKind;

  constructor(kind: SnapshotAnchorErrorKind, message: string) {
    super(message);
    this.name = "SnapshotAnchorError";
    this.kind = kind;
  }
}

export interface SnapshotAnchorCorrection {
  readonly protocol_version: string;
  readonly record_kind: "snapshot_anchor_correction";
  readonly snapshot_id: string;
  readonly iteration_id: string;
  readonly snapshot_digest: string;
  readonly original_final_commit: string;
  readonly corrected_source_commit: string;
  readonly code_digest: string;
  readonly reason: string;
  readonly actor: string;
  readonly anchored_at: string;
  readonly digest: string;
}

export interface AnchorSnapshotInput {
  readonly projectRoot: string;
  readonly snapshotId: string;
  readonly sourceCommit: string;
  readonly reason: string;
  readonly actor: string;
  readonly readBaseline: () => string;
  readonly now?: () => string;
}

export interface AnchorSnapshotResult {
  readonly status: "created" | "already_anchored";
  readonly correction: SnapshotAnchorCorrection;
}

function correctionDirectory(projectRoot: string, snapshotId: string): string {
  return resolveHarnessPath(
    harnessRootFor(projectRoot),
    `artifacts/snapshot-anchor-corrections/${snapshotId}`,
  );
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function verifyCorrectionDigest(correction: SnapshotAnchorCorrection): boolean {
  const content: Record<string, unknown> = { ...correction };
  delete content.digest;
  return contentDigest(content) === correction.digest;
}

function readCorrections(projectRoot: string, snapshotId: string): SnapshotAnchorCorrection[] {
  const directory = correctionDirectory(projectRoot, snapshotId);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readJson<SnapshotAnchorCorrection>(join(directory, entry.name)))
    .filter(
      (record) =>
        record.record_kind === "snapshot_anchor_correction" &&
        record.snapshot_id === snapshotId &&
        verifyCorrectionDigest(record),
    )
    .sort((left, right) => left.digest.localeCompare(right.digest));
}

function readSnapshot(projectRoot: string, snapshotId: string): SnapshotRecord {
  const path = resolveHarnessPath(
    harnessRootFor(projectRoot),
    `artifacts/snapshots/${snapshotId}.json`,
  );
  if (!existsSync(path)) {
    throw new SnapshotAnchorError("snapshot_not_found", `snapshot ${snapshotId} does not exist`);
  }
  return readJson<SnapshotRecord>(path);
}

function normalizeCommit(projectRoot: string, commit: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--verify", `${commit}^{commit}`], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new SnapshotAnchorError(
      "commit_not_found",
      `source commit ${JSON.stringify(commit)} does not exist in the project repository`,
    );
  }
}

function hashEntries(entries: readonly string[]): string {
  return sha256Hex([...entries].sort().join("\n"));
}

function worktreeCodeEntries(projectRoot: string): string[] {
  const listed = execFileSync(
    "git",
    ["-c", "core.quotepath=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: projectRoot, encoding: "utf8" },
  );
  return listed
    .split("\0")
    .filter((path) => path !== "" && path !== ".harness" && !path.startsWith(".harness/"))
    .map((relative) => {
      const absolute = join(projectRoot, relative);
      try {
        const stat = lstatSync(absolute);
        if (stat.isSymbolicLink()) {
          return `${relative}:symlink:${sha256Hex(readlinkSync(absolute))}`;
        }
        if (stat.isFile()) {
          const mode = (stat.mode & 0o111) === 0 ? "100644" : "100755";
          return `${relative}:file:${mode}:${sha256Hex(readFileSync(absolute).toString("base64"))}`;
        }
        return `${relative}:other`;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return `${relative}:missing`;
        throw error;
      }
    });
}

function commitCodeEntries(projectRoot: string, commit: string): string[] {
  const normalized = normalizeCommit(projectRoot, commit);
  const listed = execFileSync(
    "git",
    ["-c", "core.quotepath=false", "ls-tree", "-r", "-z", "--full-tree", normalized],
    {
      cwd: projectRoot,
      encoding: "utf8",
    },
  );
  return listed
    .split("\0")
    .filter((line) => line !== "")
    .map((line) => {
      const tab = line.indexOf("\t");
      const metadata = line.slice(0, tab).split(" ");
      const path = line.slice(tab + 1);
      return { mode: metadata[0] ?? "", object: metadata[2] ?? "", path };
    })
    .filter(({ path }) => path !== ".harness" && !path.startsWith(".harness/"))
    .map(({ mode, object, path }) => {
      if (mode === "120000") {
        const target = execFileSync("git", ["cat-file", "blob", object], {
          cwd: projectRoot,
          encoding: "utf8",
        });
        return `${path}:symlink:${sha256Hex(target)}`;
      }
      if (mode === "100644" || mode === "100755") {
        const bytes = execFileSync("git", ["cat-file", "blob", object], {
          cwd: projectRoot,
          encoding: "buffer",
        });
        return `${path}:file:${mode}:${sha256Hex(bytes.toString("base64"))}`;
      }
      return `${path}:other`;
    });
}

/** Digest every Git-visible worktree file outside the Harness control plane. */
export function hashWorktreeCode(projectRoot: string): string {
  return hashEntries(worktreeCodeEntries(projectRoot));
}

/** Digest project code exactly as it existed at a Git commit, excluding `.harness`. */
export function hashCommitCode(projectRoot: string, commit: string): string {
  return hashEntries(commitCodeEntries(projectRoot, commit));
}

/** First deterministic entry difference, for a typed binding-drift diagnostic. */
export function explainCodeDigestMismatch(projectRoot: string, commit: string): string {
  const worktree = new Set(worktreeCodeEntries(projectRoot));
  const committed = new Set(commitCodeEntries(projectRoot, commit));
  const worktreeOnly = [...worktree].filter((entry) => !committed.has(entry)).sort()[0];
  const commitOnly = [...committed].filter((entry) => !worktree.has(entry)).sort()[0];
  return `worktree-only=${worktreeOnly ?? "none"}; commit-only=${commitOnly ?? "none"}`;
}

function latestEvidenceNode(projectRoot: string, evidenceId: string): NodeRecord | undefined {
  const directory = resolveHarnessPath(
    harnessRootFor(projectRoot),
    `artifacts/evidence-nodes/${evidenceId}`,
  );
  if (!existsSync(directory)) return undefined;
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readJson<NodeRecord>(join(directory, entry.name)))
    .sort((left, right) => right.revision - left.revision)[0];
}

function evidenceProvesCodeDigest(
  projectRoot: string,
  snapshot: SnapshotRecord,
  codeDigest: string,
): boolean {
  return snapshot.evidence.some((evidenceId) => {
    const evidence = latestEvidenceNode(projectRoot, evidenceId);
    if (
      evidence?.type !== "Evidence" ||
      evidence.status !== "accepted" ||
      evidence.source !== "gate"
    ) {
      return false;
    }
    const extension = evidence.extensions?.["harness.evidence"];
    if (typeof extension !== "object" || extension === null) return false;
    const payload = extension as Record<string, unknown>;
    if (payload.passed !== true) return false;
    const bindings = payload.bindings;
    if (typeof bindings !== "object" || bindings === null) return false;
    const codeDigests = (bindings as Record<string, unknown>).code_digests;
    return Array.isArray(codeDigests) && codeDigests.includes(codeDigest);
  });
}

/**
 * Append a correction for a legacy Snapshot whose `final_commit` pointed at
 * the control-plane commit instead of the source tree proved by its gates.
 */
export async function anchorSnapshot(input: AnchorSnapshotInput): Promise<AnchorSnapshotResult> {
  const snapshot = readSnapshot(input.projectRoot, input.snapshotId);
  if (snapshot.status !== "completed") {
    throw new SnapshotAnchorError(
      "snapshot_not_completed",
      `snapshot ${input.snapshotId} is ${snapshot.status}; only completed snapshots can be anchored`,
    );
  }
  const sourceCommit = normalizeCommit(input.projectRoot, input.sourceCommit);
  const existing = readCorrections(input.projectRoot, input.snapshotId);
  const matching = existing.find(
    (correction) => correction.corrected_source_commit === sourceCommit,
  );
  if (matching !== undefined) return { status: "already_anchored", correction: matching };
  if (existing.length > 0) {
    throw new SnapshotAnchorError(
      "anchor_conflict",
      `snapshot ${input.snapshotId} already has a different source anchor`,
    );
  }

  const codeDigest = hashCommitCode(input.projectRoot, sourceCommit);
  if (!evidenceProvesCodeDigest(input.projectRoot, snapshot, codeDigest)) {
    throw new SnapshotAnchorError(
      "evidence_mismatch",
      `no accepted passing gate evidence in snapshot ${input.snapshotId} proves source commit ${sourceCommit}`,
    );
  }
  const reason = input.reason.trim();
  const actor = input.actor.trim();
  if (reason === "" || actor === "") {
    throw new SnapshotAnchorError(
      "evidence_mismatch",
      "snapshot anchor reason and actor must be non-empty",
    );
  }
  const correctionContent: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "snapshot_anchor_correction",
    snapshot_id: snapshot.snapshot_id,
    iteration_id: snapshot.iteration_id,
    snapshot_digest: snapshot.digest,
    original_final_commit: snapshot.final_commit,
    corrected_source_commit: sourceCommit,
    code_digest: codeDigest,
    reason,
    actor,
    anchored_at: input.now?.() ?? new Date().toISOString(),
  };
  const correction = {
    ...correctionContent,
    digest: contentDigest(correctionContent),
  } as unknown as SnapshotAnchorCorrection;
  const latest = readCommittedOperations(harnessRootFor(input.projectRoot)).at(-1)?.manifest;
  if (latest === undefined) {
    throw new SnapshotAnchorError(
      "snapshot_not_found",
      "the project has no committed Harness workflow operation",
    );
  }
  await new LedgerRepository({
    projectRoot: input.projectRoot,
    readBaseline: input.readBaseline,
    ...(input.now === undefined ? {} : { now: input.now }),
  }).commit({
    ledger_operation_id: `ledger_snapshot_anchor_${correction.digest.slice(0, 20)}`,
    workflow_operation_id: latest.workflow_operation_id,
    attempt_id: latest.attempt_id,
    expected_baseline: input.readBaseline(),
    artifacts: [
      {
        path: `artifacts/snapshot-anchor-corrections/${snapshot.snapshot_id}/${correction.digest}.json`,
        content: `${canonicalizeJson(correction)}\n`,
      },
    ],
    edges: [],
    events: [],
  });
  return { status: "created", correction };
}

/** Resolve the source commit for readers without rewriting the Snapshot. */
export function resolveSnapshotSourceCommit(projectRoot: string, snapshot: SnapshotRecord): string {
  const corrections = readCorrections(projectRoot, snapshot.snapshot_id).filter(
    (correction) =>
      correction.snapshot_digest === snapshot.digest &&
      correction.original_final_commit === snapshot.final_commit &&
      correction.iteration_id === snapshot.iteration_id,
  );
  if (corrections.length === 0) return snapshot.final_commit;
  const commits = new Set(corrections.map((correction) => correction.corrected_source_commit));
  if (commits.size !== 1) {
    throw new SnapshotAnchorError(
      "anchor_conflict",
      `snapshot ${snapshot.snapshot_id} has conflicting source anchor corrections`,
    );
  }
  return corrections[0]?.corrected_source_commit ?? snapshot.final_commit;
}
