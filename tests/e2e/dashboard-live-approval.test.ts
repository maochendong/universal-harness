import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test as base, type Page } from "@playwright/test";

import { createGitVcsAdapter } from "../../adapters/vcs-git/src/index.js";
import {
  GRAPH_DATABASE_RELATIVE_PATH,
  contentDigest,
  harnessRootFor,
  readCommittedOperations,
  resolveHarnessPath,
  sealRecordEnvelope,
  type ModelInvocationRecord,
} from "../../packages/core/src/index.js";
import {
  DashboardWriteError,
  startDashboardServer,
  type DashboardServer,
  type DashboardWriteApi,
} from "../../packages/dashboard/src/index.js";
import { rebuildGraphCache } from "../../packages/graph/src/index.js";
import {
  FileLiveSpool,
  appendModelInvocationRecord,
  createGenericInterpreter,
  createNewProject,
  readApprovalDecisions,
  readApprovalSummary,
  readCurrentOperation,
  resolveApproval,
  resumeIteration,
  runIteration,
  type ApprovalDecision,
  type OrchestratorDependencies,
} from "../../packages/runtime/src/index.js";

interface LiveDashboardFixture {
  readonly page: Page;
  readonly server: DashboardServer;
  readonly projectRoot: string;
  readonly workflowOperationId: string;
  readonly firstRequestId: string;
  readonly firstObjectId: string;
  readonly firstObjectType: string;
  readonly firstObjectDigest: string;
  readonly firstAllowedDecisions: readonly string[];
  /**
   * Decide the first request through the CLI-equivalent command path
   * (resolveApproval), never through the page's own UI callback, so the
   * browser can only learn about it over SSE + the shared summary endpoint.
   */
  readonly decide: (
    decision: ApprovalDecision,
    actor: string,
  ) => Promise<{ readonly approvalDigest: string }>;
}

function head(projectRoot: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
}

function modelInvocation(
  suffix: string,
  overrides: Partial<Omit<ModelInvocationRecord, "record_digest">> = {},
): ModelInvocationRecord {
  return sealRecordEnvelope({
    protocol_version: "1.1.0",
    record_kind: "model_invocation",
    invocation_id: `invocation_jev_${suffix}`,
    conversation_id: `conversation_jev_${suffix}`,
    run_id: `run_jev_${suffix}`,
    attempt: 1,
    revision: 1,
    port_id: "impact_advisory",
    prompt_contract_id: "harness:prompt:jev-impact-advisory",
    prompt_contract_version: "1.0.0",
    prompt_contract_digest: "1".repeat(64),
    output_schema_id: "jev-impact-judgments",
    output_schema_digest: "2".repeat(64),
    profile_overlay_digest: "3".repeat(64),
    policy_overlay_digest: "4".repeat(64),
    input_bundle_digest: "5".repeat(64),
    compiled_prompt_digest: "6".repeat(64),
    provider_identity: "provider_typesafe",
    config_digest: "7".repeat(64),
    budget_profile: "operation-standard",
    cache_key: "8".repeat(64),
    state: "consumed",
    ...overrides,
  });
}

