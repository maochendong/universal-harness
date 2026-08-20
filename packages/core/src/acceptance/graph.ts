import { contentDigest } from "../identity/digest.js";
import { domainRecordId } from "../identity/record-id.js";
import { PROTOCOL_1_1_VERSION } from "../protocol.js";
import type { EdgeRecord } from "../schema/edge.js";
import type { NodeRecord } from "../schema/node.js";
import type { PrdProposalRecord } from "../schema/proposal.js";
import { PROTOCOL_VERSION } from "../version.js";
import { deriveCaptureTestSeedId } from "./test-seed.js";

/**
 * Accepted PRD graph materialization (intent-to-prd design 7.5/13.1). The
 * accepted transaction is the only place business graph nodes appear: one
 * Intent node, one node per Requirement/Constraint, and one Test seed per
 * acceptance criterion, with DECOMPOSES_TO / CONSTRAINED_BY / VERIFIES edges.
 * Node identity is deterministic; a node whose semantics are unchanged since
 * the previous acceptance is reused byte-for-byte (same id and revision),
 * while a changed semantic digest keeps the id and bumps the revision.
 */
export const ACCEPTED_PRD_EXTENSION_KEY = "harness.requirements";

const NODE_ARTIFACT_DIRECTORY: Readonly<Record<string, string>> = {
  Intent: "artifacts/intents",
  Requirement: "artifacts/requirements",
  Constraint: "artifacts/constraints",
  Test: "artifacts/tests",
};

export function acceptedNodeArtifactPath(node: NodeRecord): string {
  const directory = NODE_ARTIFACT_DIRECTORY[node.type];
  if (directory === undefined) {
    throw new AcceptanceGraphError(`no artifact directory for node type ${node.type}`);
  }
  return `${directory}/${node.id}/${String(node.revision)}.json`;
}

export class AcceptanceGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcceptanceGraphError";
  }
}

export interface AcceptanceGraphContext {
  readonly session_id: string;
  readonly iteration_id: string;
  /** The approving actor (human identity or the versioned Policy identity). */
  readonly actor: string;
  readonly timestamp: string;
  /** Latest committed node record per id, for reuse-or-bump. */
  readonly priorNodes: ReadonlyMap<string, NodeRecord>;
}

function semanticDigestOf(extensions: Record<string, unknown>): string {
  return contentDigest(extensions);
}

function nodeRecord(
  context: AcceptanceGraphContext,
  spec: {
    readonly id: string;
    readonly type: "Intent" | "Requirement" | "Constraint" | "Test";
    readonly extensions: Record<string, unknown>;
  },
): NodeRecord {
  const extensions = { [ACCEPTED_PRD_EXTENSION_KEY]: spec.extensions };
  const semantic = semanticDigestOf(extensions);
  const prior = context.priorNodes.get(spec.id);
  if (
    prior !== undefined &&
    semanticDigestOf((prior.extensions ?? {}) as Record<string, unknown>) === semantic
  ) {
    // Unchanged semantics: reuse the committed record byte-for-byte so an
    // idempotent replay or a re-acceptance never forks the node history.
    return prior;
  }
  const revision = prior === undefined ? 1 : prior.revision + 1;
  const record: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "node",
    id: spec.id,
    type: spec.type,
    revision,
    status: "accepted",
    source: "workflow",
    provenance: {
      iteration_id: context.iteration_id,
      actor: context.actor,
      timestamp: context.timestamp,
    },
    confidence: 1,
    extensions,
  };
  return { ...record, digest: contentDigest(record) } as unknown as NodeRecord;
}

