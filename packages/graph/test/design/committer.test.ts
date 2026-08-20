import { describe, expect, it } from "vitest";

import { contentDigest, type EdgeRecord } from "@universal-harness-internal/core";

import {
  buildAcceptedDesignSetRecords,
  designSetIdFor,
  readDesignSetExtension,
} from "../../src/design/committer.js";
import { assertGraphIntegrity } from "../../src/integrity.js";

/**
 * T12 DesignCommitter (designset lifecycle design 6.7/7.6/12): from the
 * approved proposal content it deterministically derives the accepted
 * DesignSet, every asset revision and all edges — semantic ADDRESSES /
 * SHAPES / SPECIFIES plus the committer-owned DERIVES_FROM / CONTAINS
 * structure edges. The same approved content always derives the same
 * records, so the approval binds exactly what lands in the graph.
 */
const digest = (letter: string) => letter.repeat(64);
const REQUIREMENT_ID = "requirement_01K1REQ";
const DECISION_ID = "decision_01K1DEC";
const ARTIFACT_ID = "designartifact_01K1API";

function approvedContent() {
  return {
    requirement_baseline_digest: digest("b"),
    impact_set_id: "impactset_01K1IMP",
    impact_set_digest: digest("1"),
    policy_digest: digest("2"),
    repository_baseline: "deadbeef",
    mode: "change" as const,
    node_changes: [
      {
        action: "create" as const,
        node_id: DECISION_ID,
        node_type: "Decision" as const,
        target_revision: 1,
        proposed_extensions: { "harness.decision": { summary: "expose items read API" } },
      },
      {
        action: "create" as const,
        node_id: ARTIFACT_ID,
        node_type: "DesignArtifact" as const,
        target_revision: 1,
        proposed_extensions: { "harness.design.artifact": { artifact_kind: "api_contract" } },
      },
    ],
    reused_assets: [],
    edge_changes: [
      {
        action: "create" as const,
        edge_id: "edge_01K1E01",
        relation: "ADDRESSES" as const,
        source_id: DECISION_ID,
        target_id: REQUIREMENT_ID,
      },
      {
        action: "create" as const,
        edge_id: "edge_01K1E02",
        relation: "SPECIFIES" as const,
        source_id: ARTIFACT_ID,
        target_id: REQUIREMENT_ID,
      },
    ],
    coverage: [],
    risk_summary: { level: "high" as const, reasons: ["new public API contract"] },
    rationale: "cover the items read requirement",
  };
}

const CONTEXT = {
  projectId: "project_demo",
  iterationId: "iteration_01K1IT1",
  actor: "workflow-engine",
  timestamp: "2026-08-21T00:00:00.000Z",
};

describe("designSetIdFor", () => {
  it("derives a stable per-iteration id", () => {
    const id = designSetIdFor("project_demo", "iteration_01K1IT1");
    expect(id.startsWith("design-set_")).toBe(true);
    expect(designSetIdFor("project_demo", "iteration_01K1IT1")).toBe(id);
    expect(designSetIdFor("project_demo", "iteration_01K1IT2")).not.toBe(id);
  });
});

