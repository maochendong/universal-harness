import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { createGitVcsAdapter } from "../../adapters/vcs-git/src/index.js";
import {
  GRAPH_DATABASE_RELATIVE_PATH,
  LedgerRepository,
  canonicalizeJson,
  harnessRootFor,
  resolveHarnessPath,
  sha256Hex,
  transactionRequiredReaderVersion,
  type LifecycleEvent,
} from "../../packages/core/src/index.js";
import { startDashboardServer, type DashboardServer } from "../../packages/dashboard/src/index.js";
import { rebuildGraphCache } from "../../packages/graph/src/index.js";
import {
  approvalDecisionArtifact,
  buildApprovalDecision,
  createNewProject,
} from "../../packages/runtime/src/index.js";

/**
 * Transparency e2e (spec §9.2/§9.3, plan Task 5 Step 5): the browser subscribes
 * to the unified stream, sees one "查看对应版本产出" link per committed
 * ArtifactAvailable announcement, and clicking a link opens exactly that
 * committed version's safe view. Legacy fallback, unknown event types, stream
 * reset replay and forged hrefs are covered with routed streams.
 */

const FIXED_NOW = "2026-09-08T00:00:00.000Z";
const semantic = (seed: string): string => sha256Hex(`transparency-e2e:${seed}`);

interface FixtureFile {
  readonly path: string;
  readonly content: string;
}

interface TransparencyFixture {
  readonly server: DashboardServer;
  readonly projectRoot: string;
  readonly workflowOperationId: string;
  /** Committed byte digest per artifact-scope kind (finding_group: manifest). */
  readonly digests: Readonly<Record<string, string>>;
  readonly findingManifestDigest: string;
}

function head(projectRoot: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
}

function artifactEventSpec(
  kind: string,
  recordDigest: string,
): { readonly eventType: string; readonly payload: Record<string, unknown> } {
  return {
    eventType: "ArtifactAvailable",
    payload: {
      artifact_kind: kind,
      record_digest: recordDigest,
      summary: `透明化夹具产出 ${kind}`,
    },
  };
}

