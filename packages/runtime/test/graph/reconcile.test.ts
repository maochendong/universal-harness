import { afterEach, describe, expect, it } from "vitest";

import {
  GRAPH_DATABASE_RELATIVE_PATH,
  LedgerRepository,
  PROTOCOL_VERSION,
  canonicalizeJson,
  contentDigest,
  harnessRootFor,
  readCommittedOperations,
  resolveHarnessPath,
  sha256Hex,
  type EdgeRecord,
  type NodeRecord,
} from "@universal-harness-internal/core";
import {
  checkGraphCache,
  materializeLedger,
  pageEdges,
  pageNodes,
} from "@universal-harness-internal/graph";

import { createNewProject, hashWorktreeCode, reconcileProjectGraph } from "../../src/index.js";
import {
  FIXED_NOW,
  cleanupDirectories,
  headOf,
  makeTempDir,
  sequentialIds,
} from "../bootstrap/helpers.js";

afterEach(cleanupDirectories);

function node(input: {
  id: string;
  type: NodeRecord["type"];
  iterationId: string;
  source?: string;
  extensions?: Record<string, unknown>;
}): NodeRecord {
  const content: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "node",
    id: input.id,
    type: input.type,
    revision: 1,
    status: "accepted",
    source: input.source ?? "migration",
    provenance: { iteration_id: input.iterationId, actor: "test-fixture", timestamp: FIXED_NOW },
    confidence: 1,
    ...(input.extensions === undefined ? {} : { extensions: input.extensions }),
  };
  return { ...content, digest: contentDigest(content) } as unknown as NodeRecord;
}

function edge(input: {
  id: string;
  type: EdgeRecord["type"];
  sourceId: string;
  targetId: string;
  iterationId: string;
}): EdgeRecord {
  const content: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "edge",
    id: input.id,
    type: input.type,
    source_id: input.sourceId,
    target_id: input.targetId,
    status: "accepted",
    source: "migration",
    provenance: { iteration_id: input.iterationId, actor: "test-fixture", timestamp: FIXED_NOW },
    confidence: 1,
  };
  return { ...content, digest: contentDigest(content) } as unknown as EdgeRecord;
}

