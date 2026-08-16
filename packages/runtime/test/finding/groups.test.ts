import { describe, expect, it } from "vitest";

import { contentDigest, type NodeRecord } from "@universal-harness-internal/core";

import {
  buildFindingGovernanceMetadata,
  projectFindingGroups,
  readFindingGovernance,
} from "../../src/index.js";

const FIXED_NOW = "2026-08-12T00:00:00.000Z";

function findingNode(input: {
  readonly id: string;
  readonly status?: NodeRecord["status"];
  readonly revision?: number;
  readonly timestamp?: string;
  readonly governance: ReturnType<typeof buildFindingGovernanceMetadata>;
}): NodeRecord {
  const content = {
    protocol_version: "1.0.0",
    record_kind: "node",
    id: input.id,
    type: "Finding",
    revision: input.revision ?? 1,
    status: input.status ?? "proposed",
    source: "audit",
    provenance: {
      iteration_id: "iteration_01",
      actor: "finding-group-test",
      timestamp: input.timestamp ?? FIXED_NOW,
    },
    confidence: 1,
    extensions: {
      "harness.finding": {
        origin: "audit",
        blocking: input.governance.severity === "blocker",
        violates: [],
        blocks: [],
        evidence: [],
        ...input.governance,
      },
    },
  };
  return { ...content, digest: contentDigest(content) } as NodeRecord;
}

function legacyFindingNode(input: {
  readonly id: string;
  readonly blocking: boolean;
  readonly audit?: { readonly kind: string; readonly subjects: readonly string[] };
}): NodeRecord {
  const content = {
    protocol_version: "1.0.0",
    record_kind: "node",
    id: input.id,
    type: "Finding",
    revision: 1,
    status: "proposed",
    source: "audit",
    provenance: {
      iteration_id: "iteration_01",
      actor: "legacy-fixture",
      timestamp: FIXED_NOW,
    },
    confidence: 1,
    extensions: {
      "harness.finding": {
        origin: "audit",
        blocking: input.blocking,
        violates: [],
        blocks: [],
        evidence: [],
      },
      ...(input.audit === undefined ? {} : { "harness.audit": input.audit }),
    },
  };
  return { ...content, digest: contentDigest(content) } as NodeRecord;
}

describe("Finding governance groups", () => {
  it("groups by normalized rule, scope, severity, and actionability with stable digests", () => {
    const governance = buildFindingGovernanceMetadata({
      rule: "audit/stale_knowledge",
      scopePrefix: "project/repository_01/knowledge",
      severity: "warning",
      actionability: "auto_close",
      subjectIds: ["edge_02", "node_01", "node_01"],
      subjectDigests: ["b".repeat(64), "a".repeat(64), "a".repeat(64)],
    });
    expect(governance).toEqual({
      rule: "audit/stale_knowledge",
      scope_prefix: "project/repository_01/knowledge",
      severity: "warning",
      actionability: "auto_close",
      subject_ids: ["edge_02", "node_01"],
      subject_digests: ["a".repeat(64), "b".repeat(64)],
    });

    const first = findingNode({ id: "finding_02", governance, status: "accepted" });
    const second = findingNode({
      id: "finding_01",
      governance,
      timestamp: "2026-08-11T00:00:00.000Z",
    });
    const forward = projectFindingGroups([first, second]);
    const reverse = projectFindingGroups([second, first]);

    expect(forward).toEqual(reverse);
    expect(forward).toEqual([
      expect.objectContaining({
        group_id: expect.stringMatching(/^finding-group_[a-f0-9]{16}$/u),
        rule: governance.rule,
        scope_prefix: governance.scope_prefix,
        severity: "warning",
        actionability: "auto_close",
        open_count: 2,
        accepted_count: 1,
        member_count: 2,
        samples: ["finding_01", "finding_02"],
        first_seen: "2026-08-11T00:00:00.000Z",
        last_seen: FIXED_NOW,
        membership_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    ]);

    const revised = findingNode({
      id: second.id,
      governance,
      revision: 2,
      status: "accepted",
      timestamp: second.provenance.timestamp,
    });
    expect(projectFindingGroups([first, revised])[0]?.membership_digest).not.toBe(
      forward[0]?.membership_digest,
    );
  });

  it("uses deterministic audit metadata for legacy Findings and isolates unknown records", () => {
    const known = readFindingGovernance(
      legacyFindingNode({
        id: "finding_legacy-stale",
        blocking: false,
        audit: { kind: "stale_knowledge", subjects: ["node_02", "edge_01"] },
      }),
    );
    expect(known).toEqual({
      rule: "audit/stale_knowledge",
      scope_prefix: "legacy/audit/knowledge",
      severity: "warning",
      actionability: "auto_close",
      subject_ids: ["edge_01", "node_02"],
      subject_digests: [],
    });

    expect(
      readFindingGovernance(legacyFindingNode({ id: "finding_legacy-unknown", blocking: true })),
    ).toEqual({
      rule: "legacy/unknown",
      scope_prefix: "legacy/unknown",
      severity: "blocker",
      actionability: "human_review",
      subject_ids: [],
      subject_digests: [],
    });
  });
});
