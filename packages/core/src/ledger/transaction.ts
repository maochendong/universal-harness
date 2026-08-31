import { contentDigest } from "../identity/digest.js";
import { PROTOCOL_1_2_VERSION, compareProtocolVersions, isKnownProtocol } from "../protocol.js";
import type { EdgeRecord } from "../schema/edge.js";
import type { LifecycleEvent } from "../schema/event.js";
import type { LedgerOperation } from "../schema/operation.js";
import { validateSchema, type ValidationIssue } from "../schema/registry.js";
import { PROTOCOL_VERSION } from "../version.js";

/**
 * Ledger transaction manifest and commit-time validation.
 *
 * The committed manifest is a `ledger_operation` record (schema source:
 * `schema/operation.ts`). Its digest is computed over every content field
 * except `digest` itself and `committed_at`: the commit wall-clock time is
 * metadata about when the bytes landed, so excluding it keeps the digest
 * stable across idempotent retries of the same `ledger_operation_id`.
 */
export type LedgerErrorKind =
  | "unsupported_atomicity"
  | "validation_failed"
  | "baseline_mismatch"
  | "ledger_conflict"
  | "sequence_error"
  | "corruption";

export class LedgerError extends Error {
  readonly kind: LedgerErrorKind;

  constructor(kind: LedgerErrorKind, message: string) {
    super(message);
    this.name = "LedgerError";
    this.kind = kind;
  }
}

export class UnsupportedAtomicity extends LedgerError {
  constructor(message: string) {
    super("unsupported_atomicity", message);
    this.name = "UnsupportedAtomicity";
  }
}

export class LedgerValidationError extends LedgerError {
  readonly issues: readonly ValidationIssue[];

  constructor(message: string, issues: readonly ValidationIssue[]) {
    super("validation_failed", message);
    this.name = "LedgerValidationError";
    this.issues = issues;
  }
}

export class BaselineMismatch extends LedgerError {
  constructor(message: string) {
    super("baseline_mismatch", message);
    this.name = "BaselineMismatch";
  }
}

export class LedgerConflict extends LedgerError {
  constructor(message: string) {
    super("ledger_conflict", message);
    this.name = "LedgerConflict";
  }
}

export class LedgerSequenceError extends LedgerError {
  constructor(message: string) {
    super("sequence_error", message);
    this.name = "LedgerSequenceError";
  }
}

export class LedgerCorruptionError extends LedgerError {
  constructor(message: string) {
    super("corruption", message);
    this.name = "LedgerCorruptionError";
  }
}

/** Named durable boundaries where a commit can be interrupted. */
export const DURABLE_BOUNDARIES = [
  "lock.acquired",
  "staging.prepared",
  "validation.completed",
  "shards.renamed",
  "manifest.committed",
  "lock.released",
] as const;

export type DurableBoundary = (typeof DURABLE_BOUNDARIES)[number];

export interface BoundaryContext {
  readonly operationId: string;
  readonly stagingDir: string | undefined;
  readonly stagedFiles: readonly string[];
  readonly targetFiles: readonly string[];
  readonly manifestPath: string | undefined;
}

export interface CommitHooks {
  atBoundary?(boundary: DurableBoundary, context: BoundaryContext): void;
}

export interface TransactionArtifact {
  /** Ledger-relative POSIX path of the artifact file inside `.harness`. */
  readonly path: string;
  readonly content: string;
}

export interface TransactionInput {
  readonly ledger_operation_id: string;
  readonly workflow_operation_id: string;
  readonly attempt_id: string;
  readonly expected_baseline: string;
  readonly artifacts?: readonly TransactionArtifact[];
  readonly edges?: readonly EdgeRecord[];
  readonly events?: readonly LifecycleEvent[];
  /**
   * Protocol 1.2+: required exactly when the transaction carries an
   * authoritative Artifact/Event at protocol 1.2.0 or newer; the only accepted
   * value is the newest carried version ("1.2.0" or "1.3.0"). Plain 1.0/1.1
   * transactions never write the field.
   */
  readonly required_reader_version?: string;
}

export interface ManifestDraft {
  readonly ledger_operation_id: string;
  readonly workflow_operation_id: string;
  readonly attempt_id: string;
  readonly baseline_commit: string;
  readonly sequence: number;
  readonly artifact_digests: readonly string[];
  readonly edge_file: string;
  readonly event_file: string;
  readonly edge_file_digest: string;
  readonly event_file_digest: string;
  readonly required_reader_version?: string;
  readonly committed_at: string;
}

export function manifestDigest(draft: ManifestDraft): string {
  const { committed_at, required_reader_version, ...content } = draft;
  void committed_at;
  return contentDigest({
    protocol_version: PROTOCOL_VERSION,
    record_kind: "ledger_operation",
    ...content,
    ...requiredReaderVersionField(required_reader_version),
  });
}

export function buildManifest(draft: ManifestDraft): LedgerOperation {
  // `persistedRecordProperties` widens protocol_version/record_kind away at
  // the type level; runtime schema validation is the enforcing layer.
  const { required_reader_version, ...content } = draft;
  return {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "ledger_operation",
    ...content,
    ...requiredReaderVersionField(required_reader_version),
    artifact_digests: [...draft.artifact_digests],
    digest: manifestDigest(draft),
  } as LedgerOperation;
}

export function verifyManifestDigest(manifest: LedgerOperation): boolean {
  const rest: Record<string, unknown> = { ...manifest };
  delete rest.digest;
  delete rest.committed_at;
  return contentDigest(rest) === manifest.digest;
}

const ARTIFACT_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

