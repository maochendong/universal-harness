import { afterEach, describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";
import {
  LedgerRepository,
  canonicalizeJson,
  contentDigest,
  harnessRootFor,
  readCommittedOperations,
  type NodeRecord,
} from "@universal-harness-internal/core";
import { materializeLedger, pageEdges, pageNodes } from "@universal-harness-internal/graph";

import {
  buildFindingGovernanceMetadata,
  buildGateEvidence,
  collectProjectStatus,
  createNewProject,
  hashWorktreeCode,
  resolveFindingGroup,
} from "../../src/index.js";
import {
  FIXED_NOW,
  cleanupDirectories,
  headOf,
  makeTempDir,
  sequentialIds,
} from "../bootstrap/helpers.js";

afterEach(cleanupDirectories);

async function projectWithFindings(evidenceOverrides?: {
  readonly passed?: boolean;
  readonly provisional?: boolean;
  readonly subjectId?: string;
  readonly codeDigest?: string;
}): Promise<{
  readonly projectRoot: string;
  readonly findingIds: readonly string[];
  readonly evidenceId: string;
}> {
  const parent = makeTempDir("harness-finding-group-");
  const created = await createNewProject(
    { parentDirectory: parent, name: "finding-group", intent: "group related findings" },
    { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId: sequentialIds() },
  );
  if (!created.ok) throw new Error(created.error.message);
  const projectRoot = created.value.projectRoot;
  const governance = buildFindingGovernanceMetadata({
    rule: "audit/stale_knowledge",
    scopePrefix: `project/${created.value.repositoryId}/knowledge`,
    severity: "warning",
    actionability: "auto_close",
    subjectIds: ["node_stale"],
    subjectDigests: ["a".repeat(64)],
  });
  const findingIds = ["finding_group-01", "finding_group-02"] as const;
  const artifacts = findingIds.flatMap((id) => {
    const feedbackContent = {
      protocol_version: "1.0.0",
      record_kind: "feedback",
      id,
      type: "Finding",
      iteration_id: created.value.iterationId,
      status: "proposed",
      summary: `stale fixture ${id}`,
      created_at: FIXED_NOW,
      extensions: {
        "harness.finding": {
          origin: "audit",
          blocking: false,
          violates: [],
          blocks: [],
          evidence: [],
          ...governance,
        },
      },
    };
    const feedback = { ...feedbackContent, digest: contentDigest(feedbackContent) };
    const nodeContent = {
      protocol_version: "1.0.0",
      record_kind: "node",
      id,
      type: "Finding",
      revision: 1,
      status: "proposed",
      source: "audit",
      provenance: {
        iteration_id: created.value.iterationId,
        actor: "group-service-fixture",
        timestamp: FIXED_NOW,
      },
      confidence: 1,
      extensions: {
        "harness.finding": {
          feedback_digest: feedback.digest,
          origin: "audit",
          blocking: false,
          violates: [],
          blocks: [],
          evidence: [],
          ...governance,
        },
      },
    };
    const node = { ...nodeContent, digest: contentDigest(nodeContent) };
    return [
      {
        path: `artifacts/findings/${id}/proposed.json`,
        content: `${canonicalizeJson(feedback)}\n`,
      },
      {
        path: `artifacts/finding-nodes/${id}/1.json`,
        content: `${canonicalizeJson(node)}\n`,
      },
    ];
  });
  const evidenceId = "evidence_group-repair";
  const evidence = buildGateEvidence({
    evidenceId,
    createdAt: FIXED_NOW,
    ...(evidenceOverrides?.provisional === undefined
      ? {}
      : { provisional: evidenceOverrides.provisional }),
    outcome: {
      gate_id: "gate_group-repair",
      layer: "project",
      mandatory: true,
      subject_id: evidenceOverrides?.subjectId ?? "node_stale",
      passed: evidenceOverrides?.passed ?? true,
      exit_code: evidenceOverrides?.passed === false ? 1 : 0,
      summary: "group repair passed",
      log_summary: "ok",
      artifact_hashes: {},
      output_digest: "c".repeat(64),
    },
    bindings: {
      artifact_digests: [],
      code_digests: [evidenceOverrides?.codeDigest ?? hashWorktreeCode(projectRoot)],
      gate_digest: "d".repeat(64),
      evaluation_case_digests: [],
      policy_digest: "e".repeat(64),
    },
  });
  artifacts.push({
    path: `artifacts/evidence/${evidenceId}/${evidence.digest}.json`,
    content: `${canonicalizeJson(evidence)}\n`,
  });
  const last = readCommittedOperations(harnessRootFor(projectRoot)).at(-1);
  if (last === undefined) throw new Error("bootstrap operation missing");
  await new LedgerRepository({
    projectRoot,
    readBaseline: () => headOf(projectRoot),
    now: () => FIXED_NOW,
  }).commit({
    ledger_operation_id: "ledger_finding-fixture",
    workflow_operation_id: last.manifest.workflow_operation_id,
    attempt_id: last.manifest.attempt_id,
    expected_baseline: headOf(projectRoot),
    artifacts,
    edges: findingIds.map((id) => {
      const content = {
        protocol_version: "1.0.0",
        record_kind: "edge",
        id: `edge_${id}-blocks-iteration`,
        type: "BLOCKS",
        source_id: id,
        target_id: created.value.iterationId,
        status: "accepted",
        source: "audit",
        provenance: {
          iteration_id: created.value.iterationId,
          actor: "group-service-fixture",
          timestamp: FIXED_NOW,
        },
        confidence: 1,
      };
      return { ...content, digest: contentDigest(content) };
    }),
    events: [],
  });
  return { projectRoot, findingIds, evidenceId };
}

describe("Finding group service", () => {
  it("accepts every current member atomically and appends one event per Finding", async () => {
    const { projectRoot, findingIds } = await projectWithFindings();
    const group = collectProjectStatus(projectRoot).finding_groups[0];
    if (group === undefined) throw new Error("group projection missing");
    const before = readCommittedOperations(harnessRootFor(projectRoot)).length;

    const result = await resolveFindingGroup(
      { projectRoot, readBaseline: () => headOf(projectRoot), now: () => FIXED_NOW },
      {
        groupId: group.group_id,
        membershipDigest: group.membership_digest,
        action: "accept",
        actor: "human:reviewer",
      },
    );

    expect(result).toEqual({
      groupId: group.group_id,
      membershipDigest: group.membership_digest,
      action: "accept",
      status: "accepted",
      members: findingIds,
    });
    expect(readCommittedOperations(harnessRootFor(projectRoot))).toHaveLength(before + 1);
    const graph = materializeLedger({ projectRoot, databasePath: ":memory:" });
    try {
      const accepted = pageNodes(graph.database, { type: "Finding", status: "accepted" }).items;
      expect(accepted.map((node: NodeRecord) => node.id)).toEqual(findingIds);
    } finally {
      graph.database.close();
    }
    const events = new LedgerRepository({
      projectRoot,
      readBaseline: () => headOf(projectRoot),
    })
      .replay()
      .events.filter((event) => event.event_type === "FindingAccepted");
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.payload)).toEqual(
      findingIds.map((findingId) =>
        expect.objectContaining({
          finding_id: findingId,
          from: "proposed",
          to: "accepted",
          actor: "human:reviewer",
          cause: "group_accept",
          group_id: group.group_id,
        }),
      ),
    );
  });

  it("supersedes all open members and retires every active incident edge", async () => {
    const { projectRoot, findingIds } = await projectWithFindings();
    const group = collectProjectStatus(projectRoot).finding_groups[0];
    if (group === undefined) throw new Error("group projection missing");

    const result = await resolveFindingGroup(
      { projectRoot, readBaseline: () => headOf(projectRoot), now: () => FIXED_NOW },
      {
        groupId: group.group_id,
        membershipDigest: group.membership_digest,
        action: "supersede",
        actor: "workflow-engine",
      },
    );

    expect(result.status).toBe("superseded");
    const graph = materializeLedger({ projectRoot, databasePath: ":memory:" });
    try {
      expect(
        pageNodes(graph.database, { type: "Finding", status: "superseded" }).items.map(
          (node) => node.id,
        ),
      ).toEqual(findingIds);
      expect(pageEdges(graph.database, { status: "superseded" }).items).toHaveLength(2);
    } finally {
      graph.database.close();
    }
    const events = new LedgerRepository({
      projectRoot,
      readBaseline: () => headOf(projectRoot),
    })
      .replay()
      .events.filter((event) => event.event_type === "FindingSuperseded");
    expect(events).toHaveLength(2);
    expect(events[0]?.payload).toMatchObject({
      actor: "workflow-engine",
      cause: "group_supersede",
      group_id: group.group_id,
    });
  });

  it("rejects group close before writing when repair Evidence is absent", async () => {
    const { projectRoot } = await projectWithFindings();
    const group = collectProjectStatus(projectRoot).finding_groups[0];
    if (group === undefined) throw new Error("group projection missing");
    const before = readCommittedOperations(harnessRootFor(projectRoot)).length;

    await expect(
      resolveFindingGroup(
        { projectRoot, readBaseline: () => headOf(projectRoot), now: () => FIXED_NOW },
        {
          groupId: group.group_id,
          membershipDigest: group.membership_digest,
          action: "close",
          actor: "human:reviewer",
          evidenceId: "evidence_missing",
        },
      ),
    ).rejects.toMatchObject({ kind: "invalid_finding_group_evidence" });
    expect(readCommittedOperations(harnessRootFor(projectRoot))).toHaveLength(before);
  });

  it.each([
    ["failed", { passed: false }],
    ["provisional", { provisional: true }],
    ["stale", { codeDigest: "f".repeat(64) }],
    ["inapplicable", { subjectId: "node_other" }],
  ] as const)(
    "rejects %s repair Evidence for the whole group with zero writes",
    async (_, overrides) => {
      const { projectRoot, evidenceId } = await projectWithFindings(overrides);
      const group = collectProjectStatus(projectRoot).finding_groups[0];
      if (group === undefined) throw new Error("group projection missing");
      const before = readCommittedOperations(harnessRootFor(projectRoot)).length;

      await expect(
        resolveFindingGroup(
          { projectRoot, readBaseline: () => headOf(projectRoot), now: () => FIXED_NOW },
          {
            groupId: group.group_id,
            membershipDigest: group.membership_digest,
            action: "close",
            actor: "human:reviewer",
            evidenceId,
          },
        ),
      ).rejects.toMatchObject({ kind: "invalid_finding_group_evidence" });
      expect(readCommittedOperations(harnessRootFor(projectRoot))).toHaveLength(before);
    },
  );

  it("closes the whole group only with fresh Evidence applicable to every member", async () => {
    const { projectRoot, findingIds, evidenceId } = await projectWithFindings();
    const group = collectProjectStatus(projectRoot).finding_groups[0];
    if (group === undefined) throw new Error("group projection missing");

    const result = await resolveFindingGroup(
      { projectRoot, readBaseline: () => headOf(projectRoot), now: () => FIXED_NOW },
      {
        groupId: group.group_id,
        membershipDigest: group.membership_digest,
        action: "close",
        actor: "human:reviewer",
        evidenceId,
      },
    );

    expect(result.status).toBe("closed");
    const operations = new LedgerRepository({
      projectRoot,
      readBaseline: () => headOf(projectRoot),
    }).replay();
    expect(
      operations.events
        .filter((event) => event.event_type === "FindingClosed")
        .map((event) => event.payload),
    ).toEqual(
      findingIds.map((findingId) =>
        expect.objectContaining({ finding_id: findingId, evidence_id: evidenceId }),
      ),
    );
  });

  it("rejects a stale membership digest with zero Ledger writes", async () => {
    const { projectRoot } = await projectWithFindings();
    const group = collectProjectStatus(projectRoot).finding_groups[0];
    if (group === undefined) throw new Error("group projection missing");
    const before = readCommittedOperations(harnessRootFor(projectRoot)).length;

    await expect(
      resolveFindingGroup(
        { projectRoot, readBaseline: () => headOf(projectRoot), now: () => FIXED_NOW },
        {
          groupId: group.group_id,
          membershipDigest: "f".repeat(64),
          action: "supersede",
          actor: "human:reviewer",
        },
      ),
    ).rejects.toMatchObject({ kind: "finding_group_digest_mismatch" });
    expect(readCommittedOperations(harnessRootFor(projectRoot))).toHaveLength(before);
  });
});
