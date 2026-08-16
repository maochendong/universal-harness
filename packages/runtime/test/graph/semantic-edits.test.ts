import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";
import {
  LedgerRepository,
  PROTOCOL_VERSION,
  canonicalizeJson,
  contentDigest,
  harnessRootFor,
  readCommittedOperations,
  type EdgeRecord,
  type NodeRecord,
} from "@universal-harness-internal/core";
import { materializeLedger, pageEdges } from "@universal-harness-internal/graph";

import { approveGraphEdge, createNewProject, proposeSemanticImpactEdges } from "../../src/index.js";
import type { GraphEditError } from "../../src/index.js";
import {
  FIXED_NOW,
  cleanupDirectories,
  headOf,
  makeTempDir,
  sequentialIds,
} from "../bootstrap/helpers.js";

afterEach(cleanupDirectories);

function codeNode(input: {
  readonly id: string;
  readonly path: string;
  readonly iterationId: string;
  readonly revision?: number;
}): NodeRecord {
  const content = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "node" as const,
    id: input.id,
    type: "CodeArtifact" as const,
    revision: input.revision ?? 1,
    status: "accepted" as const,
    source: "scanner" as const,
    provenance: {
      iteration_id: input.iterationId,
      actor: "semantic-fixture",
      timestamp: FIXED_NOW,
    },
    confidence: 1,
    locator: `repo://repository_semantic/${input.path}`,
  };
  return { ...content, digest: contentDigest(content) } as NodeRecord;
}

async function appendNodes(projectRoot: string, nodes: readonly NodeRecord[]): Promise<void> {
  const last = readCommittedOperations(harnessRootFor(projectRoot)).at(-1);
  if (last === undefined) throw new Error("bootstrap operation missing");
  await new LedgerRepository({ projectRoot, readBaseline: () => headOf(projectRoot) }).commit({
    ledger_operation_id: `ledger_semantic_${String(readCommittedOperations(harnessRootFor(projectRoot)).length)}`,
    workflow_operation_id: last.manifest.workflow_operation_id,
    attempt_id: last.manifest.attempt_id,
    expected_baseline: headOf(projectRoot),
    artifacts: nodes.map((node) => ({
      path: `artifacts/semantic-nodes/${node.id}/${String(node.revision)}.json`,
      content: `${canonicalizeJson(node)}\n`,
    })),
    edges: [],
    events: [],
  });
}

async function fixture(): Promise<{
  readonly projectRoot: string;
  readonly iterationId: string;
  readonly source: NodeRecord;
  readonly target: NodeRecord;
}> {
  const created = await createNewProject(
    {
      parentDirectory: makeTempDir("harness-semantic-edit-"),
      name: "semantic-edit",
      intent: "find related user service artifacts",
    },
    { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId: sequentialIds() },
  );
  if (!created.ok) throw new Error(created.error.message);
  mkdirSync(join(created.value.projectRoot, "src"), { recursive: true });
  mkdirSync(join(created.value.projectRoot, "test"), { recursive: true });
  writeFileSync(
    join(created.value.projectRoot, "src", "UserService.ts"),
    "export class UserService { loadUserProfile() {} }\n",
  );
  writeFileSync(
    join(created.value.projectRoot, "test", "UserService.test.ts"),
    "describe('UserService loadUserProfile', () => {})\n",
  );
  const source = codeNode({
    id: "code_source",
    path: "src/UserService.ts",
    iterationId: created.value.iterationId,
  });
  const target = codeNode({
    id: "code_target",
    path: "test/UserService.test.ts",
    iterationId: created.value.iterationId,
  });
  await appendNodes(created.value.projectRoot, [source, target]);
  return {
    projectRoot: created.value.projectRoot,
    iterationId: created.value.iterationId,
    source,
    target,
  };
}

function activeEdges(projectRoot: string): EdgeRecord[] {
  const { database } = materializeLedger({ projectRoot, databasePath: ":memory:" });
  try {
    const edges: EdgeRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = pageEdges(database, {
        limit: 500,
        ...(cursor === undefined ? {} : { cursor }),
      });
      edges.push(...page.items.filter((edge) => edge.status === "accepted"));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return edges;
  } finally {
    database.close();
  }
}

