import {
  PROTOCOL_VERSION,
  contentDigest,
  type EdgeRecord,
  type NodeRecord,
} from "@universal-harness-internal/core";
import {
  freezeImpactSet,
  generateImpactSet,
  impactSetContentDigest,
  readImpactSetContent,
  seedFromRescan,
} from "@universal-harness-internal/graph";

import type { PlannerConstraints } from "../../src/planning/validator.js";

/**
 * Deterministic planning scenario. A feature seed on requirement_01 reaches
 * decision_01 (inverse ADDRESSES), component_01 (SHAPES), code_01 (inverse
 * REALIZES) and test_01 (VERIFIES); every reached node is must-change because
 * a feature carries medium base risk. Fixed ids keep every plan digest stable.
 */
export const FIXED_NOW = "2026-08-12T00:00:00.000Z";
export const APPROVAL_DIGEST = "f".repeat(64);

export const PLAN_CONTEXT = {
  iterationId: "iteration_01",
  actor: "plan-test",
  timestamp: FIXED_NOW,
} as const;

function makeNode(id: string, type: NodeRecord["type"]): NodeRecord {
  const record: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "node",
    id,
    type,
    revision: 1,
    status: "accepted",
    source: "human",
    provenance: {
      iteration_id: PLAN_CONTEXT.iterationId,
      actor: PLAN_CONTEXT.actor,
      timestamp: FIXED_NOW,
    },
    confidence: 1,
  };
  return { ...record, digest: contentDigest(record) } as unknown as NodeRecord;
}

function makeEdge(
  id: string,
  type: EdgeRecord["type"],
  sourceId: string,
  targetId: string,
): EdgeRecord {
  const record: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "edge",
    id,
    type,
    source_id: sourceId,
    target_id: targetId,
    status: "accepted",
    source: "human",
    provenance: {
      iteration_id: PLAN_CONTEXT.iterationId,
      actor: PLAN_CONTEXT.actor,
      timestamp: FIXED_NOW,
    },
    confidence: 1,
  };
  return { ...record, digest: contentDigest(record) } as unknown as EdgeRecord;
}

export const PLAN_NODES: readonly NodeRecord[] = [
  makeNode("intent_01", "Intent"),
  makeNode("requirement_01", "Requirement"),
  makeNode("decision_01", "Decision"),
  makeNode("component_01", "Component"),
  makeNode("code_01", "CodeArtifact"),
  makeNode("test_01", "Test"),
];

export const PLAN_EDGES: readonly EdgeRecord[] = [
  makeEdge("edge-intent-decomposes-requirement", "DECOMPOSES_TO", "intent_01", "requirement_01"),
  makeEdge("edge-decision-addresses-requirement", "ADDRESSES", "decision_01", "requirement_01"),
  makeEdge("edge-decision-shapes-component", "SHAPES", "decision_01", "component_01"),
  makeEdge("edge-code-realizes-component", "REALIZES", "code_01", "component_01"),
  makeEdge("edge-test-verifies-requirement", "VERIFIES", "test_01", "requirement_01"),
];

export interface ApprovedImpactSet {
  readonly proposed: NodeRecord;
  readonly impactSet: NodeRecord;
  readonly approvedDigest: string;
}

/** Generate and freeze the scenario ImpactSet exactly as an approval would. */
export function approvedImpactSet(): ApprovedImpactSet {
  const seed = seedFromRescan(
    {
      nodeId: "requirement_01",
      previous: { locator: "repo://repository_01/requirement_01", digest: "0".repeat(64) },
      next: { locator: "repo://repository_01/requirement_01", digest: "1".repeat(64) },
    },
    "feature",
  );
  if (seed === undefined) throw new Error("expected a content-change seed");
  const proposed = generateImpactSet([seed], PLAN_NODES, PLAN_EDGES, PLAN_CONTEXT);
  const approvedDigest = impactSetContentDigest(proposed);
  return { proposed, impactSet: freezeImpactSet(proposed, APPROVAL_DIGEST), approvedDigest };
}

/** Explanation path of one approved ImpactSet entry, by node id. */
export function entryPath(impactSet: NodeRecord, nodeId: string): readonly string[] {
  const entry = readImpactSetContent(impactSet).entries.find((item) => item.node_id === nodeId);
  if (entry === undefined) throw new Error(`no impact entry for ${nodeId}`);
  return entry.path;
}

/** Node ids classified must-change in the approved ImpactSet. */
export function mustChangeNodeIds(impactSet: NodeRecord): readonly string[] {
  return readImpactSetContent(impactSet)
    .entries.filter((entry) => entry.classification === "must-change")
    .map((entry) => entry.node_id);
}

export const PLAN_CONSTRAINTS: PlannerConstraints = {
  allowedCapabilities: ["fs.read", "fs.write", "test.run"],
  knownTools: ["tool:fs", "tool:test-runner"],
  knownGates: ["gate:build", "gate:test"],
};

export const SHARED_CONTEXT = {
  goal: "ship the health endpoint",
  requirement_baseline_digest: "a".repeat(64),
  policy_digest: "b".repeat(64),
} as const;
