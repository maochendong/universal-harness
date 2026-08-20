import { describe, expect, it } from "vitest";

import { contentDigest, type NodeRecord } from "@universal-harness-internal/core";
import {
  RELATION_RULE_REGISTRY,
  createInMemoryImpactAdvisoryPort,
  generateImpactSet,
  readImpactSetContent,
  type ImpactAdvisoryInput,
} from "@universal-harness-internal/graph";

import { adviseImpactSet } from "../../src/orchestration/contributors/impact-contributor.js";

/**
 * PG-3 contributor wiring: the optional advisory runs between propagation and
 * approval. A clean advisory folds into the set the human approves; a failed
 * or clarification-only advisory leaves the deterministic set untouched.
 */
function makeNode(id: string, type: NodeRecord["type"]): NodeRecord {
  const record: Record<string, unknown> = {
    protocol_version: "1.0.0",
    record_kind: "node",
    id,
    type,
    revision: 1,
    status: "accepted",
    source: "workflow",
    provenance: {
      iteration_id: "iteration_01",
      actor: "contributor-test",
      timestamp: "2026-08-20T00:00:00Z",
    },
    confidence: 1,
  };
  return { ...record, digest: contentDigest(record) } as unknown as NodeRecord;
}

const NODES = [
  makeNode("requirement_01", "Requirement"),
  makeNode("code-artifact_02", "CodeArtifact"),
];
const NODE_DIGEST = new Map(NODES.map((node) => [node.id, node.digest]));

const IDS = {
  workflow_operation_id: "operation_01K1ABC",
  iteration_id: "iteration_01K1ABC",
  attempt_id: "attempt_01",
};

function deterministicSet(): NodeRecord {
  return generateImpactSet(
    [
      {
        id: "seed_01",
        nodeId: "requirement_01",
        kind: "content-change",
        iterationKind: "feature",
        reason: "baseline intent drives the iteration",
      },
    ],
    NODES,
    [],
    { iterationId: "iteration_01", actor: "workflow-engine", timestamp: "2026-08-20T00:00:00Z" },
  );
}

describe("impact contributor advisory wiring", () => {
  it("binds the deterministic set, graph and rule registry into the advisory input", async () => {
    const set = deterministicSet();
    let seen: ImpactAdvisoryInput | undefined;
    const port = createInMemoryImpactAdvisoryPort((input) => {
      seen = input;
      return {
        additions: [],
        edge_candidates: [],
        risk_signals: [],
        missing_facts: [],
        questions: [],
      };
    });
    await adviseImpactSet(IDS, set, NODES, port);
    expect(seen).toBeDefined();
    expect(seen!.impact_set_digest).toBe(readImpactSetContent(set).content_digest);
    expect(seen!.deterministic_entries).toEqual(readImpactSetContent(set).entries);
    expect(seen!.rule_registry_version).toBe(RELATION_RULE_REGISTRY.version);
    expect(seen!.rule_registry_digest).toBe(RELATION_RULE_REGISTRY.digest);
    expect(seen!.requirement_digests["requirement_01"]).toBe(NODE_DIGEST.get("requirement_01"));
    expect(seen!.conversation_id).toContain("impact-advisory-conversation_");
  });

  it("folds a clean advisory into the set that approval binds to", async () => {
    const set = deterministicSet();
    const port = createInMemoryImpactAdvisoryPort(() => ({
      additions: [
        {
          node_id: "code-artifact_02",
          node_type: "CodeArtifact",
          classification: "inspect",
          risk: "medium",
          confidence: 0.6,
          reason: "shares the export path",
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
    const merged = await adviseImpactSet(IDS, set, NODES, port);
    const content = readImpactSetContent(merged);
    expect(content.content_digest).not.toBe(readImpactSetContent(set).content_digest);
    expect(content.entries.find((entry) => entry.node_id === "code-artifact_02")).toMatchObject({
      classification: "inspect",
      seed_id: "advisory",
    });
    expect(merged.status).toBe("proposed");
  });

  it("leaves the deterministic set untouched when the advisory fails closed", async () => {
    const set = deterministicSet();
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
    const result = await adviseImpactSet(IDS, set, NODES, port);
    expect(readImpactSetContent(result).content_digest).toBe(
      readImpactSetContent(set).content_digest,
    );
  });

  it("leaves the deterministic set untouched on a clarification-only advisory", async () => {
    const set = deterministicSet();
    const port = createInMemoryImpactAdvisoryPort(() => ({
      additions: [],
      edge_candidates: [],
      risk_signals: [],
      missing_facts: [],
      questions: [{ question: "does the export path include the audit log?" }],
    }));
    const result = await adviseImpactSet(IDS, set, NODES, port);
    expect(readImpactSetContent(result).content_digest).toBe(
      readImpactSetContent(set).content_digest,
    );
  });
});
