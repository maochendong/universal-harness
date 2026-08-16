import { Buffer } from "node:buffer";

import { canonicalizeJson, contentDigest } from "@universal-harness-internal/core";

export const MAX_REVIEW_BUNDLE_BYTES = 256 * 1024;
export const UNTRUSTED_DATA_BEGIN = "UNTRUSTED_REPOSITORY_DATA_BEGIN" as const;
export const UNTRUSTED_DATA_END = "UNTRUSTED_REPOSITORY_DATA_END" as const;

export type ReviewBundleErrorKind = "invalid_bundle" | "bundle_too_large";

export class ReviewBundleError extends Error {
  readonly kind: ReviewBundleErrorKind;

  constructor(kind: ReviewBundleErrorKind, message: string) {
    super(message);
    this.name = "ReviewBundleError";
    this.kind = kind;
  }
}

export interface RelatedReviewRecord {
  readonly id: string;
  readonly type: string;
  readonly revision: number;
  readonly digest: string;
  readonly summary?: string;
}

export interface DeterministicGateSummary {
  readonly gate_id: string;
  readonly passed: boolean;
  readonly summary: string;
}

export interface ReviewBundleInput {
  readonly baseline_commit: string;
  readonly source_commit: string;
  readonly code_digest: string;
  readonly changed_paths: readonly string[];
  readonly diff: string;
  readonly acceptance_criteria: readonly string[];
  readonly related_records: readonly RelatedReviewRecord[];
  readonly deterministic_gates: readonly DeterministicGateSummary[];
  readonly line_counts: Readonly<Record<string, number>>;
}

export interface ReviewBundle {
  readonly review_bundle_version: 1;
  readonly baseline_commit: string;
  readonly source_commit: string;
  readonly code_digest: string;
  readonly changed_paths: readonly string[];
  readonly acceptance_criteria: readonly string[];
  readonly related_records: readonly RelatedReviewRecord[];
  readonly deterministic_gates: readonly DeterministicGateSummary[];
  readonly line_counts: Readonly<Record<string, number>>;
  readonly untrusted_repository_data: {
    readonly begin_delimiter: typeof UNTRUSTED_DATA_BEGIN;
    readonly diff: string;
    readonly end_delimiter: typeof UNTRUSTED_DATA_END;
  };
}

export interface BuiltReviewBundle {
  readonly bundle: ReviewBundle;
  readonly canonical: string;
  readonly digest: string;
  readonly bytes: number;
}

function safePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || /^[A-Za-z]:/u.test(path) || path.includes("\\")) {
    return false;
  }
  const segments = path.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function sortedUnique(values: readonly string[], context: string): string[] {
  if (values.some((value) => typeof value !== "string" || value === "")) {
    throw new ReviewBundleError("invalid_bundle", `${context} contains an empty value`);
  }
  return [...new Set(values)].sort();
}

/** Build one byte-bounded, digest-bound review input without truncating repository data. */
export function buildReviewBundle(input: ReviewBundleInput): BuiltReviewBundle {
  const changedPaths = sortedUnique(input.changed_paths, "changed_paths");
  if (changedPaths.some((path) => !safePath(path))) {
    throw new ReviewBundleError("invalid_bundle", "changed_paths contains an unsafe path");
  }
  const lineCounts: Record<string, number> = {};
  for (const path of Object.keys(input.line_counts).sort()) {
    const count = input.line_counts[path];
    if (!changedPaths.includes(path) || !Number.isInteger(count) || (count as number) < 0) {
      throw new ReviewBundleError("invalid_bundle", `line_counts.${path} is invalid`);
    }
    lineCounts[path] = count as number;
  }
  const bundle: ReviewBundle = {
    review_bundle_version: 1,
    baseline_commit: input.baseline_commit,
    source_commit: input.source_commit,
    code_digest: input.code_digest,
    changed_paths: changedPaths,
    acceptance_criteria: sortedUnique(input.acceptance_criteria, "acceptance_criteria"),
    related_records: [...input.related_records].sort(
      (left, right) =>
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0) || left.revision - right.revision,
    ),
    deterministic_gates: [...input.deterministic_gates].sort((left, right) =>
      left.gate_id < right.gate_id ? -1 : left.gate_id > right.gate_id ? 1 : 0,
    ),
    line_counts: lineCounts,
    untrusted_repository_data: {
      begin_delimiter: UNTRUSTED_DATA_BEGIN,
      diff: input.diff,
      end_delimiter: UNTRUSTED_DATA_END,
    },
  };
  // The complete repository-derived bundle is fenced, not only the diff: a
  // Requirement or acceptance criterion can carry prompt-injection text too.
  const canonical = `${UNTRUSTED_DATA_BEGIN}\n${canonicalizeJson(bundle)}\n${UNTRUSTED_DATA_END}`;
  const bytes = Buffer.byteLength(canonical, "utf8");
  if (bytes > MAX_REVIEW_BUNDLE_BYTES) {
    throw new ReviewBundleError(
      "bundle_too_large",
      `review bundle is ${String(bytes)} bytes; maximum is ${String(MAX_REVIEW_BUNDLE_BYTES)}`,
    );
  }
  return { bundle, canonical, digest: contentDigest(bundle), bytes };
}
