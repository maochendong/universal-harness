import { describe, expect, it } from "vitest";

import {
  OperationDagError,
  buildOperationDag,
  validateOperationDag,
  type OperationDagNode,
} from "../../src/capability/dag.js";
import { capabilityDependencyClosure } from "../../src/capability/registry.js";
import { CAPABILITY_IDS, type CapabilityId } from "../../src/schema/profile.js";

function node(partial: Partial<OperationDagNode> & { node_id: string }): OperationDagNode {
  return {
    node_kind: "kernel",
    depends_on: [],
    consumes: [],
    produces: [],
    checkpoint: true,
    ...partial,
  };
}

function nodeIds(active: readonly CapabilityId[]): string[] {
  return buildOperationDag(new Set(active)).map((entry) => entry.node_id);
}

describe("operation dag construction", () => {
  it("keeps the fixed kernel spine without any module nodes when nothing is active", () => {
    expect(nodeIds([])).toEqual([
      "capture",
      "capability_decision",
      "plan",
      "context",
      "execute",
      "verify",
      "snapshot",
    ]);
  });

  it("inserts module nodes at their fixed positions", () => {
    expect(nodeIds(capabilityDependencyClosure(["strict_tdd"]))).toEqual([
      "capture",
      "capability_decision",
      "impact",
      "design",
      "plan",
      "context",
      "execute",
      "verify",
      "snapshot",
    ]);
    expect(nodeIds(["advanced_audit"])).toEqual([
      "capture",
      "capability_decision",
      "plan",
      "context",
      "execute",
      "verify",
      "snapshot",
      "audit",
    ]);
  });

  it("uses the fixed generic tail verify → [evaluate?] → snapshot", () => {
    const withoutEvaluation = nodeIds([]);
    expect(withoutEvaluation.slice(-2)).toEqual(["verify", "snapshot"]);
    expect(withoutEvaluation).not.toContain("evaluate");

    const withEvaluation = nodeIds(["independent_evaluation"]);
    expect(withEvaluation.slice(-3)).toEqual(["verify", "evaluate", "snapshot"]);

    const full = nodeIds([...CAPABILITY_IDS]);
    expect(full.slice(-4)).toEqual(["verify", "evaluate", "snapshot", "audit"]);
  });

  it("marks the strict_tdd subgraph inside execute, never as a global phase", () => {
    const active = new Set(capabilityDependencyClosure(["strict_tdd"]));
    const dag = buildOperationDag(active);
    const execute = dag.find((entry) => entry.node_id === "execute");
    expect(execute?.subgraph).toBe("strict_tdd");
    expect(dag.some((entry) => entry.node_id === "strict_tdd")).toBe(false);
    expect(execute?.consumes).toContain("design_set");
    expect(execute?.produces).toContain("tdd_contract");

    const plain = buildOperationDag(new Set());
    const plainExecute = plain.find((entry) => entry.node_id === "execute");
    expect(plainExecute?.subgraph).toBeUndefined();
    expect(plainExecute?.produces).not.toContain("tdd_contract");
  });

  it("builds valid dags for every dependency-closed capability subset", () => {
    for (let mask = 0; mask < 2 ** CAPABILITY_IDS.length; mask += 1) {
      const subset = CAPABILITY_IDS.filter((_, index) => (mask & (1 << index)) !== 0);
      const dag = buildOperationDag(new Set(capabilityDependencyClosure(subset)));
      expect(() => validateOperationDag(dag)).not.toThrow();
    }
  });
});

describe("operation dag validation", () => {
  it("blocks cycles", () => {
    const dag = [
      node({ node_id: "a", depends_on: ["b"] }),
      node({ node_id: "b", depends_on: ["a"] }),
    ];
    try {
      validateOperationDag(dag);
      expect.unreachable("a cycle must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(OperationDagError);
      expect((error as OperationDagError).kind).toBe("dag_cycle");
    }
  });

  it("blocks conflicting outputs", () => {
    const dag = [
      node({ node_id: "a", produces: ["snapshot"] }),
      node({ node_id: "b", produces: ["snapshot"], depends_on: ["a"] }),
    ];
    try {
      validateOperationDag(dag);
      expect.unreachable("conflicting outputs must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(OperationDagError);
      expect((error as OperationDagError).kind).toBe("output_conflict");
    }
  });

  it("blocks inputs no node produces", () => {
    const dag = [node({ node_id: "design", consumes: ["design_set"] })];
    try {
      validateOperationDag(dag);
      expect.unreachable("unsatisfied inputs must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(OperationDagError);
      expect((error as OperationDagError).kind).toBe("unsatisfied_input");
    }
  });

  it("blocks duplicate node ids and unknown dependencies", () => {
    expect(() =>
      validateOperationDag([node({ node_id: "a" }), node({ node_id: "a" })]),
    ).toThrowError(OperationDagError);
    try {
      validateOperationDag([node({ node_id: "a", depends_on: ["ghost"] })]);
      expect.unreachable("unknown dependencies must throw");
    } catch (error) {
      expect((error as OperationDagError).kind).toBe("unknown_dependency");
    }
  });
});
