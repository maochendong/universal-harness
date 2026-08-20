import { describe, expect, it } from "vitest";

import {
  freezeImpactSet,
  generateImpactSet,
  mergeImpactAdvisory,
  readImpactSetContent,
} from "../../src/impact/impact-set.js";
import { makeEdge, makeNode } from "../fixtures.js";

/**
 * Advisory merge (model advisory design 6): validated candidates fold into
 * the proposed ImpactSet so the human approves exactly one complete set.
 * The merge itself fails closed on deterministic-entry mutation or on a set
 * that is no longer proposed — it never trusts that a validator ran first.
 */
const CONTEXT = {
  iterationId: "iteration_01",
  actor: "workflow-engine",
  timestamp: "2026-08-20T00:00:00Z",
};

/**
 * A maintenance seed keeps the base risk low, so the DEPENDS_ON reach stays
 * informational/low while the REALIZES reach is must-change/high — the merge
 * tests get one entry per risk behavior.
 */
function proposedSet() {
  const nodes = [
    makeNode({ id: "requirement_01", type: "Requirement" }),
    makeNode({ id: "code-artifact_02", type: "CodeArtifact" }),
    makeNode({ id: "code-artifact_03", type: "CodeArtifact" }),
  ];
  const edges = [
    makeEdge({
      id: "edge_01",
      type: "DEPENDS_ON",
      sourceId: "requirement_01",
      targetId: "code-artifact_02",
    }),
    makeEdge({
      id: "edge_02",
      type: "REALIZES",
      sourceId: "code-artifact_03",
      targetId: "requirement_01",
    }),
  ];
  const set = generateImpactSet(
    [
      {
        id: "seed_01",
        nodeId: "requirement_01",
        kind: "content-change",
        iterationKind: "maintenance",
        reason: "baseline intent drives the iteration",
      },
    ],
    nodes,
    edges,
    CONTEXT,
  );
  return { nodes, set };
}

describe("mergeImpactAdvisory", () => {
  it("folds additions into the proposed set and re-digests the content", () => {
    const { set } = proposedSet();
    const before = readImpactSetContent(set);
    const merged = mergeImpactAdvisory(set, {
      additions: [
        {
          node_id: "code-artifact_04",
          node_type: "CodeArtifact",
          classification: "inspect",
          risk: "medium",
          confidence: 0.6,
          reason: "shares the export path",
          source_refs: [{ kind: "graph_node", ref: "code-artifact_02", digest: "a".repeat(64) }],
        },
      ],
      risk_signals: [],
    });
    const content = readImpactSetContent(merged);
    expect(content.content_digest).not.toBe(before.content_digest);
    expect(merged.status).toBe("proposed");
    const added = content.entries.find((entry) => entry.node_id === "code-artifact_04");
    expect(added).toMatchObject({
      classification: "inspect",
      risk: "medium",
      path: [],
      seed_id: "advisory",
    });
    // Deterministic entries carry over untouched.
    for (const entry of before.entries) {
      expect(content.entries).toContainEqual(entry);
    }
  });

  it("raises risk through signals but never lowers it", () => {
    const { set } = proposedSet();
    const before = readImpactSetContent(set);
    expect(before.entries.find((entry) => entry.node_id === "code-artifact_02")!.risk).toBe("low");
    expect(before.entries.find((entry) => entry.node_id === "code-artifact_03")!.risk).toBe("high");
    const merged = mergeImpactAdvisory(set, {
      additions: [],
      risk_signals: [
        {
          node_id: "code-artifact_02",
          signal: "auth boundary crossed",
          risk: "medium",
          rationale: "the dependency gates credentials",
          source_refs: [{ kind: "graph_node", ref: "code-artifact_02", digest: "b".repeat(64) }],
        },
        {
          node_id: "code-artifact_03",
          signal: "stale cache",
          risk: "low",
          rationale: "cosmetic only",
          source_refs: [{ kind: "graph_node", ref: "code-artifact_03", digest: "c".repeat(64) }],
        },
      ],
    });
    const entries = readImpactSetContent(merged).entries;
    expect(entries.find((entry) => entry.node_id === "code-artifact_02")!.risk).toBe("medium");
    expect(entries.find((entry) => entry.node_id === "code-artifact_03")!.risk).toBe("high");
    expect(entries.find((entry) => entry.node_id === "requirement_01")!.risk).toBe("low");
  });

  it("refuses an addition that targets a deterministic entry", () => {
    const { set } = proposedSet();
    expect(() =>
      mergeImpactAdvisory(set, {
        additions: [
          {
            node_id: "requirement_01",
            node_type: "Requirement",
            classification: "informational",
            risk: "low",
            confidence: 0.9,
            reason: "rewrite",
            source_refs: [{ kind: "graph_node", ref: "requirement_01", digest: "d".repeat(64) }],
          },
        ],
        risk_signals: [],
      }),
    ).toThrowError(/deterministic entry/);
  });

  it("refuses to merge into a frozen set", () => {
    const { set } = proposedSet();
    const frozen = freezeImpactSet(set, "e".repeat(64));
    expect(() => mergeImpactAdvisory(frozen, { additions: [], risk_signals: [] })).toThrowError(
      /not proposed/,
    );
  });
});
