import { execFileSync } from "node:child_process";

import type { SnapshotRecord } from "./builder.js";
import { resolveSnapshotSourceCommit } from "./anchor.js";

const SNAPSHOT_ID_PATTERN = /^[a-z][a-z0-9-]*_[A-Za-z0-9_-]+$/u;

export interface SnapshotCommitRefs {
  readonly source_commit: string;
  /** First Git commit that contains this Snapshot artifact, or null before commit. */
  readonly ledger_commit: string | null;
  readonly repository_head: string;
}

function git(projectRoot: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Locate the first repository commit that added the immutable Snapshot file. */
export function locateSnapshotLedgerCommit(projectRoot: string, snapshotId: string): string | null {
  if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    throw new Error(`invalid snapshot id ${JSON.stringify(snapshotId)}`);
  }
  const path = `.harness/artifacts/snapshots/${snapshotId}.json`;
  try {
    const commits = git(projectRoot, [
      "log",
      "--reverse",
      "--format=%H",
      "--diff-filter=A",
      "--",
      path,
    ]);
    return commits.split(/\r?\n/u).find((entry) => entry.length > 0) ?? null;
  } catch {
    return null;
  }
}

/** Project three non-overloaded commit references for current and legacy Snapshots. */
export function projectSnapshotCommitRefs(
  projectRoot: string,
  snapshot: SnapshotRecord,
): SnapshotCommitRefs {
  return {
    source_commit: resolveSnapshotSourceCommit(projectRoot, snapshot),
    ledger_commit: locateSnapshotLedgerCommit(projectRoot, snapshot.snapshot_id),
    repository_head: git(projectRoot, ["rev-parse", "HEAD"]),
  };
}
