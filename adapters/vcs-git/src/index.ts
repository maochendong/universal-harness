export { createGitVcsAdapter, type GitVcsAdapterOptions } from "./adapter.js";
export {
  createGitControlStoreAdapter,
  type CandidatePrepareOutcome,
  type CandidatePrepareRequest,
  type ControlStoreAppendInput,
  type ControlStoreAppendResult,
  type ControlStoreReadInput,
  type ControlStoreReadResult,
  type ControlStoreSnapshot,
  type GitControlStoreAdapter,
  type GitControlStoreAdapterOptions,
  type GitControlStoreErrorCode,
  type GitControlStoreFailure,
  type OperationCasOutcome,
  type OperationCasRequest,
  type OperationHeadEntry,
  type OperationHeadListResult,
  type ProjectRecordAppendInput,
  type ProjectRecordAppendResult,
  type TargetCasOutcome,
  type TargetCasRequest,
} from "./control-store.js";
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
