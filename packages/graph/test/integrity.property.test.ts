import { describe, expect, it } from "vitest";

import type { EdgeRecord, NodeRecord } from "@universal-harness-internal/core";

import {
  GraphIntegrityError,
  RELATION_COMPATIBILITY,
  assertGraphIntegrity,
  checkGraphIntegrity,
  type IntegrityViolation,
} from "../src/integrity.js";

import { makeEdge, makeNode } from "./fixtures.js";

/**
 * Deterministic property tests for the graph integrity invariants. A seeded
 * PRNG (no external dependency) generates random graphs; every run of the
 * suite covers the same graphs, so a regression always reproduces.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const SEEDS = Array.from({ length: 24 }, (_, index) => index + 1);

/** DEPENDS_ON cycles need controlled construction, so they are excluded here. */
const RANDOM_RULES = RELATION_COMPATIBILITY.filter((rule) => rule.type !== "DEPENDS_ON");

interface GeneratedGraph {
  readonly nodes: NodeRecord[];
  readonly edges: EdgeRecord[];
}

function generateValidGraph(seed: number): GeneratedGraph {
  const random = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => {
    const chosen = items[Math.floor(random() * items.length)];
    if (chosen === undefined) throw new Error("empty pick");
    return chosen;
  };

  const nodes: NodeRecord[] = [];
  const edges: EdgeRecord[] = [];
  let nodeCounter = 0;
  const addNode = (type: NodeRecord["type"], revision = 1): NodeRecord => {
    nodeCounter += 1;
    const node = makeNode({ id: `node_${nodeCounter}`, type, revision });
    nodes.push(node);
    return node;
  };

  // Version chains: revisions 1..m of the same id are always contiguous.
  const chainLength = 1 + Math.floor(random() * 3);
  const chained = addNode(pick(["Requirement", "Decision", "Component"] as const));
  for (let revision = 2; revision <= chainLength; revision += 1) {
    nodes.push(makeNode({ id: chained.id, type: chained.type, revision }));
  }

  const edgeCount = 3 + Math.floor(random() * 8);
  for (let index = 0; index < edgeCount; index += 1) {
    const rule = pick(RANDOM_RULES);
    const source = addNode(pick(rule.sources));
    const target = addNode(pick(rule.targets));
    edges.push(
      makeEdge({
        id: `edge_${index}`,
        type: rule.type,
        sourceId: source.id,
        targetId: target.id,
        status: pick(["proposed", "accepted", "rejected", "superseded"] as const),
      }),
    );
  }

  // Random DEPENDS_ON DAG: edges only flow from lower to higher task index.
  const taskCount = 2 + Math.floor(random() * 4);
  const tasks: NodeRecord[] = [];
  for (let index = 0; index < taskCount; index += 1) {
    tasks.push(addNode("Task"));
  }
  let dependencyCounter = 0;
  for (let source = 0; source < taskCount; source += 1) {
    for (let target = source + 1; target < taskCount; target += 1) {
      if (random() < 0.5) {
        dependencyCounter += 1;
        edges.push(
          makeEdge({
            id: `edge-dep_${dependencyCounter}`,
            type: "DEPENDS_ON",
            sourceId: (tasks[source] as NodeRecord).id,
            targetId: (tasks[target] as NodeRecord).id,
          }),
        );
      }
    }
  }
  return { nodes, edges };
}

function kinds(violations: readonly IntegrityViolation[]): string[] {
  return violations.map((violation) => violation.kind);
}

