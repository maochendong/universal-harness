import type { AgentChangeSummary, DiffSummary } from "@universal-harness-internal/plugin-sdk";

import { isPathWithinScopes, normalizeRepoRelativePath } from "../policy/path-boundary.js";

export interface ActualRunChanges {
  readonly change_summary: AgentChangeSummary;
  readonly undeclared_writes: readonly string[];
  readonly renamed_paths: readonly { readonly from: string; readonly to: string }[];
  readonly binary_paths: readonly string[];
}

/** Derive the run-local delta from two Harness-owned VCS observations. */
export function deriveActualRunChanges(
  before: DiffSummary,
  after: DiffSummary,
  approvedWritePaths: readonly string[],
): ActualRunChanges {
  const beforeByPath = new Map(before.files.map((file) => [file.path, file]));
  const changed = after.files.filter((file) => {
    const previous = beforeByPath.get(file.path);
    return (
      previous === undefined ||
      previous.status !== file.status ||
      previous.previousPath !== file.previousPath ||
      previous.insertions !== file.insertions ||
      previous.deletions !== file.deletions ||
      (previous.binary ?? false) !== (file.binary ?? false)
    );
  });
  const paths = changed.map((file) => normalizeRepoRelativePath(file.path)).sort();
  const touched = changed.flatMap((file) => [
    file.path,
    ...(file.previousPath === undefined ? [] : [file.previousPath]),
  ]);
  const undeclared = [...new Set(touched.map(normalizeRepoRelativePath))]
    .filter((path) => !isPathWithinScopes(approvedWritePaths, path))
    .sort();
  return {
    change_summary: {
      files_changed: changed.length,
      insertions: changed.reduce(
        (sum, file) =>
          sum + Math.max(0, file.insertions - (beforeByPath.get(file.path)?.insertions ?? 0)),
        0,
      ),
      deletions: changed.reduce(
        (sum, file) =>
          sum + Math.max(0, file.deletions - (beforeByPath.get(file.path)?.deletions ?? 0)),
        0,
      ),
      paths,
    },
    undeclared_writes: undeclared,
    renamed_paths: changed.flatMap((file) =>
      file.previousPath === undefined ? [] : [{ from: file.previousPath, to: file.path }],
    ),
    binary_paths: changed
      .filter((file) => file.binary === true)
      .map((file) => file.path)
      .sort(),
  };
}
