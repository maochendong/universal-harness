import type { EdgeRecord, NodeRecord } from "@universal-harness-internal/core";

import { FIXED_NOW, makeEdge, makeNode } from "../fixtures.js";

/**
 * Deterministic impact scenario. The graph has a connected cluster around
 * requirement_01, an isolated component_02/code_02 pair that must never be
 * classified, one agent-inferred proposed edge, and the code_03 rename of
 * code_01 linked by SUPERSEDES. Fixed ids keep every ImpactSet digest stable.
 */
export const IMPACT_CONTEXT = {
  iterationId: "iteration_01",
  actor: "impact-test",
  timestamp: FIXED_NOW,
} as const;

export const IMPACT_NODES: readonly NodeRecord[] = [
  makeNode({ id: "intent_01", type: "Intent" }),
  makeNode({ id: "requirement_01", type: "Requirement" }),
  makeNode({ id: "constraint_01", type: "Constraint" }),
  makeNode({
    id: "policy_01",
    type: "Policy",
    extensions: { "harness.test": { note: "stands in for policy_fields" } },
  }),
  makeNode({ id: "decision_01", type: "Decision" }),
  makeNode({ id: "decision_02", type: "Decision" }),
  makeNode({ id: "component_01", type: "Component" }),
  makeNode({ id: "component_02", type: "Component" }),
  makeNode({
    id: "code_01",
    type: "CodeArtifact",
    source: "scanner",
    locator: "repo://repository_01/src/widget.ts",
  }),
  makeNode({
    id: "code_02",
    type: "CodeArtifact",
    source: "scanner",
    locator: "repo://repository_01/src/unrelated.ts",
  }),
  makeNode({
    id: "code_03",
    type: "CodeArtifact",
    source: "scanner",
    locator: "repo://repository_01/src/renamed-widget.ts",
  }),
  makeNode({ id: "test_01", type: "Test" }),
  makeNode({ id: "task_01", type: "Task" }),
  makeNode({ id: "task_02", type: "Task" }),
  makeNode({ id: "evidence_01", type: "Evidence", source: "gate" }),
  makeNode({ id: "finding_01", type: "Finding", source: "evaluation" }),
  makeNode({ id: "rca_01", type: "RootCauseAnalysis" }),
  makeNode({ id: "improvement_01", type: "ImprovementCandidate", source: "agent" }),
  makeNode({ id: "tool_01", type: "ToolDefinition" }),
];

/** Agent-inferred relation: proposed, original confidence 0.5. */
export const INFERRED_EDGE_ID = "edge-decision2-addresses-requirement";

export const IMPACT_EDGES: readonly EdgeRecord[] = [
  makeEdge({
    id: "edge-intent-decomposes-requirement",
    type: "DECOMPOSES_TO",
    sourceId: "intent_01",
    targetId: "requirement_01",
  }),
  makeEdge({
    id: "edge-decision-addresses-requirement",
    type: "ADDRESSES",
    sourceId: "decision_01",
    targetId: "requirement_01",
  }),
  makeEdge({
    id: INFERRED_EDGE_ID,
    type: "ADDRESSES",
    sourceId: "decision_02",
    targetId: "requirement_01",
    status: "proposed",
    source: "agent",
    confidence: 0.5,
  }),
  makeEdge({
    id: "edge-decision-shapes-component",
    type: "SHAPES",
    sourceId: "decision_01",
    targetId: "component_01",
  }),
  makeEdge({
    id: "edge-code-realizes-component",
    type: "REALIZES",
    sourceId: "code_01",
    targetId: "component_01",
  }),
  makeEdge({
    id: "edge-code2-realizes-component2",
    type: "REALIZES",
    sourceId: "code_02",
    targetId: "component_02",
  }),
  makeEdge({
    id: "edge-test-verifies-requirement",
    type: "VERIFIES",
    sourceId: "test_01",
    targetId: "requirement_01",
  }),
  makeEdge({
    id: "edge-requirement-constrained-by",
    type: "CONSTRAINED_BY",
    sourceId: "requirement_01",
    targetId: "constraint_01",
  }),
  makeEdge({
    id: "edge-requirement-governed-by",
    type: "GOVERNED_BY",
    sourceId: "requirement_01",
    targetId: "policy_01",
  }),
  makeEdge({
    id: "edge-task1-implements-requirement",
    type: "IMPLEMENTS",
    sourceId: "task_01",
    targetId: "requirement_01",
  }),
  makeEdge({
    id: "edge-task2-implements-decision",
    type: "IMPLEMENTS",
    sourceId: "task_02",
    targetId: "decision_01",
  }),
  makeEdge({
    id: "edge-task2-depends-on-task1",
    type: "DEPENDS_ON",
    sourceId: "task_02",
    targetId: "task_01",
  }),
  makeEdge({
    id: "edge-code3-supersedes-code1",
    type: "SUPERSEDES",
    sourceId: "code_03",
    targetId: "code_01",
  }),
  makeEdge({
    id: "edge-evidence-refutes-test",
    type: "REFUTES",
    sourceId: "evidence_01",
    targetId: "test_01",
    source: "gate",
  }),
  makeEdge({
    id: "edge-finding-violates-policy",
    type: "VIOLATES",
    sourceId: "finding_01",
    targetId: "policy_01",
    source: "evaluation",
  }),
  makeEdge({
    id: "edge-finding-blocks-task1",
    type: "BLOCKS",
    sourceId: "finding_01",
    targetId: "task_01",
    source: "evaluation",
  }),
  makeEdge({
    id: "edge-finding-diagnosed-by-rca",
    type: "DIAGNOSED_BY",
    sourceId: "finding_01",
    targetId: "rca_01",
  }),
  makeEdge({
    id: "edge-improvement-proposes-tool",
    type: "PROPOSES_CHANGE_TO",
    sourceId: "improvement_01",
    targetId: "tool_01",
    source: "agent",
  }),
];
