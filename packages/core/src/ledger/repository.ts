import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";

import { canonicalizeJson } from "../identity/canonical-json.js";
import type { LedgerOperation } from "../schema/operation.js";
import {
  assertAppendOnly,
  nextSequence,
  readCommittedOperations,
  replayLedger,
  sha256Hex,
  type CommittedOperation,
  type ReplayResult,
} from "./event-store.js";
import {
  assertLedgerOperationId,
  edgeShardRelativePath,
  eventShardRelativePath,
  harnessRootFor,
  operationManifestRelativePath,
  resolveHarnessPath,
  shardMonthFor,
  stagingRelativePath,
} from "./layout.js";
import { acquireWriteLock, type AcquireWriteLockOptions } from "./lock.js";
import {
  BaselineMismatch,
  LedgerConflict,
  LedgerCorruptionError,
  LedgerValidationError,
  UnsupportedAtomicity,
  buildManifest,
  manifestDigest,
  validateTransaction,
  type CommitHooks,
  type DurableBoundary,
  type TransactionInput,
} from "./transaction.js";

/**
 * Git-native ledger repository. A commit stages every byte under
 * `.harness/staging/<ledger-operation-id>/`, validates, then publishes by
 * same-volume atomic renames with the commit manifest written last, so any
 * interruption leaves either the whole operation visible or none of it.
 * Retrying an already committed `ledger_operation_id` is an idempotent
 * no-op; the project-level write lock serializes writers while readers
 * replay lock-free.
 */
export type CommitResult =
  | { readonly status: "committed"; readonly manifest: LedgerOperation }
  | { readonly status: "already_committed"; readonly manifest: LedgerOperation };

export interface StagingRecovery {
  readonly operationId: string;
  readonly stagingDir: string;
  /** "incomplete" staging is never treated as accepted authoritative data. */
  readonly status: "committed" | "incomplete";
}

export interface RecoveryReport {
  readonly staging: readonly StagingRecovery[];
  /** Shard files no committed manifest references; not authoritative. */
  readonly orphanShards: readonly string[];
}

export type LockTuning = Omit<AcquireWriteLockOptions, "harnessRoot">;

export interface LedgerRepositoryOptions {
  readonly projectRoot: string;
  /** Returns the current baseline commit the caller expects to build on. */
  readonly readBaseline: () => string;
  readonly now?: () => string;
  readonly hooks?: CommitHooks;
  readonly lock?: LockTuning;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable device lookup so tests can simulate cross-volume file systems. */
  readonly deviceOf?: (path: string) => number;
  /**
   * Protocol version this repository reads as. Defaults to the newest
   * version this runtime implements; an older reader fails closed on
   * manifests carrying `required_reader_version` beyond it.
   */
  readonly readerVersion?: string;
}

interface CommitContext {
  operationId: string;
  stagingDir: string | undefined;
  stagedFiles: string[];
  targetFiles: string[];
  manifestPath: string | undefined;
  edgeFile: string;
  eventFile: string;
  /** Expected sha-256 of every staged file, checked again at publish time. */
  stagedDigests: Map<string, string>;
}

const RETRIABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function writeFileFsync(path: string, content: string): void {
  const fd = openSync(path, "w");
  try {
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function serializeJsonl(records: readonly unknown[]): string {
  if (records.length === 0) return "";
  return `${records.map((record) => canonicalizeJson(record)).join("\n")}\n`;
}

function defaultDeviceOf(path: string): number {
  // realpath resolves symlinks/junctions so the volume check compares the
  // physical devices, not the apparent paths.
  return statSync(realpathSync.native(path)).dev;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

/**
 * Prove same-volume atomic replace is possible before committing. When the
 * file system cannot prove it, the operation blocks with a typed
 * UnsupportedAtomicity instead of degrading into non-atomic writes.
 */
export function assertSameVolumeAtomicity(
  paths: readonly string[],
  deviceOf: (path: string) => number = defaultDeviceOf,
): void {
  const devices = new Set(paths.map((path) => deviceOf(path)));
  if (devices.size !== 1) {
    throw new UnsupportedAtomicity(
      "staging area and ledger targets are not on the same volume; atomic rename cannot be proven",
    );
  }
}

async function renameWithBackoff(
  from: string,
  to: string,
  sleep: (ms: number) => Promise<void>,
  attempts = 4,
  initialBackoffMs = 25,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows sharing violations surface as EPERM/EACCES/EBUSY and clear
      // once the holding process releases its handle; retry with bounded
      // backoff, then propagate.
      if (code !== undefined && RETRIABLE_RENAME_CODES.has(code) && attempt < attempts - 1) {
        await sleep(initialBackoffMs * 2 ** attempt);
        continue;
      }
      throw error;
    }
  }
}

interface InputDigests {
  readonly artifactDigests: readonly string[];
  readonly edgeContent: string;
  readonly eventContent: string;
  readonly edgeFileDigest: string;
  readonly eventFileDigest: string;
}

function computeInputDigests(input: TransactionInput): InputDigests {
  const edgeContent = serializeJsonl(input.edges ?? []);
  const eventContent = serializeJsonl(input.events ?? []);
  return {
    artifactDigests: (input.artifacts ?? []).map((artifact) => sha256Hex(artifact.content)),
    edgeContent,
    eventContent,
    edgeFileDigest: sha256Hex(edgeContent),
    eventFileDigest: sha256Hex(eventContent),
  };
}

function safeEntries(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function listFilesRecursive(directory: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(absolute));
    } else if (entry.isFile()) {
      results.push(absolute);
    }
  }
  return results;
}

