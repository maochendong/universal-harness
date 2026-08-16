export { createGitVcsAdapter, type GitVcsAdapterOptions } from "./adapter.js";
export {
  parseGitDiffStat,
  parseNameStatusZ,
  parseNumstatZ,
  parsePorcelainV1Z,
  type LineCounts,
  type ParsedNameStatusEntry,
  type ParsedStatus,
  type UntrackedDiffEntry,
} from "./status.js";

export const workspacePackageName = "@universal-harness-internal/adapter-vcs-git" as const;
