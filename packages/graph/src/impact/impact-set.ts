import {
  PROTOCOL_VERSION,
  contentDigest,
  type EdgeRecord,
  type NodeRecord,
} from "@universal-harness-internal/core";

import { isRelationCompatible } from "../integrity.js";
import {
  DEFAULT_PROPAGATION_POLICY,
  propagateImpact,
  type PropagationPolicy,
} from "./propagation.js";
import { assessImpact, type ImpactClassification, type RiskLevel } from "./scoring.js";
import { ImpactError, type ChangeSeed } from "./seeds.js";

/**
 * ImpactSet generation (design section 9, steps 4-6). The ImpactSet is a
 * Feedback node whose extension carries the canonical, metadata-free content:
 * the seeds and one classified entry per reached node, each with its shortest
 * explanation path, risk, confidence and reason. The content digest is what
 * an ApprovalRequest binds to; planning may only start from a frozen set
 * whose content still digests to the approved value.
 */
export const IMPACT_EXTENSION_KEY = "harness.impact";

export interface ImpactEntry {
  readonly node_id: string;
  readonly node_type: NodeRecord["type"];
  readonly classification: ImpactClassification;
  readonly risk: RiskLevel;
  readonly confidence: number;
  /** Edge ids of the shortest explanation path from the seed, in order. */
  readonly path: readonly string[];
  readonly reason: string;
  readonly seed_id: string;
}

/** Canonical ImpactSet content; digests identically regardless of metadata. */
export interface ImpactSetContent {
  readonly content_digest: string;
  readonly seeds: readonly ChangeSeed[];
  readonly entries: readonly ImpactEntry[];
  /** Digest of the approval decision that froze the set; absent while proposed. */
  readonly approval_digest?: string;
}

export interface ImpactSetContext {
  readonly iterationId: string;
  readonly actor: string;
  readonly timestamp: string;
}

const CLASSIFICATION_RANK: Readonly<Record<ImpactClassification, number>> = {
  "must-change": 0,
  inspect: 1,
  informational: 2,
};

function digestContent(seeds: readonly ChangeSeed[], entries: readonly ImpactEntry[]): string {
  return contentDigest({
    seeds: seeds.map((seed) => ({ ...seed })),
    entries: entries.map((entry) => ({ ...entry, path: [...entry.path] })),
  });
}

/**
 * Generate an ImpactSet node in `proposed` status. Seeds are processed in id
 * order; when several seeds reach the same node, the strongest classification
 * wins and ties keep the earlier seed's explanation, so the output is fully
 * determined by the graph records and the seed list.
 */
export function generateImpactSet(
  seeds: readonly ChangeSeed[],
  nodes: readonly NodeRecord[],
  edges: readonly EdgeRecord[],
  context: ImpactSetContext,
  policy: PropagationPolicy = DEFAULT_PROPAGATION_POLICY,
): NodeRecord {
  if (seeds.length === 0) {
    throw new ImpactError("an impact set requires at least one change seed");
  }
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const sortedSeeds = [...seeds].sort((left, right) => (left.id < right.id ? -1 : 1));
  const entryByNode = new Map<string, ImpactEntry>();
  for (const seed of sortedSeeds) {
    for (const reach of propagateImpact(seed.nodeId, nodes, edges, policy)) {
      const node = nodeById.get(reach.nodeId) as NodeRecord;
      const assessment = assessImpact(seed, reach.path);
      const candidate: ImpactEntry = {
        node_id: node.id,
        node_type: node.type,
        classification: assessment.classification,
        risk: assessment.risk,
        confidence: assessment.confidence,
        path: reach.path.map((step) => step.edgeId),
        reason: assessment.reason,
        seed_id: seed.id,
      };
      const existing = entryByNode.get(node.id);
      if (
        existing === undefined ||
        CLASSIFICATION_RANK[candidate.classification] < CLASSIFICATION_RANK[existing.classification]
      ) {
        entryByNode.set(node.id, candidate);
      }
    }
  }
  const entries = [...entryByNode.values()].sort((left, right) =>
    left.node_id < right.node_id ? -1 : 1,
  );
  const content: ImpactSetContent = {
    content_digest: digestContent(sortedSeeds, entries),
    seeds: sortedSeeds,
    entries,
  };
  const record: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "node",
    id: `impactset_${content.content_digest.slice(0, 16)}`,
    type: "ImpactSet",
    revision: 1,
    status: "proposed",
    source: "workflow",
    provenance: {
      iteration_id: context.iterationId,
      actor: context.actor,
      timestamp: context.timestamp,
    },
    confidence: 1,
    extensions: { [IMPACT_EXTENSION_KEY]: content },
  };
  return { ...record, digest: contentDigest(record) } as unknown as NodeRecord;
}