/** Ledger-internal trees are written only by the transaction engine itself. */
const RESERVED_ARTIFACT_PREFIXES = ["ledger/", "events/", "staging/", "locks/", "cache/"];

/**
 * Read a field off a parsed JSON value only when it is a plain object. Shared
 * by every raw-payload sniff (artifact/event protocol detection and the
 * manifest reader gate) so none of them trusts arrays, nulls or primitives.
 */
export function plainRecordField(value: unknown, field: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[field];
}

/**
 * Canonical JSON rejects undefined values; the optional reader gate must
 * never serialize as a present-but-undefined key. Include it only when set.
 */
export function requiredReaderVersionField(version: string | undefined): {
  readonly required_reader_version?: string;
} {
  return version !== undefined ? { required_reader_version: version } : {};
}

/**
 * Authoritative-content detection: a transaction is reader-gated when any
 * event or JSON artifact carries a known `protocol_version` at 1.2.0 or newer.
 * Unparseable artifact content is opaque bytes, never an authoritative record.
 */
function artifactProtocolVersion(content: string): string | undefined {
  try {
    const version = plainRecordField(JSON.parse(content), "protocol_version");
    return typeof version === "string" && isKnownProtocol(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

function eventProtocolVersion(event: unknown): string | undefined {
  // `persistedRecordProperties` widens protocol_version away at the type
  // level; the persisted record always carries it at runtime.
  const version = plainRecordField(event, "protocol_version");
  return typeof version === "string" && isKnownProtocol(version) ? version : undefined;
}

/**
 * Single newest-authoritative-version reducer: the exact
 * `required_reader_version` a transaction must pin, or undefined when it only
 * carries legacy 1.0/1.1 content. A transaction mixing 1.2 and 1.3 content
 * reduces to 1.3.0; a transaction with no post-1.1 content keeps its existing
 * manifest bytes.
 */
export function transactionRequiredReaderVersion(input: TransactionInput): string | undefined {
  let newest: string | undefined;
  const consider = (version: string | undefined): void => {
    if (version === undefined) return;
    if (compareProtocolVersions(version, PROTOCOL_1_2_VERSION) < 0) return;
    if (newest === undefined || compareProtocolVersions(version, newest) > 0) newest = version;
  };
  for (const event of input.events ?? []) consider(eventProtocolVersion(event));
  for (const artifact of input.artifacts ?? []) consider(artifactProtocolVersion(artifact.content));
  return newest;
}

/**
 * Validate a transaction before any byte leaves staging. Every issue carries
 * the precise record location so callers can report it; nothing here mutates
 * the ledger.
 */
export function validateTransaction(input: TransactionInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const artifacts = input.artifacts ?? [];
  const edges = input.edges ?? [];
  const events = input.events ?? [];

  const seenArtifactPaths = new Set<string>();
  artifacts.forEach((artifact, index) => {
    const location = `/artifacts/${index}/path`;
    if (RESERVED_ARTIFACT_PREFIXES.some((prefix) => artifact.path.startsWith(prefix))) {
      issues.push({
        instancePath: location,
        keyword: "reservedPrefix",
        message: `artifact path is reserved for ledger internals: ${artifact.path}`,
      });
    }
    if (
      !ARTIFACT_PATH_PATTERN.test(artifact.path) ||
      artifact.path.includes("//") ||
      artifact.path.split("/").some((segment) => segment === "." || segment === "..")
    ) {
      issues.push({
        instancePath: location,
        keyword: "pattern",
        message: `illegal artifact path: ${JSON.stringify(artifact.path)}`,
      });
    }
    if (seenArtifactPaths.has(artifact.path)) {
      issues.push({
        instancePath: location,
        keyword: "uniqueItems",
        message: `duplicate artifact path: ${artifact.path}`,
      });
    }
    seenArtifactPaths.add(artifact.path);
  });

  edges.forEach((edge, index) => {
    const result = validateSchema("edge", edge);
    for (const issue of result.valid ? [] : result.errors) {
      issues.push({ ...issue, instancePath: `/edges/${index}${issue.instancePath}` });
    }
  });

  events.forEach((event, index) => {
    const result = validateSchema("event", event);
    for (const issue of result.valid ? [] : result.errors) {
      issues.push({ ...issue, instancePath: `/events/${index}${issue.instancePath}` });
    }
    if (result.valid && event.ledger_operation_id !== input.ledger_operation_id) {
      issues.push({
        instancePath: `/events/${index}/ledger_operation_id`,
        keyword: "operationBinding",
        message: "event does not belong to this ledger operation",
      });
    }
    if (result.valid && event.workflow_operation_id !== input.workflow_operation_id) {
      issues.push({
        instancePath: `/events/${index}/workflow_operation_id`,
        keyword: "operationBinding",
        message: "event does not belong to this workflow operation",
      });
    }
  });

  // Reader gate (Protocol 1.2+): a transaction carrying authoritative records
  // at 1.2.0 or newer must pin required_reader_version to exactly the newest
  // carried version, and a plain 1.0/1.1 transaction must not carry the field
  // at all.
  const requiredVersion = transactionRequiredReaderVersion(input);
  if (requiredVersion !== undefined && input.required_reader_version !== requiredVersion) {
    issues.push({
      instancePath: "/required_reader_version",
      keyword: "requiredReaderVersion",
      message: `transaction carries protocol ${requiredVersion} authoritative records and must pin required_reader_version to ${requiredVersion}`,
    });
  }
  if (requiredVersion === undefined && input.required_reader_version !== undefined) {
    issues.push({
      instancePath: "/required_reader_version",
      keyword: "requiredReaderVersion",
      message:
        "required_reader_version is only valid on transactions carrying protocol 1.2 or newer records",
    });
  }

  return issues;
}
