import { afterEach, describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";
import {
  GRAPH_DATABASE_RELATIVE_PATH,
  LedgerRepository,
  PROTOCOL_VERSION,
  canonicalizeJson,
  contentDigest,
  harnessRootFor,
  resolveHarnessPath,
  type NodeRecord,
} from "@universal-harness-internal/core";
import { rebuildGraphCache } from "@universal-harness-internal/graph";
import {
  approvalRequestArtifact,
  buildApprovalRequest,
  createNewProject,
} from "@universal-harness-internal/runtime";

import { startDashboardServer, type DashboardServer } from "../src/index.js";

const servers: DashboardServer[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  const { rmSync } = await import("node:fs");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function managedProject(): Promise<string> {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const parent = mkdtempSync(join(tmpdir(), "harness-dashboard-"));
  roots.push(parent);
  const created = await createNewProject(
    { parentDirectory: parent, name: "dashboard-project", intent: "inspect the harness graph" },
    { vcs: createGitVcsAdapter() },
  );
  if (!created.ok) throw new Error(created.error.message);
  const sealNode = (content: Omit<NodeRecord, "digest">): NodeRecord => ({
    ...content,
    digest: contentDigest(content),
  });
  const timestamp = "2026-08-17T00:00:00.000Z";
  const evidence = sealNode({
    protocol_version: PROTOCOL_VERSION,
    record_kind: "node",
    id: "evidence_dashboard_01",
    type: "Evidence",
    revision: 1,
    status: "accepted",
    source: "gate",
    provenance: {
      iteration_id: created.value.iterationId,
      actor: "dashboard-test",
      timestamp,
    },
    confidence: 1,
    extensions: {
      "harness.gate": {
        gate_id: "gate_dashboard",
        passed: true,
        freshness: "fresh",
        provisional: false,
        summary: "Dashboard 展示层验证已通过。",
      },
    },
  });
  const finding = sealNode({
    protocol_version: PROTOCOL_VERSION,
    record_kind: "node",
    id: "finding_dashboard_01",
    type: "Finding",
    revision: 1,
    status: "proposed",
    source: "audit",
    provenance: {
      iteration_id: created.value.iterationId,
      actor: "dashboard-test",
      timestamp,
    },
    confidence: 1,
    extensions: {
      "harness.finding": {
        rule: "missing_verification",
        scope_prefix: `project/${created.value.repositoryId}/verification`,
        severity: "blocker",
        actionability: "human_review",
        subject_ids: [created.value.repositoryNodeId],
        subject_digests: [],
      },
      "harness.copy": { summary: "登录能力缺少验证证据。" },
    },
  });
  const approvalRequest = buildApprovalRequest({
    requestId: "approval_request_dashboard_01",
    workflowOperationId: created.value.workflowOperationId,
    objectId: created.value.repositoryNodeId,
    objectType: "RequirementBaseline",
    objectDigest: "a".repeat(64),
    baselineDigest: "b".repeat(64),
    policyDigest: "c".repeat(64),
    impactPath: [created.value.repositoryNodeId, "requirement_dashboard_01"],
    risk: "high",
    reason: "确认 Dashboard 权威审批队列能够在错过实时事件后恢复。",
    allowedDecisions: ["approve", "reject", "defer"],
    createdAt: timestamp,
    resumePhase: "capture",
    proposedBy: "agent:dashboard-fixture",
  });
  await new LedgerRepository({
    projectRoot: created.value.projectRoot,
    readBaseline: () => created.value.headCommit,
    now: () => timestamp,
  }).commit({
    ledger_operation_id: "ledger_dashboard_read_fixture",
    workflow_operation_id: created.value.workflowOperationId,
    attempt_id: "attempt_dashboard_read_fixture",
    expected_baseline: created.value.headCommit,
    artifacts: [
      ...[evidence, finding].map((node) => ({
        path: `artifacts/dashboard-fixtures/${node.id}.json`,
        content: `${canonicalizeJson(node)}\n`,
      })),
      approvalRequestArtifact(approvalRequest),
    ],
  });
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const proposalDirectory = resolveHarnessPath(
    harnessRootFor(created.value.projectRoot),
    "artifacts/edge-proposals",
  );
  mkdirSync(proposalDirectory, { recursive: true });
  writeFileSync(
    resolveHarnessPath(proposalDirectory, "edge_dashboard_proposal.json"),
    `${JSON.stringify({
      edge: {
        id: "edge_dashboard_proposal",
        source_id: created.value.repositoryNodeId,
        target_id: "component_dashboard",
      },
      preview_digest: "e".repeat(64),
      suggestion: {
        score: { millionths: 875_000 },
        reason: "代码仓库与 Dashboard 组件共享展示契约。",
      },
    })}\n`,
    "utf8",
  );
  const databasePath = resolveHarnessPath(
    harnessRootFor(created.value.projectRoot),
    GRAPH_DATABASE_RELATIVE_PATH,
  );
  rebuildGraphCache({ projectRoot: created.value.projectRoot, databasePath }).database.close();
  return created.value.projectRoot;
}

function cookieOf(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (value === null) throw new Error("session cookie missing");
  return value.split(";", 1)[0] ?? "";
}

async function authenticated(server: DashboardServer): Promise<string> {
  const exchange = await fetch(server.bootstrapUrl, { redirect: "manual" });
  expect(exchange.status).toBe(303);
  expect(exchange.headers.get("location")).toBe("/");
  return cookieOf(exchange);
}

describe("Dashboard server", () => {
  it("binds to loopback on a random port and exposes paged read APIs", async () => {
    const projectRoot = await managedProject();
    const server = await startDashboardServer({ projectRoot });
    servers.push(server);

    expect(server.host).toBe("127.0.0.1");
    expect(server.port).toBeGreaterThan(0);
    const cookie = await authenticated(server);

    const project = await fetch(`${server.origin}/api/v1/project`, {
      headers: { cookie },
    });
    expect(project.status).toBe(200);
    await expect(project.json()).resolves.toMatchObject({
      data: { name: "dashboard-project", graph_cache: "ok" },
    });

    const nodes = await fetch(`${server.origin}/api/v1/graph/nodes?limit=1`, {
      headers: { cookie },
    });
    expect(nodes.status).toBe(200);
    const nodePage = (await nodes.json()) as {
      data: {
        items: { id: string; digest: string; type: string; status: string }[];
        next_cursor?: string;
        presentations: Record<
          string,
          { entity_id: string; binding_digest: string; type_label_zh: string }
        >;
      };
    };
    expect(nodePage).toMatchObject({
      data: { items: [expect.objectContaining({ record_kind: "node" })] },
    });
    expect(nodePage.data.next_cursor).toEqual(expect.any(String));
    const firstNode = nodePage.data.items[0];
    if (firstNode === undefined) throw new Error("bootstrap node missing");
    expect(nodePage.data.presentations[`${firstNode.id}@${firstNode.digest}`]).toMatchObject({
      entity_id: firstNode.id,
      binding_digest: firstNode.digest,
      technical_type: firstNode.type,
      technical_status: firstNode.status,
    });

    const iterationPage = (await (
      await fetch(`${server.origin}/api/v1/graph/nodes?type=Iteration`, {
        headers: { cookie },
      })
    ).json()) as { data: { items: { id: string }[] } };
    const iterationId = iterationPage.data.items[0]?.id;
    if (iterationId === undefined) throw new Error("bootstrap Iteration missing");
    const iteration = await fetch(`${server.origin}/api/v1/iterations/${iterationId}`, {
      headers: { cookie },
    });
    expect(iteration.status).toBe(200);
    const iterationBody = (await iteration.json()) as {
      data: {
        iteration: { id: string; digest: string; type: string };
        graph: { rootId: string };
        evaluations: unknown[];
        presentations: Record<string, unknown>;
      };
    };
    expect(iterationBody).toMatchObject({
      data: {
        iteration: { id: iterationId, type: "Iteration" },
        graph: { rootId: iterationId },
        evaluations: [],
      },
    });
    expect(
      iterationBody.data.presentations[
        `${iterationBody.data.iteration.id}@${iterationBody.data.iteration.digest}`
      ],
    ).toMatchObject({
      entity_id: iterationId,
      technical_type: "Iteration",
    });

    const neighborhood = await fetch(
      `${server.origin}/api/v1/graph/neighborhood/${nodePage.data.items[0]?.id ?? "node_missing"}`,
      { headers: { cookie } },
    );
    expect(neighborhood.status).toBe(200);
    const neighborhoodBody = (await neighborhood.json()) as {
      data: {
        rootId: string;
        nodes: { id: string; digest: string }[];
        edges: { id: string; digest: string }[];
        presentations: Record<string, unknown>;
      };
    };
    expect(neighborhoodBody).toMatchObject({
      data: { rootId: nodePage.data.items[0]?.id },
    });
    for (const record of [...neighborhoodBody.data.nodes, ...neighborhoodBody.data.edges]) {
      expect(neighborhoodBody.data.presentations[`${record.id}@${record.digest}`]).toBeDefined();
    }

    const edges = await fetch(`${server.origin}/api/v1/graph/edges?limit=1`, {
      headers: { cookie },
    });
    expect(edges.status).toBe(200);
    const edgePage = (await edges.json()) as {
      data: {
        items: {
          id: string;
          digest: string;
          type: string;
          status: string;
          source_id: string;
          target_id: string;
        }[];
        presentations: Record<string, unknown>;
      };
    };
    expect(edgePage).toMatchObject({
      data: { items: [expect.objectContaining({ record_kind: "edge" })] },
    });
    const firstEdge = edgePage.data.items[0];
    if (firstEdge === undefined) throw new Error("bootstrap edge missing");
    expect(edgePage.data.presentations[`${firstEdge.id}@${firstEdge.digest}`]).toMatchObject({
      entity_id: firstEdge.id,
      binding_digest: firstEdge.digest,
      technical_type: firstEdge.type,
      technical_status: firstEdge.status,
    });
    const path = await fetch(
      `${server.origin}/api/v1/graph/path?from=${firstEdge.source_id}&to=${firstEdge.target_id}`,
      { headers: { cookie } },
    );
    expect(path.status).toBe(200);
    const pathBody = (await path.json()) as {
      data: {
        nodes: { id: string; digest: string }[];
        edges: { id: string; digest: string; source_id: string }[];
        presentations: Record<string, unknown>;
      };
    };
    expect(pathBody).toMatchObject({
      data: { edges: [expect.objectContaining({ source_id: firstEdge.source_id })] },
    });
    for (const record of [...pathBody.data.nodes, ...pathBody.data.edges]) {
      expect(pathBody.data.presentations[`${record.id}@${record.digest}`]).toBeDefined();
    }

    const evidence = await fetch(`${server.origin}/api/v1/evidence?limit=1`, {
      headers: { cookie },
    });
    expect(evidence.status).toBe(200);
    const evidenceBody = (await evidence.json()) as {
      data: {
        items: { id: string; digest: string }[];
        presentations: Record<string, unknown>;
      };
    };
    expect(evidenceBody.data.items).toHaveLength(1);
    const firstEvidence = evidenceBody.data.items[0];
    if (firstEvidence === undefined) throw new Error("Evidence fixture missing");
    expect(
      evidenceBody.data.presentations[`${firstEvidence.id}@${firstEvidence.digest}`],
    ).toMatchObject({ type_label_zh: "证据", status_label_zh: "已接受" });

    const findings = await fetch(`${server.origin}/api/v1/finding-groups`, {
      headers: { cookie },
    });
    expect(findings.status).toBe(200);
    const findingBody = (await findings.json()) as {
      data: {
        items: { group_id: string; membership_digest: string }[];
        presentations: Record<string, unknown>;
      };
    };
    expect(findingBody.data.items).toHaveLength(1);
    const firstFinding = findingBody.data.items[0];
    if (firstFinding === undefined) throw new Error("Finding fixture missing");
    expect(
      findingBody.data.presentations[`${firstFinding.group_id}@${firstFinding.membership_digest}`],
    ).toMatchObject({ title_zh: "缺少验证证据", status_label_zh: "待处理" });

    const semantic = await fetch(`${server.origin}/api/v1/semantic-proposals`, {
      headers: { cookie },
    });
    expect(semantic.status).toBe(200);
    const semanticBody = (await semantic.json()) as {
      data: {
        items: { edge_id: string; preview_digest: string }[];
        presentations: Record<string, unknown>;
      };
    };
    expect(semanticBody.data.items).toHaveLength(1);
    const firstProposal = semanticBody.data.items[0];
    if (firstProposal === undefined) throw new Error("Semantic proposal fixture missing");
    expect(
      semanticBody.data.presentations[`${firstProposal.edge_id}@${firstProposal.preview_digest}`],
    ).toMatchObject({ type_label_zh: "语义候选", status_label_zh: "待批准" });

    const approvals = await fetch(`${server.origin}/api/v1/approvals?limit=20`, {
      headers: { cookie },
    });
    expect(approvals.status).toBe(200);
    const approvalBody = (await approvals.json()) as {
      data: {
        items: {
          request_id: string;
          object_digest: string;
          workflow_operation_id: string;
        }[];
        presentations: Record<string, unknown>;
      };
    };
    expect(approvalBody.data.items).toEqual([
      expect.objectContaining({
        request_id: "approval_request_dashboard_01",
        object_digest: "a".repeat(64),
        workflow_operation_id: expect.any(String),
      }),
    ]);
    const firstApproval = approvalBody.data.items[0];
    if (firstApproval === undefined) throw new Error("Approval fixture missing");
    expect(
      approvalBody.data.presentations[`${firstApproval.request_id}@${firstApproval.object_digest}`],
    ).toMatchObject({
      entity_id: firstApproval.request_id,
      binding_digest: firstApproval.object_digest,
      type_label_zh: "审批请求",
      status_label_zh: "等待决策",
    });
  });

  it("returns typed problems for invalid limits, unknown nodes, and a damaged cache", async () => {
    const { writeFileSync } = await import("node:fs");
    const projectRoot = await managedProject();
    const server = await startDashboardServer({ projectRoot });
    servers.push(server);
    const cookie = await authenticated(server);

    const invalid = await fetch(`${server.origin}/api/v1/graph/nodes?limit=501`, {
      headers: { cookie },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("content-type")).toContain("application/problem+json");
    await expect(invalid.json()).resolves.toMatchObject({ code: "invalid_query", status: 400 });

    const missing = await fetch(`${server.origin}/api/v1/graph/neighborhood/node_missing`, {
      headers: { cookie },
    });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ code: "node_not_found" });

    const databasePath = resolveHarnessPath(
      harnessRootFor(projectRoot),
      GRAPH_DATABASE_RELATIVE_PATH,
    );
    writeFileSync(databasePath, "not sqlite", "utf8");
    const unavailable = await fetch(`${server.origin}/api/v1/graph/nodes`, {
      headers: { cookie },
    });
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toMatchObject({
      code: "graph_cache_unavailable",
      status: 503,
    });
  });
});
