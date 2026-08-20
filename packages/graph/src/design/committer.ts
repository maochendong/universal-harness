import {
  contentDigest,
  domainRecordId,
  sha256Hex,
  PROTOCOL_1_1_VERSION,
  PROTOCOL_VERSION,
  type DesignSetContent,
  type EdgeRecord,
  type NodeRecord,
} from "@universal-harness-internal/core";
import { canonicalizeDesignSetContent } from "@universal-harness-internal/core";

/**
 * The DesignCommitter (designset lifecycle design 6.7, 7.6 and 12, plan
 * T12): from approved proposal content it deterministically derives the
 * accepted DesignSet node, every asset revision and all edges. The semantic
 * ADDRESSES / SHAPES / SPECIFIES edges come from the approved edge changes;
 * the DERIVES_FROM and CONTAINS structure edges are generated here and could
 * never be proposed by a model. The same approved content always derives the
 * same records, so the approval digest binds exactly what lands in the
 * graph, and a crash between approval and commit replays identically.
 */
export class DesignCommitError extends Error {
  readonly kind = "design_commit_error" as const;

  constructor(message: string) {
    super(message);
    this.name = "DesignCommitError";
  }
}

export interface DesignCommitContext {
  readonly projectId: string;
  readonly iterationId: string;
  readonly actor: string;
  readonly timestamp: string;
}

/** The stable per-iteration DesignSet identity (design 7.7). */
export function designSetIdFor(projectId: string, iterationId: string): string {
  return domainRecordId({
    domain_tag: "design_set",
    id_prefix: "design-set",
    protocol_version: PROTOCOL_1_1_VERSION,
    canonical_input: { project_id: projectId, iteration_id: iterationId },
  });
}

export interface DesignSetAssetBinding {
  readonly node_id: string;
  readonly revision: number;
  readonly digest: string;
}

export interface DesignSetEdgeBinding {
  readonly edge_id: string;
  readonly digest: string;
}

/** The harness.design.set extension of an accepted DesignSet node. */
export interface DesignSetExtension {
  readonly content: DesignSetContent;
  readonly content_digest: string;
  readonly approval_digest: string;
  readonly bindings: {
    readonly nodes: readonly DesignSetAssetBinding[];
    readonly edges: readonly DesignSetEdgeBinding[];
  };
}

export const DESIGN_SET_EXTENSION_KEY = "harness.design.set" as const;

/** Read the design set extension of an accepted DesignSet node, or throw. */
export function readDesignSetExtension(designSet: NodeRecord): DesignSetExtension {
  if (designSet.type !== "DesignSet") {
    throw new DesignCommitError(`expected a DesignSet node, got ${designSet.type}`);
  }
  const extension = designSet.extensions?.[DESIGN_SET_EXTENSION_KEY];
  if (typeof extension !== "object" || extension === null) {
    throw new DesignCommitError(
      `design set ${designSet.id} carries no ${DESIGN_SET_EXTENSION_KEY} extension`,
    );
  }
  return extension as DesignSetExtension;
}

export interface AcceptedDesignSetRecords {
  readonly designSet: NodeRecord;
  readonly assets: readonly NodeRecord[];
  readonly edges: readonly EdgeRecord[];
}

function structureEdgeId(relation: string, sourceId: string, targetId: string): string {
  return `edge_${sha256Hex(`${relation}:${sourceId}:${targetId}`).slice(0, 16)}`;
}

