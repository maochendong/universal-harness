import { canonicalizeJson } from "../identity/canonical-json.js";

/**
 * Project manifest at `.harness/manifest.yaml`. The file keeps the `.yaml`
 * name from the managed-layout contract, while its content is canonical
 * JSON, which is valid YAML 1.2: serialization stays deterministic and
 * dependency-free, and any YAML reader can still consume it. Manifests are
 * authoritative data committed to Git, so the canonical form guarantees a
 * byte-identical file for the same logical content on every platform.
 */
export const PROJECT_MANIFEST_VERSION = 1 as const;

export class ProjectManifestError extends Error {
  readonly kind = "project_manifest_error" as const;

  constructor(message: string) {
    super(message);
    this.name = "ProjectManifestError";
  }
}

export interface ProjectManifest {
  readonly manifest_version: number;
  readonly name: string;
  readonly repository_id: string;
  readonly created_at: string;
}

const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const REPOSITORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const ISO_TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}/u;

export function assertProjectName(name: string): void {
  if (!PROJECT_NAME_PATTERN.test(name)) {
    throw new ProjectManifestError(
      `invalid project name (lowercase kebab-case expected): ${JSON.stringify(name)}`,
    );
  }
}

export function assertRepositoryId(repositoryId: string): void {
  if (!REPOSITORY_ID_PATTERN.test(repositoryId)) {
    throw new ProjectManifestError(`invalid repository id: ${JSON.stringify(repositoryId)}`);
  }
}

export function createProjectManifest(options: {
  readonly name: string;
  readonly repositoryId: string;
  readonly now?: () => string;
}): ProjectManifest {
  assertProjectName(options.name);
  assertRepositoryId(options.repositoryId);
  const createdAt = (options.now ?? (() => new Date().toISOString()))();
  if (!ISO_TIMESTAMP_PATTERN.test(createdAt)) {
    throw new ProjectManifestError(`invalid ISO timestamp: ${JSON.stringify(createdAt)}`);
  }
  return {
    manifest_version: PROJECT_MANIFEST_VERSION,
    name: options.name,
    repository_id: options.repositoryId,
    created_at: createdAt,
  };
}

export function serializeProjectManifest(manifest: ProjectManifest): string {
  return `${canonicalizeJson(manifest)}\n`;
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ProjectManifestError(`manifest field ${field} must be a non-empty string`);
  }
  return value;
}

export function parseProjectManifest(raw: string): ProjectManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProjectManifestError("manifest is not valid canonical JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProjectManifestError("manifest must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (record["manifest_version"] !== PROJECT_MANIFEST_VERSION) {
    throw new ProjectManifestError(
      `unsupported manifest_version: ${JSON.stringify(record["manifest_version"])}`,
    );
  }
  const manifest: ProjectManifest = {
    manifest_version: PROJECT_MANIFEST_VERSION,
    name: requireString(record, "name"),
    repository_id: requireString(record, "repository_id"),
    created_at: requireString(record, "created_at"),
  };
  assertProjectName(manifest.name);
  assertRepositoryId(manifest.repository_id);
  if (!ISO_TIMESTAMP_PATTERN.test(manifest.created_at)) {
    throw new ProjectManifestError(
      `manifest created_at is not an ISO timestamp: ${JSON.stringify(manifest.created_at)}`,
    );
  }
  return manifest;
}
