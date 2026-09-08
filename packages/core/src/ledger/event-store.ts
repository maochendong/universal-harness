import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";

import type { EdgeRecord } from "../schema/edge.js";
import { EVENT_TYPES, type LifecycleEvent } from "../schema/event.js";
import type { LedgerOperation } from "../schema/operation.js";
import { validateSchema, type SchemaKey } from "../schema/registry.js";
import { PROTOCOL_1_3_VERSION, assertProtocolReaderCanProject } from "../protocol.js";
import { resolveHarnessPath } from "./layout.js";
import {
  BaselineMismatch,
  LedgerConflict,
  LedgerCorruptionError,
  LedgerSequenceError,
  plainRecordField,
  verifyManifestDigest,
} from "./transaction.js";

/**
 * Read-side of the ledger: committed manifests, append-only invariants,
 * branch-merge checks and deterministic replay. Materialization only ever
 * sees operations with a valid manifest whose recorded digests match the
 * shard bytes on disk; staging directories are never consulted here.
 */
export interface CommittedOperation {
  readonly manifest: LedgerOperation;
  readonly manifestPath: string;
}

export interface ReplayResult {
  readonly operations: readonly CommittedOperation[];
  readonly edges: readonly EdgeRecord[];
  readonly events: readonly LifecycleEvent[];
}

export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export interface LedgerReadOptions {
  /**
   * Protocol version of the active reader. Defaults to the newest version
   * this runtime implements; passing an older version simulates a pre-1.2
   * reader, which must fail closed on manifests that require a newer one.
   */
  readonly readerVersion?: string | undefined;
}

function parseManifest(fileName: string, raw: string, readerVersion: string): LedgerOperation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LedgerCorruptionError(`unparsable operation manifest: ${fileName}`);
  }
  // Inspect the raw reader gate before any domain validation or replay: an
  // older reader must surface protocol_upgrade_required instead of silently
  // skipping (or misprojecting) a Protocol 1.2 manifest.
  const required = plainRecordField(parsed, "required_reader_version");
  if (typeof required === "string") {
    assertProtocolReaderCanProject({
      readerVersion,
      recordVersion: required,
      authoritative: true,
    });
  }
  const result = validateSchema("ledger-operation", parsed);
  if (!result.valid) {
    const detail = result.errors
      .map((issue) => `${issue.instancePath}: ${issue.message}`)
      .join("; ");
    throw new LedgerCorruptionError(`invalid operation manifest ${fileName}: ${detail}`);
  }
  const manifest = parsed as LedgerOperation;
  if (!verifyManifestDigest(manifest)) {
    throw new LedgerCorruptionError(`manifest digest mismatch: ${fileName}`);
  }
  if (fileName !== `${manifest.ledger_operation_id}.json`) {
    throw new LedgerCorruptionError(
      `manifest file name does not match its ledger_operation_id: ${fileName}`,
    );
  }
  return manifest;
}

/**
 * Read every committed operation ordered by the manifest's logical sequence
 * — never by directory traversal order, which is platform-dependent.
 */
export function readCommittedOperations(
  harnessRoot: string,
  options?: LedgerReadOptions,
): CommittedOperation[] {
  const readerVersion = options?.readerVersion ?? PROTOCOL_1_3_VERSION;
  const operationsDir = resolveHarnessPath(harnessRoot, "ledger/operations");
  if (!existsSync(operationsDir)) return [];
  const operations = readdirSync(operationsDir)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => readCommittedOperation(harnessRoot, fileName, { readerVersion }));
  return operations.sort((left, right) => left.manifest.sequence - right.manifest.sequence);
}

/** Validate a single committed manifest, also used by incremental observers. */
export function readCommittedOperation(
  harnessRoot: string,
  fileName: string,
  options?: LedgerReadOptions,
): CommittedOperation {
  if (basename(fileName) !== fileName || !fileName.endsWith(".json")) {
    throw new LedgerCorruptionError("invalid operation manifest file name");
  }
  const manifestPath = resolveHarnessPath(harnessRoot, `ledger/operations/${fileName}`);
  return {
    manifest: parseManifest(
      fileName,
      readFileSync(manifestPath, "utf8"),
      options?.readerVersion ?? PROTOCOL_1_3_VERSION,
    ),
    manifestPath,
  };
}

export function nextSequence(operations: readonly CommittedOperation[]): number {
  return (
    operations.reduce((maximum, operation) => Math.max(maximum, operation.manifest.sequence), 0) + 1
  );
}

/** Enforce the append-only invariant before a new manifest is accepted. */
export function assertAppendOnly(
  operations: readonly CommittedOperation[],
  candidate: { readonly ledger_operation_id: string; readonly sequence: number },
): void {
  if (operations.some((op) => op.manifest.ledger_operation_id === candidate.ledger_operation_id)) {
    throw new LedgerConflict(
      `ledger operation is already committed: ${candidate.ledger_operation_id}`,
    );
  }
  const expected = nextSequence(operations);
  if (candidate.sequence !== expected) {
    throw new LedgerSequenceError(
      `append-only violation: next sequence is ${expected}, got ${candidate.sequence}`,
    );
  }
}

/**
 * Merge operations brought in by a Git branch merge with the local set.
 * Distinct `ledger_operation_id` shards merge cleanly; identical ids with
 * different digests, sequence forks, or unknown baselines are blocked with
 * typed errors — never papered over by a union merge.
 */
