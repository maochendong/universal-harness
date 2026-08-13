import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  PROTOCOL_VERSION,
  canonicalizeJson,
  resolveHarnessPath,
  sha256Hex,
  validateSchema,
  type CommittedOperation,
} from "@universal-harness-internal/core";

import {
  assertWorkingState,
  assertWorkingStateWriter,
  workingStateDigest,
  type WorkingState,
  type WorkingStateWriter,
} from "./working-state.js";

/**
 * Checkpoint persistence (design 15.3). A checkpoint is committed after
 * every authoritative commit, approval, task, gate, external action and
 * snapshot boundary. Each checkpoint pairs a schema-validated
 * `CheckpointRecord` with the canonical WorkingState document whose digest
 * the record carries as `state_digest`; both land in the same atomic ledger
 * commit, so readers never see one without the other.
 */
export const CHECKPOINT_BOUNDARIES = [
  "authoritative_commit",
  "approval",
  "task",
  "gate",
  "external_action",
  "snapshot",
] as const;

export type CheckpointBoundary = (typeof CHECKPOINT_BOUNDARIES)[number];

export type CheckpointErrorKind = "checkpoint_not_found" | "checkpoint_corrupt";

export class CheckpointError extends Error {
  readonly kind: CheckpointErrorKind;

  constructor(kind: CheckpointErrorKind, message: string) {
    super(message);
    this.name = "CheckpointError";
    this.kind = kind;
  }
}

/** Matches `CheckpointRecordSchema` in core; validated against it on write and read. */
export interface CheckpointRecord {
  readonly protocol_version: string;
  readonly record_kind: "checkpoint";
  readonly checkpoint_id: string;
  readonly workflow_operation_id: string;
  readonly attempt_id: string;
  readonly phase: string;
  readonly state_digest: string;
  readonly timestamp: string;
}

export function checkpointArtifactPath(checkpointId: string): string {
  return `artifacts/checkpoints/${checkpointId}.json`;
}

export function workingStateArtifactPath(checkpointId: string): string {
  return `artifacts/working-state/${checkpointId}.json`;
}

export interface CheckpointArtifacts {
  readonly record: CheckpointRecord;
  readonly files: readonly { readonly path: string; readonly content: string }[];
}

/**
 * Serialize a checkpoint and its WorkingState into ledger artifacts. Gated
 * by the engine writer token: adapters can only propose WorkingState, never
 * serialize it into the ledger.
 */
export function buildCheckpointArtifacts(
  writer: WorkingStateWriter,
  spec: {
    readonly checkpoint_id: string;
    readonly workflow_operation_id: string;
    readonly attempt_id: string;
    readonly phase: string;
    readonly timestamp: string;
    readonly working_state: WorkingState;
  },
): CheckpointArtifacts {
  assertWorkingStateWriter(writer);
  assertWorkingState(spec.working_state);
  const record: CheckpointRecord = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "checkpoint",
    checkpoint_id: spec.checkpoint_id,
    workflow_operation_id: spec.workflow_operation_id,
    attempt_id: spec.attempt_id,
    phase: spec.phase,
    state_digest: workingStateDigest(spec.working_state),
    timestamp: spec.timestamp,
  };
  const validation = validateSchema("runtime", record);
  if (!validation.valid) {
    const detail = validation.errors
      .map((issue) => `${issue.instancePath}: ${issue.message}`)
      .join("; ");
    throw new CheckpointError("checkpoint_corrupt", `invalid checkpoint record: ${detail}`);
  }
  return {
    record,
    files: [
      {
        path: checkpointArtifactPath(spec.checkpoint_id),
        content: `${canonicalizeJson(record)}\n`,
      },
      {
        path: workingStateArtifactPath(spec.checkpoint_id),
        content: `${canonicalizeJson(spec.working_state)}\n`,
      },
    ],
  };
}

/**
 * Union of artifact digests recorded by every committed manifest of a
 * workflow operation. Runtime records carry no self digest; this allowlist
 * is the tamper-evidence that ties artifact bytes back to committed
 * manifests.
 */
export function artifactDigestAllowlist(
  operations: readonly CommittedOperation[],
  workflowOperationId: string,
): Set<string> {
  const allowed = new Set<string>();
  for (const operation of operations) {
    if (operation.manifest.workflow_operation_id !== workflowOperationId) continue;
    for (const digest of operation.manifest.artifact_digests) allowed.add(digest);
  }
  return allowed;
}

/**
 * Read an artifact only if its bytes match a digest some committed manifest
 * recorded for the operation. Anything else is corruption, not data.
 */
export function readVerifiedArtifact(
  harnessRoot: string,
  relativePath: string,
  allowedDigests: ReadonlySet<string>,
): string {
  const absolute = resolveHarnessPath(harnessRoot, relativePath);
  if (!existsSync(absolute)) {
    throw new CheckpointError("checkpoint_not_found", `artifact not committed: ${relativePath}`);
  }
  const bytes = readFileSync(absolute, "utf8");
  if (!allowedDigests.has(sha256Hex(bytes))) {
    throw new CheckpointError(
      "checkpoint_corrupt",
      `artifact bytes match no committed manifest digest: ${relativePath}`,
    );
  }
  return bytes;
}

