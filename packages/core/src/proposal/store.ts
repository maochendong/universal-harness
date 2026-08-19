import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

import { canonicalizeJson } from "../identity/canonical-json.js";
import { harnessRootFor, resolveHarnessPath } from "../ledger/layout.js";
import { verifyRecordEnvelope } from "../schema/envelope.js";
import type {
  PrdEntityLineageRecord,
  PrdProposalRecord,
  PrdValidationReportRecord,
} from "../schema/proposal.js";
import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../schema/registry.js";

/**
 * Append-only store for PRD proposal, entity lineage and validation report
 * records (intent-to-prd design 6.4-6.6; same conventions as the capture
 * store). Identical re-appends are idempotent no-ops, divergent rewrites of a
 * committed identity fail closed, and proposal revisions are monotonic per
 * session so the proposal chain cannot fork silently.
 */
export class ProposalStoreError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "ProposalStoreError";
    this.kind = kind;
  }
}

const SCHEMA_KEY_BY_KIND = {
  prd_proposal: "prd-proposal",
  prd_entity_lineage: "prd-entity-lineage",
  prd_validation_report: "prd-validation-report",
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
    throw new ProposalStoreError("invalid_record", `unknown record kind: ${String(kind)}`);
  }
  const validation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate(schemaKey, record);
  if (!validation.valid) {
    throw new ProposalStoreError(
      "invalid_record",
      `record failed schema validation: ${validation.errors
        .map((error) => `${error.instancePath}: ${error.message}`)
        .join("; ")}`,
    );
  }
  if (!verifyRecordEnvelope(record)) {
    throw new ProposalStoreError("invalid_record", "record envelope digest does not verify");
  }
  const harnessRoot = harnessRootFor(projectRoot);
  const absolute = resolveHarnessPath(harnessRoot, relativePath);
  const content = `${canonicalizeJson(record)}\n`;
  if (existsSync(absolute)) {
    if (readFileSync(absolute, "utf8") === content) return;
    throw new ProposalStoreError(
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
    throw new ProposalStoreError("corrupt_record", `unparseable record file: ${absolute}`);
  }
  const record = parsed as Record<string, unknown>;
  const kind = record["record_kind"];
  const schemaKey =
    typeof kind === "string"
      ? SCHEMA_KEY_BY_KIND[kind as keyof typeof SCHEMA_KEY_BY_KIND]
      : undefined;
  if (schemaKey === undefined) {
    throw new ProposalStoreError("corrupt_record", `unknown record kind in ${absolute}`);
  }
  const validation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate(schemaKey, record);
  if (!validation.valid || !verifyRecordEnvelope(record)) {
    throw new ProposalStoreError("corrupt_record", `record failed validation: ${absolute}`);
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

// --- Proposals ---------------------------------------------------------------

function proposalRelativePath(sessionId: string, revision: number): string {
  return `artifacts/capture/proposals/${sessionId}/${String(revision)}.json`;
}

export function appendPrdProposalRecord(projectRoot: string, record: PrdProposalRecord): void {
  const relativePath = proposalRelativePath(record.session_id, record.revision);
  const absolute = resolveHarnessPath(harnessRootFor(projectRoot), relativePath);
  if (!existsSync(absolute)) {
    const revisions = readPrdProposalRevisions(projectRoot, record.session_id);
    const latest = revisions.at(-1);
    const expectedRevision = latest === undefined ? 1 : latest.revision + 1;
    if (record.revision !== expectedRevision) {
      throw new ProposalStoreError(
        "proposal_revision_conflict",
        `expected next revision ${String(expectedRevision)}, got ${String(record.revision)}`,
      );
    }
    if (latest !== undefined && record.supersedes_digest !== latest.record_digest) {
      throw new ProposalStoreError(
        "proposal_revision_conflict",
        "proposal revision does not build on the latest committed proposal",
      );
    }
  }
  appendRecord(projectRoot, relativePath, record as unknown as Record<string, unknown>);
}

export function readPrdProposalRevisions(
  projectRoot: string,
  sessionId: string,
): PrdProposalRecord[] {
  const harnessRoot = harnessRootFor(projectRoot);
  const directory = resolveHarnessPath(harnessRoot, `artifacts/capture/proposals/${sessionId}`);
  if (!existsSync(directory)) return [];
  const revisions = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^[0-9]+\.json$/u.test(entry.name))
    .map((entry) => Number.parseInt(entry.name, 10))
    .sort((left, right) => left - right);
  return revisions.map((revision) =>
    readRecord<PrdProposalRecord>(
      resolveHarnessPath(harnessRoot, proposalRelativePath(sessionId, revision)),
    ),
  );
}

export function findPrdProposalByDigest(
  projectRoot: string,
  sessionId: string,
  contentDigest: string,
): PrdProposalRecord | undefined {
  return readPrdProposalRevisions(projectRoot, sessionId)
    .filter((record) => record.content_digest === contentDigest)
    .at(-1);
}

// --- Lineage -----------------------------------------------------------------

export function appendPrdEntityLineageRecord(
  projectRoot: string,
  record: PrdEntityLineageRecord,
): void {
  appendRecord(
    projectRoot,
    `artifacts/capture/lineage/${record.session_id}/${record.lineage_record_id}.json`,
    record as unknown as Record<string, unknown>,
  );
}

export function readPrdEntityLineageRecords(
  projectRoot: string,
  sessionId: string,
): PrdEntityLineageRecord[] {
  return readDirectoryRecords(projectRoot, `artifacts/capture/lineage/${sessionId}`);
}

// --- Validation reports --------------------------------------------------------

export function appendPrdValidationReportRecord(
  projectRoot: string,
  record: PrdValidationReportRecord,
): void {
  appendRecord(
    projectRoot,
    `artifacts/capture/validations/${record.session_id}/${record.validation_report_id}.json`,
    record as unknown as Record<string, unknown>,
  );
}

export function readPrdValidationReports(
  projectRoot: string,
  sessionId: string,
): PrdValidationReportRecord[] {
  return readDirectoryRecords(projectRoot, `artifacts/capture/validations/${sessionId}`);
}