describe("reconcileProjectGraph", () => {
  it("repairs a legacy failed Run and missing Test evidence exactly once", async () => {
    const created = await createNewProject(
      {
        parentDirectory: makeTempDir("harness-reconcile-"),
        name: "legacy-project",
        intent: "repair the historical graph",
      },
      {
        vcs: (await import("@universal-harness-internal/adapter-vcs-git")).createGitVcsAdapter(),
        now: () => FIXED_NOW,
        newId: sequentialIds(),
      },
    );
    if (!created.ok) throw new Error(created.error.message);
    const projectRoot = created.value.projectRoot;
    const iterationId = created.value.iterationId;
    const harnessRoot = harnessRootFor(projectRoot);
    const operations = readCommittedOperations(harnessRoot);
    const latest = operations.at(-1);
    if (latest === undefined) throw new Error("bootstrap operation missing");

    const { database } = materializeLedger({ projectRoot, databasePath: ":memory:" });
    let repositoryId = "";
    const requirementId = "requirement_legacy";
    try {
      let cursor: string | undefined;
      do {
        const page = pageNodes(database, {
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });
        repositoryId ||= page.items.find((item) => item.type === "Repository")?.id ?? "";
        cursor = page.nextCursor;
      } while (cursor !== undefined);
    } finally {
      database.close();
    }
    if (repositoryId === "") throw new Error("bootstrap graph incomplete");

    const taskId = "task_legacy_failure";
    const runId = "run_legacy_failure";
    const testId = "test_legacy_verification";
    const evidenceId = "evidence_legacy_gate";
    const findingSummary = `accepted test ${testId} has no evidence verdict; run its gate before relying on it`;
    const findingId = `finding_audit-missing-verification-${sha256Hex(`missing_verification\n${findingSummary}`).slice(0, 16)}`;
    const failedResult = {
      outcome: "failed",
      termination_reason: "adapter_failure",
      completion_claimed: false,
      summary: "provider credential is missing",
      state_proposal: null,
      dropped_proposal_fields: [],
      change_summary: { files_changed: 0, insertions: 0, deletions: 0, paths: [] },
      tool_activity: { total_calls: 0, governed_calls: 0, by_tool: {} },
      usage: {
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        duration_ms: 1,
        metering: "unmetered",
      },
      evidence: [],
      undeclared_writes: [],
    };
    const records = [
      node({ id: requirementId, type: "Requirement", iterationId }),
      node({ id: taskId, type: "Task", iterationId }),
      node({ id: runId, type: "Run", iterationId }),
      node({ id: testId, type: "Test", iterationId }),
      node({
        id: evidenceId,
        type: "Evidence",
        iterationId,
        source: "gate",
        extensions: {
          "harness.evidence": {
            artifact_digest: "a".repeat(64),
            gate_id: "gate_legacy",
            passed: true,
            bindings: { code_digests: [hashWorktreeCode(projectRoot)] },
          },
        },
      }),
      node({
        id: findingId,
        type: "Finding",
        iterationId,
        source: "audit",
        extensions: {
          "harness.finding": { origin: "audit", blocking: true, blocks: [iterationId] },
          "harness.audit": { kind: "missing_verification", subjects: [testId] },
        },
      }),
    ];
    const relations = [
      edge({
        id: "edge_task_requirement",
        type: "IMPLEMENTS",
        sourceId: taskId,
        targetId: requirementId,
        iterationId,
      }),
      edge({
        id: "edge_test_requirement",
        type: "VERIFIES",
        sourceId: testId,
        targetId: requirementId,
        iterationId,
      }),
      edge({
        id: "edge_repository_test",
        type: "CONTAINS",
        sourceId: repositoryId,
        targetId: testId,
        iterationId,
      }),
      edge({
        id: "edge_finding_iteration",
        type: "BLOCKS",
        sourceId: findingId,
        targetId: iterationId,
        iterationId,
      }),
    ];
    const fixtureTransaction = {
      ledger_operation_id: "ledger_reconcile_fixture",
      workflow_operation_id: latest.manifest.workflow_operation_id,
      attempt_id: latest.manifest.attempt_id,
      expected_baseline: headOf(projectRoot),
      artifacts: [
        ...records.map((record) => ({
          path:
            record.type === "Requirement"
              ? `artifacts/requirements/${record.id}.json`
              : record.type === "Task"
                ? `artifacts/tasks/${record.id}.json`
                : record.type === "Run"
                  ? `artifacts/run-nodes/${record.id}.json`
                  : record.type === "Test"
                    ? `artifacts/tests/${record.id}.json`
                    : record.type === "Evidence"
                      ? `artifacts/evidence-nodes/${record.id}/1.json`
                      : `artifacts/finding-nodes/${record.id}/1.json`,
          content: `${canonicalizeJson(record)}\n`,
        })),
        {
          path: `artifacts/runs/${runId}/0001-run_started.json`,
          content: `${canonicalizeJson({
            protocol_version: PROTOCOL_VERSION,
            record_kind: "run_started",
            run_id: runId,
            task_id: taskId,
            workflow_operation_id: latest.manifest.workflow_operation_id,
            attempt_id: latest.manifest.attempt_id,
            sequence: 1,
            timestamp: FIXED_NOW,
            context_bundle_id: "context_bundle_fixture",
          })}\n`,
        },
        {
          path: `artifacts/runs/${runId}/0002-run_terminated.json`,
          content: `${canonicalizeJson({
            protocol_version: PROTOCOL_VERSION,
            record_kind: "run_terminated",
            run_id: runId,
            task_id: taskId,
            workflow_operation_id: latest.manifest.workflow_operation_id,
            attempt_id: latest.manifest.attempt_id,
            sequence: 2,
            timestamp: FIXED_NOW,
            outcome: "failed",
            termination_reason: "adapter_failure",
          })}\n`,
        },
        {
          path: `artifacts/run-results/${runId}.json`,
          content: `${canonicalizeJson(failedResult)}\n`,
        },
      ],
      edges: relations,
      events: [],
    };
    try {
      await new LedgerRepository({ projectRoot, readBaseline: () => headOf(projectRoot) }).commit(
        fixtureTransaction,
      );
    } catch (error) {
      const issues = (error as { issues?: unknown }).issues;
      throw new Error(`fixture transaction failed: ${JSON.stringify(issues)}`, { cause: error });
    }

    const first = await reconcileProjectGraph({
      projectRoot,
      readBaseline: () => headOf(projectRoot),
      now: () => FIXED_NOW,
    });
    expect(first).toMatchObject({ evaluations: 1, findings_superseded: 1, skipped: [] });

    const materialized = materializeLedger({ projectRoot, databasePath: ":memory:" }).database;
    try {
      const nodes: NodeRecord[] = [];
      const edges: EdgeRecord[] = [];
      let nodeCursor: string | undefined;
      do {
        const page = pageNodes(materialized, {
          limit: 100,
          ...(nodeCursor === undefined ? {} : { cursor: nodeCursor }),
        });
        nodes.push(...page.items);
        nodeCursor = page.nextCursor;
      } while (nodeCursor !== undefined);
      let edgeCursor: string | undefined;
      do {
        const page = pageEdges(materialized, {
          limit: 100,
          ...(edgeCursor === undefined ? {} : { cursor: edgeCursor }),
        });
        edges.push(...page.items);
        edgeCursor = page.nextCursor;
      } while (edgeCursor !== undefined);
      expect(
        edges.some(
          (item) =>
            item.type === "EXECUTES" && item.source_id === runId && item.target_id === taskId,
        ),
      ).toBe(true);
      expect(
        edges.some(
          (item) =>
            item.type === "SUPPORTS" && item.source_id === evidenceId && item.target_id === testId,
        ),
      ).toBe(true);
      expect(edges.some((item) => item.type === "EVALUATES" && item.target_id === runId)).toBe(
        true,
      );
      expect(
        nodes.some((item) => item.type === "EvaluationCase" && item.status === "accepted"),
      ).toBe(true);
    } finally {
      materialized.close();
    }

    const second = await reconcileProjectGraph({
      projectRoot,
      readBaseline: () => headOf(projectRoot),
      now: () => FIXED_NOW,
    });
    expect(second).toMatchObject({
      nodes: 0,
      edges: 0,
      revisions: 0,
      evaluations: 0,
      evidence_links: 0,
      findings_superseded: 0,
      skipped: [],
    });
    expect(checkGraphCache(resolveHarnessPath(harnessRoot, GRAPH_DATABASE_RELATIVE_PATH))).toEqual({
      status: "ok",
    });
  });
});
