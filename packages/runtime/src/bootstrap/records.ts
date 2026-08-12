import {
  PROTOCOL_VERSION,
  canonicalizeJson,
  canonicalizeLocator,
  contentDigest,
  scannedNodeId,
  uuidv5,
  type EdgeRecord,
  type LifecycleEvent,
  type NodeRecord,
  type ScannedNodeIdentity,
} from "@universal-harness-internal/core";

/**
 * Canonical record builders for bootstrap baselines. Scanned identities come
 * from core (`scannedNodeId`), so the same repository and configuration always
 * produce the same repository-qualified node IDs; edge IDs derive the same
 * way from their relation type and endpoints. Record digests follow the
 * established convention: SHA-256 over the canonical record without its
 * `digest` field.
 */
const UUID_URL_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
const EDGE_NAMESPACE_NAME = "universal-harness/edge/v1";
const FIELD_SEPARATOR = "\u001f";

export interface RecordContext {
  readonly projectId: string;
  readonly repositoryId: string;
  readonly iterationId: string;
  readonly actor: string;
  readonly timestamp: string;
}

/** Deterministic edge identity: UUIDv5 over relation type and endpoints. */
export function scannedEdgeId(
  projectId: string,
  repositoryId: string,
  type: EdgeRecord["type"],
  sourceId: string,
  targetId: string,
): string {
  const namespace = uuidv5(uuidv5(UUID_URL_NAMESPACE, EDGE_NAMESPACE_NAME), projectId);
  const name = [repositoryId, type, sourceId, targetId].join(FIELD_SEPARATOR);
  return `edge_${uuidv5(namespace, name)}`;
}

export function scannedNodeRecord(
  context: RecordContext,
  spec: {
    readonly type: ScannedNodeIdentity["type"];
    readonly locator: string;
    readonly extensions?: Record<string, unknown>;
  },
): NodeRecord {
  const id = scannedNodeId({
    project_id: context.projectId,
    repository_id: context.repositoryId,
    type: spec.type,
    locator: spec.locator,
  });
  const record: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "node",
    id,
    type: spec.type,
    revision: 1,
    status: "accepted",
    source: "scanner",
    provenance: {
      iteration_id: context.iterationId,
      actor: context.actor,
      timestamp: context.timestamp,
    },
    confidence: 1,
    locator: canonicalizeLocator(spec.locator),
    ...(spec.extensions === undefined ? {} : { extensions: spec.extensions }),
  };
  return { ...record, digest: contentDigest(record) } as unknown as NodeRecord;
}

export function iterationNodeRecord(
  context: RecordContext,
  spec: {
    readonly iterationId: string;
    readonly intent: string;
  },
): NodeRecord {
  const record: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "node",
    id: spec.iterationId,
    type: "Iteration",
    revision: 1,
    status: "accepted",
    source: "workflow",
    provenance: {
      iteration_id: context.iterationId,
      actor: context.actor,
      timestamp: context.timestamp,
    },
    confidence: 1,
    iteration_state: "draft",
    extensions: { "harness.bootstrap": { intent: spec.intent } },
  };
  return { ...record, digest: contentDigest(record) } as unknown as NodeRecord;
}

export function edgeRecord(
  context: RecordContext,
  spec: {
    readonly type: EdgeRecord["type"];
    readonly sourceId: string;
    readonly targetId: string;
    readonly source?: EdgeRecord["source"];
  },
): EdgeRecord {
  const record: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "edge",
    id: scannedEdgeId(
      context.projectId,
      context.repositoryId,
      spec.type,
      spec.sourceId,
      spec.targetId,
    ),
    type: spec.type,
    source_id: spec.sourceId,
    target_id: spec.targetId,
    status: "accepted",
    source: spec.source ?? "scanner",
    provenance: {
      iteration_id: context.iterationId,
      actor: context.actor,
      timestamp: context.timestamp,
    },
    confidence: 1,
  };
  return { ...record, digest: contentDigest(record) } as unknown as EdgeRecord;
}

export function lifecycleEvent(
  context: RecordContext,
  spec: {
    readonly eventId: string;
    readonly eventType: LifecycleEvent["event_type"];
    readonly workflowOperationId: string;
    readonly ledgerOperationId: string;
    readonly sequence: number;
    readonly payload: Record<string, unknown>;
  },
): LifecycleEvent {
  return {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "event",
    event_id: spec.eventId,
    event_type: spec.eventType,
    project_id: context.projectId,
    iteration_id: context.iterationId,
    workflow_operation_id: spec.workflowOperationId,
    ledger_operation_id: spec.ledgerOperationId,
    sequence: spec.sequence,
    timestamp: context.timestamp,
    payload: spec.payload,
  } as LifecycleEvent;
}

const ARTIFACT_DIRECTORY_BY_TYPE: Partial<Record<NodeRecord["type"], string>> = {
  Repository: "artifacts/repositories",
  Iteration: "artifacts/iterations",
  Component: "artifacts/components",
  CodeArtifact: "artifacts/code-artifacts",
  Test: "artifacts/tests",
};

/** Ledger-relative artifact path for a bootstrap node record. */
export function artifactPathForNode(node: NodeRecord): string {
  const directory = ARTIFACT_DIRECTORY_BY_TYPE[node.type];
  if (directory === undefined) {
    throw new Error(`no artifact directory for bootstrap node type: ${node.type}`);
  }
  return `${directory}/${node.id}.json`;
}

export function artifactContentForNode(node: NodeRecord): string {
  return `${canonicalizeJson(node)}\n`;
}
