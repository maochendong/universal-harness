import { vcsOk, type VcsResult, type WorktreeStatus } from "@universal-harness-internal/plugin-sdk";

import type { GitRunner } from "./commands.js";

export interface ParsedStatus {
  readonly staged: string[];
  readonly unstaged: string[];
  readonly untracked: string[];
}

/**
 * Parse `git status --porcelain=v1 -z` output. Records are NUL-terminated as
 * `XY <path>`; rename/copy records carry the source path in the next record.
 */
export function parsePorcelainV1Z(output: string): ParsedStatus {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  const records = output.split("\0");
  let index = 0;
  while (index < records.length) {
    const record = records[index];
    index += 1;
    if (record === undefined || record.length < 4) continue;
    const x = record.charAt(0);
    const y = record.charAt(1);
    const path = record.slice(3);
    if (x === "?" && y === "?") {
      untracked.push(path);
      continue;
    }
    if (x === "!" && y === "!") continue;
    if (x !== "." && x !== " ") staged.push(path);
    if (y !== "." && y !== " ") unstaged.push(path);
    if (x === "R" || x === "C" || y === "R" || y === "C") index += 1;
  }
  return { staged, unstaged, untracked };
}

export interface ParsedNameStatusEntry {
  readonly status: "added" | "modified" | "deleted" | "renamed";
  readonly path: string;
  readonly previousPath?: string;
}

/** Parse `git diff --name-status -z -M` output. */
export function parseNameStatusZ(output: string): ParsedNameStatusEntry[] {
  const entries: ParsedNameStatusEntry[] = [];
  const tokens = output.split("\0");
  let index = 0;
  while (index < tokens.length) {
    const code = tokens[index];
    index += 1;
    if (code === undefined || code.length === 0) continue;
    const letter = code.charAt(0);
    if (letter === "R" || letter === "C") {
      const previousPath = tokens[index];
      const path = tokens[index + 1];
      index += 2;
      if (previousPath === undefined || path === undefined) break;
      entries.push({ status: "renamed", path, previousPath });
      continue;
    }
    const path = tokens[index];
    index += 1;
    if (path === undefined) break;
    if (letter === "A") entries.push({ status: "added", path });
    else if (letter === "D") entries.push({ status: "deleted", path });
    else if (letter === "M" || letter === "T") entries.push({ status: "modified", path });
  }
  return entries;
}

export interface LineCounts {
  readonly insertions: number;
  readonly deletions: number;
}

/**
 * Parse `git diff --numstat -z -M` output into counts keyed by final path.
 * Binary files report `-` counts, which collapse to zero.
 */
export function parseNumstatZ(output: string): Map<string, LineCounts> {
  const counts = new Map<string, LineCounts>();
  const tokens = output.split("\0");
  let index = 0;
  const parseCount = (field: string | undefined): number => {
    const value = Number.parseInt(field ?? "", 10);
    return Number.isNaN(value) ? 0 : value;
  };
  while (index < tokens.length) {
    const header = tokens[index];
    index += 1;
    if (header === undefined || header.length === 0) continue;
    const fields = header.split("\t");
    const entry: LineCounts = {
      insertions: parseCount(fields[0]),
      deletions: parseCount(fields[1]),
    };
    const pathField = fields[2];
    if (pathField !== undefined && pathField.length > 0) {
      counts.set(pathField, entry);
      continue;
    }
    // Rename entry: the header's path field is empty, followed by old and new.
    const path = tokens[index + 1];
    index += 2;
    if (path === undefined) break;
    counts.set(path, entry);
  }
  return counts;
}

/**
 * Read the worktree status of the repository (or linked worktree) at `root`
 * via `git status --porcelain=v1 -z` plus branch/HEAD resolution.
 */
export async function readWorktreeStatus(
  run: GitRunner,
  operation: string,
  root: string,
): Promise<VcsResult<WorktreeStatus>> {
  const porcelain = await run(operation, root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=normal",
  ]);
  if (!porcelain.ok) return porcelain;
  const branchOutcome = await run(operation, root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const headOutcome = await run(operation, root, ["rev-parse", "--verify", "--quiet", "HEAD"]);

  const parsed = parsePorcelainV1Z(porcelain.value.stdout);
  const clean =
    parsed.staged.length === 0 && parsed.unstaged.length === 0 && parsed.untracked.length === 0;
  return vcsOk({
    clean,
    branch: branchOutcome.ok ? branchOutcome.value.stdout.trim() : null,
    head: headOutcome.ok ? headOutcome.value.stdout.trim() : null,
    staged: parsed.staged,
    unstaged: parsed.unstaged,
    untracked: parsed.untracked,
  });
}
