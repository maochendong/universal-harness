import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

import { canonicalizeJson } from "../identity/canonical-json.js";
import { harnessRootFor, resolveHarnessPath } from "../ledger/layout.js";
import { verifyRecordEnvelope } from "../schema/envelope.js";
import type {
  CaptureModelProviderBindingRecord,
  ProfileDecisionRecord,
  ProfileRecommendationRecord,
  ProjectProfileRecord,
} from "../schema/profile.js";
import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../schema/registry.js";

/**
 * Append-only file store for the Protocol 1.1 profile records (slim-profiles
 * design 8.4 suggested layout). Every record is schema-validated and envelope
 * verified on both write and read; re-appending a byte-identical record is an
 * idempotent no-op while a conflicting rewrite of the same identity fails
 * closed instead of forking history.
 */
export class ProfileStoreError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "ProfileStoreError";
    this.kind = kind;
  }
}

export interface AppendOutcome {
  /** False when the identical record was already persisted. */
  readonly appended: boolean;
}

const SCHEMA_KEY_BY_KIND = {
  project_profile: "project-profile",
  profile_recommendation: "profile-recommendation",
  profile_decision: "profile-decision",
  model_provider_binding: "model-provider-binding",
} as const;

function serializeRecord(record: Record<string, unknown>): string {
  return `${canonicalizeJson(record)}\n`;
}

function assertValidRecord(record: Record<string, unknown>): void {
  const kind = record["record_kind"];
  const schemaKey =
    typeof kind === "string"
      ? SCHEMA_KEY_BY_KIND[kind as keyof typeof SCHEMA_KEY_BY_KIND]
      : undefined;
  if (schemaKey === undefined) {
    throw new ProfileStoreError("invalid_record", `unknown record kind: ${String(kind)}`);
  }
  const validation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate(schemaKey, record);
  if (!validation.valid) {
    throw new ProfileStoreError(
      "invalid_record",
      `record failed schema validation: ${validation.errors
        .map((error) => `${error.instancePath}: ${error.message}`)
        .join("; ")}`,
    );
  }
  if (!verifyRecordEnvelope(record)) {
    throw new ProfileStoreError("invalid_record", "record envelope digest does not verify");
  }
}

function readRecord<T extends Record<string, unknown>>(absolute: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch {
    throw new ProfileStoreError("corrupt_record", `unparseable record file: ${absolute}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProfileStoreError("corrupt_record", `record file is not an object: ${absolute}`);
  }
  assertValidRecord(parsed as Record<string, unknown>);
  return parsed as T;
}

/**
 * Write one record; returns whether it was appended. Identical re-writes are
 * no-ops (idempotent retry after a crash), divergent ones conflict.
 */
function appendRecord(
  projectRoot: string,
  relativePath: string,
  record: Record<string, unknown>,
): AppendOutcome {
  assertValidRecord(record);
  const harnessRoot = harnessRootFor(projectRoot);
  const absolute = resolveHarnessPath(harnessRoot, relativePath);
  const content = serializeRecord(record);
  if (existsSync(absolute)) {
    if (readFileSync(absolute, "utf8") === content) {
      return { appended: false };
    }
    throw new ProfileStoreError(
      "record_conflict",
      `record already exists with different content: .harness/${relativePath}`,
    );
  }
  mkdirSync(resolveHarnessPath(harnessRoot, relativePath.split("/").slice(0, -1).join("/")), {
    recursive: true,
  });
  writeFileSync(absolute, content, "utf8");
  return { appended: true };
}

function projectProfileRelativePath(projectId: string, revision: number): string {
  return `artifacts/project-profiles/${projectId}/${String(revision)}.json`;
}

export function appendProjectProfileRecord(
  projectRoot: string,
  record: ProjectProfileRecord,
): AppendOutcome {
  const relativePath = projectProfileRelativePath(record.project_id, record.revision);
  const absolute = resolveHarnessPath(harnessRootFor(projectRoot), relativePath);
  if (existsSync(absolute)) {
    // Re-appending an earlier revision is idempotent only when it is the
    // byte-identical record; anything else is a history rewrite attempt.
    return appendRecord(projectRoot, relativePath, record as unknown as Record<string, unknown>);
  }
  const latest = readLatestProjectProfile(projectRoot, record.project_id);
  const expectedRevision = latest === undefined ? 1 : latest.revision + 1;
  if (record.revision !== expectedRevision) {
    throw new ProfileStoreError(
      "profile_revision_conflict",
      `expected next revision ${String(expectedRevision)}, got ${String(record.revision)}`,
    );
  }
  return appendRecord(projectRoot, relativePath, record as unknown as Record<string, unknown>);
}

export function readProjectProfileRevisions(
  projectRoot: string,
  projectId: string,
): ProjectProfileRecord[] {
  const harnessRoot = harnessRootFor(projectRoot);
  const directory = resolveHarnessPath(harnessRoot, `artifacts/project-profiles/${projectId}`);
  if (!existsSync(directory)) return [];
  const revisions = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^[0-9]+\.json$/.test(entry.name))
    .map((entry) => Number.parseInt(entry.name, 10))
    .sort((left, right) => left - right);
  return revisions.map((revision) =>
    readRecord<ProjectProfileRecord>(
      resolveHarnessPath(harnessRoot, projectProfileRelativePath(projectId, revision)),
    ),
  );
}

export function readLatestProjectProfile(
  projectRoot: string,
  projectId: string,
): ProjectProfileRecord | undefined {
  return readProjectProfileRevisions(projectRoot, projectId).at(-1);
}

export function appendProfileRecommendationRecord(
  projectRoot: string,
  record: ProfileRecommendationRecord,
): AppendOutcome {
  return appendRecord(
    projectRoot,
    `artifacts/profile-recommendations/${record.profile_recommendation_id}.json`,
    record as unknown as Record<string, unknown>,
  );
}

export function readProfileRecommendationRecords(
  projectRoot: string,
): ProfileRecommendationRecord[] {
  const harnessRoot = harnessRootFor(projectRoot);
  const directory = resolveHarnessPath(harnessRoot, "artifacts/profile-recommendations");
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort()
    .map((name) =>
      readRecord<ProfileRecommendationRecord>(
        resolveHarnessPath(harnessRoot, `artifacts/profile-recommendations/${name}`),
      ),
    );
}

export function appendProfileDecisionRecord(
  projectRoot: string,
  record: ProfileDecisionRecord,
): AppendOutcome {
  return appendRecord(
    projectRoot,
    `artifacts/profile-decisions/${record.profile_decision_id}.json`,
    record as unknown as Record<string, unknown>,
  );
}

/**
 * Commit the Capture-scope bindings before Capture starts (model advisory
 * design 11.1): the record binds the ProfileDecision, Policy, config,
 * baseline and the per-slot prompt/schema versions.
 */
export function submitCaptureModelProviderBindings(
  projectRoot: string,
  record: CaptureModelProviderBindingRecord,
): AppendOutcome {
  return appendRecord(
    projectRoot,
    `artifacts/model-provider-bindings/capture/${record.model_provider_binding_id}.json`,
    record as unknown as Record<string, unknown>,
  );
}

export function readCaptureModelProviderBindings(
  projectRoot: string,
): CaptureModelProviderBindingRecord[] {
  const harnessRoot = harnessRootFor(projectRoot);
  const directory = resolveHarnessPath(harnessRoot, "artifacts/model-provider-bindings/capture");
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort()
    .map((name) =>
      readRecord<CaptureModelProviderBindingRecord>(
        resolveHarnessPath(harnessRoot, `artifacts/model-provider-bindings/capture/${name}`),
      ),
    );
}
