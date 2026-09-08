import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "../../adapters/vcs-git/src/index.js";
import {
  GRAPH_DATABASE_RELATIVE_PATH,
  LedgerRepository,
  canonicalizeJson,
  harnessRootFor,
  resolveHarnessPath,
  sha256Hex,
} from "../../packages/core/src/index.js";
import { rebuildGraphCache } from "../../packages/graph/src/index.js";
import { startDashboardServer, type DashboardServer } from "../../packages/dashboard/src/index.js";
import { createNewProject } from "../../packages/runtime/src/index.js";

/**
 * Artifact read security boundaries (transparency spec §9.2/§10): the
 * controlled endpoint never accepts client paths, never confuses semantic
 * digests with committed byte digests, never follows symlinks out of the
 * harness tree, redacts resolved env secrets, and fails closed on tampering.
 */

const roots: string[] = [];
const servers: DashboardServer[] = [];
const FIXED_NOW = "2026-09-08T00:00:00.000Z";
const SECRET_NAME = "HARNESS_DASHBOARD_BOUNDARY_SECRET";
const SECRET_VALUE = "sk-boundary-9f8e7d6c5b4a";

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env[SECRET_NAME];
});

interface BoundaryFixture {
  readonly projectRoot: string;
  readonly planByteDigest: string;
  readonly planSemanticDigest: string;
  readonly runByteDigest: string;
}

