import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

import { canonicalizeJson } from "../identity/canonical-json.js";
import { harnessRootFor, resolveHarnessPath } from "../ledger/layout.js";
import type {
  CaptureBlockerRecord,
  CaptureCheckpointRecord,
  CaptureInvocationRecord,
  CaptureSessionRecord,
  ClarificationAnswerRecord,
  ClarificationQuestionRecord,
} from "../schema/capture.js";
import { verifyRecordEnvelope } from "../schema/envelope.js";
import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../schema/registry.js";
import { assertCaptureSessionRecord } from "./records.js";

/**
 * Append-only capture record store (intent-to-prd design 6/7; same
 * conventions as the profile store). Every record is schema-validated and
 * envelope-verified on write and on read; re-appending a byte-identical
 * record is an idempotent no-op while a divergent rewrite of a committed
 * identity fails closed. Session revisions are monotonic and never gap, so
 * history cannot fork silently. The Coordinator holds no authoritative
 * in-memory state — a refresh or restart resumes from these bytes alone.
 */
export class CaptureStoreError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "CaptureStoreError";
    this.kind = kind;
  }
}

export interface CaptureAppendOutcome {
  /** False when the identical record was already persisted. */
  readonly appended: boolean;
}

const SCHEMA_KEY_BY_KIND = {
  capture_session: "capture-session",
  clarification_question: "clarification-question",
  clarification_answer: "clarification-answer",
  capture_invocation: "capture-invocation",
  capture_checkpoint: "capture-checkpoint",
  capture_blocker: "capture-blocker",
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
    throw new CaptureStoreError("invalid_record", `unknown record kind: ${String(kind)}`);
  }
  const validation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate(schemaKey, record);
  if (!validation.valid) {
    throw new CaptureStoreError(
      "invalid_record",
      `record failed schema validation: ${validation.errors
        .map((error) => `${error.instancePath}: ${error.message}`)
        .join("; ")}`,
    );
  }
  if (!verifyRecordEnvelope(record)) {
    throw new CaptureStoreError("invalid_record", "record envelope digest does not verify");
  }
  if (kind === "capture_session") {
    try {
      assertCaptureSessionRecord(record as unknown as CaptureSessionRecord);
    } catch (error) {
      throw new CaptureStoreError(
        "invalid_record",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

function readRecord<T extends Record<string, unknown>>(absolute: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch {
    throw new CaptureStoreError("corrupt_record", `unparseable record file: ${absolute}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CaptureStoreError("corrupt_record", `record file is not an object: ${absolute}`);
  }
  assertValidRecord(parsed as Record<string, unknown>);
  return parsed as T;
}

function appendRecord(
  projectRoot: string,
  relativePath: string,
  record: Record<string, unknown>,
): CaptureAppendOutcome {
  assertValidRecord(record);
  const harnessRoot = harnessRootFor(projectRoot);
  const absolute = resolveHarnessPath(harnessRoot, relativePath);
  const content = serializeRecord(record);
  if (existsSync(absolute)) {
    if (readFileSync(absolute, "utf8") === content) {
      return { appended: false };
    }
    throw new CaptureStoreError(
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

// --- Session revisions -------------------------------------------------

function sessionRelativePath(sessionId: string, revision: number): string {
  return `artifacts/capture/sessions/${sessionId}/${String(revision)}.json`;
}

export function appendCaptureSessionRecord(
  projectRoot: string,
  record: CaptureSessionRecord,
): CaptureAppendOutcome {
  const relativePath = sessionRelativePath(record.session_id, record.revision);
  const absolute = resolveHarnessPath(harnessRootFor(projectRoot), relativePath);
  if (!existsSync(absolute)) {
    const latest = readLatestCaptureSession(projectRoot, record.session_id);
    const expectedRevision = latest === undefined ? 1 : latest.revision + 1;
    if (record.revision !== expectedRevision) {
      throw new CaptureStoreError(
        "session_revision_conflict",
        `expected next revision ${String(expectedRevision)}, got ${String(record.revision)}`,
      );
    }
    if (latest !== undefined && record.supersedes_digest !== latest.record_digest) {
      throw new CaptureStoreError(
        "session_revision_conflict",
        "session revision does not build on the latest committed revision",
      );
    }
  }
  return appendRecord(projectRoot, relativePath, record as unknown as Record<string, unknown>);
}

export function readCaptureSessionRevisions(
  projectRoot: string,
  sessionId: string,
): CaptureSessionRecord[] {
  const harnessRoot = harnessRootFor(projectRoot);
  const directory = resolveHarnessPath(harnessRoot, `artifacts/capture/sessions/${sessionId}`);
  if (!existsSync(directory)) return [];
  const revisions = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^[0-9]+\.json$/u.test(entry.name))
    .map((entry) => Number.parseInt(entry.name, 10))
    .sort((left, right) => left - right);
  return revisions.map((revision) =>
    readRecord<CaptureSessionRecord>(
      resolveHarnessPath(harnessRoot, sessionRelativePath(sessionId, revision)),
    ),
  );
}

export function readLatestCaptureSession(
  projectRoot: string,
  sessionId: string,
): CaptureSessionRecord | undefined {
  return readCaptureSessionRevisions(projectRoot, sessionId).at(-1);
}

export function listCaptureSessionIds(projectRoot: string): string[] {
  const harnessRoot = harnessRootFor(projectRoot);
  const directory = resolveHarnessPath(harnessRoot, "artifacts/capture/sessions");
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

// --- Questions / answers ------------------------------------------------

export function appendCaptureQuestionRecord(
  projectRoot: string,
  record: ClarificationQuestionRecord,
): CaptureAppendOutcome {
  return appendRecord(
    projectRoot,
    `artifacts/capture/questions/${record.session_id}/${record.question_id}.json`,
    record as unknown as Record<string, unknown>,
  );
}

export function readCaptureQuestions(
  projectRoot: string,
  sessionId: string,
): ClarificationQuestionRecord[] {
  return readDirectoryRecords(projectRoot, `artifacts/capture/questions/${sessionId}`);
}

export function appendCaptureAnswerRecord(
  projectRoot: string,
  record: ClarificationAnswerRecord,
): CaptureAppendOutcome {
  return appendRecord(
    projectRoot,
    `artifacts/capture/answers/${record.session_id}/${record.answer_id}.json`,
    record as unknown as Record<string, unknown>,
  );
}

export function readCaptureAnswers(
  projectRoot: string,
  sessionId: string,
): ClarificationAnswerRecord[] {
  return readDirectoryRecords(projectRoot, `artifacts/capture/answers/${sessionId}`);
}

// --- Invocations / checkpoints / blockers --------------------------------

export function appendCaptureInvocationRecord(
  projectRoot: string,
  record: CaptureInvocationRecord,
): CaptureAppendOutcome {
  return appendRecord(
    projectRoot,
    `artifacts/capture/invocations/${record.session_id}/${record.invocation_id}.json`,
    record as unknown as Record<string, unknown>,
  );
}

export function readCaptureInvocations(
  projectRoot: string,
  sessionId: string,
): CaptureInvocationRecord[] {
  return readDirectoryRecords(projectRoot, `artifacts/capture/invocations/${sessionId}`);
}

export function appendCaptureCheckpointRecord(
  projectRoot: string,
  record: CaptureCheckpointRecord,
): CaptureAppendOutcome {
  return appendRecord(
    projectRoot,
    `artifacts/capture/checkpoints/${record.session_id}/${record.checkpoint_id}.json`,
    record as unknown as Record<string, unknown>,
  );
}

export function readCaptureCheckpoints(
  projectRoot: string,
  sessionId: string,
): CaptureCheckpointRecord[] {
  // Checkpoint identity is content-derived, so order by the revision they seal.
  return readDirectoryRecords<CaptureCheckpointRecord>(
    projectRoot,
    `artifacts/capture/checkpoints/${sessionId}`,
  ).sort((left, right) => left.session_revision - right.session_revision);
}

export function appendCaptureBlockerRecord(
  projectRoot: string,
  record: CaptureBlockerRecord,
): CaptureAppendOutcome {
  return appendRecord(
    projectRoot,
    `artifacts/capture/blockers/${record.session_id}/${record.blocker_id}.json`,
    record as unknown as Record<string, unknown>,
  );
}

export function readCaptureBlockers(
  projectRoot: string,
  sessionId: string,
): CaptureBlockerRecord[] {
  return readDirectoryRecords(projectRoot, `artifacts/capture/blockers/${sessionId}`);
}
