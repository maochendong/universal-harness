import { describe, expect, it } from "vitest";

import { contentDigest, type EdgeRecord, type NodeRecord } from "@universal-harness-internal/core";

import { planFindingDecay } from "../../src/index.js";

const NOW = "2026-08-12T00:00:00.000Z";

function node(input: {
  readonly id: string;
  readonly type: NodeRecord["type"];
  readonly extensions?: Record<string, unknown>;
}): NodeRecord {
  const content = {
    protocol_version: "1.0.0",
    record_kind: "node",
    id: input.id,
    type: input.type,
    revision: 1,
    status: "proposed",
    source: input.type === "Finding" ? "audit" : "scanner",
    provenance: { iteration_id: "iteration_01", actor: "decay-test", timestamp: NOW },
    confidence: 1,
    ...(input.extensions === undefined ? {} : { extensions: input.extensions }),
  };
  return { ...content, digest: contentDigest(content) } as NodeRecord;
}

function edge(id: string, findingId: string): EdgeRecord {
  const content = {
    protocol_version: "1.0.0",
    record_kind: "edge",
    id,
    type: "BLOCKS",
    source_id: findingId,
    target_id: "iteration_01",
    status: "accepted",
    source: "audit",
    provenance: { iteration_id: "iteration_01", actor: "decay-test", timestamp: NOW },
    confidence: 1,
  };
  return { ...content, digest: contentDigest(content) } as EdgeRecord;
}

function finding(
  id: string,
  actionability: "auto_close" | "human_review",
  subjectDigest: string,
): NodeRecord {
  return node({
    id,
    type: "Finding",
    extensions: {
      "harness.finding": {
        origin: "audit",
        blocking: actionability === "human_review",
        rule:
          actionability === "auto_close"
            ? "audit/stale_knowledge"
            : "audit/missing_design_artifact",
        scope_prefix:
          actionability === "auto_close"
            ? "project/repository_01/knowledge"
            : "project/repository_01/design",
        severity: actionability === "auto_close" ? "warning" : "blocker",
        actionability,
        subject_ids: ["code_01"],
        subject_digests: [subjectDigest],
      },
    },
  });
}

describe("Finding decay planning", () => {
  it("supersedes only non-reproducing auto-close Findings and selects every incident edge", () => {
    const oldDigest = "a".repeat(64);
    const currentSubject = node({ id: "code_01", type: "CodeArtifact" });
    const stale = finding("finding_stale", "auto_close", oldDigest);
    const human = finding("finding_human", "human_review", oldDigest);
    const staleEdge = edge("edge_stale", stale.id);
    const humanEdge = edge("edge_human", human.id);

    expect(
      planFindingDecay({
        nodes: [currentSubject, stale, human],
        edges: [humanEdge, staleEdge],
        liveFindingIds: [],
      }),
    ).toEqual([
      {
        finding: stale,
        incidentEdges: [staleEdge],
        cause: "predicate_resolved",
        oldSubjectDigests: [oldDigest],
        newSubjectDigests: [currentSubject.digest],
      },
    ]);

    expect(
      planFindingDecay({
        nodes: [currentSubject, stale],
        edges: [staleEdge],
        liveFindingIds: [stale.id],
      }),
    ).toEqual([]);
  });
});
