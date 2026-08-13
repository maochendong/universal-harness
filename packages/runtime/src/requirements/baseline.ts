import {
  LedgerError,
  PROTOCOL_VERSION,
  canonicalizeJson,
  contentDigest,
  ulid,
  type EdgeRecord,
  type NodeRecord,
} from "@universal-harness-internal/core";

import {
  WorkflowError,
  ledgerRepositoryFor,
  type WorkflowDependencies,
} from "../workflow/operation.js";
import type { RequirementProposal } from "./capture.js";

/**
 * Requirement baseline (design 12: "approve the requirement baseline"). The
 * baseline digest derives from the canonical requirement document only —
 * never from record metadata such as provenance timestamps — so the digest an
 * ApprovalRequest binds to is exactly the digest of the document committed
 * after approval. The committed document is the immutable versioned input
 * later impact analysis binds to.
 */
export const REQUIREMENTS_EXTENSION_KEY = "harness.requirements";

export type BaselineIdKind = "test" | "edge";

export interface BaselineContext {
  readonly projectId: string;
  readonly iterationId: string;
  readonly actor: string;
  readonly timestamp: string;
  /** Injectable id mint for Test node and edge ids; deterministic in tests. */
  readonly newId: (kind: BaselineIdKind) => string;
}

/** Canonical, metadata-free content of one requirement baseline. */
export function baselineDocument(proposal: RequirementProposal): Record<string, unknown> {
  return {
    intent: { id: proposal.intent.id, text: proposal.intent.text },
    requirements: proposal.requirements.map((requirement) => ({
      id: requirement.id,
      statement: requirement.statement,
      acceptance: requirement.acceptance.map((criterion) => ({ ...criterion })),
    })),
    constraints: proposal.constraints.map((constraint) => ({ ...constraint })),
  };
}

/** Digest an ApprovalRequest binds to; identical before and after approval. */
export function requirementBaselineDigest(proposal: RequirementProposal): string {
  return contentDigest(baselineDocument(proposal));
}

function nodeRecord(
  context: BaselineContext,
  spec: {
    readonly id: string;
    readonly type: "Intent" | "Requirement" | "Constraint" | "Test";
    readonly extensions: Record<string, unknown>;
  },
): NodeRecord {
  const record: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "node",
    id: spec.id,
    type: spec.type,
    revision: 1,
    status: "accepted",
    source: "human",
    provenance: {
      iteration_id: context.iterationId,
      actor: context.actor,
      timestamp: context.timestamp,
    },
    confidence: 1,
    extensions: { [REQUIREMENTS_EXTENSION_KEY]: spec.extensions },
  };
  return { ...record, digest: contentDigest(record) } as unknown as NodeRecord;
}

function edgeRecord(
  context: BaselineContext,
  spec: {
    readonly type: "DECOMPOSES_TO" | "CONSTRAINED_BY" | "VERIFIES";
    readonly sourceId: string;
    readonly targetId: string;
  },
): EdgeRecord {
  const record: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "edge",
    id: context.newId("edge"),
    type: spec.type,
    source_id: spec.sourceId,
    target_id: spec.targetId,
    status: "accepted",
    source: "human",
    provenance: {
      iteration_id: context.iterationId,
      actor: context.actor,
      timestamp: context.timestamp,
    },
    confidence: 1,
  };
  return { ...record, digest: contentDigest(record) } as unknown as EdgeRecord;
}

export interface BaselineRecords {
  readonly nodes: readonly NodeRecord[];
  readonly edges: readonly EdgeRecord[];
}

/**
 * Materialize a captured proposal as accepted nodes and traceability edges:
 * Intent DECOMPOSES_TO each Requirement, each Requirement CONSTRAINED_BY each
 * Constraint, and one acceptance Test VERIFIES its Requirement or Constraint.
 */
