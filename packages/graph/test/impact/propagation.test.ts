import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROPAGATION_POLICY,
  ImpactError,
  propagateImpact,
} from "../../src/impact/propagation.js";

import { IMPACT_EDGES, IMPACT_NODES, INFERRED_EDGE_ID } from "./fixtures.js";

function reachMap(seedNodeId: string, policy = DEFAULT_PROPAGATION_POLICY) {
  return new Map(
    propagateImpact(seedNodeId, IMPACT_NODES, IMPACT_EDGES, policy).map((reach) => [
      reach.nodeId,
      reach,
    ]),
  );
}

describe("impact propagation", () => {
  it("follows only policy-admitted relations and directions", () => {
    const reaches = reachMap("requirement_01");
    // DECOMPOSES_TO is forward-only: the intent is not pulled in by a
    // requirement change. SUPERSEDES is forward-only: the rename follower
    // code_03 is not pulled in either.
    expect(reaches.has("intent_01")).toBe(false);
    expect(reaches.has("code_03")).toBe(false);
    // The isolated pair is never reached.
    expect(reaches.has("component_02")).toBe(false);
    expect(reaches.has("code_02")).toBe(false);
    // Deterministic neighbors in both directions are reached.
    for (const id of [
      "requirement_01",
      "decision_01",
      "component_01",
      "code_01",
      "test_01",
      "constraint_01",
      "policy_01",
      "task_01",
      "task_02",
      "decision_02",
    ]) {
      expect(reaches.has(id), id).toBe(true);
    }
  });

  it("reproduces the design failure chain with the shortest explanation path", () => {
    const reaches = reachMap("evidence_01");
    const code = reaches.get("code_01");
    expect(code?.path.map((step) => step.edgeId)).toEqual([
      "edge-evidence-refutes-test",
      "edge-test-verifies-requirement",
      "edge-decision-addresses-requirement",
      "edge-decision-shapes-component",
      "edge-code-realizes-component",
    ]);
  });

  it("traverses proposed inferred edges but marks them inferred", () => {
    const reaches = reachMap("requirement_01");
    const decision2 = reaches.get("decision_02");
    expect(decision2?.path).toHaveLength(1);
    expect(decision2?.path[0]?.edgeId).toBe(INFERRED_EDGE_ID);
    expect(decision2?.path[0]?.inferred).toBe(true);
  });

  it("treats an accepted edge with original sub-1 confidence as inferred", () => {
    const accepted = IMPACT_EDGES.map((edge) =>
      edge.id === INFERRED_EDGE_ID ? { ...edge, status: "accepted" as const } : edge,
    );
    const reaches = new Map(
      propagateImpact("requirement_01", IMPACT_NODES, accepted).map((reach) => [
        reach.nodeId,
        reach,
      ]),
    );
    // Acceptance changed the status only; the original confidence still caps
    // anything beyond this edge at inspect grade.
    expect(reaches.get("decision_02")?.path[0]?.inferred).toBe(true);
  });

  it("never traverses rejected or superseded edges", () => {
    const dead = IMPACT_EDGES.map((edge) =>
      edge.id === "edge-test-verifies-requirement"
        ? { ...edge, status: "rejected" as const }
        : edge,
    );
    const reaches = new Map(
      propagateImpact("requirement_01", IMPACT_NODES, dead).map((reach) => [reach.nodeId, reach]),
    );
    expect(reaches.has("test_01")).toBe(false);
  });

  it("respects the policy depth limit", () => {
    const reaches = reachMap("evidence_01", { ...DEFAULT_PROPAGATION_POLICY, maxDepth: 2 });
    expect(reaches.has("test_01")).toBe(true);
    expect(reaches.has("requirement_01")).toBe(true);
    expect(reaches.has("decision_01")).toBe(false);
    expect(() =>
      propagateImpact("evidence_01", IMPACT_NODES, IMPACT_EDGES, {
        ...DEFAULT_PROPAGATION_POLICY,
        maxDepth: 0,
      }),
    ).toThrow(ImpactError);
  });

  it("is deterministic regardless of record ordering", () => {
    const shuffledNodes = [...IMPACT_NODES].reverse();
    const shuffledEdges = [...IMPACT_EDGES].reverse();
    expect(propagateImpact("requirement_01", shuffledNodes, shuffledEdges)).toEqual(
      propagateImpact("requirement_01", IMPACT_NODES, IMPACT_EDGES),
    );
  });

  it("rejects a seed that references an unknown node", () => {
    expect(() => propagateImpact("node_missing", IMPACT_NODES, IMPACT_EDGES)).toThrow(ImpactError);
  });
});
