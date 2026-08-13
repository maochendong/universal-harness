import { describe, expect, it } from "vitest";

import {
  ContextError,
  knowledgeLayerFor,
  selectTaskNeighborhood,
} from "../../src/context/selector.js";
import type { TaskSpecification } from "../../src/planning/task.js";

import { makeEdge, makeNode } from "./fixtures.js";

describe("knowledgeLayerFor", () => {
  it("maps the design 8.7 layer defaults", () => {
    expect(knowledgeLayerFor("Constraint")).toBe("L1");
    expect(knowledgeLayerFor("Policy")).toBe("L1");
    expect(knowledgeLayerFor("Decision")).toBe("L2");
    expect(knowledgeLayerFor("Component")).toBe("L2");
    expect(knowledgeLayerFor("ToolDefinition")).toBe("L3");
    expect(knowledgeLayerFor("Gate")).toBe("L3");
    expect(knowledgeLayerFor("CodeArtifact")).toBe("L4");
    expect(knowledgeLayerFor("Test")).toBe("L4");
    expect(knowledgeLayerFor("Finding")).toBe("L5");
    expect(knowledgeLayerFor("Evidence")).toBe("L5");
    expect(knowledgeLayerFor("ImprovementCandidate")).toBe("L5");
  });

  it("leaves unmapped node types without a layer", () => {
    expect(knowledgeLayerFor("Requirement")).toBe("none");
    expect(knowledgeLayerFor("Task")).toBe("none");
    expect(knowledgeLayerFor("Intent")).toBe("none");
  });
});

describe("selectTaskNeighborhood", () => {
  const nodes = [
    makeNode("requirement_01", "Requirement"),
    makeNode("decision_01", "Decision"),
    makeNode("component_01", "Component"),
    makeNode("code_01", "CodeArtifact"),
    makeNode("code_02", "CodeArtifact"),
    makeNode("test_01", "Test"),
  ];
  const edges = [
    makeEdge("edge-decision-addresses-requirement", "ADDRESSES", "decision_01", "requirement_01"),
    makeEdge("edge-decision-shapes-component", "SHAPES", "decision_01", "component_01"),
    makeEdge("edge-code-realizes-component", "REALIZES", "code_01", "component_01"),
    makeEdge("edge-code2-realizes-component", "REALIZES", "code_02", "component_01"),
    makeEdge("edge-test-verifies-requirement", "VERIFIES", "test_01", "requirement_01"),
  ];

  function task(overrides?: Partial<TaskSpecification>): TaskSpecification {
    return {
      id: "task_01",
      objective: "change the component",
      impact_paths: [["edge-decision-shapes-component"]],
      expected_outputs: ["code_01"],
      capabilities: ["fs.read"],
      tools: ["tool:fs"],
      dependencies: [],
      risk: "medium",
      budget: { steps: 4, tokens: 2000 },
      acceptance: [{ description: "verified", verification: "gate:test" }],
      required_gates: ["gate:test"],
      ...overrides,
    };
  }

  it("seeds from expected outputs and impact path endpoints with reasons", () => {
    const selection = selectTaskNeighborhood(task(), nodes, edges, 0);
    expect(selection).toEqual([
      { nodeId: "code_01", reason: "expected task output", depth: 0 },
      {
        nodeId: "component_01",
        reason: "approved impact path endpoint of edge-decision-shapes-component",
        depth: 0,
      },
      {
        nodeId: "decision_01",
        reason: "approved impact path endpoint of edge-decision-shapes-component",
        depth: 0,
      },
    ]);
  });

  it("expands one hop in both directions, recording the explaining edge", () => {
    const selection = selectTaskNeighborhood(task(), nodes, edges);
    const byId = new Map(selection.map((entry) => [entry.nodeId, entry]));
    // One hop from code_01 and component_01 / decision_01 seeds.
    expect(byId.get("requirement_01")).toMatchObject({ depth: 1 });
    expect(byId.get("code_02")).toMatchObject({
      depth: 1,
      reason: "neighbor of component_01 via edge-code2-realizes-component (REALIZES)",
    });
    // Two hops away from every seed.
    expect(byId.has("test_01")).toBe(false);
  });

  it("respects deeper traversal when requested", () => {
    const selection = selectTaskNeighborhood(task(), nodes, edges, 2);
    const byId = new Map(selection.map((entry) => [entry.nodeId, entry]));
    expect(byId.get("test_01")).toMatchObject({ depth: 2 });
  });

  it("is deterministic for the same graph", () => {
    const first = selectTaskNeighborhood(task(), nodes, edges, 2);
    const second = selectTaskNeighborhood(task(), [...nodes].reverse(), [...edges].reverse(), 2);
    expect(first).toEqual(second);
  });

  it("ignores impact path edges that are not in the graph", () => {
    const selection = selectTaskNeighborhood(
      task({ impact_paths: [["edge-missing"]] }),
      nodes,
      edges,
      0,
    );
    expect(selection).toEqual([{ nodeId: "code_01", reason: "expected task output", depth: 0 }]);
  });

  it("rejects invalid depths", () => {
    expect(() => selectTaskNeighborhood(task(), nodes, edges, -1)).toThrowError(ContextError);
    expect(() => selectTaskNeighborhood(task(), nodes, edges, 99)).toThrowError(ContextError);
  });
});