export class LedgerRepository {
  readonly harnessRoot: string;
  private readonly readBaseline: () => string;
  private readonly now: () => string;
  private readonly hooks: CommitHooks | undefined;
  private readonly lockTuning: LockTuning | undefined;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;
  private readonly deviceOf: ((path: string) => number) | undefined;
  private readonly readerVersion: string | undefined;

  constructor(options: LedgerRepositoryOptions) {
    this.harnessRoot = harnessRootFor(options.projectRoot);
    this.readBaseline = options.readBaseline;
    this.now = options.now ?? (() => new Date().toISOString());
    this.hooks = options.hooks;
    this.lockTuning = options.lock;
    this.sleep = options.sleep;
    this.deviceOf = options.deviceOf;
    this.readerVersion = options.readerVersion;
  }

  operations(): CommittedOperation[] {
    return readCommittedOperations(this.harnessRoot, { readerVersion: this.readerVersion });
  }

  replay(): ReplayResult {
    return replayLedger(this.harnessRoot, { readerVersion: this.readerVersion });
  }

  /**
   * Classify leftover staging directories without accepting them. Incomplete
   * staging (no committed manifest) is reported for explicit revision or
   * discard; it never feeds replay.
   */
  recover(): RecoveryReport {
    const stagingRoot = resolveHarnessPath(this.harnessRoot, "staging");
    const staging: StagingRecovery[] = [];
    for (const entry of safeEntries(stagingRoot)) {
      const manifestPath = resolveHarnessPath(
        this.harnessRoot,
        operationManifestRelativePath(entry),
      );
      staging.push({
        operationId: entry,
        stagingDir: join(stagingRoot, entry),
        status: existsSync(manifestPath) ? "committed" : "incomplete",
      });
    }
    const referenced = new Set<string>();
    for (const operation of this.operations()) {
      referenced.add(operation.manifest.edge_file);
      referenced.add(operation.manifest.event_file);
    }
    const orphanShards: string[] = [];
    for (const root of ["ledger/edges", "events"]) {
      const absoluteRoot = resolveHarnessPath(this.harnessRoot, root);
      for (const month of safeEntries(absoluteRoot)) {
        for (const file of safeEntries(join(absoluteRoot, month))) {
          const relative = `${root}/${month}/${file}`;
          if (!referenced.has(relative)) orphanShards.push(relative);
        }
      }
    }
    return { staging, orphanShards };
  }

  /** Explicitly discard incomplete staging; committed data is never touched. */
  discardStaging(operationId: string): void {
    const manifestPath = resolveHarnessPath(
      this.harnessRoot,
      operationManifestRelativePath(operationId),
    );
    if (existsSync(manifestPath)) {
      throw new LedgerConflict(`cannot discard staging for committed operation: ${operationId}`);
    }
    rmSync(resolveHarnessPath(this.harnessRoot, stagingRelativePath(operationId)), {
      recursive: true,
      force: true,
    });
  }

