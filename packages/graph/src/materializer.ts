import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  PROTOCOL_VERSION,
  contentDigest,
  harnessRootFor,
  readCommittedOperations,
  replayLedger,
  resolveHarnessPath,
  sha256Hex,
  validateSchema,
  type CommittedOperation,
  type EdgeRecord,
  type LifecycleEvent,
  type NodeRecord,
} from "@universal-harness-internal/core";
import type { DatabaseSync } from "node:sqlite";

import {
  META_KEYS,
  clearProjection,
  openGraphDatabase,
  readMeta,
  writeMeta,
} from "./sqlite/database.js";
import { assertGraphIntegrity } from "./integrity.js";

/**
 * Ledger materializer. Rebuilds the disposable SQLite projection from the
 * authoritative Git-native ledger: committed operation manifests (in manifest
 * sequence order, never directory order), digest-verified edge/event shards,
 * and node artifact files whose content digest is recorded by a committed
 * manifest. Files on disk that no committed manifest references are reported
 * but never projected, so staging leftovers or hand edits cannot leak into
 * query results.
 */
export type MaterializationErrorKind = "invalid_artifact" | "revision_fork" | "conflicting_event";

export class MaterializationError extends Error {
  readonly kind: MaterializationErrorKind;

  constructor(kind: MaterializationErrorKind, message: string) {
    super(message);
    this.name = "MaterializationError";
    this.kind = kind;
  }
}

export interface MaterializeOptions {
  /** Project root containing the `.harness` ledger directory. */
  readonly projectRoot: string;
  /** SQLite cache path, or ":memory:" for an ephemeral projection. */
  readonly databasePath: string;
}

export interface MaterializationReport {
  readonly operationCount: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly eventCount: number;
  /** Highest committed ledger sequence materialized (0 for an empty ledger). */
  readonly lastSequence: number;
  /** Artifact files ignored because no committed manifest records their digest. */
  readonly skippedArtifacts: readonly string[];
  /** Deterministic digest of the projected state; stable across rebuilds. */
  readonly projectionDigest: string;
}

export interface Materialization {
  readonly database: DatabaseSync;
  readonly report: MaterializationReport;
}

interface NodeCandidate {
  readonly record: NodeRecord;
  readonly relativePath: string;
}

function listArtifactFiles(harnessRoot: string): string[] {
  const artifactsRoot = resolveHarnessPath(harnessRoot, "artifacts");
  if (!existsSync(artifactsRoot)) return [];
  const results: string[] = [];
  const walk = (directory: string, relativePrefix: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const relative = relativePrefix.length === 0 ? entry.name : `${relativePrefix}/${entry.name}`;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute, relative);
      } else {
        results.push(relative);
      }
    }
  };
  walk(artifactsRoot, "");
  return results;
}

/**
 * Read node artifact files under `.harness/artifacts/`. Only files whose
 * content digest is recorded by a committed manifest are eligible; among
 * those, JSON records with `record_kind: "node"` must validate against the
 * node schema, while non-node extension files (free-form narratives) are
 * ignored — they are content, not graph structure.
 */
function readNodeArtifacts(
  harnessRoot: string,
  authoritativeDigests: ReadonlySet<string>,
): { readonly nodes: NodeCandidate[]; readonly skippedArtifacts: string[] } {
  const nodes: NodeCandidate[] = [];
  const skippedArtifacts: string[] = [];
  for (const relative of listArtifactFiles(harnessRoot)) {
    const ledgerRelative = `artifacts/${relative}`;
    const content = readFileSync(resolveHarnessPath(harnessRoot, ledgerRelative), "utf8");
    if (!authoritativeDigests.has(sha256Hex(content))) {
      skippedArtifacts.push(ledgerRelative);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      // Authoritative non-JSON extension file: content, not graph structure.
      continue;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { record_kind?: unknown }).record_kind !== "node"
    ) {
      continue;
    }
    const validation = validateSchema("node", parsed);
    if (!validation.valid) {
      const detail = validation.errors
        .map((issue) => `${issue.instancePath}: ${issue.message}`)
        .join("; ");
      throw new MaterializationError(
        "invalid_artifact",
        `invalid node artifact ${ledgerRelative}: ${detail}`,
      );
    }
    nodes.push({ record: parsed as NodeRecord, relativePath: ledgerRelative });
  }
  return { nodes, skippedArtifacts };
}