export function mergeCommittedOperations(
  localOperations: readonly CommittedOperation[],
  incomingOperations: readonly CommittedOperation[],
): CommittedOperation[] {
  const byId = new Map<string, CommittedOperation>(
    localOperations.map((operation) => [operation.manifest.ledger_operation_id, operation]),
  );
  const merged = [...localOperations];
  for (const incoming of incomingOperations) {
    const existing = byId.get(incoming.manifest.ledger_operation_id);
    if (existing !== undefined) {
      if (existing.manifest.digest !== incoming.manifest.digest) {
        throw new LedgerConflict(
          `ledger_operation_id ${incoming.manifest.ledger_operation_id} has conflicting digests across branches`,
        );
      }
      continue;
    }
    merged.push(incoming);
    byId.set(incoming.manifest.ledger_operation_id, incoming);
  }
  const idBySequence = new Map<number, string>();
  for (const operation of merged) {
    const previous = idBySequence.get(operation.manifest.sequence);
    if (previous !== undefined && previous !== operation.manifest.ledger_operation_id) {
      throw new LedgerSequenceError(
        `revision fork at sequence ${operation.manifest.sequence}: ${previous} vs ${operation.manifest.ledger_operation_id}`,
      );
    }
    idBySequence.set(operation.manifest.sequence, operation.manifest.ledger_operation_id);
  }
  return merged.sort((left, right) => left.manifest.sequence - right.manifest.sequence);
}

/** Block operations whose expected baseline is not part of the known chain. */
export function assertBaselineCompatible(
  operations: readonly CommittedOperation[],
  isKnownBaseline: (baseline: string) => boolean,
): void {
  for (const operation of operations) {
    if (!isKnownBaseline(operation.manifest.baseline_commit)) {
      throw new BaselineMismatch(
        `operation ${operation.manifest.ledger_operation_id} targets incompatible baseline ${operation.manifest.baseline_commit}`,
      );
    }
  }
}

function readShardRecords<T>(
  harnessRoot: string,
  relativePath: string,
  schemaKey: SchemaKey,
  expectedDigest: string | undefined,
  unknownEventTypes: "reject" | "skip" = "reject",
): T[] {
  const absolutePath = resolveHarnessPath(harnessRoot, relativePath);
  if (!existsSync(absolutePath)) {
    throw new LedgerCorruptionError(
      `missing shard referenced by a committed manifest: ${relativePath}`,
    );
  }
  const content = readFileSync(absolutePath, "utf8");
  if (expectedDigest !== undefined && sha256Hex(content) !== expectedDigest) {
    throw new LedgerCorruptionError(`shard digest mismatch: ${relativePath}`);
  }
  const records: T[] = [];
  const lines = content.split("\n");
  lines.forEach((line, index) => {
    if (line.length === 0 && index === lines.length - 1) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new LedgerCorruptionError(`unparsable record at ${relativePath}:${index + 1}`);
    }
    const eventType = plainRecordField(parsed, "event_type");
    const unknown =
      schemaKey === "event" &&
      typeof eventType === "string" &&
      eventType.trim().length > 0 &&
      !EVENT_TYPES.some((known) => known === eventType);
    // Unknown observation types may be skipped only after digest and the entire
    // common event envelope validate. A generic known discriminator exercises
    // that same schema without relaxing any of its envelope fields.
    const skip = unknown && unknownEventTypes === "skip" && expectedDigest !== undefined;
    const result = validateSchema(
      schemaKey,
      skip ? { ...(parsed as Record<string, unknown>), event_type: "OperationStarted" } : parsed,
    );
    if (!result.valid) {
      const detail = result.errors
        .map((issue) => `${issue.instancePath}: ${issue.message}`)
        .join("; ");
      throw new LedgerCorruptionError(`invalid record at ${relativePath}:${index + 1}: ${detail}`);
    }
    records.push(parsed as T);
  });
  return records;
}

/** The strict Ledger replay and observer share shard validation and binding. */
export function readCommittedEventShard(
  harnessRoot: string,
  operation: CommittedOperation,
  options?: { readonly unknownEventTypes?: "reject" | "skip" },
): readonly LifecycleEvent[] {
  const { manifest } = operation;
  const events = readShardRecords<LifecycleEvent>(
    harnessRoot,
    manifest.event_file,
    "event",
    manifest.event_file_digest,
    options?.unknownEventTypes,
  );
  let previousSequence = 0;
  const ids = new Set<string>();
  for (const event of events) {
    if (
      event.ledger_operation_id !== manifest.ledger_operation_id ||
      event.workflow_operation_id !== manifest.workflow_operation_id ||
      event.sequence <= previousSequence ||
      ids.has(event.event_id)
    ) {
      throw new LedgerCorruptionError(`invalid event binding or sequence: ${manifest.event_file}`);
    }
    previousSequence = event.sequence;
    ids.add(event.event_id);
  }
  return events.filter((event) => EVENT_TYPES.some((known) => known === event.event_type));
}

/**
 * Replay the authoritative ledger in manifest sequence order. Shard bytes
 * are verified against the digests recorded in each manifest, so a corrupt
 * shard blocks materialization instead of silently projecting bad data.
 */
export function replayLedger(harnessRoot: string, options?: LedgerReadOptions): ReplayResult {
  const operations = readCommittedOperations(harnessRoot, options);
  const edges: EdgeRecord[] = [];
  const events: LifecycleEvent[] = [];
  for (const operation of operations) {
    edges.push(
      ...readShardRecords<EdgeRecord>(
        harnessRoot,
        operation.manifest.edge_file,
        "edge",
        operation.manifest.edge_file_digest,
      ),
    );
    events.push(...readCommittedEventShard(harnessRoot, operation));
  }
  return { operations, edges, events };
}