export function buildAcceptedDesignSetRecords(input: {
  readonly content: DesignSetContent;
  readonly approvalDigest: string;
  readonly revision: number;
  readonly baseEdges: readonly EdgeRecord[];
  readonly context: DesignCommitContext;
}): AcceptedDesignSetRecords {
  const { context } = input;
  const content = canonicalizeDesignSetContent(input.content);
  const content_digest = contentDigest(content);
  const designSetId = designSetIdFor(context.projectId, context.iterationId);
  const provenance = {
    iteration_id: context.iterationId,
    actor: context.actor,
    timestamp: context.timestamp,
  };

  const assets: NodeRecord[] = content.node_changes.map((change) => {
    const record: Record<string, unknown> = {
      protocol_version: PROTOCOL_VERSION,
      record_kind: "node",
      id: change.node_id,
      type: change.node_type,
      revision: change.target_revision,
      status: "accepted",
      source: "workflow",
      provenance,
      confidence: 1,
      extensions: change.proposed_extensions,
      ...(change.locator === undefined ? {} : { locator: change.locator }),
    };
    return { ...record, digest: contentDigest(record) } as unknown as NodeRecord;
  });

  const baseById = new Map(input.baseEdges.map((edge) => [edge.id, edge]));
  const edges: EdgeRecord[] = [];
  for (const change of content.edge_changes) {
    if (change.action === "create") {
      const record: Record<string, unknown> = {
        protocol_version: PROTOCOL_VERSION,
        record_kind: "edge",
        id: change.edge_id,
        type: change.relation,
        source_id: change.source_id,
        target_id: change.target_id,
        status: "accepted",
        source: "workflow",
        provenance,
        confidence: 1,
      };
      edges.push({ ...record, digest: contentDigest(record) } as unknown as EdgeRecord);
      continue;
    }
    // supersede: retire the base edge by appending its superseded copy; a
    // replacement arrives as its own create change (design 7.5).
    const base = baseById.get(change.edge_id);
    if (base === undefined || base.digest !== change.base_digest) {
      throw new DesignCommitError(
        `supersede of edge ${change.edge_id} does not pin the current edge digest`,
      );
    }
    const retired: Record<string, unknown> = {
      protocol_version: PROTOCOL_VERSION,
      record_kind: "edge",
      id: base.id,
      type: base.type,
      source_id: base.source_id,
      target_id: base.target_id,
      status: "superseded",
      source: base.source,
      provenance: base.provenance,
      confidence: base.confidence,
    };
    edges.push({ ...retired, digest: contentDigest(retired) } as unknown as EdgeRecord);
  }

  const memberIds = [
    ...content.node_changes.map((change) => change.node_id),
    ...content.reused_assets.map((asset) => asset.node_id),
  ].sort();
  const structureEdges: EdgeRecord[] = [
    {
      relation: "DERIVES_FROM",
      sourceId: designSetId,
      targetId: content.impact_set_id,
    },
    ...memberIds.map((memberId) => ({
      relation: "CONTAINS",
      sourceId: designSetId,
      targetId: memberId,
    })),
  ].map((spec) => {
    const record: Record<string, unknown> = {
      protocol_version: PROTOCOL_VERSION,
      record_kind: "edge",
      id: structureEdgeId(spec.relation, spec.sourceId, spec.targetId),
      type: spec.relation,
      source_id: spec.sourceId,
      target_id: spec.targetId,
      status: "accepted",
      source: "workflow",
      provenance,
      confidence: 1,
    };
    return { ...record, digest: contentDigest(record) } as unknown as EdgeRecord;
  });
  edges.push(...structureEdges);

  const reusedBindings: DesignSetAssetBinding[] = content.reused_assets.map((asset) => ({
    node_id: asset.node_id,
    revision: asset.revision,
    digest: asset.digest,
  }));
  const extension: DesignSetExtension = {
    content,
    content_digest,
    approval_digest: input.approvalDigest,
    bindings: {
      nodes: [
        ...assets.map((asset) => ({
          node_id: asset.id,
          revision: asset.revision,
          digest: asset.digest,
        })),
        ...reusedBindings,
      ].sort((left, right) => (left.node_id < right.node_id ? -1 : 1)),
      edges: edges
        .map((edge) => ({ edge_id: edge.id, digest: edge.digest }))
        .sort((left, right) => (left.edge_id < right.edge_id ? -1 : 1)),
    },
  };
  const designSetRecord: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "node",
    id: designSetId,
    type: "DesignSet",
    revision: input.revision,
    status: "accepted",
    source: "workflow",
    provenance,
    confidence: 1,
    extensions: { [DESIGN_SET_EXTENSION_KEY]: extension },
  };
  const designSet = {
    ...designSetRecord,
    digest: contentDigest(designSetRecord),
  } as unknown as NodeRecord;

  return { designSet, assets, edges };
}
