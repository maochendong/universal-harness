import { describe, expect, it } from "vitest";

import { contentDigest, type EdgeRecord, type NodeRecord } from "@universal-harness-internal/core";

import { checkGraphIntegrity, propagateImpact } from "../../src/index.js";

function node(id: string, type: NodeRecord["type"]): NodeRecord {
  const content = {
    schema_version: 1,
    record_kind: "node" as const,
    id,
    type,
    revision: 1,
    source: "tool" as const,
    provenance: { actor: "semantic-test", timestamp: "2026-08-16T00:00:00.000Z" },
  };
  return { ...content, digest: contentDigest(content) } as NodeRecord;
}

function inferredEdge(
  sourceId: string,
  targetId: string,
  status: EdgeRecord["status"],
): EdgeRecord {
  const content = {
    schema_version: 1,
    record_kind: "edge" as const,
    id: "edge_semantic",
    type: "MAY_IMPACT" as const,
    source_id: sourceId,
    target_id: targetId,
    status,
    source: "tool" as const,
    provenance: { actor: "semantic-provider", timestamp: "2026-08-16T00:00:00.000Z" },
    confidence: 0.8,
  };
  return { ...content, digest: contentDigest(content) } as EdgeRecord;
}

describe("MAY_IMPACT graph policy", () => {
  it("admits only versionable endpoints and propagates forward at inspect grade", () => {
    const source = node("code_source", "CodeArtifact");
    const target = node("test_target", "Test");
    const edge = inferredEdge(source.id, target.id, "accepted");

    expect(checkGraphIntegrity([source, target], [edge])).toEqual([]);
    expect(propagateImpact(source.id, [source, target], [edge])).toEqual([
      { nodeId: source.id, path: [] },
      {
        nodeId: target.id,
        path: [
          expect.objectContaining({
            relation: "MAY_IMPACT",
            relationRisk: "low",
            inferred: true,
          }),
        ],
      },
    ]);
    expect(propagateImpact(target.id, [source, target], [edge])).toEqual([
      { nodeId: target.id, path: [] },
    ]);
  });

  it("rejects non-versionable endpoints", () => {
    const source = node("project_source", "Project");
    const target = node("code_target", "CodeArtifact");
    expect(
      checkGraphIntegrity([source, target], [inferredEdge(source.id, target.id, "proposed")]),
    ).toEqual([expect.objectContaining({ kind: "invalid_relation" })]);
  });
});
