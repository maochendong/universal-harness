import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
} from "../../packages/core/src/index.js";
import {
  DashboardWriteError,
  startDashboardServer,
  type DashboardServer,
  type DashboardWriteApi,
} from "../../packages/dashboard/src/index.js";
import { rebuildGraphCache } from "../../packages/graph/src/index.js";
import {
  createGenericInterpreter,
  createNewProject,
  readApprovalDecisions,
  readCurrentOperation,
  resolveApproval,
  resumeIteration,
  runIteration,
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
}

function head(projectRoot: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
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
      });
    } finally {
      await server.close();
      rmSync(parent, { recursive: true, force: true });
    }
  },
});

test.describe("Dashboard live approval journey", () => {
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
});