/**
 * Version replacement: the highest revision of a node id wins. Two records
 * claiming the same id and revision with different digests are a revision
 * fork and block materialization instead of being silently projected.
 */
function resolveCurrentNodes(candidates: readonly NodeCandidate[]): NodeRecord[] {
  const byId = new Map<string, NodeRecord>();
  for (const candidate of candidates) {
    const record = candidate.record;
    const current = byId.get(record.id);
    if (current === undefined || record.revision > current.revision) {
      byId.set(record.id, record);
      continue;
    }
    if (record.revision === current.revision && record.digest !== current.digest) {
      throw new MaterializationError(
        "revision_fork",
        `node ${record.id} has conflicting revision ${record.revision} records (${candidate.relativePath})`,
      );
    }
  }
  return [...byId.values()].sort((left, right) => (left.id < right.id ? -1 : 1));
}

function insertOperations(database: DatabaseSync, operations: readonly CommittedOperation[]): void {
  const statement = database.prepare(
    "INSERT INTO operations (ledger_operation_id, sequence, workflow_operation_id, attempt_id, baseline_commit, digest) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const operation of operations) {
    const manifest = operation.manifest;
    statement.run(
      manifest.ledger_operation_id,
      manifest.sequence,
      manifest.workflow_operation_id,
      manifest.attempt_id,
      manifest.baseline_commit,
      manifest.digest,
    );
  }
}

function insertNodes(database: DatabaseSync, nodes: readonly NodeRecord[]): void {
  const statement = database.prepare(
    "INSERT INTO nodes (id, type, revision, status, source, confidence, digest, locator, iteration_id, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const node of nodes) {
    statement.run(
      node.id,
      node.type,
      node.revision,
      node.status,
      node.source,
      node.confidence,
      node.digest,
      node.locator ?? null,
      node.provenance.iteration_id,
      JSON.stringify(node),
    );
  }
}

function insertEdges(database: DatabaseSync, edges: readonly EdgeRecord[]): void {
  const statement = database.prepare(
    "INSERT INTO edges (id, type, source_id, target_id, status, confidence, digest, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET type = excluded.type, source_id = excluded.source_id, target_id = excluded.target_id, status = excluded.status, confidence = excluded.confidence, digest = excluded.digest, record = excluded.record",
  );
  // Replay order is manifest sequence order, so a later operation revising an
  // edge (for example proposed -> accepted) deterministically replaces the
  // earlier projection; an identical record is an idempotent no-op.
  for (const edge of edges) {
    statement.run(
      edge.id,
      edge.type,
      edge.source_id,
      edge.target_id,
      edge.status,
      edge.confidence,
      edge.digest,
      JSON.stringify(edge),
    );
  }
}

