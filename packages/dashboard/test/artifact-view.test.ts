import { afterEach, describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";
import {
  GRAPH_DATABASE_RELATIVE_PATH,
  LedgerRepository,
  canonicalizeJson,
  harnessRootFor,
  resolveHarnessPath,
  sha256Hex,
} from "@universal-harness-internal/core";
import { rebuildGraphCache } from "@universal-harness-internal/graph";
import {
  approvalDecisionArtifact,
  buildApprovalDecision,
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

const FIXED_NOW = "2026-09-08T00:00:00.000Z";
const semantic = (seed: string): string => sha256Hex(`dashboard-artifact:${seed}`);

interface CommittedFixture {
  readonly projectRoot: string;
  readonly headCommit: string;
  readonly planDigest: string;
  readonly verifyDigest: string;
  readonly evidenceDigest: string;
  readonly runDigest: string;
  readonly decisionDigest: string;
  readonly findingManifestDigest: string;
  readonly findingEvidenceDigest: string;
}

const LONG_RUN_SUMMARY = `运行摘要🔧：${"门禁与评估全部通过，迭代收尾。".repeat(700)}`;

async function fixture(): Promise<CommittedFixture> {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const parent = mkdtempSync(join(tmpdir(), "harness-dashboard-artifact-"));
  roots.push(parent);
  const created = await createNewProject(
    { parentDirectory: parent, name: "dashboard-artifact", intent: "versioned artifact reads" },
    { vcs: createGitVcsAdapter() },
  );
  if (!created.ok) throw new Error(created.error.message);
  const projectRoot = created.value.projectRoot;
  const file = (path: string, record: unknown): { path: string; content: string } => ({
    path,
    content: `${canonicalizeJson(record)}\n`,
  });

  const provenance = {
    iteration_id: created.value.iterationId,
    actor: "dashboard-artifact-test",
    timestamp: FIXED_NOW,
  };
  const plan = file("artifacts/plans/plan_dash.json", {
    protocol_version: "1.1.0",
    record_kind: "node",
    id: "plan_dash",
    type: "ExecutionPlan",
    revision: 1,
    status: "accepted",
    source: "workflow",
    provenance,
    confidence: 1,
    digest: semantic("plan"),
    extensions: {
      "harness.plan": { mode: "agent", shared_context: { goal: "旧版迭代计划" } },
    },
  });
  const task = file("artifacts/tasks/task_dash1.json", {
    protocol_version: "1.1.0",
    record_kind: "node",
    id: "task_dash1",
    type: "Task",
    revision: 1,
    status: "accepted",
    source: "workflow",
    provenance,
    confidence: 1,
    digest: semantic("task"),
    extensions: { "harness.plan": { objective: "实现订单接口" } },
  });
  const verifyResults = Array.from({ length: 25 }, (_, index) => ({
    gate_id: `gate_${String(index).padStart(2, "0")}`,
    passed: index % 2 === 0,
    evidence_id: `evidence_${String(index).padStart(2, "0")}`,
    summary: `门禁 ${String(index)}`,
  }));
  const verify = file(`artifacts/verify/${created.value.iterationId}/${semantic("verify")}.json`, {
    record_kind: "orchestration_verify_result",
    iteration_id: created.value.iterationId,
    bindings: { artifact_digests: [], code_digests: [], evaluation_case_digests: [] },
    results: verifyResults,
    findings: [],
    completed_allowed: false,
  });
  const evidence = file(`artifacts/evidence/evidence_dash/${semantic("evidence")}.json`, {
    protocol_version: "1.1.0",
    record_kind: "evidence",
    evidence_id: "evidence_dash",
    evidence_type: "gate_run",
    subject_id: "task_dash1",
    digest: semantic("evidence"),
    provisional: false,
    created_at: FIXED_NOW,
    extensions: {
      "harness.gate": { gate_id: "gate_00", passed: true, summary: "通过", log_summary: "ok" },
    },
  });
  const run = file("artifacts/run-results/run_dash.json", {
    outcome: "handoff",
    termination_reason: "completion",
    completion_claimed: true,
    summary: LONG_RUN_SUMMARY,
    state_proposal: { raw_prompt: "提示词原文" },
    dropped_proposal_fields: [],
    change_summary: { files_changed: 1, insertions: 3, deletions: 0, paths: ["src/order.ts"] },
    tool_activity: { total_calls: 1, governed_calls: 1, by_tool: {} },
    usage: {
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      duration_ms: 10,
      metering: "unmetered",
    },
    evidence: [],
    undeclared_writes: [],
  });
  const decision = approvalDecisionArtifact(
    buildApprovalDecision({
      approvalId: "approval_dash1",
      requestId: "approval-request_dash1",
      actor: "user:carol@example.com",
      decision: "approve",
      objectDigest: semantic("object"),
      decidedAt: FIXED_NOW,
    }),
  );

  const commit = async (
    tag: string,
    artifacts: readonly { path: string; content: string }[],
  ): Promise<string> => {
    const result = await new LedgerRepository({
      projectRoot,
      readBaseline: () => created.value.headCommit,
      now: () => FIXED_NOW,
    }).commit({
      ledger_operation_id: `ledger_dash_${tag}`,
      workflow_operation_id: created.value.workflowOperationId,
      attempt_id: "attempt_dash_fixture",
      expected_baseline: created.value.headCommit,
      artifacts,
      edges: [],
      events: [],
    });
    if (result.status !== "committed") throw new Error(`fixture commit failed: ${tag}`);
    return result.manifest.digest;
  };
  await commit("plan", [plan, task]);
  await commit("verify", [verify, evidence]);
  await commit("run", [run]);
  await commit("decision", [decision]);

  const finding = file("artifacts/findings/finding_dash/proposed.json", {
    protocol_version: "1.1.0",
    record_kind: "feedback",
    id: "finding_dash",
    type: "Finding",
    iteration_id: created.value.iterationId,
    status: "proposed",
    summary: "缺少验证证据",
    created_at: FIXED_NOW,
    digest: semantic("finding"),
    extensions: { "harness.finding": { rule: "missing_verification", severity: "warning" } },
  });
  const findingEvidence = file(`artifacts/evidence/evidence_dash2/${semantic("evidence2")}.json`, {
    protocol_version: "1.1.0",
    record_kind: "evidence",
    evidence_id: "evidence_dash2",
    evidence_type: "gate_run",
    subject_id: "task_dash1",
    digest: semantic("evidence2"),
    provisional: false,
    created_at: FIXED_NOW,
  });
  const findingManifestDigest = await commit("findings", [finding, findingEvidence]);

  const databasePath = resolveHarnessPath(
    harnessRootFor(projectRoot),
    GRAPH_DATABASE_RELATIVE_PATH,
  );
  rebuildGraphCache({ projectRoot, databasePath }).database.close();
  // Keep the linters honest about the helper import being available.
  void writeFileSync;
  return {
    projectRoot,
    headCommit: created.value.headCommit,
    planDigest: sha256Hex(plan.content),
    verifyDigest: sha256Hex(verify.content),
    evidenceDigest: sha256Hex(evidence.content),
    runDigest: sha256Hex(run.content),
    decisionDigest: sha256Hex(decision.content),
    findingManifestDigest,
    findingEvidenceDigest: sha256Hex(findingEvidence.content),
  };
}

async function authenticated(server: DashboardServer): Promise<string> {
  const exchange = await fetch(server.bootstrapUrl, { redirect: "manual" });
  expect(exchange.status).toBe(303);
  return (exchange.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
}

interface ArtifactResponse {
  readonly status: number;
  readonly body: {
    readonly data?: {
      readonly ref: { kind: string; scope: string; digest: string };
      readonly provenance: {
        ledger_operation_id: string;
        manifest_digest: string;
        input_refs: { kind: string; scope: string; digest: string }[];
      };
      readonly content: Record<string, unknown>;
      readonly safe_view: boolean;
      readonly next_cursor?: string;
      readonly presentations: Record<
        string,
        { artifact_links?: { label_zh: string; href: string }[] }
      >;
    };
    readonly code?: string;
  };
  readonly bytes: number;
}

async function readArtifact(
  server: DashboardServer,
  cookie: string,
  digest: string,
  query: string,
): Promise<ArtifactResponse> {
  const response = await fetch(`${server.origin}/api/v1/artifacts/${digest}?${query}`, {
    headers: { cookie },
  });
  const text = await response.text();
  return {
    status: response.status,
    body: JSON.parse(text) as ArtifactResponse["body"],
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

describe("Dashboard artifact read API", () => {
  it("serves the pinned plan version with provenance and a safe view", async () => {
    const fx = await fixture();
    const server = await startDashboardServer({ projectRoot: fx.projectRoot });
    servers.push(server);
    const cookie = await authenticated(server);

    const response = await readArtifact(server, cookie, fx.planDigest, "kind=plan&scope=artifact");
    expect(response.status).toBe(200);
    const data = response.body.data!;
    expect(data.safe_view).toBe(true);
    expect(data.ref).toEqual({ kind: "plan", scope: "artifact", digest: fx.planDigest });
    expect(data.content["plan_id"]).toBe("plan_dash");
    expect(data.content["summary"]).toBe("旧版迭代计划");
    expect(data.provenance.manifest_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(response.body)).not.toContain("user:carol@example.com");
  });

  it("links a gate result view to its committed evidence inputs", async () => {
    const fx = await fixture();
    const server = await startDashboardServer({ projectRoot: fx.projectRoot });
    servers.push(server);
    const cookie = await authenticated(server);

    const response = await readArtifact(
      server,
      cookie,
      fx.verifyDigest,
      "kind=gate_result&scope=artifact&limit=5",
    );
    expect(response.status).toBe(200);
    const data = response.body.data!;
    expect(data.provenance.input_refs).toEqual([
      { kind: "evidence", scope: "artifact", digest: fx.evidenceDigest },
    ]);
    const presentation = Object.values(data.presentations)[0];
    expect(presentation?.artifact_links).toEqual([
      expect.objectContaining({
        href: `/api/v1/artifacts/${fx.evidenceDigest}?kind=evidence&scope=artifact`,
      }),
    ]);
    expect(response.bytes).toBeLessThanOrEqual(256 * 1024);
  });

  it("rejects unknown kinds, scope mismatches, bad limits and unknown query keys", async () => {
    const fx = await fixture();
    const server = await startDashboardServer({ projectRoot: fx.projectRoot });
    servers.push(server);
    const cookie = await authenticated(server);

    for (const query of [
      "kind=raw_log&scope=artifact",
      "kind=finding_group&scope=artifact",
      "kind=plan&scope=manifest",
      "kind=plan&scope=artifact&limit=0",
      "kind=plan&scope=artifact&limit=101",
      "kind=plan&scope=artifact&cursor=bogus",
      "kind=plan&scope=artifact&path=artifacts/plans/plan_dash.json",
    ]) {
      const response = await readArtifact(server, cookie, fx.planDigest, query);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("invalid_query");
    }
    const missing = await readArtifact(server, cookie, fx.planDigest, "scope=artifact");
    expect(missing.status).toBe(400);
  });

  it("rejects path-shaped digests at the route boundary", async () => {
    const fx = await fixture();
    const server = await startDashboardServer({ projectRoot: fx.projectRoot });
    servers.push(server);
    const cookie = await authenticated(server);

    for (const target of [
      "/api/v1/artifacts/..%2Fsecret?kind=plan&scope=artifact",
      "/api/v1/artifacts/abcd?kind=plan&scope=artifact",
      "/api/v1/artifacts/" + "A".repeat(64) + "?kind=plan&scope=artifact",
    ]) {
      const response = await fetch(`${server.origin}${target}`, { headers: { cookie } });
      expect(response.status).toBe(404);
    }
  });

  it("returns 404 for digests no committed manifest carries", async () => {
    const fx = await fixture();
    const server = await startDashboardServer({ projectRoot: fx.projectRoot });
    servers.push(server);
    const cookie = await authenticated(server);

    const response = await readArtifact(
      server,
      cookie,
      semantic("never-committed"),
      "kind=plan&scope=artifact",
    );
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("artifact_not_found");
  });

  it("fails closed with 422 when committed bytes were replaced", async () => {
    const fx = await fixture();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      resolveHarnessPath(
        harnessRootFor(fx.projectRoot),
        `artifacts/evidence/evidence_dash/${semantic("evidence")}.json`,
      ),
      `${JSON.stringify({ tampered: true })}\n`,
    );
    const server = await startDashboardServer({ projectRoot: fx.projectRoot });
    servers.push(server);
    const cookie = await authenticated(server);

    const response = await readArtifact(
      server,
      cookie,
      fx.evidenceDigest,
      "kind=evidence&scope=artifact",
    );
    expect(response.status).toBe(422);
    expect(response.body.code).toBe("artifact_unverified");
  });

  it("pages collections with limit bounds and a stable digest", async () => {
    const fx = await fixture();
    const server = await startDashboardServer({ projectRoot: fx.projectRoot });
    servers.push(server);
    const cookie = await authenticated(server);

    const first = await readArtifact(
      server,
      cookie,
      fx.verifyDigest,
      "kind=gate_result&scope=artifact",
    );
    expect(first.status).toBe(200);
    const firstData = first.body.data!;
    const results = firstData.content["results"] as { items: unknown[]; total: number };
    expect(results.items).toHaveLength(20);
    expect(results.total).toBe(25);
    expect(firstData.next_cursor).toBeDefined();

    const second = await readArtifact(
      server,
      cookie,
      fx.verifyDigest,
      `kind=gate_result&scope=artifact&cursor=${firstData.next_cursor}`,
    );
    expect(second.status).toBe(200);
    expect(second.body.data!.ref.digest).toBe(fx.verifyDigest);
    expect((second.body.data!.content["results"] as { items: unknown[] }).items).toHaveLength(5);
    expect(second.body.data!.next_cursor).toBeUndefined();
  });

  it("pages long run summaries in 8 KiB UTF-8-safe fragments", async () => {
    const fx = await fixture();
    const server = await startDashboardServer({ projectRoot: fx.projectRoot });
    servers.push(server);
    const cookie = await authenticated(server);
    expect(Buffer.byteLength(LONG_RUN_SUMMARY, "utf8")).toBeGreaterThan(8 * 1024);

    let cursor: string | undefined;
    let assembled = "";
    let pages = 0;
    do {
      const suffix = cursor === undefined ? "" : `&cursor=${cursor}`;
      const page: ArtifactResponse = await readArtifact(
        server,
        cookie,
        fx.runDigest,
        `kind=run_summary&scope=artifact${suffix}`,
      );
      expect(page.status).toBe(200);
      expect(page.body.data!.ref.digest).toBe(fx.runDigest);
      const content = page.body.data!.content as { summary: string };
      expect(Buffer.byteLength(content.summary, "utf8")).toBeLessThanOrEqual(8 * 1024);
      assembled += content.summary;
      cursor = page.body.data!.next_cursor;
      pages += 1;
    } while (cursor !== undefined);
    expect(pages).toBeGreaterThan(1);
    expect(assembled).toBe(LONG_RUN_SUMMARY);
  });

  it("keeps approval decisions on the shared redacted summary reader", async () => {
    const fx = await fixture();
    const server = await startDashboardServer({ projectRoot: fx.projectRoot });
    servers.push(server);
    const cookie = await authenticated(server);

    const response = await readArtifact(
      server,
      cookie,
      fx.decisionDigest,
      "kind=approval_decision&scope=artifact",
    );
    expect(response.status).toBe(200);
    const content = response.body.data!.content;
    expect(content["decision"]).toBe("approve");
    expect(content["actor_display"]).toMatch(/^审批者[0-9a-f]{12}$/u);
    expect(JSON.stringify(response.body)).not.toContain("user:carol@example.com");
  });

  it("reads a derived finding group at manifest scope with its input refs", async () => {
    const fx = await fixture();
    const server = await startDashboardServer({ projectRoot: fx.projectRoot });
    servers.push(server);
    const cookie = await authenticated(server);

    const response = await readArtifact(
      server,
      cookie,
      fx.findingManifestDigest,
      "kind=finding_group&scope=manifest",
    );
    expect(response.status).toBe(200);
    const data = response.body.data!;
    const findings = data.content["findings"] as { items: { finding_id: string }[] };
    expect(findings.items.map((item) => item.finding_id)).toEqual(["finding_dash"]);
    expect(data.provenance.input_refs).toEqual([
      { kind: "evidence", scope: "artifact", digest: fx.findingEvidenceDigest },
    ]);
  });
});