export function readVerifiedJsonArtifact(
  harnessRoot: string,
  relativePath: string,
  allowedDigests: ReadonlySet<string>,
): unknown {
  const bytes = readVerifiedArtifact(harnessRoot, relativePath, allowedDigests);
  try {
    return JSON.parse(bytes) as unknown;
  } catch {
    throw new CheckpointError("checkpoint_corrupt", `unparsable artifact: ${relativePath}`);
  }
}

function parseCheckpointRecord(
  harnessRoot: string,
  relativePath: string,
  allowedDigests: ReadonlySet<string>,
  workflowOperationId: string,
): CheckpointRecord | undefined {
  let parsed: unknown;
  try {
    parsed = readVerifiedJsonArtifact(harnessRoot, relativePath, allowedDigests);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as CheckpointRecord;
  if (
    candidate.record_kind !== "checkpoint" ||
    candidate.workflow_operation_id !== workflowOperationId
  ) {
    return undefined;
  }
  if (!validateSchema("runtime", candidate).valid) return undefined;
  return candidate;
}

export interface CommittedCheckpoint {
  readonly record: CheckpointRecord;
  readonly workingState: WorkingState;
}

function loadWorkingState(
  harnessRoot: string,
  record: CheckpointRecord,
  allowedDigests: ReadonlySet<string>,
): WorkingState | undefined {
  let parsed: unknown;
  try {
    parsed = readVerifiedJsonArtifact(
      harnessRoot,
      workingStateArtifactPath(record.checkpoint_id),
      allowedDigests,
    );
  } catch {
    return undefined;
  }
  if (workingStateDigest(parsed as WorkingState) !== record.state_digest) return undefined;
  try {
    assertWorkingState(parsed);
  } catch {
    return undefined;
  }
  return parsed;
}

/**
 * The newest checkpoint whose record, WorkingState document and cross-digest
 * all verify. Corrupt or incomplete newer checkpoints are skipped in favor
 * of the latest fully valid one, per the resume protocol.
 */
export function latestValidCheckpoint(
  harnessRoot: string,
  operations: readonly CommittedOperation[],
  workflowOperationId: string,
): CommittedCheckpoint | undefined {
  const allowedDigests = artifactDigestAllowlist(operations, workflowOperationId);
  const directory = resolveHarnessPath(harnessRoot, "artifacts/checkpoints");
  if (!existsSync(directory)) return undefined;
  const candidates = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) =>
      parseCheckpointRecord(
        harnessRoot,
        `artifacts/checkpoints/${name}`,
        allowedDigests,
        workflowOperationId,
      ),
    )
    .filter((record): record is CheckpointRecord => record !== undefined)
    .sort((left, right) =>
      left.timestamp === right.timestamp
        ? left.checkpoint_id < right.checkpoint_id
          ? 1
          : -1
        : left.timestamp < right.timestamp
          ? 1
          : -1,
    );
  for (const record of candidates) {
    const workingState = loadWorkingState(harnessRoot, record, allowedDigests);
    if (workingState !== undefined) return { record, workingState };
  }
  return undefined;
}

/** All checkpoints of an operation, oldest first, with integrity verified. */
export function listValidCheckpoints(
  harnessRoot: string,
  operations: readonly CommittedOperation[],
  workflowOperationId: string,
): readonly CommittedCheckpoint[] {
  const checkpoints: CommittedCheckpoint[] = [];
  const seen = new Set<string>();
  let latest = latestValidCheckpoint(harnessRoot, operations, workflowOperationId);
  while (latest !== undefined && !seen.has(latest.record.checkpoint_id)) {
    seen.add(latest.record.checkpoint_id);
    checkpoints.push(latest);
    const previousId = latest.workingState.previous_checkpoint_id;
    if (previousId === undefined) break;
    latest = loadCheckpointById(harnessRoot, operations, workflowOperationId, previousId);
  }
  return checkpoints.reverse();
}

function loadCheckpointById(
  harnessRoot: string,
  operations: readonly CommittedOperation[],
  workflowOperationId: string,
  checkpointId: string,
): CommittedCheckpoint | undefined {
  const allowedDigests = artifactDigestAllowlist(operations, workflowOperationId);
  const record = parseCheckpointRecord(
    harnessRoot,
    checkpointArtifactPath(checkpointId),
    allowedDigests,
    workflowOperationId,
  );
  if (record === undefined) return undefined;
  const workingState = loadWorkingState(harnessRoot, record, allowedDigests);
  return workingState === undefined ? undefined : { record, workingState };
}

/** Directory listing helper for runtime artifact scans (runs, approvals). */
export function listArtifactFiles(harnessRoot: string, relativeDirectory: string): string[] {
  const directory = resolveHarnessPath(harnessRoot, relativeDirectory);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(relativeDirectory, name).split("\\").join("/"));
}
