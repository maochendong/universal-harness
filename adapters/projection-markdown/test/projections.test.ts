import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { contentDigest, type EdgeRecord, type NodeRecord } from "@universal-harness-internal/core";

import {
  renderArchitectureProjection,
  renderPlanProjection,
  renderPrdProjection,
  renderSnapshotProjection,
  renderSpecificationProjection,
  type ProjectionGraph,
  type SnapshotViewInput,
} from "../src/index.js";

const goldenDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../tests/golden/projections",
);

function readGolden(name: string): string {
  return readFileSync(join(goldenDirectory, name), "utf8");
}

const FIXED_NOW = "2026-08-12T00:00:00.000Z";

interface NodeSpec {
  readonly id: string;
  readonly type: NodeRecord["type"];
  readonly revision?: number;
  readonly status?: NodeRecord["status"];
  readonly locator?: string;
  readonly extensions?: Record<string, unknown>;
}

function makeNode(spec: NodeSpec): NodeRecord {
  const record: Record<string, unknown> = {
    protocol_version: "1.0.0",
    record_kind: "node",
    id: spec.id,
    type: spec.type,
    revision: spec.revision ?? 1,
    status: spec.status ?? "accepted",
    source: "workflow",
    provenance: { iteration_id: "iteration_01", actor: "projection-test", timestamp: FIXED_NOW },
    confidence: 1,
  };
  if (spec.locator !== undefined) record.locator = spec.locator;
  if (spec.extensions !== undefined) record.extensions = spec.extensions;
  return { ...record, digest: contentDigest(record) } as unknown as NodeRecord;
}

interface EdgeSpec {
  readonly id: string;
  readonly type: EdgeRecord["type"];
  readonly sourceId: string;
  readonly targetId: string;
}

function makeEdge(spec: EdgeSpec): EdgeRecord {
  const record: Record<string, unknown> = {
    protocol_version: "1.0.0",
    record_kind: "edge",
    id: spec.id,
    type: spec.type,
    source_id: spec.sourceId,
    target_id: spec.targetId,
    status: "accepted",
    source: "workflow",
    provenance: { iteration_id: "iteration_01", actor: "projection-test", timestamp: FIXED_NOW },
    confidence: 1,
  };
  return { ...record, digest: contentDigest(record) } as unknown as EdgeRecord;
}

function fixtureGraph(): ProjectionGraph {
  const nodes: NodeRecord[] = [
    makeNode({
      id: "intent_01",
      type: "Intent",
      extensions: { "harness.requirements": { text: "Ship the widget" } },
    }),
    makeNode({
      id: "requirement_01",
      type: "Requirement",
      revision: 1,
      status: "superseded",
      extensions: { "harness.requirements": { statement: "old statement", acceptance: [] } },
    }),
    makeNode({
      id: "requirement_01",
      type: "Requirement",
      revision: 2,
      extensions: {
        "harness.requirements": {
          statement: "The widget renders in under 100ms",
          acceptance: [
            { description: "render benchmark passes", verification: "gate perf_benchmark" },
          ],
        },
      },
    }),
    makeNode({
      id: "constraint_01",
      type: "Constraint",
      extensions: {
        "harness.requirements": {
          statement: "No network access from the widget",
          verification: "gate policy_check",
        },
      },
    }),
    makeNode({
      id: "test_01",
      type: "Test",
      extensions: {
        "harness.requirements": {
          description: "render benchmark passes",
          verification: "gate perf_benchmark",
          verifies: "requirement_01",
        },
      },
    }),
    makeNode({ id: "decision_01", type: "Decision" }),
    makeNode({ id: "component_01", type: "Component" }),
    makeNode({
      id: "code_01",
      type: "CodeArtifact",
      locator: "repo://repository_01/src/widget.ts",
    }),
    makeNode({
      id: "plan_01",
      type: "ExecutionPlan",
      extensions: {
        "harness.plan": {
          mode: "single-loop",
          mode_reason: "single coherent task chain",
          restricted: true,
        },
      },
    }),
    makeNode({
      id: "task_01",
      type: "Task",
      extensions: {
        "harness.plan": {
          id: "task_01",
          objective: "Implement the widget renderer",
          risk: "medium",
          budget: { steps: 10, tokens: 20000 },
          dependencies: [],
          required_gates: ["perf_benchmark"],
          acceptance: [
            { description: "render benchmark passes", verification: "gate perf_benchmark" },
          ],
        },
      },
    }),
    makeNode({
      id: "task_02",
      type: "Task",
      extensions: {
        "harness.plan": {
          id: "task_02",
          objective: "Wire the widget into the shell",
          risk: "low",
          budget: { steps: 5, tokens: 8000 },
          dependencies: ["task_01"],
          required_gates: [],
          acceptance: [
            { description: "shell integration test passes", verification: "test shell" },
          ],
        },
      },
    }),
  ];
  const edges: EdgeRecord[] = [
    makeEdge({
      id: "edge-intent-decomposes-requirement_01",
      type: "DECOMPOSES_TO",
      sourceId: "intent_01",
      targetId: "requirement_01",
    }),
    makeEdge({
      id: "edge-requirement-constrained-by-constraint_01",
      type: "CONSTRAINED_BY",
      sourceId: "requirement_01",
      targetId: "constraint_01",
    }),
    makeEdge({
      id: "edge-test-verifies-requirement_01",
      type: "VERIFIES",
      sourceId: "test_01",
      targetId: "requirement_01",
    }),
    makeEdge({
      id: "edge-decision-addresses-requirement_01",
      type: "ADDRESSES",
      sourceId: "decision_01",
      targetId: "requirement_01",
    }),
    makeEdge({
      id: "edge-decision-shapes-component_01",
      type: "SHAPES",
      sourceId: "decision_01",
      targetId: "component_01",
    }),
    makeEdge({
      id: "edge-code-realizes-component_01",
      type: "REALIZES",
      sourceId: "code_01",
      targetId: "component_01",
    }),
    makeEdge({
      id: "edge-plan-contains-task_01",
      type: "CONTAINS",
      sourceId: "plan_01",
      targetId: "task_01",
    }),
    makeEdge({
      id: "edge-plan-contains-task_02",
      type: "CONTAINS",
      sourceId: "plan_01",
      targetId: "task_02",
    }),
    makeEdge({
      id: "edge-task-depends-on-task_01",
      type: "DEPENDS_ON",
      sourceId: "task_02",
      targetId: "task_01",
    }),
    makeEdge({
      id: "edge-task-implements-requirement_01",
      type: "IMPLEMENTS",
      sourceId: "task_01",
      targetId: "requirement_01",
    }),
  ];
  return { nodes, edges };
}

