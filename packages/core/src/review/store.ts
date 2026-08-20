import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

import { canonicalizeJson } from "../identity/canonical-json.js";
import { harnessRootFor, resolveHarnessPath } from "../ledger/layout.js";
import { verifyRecordEnvelope } from "../schema/envelope.js";
import type { ManualReviewInputRecord, PrdReviewReportRecord } from "../schema/review.js";
import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../schema/registry.js";

/**
 * Append-only store for PRD review reports and manual review inputs (design
 * 6.6; same conventions as the proposal store). Identical re-appends are
 * idempotent no-ops; divergent rewrites of a committed identity fail closed.
 */
export class ReviewStoreError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "ReviewStoreError";
    this.kind = kind;
  }
}

const SCHEMA_KEY_BY_KIND = {
  prd_review_report: "prd-review-report",
  manual_review_input: "manual-review-input",
} as const;

function appendRecord(
  projectRoot: string,
  relativePath: string,
  record: Record<string, unknown>,
): void {
  const kind = record["record_kind"];
  const schemaKey =
    typeof kind === "string"
      ? SCHEMA_KEY_BY_KIND[kind as keyof typeof SCHEMA_KEY_BY_KIND]
      : undefined;
  if (schemaKey === undefined) {
    throw new ReviewStoreError("invalid_record", `unknown record kind: ${String(kind)}`);
  }
  const validation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate(schemaKey, record);
  if (!validation.valid) {
    throw new ReviewStoreError(
      "invalid_record",
      `record failed schema validation: ${validation.errors
        .map((error) => `${error.instancePath}: ${error.message}`)
        .join("; ")}`,
    );
  }
  if (!verifyRecordEnvelope(record)) {
    throw new ReviewStoreError("invalid_record", "record envelope digest does not verify");
  }
  const harnessRoot = harnessRootFor(projectRoot);
  const absolute = resolveHarnessPath(harnessRoot, relativePath);
  const content = `${canonicalizeJson(record)}\n`;
  if (existsSync(absolute)) {
    if (readFileSync(absolute, "utf8") === content) return;
    throw new ReviewStoreError(
      "record_conflict",
      `record already exists with different content: .harness/${relativePath}`,
    );
  }
  mkdirSync(resolveHarnessPath(harnessRoot, relativePath.split("/").slice(0, -1).join("/")), {
    recursive: true,
  });
  writeFileSync(absolute, content, "utf8");
}

function readRecord<T extends Record<string, unknown>>(absolute: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch {
    throw new ReviewStoreError("corrupt_record", `unparseable record file: ${absolute}`);
  }
  const record = parsed as Record<string, unknown>;
  const kind = record["record_kind"];
  const schemaKey =
    typeof kind === "string"
      ? SCHEMA_KEY_BY_KIND[kind as keyof typeof SCHEMA_KEY_BY_KIND]
      : undefined;
  if (schemaKey === undefined) {
    throw new ReviewStoreError("corrupt_record", `unknown record kind in ${absolute}`);
  }
  const validation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate(schemaKey, record);
  if (!validation.valid || !verifyRecordEnvelope(record)) {
    throw new ReviewStoreError("corrupt_record", `record failed validation: ${absolute}`);
  }
  return parsed as T;
}

function readDirectoryRecords<T extends Record<string, unknown>>(
  projectRoot: string,
  relativeDirectory: string,
): T[] {
  const harnessRoot = harnessRootFor(projectRoot);
  const directory = resolveHarnessPath(harnessRoot, relativeDirectory);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort()
    .map((name) => readRecord<T>(resolveHarnessPath(harnessRoot, `${relativeDirectory}/${name}`)));
}

export function appendPrdReviewReportRecord(
  projectRoot: string,
  record: PrdReviewReportRecord,
): void {
  appendRecord(
    projectRoot,
    `artifacts/capture/reviews/${record.session_id}/${record.review_report_id}.json`,
    record as unknown as Record<string, unknown>,
  );
}

export function readPrdReviewReports(
  projectRoot: string,
  sessionId: string,
): PrdReviewReportRecord[] {
  return readDirectoryRecords(projectRoot, `artifacts/capture/reviews/${sessionId}`);
}

export function appendManualReviewInputRecord(
  projectRoot: string,
  record: ManualReviewInputRecord,
): void {
  appendRecord(
    projectRoot,
    `artifacts/capture/manual-review/${record.session_id}/${record.manual_review_input_id}.json`,
    record as unknown as Record<string, unknown>,
  );
}

export function readManualReviewInputs(
  projectRoot: string,
  sessionId: string,
): ManualReviewInputRecord[] {
  return readDirectoryRecords(projectRoot, `artifacts/capture/manual-review/${sessionId}`);
}