function insertEvents(
  database: DatabaseSync,
  events: readonly LifecycleEvent[],
  sequenceByOperationId: ReadonlyMap<string, number>,
): void {
  const statement = database.prepare(
    "INSERT INTO events (event_id, event_type, project_id, iteration_id, workflow_operation_id, ledger_operation_id, operation_sequence, sequence, timestamp, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const seen = new Map<string, string>();
  for (const event of events) {
    const serialized = JSON.stringify(event);
    const previous = seen.get(event.event_id);
    if (previous !== undefined) {
      if (previous === serialized) continue; // Idempotent replay of the same record.
      throw new MaterializationError(
        "conflicting_event",
        `event ${event.event_id} appears twice with different content`,
      );
    }
    seen.set(event.event_id, serialized);
    const operationSequence = sequenceByOperationId.get(event.ledger_operation_id);
    if (operationSequence === undefined) {
      throw new MaterializationError(
        "conflicting_event",
        `event ${event.event_id} references unknown ledger operation ${event.ledger_operation_id}`,
      );
    }
    statement.run(
      event.event_id,
      event.event_type,
      event.project_id,
      event.iteration_id,
      event.workflow_operation_id,
      event.ledger_operation_id,
      operationSequence,
      event.sequence,
      event.timestamp,
      serialized,
    );
  }
}

/**
 * Deterministic digest over the logical projected state. Rebuilding the cache
 * from the same ledger must reproduce this digest exactly, which is the
 * machine-checkable proof that SQLite holds no exclusive authoritative state.
 */
function computeProjectionDigest(
  nodes: readonly { id: string; revision: number; digest: string }[],
  edges: readonly { id: string; digest: string }[],
  eventIds: readonly string[],
): string {
  const edgeEntries: [string, string][] = edges.map((edge) => [edge.id, edge.digest]);
  edgeEntries.sort(([left], [right]) => (left < right ? -1 : 1));
  return contentDigest({
    nodes: nodes.map((node): [string, number, string] => [node.id, node.revision, node.digest]),
    edges: edgeEntries,
    events: [...eventIds].sort(),
  });
}

/**
 * Recompute the projection digest from the current table contents and compare
 * it with the digest recorded in meta. Returns false on any inconsistency —
 * including a missing digest or unreadable tables — so callers treat the
 * cache as unrecoverable and rebuild instead of trusting it. Never throws.
 */
export function verifyProjectionDigest(database: DatabaseSync): boolean {
  try {
    const recorded = readMeta(database, META_KEYS.projectionDigest);
    if (recorded === undefined) return false;
    const nodeRows = database
      .prepare("SELECT id, revision, digest FROM nodes")
      .all() as unknown as {
      id: string;
      revision: number;
      digest: string;
    }[];
    const edgeRows = database.prepare("SELECT id, digest FROM edges").all() as unknown as {
      id: string;
      digest: string;
    }[];
    const eventRows = database.prepare("SELECT event_id FROM events").all() as unknown as {
      event_id: string;
    }[];
    return (
      computeProjectionDigest(
        nodeRows,
        edgeRows,
        eventRows.map((row) => row.event_id),
      ) === recorded
    );
  } catch {
    return false;
  }
}

/**
 * Rebuild the SQLite projection from scratch. Any previous cache content is
 * replaced wholesale inside one transaction, so readers never observe a
 * half-materialized view.
 */
export function materializeLedger(options: MaterializeOptions): Materialization {
  const harnessRoot = harnessRootFor(options.projectRoot);
  const operations = readCommittedOperations(harnessRoot);
  const authoritativeDigests = new Set(
    operations.flatMap((operation) => operation.manifest.artifact_digests),
  );
  const { nodes: candidates, skippedArtifacts } = readNodeArtifacts(
    harnessRoot,
    authoritativeDigests,
  );
  const replay = replayLedger(harnessRoot);
  const nodes = resolveCurrentNodes(candidates);
  // Integrity gate: a ledger whose committed records violate graph invariants
  // (dangling edges, incompatible relations, non-monotonic revisions or
  // dependency cycles) is never projected into query results. Revision forks
  // are still reported first by resolveCurrentNodes with their own typed error.
  assertGraphIntegrity(
    candidates.map((candidate) => candidate.record),
    replay.edges,
  );
  const sequenceByOperationId = new Map(
    operations.map((operation) => [
      operation.manifest.ledger_operation_id,
      operation.manifest.sequence,
    ]),
  );
  const lastSequence = operations.reduce(
    (maximum, operation) => Math.max(maximum, operation.manifest.sequence),
    0,
  );

  const database = openGraphDatabase(options.databasePath);
  try {
    database.exec("BEGIN");
    clearProjection(database);
    insertOperations(database, operations);
    insertNodes(database, nodes);
    insertEdges(database, replay.edges);
    insertEvents(database, replay.events, sequenceByOperationId);

    const edgeRows = database.prepare("SELECT id, digest FROM edges").all() as unknown as {
      id: string;
      digest: string;
    }[];
    const eventRows = database.prepare("SELECT event_id FROM events").all() as unknown as {
      event_id: string;
    }[];
    const projectionDigest = computeProjectionDigest(
      nodes,
      edgeRows,
      eventRows.map((row) => row.event_id),
    );
    const report: MaterializationReport = {
      operationCount: operations.length,
      nodeCount: nodes.length,
      edgeCount: edgeRows.length,
      eventCount: eventRows.length,
      lastSequence,
      skippedArtifacts,
      projectionDigest,
    };
    writeMeta(database, META_KEYS.protocolVersion, PROTOCOL_VERSION);
    writeMeta(database, META_KEYS.lastSequence, String(lastSequence));
    writeMeta(database, META_KEYS.operationCount, String(report.operationCount));
    writeMeta(database, META_KEYS.nodeCount, String(report.nodeCount));
    writeMeta(database, META_KEYS.edgeCount, String(report.edgeCount));
    writeMeta(database, META_KEYS.eventCount, String(report.eventCount));
    writeMeta(database, META_KEYS.projectionDigest, projectionDigest);
    database.exec("COMMIT");
    return { database, report };
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } finally {
      database.close();
    }
    throw error;
  }
}