const SNAPSHOT_INPUT: SnapshotViewInput = {
  snapshot_id: "snapshot_01",
  iteration_id: "iteration_01",
  status: "completed",
  source_commit: "0123456789abcdef0123456789abcdef01234567",
  final_commit: "0123456789abcdef0123456789abcdef01234567",
  workflow_operation_id: "workflow-op_01",
  execution_plan_id: "plan_01",
  run_outcomes: [
    { id: "run_01", outcome: "handoff" },
    { id: "run_02", outcome: "handoff" },
  ],
  task_verdicts: [
    { verdict_id: "verdict_01", task_id: "task_01", verdict: "passed" },
    { verdict_id: "verdict_02", task_id: "task_02", verdict: "passed" },
  ],
  budget: { used_steps: 12, used_tokens: 21000, ceiling_steps: 20, ceiling_tokens: 50000 },
  trajectory_summary: "2 runs, 14 tool calls, 0 denials",
  approvals: ["approval_01"],
  evidence: ["evidence_01"],
  closed_findings: ["finding_01"],
  unresolved_items: [],
  rejected_hypotheses: ["hypothesis: cache-first rendering"],
  improvement_candidates: [{ id: "improvement_01", status: "proposed" }],
};

describe("markdown projections", () => {
  it("pins the PRD projection golden", () => {
    expect(renderPrdProjection(fixtureGraph()).markdown).toBe(readGolden("prd.md"));
  });

  it("pins the architecture projection golden", () => {
    expect(renderArchitectureProjection(fixtureGraph()).markdown).toBe(
      readGolden("architecture.md"),
    );
  });

  it("pins the specification projection golden", () => {
    expect(renderSpecificationProjection(fixtureGraph()).markdown).toBe(readGolden("spec.md"));
  });

  it("pins the plan projection golden", () => {
    expect(renderPlanProjection(fixtureGraph()).markdown).toBe(readGolden("plan.md"));
  });

  it("pins the snapshot projection golden", () => {
    expect(renderSnapshotProjection(SNAPSHOT_INPUT).markdown).toBe(readGolden("snapshot.md"));
  });

  it("is reproducible: identical graph state renders byte-identical output", () => {
    const first = renderPrdProjection(fixtureGraph());
    const second = renderPrdProjection(fixtureGraph());
    expect(second.markdown).toBe(first.markdown);
    expect(second.generation_digest).toBe(first.generation_digest);
  });

  it("changes the generation digest when a source revision changes", () => {
    const graph = fixtureGraph();
    const baseline = renderPrdProjection(graph);
    const revised: ProjectionGraph = {
      nodes: [
        ...graph.nodes,
        makeNode({
          id: "requirement_01",
          type: "Requirement",
          revision: 3,
          extensions: {
            "harness.requirements": {
              statement: "The widget renders in under 50ms",
              acceptance: [
                { description: "render benchmark passes", verification: "gate perf_benchmark" },
              ],
            },
          },
        }),
      ],
      edges: graph.edges,
    };
    const next = renderPrdProjection(revised);
    expect(next.generation_digest).not.toBe(baseline.generation_digest);
    expect(next.markdown).toContain("under 50ms");
    expect(next.markdown).not.toContain("old statement");
  });

  it("renders an empty graph as an explicit empty view", () => {
    const document = renderPrdProjection({ nodes: [], edges: [] });
    expect(document.markdown).toContain("No intent has been captured yet.");
    expect(document.sources).toEqual([]);
  });
});