export function buildBaselineRecords(
  context: BaselineContext,
  proposal: RequirementProposal,
): BaselineRecords {
  const nodes: NodeRecord[] = [
    nodeRecord(context, {
      id: proposal.intent.id,
      type: "Intent",
      extensions: { text: proposal.intent.text },
    }),
  ];
  const edges: EdgeRecord[] = [];
  for (const requirement of proposal.requirements) {
    nodes.push(
      nodeRecord(context, {
        id: requirement.id,
        type: "Requirement",
        extensions: {
          statement: requirement.statement,
          acceptance: requirement.acceptance.map((criterion) => ({ ...criterion })),
        },
      }),
    );
    edges.push(
      edgeRecord(context, {
        type: "DECOMPOSES_TO",
        sourceId: proposal.intent.id,
        targetId: requirement.id,
      }),
    );
    for (const constraint of proposal.constraints) {
      edges.push(
        edgeRecord(context, {
          type: "CONSTRAINED_BY",
          sourceId: requirement.id,
          targetId: constraint.id,
        }),
      );
    }
    for (const criterion of requirement.acceptance) {
      const testId = context.newId("test");
      nodes.push(
        nodeRecord(context, {
          id: testId,
          type: "Test",
          extensions: { ...criterion, verifies: requirement.id },
        }),
      );
      edges.push(
        edgeRecord(context, { type: "VERIFIES", sourceId: testId, targetId: requirement.id }),
      );
    }
  }
  for (const constraint of proposal.constraints) {
    nodes.push(
      nodeRecord(context, {
        id: constraint.id,
        type: "Constraint",
        extensions: { statement: constraint.statement, verification: constraint.verification },
      }),
    );
    const testId = context.newId("test");
    nodes.push(
      nodeRecord(context, {
        id: testId,
        type: "Test",
        extensions: {
          description: constraint.statement,
          verification: constraint.verification,
          verifies: constraint.id,
        },
      }),
    );
    edges.push(
      edgeRecord(context, { type: "VERIFIES", sourceId: testId, targetId: constraint.id }),
    );
  }
  return { nodes, edges };
}

const BASELINE_ARTIFACT_DIRECTORY: Readonly<Record<string, string>> = {
  Intent: "artifacts/intents",
  Requirement: "artifacts/requirements",
  Constraint: "artifacts/constraints",
  Test: "artifacts/tests",
};

/** Ledger-relative artifact path for a requirement baseline node record. */
export function baselineNodeArtifactPath(node: NodeRecord): string {
  const directory = BASELINE_ARTIFACT_DIRECTORY[node.type];
  if (directory === undefined) {
    throw new WorkflowError("ledger_failure", `no baseline artifact directory for ${node.type}`);
  }
  return `${directory}/${node.id}.json`;
}

export function baselineDocumentArtifactPath(digest: string): string {
  return `artifacts/requirement-baselines/${digest}.json`;
}

export interface CommittedRequirementBaseline {
  readonly digest: string;
  readonly documentPath: string;
  readonly nodeIds: readonly string[];
  readonly ledgerOperationId: string;
}

export interface BaselineCommitBinding {
  readonly workflowOperationId: string;
  readonly attemptId: string;
  /** Digest of the approval decision authorizing this baseline commit. */
  readonly approvalDigest: string;
}

/**
 * Atomically commit an approved requirement baseline: node artifacts, the
 * traceability edges and the canonical baseline document land in one ledger
 * operation. Refuses to commit when the proposal no longer matches the
 * digest the approval bound to.
 */
export async function commitRequirementBaseline(
  deps: WorkflowDependencies,
  context: BaselineContext,
  proposal: RequirementProposal,
  binding: BaselineCommitBinding,
): Promise<CommittedRequirementBaseline> {
  const digest = requirementBaselineDigest(proposal);
  const records = buildBaselineRecords(context, proposal);
  const document = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "requirement_baseline",
    digest,
    approval_digest: binding.approvalDigest,
    ...baselineDocument(proposal),
  };
  const artifacts = [
    ...records.nodes.map((node) => ({
      path: baselineNodeArtifactPath(node),
      content: `${canonicalizeJson(node)}\n`,
    })),
    {
      path: baselineDocumentArtifactPath(digest),
      content: `${canonicalizeJson(document)}\n`,
    },
  ];
  const ledgerOperationId = deps.newId?.("ledger") ?? `ledger_${ulid()}`;
  try {
    await ledgerRepositoryFor(deps).commit({
      ledger_operation_id: ledgerOperationId,
      workflow_operation_id: binding.workflowOperationId,
      attempt_id: binding.attemptId,
      expected_baseline: deps.readBaseline(),
      artifacts,
      edges: records.edges,
      events: [],
    });
  } catch (error) {
    if (error instanceof LedgerError) {
      throw new WorkflowError("ledger_failure", error.message);
    }
    throw error;
  }
  return {
    digest,
    documentPath: baselineDocumentArtifactPath(digest),
    nodeIds: records.nodes.map((node) => node.id),
    ledgerOperationId,
  };
}