  async commit(input: TransactionInput): Promise<CommitResult> {
    assertLedgerOperationId(input.ledger_operation_id);
    const digests = computeInputDigests(input);

    // Fast path: idempotent retry short-circuits before touching the lock.
    const existing = this.readManifest(input.ledger_operation_id);
    if (existing !== undefined) {
      return this.resolveRetry(existing, input, digests);
    }

    this.ensureDirectories(input.artifacts?.map((artifact) => artifact.path) ?? []);
    const lock = await acquireWriteLock({ harnessRoot: this.harnessRoot, ...this.lockTuning });
    const context = this.newContext(input.ledger_operation_id);
    let result: CommitResult;
    try {
      this.atBoundary("lock.acquired", context);

      // Re-check inside the lock: another writer may have committed while we waited.
      const committed = this.readManifest(input.ledger_operation_id);
      if (committed !== undefined) {
        result = this.resolveRetry(committed, input, digests);
        return result;
      }

      this.proveAtomicity(context);
      this.writeStaging(input, digests, context);
      this.atBoundary("staging.prepared", context);

      const issues = validateTransaction(input);
      if (issues.length > 0) {
        throw new LedgerValidationError(
          `transaction ${input.ledger_operation_id} failed validation; staging preserved at ${context.stagingDir ?? "unknown"}`,
          issues,
        );
      }
      const operations = readCommittedOperations(this.harnessRoot);
      const sequence = nextSequence(operations);
      assertAppendOnly(operations, {
        ledger_operation_id: input.ledger_operation_id,
        sequence,
      });
      const baseline = this.readBaseline();
      if (baseline !== input.expected_baseline) {
        throw new BaselineMismatch(
          `expected baseline ${input.expected_baseline}, current baseline is ${baseline}`,
        );
      }
      this.atBoundary("validation.completed", context);

      await this.publishShards(context);
      this.atBoundary("shards.renamed", context);

      const manifest = buildManifest({
        ledger_operation_id: input.ledger_operation_id,
        workflow_operation_id: input.workflow_operation_id,
        attempt_id: input.attempt_id,
        baseline_commit: input.expected_baseline,
        sequence,
        artifact_digests: [...digests.artifactDigests],
        edge_file: context.edgeFile,
        event_file: context.eventFile,
        edge_file_digest: digests.edgeFileDigest,
        event_file_digest: digests.eventFileDigest,
        ...(input.required_reader_version !== undefined
          ? { required_reader_version: input.required_reader_version }
          : {}),
        committed_at: this.now(),
      });
      this.publishManifest(manifest, context);
      this.atBoundary("manifest.committed", context);

      rmSync(context.stagingDir as string, { recursive: true, force: true });
      result = { status: "committed", manifest };
    } finally {
      lock.release();
    }
    this.atBoundary("lock.released", context);
    return result;
  }

  private resolveRetry(
    existing: LedgerOperation,
    input: TransactionInput,
    digests: InputDigests,
  ): CommitResult {
    // Compare deterministic content only: sequence and shard paths come from
    // the stored manifest, and committed_at never feeds the digest, so a
    // faithful retry of the same operation is recognized regardless of when
    // or where it is re-attempted.
    const candidateDigest = manifestDigest({
      ledger_operation_id: input.ledger_operation_id,
      workflow_operation_id: input.workflow_operation_id,
      attempt_id: input.attempt_id,
      baseline_commit: input.expected_baseline,
      sequence: existing.sequence,
      artifact_digests: digests.artifactDigests,
      edge_file: existing.edge_file,
      event_file: existing.event_file,
      edge_file_digest: digests.edgeFileDigest,
      event_file_digest: digests.eventFileDigest,
      ...(input.required_reader_version !== undefined
        ? { required_reader_version: input.required_reader_version }
        : {}),
      committed_at: existing.committed_at,
    });
    if (candidateDigest === existing.digest) {
      return { status: "already_committed", manifest: existing };
    }
    throw new LedgerConflict(
      `ledger_operation_id ${input.ledger_operation_id} was already committed with different content`,
    );
  }

  private readManifest(operationId: string): LedgerOperation | undefined {
    return this.operations().find(
      (candidate) => candidate.manifest.ledger_operation_id === operationId,
    )?.manifest;
  }

  private newContext(operationId: string): CommitContext {
    const month = shardMonthFor(this.now());
    return {
      operationId,
      stagingDir: resolveHarnessPath(this.harnessRoot, stagingRelativePath(operationId)),
      stagedFiles: [],
      targetFiles: [],
      manifestPath: undefined,
      edgeFile: edgeShardRelativePath(month, operationId),
      eventFile: eventShardRelativePath(month, operationId),
      stagedDigests: new Map(),
    };
  }

  private atBoundary(boundary: DurableBoundary, context: CommitContext): void {
    this.hooks?.atBoundary?.(boundary, {
      operationId: context.operationId,
      stagingDir: context.stagingDir,
      stagedFiles: [...context.stagedFiles],
      targetFiles: [...context.targetFiles],
      manifestPath: context.manifestPath,
    });
  }

  private ensureDirectories(artifactPaths: readonly string[]): void {
    for (const relative of ["staging", "locks", "ledger/operations"]) {
      mkdirSync(resolveHarnessPath(this.harnessRoot, relative), { recursive: true });
    }
    for (const artifactPath of artifactPaths) {
      const parent = artifactPath.split("/").slice(0, -1).join("/");
      if (parent.length > 0) {
        mkdirSync(resolveHarnessPath(this.harnessRoot, parent), { recursive: true });
      }
    }
  }