describe("semantic graph edge proposals", () => {
  it("stages a batch without active edges, then activates one digest-bound inspect edge", async () => {
    const { projectRoot, source, target } = await fixture();
    const beforeOperations = readCommittedOperations(harnessRootFor(projectRoot)).length;
    const batch = await proposeSemanticImpactEdges(
      { projectRoot, readBaseline: () => headOf(projectRoot), now: () => FIXED_NOW },
      { sourceNodeIds: [source.id], actor: "human:local", topK: 10 },
    );
    const proposal = batch.proposals.find((entry) => entry.candidateNodeId === target.id);

    expect(proposal).toBeDefined();
    expect(readCommittedOperations(harnessRootFor(projectRoot))).toHaveLength(beforeOperations + 1);
    expect(activeEdges(projectRoot).some((edge) => edge.type === "MAY_IMPACT")).toBe(false);
    if (proposal === undefined) return;
    const staged = JSON.parse(
      readFileSync(
        join(projectRoot, ".harness", "artifacts", "edge-proposals", `${proposal.edgeId}.json`),
        "utf8",
      ),
    ) as { suggestion: { index_digest: string; source_revision: number } };
    expect(staged.suggestion).toMatchObject({
      index_digest: batch.descriptor.index_digest,
      source_revision: source.revision,
    });

    await approveGraphEdge(
      { projectRoot, readBaseline: () => headOf(projectRoot), now: () => FIXED_NOW },
      { edgeId: proposal.edgeId, previewDigest: proposal.previewDigest, actor: "human:local" },
    );
    const edge = activeEdges(projectRoot).find((candidate) => candidate.id === proposal.edgeId);
    expect(edge).toMatchObject({
      type: "MAY_IMPACT",
      source_id: source.id,
      target_id: target.id,
      status: "accepted",
      source: "tool",
    });
    expect(edge?.confidence).toBeGreaterThan(0);
    expect(edge?.confidence).toBeLessThan(1);
    expect(edge?.extensions?.["harness.semantic"]).toBeDefined();
  });

  it("rejects endpoint revision and semantic index drift", async () => {
    const first = await fixture();
    const firstBatch = await proposeSemanticImpactEdges(
      { projectRoot: first.projectRoot, readBaseline: () => headOf(first.projectRoot) },
      { sourceNodeIds: [first.source.id], actor: "human:local" },
    );
    const firstProposal = firstBatch.proposals.find(
      (entry) => entry.candidateNodeId === first.target.id,
    );
    if (firstProposal === undefined) throw new Error("semantic fixture produced no proposal");
    await appendNodes(first.projectRoot, [
      codeNode({
        id: first.source.id,
        path: "src/UserService.ts",
        iterationId: first.iterationId,
        revision: 2,
      }),
    ]);
    await expect(
      approveGraphEdge(
        { projectRoot: first.projectRoot, readBaseline: () => headOf(first.projectRoot) },
        {
          edgeId: firstProposal.edgeId,
          previewDigest: firstProposal.previewDigest,
          actor: "human:local",
        },
      ),
    ).rejects.toMatchObject<Partial<GraphEditError>>({ kind: "endpoint_revision_drift" });

    const second = await fixture();
    const secondBatch = await proposeSemanticImpactEdges(
      { projectRoot: second.projectRoot, readBaseline: () => headOf(second.projectRoot) },
      { sourceNodeIds: [second.source.id], actor: "human:local" },
    );
    const secondProposal = secondBatch.proposals.find(
      (entry) => entry.candidateNodeId === second.target.id,
    );
    if (secondProposal === undefined) throw new Error("semantic fixture produced no proposal");
    writeFileSync(
      join(second.projectRoot, "src", "UserService.ts"),
      "export class RenamedAccountService {}\n",
    );
    await expect(
      approveGraphEdge(
        { projectRoot: second.projectRoot, readBaseline: () => headOf(second.projectRoot) },
        {
          edgeId: secondProposal.edgeId,
          previewDigest: secondProposal.previewDigest,
          actor: "human:local",
        },
      ),
    ).rejects.toMatchObject<Partial<GraphEditError>>({ kind: "semantic_index_drift" });
  });
});