describe("buildAcceptedDesignSetRecords", () => {
  it("derives the accepted set, asset revisions and all edges deterministically", () => {
    const records = buildAcceptedDesignSetRecords({
      content: approvedContent(),
      approvalDigest: digest("a"),
      revision: 1,
      baseEdges: [],
      context: CONTEXT,
    });
    const replay = buildAcceptedDesignSetRecords({
      content: approvedContent(),
      approvalDigest: digest("a"),
      revision: 1,
      baseEdges: [],
      context: CONTEXT,
    });
    expect(records.designSet.digest).toBe(replay.designSet.digest);

    expect(records.designSet.type).toBe("DesignSet");
    expect(records.designSet.status).toBe("accepted");
    expect(records.designSet.revision).toBe(1);
    const extension = readDesignSetExtension(records.designSet);
    expect(extension.approval_digest).toBe(digest("a"));
    expect(extension.content.mode).toBe("change");
    expect(extension.bindings.nodes.map((binding) => binding.node_id).sort()).toEqual([
      DECISION_ID,
      ARTIFACT_ID,
    ]);

    expect(records.assets.map((asset) => asset.id).sort()).toEqual([DECISION_ID, ARTIFACT_ID]);
    for (const asset of records.assets) {
      expect(asset.status).toBe("accepted");
      expect(asset.revision).toBe(1);
    }

    const relations = records.edges.map((edge) => edge.type);
    expect(relations.filter((type) => type === "ADDRESSES")).toHaveLength(1);
    expect(relations.filter((type) => type === "SPECIFIES")).toHaveLength(1);
    expect(relations.filter((type) => type === "DERIVES_FROM")).toHaveLength(1);
    expect(relations.filter((type) => type === "CONTAINS")).toHaveLength(2);
    const derives = records.edges.find((edge) => edge.type === "DERIVES_FROM");
    expect(derives?.source_id).toBe(records.designSet.id);
    expect(derives?.target_id).toBe("impactset_01K1IMP");
  });

  it("produces records that satisfy graph integrity with the context nodes", () => {
    const requirement = {
      protocol_version: "1.0.0",
      record_kind: "node",
      id: REQUIREMENT_ID,
      type: "Requirement",
      revision: 1,
      status: "accepted",
      source: "workflow",
      provenance: {
        iteration_id: "iteration_01K1IT1",
        actor: "workflow-engine",
        timestamp: "2026-08-21T00:00:00.000Z",
      },
      confidence: 1,
    };
    const requirementNode = {
      ...requirement,
      digest: contentDigest(requirement),
    } as unknown as Parameters<typeof assertGraphIntegrity>[0][number];
    const impactRecord = {
      ...requirement,
      id: "impactset_01K1IMP",
      type: "ImpactSet",
    };
    const impactNode = {
      ...impactRecord,
      digest: contentDigest(impactRecord),
    } as unknown as Parameters<typeof assertGraphIntegrity>[0][number];
    const records = buildAcceptedDesignSetRecords({
      content: approvedContent(),
      approvalDigest: digest("a"),
      revision: 1,
      baseEdges: [],
      context: CONTEXT,
    });
    expect(() =>
      assertGraphIntegrity(
        [requirementNode, impactNode, records.designSet, ...records.assets],
        records.edges,
      ),
    ).not.toThrow();
  });

  it("marks the base edge superseded for supersede changes", () => {
    const baseEdge: EdgeRecord = {
      protocol_version: "1.0.0",
      record_kind: "edge",
      id: "edge_01K1OLD",
      type: "ADDRESSES",
      source_id: DECISION_ID,
      target_id: REQUIREMENT_ID,
      status: "accepted",
      source: "workflow",
      provenance: {
        iteration_id: "iteration_01K1IT0",
        actor: "workflow-engine",
        timestamp: "2026-08-20T00:00:00.000Z",
      },
      confidence: 1,
      digest: digest("e"),
    } as unknown as EdgeRecord;
    const content = approvedContent();
    content.edge_changes = [
      {
        action: "supersede" as const,
        edge_id: "edge_01K1OLD",
        relation: "ADDRESSES" as const,
        source_id: DECISION_ID,
        target_id: REQUIREMENT_ID,
        base_digest: digest("e"),
        reason: "replaced by the richer contract",
      },
    ];
    const records = buildAcceptedDesignSetRecords({
      content,
      approvalDigest: digest("a"),
      revision: 1,
      baseEdges: [baseEdge],
      context: CONTEXT,
    });
    const retired = records.edges.find((edge) => edge.id === "edge_01K1OLD");
    expect(retired?.status).toBe("superseded");
    expect(retired?.digest).not.toBe(baseEdge.digest);
  });
});