  private proveAtomicity(context: CommitContext): void {
    const shardParents = [
      dirname(resolveHarnessPath(this.harnessRoot, context.edgeFile)),
      dirname(resolveHarnessPath(this.harnessRoot, context.eventFile)),
    ];
    for (const parent of shardParents) mkdirSync(parent, { recursive: true });
    mkdirSync(context.stagingDir as string, { recursive: true });
    assertSameVolumeAtomicity(
      [
        this.harnessRoot,
        context.stagingDir as string,
        resolveHarnessPath(this.harnessRoot, "ledger/operations"),
        ...shardParents,
      ],
      this.deviceOf ?? defaultDeviceOf,
    );
  }

  private writeStaging(
    input: TransactionInput,
    digests: InputDigests,
    context: CommitContext,
  ): void {
    const stagingDir = context.stagingDir as string;
    mkdirSync(stagingDir, { recursive: true });
    const stagedArtifacts: Array<{ path: string; expectedDigest: string }> = [];
    for (const artifact of input.artifacts ?? []) {
      const stagedPath = join(stagingDir, ...artifact.path.split("/"));
      mkdirSync(dirname(stagedPath), { recursive: true });
      writeFileFsync(stagedPath, artifact.content);
      context.stagedFiles.push(stagedPath);
      stagedArtifacts.push({ path: stagedPath, expectedDigest: sha256Hex(artifact.content) });
    }
    const stagedEdges = join(stagingDir, "edges.jsonl");
    const stagedEvents = join(stagingDir, "events.jsonl");
    writeFileFsync(stagedEdges, digests.edgeContent);
    writeFileFsync(stagedEvents, digests.eventContent);
    context.stagedFiles.push(stagedEdges, stagedEvents);
    stagedArtifacts.push(
      { path: stagedEdges, expectedDigest: digests.edgeFileDigest },
      { path: stagedEvents, expectedDigest: digests.eventFileDigest },
    );

    // Read back every staged byte: a corrupt output device or torn write
    // surfaces here, before anything is published to the ledger.
    for (const staged of stagedArtifacts) {
      if (sha256Hex(readFileSync(staged.path, "utf8")) !== staged.expectedDigest) {
        throw new LedgerCorruptionError(`staged content digest mismatch: ${staged.path}`);
      }
      context.stagedDigests.set(staged.path, staged.expectedDigest);
    }
  }

  private async publishShards(context: CommitContext): Promise<void> {
    const stagingDir = context.stagingDir as string;
    const moves: Array<{ from: string; to: string }> = [];
    for (const stagedFile of listFilesRecursive(stagingDir)) {
      const relativeName = stagedFile
        .slice(stagingDir.length + 1)
        .split(sep)
        .join("/");
      const relative =
        relativeName === "edges.jsonl"
          ? context.edgeFile
          : relativeName === "events.jsonl"
            ? context.eventFile
            : relativeName;
      const target = resolveHarnessPath(this.harnessRoot, relative);
      mkdirSync(dirname(target), { recursive: true });
      moves.push({ from: stagedFile, to: target });
    }

    for (const move of moves) {
      // Re-verify staged bytes immediately before publishing: corruption
      // injected after staging never reaches the authoritative ledger.
      const expectedDigest = context.stagedDigests.get(move.from);
      const stagedBytes = readFileSync(move.from, "utf8");
      if (expectedDigest !== undefined && sha256Hex(stagedBytes) !== expectedDigest) {
        throw new LedgerCorruptionError(`staged content digest mismatch: ${move.from}`);
      }
      if (existsSync(move.to)) {
        const targetBytes = readFileSync(move.to, "utf8");
        if (sha256Hex(stagedBytes) === sha256Hex(targetBytes)) {
          // An earlier interrupted attempt already published this file.
          rmSync(move.from, { force: true });
          context.targetFiles.push(move.to);
          continue;
        }
        throw new LedgerConflict(
          `immutable ledger file already exists with different content: ${move.to}`,
        );
      }
      await renameWithBackoff(move.from, move.to, this.sleep ?? defaultSleep);
      context.targetFiles.push(move.to);
    }
  }

  private publishManifest(manifest: LedgerOperation, context: CommitContext): void {
    const target = resolveHarnessPath(
      this.harnessRoot,
      operationManifestRelativePath(manifest.ledger_operation_id),
    );
    // Write to a sibling temp file first, then atomically rename it into
    // place: the manifest is the commit point of the whole transaction.
    const temporary = join(dirname(target), `.${manifest.ledger_operation_id}.tmp`);
    writeFileFsync(temporary, `${canonicalizeJson(manifest)}\n`);
    renameSync(temporary, target);
    context.manifestPath = target;
  }
}