const test = base.extend<{ dashboard: LiveDashboardFixture }>({
  dashboard: async ({ page }, use) => {
    const parent = mkdtempSync(join(tmpdir(), "harness-dashboard-live-e2e-"));
    const vcs = createGitVcsAdapter();
    const created = await createNewProject(
      { parentDirectory: parent, name: "dashboard-live", intent: "govern a live iteration" },
      { vcs },
    );
    if (!created.ok) throw new Error(created.error.message);
    const projectRoot = created.value.projectRoot;
    const deps: OrchestratorDependencies = {
      projectRoot,
      readBaseline: () => head(projectRoot),
      vcs,
      interpret: createGenericInterpreter(),
    };
    const started = await runIteration(deps, {
      intent: "add a digest-bound live approval flow",
      intentShape: "pack-converted",
    });
    if (started.status !== "approval_required") {
      throw new Error(`expected first approval, got ${started.status}`);
    }
    const writeApi: DashboardWriteApi = {
      decideApproval: async (input) => {
        try {
          const resolved = await resolveApproval(deps, {
            requestId: input.requestId,
            decision: input.decision,
            actor: input.actor,
            expectedObjectDigest: input.expectedDigest,
          });
          const operation = readCurrentOperation(
            { projectRoot, readBaseline: deps.readBaseline },
            resolved.workflowOperationId,
          );
          return {
            request_id: resolved.requestId,
            decision: resolved.decision,
            approval_digest: resolved.approvalDigest,
            workflow_operation_id: resolved.workflowOperationId,
            workflow_digest: operation === undefined ? undefined : contentDigest(operation),
            expected_digest: input.expectedDigest,
            actor: input.actor,
          };
        } catch {
          throw new DashboardWriteError("conflict", "approval changed; refresh first");
        }
      },
      resumeWorkflow: async (input) => {
        const operation = readCurrentOperation(
          { projectRoot, readBaseline: deps.readBaseline },
          input.workflowOperationId,
        );
        if (operation === undefined) throw new DashboardWriteError("not_found", "workflow missing");
        if (contentDigest(operation) !== input.expectedDigest) {
          throw new DashboardWriteError("conflict", "workflow changed; refresh first");
        }
        const outcome = await resumeIteration(deps, input.workflowOperationId, undefined);
        return { status: outcome.status, actor: input.actor };
      },
      resolveFindingGroup: () =>
        Promise.reject(new DashboardWriteError("unavailable", "no finding fixture")),
    };
    const databasePath = resolveHarnessPath(
      harnessRootFor(projectRoot),
      GRAPH_DATABASE_RELATIVE_PATH,
    );
    rebuildGraphCache({ projectRoot, databasePath }).database.close();
    const server = await startDashboardServer({ projectRoot, writeApi });
    await page.goto(server.bootstrapUrl);
    await expect(page).toHaveURL(server.origin + "/");
    try {
      await use({
        page,
        server,
        projectRoot,
        workflowOperationId: started.required.workflow_operation_id,
        firstRequestId: started.required.request_id,
        firstObjectId: started.required.object_id,
        firstObjectType: started.required.object_type,
        firstObjectDigest: started.required.object_digest,
        firstAllowedDecisions: started.required.allowed_decisions,
        decide: async (decision, actor) => {
          const resolved = await resolveApproval(deps, {
            requestId: started.required.request_id,
            decision,
            actor,
            expectedObjectDigest: started.required.object_digest,
          });
          return { approvalDigest: resolved.approvalDigest };
        },
      });
    } finally {
      await server.close();
      rmSync(parent, { recursive: true, force: true });
    }
  },
});

