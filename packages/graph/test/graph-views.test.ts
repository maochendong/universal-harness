import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import type { EdgeRecord, NodeRecord } from "@universal-harness-internal/core";

import { materializeLedger, type Materialization } from "../src/materializer.js";
import { pageEvents, shortestPath } from "../src/query-port.js";
import { createArtifactGraphView } from "../src/views/artifact-graph.js";
import { createExecutionGraphView } from "../src/views/execution-graph.js";

import { commitScenario, makeProjectRoot } from "./fixtures.js";

const goldenDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../tests/golden/graph-views",
);

function readGolden(name: string): unknown {
  return JSON.parse(readFileSync(join(goldenDirectory, name), "utf8")) as unknown;
}

function summarizeNode(node: NodeRecord): Record<string, unknown> {
  return {
    id: node.id,
    type: node.type,
    revision: node.revision,
    status: node.status,
    digest: node.digest,
  };
}

function summarizeEdge(edge: EdgeRecord): Record<string, unknown> {
  return {
    id: edge.id,
    type: edge.type,
    source_id: edge.source_id,
    target_id: edge.target_id,
    status: edge.status,
    confidence: edge.confidence,
    digest: edge.digest,
  };
}

describe("graph views", () => {
  let materialization: Materialization;

  beforeAll(async () => {
    const projectRoot = makeProjectRoot();
    await commitScenario(projectRoot);
    materialization = materializeLedger({ projectRoot, databasePath: ":memory:" });
    return () => {
      materialization.database.close();
    };
  });

  it("pins the artifact graph golden query results", () => {
    const view = createArtifactGraphView(materialization.database);
    const result = {
      nodes: view.pageNodes({ limit: 500 }).items.map(summarizeNode),
      edges: view.pageEdges({ limit: 500 }).items.map(summarizeEdge),
    };
    expect(result).toEqual(readGolden("artifact-view.json"));
  });

  it("pins the execution graph golden query results", () => {
    const view = createExecutionGraphView(materialization.database);
    const result = {
      nodes: view.pageNodes({ limit: 500 }).items.map(summarizeNode),
      edges: view.pageEdges({ limit: 500 }).items.map(summarizeEdge),
      events: pageEvents(materialization.database, { limit: 500 }).items.map(
        (event) => event.event_id,
      ),
    };
    expect(result).toEqual(readGolden("execution-view.json"));
  });

  it("pins the deterministic projection digest and materialization counts", () => {
    const report = materialization.report;
    const result = {
      projectionDigest: report.projectionDigest,
      operationCount: report.operationCount,
      nodeCount: report.nodeCount,
      edgeCount: report.edgeCount,
      eventCount: report.eventCount,
      lastSequence: report.lastSequence,
    };
    expect(result).toEqual(readGolden("projection-digest.json"));
  });

  it("proves both views share ledger identity and stay mutually traceable", () => {
    const artifactView = createArtifactGraphView(materialization.database);
    const executionView = createExecutionGraphView(materialization.database);

    // Evidence is the shared bridge node: identical record in both views.
    const artifactEvidence = artifactView.getNode("evidence_01");
    const executionEvidence = executionView.getNode("evidence_01");
    expect(artifactEvidence).toBeDefined();
    expect(executionEvidence).toEqual(artifactEvidence);

    const path = shortestPath(materialization.database, "run_01", "requirement_01");
    const result = {
      sharedEvidence: {
        id: artifactEvidence?.id,
        digest: artifactEvidence?.digest,
        executionDigest: executionEvidence?.digest,
      },
      artifactBridgesFromEvidence: artifactView.bridges("evidence_01").map((bridge) => ({
        edge: bridge.edge.id,
        peer: bridge.peer.id,
        direction: bridge.direction,
      })),
      executionBridgesFromTask: executionView.bridges("task_01").map((bridge) => ({
        edge: bridge.edge.id,
        peer: bridge.peer.id,
        direction: bridge.direction,
      })),
      pathRunToRequirement: {
        nodes: path?.nodes.map((node) => node.id),
        edges: path?.edges.map((edge) => edge.id),
      },
    };
    expect(result).toEqual(readGolden("cross-view-trace.json"));
  });

  it("scopes each view to its node types and hides cross-view edges", () => {
    const artifactView = createArtifactGraphView(materialization.database);
    const executionView = createExecutionGraphView(materialization.database);

    expect(artifactView.getNode("run_01")).toBeUndefined();
    expect(executionView.getNode("requirement_01")).toBeUndefined();
    expect(artifactView.isMember("requirement_01")).toBe(true);
    expect(executionView.isMember("requirement_01")).toBe(false);

    // The IMPLEMENTS edge crosses the boundary, so neither view lists it.
    const artifactEdgeIds = artifactView.pageEdges({ limit: 500 }).items.map((edge) => edge.id);
    const executionEdgeIds = executionView.pageEdges({ limit: 500 }).items.map((edge) => edge.id);
    expect(artifactEdgeIds).not.toContain("edge-task-implements-requirement_01");
    expect(executionEdgeIds).not.toContain("edge-task-implements-requirement_01");

    expect(() => artifactView.bridges("run_01")).toThrowError(/not a member/);
  });

  it("keeps view neighborhoods inside the view", () => {
    const executionView = createExecutionGraphView(materialization.database);
    const area = executionView.neighborhood("run_01", { depth: 1 });
    expect(area.nodes.map((node) => node.id)).toEqual([
      "context_01",
      "evidence_01",
      "run_01",
      "task_01",
    ]);
    expect(area.edges.map((edge) => edge.id)).toEqual([
      "edge-run-executes-task_01",
      "edge-run-produces-evidence_01",
      "edge-run-uses-context_01",
    ]);
  });

  it("pages nodes deterministically through cursors", () => {
    const artifactView = createArtifactGraphView(materialization.database);
    const collected: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = artifactView.pageNodes({
        limit: 3,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      collected.push(...page.items.map((node) => node.id));
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
    const full = artifactView.pageNodes({ limit: 500 }).items.map((node) => node.id);
    expect(collected).toEqual(full);
    expect(full).toEqual([...full].sort());
  });

  it("pages events in ledger order through opaque cursors", () => {
    const first = pageEvents(materialization.database, { limit: 2 });
    expect(first.items.map((event) => event.event_id)).toEqual([
      "event-op-01-started_01",
      "event-op-02-plan-accepted_01",
    ]);
    expect(first.nextCursor).toBeDefined();
    const second = pageEvents(materialization.database, {
      limit: 2,
      ...(first.nextCursor !== undefined ? { cursor: first.nextCursor } : {}),
    });
    expect(second.items.map((event) => event.event_id)).toEqual(["event-op-03-gate-completed_01"]);
    expect(second.nextCursor).toBeUndefined();
    expect(() => pageEvents(materialization.database, { cursor: "not-a-cursor" })).toThrowError(
      /invalid event cursor/,
    );
  });

  it("resolves a deterministic shortest path and reports unreachable targets", () => {
    const path = shortestPath(materialization.database, "run_01", "requirement_01");
    expect(path?.nodes.map((node) => node.id)).toEqual(["run_01", "evidence_01", "requirement_01"]);
    expect(path?.edges.map((edge) => edge.id)).toEqual([
      "edge-run-produces-evidence_01",
      "edge-evidence-supports-requirement_01",
    ]);
    const unreachable = shortestPath(materialization.database, "approval_01", "project_01", {
      direction: "outgoing",
    });
    expect(unreachable).toBeUndefined();
  });
});
