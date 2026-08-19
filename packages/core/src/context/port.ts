import type {
  ProjectContextBudget,
  ProjectContextBundleRecord,
  ProjectContextPurpose,
  ProjectContextSourceKind,
} from "../schema/context.js";

/**
 * ProjectContextPort contract (intent-to-prd design 8.1). The port is the
 * only adapter seam that may read project facts; it returns a sealed bundle
 * or a typed failure, never raw file access.
 */
export interface ProjectContextPathPolicy {
  /** Directory prefixes (POSIX, relative) that bound the search; default: whole project. */
  readonly allowed_roots?: readonly string[];
  /** Additional denied prefixes on top of the built-in `.git`/`.harness` denial. */
  readonly denied_paths?: readonly string[];
}

export interface ProjectContextRequest {
  readonly session_id: string;
  readonly purpose: ProjectContextPurpose;
  readonly intent_text: string;
  readonly project_root_kind: "new" | "adopted" | "managed";
  readonly project_baseline_digest: string;
  readonly project_profile_digest: string;
  readonly capture_policy_digest: string;
  readonly allowed_source_kinds: readonly ProjectContextSourceKind[];
  readonly path_policy: ProjectContextPathPolicy;
  readonly budget: ProjectContextBudget;
}

export const PROJECT_CONTEXT_FAILURE_CODES = [
  "adapter_error",
  "invalid_request",
  "bundle_rejected",
] as const;
export type ProjectContextFailureCode = (typeof PROJECT_CONTEXT_FAILURE_CODES)[number];

export interface ProjectContextFailure {
  readonly code: ProjectContextFailureCode;
  readonly summary: string;
  readonly retryable: boolean;
}

export type ProjectContextResult =
  | { readonly status: "compiled"; readonly bundle: ProjectContextBundleRecord }
  | { readonly status: "blocked"; readonly failure: ProjectContextFailure };

export interface ProjectContextPort {
  readonly name: string;
  compile(request: ProjectContextRequest): Promise<ProjectContextResult> | ProjectContextResult;
}
