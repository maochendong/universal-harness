import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

import {
  canonicalizeJson,
  harnessRootFor,
  resolveHarnessPath,
  verifyRecordEnvelope,
  PROTOCOL_1_1_SCHEMA_REGISTRY,
  type ModelInvocationRecord,
} from "@universal-harness-internal/core";

/**
 * Append-only store for model invocation records (plan PG-2). One file per
 * revision under `artifacts/model-invocations/<invocation_id>/`; identical
 * re-appends are idempotent no-ops, conflicting rewrites and corrupt files
 * fail closed. Crash recovery reconciles from these records alone.
 */
export class ModelInvocationStoreError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "ModelInvocationStoreError";
    this.kind = kind;
  }
}

const STORE_DIRECTORY = "artifacts/model-invocations";

function recordPath(record: ModelInvocationRecord): string {
  return `${STORE_DIRECTORY}/${record.invocation_id}/attempt-${record.attempt}-revision-${record.revision}.json`;
}

export function appendModelInvocationRecord(
  projectRoot: string,
  record: ModelInvocationRecord,
): void {
  const validation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate("model-invocation", record);
  if (!validation.valid) {
    throw new ModelInvocationStoreError(
      "invalid_record",
      `model invocation record failed schema validation: ${validation.errors
        .map((error) => `${error.instancePath}: ${error.message}`)
        .join("; ")}`,
    );
  }
  if (!verifyRecordEnvelope(record)) {
    throw new ModelInvocationStoreError(
      "invalid_record",
      "model invocation record envelope digest does not verify",
    );
  }
  const relativePath = recordPath(record);
  const harnessRoot = harnessRootFor(projectRoot);
  const absolute = resolveHarnessPath(harnessRoot, relativePath);
  const content = `${canonicalizeJson(record)}\n`;
  if (existsSync(absolute)) {
    if (readFileSync(absolute, "utf8") === content) return;
    throw new ModelInvocationStoreError(
      "record_conflict",
      `invocation record already exists with different content: .harness/${relativePath}`,
    );
  }
  mkdirSync(resolveHarnessPath(harnessRoot, `${STORE_DIRECTORY}/${record.invocation_id}`), {
    recursive: true,
  });
  writeFileSync(absolute, content, "utf8");
}

function readRecordFile(absolute: string): ModelInvocationRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch {
    throw new ModelInvocationStoreError("corrupt_record", `unparseable record file: ${absolute}`);
  }
  const validation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate("model-invocation", parsed);
  if (!validation.valid || !verifyRecordEnvelope(parsed as Record<string, unknown>)) {
    throw new ModelInvocationStoreError(
      "corrupt_record",
      `model invocation record failed validation: ${absolute}`,
    );
  }
  return parsed as ModelInvocationRecord;
}

/** Read every invocation revision, ordered by invocation, attempt, revision. */
export function readModelInvocationRecords(projectRoot: string): ModelInvocationRecord[] {
  const harnessRoot = harnessRootFor(projectRoot);
  const directory = resolveHarnessPath(harnessRoot, STORE_DIRECTORY);
  if (!existsSync(directory)) return [];
  const records: ModelInvocationRecord[] = [];
  for (const entry of readdirSync(directory).sort()) {
    const invocationDirectory = resolveHarnessPath(harnessRoot, `${STORE_DIRECTORY}/${entry}`);
    for (const file of readdirSync(invocationDirectory).sort()) {
      if (!file.endsWith(".json")) continue;
      records.push(
        readRecordFile(resolveHarnessPath(harnessRoot, `${STORE_DIRECTORY}/${entry}/${file}`)),
      );
    }
  }
  return records.sort(
    (left, right) =>
      left.invocation_id.localeCompare(right.invocation_id) ||
      left.attempt - right.attempt ||
      left.revision - right.revision,
  );
}

/** The newest revision of one invocation, if any. */
export function latestModelInvocation(
  records: readonly ModelInvocationRecord[],
  invocationId: string,
): ModelInvocationRecord | undefined {
  return records
    .filter((record) => record.invocation_id === invocationId)
    .sort((left, right) => right.attempt - left.attempt || right.revision - left.revision)[0];
}

const TERMINAL_STATES = new Set(["consumed", "failed", "invalidated"]);

/**
 * Crash reconciliation (plan PG-2 test 5): invocations whose latest revision
 * is planned/started/completed/validated were interrupted and can resume from
 * exactly that state — the result is never consumed twice because consumption
 * is terminal and idempotent.
 */
export function recoverableModelInvocations(
  records: readonly ModelInvocationRecord[],
): ModelInvocationRecord[] {
  const latest = new Map<string, ModelInvocationRecord>();
  for (const record of records) {
    const current = latest.get(record.invocation_id);
    if (
      current === undefined ||
      record.attempt > current.attempt ||
      (record.attempt === current.attempt && record.revision > current.revision)
    ) {
      latest.set(record.invocation_id, record);
    }
  }
  return [...latest.values()]
    .filter((record) => !TERMINAL_STATES.has(record.state))
    .sort((left, right) => left.invocation_id.localeCompare(right.invocation_id));
}
