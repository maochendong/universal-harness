import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

import { canonicalizeJson } from "../identity/canonical-json.js";
import { harnessRootFor, resolveHarnessPath } from "../ledger/layout.js";
import { verifyRecordEnvelope } from "../schema/envelope.js";
import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../schema/registry.js";
import type {
  ProjectContextBundleInvalidationRecord,
  ProjectContextBundleRecord,
} from "../schema/context.js";

/**
 * Append-only store for project context bundles and their invalidation
 * records (intent-to-prd design 6.3, 14.2). Identical re-appends are
 * idempotent no-ops; conflicting rewrites fail closed.
 */
export class ProjectContextStoreError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "ProjectContextStoreError";
    this.kind = kind;
  }
}

const SCHEMA_KEY_BY_KIND = {
  project_context_bundle: "project-context-bundle",
  project_context_bundle_invalidation: "project-context-bundle-invalidation",
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
    throw new ProjectContextStoreError("invalid_record", `unknown record kind: ${String(kind)}`);
  }
  const validation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate(schemaKey, record);
  if (!validation.valid) {
    throw new ProjectContextStoreError(
      "invalid_record",
      `record failed schema validation: ${validation.errors
        .map((error) => `${error.instancePath}: ${error.message}`)
        .join("; ")}`,
    );
  }
  if (!verifyRecordEnvelope(record)) {
    throw new ProjectContextStoreError("invalid_record", "record envelope digest does not verify");
  }
  const harnessRoot = harnessRootFor(projectRoot);
  const absolute = resolveHarnessPath(harnessRoot, relativePath);
  const content = `${canonicalizeJson(record)}\n`;
  if (existsSync(absolute)) {
    if (readFileSync(absolute, "utf8") === content) return;
    throw new ProjectContextStoreError(
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
    throw new ProjectContextStoreError("corrupt_record", `unparseable record file: ${absolute}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProjectContextStoreError(
      "corrupt_record",
      `record file is not an object: ${absolute}`,
    );
  }
  const record = parsed as Record<string, unknown>;
  const kind = record["record_kind"];
  const schemaKey =
    typeof kind === "string"
      ? SCHEMA_KEY_BY_KIND[kind as keyof typeof SCHEMA_KEY_BY_KIND]
      : undefined;
  if (schemaKey === undefined) {
    throw new ProjectContextStoreError("corrupt_record", `unknown record kind in ${absolute}`);
  }
  const validation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate(schemaKey, record);
  if (!validation.valid || !verifyRecordEnvelope(record)) {
    throw new ProjectContextStoreError("corrupt_record", `record failed validation: ${absolute}`);
  }
  return parsed as T;
}

export function appendProjectContextBundleRecord(
  projectRoot: string,
  bundle: ProjectContextBundleRecord,
): void {
  appendRecord(
    projectRoot,
    `artifacts/project-context-bundles/${bundle.bundle_id}.json`,
    bundle as unknown as Record<string, unknown>,
  );
}

export function readProjectContextBundle(
  projectRoot: string,
  bundleId: string,
): ProjectContextBundleRecord | undefined {
  const harnessRoot = harnessRootFor(projectRoot);
  const absolute = resolveHarnessPath(
    harnessRoot,
    `artifacts/project-context-bundles/${bundleId}.json`,
  );
  if (!existsSync(absolute)) return undefined;
  return readRecord<ProjectContextBundleRecord>(absolute);
}

export function appendProjectContextBundleInvalidationRecord(
  projectRoot: string,
  record: ProjectContextBundleInvalidationRecord,
): void {
  appendRecord(
    projectRoot,
    `artifacts/project-context-bundle-invalidations/${record.invalidation_id}.json`,
    record as unknown as Record<string, unknown>,
  );
}

export function readProjectContextBundleInvalidations(
  projectRoot: string,
  bundleId?: string,
): ProjectContextBundleInvalidationRecord[] {
  const harnessRoot = harnessRootFor(projectRoot);
  const directory = resolveHarnessPath(
    harnessRoot,
    "artifacts/project-context-bundle-invalidations",
  );
  if (!existsSync(directory)) return [];
  const records = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) =>
      readRecord<ProjectContextBundleInvalidationRecord>(
        resolveHarnessPath(
          harnessRoot,
          `artifacts/project-context-bundle-invalidations/${entry.name}`,
        ),
      ),
    );
  return bundleId === undefined
    ? records
    : records.filter((record) => record.bundle_id === bundleId);
}

/** Whether any committed invalidation covers this bundle digest. */
export function isProjectContextBundleInvalidated(
  projectRoot: string,
  bundleDigest: string,
): boolean {
  return readProjectContextBundleInvalidations(projectRoot).some(
    (record) => record.bundle_digest === bundleDigest,
  );
}
