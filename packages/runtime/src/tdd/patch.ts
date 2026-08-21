import { contentDigest, type TddPathPolicy } from "@universal-harness-internal/core";

import { isPathWithinScopes, tryNormalizeRepoRelativePath } from "../policy/path-boundary.js";

/**
 * Canonical test patches and write-set attestation (provable TDD design
 * 8.2, plan T15). Test authoring may touch test and test-config paths only;
 * immutable paths always win over any other classification; a co-located
 * test file inside the production tree still classifies as test. The
 * canonical patch digest is order-insensitive and content-bound, so an
 * accepted patch is reused verbatim and any post-acceptance drift is a
 * different digest — never a silent change.
 */
export type TddPathScope = "test" | "test_config" | "production" | "immutable";

const COLOCATED_TEST_PATTERN = /(?:^|\/)[^/]*\.(?:test|spec)\.[a-z0-9]+$/u;

/** Policy scopes may use a trailing `/**`; matching is by path prefix. */
function scopePrefixes(scopes: readonly string[]): string[] {
  return scopes.map((scope) => (scope.endsWith("/**") ? scope.slice(0, -3) : scope));
}

/** Classify a repository-relative path against the contract path policy. */
export function classifyPath(path: string, policy: TddPathPolicy): TddPathScope | undefined {
  const normalized = tryNormalizeRepoRelativePath(path);
  if (normalized === undefined) return undefined;
  if (isPathWithinScopes(scopePrefixes(policy.immutable), normalized)) return "immutable";
  if (isPathWithinScopes(scopePrefixes(policy.test_config), normalized)) return "test_config";
  if (isPathWithinScopes(scopePrefixes(policy.test), normalized)) return "test";
  // A co-located test inside the production tree is a test, not production.
  if (COLOCATED_TEST_PATTERN.test(normalized)) return "test";
  if (isPathWithinScopes(scopePrefixes(policy.production), normalized)) return "production";
  return undefined;
}

export const TDD_PATCH_ISSUE_CODES = [
  "production_write",
  "immutable_write",
  "unclassified_path",
  "path_escape",
] as const;
export type TddPatchIssueCode = (typeof TDD_PATCH_ISSUE_CODES)[number];

export interface TddPatchIssue {
  readonly code: TddPatchIssueCode;
  readonly path: string;
  readonly message: string;
}

export interface PatchFile {
  readonly path: string;
  readonly content: string;
}

/** A test-authoring patch may carry test and test-config files only. */
export function validateTestAuthoringPatch(
  files: readonly PatchFile[],
  policy: TddPathPolicy,
): TddPatchIssue[] {
  const issues: TddPatchIssue[] = [];
  for (const file of files) {
    if (tryNormalizeRepoRelativePath(file.path) === undefined) {
      issues.push({
        code: "path_escape",
        path: file.path,
        message: `patch path ${file.path} is not a legal repository-relative path`,
      });
      continue;
    }
    const scope = classifyPath(file.path, policy);
    if (scope === "immutable") {
      issues.push({
        code: "immutable_write",
        path: file.path,
        message: `patch touches immutable path ${file.path}`,
      });
    } else if (scope === "production") {
      issues.push({
        code: "production_write",
        path: file.path,
        message: `test-authoring patch touches production path ${file.path}`,
      });
    } else if (scope === undefined) {
      issues.push({
        code: "unclassified_path",
        path: file.path,
        message: `patch path ${file.path} matches no policy scope`,
      });
    }
  }
  return issues.sort((left, right) => left.code.localeCompare(right.code));
}

export interface CanonicalPatch {
  readonly files: readonly { readonly path: string; readonly content_digest: string }[];
  readonly patch_digest: string;
}

/** The canonical, order-insensitive digest of a patch's full content. */
export function canonicalTestPatch(files: readonly PatchFile[]): CanonicalPatch {
  const normalized = files
    .map((file) => ({
      path: tryNormalizeRepoRelativePath(file.path) ?? file.path,
      content_digest: contentDigest(file.content),
    }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { files: normalized, patch_digest: contentDigest(normalized) };
}

/**
 * Write-set attestation (design 8.2/9.1): every observed write must fall
 * inside the granted write scopes. Returns the offending paths, sorted.
 */
export function attestWriteSet(
  observedPaths: readonly string[],
  grantedWriteScopes: readonly string[],
): string[] {
  return observedPaths
    .filter((path) => !isPathWithinScopes(scopePrefixes(grantedWriteScopes), path))
    .sort();
}