async function fixture(): Promise<BoundaryFixture> {
  const parent = mkdtempSync(join(tmpdir(), "harness-artifact-boundary-"));
  roots.push(parent);
  const created = await createNewProject(
    { parentDirectory: parent, name: "artifact-boundary", intent: "verify read boundaries" },
    { vcs: createGitVcsAdapter() },
  );
  if (!created.ok) throw new Error(created.error.message);
  const projectRoot = created.value.projectRoot;
  const provenance = {
    iteration_id: created.value.iterationId,
    actor: "boundary-test",
    timestamp: FIXED_NOW,
  };
  // The semantic digest is deliberately valid hex but is NOT the committed
  // byte digest of the artifact file.
  const planSemanticDigest = sha256Hex("semantic:plan-boundary");
  const planRecord = {
    protocol_version: "1.1.0",
    record_kind: "node",
    id: "plan_boundary",
    type: "ExecutionPlan",
    revision: 1,
    status: "accepted",
    source: "workflow",
    provenance,
    confidence: 1,
    digest: planSemanticDigest,
    extensions: { "harness.plan": { mode: "agent", shared_context: { goal: "边界验证计划" } } },
  };
  const planContent = `${canonicalizeJson(planRecord)}\n`;
  const runRecord = {
    outcome: "handoff",
    termination_reason: "completion",
    completion_claimed: true,
    // The whitelisted summary field carries the resolved secret value; the raw
    // record references its $env source, so the reader must redact it.
    summary: `部署使用凭据 ${SECRET_VALUE} 完成`,
    state_proposal: { raw_prompt: "部署提示词", token: { $env: SECRET_NAME } },
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
  const runContent = `${canonicalizeJson(runRecord)}\n`;
  const repository = new LedgerRepository({
    projectRoot,
    readBaseline: () => created.value.headCommit,
    now: () => FIXED_NOW,
  });
  const committed = await repository.commit({
    ledger_operation_id: "ledger_boundary_01",
    workflow_operation_id: created.value.workflowOperationId,
    attempt_id: "attempt_boundary",
    expected_baseline: created.value.headCommit,
    artifacts: [
      { path: "artifacts/plans/plan_boundary.json", content: planContent },
      { path: "artifacts/run-results/run_boundary.json", content: runContent },
    ],
    edges: [],
    events: [],
  });
  if (committed.status !== "committed") throw new Error("boundary fixture commit failed");
  rebuildGraphCache({
    projectRoot,
    databasePath: resolveHarnessPath(harnessRootFor(projectRoot), GRAPH_DATABASE_RELATIVE_PATH),
  }).database.close();
  return {
    projectRoot,
    planByteDigest: sha256Hex(planContent),
    planSemanticDigest,
    runByteDigest: sha256Hex(runContent),
  };
}

async function cookie(server: DashboardServer): Promise<string> {
  const exchange = await fetch(server.bootstrapUrl, { redirect: "manual" });
  expect(exchange.status).toBe(303);
  return (exchange.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
}

async function readArtifact(
  server: DashboardServer,
  cookieHeader: string,
  digest: string,
  query: string,
): Promise<{ status: number; text: string }> {
  const response = await fetch(`${server.origin}/api/v1/artifacts/${digest}?${query}`, {
    headers: { cookie: cookieHeader },
  });
  return { status: response.status, text: await response.text() };
}

describe("Dashboard artifact read boundaries", () => {
  it("requires authentication before any artifact byte is served", async () => {
    const fx = await fixture();
    const server = await startDashboardServer({ projectRoot: fx.projectRoot });
    servers.push(server);

    const response = await fetch(
      `${server.origin}/api/v1/artifacts/${fx.planByteDigest}?kind=plan&scope=artifact`,
      { redirect: "manual" },
    );
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("边界验证计划");
  });

  it("never accepts the artifact's semantic digest as its byte reference", async () => {
    const fx = await fixture();
    const server = await startDashboardServer({ projectRoot: fx.projectRoot });
    servers.push(server);
    const auth = await cookie(server);

    const response = await readArtifact(
      server,
      auth,
      fx.planSemanticDigest,
      "kind=plan&scope=artifact",
    );
    expect(response.status).toBe(404);
    expect(response.text).not.toContain("边界验证计划");
  });

  it("fails closed when a committed artifact is replaced by a symlink to outside bytes", async () => {
    const fx = await fixture();
    // Attacker primitive: swap the committed file for a symlink to an outside
    // secret file. The reader must refuse, never serve the target bytes.
    const outside = join(fx.projectRoot, "..", "outside-secret.txt");
    writeFileSync(outside, "OUTSIDE-SECRET-CONTENT");
    const harnessPlan = resolveHarnessPath(
      harnessRootFor(fx.projectRoot),
      "artifacts/plans/plan_boundary.json",
    );
    rmSync(harnessPlan);
    symlinkSync(outside, harnessPlan);

    const server = await startDashboardServer({ projectRoot: fx.projectRoot });
    servers.push(server);
    const auth = await cookie(server);

    const response = await readArtifact(
      server,
      auth,
      fx.planByteDigest,
      "kind=plan&scope=artifact",
    );
    expect(response.status).toBe(422);
    expect(response.text).not.toContain("OUTSIDE-SECRET-CONTENT");
  });

  it("redacts resolved env secrets from the served safe view", async () => {
    process.env[SECRET_NAME] = SECRET_VALUE;
    const fx = await fixture();
    const server = await startDashboardServer({ projectRoot: fx.projectRoot });
    servers.push(server);
    const auth = await cookie(server);

    const response = await readArtifact(
      server,
      auth,
      fx.runByteDigest,
      "kind=run_summary&scope=artifact",
    );
    expect(response.status).toBe(200);
    expect(response.text).not.toContain(SECRET_VALUE);
    // The omitted raw prompt is named with its reason, never served.
    expect(response.text).toContain("state_proposal");
    expect(response.text).not.toContain("raw_prompt");
  });

  it("refuses kind confusion: evidence bytes are never served as a plan", async () => {
    const fx = await fixture();
    const server = await startDashboardServer({ projectRoot: fx.projectRoot });
    servers.push(server);
    const auth = await cookie(server);

    const confused = await readArtifact(server, auth, fx.runByteDigest, "kind=plan&scope=artifact");
    expect(confused.status).toBe(422);
    expect(confused.text).not.toContain("部署使用凭据");
  });
});