/** Read the canonical content of an ImpactSet node, or throw. */
export function readImpactSetContent(impactSet: NodeRecord): ImpactSetContent {
  if (impactSet.type !== "ImpactSet") {
    throw new ImpactError(`expected an ImpactSet node, got ${impactSet.type}`);
  }
  const content = impactSet.extensions?.[IMPACT_EXTENSION_KEY];
  if (typeof content !== "object" || content === null) {
    throw new ImpactError(`impact set ${impactSet.id} carries no ${IMPACT_EXTENSION_KEY} content`);
  }
  return content as ImpactSetContent;
}

/** Digest an ApprovalRequest binds to before an ImpactSet is frozen. */
export function impactSetContentDigest(impactSet: NodeRecord): string {
  return readImpactSetContent(impactSet).content_digest;
}

/**
 * Freeze a proposed ImpactSet after approval (design 9, step 6). The frozen
 * revision records the approving decision's digest; the seeds and entries are
 * carried over untouched, so the approved content digest still verifies.
 */
export function freezeImpactSet(impactSet: NodeRecord, approvalDigest: string): NodeRecord {
  const content = readImpactSetContent(impactSet);
  if (impactSet.status !== "proposed") {
    throw new ImpactError(`impact set ${impactSet.id} is not proposed; refusing to refreeze`);
  }
  const frozenContent: ImpactSetContent = { ...content, approval_digest: approvalDigest };
  const record: Record<string, unknown> = {
    ...impactSet,
    revision: impactSet.revision + 1,
    status: "accepted",
    extensions: { ...impactSet.extensions, [IMPACT_EXTENSION_KEY]: frozenContent },
  };
  delete record.digest;
  return { ...record, digest: contentDigest(record) } as unknown as NodeRecord;
}

/**
 * Planning guard: the set must be frozen by an approval and its content must
 * still digest to the exact value the approval bound to. Any drift (edited
 * entries, swapped seeds, missing approval) blocks planning with a typed
 * error instead of silently replanning from a stale set.
 */
export function assertApprovedImpactSet(
  impactSet: NodeRecord,
  approvedContentDigest: string,
): void {
  const content = readImpactSetContent(impactSet);
  if (impactSet.status !== "accepted" || content.approval_digest === undefined) {
    throw new ImpactError(`impact set ${impactSet.id} has not been approved and frozen`);
  }
  const actual = digestContent(content.seeds, content.entries);
  if (actual !== content.content_digest || actual !== approvedContentDigest) {
    throw new ImpactError(
      `impact set ${impactSet.id} content drifted from the approved digest ${approvedContentDigest}`,
    );
  }
}

/** A probabilistic relation suggested by a model, never by deterministic code. */
export interface SemanticSuggestion {
  readonly relation: EdgeRecord["type"];
  readonly sourceId: string;
  readonly targetId: string;
  /** Sub-1.0 confidence; a suggestion is a probability, never a fact. */
  readonly confidence: number;
  readonly reason: string;
}

export interface SuggestionContext {
  readonly id: string;
  readonly iterationId: string;
  readonly actor: string;
  readonly timestamp: string;
}

/**
 * Isolate a semantic suggestion as a proposed edge (design 8.6): status
 * `proposed`, source `agent`, the original confidence preserved and the
 * reason recorded. The relation must be compatible with the endpoint types;
 * an incompatible or overconfident suggestion is rejected, never silently
 * accepted, so a suggestion can enrich context but can never authorize a
 * route, a write or a must-change classification on its own.
 */
export function proposedEdgeFromSuggestion(
  suggestion: SemanticSuggestion,
  nodes: readonly NodeRecord[],
  context: SuggestionContext,
): EdgeRecord {
  if (suggestion.confidence <= 0 || suggestion.confidence >= 1) {
    throw new ImpactError(
      `semantic suggestion confidence must be in (0, 1), got ${suggestion.confidence}`,
    );
  }
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const source = nodeById.get(suggestion.sourceId);
  const target = nodeById.get(suggestion.targetId);
  if (source === undefined || target === undefined) {
    throw new ImpactError(
      `semantic suggestion references unknown node(s): ${
        source === undefined ? suggestion.sourceId : suggestion.targetId
      }`,
    );
  }
  if (!isRelationCompatible(suggestion.relation, source.type, target.type)) {
    throw new ImpactError(
      `semantic suggestion ${suggestion.relation} is incompatible: ${source.type} -> ${target.type}`,
    );
  }
  const record: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "edge",
    id: context.id,
    type: suggestion.relation,
    source_id: suggestion.sourceId,
    target_id: suggestion.targetId,
    status: "proposed",
    source: "agent",
    provenance: {
      iteration_id: context.iterationId,
      actor: context.actor,
      timestamp: context.timestamp,
    },
    confidence: suggestion.confidence,
    extensions: { [IMPACT_EXTENSION_KEY]: { reason: suggestion.reason } },
  };
  return { ...record, digest: contentDigest(record) } as unknown as EdgeRecord;
}