describe("graph integrity invariants", () => {
  it("accepts every generated valid graph", () => {
    for (const seed of SEEDS) {
      const { nodes, edges } = generateValidGraph(seed);
      expect(checkGraphIntegrity(nodes, edges), `seed ${seed}`).toEqual([]);
    }
  });

  it("produces identical violations for identical input", () => {
    const { nodes, edges } = generateValidGraph(7);
    expect(checkGraphIntegrity(nodes, edges)).toEqual(checkGraphIntegrity(nodes, edges));
  });

  it("always rejects an edge whose endpoint does not exist", () => {
    for (const seed of SEEDS) {
      const { nodes, edges } = generateValidGraph(seed);
      const dangling = makeEdge({
        id: "edge-dangling",
        type: "CONTAINS",
        sourceId: "node_1",
        targetId: "node_never_created",
      });
      const violations = checkGraphIntegrity(nodes, [...edges, dangling]);
      expect(kinds(violations)).toContain("dangling_edge");
      const violation = violations.find((entry) => entry.kind === "dangling_edge");
      expect(violation?.subjectIds).toEqual(["edge-dangling"]);
      // A dangling edge is reported once, not again as an invalid relation.
      expect(violations.filter((entry) => entry.subjectIds.includes("edge-dangling"))).toHaveLength(
        1,
      );
    }
  });

  it("always rejects a relation incompatible with the endpoint node types", () => {
    for (const seed of SEEDS) {
      const { nodes, edges } = generateValidGraph(seed);
      const random = mulberry32(seed * 1000);
      // Find a deterministically random (relation, source, target) triple no
      // rule admits.
      const nodeTypes = ["Requirement", "Evidence", "Task", "Run", "Decision"] as const;
      let triple:
        | { type: EdgeRecord["type"]; source: NodeRecord["type"]; target: NodeRecord["type"] }
        | undefined;
      for (let attempt = 0; attempt < 500 && triple === undefined; attempt += 1) {
        const rule = RELATION_COMPATIBILITY[Math.floor(random() * RELATION_COMPATIBILITY.length)];
        const source = nodeTypes[Math.floor(random() * nodeTypes.length)];
        const target = nodeTypes[Math.floor(random() * nodeTypes.length)];
        if (rule === undefined || source === undefined || target === undefined) continue;
        const admitted = RELATION_COMPATIBILITY.some(
          (candidate) =>
            candidate.type === rule.type &&
            candidate.sources.includes(source) &&
            candidate.targets.includes(target),
        );
        if (!admitted) triple = { type: rule.type, source, target };
      }
      if (triple === undefined) throw new Error("no incompatible triple found");
      const sourceNode = makeNode({ id: "node-bad-source", type: triple.source });
      const targetNode = makeNode({ id: "node-bad-target", type: triple.target });
      const badEdge = makeEdge({
        id: "edge-bad-relation",
        type: triple.type,
        sourceId: sourceNode.id,
        targetId: targetNode.id,
      });
      const violations = checkGraphIntegrity(
        [...nodes, sourceNode, targetNode],
        [...edges, badEdge],
      );
      expect(kinds(violations)).toContain("invalid_relation");
    }
  });

  it("always rejects a revision chain that skips a version", () => {
    for (const seed of SEEDS) {
      const { nodes, edges } = generateValidGraph(seed);
      const gapped = makeNode({ id: "node-gapped", type: "Decision", revision: 3 });
      const violations = checkGraphIntegrity([...nodes, gapped], edges);
      expect(kinds(violations)).toContain("version_nonmonotonic");
      expect(violations.find((entry) => entry.kind === "version_nonmonotonic")?.subjectIds).toEqual(
        ["node-gapped"],
      );
    }
  });

  it("always rejects a DEPENDS_ON cycle among tasks", () => {
    for (const seed of SEEDS) {
      const { nodes, edges } = generateValidGraph(seed);
      const cycleEdges = [
        makeEdge({ id: "edge-c1", type: "DEPENDS_ON", sourceId: "task-a", targetId: "task-b" }),
        makeEdge({ id: "edge-c2", type: "DEPENDS_ON", sourceId: "task-b", targetId: "task-c" }),
        makeEdge({ id: "edge-c3", type: "DEPENDS_ON", sourceId: "task-c", targetId: "task-a" }),
      ];
      const taskNodes = ["task-a", "task-b", "task-c"].map((id) => makeNode({ id, type: "Task" }));
      const violations = checkGraphIntegrity([...nodes, ...taskNodes], [...edges, ...cycleEdges]);
      expect(kinds(violations)).toContain("dependency_cycle");
      const cycle = violations.find((entry) => entry.kind === "dependency_cycle");
      expect(cycle?.subjectIds).toEqual(["task-a", "task-b", "task-c"]);
    }
  });

  it("detects a self-dependency as a cycle", () => {
    const task = makeNode({ id: "task-solo", type: "Task" });
    const selfLoop = makeEdge({
      id: "edge-self",
      type: "DEPENDS_ON",
      sourceId: "task-solo",
      targetId: "task-solo",
    });
    expect(kinds(checkGraphIntegrity([task], [selfLoop]))).toContain("dependency_cycle");
  });

  it("ignores rejected or superseded DEPENDS_ON edges for cycle detection", () => {
    const tasks = ["task-a", "task-b"].map((id) => makeNode({ id, type: "Task" }));
    const edges = [
      makeEdge({ id: "edge-live", type: "DEPENDS_ON", sourceId: "task-a", targetId: "task-b" }),
      makeEdge({
        id: "edge-dead",
        type: "DEPENDS_ON",
        sourceId: "task-b",
        targetId: "task-a",
        status: "rejected",
      }),
    ];
    expect(checkGraphIntegrity(tasks, edges)).toEqual([]);
  });

  it("does not treat a tombstoned node as dangling", () => {
    const project = makeNode({ id: "project_01", type: "Project" });
    const intent = makeNode({ id: "intent_01", type: "Intent", status: "tombstoned" });
    const edge = makeEdge({
      id: "edge-contains",
      type: "CONTAINS",
      sourceId: "project_01",
      targetId: "intent_01",
    });
    expect(checkGraphIntegrity([project, intent], [edge])).toEqual([]);
  });

  it("tolerates duplicate revisions with identical content", () => {
    const first = makeNode({ id: "decision_01", type: "Decision", revision: 1 });
    const duplicate = makeNode({ id: "decision_01", type: "Decision", revision: 1 });
    expect(checkGraphIntegrity([first, duplicate], [])).toEqual([]);
  });

  it("rejects a revision chain that does not start at 1", () => {
    const node = makeNode({ id: "decision_01", type: "Decision", revision: 2 });
    expect(kinds(checkGraphIntegrity([node], []))).toContain("version_nonmonotonic");
  });

  it("assertGraphIntegrity throws a typed error carrying every violation", () => {
    const dangling = makeEdge({
      id: "edge-dangling",
      type: "CONTAINS",
      sourceId: "node-missing-a",
      targetId: "node-missing-b",
    });
    let caught: unknown;
    try {
      assertGraphIntegrity([], [dangling]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GraphIntegrityError);
    expect((caught as GraphIntegrityError).violations.map((entry) => entry.kind)).toEqual([
      "dangling_edge",
    ]);
  });
});
