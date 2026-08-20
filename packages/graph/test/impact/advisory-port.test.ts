import { describe, expect, it } from "vitest";

import { makeNode } from "../fixtures.js";
import { RELATION_RULE_REGISTRY } from "../../src/impact/advisory.js";
import {
  createInMemoryImpactAdvisoryPort,
  type ImpactAdvisoryInput,
} from "../../src/impact/advisory-port.js";
import type { ImpactEntry } from "../../src/impact/impact-set.js";

const NODES = [
  makeNode({ id: "requirement_01", type: "Requirement" }),
  makeNode({ id: "code-artifact_02", type: "CodeArtifact" }),
];
const NODE_DIGEST = new Map(NODES.map((node) => [node.id, node.digest]));

function entry(): ImpactEntry {
  return {
    node_id: "requirement_01",
    node_type: "Requirement",
    classification: "must-change",
    risk: "high",
    confidence: 1,
    path: [],
    reason: "directly seeded",
    seed_id: "seed_01",
  };
}

function input(): ImpactAdvisoryInput {
  return {
    workflow_operation_id: "operation_01K1ABC",
    iteration_id: "iteration_01K1ABC",
    impact_set_digest: "a".repeat(64),
    deterministic_entries: [entry()],
    nodes: NODES,
    requirement_digests: {},
    rule_registry_version: RELATION_RULE_REGISTRY.version,
    rule_registry_digest: RELATION_RULE_REGISTRY.digest,
    conversation_id: "conversation_01K1ABC",
    run_id: "run_01K1ABC",
  };
}

describe("in-memory impact advisory port", () => {
  it("returns the scripted advisory unchanged when it merges cleanly", async () => {
    const port = createInMemoryImpactAdvisoryPort(() => ({
      additions: [
        {
          node_id: "code-artifact_02",
          node_type: "CodeArtifact",
          classification: "inspect",
          risk: "medium",
          confidence: 0.6,
          reason: "the reporting module shares the export path",
          source_refs: [
            {
              kind: "graph_node",
              ref: "code-artifact_02",
              digest: NODE_DIGEST.get("code-artifact_02")!,
            },
          ],
        },
      ],
      edge_candidates: [],
      risk_signals: [],
      missing_facts: [],
      questions: [],
    }));
    const result = await port.advise(input());
    expect(result.status).toBe("proposed");
  });

  it("fails closed instead of returning an unmergable advisory", async () => {
    const port = createInMemoryImpactAdvisoryPort(() => ({
      additions: [
        {
          node_id: "requirement_01",
          node_type: "Requirement",
          classification: "informational",
          risk: "low",
          confidence: 0.9,
          reason: "rewrite the deterministic entry",
          source_refs: [
            {
              kind: "graph_node",
              ref: "requirement_01",
              digest: NODE_DIGEST.get("requirement_01")!,
            },
          ],
        },
      ],
      edge_candidates: [],
      risk_signals: [],
      missing_facts: [],
      questions: [],
    }));
    const result = await port.advise(input());
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.code).toBe("invalid_output");
  });

  it("rejects advisory output that drifts from the advised set digest", async () => {
    const port = createInMemoryImpactAdvisoryPort(() => ({
      impact_set_digest: "9".repeat(64),
      additions: [],
      edge_candidates: [],
      risk_signals: [],
      missing_facts: [],
      questions: [],
    }));
    const result = await port.advise(input());
    expect(result.status).toBe("failed");
  });
});