function edgeRecord(
  context: AcceptanceGraphContext,
  spec: {
    readonly type: "DECOMPOSES_TO" | "CONSTRAINED_BY" | "VERIFIES";
    readonly sourceId: string;
    readonly targetId: string;
  },
): EdgeRecord {
  const record: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "edge",
    id: domainRecordId({
      domain_tag: "capture_accept_edge",
      id_prefix: "capture-edge",
      protocol_version: PROTOCOL_1_1_VERSION,
      canonical_input: { type: spec.type, source_id: spec.sourceId, target_id: spec.targetId },
    }),
    type: spec.type,
    source_id: spec.sourceId,
    target_id: spec.targetId,
    status: "accepted",
    source: "workflow",
    provenance: {
      iteration_id: context.iteration_id,
      actor: context.actor,
      timestamp: context.timestamp,
    },
    confidence: 1,
  };
  return { ...record, digest: contentDigest(record) } as unknown as EdgeRecord;
}

/** Intent node identity derives from the session intent digest. */
export function deriveCaptureIntentNodeId(sessionId: string): string {
  return domainRecordId({
    domain_tag: "capture_intent_node",
    id_prefix: "capture-intent",
    protocol_version: PROTOCOL_1_1_VERSION,
    canonical_input: { session_id: sessionId },
  });
}

export interface AcceptedPrdGraph {
  readonly nodes: readonly NodeRecord[];
  readonly edges: readonly EdgeRecord[];
}

/**
 * Build the accepted graph records for the current proposal. The returned
 * records are deterministic given (proposal content, prior nodes, timestamp);
 * ordering is canonical by id so the ledger artifacts are stable.
 */
export function buildAcceptedPrdGraph(
  context: AcceptanceGraphContext,
  proposal: PrdProposalRecord,
): AcceptedPrdGraph {
  const content = proposal.content;
  const nodes: NodeRecord[] = [];
  const edges: EdgeRecord[] = [];

  const intentNodeId = deriveCaptureIntentNodeId(context.session_id);
  nodes.push(
    nodeRecord(context, {
      id: intentNodeId,
      type: "Intent",
      extensions: { text: content.intent.text, intent_digest: content.intent.digest },
    }),
  );

  for (const requirement of content.requirements) {
    nodes.push(
      nodeRecord(context, {
        id: requirement.id,
        type: "Requirement",
        extensions: {
          statement: requirement.statement,
          priority: requirement.priority,
          change_kind: requirement.change_kind,
          acceptance_criterion_ids: requirement.acceptance_criterion_ids,
          scenario_ids: requirement.scenario_ids,
        },
      }),
    );
    edges.push(
      edgeRecord(context, {
        type: "DECOMPOSES_TO",
        sourceId: intentNodeId,
        targetId: requirement.id,
      }),
    );
  }

  for (const constraint of content.constraints) {
    nodes.push(
      nodeRecord(context, {
        id: constraint.id,
        type: "Constraint",
        extensions: {
          statement: constraint.statement,
          category: constraint.category,
          verification_intent: constraint.verification_intent,
        },
      }),
    );
    for (const requirement of content.requirements) {
      edges.push(
        edgeRecord(context, {
          type: "CONSTRAINED_BY",
          sourceId: requirement.id,
          targetId: constraint.id,
        }),
      );
    }
  }

  for (const criterion of content.acceptance_criteria) {
    const testId = deriveCaptureTestSeedId(criterion.criterion_id);
    nodes.push(
      nodeRecord(context, {
        id: testId,
        type: "Test",
        extensions: {
          acceptance_criterion_id: criterion.criterion_id,
          criterion_semantic_digest: criterion.criterion_semantic_digest,
          source_binding_digests: criterion.source_bindings
            .map((binding) => binding.source_digest)
            .sort(),
          verifies: criterion.requirement_id,
          observable_outcome: criterion.observable_outcome,
          verification_intent: criterion.verification_intent,
          test_seed: true,
        },
      }),
    );
    edges.push(
      edgeRecord(context, {
        type: "VERIFIES",
        sourceId: testId,
        targetId: criterion.requirement_id,
      }),
    );
  }

  nodes.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  edges.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return { nodes, edges };
}
