import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { contentDigest, type EdgeRecord, type NodeRecord } from "@universal-harness-internal/core";

import { renderTasksProjection, type ProjectionGraph } from "../src/index.js";

const goldenDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../tests/golden/projections",
);

const FIXED_NOW = "2026-08-12T00:00:00.000Z";

interface NodeSpec {
  readonly id: string;
  readonly type: NodeRecord["type"];
  readonly revision?: number;
  readonly status?: NodeRecord["status"];
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

function taskNode(id: string, objective: string): NodeRecord {
  return makeNode({
    id,
    type: "Task",
    extensions: {
      "harness.plan": { id, objective, risk: "low", dependencies: [] },
    },
  });
}

/**
 * Three-task fixture: two independent roots (a parallel wave) and one task
 * depending on both. task_01 is proven complete by a snapshot.
 */
function fixtureGraph(): ProjectionGraph {
  return {
    nodes: [
      makeNode({
        id: "plan_01",
        type: "ExecutionPlan",
        extensions: { "harness.plan": { mode: "single-loop" } },
      }),
      taskNode("task_01", "Implement the widget renderer"),
      taskNode("task_02", "Wire the widget into the shell"),
      taskNode("task_03", "Polish the widget"),
    ],
    edges: [
      makeEdge({
        id: "edge-contains_01",
        type: "CONTAINS",
        sourceId: "plan_01",
        targetId: "task_01",
      }),
      makeEdge({
        id: "edge-contains_02",
        type: "CONTAINS",
        sourceId: "plan_01",
        targetId: "task_02",
      }),
      makeEdge({
        id: "edge-contains_03",
        type: "CONTAINS",
        sourceId: "plan_01",
        targetId: "task_03",
      }),
      makeEdge({ id: "edge-dep_01", type: "DEPENDS_ON", sourceId: "task_03", targetId: "task_01" }),
      makeEdge({ id: "edge-dep_02", type: "DEPENDS_ON", sourceId: "task_03", targetId: "task_02" }),
    ],
  };
}

describe("renderTasksProjection", () => {
  it("renders the fixture graph byte-identical to the golden file", () => {
    const document = renderTasksProjection(fixtureGraph(), { completedTasks: ["task_01"] });
    expect(document.markdown).toBe(readFileSync(join(goldenDirectory, "tasks.md"), "utf8"));
  });

  it("is deterministic: identical input produces identical output", () => {
    const graph = fixtureGraph();
    const options = { completedTasks: ["task_01"] };
    expect(renderTasksProjection(graph, options)).toEqual(renderTasksProjection(graph, options));
  });

  it("maps completion state, parallel waves and dependencies onto the list", () => {
    const { markdown } = renderTasksProjection(fixtureGraph(), { completedTasks: ["task_01"] });
    expect(markdown).toContain("- [x] T001 [P] Implement the widget renderer");
    expect(markdown).toContain("- [ ] T002 [P] Wire the widget into the shell");
    expect(markdown).toContain("- [ ] T003 Polish the widget (depends on T001, T002)");
    expect(markdown).toContain("do not edit");
  });

  it("numbers tasks in dependency order, not id order", () => {
    const graph: ProjectionGraph = {
      nodes: [
        makeNode({
          id: "plan_01",
          type: "ExecutionPlan",
          extensions: { "harness.plan": { mode: "single-loop" } },
        }),
        taskNode("task_a", "downstream task"),
        taskNode("task_b", "upstream task"),
      ],
      edges: [
        makeEdge({
          id: "edge-contains_01",
          type: "CONTAINS",
          sourceId: "plan_01",
          targetId: "task_a",
        }),
        makeEdge({
          id: "edge-contains_02",
          type: "CONTAINS",
          sourceId: "plan_01",
          targetId: "task_b",
        }),
        makeEdge({ id: "edge-dep_01", type: "DEPENDS_ON", sourceId: "task_a", targetId: "task_b" }),
      ],
    };
    const { markdown } = renderTasksProjection(graph);
    expect(markdown).toContain("- [ ] T001 upstream task");
    expect(markdown).toContain("- [ ] T002 downstream task (depends on T001)");
    // A lone root is never marked [P]: no parallel sibling exists.
    expect(markdown).not.toContain("[P]");
  });

  it("renders an empty state when no plan exists", () => {
    const { markdown } = renderTasksProjection({ nodes: [], edges: [] });
    expect(markdown).toContain("# Tasks");
    expect(markdown).toContain("No execution plan recorded yet.");
  });
});