async function buildFixture(): Promise<TransparencyFixture & { readonly parent: string }> {
  const parent = mkdtempSync(join(tmpdir(), "harness-dashboard-transparency-"));
  const created = await createNewProject(
    {
      parentDirectory: parent,
      name: "transparency",
      intent: "prove versioned artifact navigation",
    },
    { vcs: createGitVcsAdapter() },
  );
  if (!created.ok) throw new Error(created.error.message);
  const projectRoot = created.value.projectRoot;
  const workflowOperationId = created.value.workflowOperationId;
  const iterationId = created.value.iterationId;
  const baseline = (): string => head(projectRoot);
  const provenance = { iteration_id: iterationId, actor: "transparency-e2e", timestamp: FIXED_NOW };
  const file = (path: string, record: unknown): FixtureFile => ({
    path,
    content: `${canonicalizeJson(record)}\n`,
  });
  const node = (
    id: string,
    type: string,
    extensions: Record<string, unknown>,
  ): Record<string, unknown> => ({
    protocol_version: "1.1.0",
    record_kind: "node",
    id,
    type,
    revision: 1,
    status: "accepted",
    source: "workflow",
    provenance,
    confidence: 1,
    digest: semantic(id),
    extensions,
  });

  const decision = approvalDecisionArtifact(
    buildApprovalDecision({
      approvalId: "approval_e2e1",
      requestId: "approval-request_e2e1",
      actor: "user:dana@example.com",
      decision: "approve",
      objectDigest: semantic("object"),
      decidedAt: FIXED_NOW,
    }),
  );
  const prd = file("artifacts/capture/accepted/prd_e2e/1.json", {
    protocol_version: "1.1.0",
    record_kind: "accepted_prd",
    prd_id: "prd_e2e",
    revision: 1,
    session_id: "capture-session_e2e",
    workflow_operation_id: workflowOperationId,
    proposal_id: "prd-proposal_e2e",
    proposal_content_digest: semantic("proposal-content"),
    proposal_context_bundle_digest: semantic("proposal-bundle"),
    review_context_bundle_digest: semantic("review-bundle"),
    validation_report_digest: semantic("validation"),
    review_report_digest: semantic("review"),
    risk_assessment_digest: semantic("risk"),
    capture_policy_digest: semantic("capture-policy"),
    policy_digest: semantic("policy"),
    approval_digest: semantic("approval"),
    requirement_baseline_digest: semantic("baseline"),
    record_digest: semantic("prd"),
  });
  const designSet = file("artifacts/design-sets/design-set_e2e/1.json", {
    ...node("design-set_e2e", "DesignSet", {
      "harness.design.set": {
        content: { rationale: "设计集叙事透明化" },
        content_digest: semantic("design-content"),
        approval_digest: semantic("design-approval"),
      },
    }),
  });
  const plan = file("artifacts/plans/plan_e2e.json", {
    ...node("plan_e2e", "ExecutionPlan", {
      "harness.plan": { mode: "agent", shared_context: { goal: "透明化迭代计划目标" } },
    }),
  });
  const task = file("artifacts/tasks/task_e2e1.json", {
    ...node("task_e2e1", "Task", { "harness.plan": { objective: "实现订单接口" } }),
  });
  const bundle = file("artifacts/context-bundles/bundle_e2e.json", {
    protocol_version: "1.1.0",
    record_kind: "context_bundle",
    context_bundle_id: "bundle_e2e",
    task_id: "task_e2e1",
    source_digests: [semantic("source-a"), semantic("source-b")],
    digest: semantic("bundle"),
    stale: false,
    extensions: {
      "harness.context": { goal: "实现订单接口", included_tokens: 512, token_budget: 2048 },
    },
  });
  const run = file("artifacts/run-results/run_e2e.json", {
    outcome: "handoff",
    termination_reason: "completion",
    completion_claimed: true,
    summary: "任务完成：透明化运行摘要",
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
  const gateEvidence = file(`artifacts/evidence/evidence_e2e/${semantic("evidence")}.json`, {
    protocol_version: "1.1.0",
    record_kind: "evidence",
    evidence_id: "evidence_e2e",
    evidence_type: "gate_run",
    subject_id: "task_e2e1",
    digest: semantic("evidence"),
    provisional: false,
    created_at: FIXED_NOW,
    extensions: {
      "harness.gate": {
        gate_id: "gate_unit",
        passed: true,
        summary: "证据摘要透明化",
        log_summary: "12/12 passed",
      },
    },
  });
  const verify = file(`artifacts/verify/${iterationId}/${semantic("verify")}.json`, {
    record_kind: "orchestration_verify_result",
    iteration_id: iterationId,
    bindings: { artifact_digests: [], code_digests: [], evaluation_case_digests: [] },
    results: [
      {
        gate_id: "gate_unit",
        passed: true,
        evidence_id: "evidence_e2e",
        summary: "单测通过透明化",
      },
    ],
    findings: [],
    completed_allowed: true,
  });
  const evaluation = file(
    `artifacts/evaluations/evidence_evaluation_e2e/${semantic("evaluation")}.json`,
    {
      protocol_version: "1.1.0",
      record_kind: "evidence",
      evidence_id: "evidence_evaluation_e2e",
      evidence_type: "evaluation_report",
      subject_id: "task_e2e1",
      digest: semantic("evaluation"),
      provisional: false,
      created_at: FIXED_NOW,
      extensions: {
        "harness.evaluation": {
          case_id: "case_e2e1",
          case_digest: semantic("case"),
          passed: true,
          visibility: "external-only",
        },
      },
    },
  );
  const snapshot = file("artifacts/snapshots/snapshot_e2e.json", {
    protocol_version: "1.1.0",
    record_kind: "snapshot",
    snapshot_id: "snapshot_e2e",
    iteration_id: iterationId,
    status: "completed",
    final_commit: semantic("final-commit"),
    workflow_operation_id: workflowOperationId,
    created_at: FIXED_NOW,
    run_outcomes: [{ id: "run_e2e", outcome: "handoff" }],
    task_verdicts: [{ task_id: "task_e2e1", verdict: "passed" }],
    approvals: [],
    evidence: [],
    closed_findings: [],
    unresolved_items: [],
    rejected_hypotheses: [],
    coverage_summary: "门禁全部通过透明化",
  });
  const cycle = file("artifacts/tdd-cycles/cycle_e2e-1.json", {
    protocol_version: "1.1.0",
    record_kind: "tdd_cycle",
    logical_cycle_id: "cycle_e2e",
    attempt_ordinal: 1,
    task_id: "task_e2e1",
    status: "completed",
    assertion_ids: ["assert_e2e1"],
    contract_digest: semantic("contract"),
    repository_baseline: semantic("repo-baseline"),
    record_digest: semantic("cycle"),
  });
  const tddEvidence = file(
    `artifacts/tdd-evidence/cycle_e2e-1-red-${semantic("tdd-evidence").slice(0, 12)}.json`,
    {
      record_kind: "tdd_evidence",
      evidence_type: "red",
      task_id: "task_e2e1",
      contract_digest: semantic("contract"),
      logical_cycle_id: "cycle_e2e",
      attempt_ordinal: 1,
      digest: semantic("tdd-evidence"),
    },
  );
  const grant = file(`artifacts/tdd-grants/${semantic("grant")}.json`, {
    record_kind: "capability_grant",
    grant_id: "grant_e2e1",
    task_id: "task_e2e1",
    phase: "implementation",
    digest: semantic("grant"),
  });
  const finding = file("artifacts/findings/finding_e2e/proposed.json", {
    protocol_version: "1.1.0",
    record_kind: "feedback",
    id: "finding_e2e",
    type: "Finding",
    iteration_id: iterationId,
    status: "proposed",
    summary: "缺少验证证据透明化",
    created_at: FIXED_NOW,
    digest: semantic("finding"),
    extensions: { "harness.finding": { rule: "missing_verification", severity: "warning" } },
  });
  const findingEvidence = file(`artifacts/evidence/evidence_e2e2/${semantic("evidence2")}.json`, {
    protocol_version: "1.1.0",
    record_kind: "evidence",
    evidence_id: "evidence_e2e2",
    evidence_type: "gate_run",
    subject_id: "task_e2e1",
    digest: semantic("evidence2"),
    provisional: false,
    created_at: FIXED_NOW,
  });
  const wave = file(`artifacts/scheduling/${workflowOperationId}/waves/wave-integration_e2e.json`, {
    protocol_version: "1.3.0",
    record_kind: "wave_integration",
    wave_integration_id: "wave-integration_e2e",
    operation_id: workflowOperationId,
    iteration_id: iterationId,
    plan_digest: semantic("plan"),
    wave_index: 0,
    task_ids: ["task_e2e1"],
    base_commit: semantic("base-commit"),
    candidate_commit: semantic("candidate-commit"),
    accepted_source_tree_digest: semantic("tree"),
    task_lease_digests: [],
    task_evidence_digests: [],
    candidate_gate_evidence_digests: [],
    wave_gate_evidence_digests: [],
    policy_digest: semantic("policy"),
    approval_digests: [],
    command_id: "command_e2e1",
    integrated_at: FIXED_NOW,
    record_digest: semantic("wave"),
  });
  const integration = file("artifacts/integrations/integration_e2e.json", {
    record_kind: "integration",
    integration_id: "integration_e2e",
    operation_id: workflowOperationId,
    expected_target_commit: semantic("target-commit"),
    operation_commit: semantic("operation-commit"),
    lease_fencing_token: 3,
    ledger_sequence_rewrites: [],
    evidence_digests: [],
    approval_decision_digests: [],
    command_id: "command_e2e1",
    record_digest: semantic("integration"),
  });
  const lease = file(
    `artifacts/scheduling/${workflowOperationId}/leases/task-lease-record_e2e.json`,
    {
      protocol_version: "1.3.0",
      record_kind: "task_lease",
      task_lease_record_id: "task-lease-record_e2e",
      lease_id: "lease_e2e",
      operation_id: workflowOperationId,
      task_id: "task_e2e1",
      slot_id: "slot_e2e",
      fencing_token: 7,
      state: "granted",
      reserved_budget: { steps: 10, tokens: 1000 },
      retry_kind: "none",
      approval_digests: [],
      granted_at: FIXED_NOW,
      record_digest: semantic("lease"),
    },
  );

  // One atomic commit per artifact group, each carrying its ArtifactAvailable
  // announcement exactly like the production commit points (spec §9.3).
  const repository = new LedgerRepository({
    projectRoot,
    readBaseline: baseline,
    now: () => FIXED_NOW,
  });
  let sequence = repository
    .replay()
    .events.reduce((maximum, event) => Math.max(maximum, event.sequence), 0);
  let tick = 0;
  let findingManifestDigest = "";
  const digests: Record<string, string> = {};
  const record = (kind: string, artifact: FixtureFile): string => {
    digests[kind] = sha256Hex(artifact.content);
    return digests[kind];
  };
  const commit = async (
    tag: string,
    artifacts: readonly FixtureFile[],
    eventSpecs: readonly {
      readonly eventType: string;
      readonly payload: Record<string, unknown>;
    }[],
  ): Promise<void> => {
    const ledgerOperationId = `ledger_e2e_${tag}`;
    const events = eventSpecs.map((spec) => {
      sequence += 1;
      tick += 1;
      return {
        protocol_version: spec.eventType === "ArtifactAvailable" ? "1.4.0" : "1.1.0",
        record_kind: "event",
        event_id: `event_e2e_${tag}_${String(sequence)}`,
        event_type: spec.eventType,
        project_id: "project_transparency",
        iteration_id: iterationId,
        workflow_operation_id: workflowOperationId,
        ledger_operation_id: ledgerOperationId,
        sequence,
        timestamp: new Date(Date.parse(FIXED_NOW) + tick * 1000).toISOString(),
        payload: spec.payload,
      } as LifecycleEvent;
    });
    const transaction = {
      ledger_operation_id: ledgerOperationId,
      workflow_operation_id: workflowOperationId,
      attempt_id: `attempt_e2e_${tag}`,
      expected_baseline: baseline(),
      artifacts,
      edges: [],
      events,
    };
    const pin = transactionRequiredReaderVersion(transaction);
    const result = await repository.commit({
      ...transaction,
      ...(pin === undefined ? {} : { required_reader_version: pin }),
    });
    if (result.status !== "committed")
      throw new Error(`transparency fixture commit failed: ${tag}`);
    if (tag === "findings") findingManifestDigest = result.manifest.digest;
  };

  await commit(
    "decision",
    [decision],
    [artifactEventSpec("approval_decision", record("approval_decision", decision))],
  );
  await commit("prd", [prd], [artifactEventSpec("prd", record("prd", prd))]);
  await commit(
    "design",
    [designSet],
    [artifactEventSpec("design_set", record("design_set", designSet))],
  );
  await commit("plan", [plan, task], [artifactEventSpec("plan", record("plan", plan))]);
  await commit(
    "context",
    [bundle],
    [artifactEventSpec("context_manifest", record("context_manifest", bundle))],
  );
  await commit("run", [run], [artifactEventSpec("run_summary", record("run_summary", run))]);
  await commit(
    "verify",
    [verify, gateEvidence],
    [
      artifactEventSpec("gate_result", record("gate_result", verify)),
      artifactEventSpec("evidence", record("evidence", gateEvidence)),
    ],
  );
  await commit(
    "evaluation",
    [evaluation],
    [artifactEventSpec("evaluation", record("evaluation", evaluation))],
  );
  await commit(
    "snapshot",
    [snapshot],
    [artifactEventSpec("snapshot", record("snapshot", snapshot))],
  );
  await commit(
    "tdd",
    [cycle, tddEvidence, grant],
    [artifactEventSpec("tdd_artifact", record("tdd_artifact", cycle))],
  );
  await commit(
    "findings",
    [finding, findingEvidence],
    [artifactEventSpec("finding_group", record("finding_group", finding))],
  );
  await commit("wave", [wave], [artifactEventSpec("wave_result", record("wave_result", wave))]);
  await commit(
    "integration",
    [integration],
    [artifactEventSpec("integration_record", record("integration_record", integration))],
  );
  await commit("lease", [lease], [artifactEventSpec("task_lease", record("task_lease", lease))]);

  rebuildGraphCache({
    projectRoot,
    databasePath: resolveHarnessPath(harnessRootFor(projectRoot), GRAPH_DATABASE_RELATIVE_PATH),
  }).database.close();
  const server = await startDashboardServer({ projectRoot });
  return { parent, server, projectRoot, workflowOperationId, digests, findingManifestDigest };
}

const fixtures: { current?: TransparencyFixture & { readonly parent: string } } = {};

test.beforeEach(async () => {
  fixtures.current = await buildFixture();
});

test.afterEach(async () => {
  const current = fixtures.current;
  fixtures.current = undefined;
  if (current === undefined) return;
  await current.server.close();
  rmSync(current.parent, { recursive: true, force: true });
});

/** 14 artifact-scope kinds: stream link → click → pinned safe view (spec §9.3). */
const CLICK_CASES: readonly (readonly [string, string])[] = [
  ["approval_decision", "approve"],
  ["prd", "prd_e2e"],
  ["design_set", "设计集叙事透明化"],
  ["plan", "透明化迭代计划目标"],
  ["context_manifest", "bundle_e2e"],
  ["run_summary", "任务完成：透明化运行摘要"],
  ["gate_result", "单测通过透明化"],
  ["evidence", "证据摘要透明化"],
  ["evaluation", "case_e2e1"],
  ["snapshot", "snapshot_e2e"],
  ["tdd_artifact", "cycle_e2e"],
  ["wave_result", "wave-integration_e2e"],
  ["integration_record", "integration_e2e"],
  ["task_lease", "task-lease-record_e2e"],
];

test.describe("Dashboard transparency navigation", () => {
  for (const [kind, marker] of CLICK_CASES) {
    test(`opens the committed ${kind} safe view from its stream link`, async ({ page }) => {
      const fixture = fixtures.current!;
      await page.goto(fixture.server.bootstrapUrl);
      await page.getByRole("link", { name: /Live/u }).click();
      // The exact committed byte digest pins the navigation target (spec §9.3):
      // sibling kinds of other transactions must never be opened instead.
      const link = page
        .locator(
          `#live-register a.artifact-link[href="/api/v1/artifacts/${fixture.digests[kind]}?kind=${kind}&scope=artifact"]`,
        )
        .first();
      await expect(link).toBeVisible();
      await expect(link).toHaveText("查看对应版本产出");
      await link.click();
      const body = page.locator("#artifact-view-body");
      await expect(page.locator("#artifact-view")).toBeVisible();
      await expect(body).toContainText(`${kind} · artifact`);
      await expect(body).toContainText(marker);
    });
  }

  test("reads the finding group through its committed manifest scope", async ({ page }) => {
    const fixture = fixtures.current!;
    await page.goto(fixture.server.bootstrapUrl);
    const response = await page.request.get(
      `${fixture.server.origin}/api/v1/artifacts/${fixture.findingManifestDigest}?kind=finding_group&scope=manifest`,
    );
    expect(response.status()).toBe(200);
    const body = (await response.json()) as {
      data: {
        safe_view: boolean;
        content: { findings: { items: Record<string, unknown>[]; total: number } };
      };
    };
    expect(body.data.safe_view).toBe(true);
    expect(body.data.content.findings.total).toBe(1);
    expect(body.data.content.findings.items[0]).toMatchObject({
      finding_id: "finding_e2e",
      status: "proposed",
      summary: "缺少验证证据透明化",
    });
  });

  test("refuses to open a forged artifact href before any fetch", async ({ page }) => {
    const fixture = fixtures.current!;
    const liveId = "live:forged-href:1";
    const frame = {
      id: liveId,
      source: "live",
      authoritative: false,
      event: {
        event_type: "ArtifactAvailable",
        timestamp: FIXED_NOW,
        observation_key: "forged_href_obs",
        workflow_operation_id: fixture.workflowOperationId,
        payload: {
          artifact_kind: "plan",
          record_digest: "a".repeat(64),
          summary: "伪造链接",
        },
      },
      presentations: {
        [`${liveId}@live`]: {
          presentation_version: "1",
          entity_id: liveId,
          binding_digest: null,
          title_zh: "伪造的产出公告",
          description_zh: "携带站外伪造链接。",
          type_label_zh: "运行事件",
          status_label_zh: "实时信号",
          technical_type: "ArtifactAvailable",
          technical_status: "live",
          badges: [],
          derived_from: [],
          fallback: false,
          artifact_links: [{ label_zh: "查看对应版本产出", href: "https://evil.example/artifact" }],
        },
      },
    };
    await page.route("**/events", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "cache-control": "no-cache" },
        body: `id: ${liveId}\nevent: ArtifactAvailable\ndata: ${JSON.stringify(frame)}\n\n`,
      }),
    );
    await page.goto(fixture.server.bootstrapUrl);
    await page.getByRole("link", { name: /Live/u }).click();
    const forged = page.getByRole("link", { name: "查看对应版本产出", exact: true });
    await expect(forged).toBeVisible();
    let artifactFetches = 0;
    page.on("request", (request) => {
      if (request.url().includes("/api/v1/artifacts/")) artifactFetches += 1;
    });
    await forged.click();
    await expect(page.locator("#artifact-view-body")).toContainText("链接未通过校验，已拒绝打开。");
    expect(artifactFetches).toBe(0);
  });

  test("keeps the legacy subscription table when the session omits event_types", async ({
    page,
  }) => {
    const fixture = fixtures.current!;
    // Simulate a pre-1.4 server: the session payload carries no event_types.
    await page.route("**/api/v1/session", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { data?: Record<string, unknown> };
      if (body.data !== undefined) delete body.data["event_types"];
      await route.fulfill({ response, json: body });
    });
    await page.goto(fixture.server.bootstrapUrl);
    await page.getByRole("link", { name: /Live/u }).click();
    // The stream itself connects; the fallback table just never subscribes to
    // ArtifactAvailable, so no artifact link is rendered from it.
    await expect(page.locator("#connection-label")).toHaveText("LIVE / LOCAL");
    await expect(page.locator("#live-register a.artifact-link")).toHaveCount(0);
  });

  test("renders an unknown future event type without breaking the stream", async ({ page }) => {
    const fixture = fixtures.current!;
    // A newer server may advertise an event type this client build does not
    // know; the client subscribes (it trusts the session table) and renders
    // the event with the generic fallback presentation.
    await page.route("**/api/v1/session", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { data?: { event_types?: string[] } };
      if (body.data?.event_types !== undefined) {
        body.data.event_types = [...body.data.event_types, "FutureEvent2099"];
      }
      await route.fulfill({ response, json: body });
    });
    const liveId = "live:future-event:1";
    const frame = {
      id: liveId,
      source: "live",
      authoritative: false,
      event: {
        event_type: "FutureEvent2099",
        timestamp: FIXED_NOW,
        observation_key: "future_event_obs",
        workflow_operation_id: fixture.workflowOperationId,
        payload: {},
      },
      presentations: {},
    };
    await page.route("**/events", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "cache-control": "no-cache" },
        body: `id: ${liveId}\nevent: FutureEvent2099\ndata: ${JSON.stringify(frame)}\n\n`,
      }),
    );
    await page.goto(fixture.server.bootstrapUrl);
    await page.getByRole("link", { name: /Live/u }).click();
    await expect(page.locator("#live-register")).toContainText("FutureEvent2099");
  });

  test("replays after a stream reset and upgrades the live row to its ledger row", async ({
    page,
  }) => {
    const fixture = fixtures.current!;
    const liveId = "live:upgrade:1";
    const ledgerId = "ledger:upgrade:1";
    const presentation = {
      presentation_version: "1",
      entity_id: liveId,
      binding_digest: null,
      title_zh: "运行事件 · ArtifactAvailable",
      description_zh: "产出公告。",
      type_label_zh: "运行事件",
      status_label_zh: "实时信号",
      technical_type: "ArtifactAvailable",
      technical_status: "live",
      badges: [],
      derived_from: [],
      fallback: false,
    };
    const makeFrame = (id: string, authoritative: boolean) =>
      `id: ${id}\nevent: ArtifactAvailable\ndata: ${JSON.stringify({
        id,
        source: authoritative ? "ledger" : "live",
        authoritative,
        event: {
          event_type: "ArtifactAvailable",
          timestamp: FIXED_NOW,
          observation_key: "obs_e2e_upgrade",
          workflow_operation_id: fixture.workflowOperationId,
          payload: {
            artifact_kind: "snapshot",
            record_digest: "b".repeat(64),
            summary: "重放升级",
          },
        },
        presentations: { [`${id}@live`]: presentation },
      })}\n\n`;
    let connections = 0;
    await page.route("**/events", (route) => {
      connections += 1;
      const body =
        connections === 1
          ? `${makeFrame(liveId, false)}event: stream_reset\ndata: ${JSON.stringify({ reason: "cursor_evicted" })}\n\n`
          : makeFrame(ledgerId, true);
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "cache-control": "no-cache" },
        body,
      });
    });
    await page.goto(fixture.server.bootstrapUrl);
    await page.getByRole("link", { name: /Live/u }).click();

    // The live row appears first, the reset flags a gap, and the replayed
    // ledger row replaces the live row in place (same observation_key).
    await expect(page.locator("#live-register .live-gap-note")).toContainText(
      "live history may have gaps",
    );
    const rows = page.locator("#live-register li.live-event", {
      hasText: "ArtifactAvailable",
    });
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveClass(/is-authoritative/u);
  });
});