test.describe("Dashboard live approval journey", () => {
  test("shows project-level model invocation pages and refreshes a recovered Jev attempt safely", async ({
    dashboard,
  }, testInfo) => {
    const { page, projectRoot } = dashboard;
    const unsafeProvider = '<img src="/jev-injected-image" onerror="alert(1)">';
    const resultLocator = "artifacts/model-results/invocation_jev_002/attempt-1.json";
    appendModelInvocationRecord(
      projectRoot,
      modelInvocation("001", {
        state: "failed",
        failure: {
          code: "provider_unavailable",
          summary: "raw prompt and synthetic key must not appear in the card",
          retryable: true,
        },
      }),
    );
    appendModelInvocationRecord(
      projectRoot,
      modelInvocation("002", {
        usage: { tokens: 320 },
        result_locator: resultLocator,
      }),
    );
    appendModelInvocationRecord(
      projectRoot,
      modelInvocation("003", { provider_identity: unsafeProvider }),
    );
    for (let index = 4; index <= 21; index += 1) {
      appendModelInvocationRecord(projectRoot, modelInvocation(String(index).padStart(3, "0")));
    }

    const requests: URL[] = [];
    page.on("request", (request) => requests.push(new URL(request.url())));
    await page.getByRole("link", { name: /Live/u }).click();
    const panel = page.getByRole("region", { name: "项目级模型调用记录" });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("不代表当前迭代的证据");
    await expect(panel.getByRole("article")).toHaveCount(20);
    await expect(panel).toContainText("Jev");
    await expect(panel).toContainText("provider_typesafe");
    await expect(panel).toContainText("320 tokens");
    await expect(panel).toContainText("建议强度非正确率");
    const failed = panel.getByRole("article").filter({ hasText: "已失败" });
    await expect(failed).toContainText("Provider 不可用");
    await expect(failed).toContainText("不可用");
    await expect(failed).not.toContainText("0 tokens");
    await expect(panel).not.toContainText("raw prompt and synthetic key");
    await expect(panel.getByText(unsafeProvider, { exact: true })).toBeVisible();
    await expect(panel.getByRole("img")).toHaveCount(0);
    await expect(panel.getByText(resultLocator, { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "复制结果引用" })).toHaveCount(1);
    await expect(panel.getByRole("link")).toHaveCount(0);
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], { origin: dashboard.server.origin });
    await panel.getByRole("button", { name: "复制结果引用" }).click();
    await expect(panel.getByRole("button", { name: "已复制", exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(resultLocator);
    // Keep the register title below the fixed Observatory masthead in the artifact.
    await panel.evaluate((element) =>
      window.scrollTo({ top: window.scrollY + element.getBoundingClientRect().top - 110 }),
    );
    await page.screenshot({ path: testInfo.outputPath("jev-model-invocations-desktop.png") });

    await panel.getByRole("button", { name: "加载更多模型调用" }).click();
    await expect(panel.getByRole("article")).toHaveCount(21);
    await expect(panel.getByRole("button", { name: "加载更多模型调用" })).toBeHidden();
    const invocationRequests = requests.filter(
      (url) => url.pathname === "/api/v1/model-invocations",
    );
    expect(invocationRequests.map((url) => url.searchParams.get("limit"))).toEqual(["20", "20"]);
    expect(invocationRequests[1]?.searchParams.get("cursor")).toBe("invocation_jev_020");
    expect(invocationRequests.some((url) => url.searchParams.has("operation_id"))).toBe(false);
    expect(requests.some((url) => url.pathname.includes("/model-results/"))).toBe(false);
    expect(requests.some((url) => url.pathname === "/jev-injected-image")).toBe(false);

    // Recovery is a new invocation identity. The old failure remains a project fact.
    appendModelInvocationRecord(
      projectRoot,
      modelInvocation("000_recovered", { usage: { tokens: 654 } }),
    );
    await panel.getByRole("button", { name: "刷新模型调用" }).click();
    await expect(panel.getByRole("article")).toHaveCount(20);
    await expect(panel).toContainText("654 tokens");
    await expect(panel.getByRole("article").filter({ hasText: "已失败" })).toHaveCount(1);
  });

  test("keeps the model register empty on read failure and retries without fabricating local calls", async ({
    dashboard,
  }) => {
    const { page } = dashboard;
    await page.route("**/api/v1/model-invocations?**", (route) =>
      route.fulfill({
        status: 503,
        json: { detail: "raw-provider-diagnostic-do-not-display" },
      }),
    );
    await page.getByRole("link", { name: /Live/u }).click();
    const panel = page.getByRole("region", { name: "项目级模型调用记录" });
    await expect(panel.getByRole("status")).toContainText("读取失败");
    await expect(panel.getByRole("article")).toHaveCount(0);
    await expect(panel).not.toContainText("raw-provider-diagnostic");
    await expect(panel.getByRole("button", { name: "刷新模型调用" })).toBeEnabled();
    await page.unroute("**/api/v1/model-invocations?**");
    await panel.getByRole("button", { name: "刷新模型调用" }).click();
    await expect(panel.getByRole("status")).toContainText("暂无项目级模型调用记录");
    await expect(panel).toContainText("本地补证或零调用不会生成模型调用卡片");
    await expect(panel.getByRole("article")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "加载更多模型调用" })).toBeHidden();
  });

  test("renders a readable dsh output tail with stream provenance", async ({ dashboard }) => {
    const { page, workflowOperationId } = dashboard;
    const liveId = "live:dsh-output:1";
    const frame = {
      id: liveId,
      source: "live",
      authoritative: false,
      event: {
        event_type: "RunOutputSummary",
        timestamp: "2026-08-17T00:00:00.000Z",
        observation_key: "dsh_output_01",
        workflow_operation_id: workflowOperationId,
        payload: {
          run_id: "run_dsh_01",
          summary: "编译后端模块\n运行集成测试\n12/12 passed",
          stream: "mixed",
          bytes_observed: 1_484,
          truncated: false,
          final: false,
        },
      },
      presentations: {},
    };
    await page.route("**/events", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "cache-control": "no-cache" },
        body: `id: ${liveId}\nevent: RunOutputSummary\ndata: ${JSON.stringify(frame)}\n\n`,
      }),
    );

    await page.getByRole("link", { name: /Live/u }).click();
    await expect(page.getByLabel("Agent output tail")).toContainText("运行集成测试");
    await expect(page.getByText("mixed · 1484 bytes", { exact: true })).toBeVisible();
  });

  test("loads the authoritative approval queue after the live event was missed", async ({
    dashboard,
  }) => {
    const { page, firstRequestId, firstObjectDigest } = dashboard;

    await page.getByRole("link", { name: /Approvals/u }).click();
    await expect(page.getByRole("heading", { name: "Pending approvals" })).toBeVisible();
    await expect(page.getByText("1 pending", { exact: true })).toBeVisible();
    const card = page.locator("#approval-queue .approval-card");
    await expect(card).toHaveCount(1);
    await expect(card.getByRole("heading", { name: /批准/u })).toBeVisible();
    await card.getByText(/审计信息 ·/u).click();
    await expect(card.getByText(firstRequestId, { exact: true })).toBeVisible();

    let decisionBody: { expected_digest?: string } | undefined;
    page.on("request", (request) => {
      if (request.method() !== "POST" || !request.url().includes("/decision")) return;
      decisionBody = request.postDataJSON() as { expected_digest?: string };
    });
    await card.getByRole("textbox", { name: /审批人身份/u }).fill("human:approval-queue-e2e");
    await card.getByRole("button", { name: "APPROVE" }).click();
    await expect(card.getByText("DECISION RECORDED")).toBeVisible();
    expect(decisionBody?.expected_digest).toBe(firstObjectDigest);
    await expect(card.getByRole("button", { name: "RESUME WORKFLOW" })).toBeVisible();
  });

  test("replaces live signals, commits a digest-bound actor decision, and resumes", async ({
    dashboard,
  }) => {
    const { page, projectRoot, workflowOperationId, firstRequestId } = dashboard;
    await page.getByRole("link", { name: /Live/u }).click();
    await expect(page.getByRole("heading", { name: "Operation stream" })).toBeVisible();
    await expect(page.getByText("需要人工审批", { exact: true }).first()).toBeVisible();
    await expect(
      page.locator(".approval-card").getByRole("heading", { name: /批准/u }),
    ).toBeVisible();
    await expect(
      page.locator(".approval-card").getByText("等待决策", { exact: true }),
    ).toBeVisible();
    await page
      .locator(".approval-card")
      .getByText(/审计信息 ·/u)
      .click();
    await expect(
      page.locator(".approval-card").getByText(firstRequestId, { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "APPROVE" })).toBeVisible();
    await expect(page.getByRole("button", { name: "REJECT" })).toBeVisible();
    await expect(page.getByRole("button", { name: "DEFER" })).toBeVisible();

    await page.getByRole("textbox", { name: /审批人身份/u }).fill("human:web-e2e");
    await page.getByRole("button", { name: "APPROVE" }).click();
    await expect(page.getByText("DECISION RECORDED")).toBeVisible();
    await expect(page.getByRole("button", { name: "RESUME WORKFLOW" })).toBeVisible();

    const decisions = readApprovalDecisions(
      harnessRootFor(projectRoot),
      readCommittedOperations(harnessRootFor(projectRoot)),
      workflowOperationId,
    );
    expect(decisions).toEqual([
      expect.objectContaining({
        request_id: firstRequestId,
        actor: "human:web-e2e",
        decision: "approve",
      }),
    ]);

    await page.getByRole("button", { name: "RESUME WORKFLOW" }).click();
    await expect(
      page.locator(".approval-card").getByRole("heading", { name: "批准影响范围" }),
    ).toBeVisible();
    await page
      .locator(".approval-card")
      .getByText(/审计信息 ·/u)
      .click();
    await expect(
      page
        .locator(".approval-card")
        .getByText(/approval_request_/u)
        .first(),
    ).toBeVisible();
  });

  test("binds the decision to the raw approval digest when presentation data is altered", async ({
    dashboard,
  }) => {
    const {
      page,
      workflowOperationId,
      firstRequestId,
      firstObjectId,
      firstObjectType,
      firstObjectDigest,
      firstAllowedDecisions,
    } = dashboard;
    const alteredDigest = "e".repeat(64);
    const liveId = "live:tampered-presentation:1";
    const frame = {
      id: liveId,
      source: "live",
      authoritative: false,
      event: {
        event_type: "ApprovalRequired",
        timestamp: "2026-08-17T00:00:00.000Z",
        observation_key: "tampered_presentation_approval",
        workflow_operation_id: workflowOperationId,
        payload: {
          request_id: firstRequestId,
          object_id: firstObjectId,
          object_type: firstObjectType,
          object_digest: firstObjectDigest,
          reason: "确认原始对象摘要不受展示层影响。",
          risk: "high",
          allowed_decisions: firstAllowedDecisions,
        },
      },
      presentations: {
        [`${liveId}@live`]: {
          presentation_version: "1",
          entity_id: liveId,
          binding_digest: null,
          title_zh: "需要人工审批",
          description_zh: "展示层事件说明。",
          type_label_zh: "运行事件",
          status_label_zh: "等待决策",
          technical_type: "ApprovalRequired",
          technical_status: "live",
          badges: [],
          derived_from: [],
          fallback: false,
        },
        [`${firstRequestId}@${firstObjectDigest}`]: {
          presentation_version: "1",
          entity_id: firstRequestId,
          binding_digest: alteredDigest,
          title_zh: "被篡改的展示标题",
          description_zh: "此处故意携带错误的展示层摘要。",
          type_label_zh: "审批请求",
          status_label_zh: "等待决策",
          technical_type: firstObjectType,
          technical_status: "pending",
          badges: [],
          derived_from: [],
          fallback: false,
        },
      },
    };
    await page.route("**/events", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "cache-control": "no-cache" },
        body: `id: ${liveId}\nevent: ApprovalRequired\ndata: ${JSON.stringify(frame)}\n\n`,
      }),
    );
    let decisionBody: { expected_digest?: string } | undefined;
    page.on("request", (request) => {
      if (request.method() !== "POST" || !request.url().includes("/decision")) return;
      decisionBody = request.postDataJSON() as { expected_digest?: string };
    });

    await page.getByRole("link", { name: /Live/u }).click();
    await expect(
      page.locator(".approval-card").getByRole("heading", { name: "被篡改的展示标题" }),
    ).toBeVisible();
    await page.getByRole("textbox", { name: /审批人身份/u }).fill("human:digest-binding-e2e");
    await page.getByRole("button", { name: "APPROVE" }).click();
    await expect(page.getByText("DECISION RECORDED")).toBeVisible();
    expect(decisionBody?.expected_digest).toBe(firstObjectDigest);
    expect(decisionBody?.expected_digest).not.toBe(alteredDigest);
  });

  test("pushes defer and terminal decisions made on another command path into two browser queues", async ({
    dashboard,
  }) => {
    const { page, server, projectRoot, decide } = dashboard;
    const second = await page.context().newPage();
    await second.goto(server.origin + "/");
    try {
      for (const browser of [page, second]) {
        await browser.getByRole("link", { name: /Live/u }).click();
        await browser.getByRole("link", { name: /Approvals/u }).click();
        await expect(browser.locator("#approval-queue .approval-card")).toHaveCount(1);
      }

      // A defer committed elsewhere: the card shows the shared summary, keeps
      // the request pending and keeps the follow-up actions available.
      const deferred = await decide("defer", "human:cli-defer");
      const deferSummary = readApprovalSummary(projectRoot, deferred.approvalDigest).summary;
      expect(deferSummary.decision).toBe("defer");
      for (const browser of [page, second]) {
        const queue = browser.locator("#approval-queue");
        await expect(queue).toContainText("已暂缓，仍待处理");
        await expect(queue).toContainText(deferSummary.actor_display);
        await expect(queue).toContainText(deferSummary.decided_at);
        await expect(queue.getByRole("button", { name: "APPROVE" })).toBeEnabled();
      }

      // A terminal approve committed elsewhere: both browsers show the same
      // decision, redacted identity and record time; the raw actor and the
      // decision form leave the terminal card.
      const approved = await decide("approve", "human:cli-approve");
      const approveSummary = readApprovalSummary(projectRoot, approved.approvalDigest).summary;
      for (const browser of [page, second]) {
        const queue = browser.locator("#approval-queue");
        await expect(queue).toContainText("审批决定 · 已批准");
        await expect(queue).toContainText(approveSummary.actor_display);
        await expect(queue).toContainText(approveSummary.decided_at);
        await expect(queue).not.toContainText("human:cli-approve");
        await expect(queue.getByRole("button", { name: "APPROVE" })).toHaveCount(0);
        await expect(browser.locator("#approval-count")).toHaveText("0 pending");
      }
    } finally {
      await second.close();
    }
  });

  test("rebuilds the decision card from the authoritative replay after a refresh", async ({
    dashboard,
  }) => {
    const { page, firstRequestId, decide } = dashboard;
    await page.getByRole("link", { name: /Live/u }).click();
    await page.getByRole("link", { name: /Approvals/u }).click();
    await expect(page.locator("#approval-queue .approval-card")).toHaveCount(1);

    await decide("defer", "human:cli-defer");
    await decide("approve", "human:cli-approve");
    await expect(page.locator("#approval-queue")).toContainText("审批决定 · 已批准");

    await page.reload();
    await page.getByRole("link", { name: /Live/u }).click();
    await page.getByRole("link", { name: /Approvals/u }).click();
    const cards = page.locator(`#approval-queue [data-request-id="${firstRequestId}"]`);
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText("审批决定 · 已批准");
    // The replayed older defer must not downgrade the terminal state.
    await expect(page.locator("#approval-queue")).not.toContainText("已暂缓，仍待处理");
    await expect(page.locator("#approval-count")).toHaveText("0 pending");
  });

  test("recovers pending and decision state after a real stream reset, flagging live gaps", async ({
    dashboard,
  }) => {
    const { page, projectRoot, workflowOperationId, firstRequestId, decide } = dashboard;
    // Seed a Live observation so the browser cursor advances past a Live
    // segment the test can then replace to force a real source reset.
    const live = new FileLiveSpool(projectRoot).append({
      streamId: "stream_reset_e2e",
      observationKey: "obs_reset_before",
      eventType: "RunHeartbeat",
      projectId: "project_dashboard_live",
      iterationId: "iteration_01M02WWWWWWWWWWWWWWWWWWWWWW",
      workflowOperationId,
      timestamp: "2026-09-08T00:00:00.000Z",
      payload: { run_id: "run_reset_e2e" },
    });

    await page.getByRole("link", { name: /Live/u }).click();
    await expect(page.locator("#live-register")).toContainText("RunHeartbeat");
    await page.getByRole("link", { name: /Approvals/u }).click();
    await decide("approve", "human:cli-reset");
    await expect(page.locator("#approval-queue")).toContainText("审批决定 · 已批准");

    // Replace the Live segment: the shared source drops the old generation,
    // the Hub evicts the browser cursor and emits a real stream_reset frame.
    const segment = join(
      projectRoot,
      ".harness/cache/event-stream/stream_reset_e2e/segment-000001.jsonl",
    );
    writeFileSync(
      `${segment}.replacement`,
      `${JSON.stringify({ ...live, observation_key: "obs_reset_after" })}\n`,
    );
    renameSync(`${segment}.replacement`, segment);

    await expect(page.locator("#live-register .live-gap-note")).toContainText(
      "live history may have gaps",
    );
    // The authoritative replay restores the decision card in committed order.
    await expect(page.locator("#approval-queue")).toContainText("审批决定 · 已批准");
    await expect(page.locator(`#approval-queue [data-request-id="${firstRequestId}"]`)).toHaveCount(
      1,
    );
    await expect(page.locator("#approval-count")).toHaveText("0 pending");
  });
});
