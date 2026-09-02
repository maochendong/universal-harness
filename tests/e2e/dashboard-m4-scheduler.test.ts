import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test as base, type Page } from "@playwright/test";

import { createGitVcsAdapter } from "../../adapters/vcs-git/src/index.js";
import { contentDigest, type FeedbackRecord } from "../../packages/core/src/index.js";
import {
  DashboardWriteError,
  createDashboardSchedulerApi,
  startDashboardServer,
  type DashboardServer,
  type DashboardWriteApi,
} from "../../packages/dashboard/src/index.js";
import {
  createNewProject,
  type ApprovalRequestRecord,
  type SchedulerReadModel,
} from "../../packages/runtime/src/index.js";

interface SchedulerControl {
  activeOperationId: string;
  liveState: "observed" | "rebuilding";
  approvals: ApprovalRequestRecord[];
  lockHeld: boolean;
  resumeCalls: number;
  decisions: { requestId: string; decision: string; actor: string }[];
  schedulerDelays: Map<string, number>;
  cancelledTask: boolean;
  cancelCalls: { operationId: string; actor: string; expectedDigest: string }[];
}

interface SchedulerFixture {
  readonly page: Page;
  readonly server: DashboardServer;
  readonly operationId: string;
  readonly control: SchedulerControl;
}

function approval(
  operationId: string,
  requestId: string,
  taskId: string,
  action: "dispatch_task" | "integrate_wave",
): ApprovalRequestRecord {
  return {
    protocol_version: "1.3.0",
    record_kind: "approval_request",
    request_id: requestId,
    workflow_operation_id: operationId,
    object_id: taskId,
    object_type: action,
    object_digest: contentDigest({ requestId, object: taskId }),
    baseline_digest: "b".repeat(64),
    policy_digest: "c".repeat(64),
    preview_digest: "d".repeat(64),
    impact_path: ["plan_scheduler", taskId],
    risk: action === "integrate_wave" ? "critical" : "high",
    reason:
      action === "integrate_wave"
        ? "集成 Wave 2 前确认高风险契约变更。"
        : "并行启动 API Task 前确认写集与预算。",
    allowed_decisions: ["approve", "reject", "defer"],
    created_at: "2026-08-31T00:00:00.000Z",
    resume_phase: "execute",
  };
}

function budgetFinding(): FeedbackRecord {
  const content = {
    protocol_version: "1.3.0",
    record_kind: "feedback" as const,
    id: "finding_budget_exhausted",
    type: "Finding" as const,
    iteration_id: "iteration_scheduler",
    status: "proposed" as const,
    summary: "验证数据契约的 Task 预算已耗尽",
    created_at: "2026-08-31T00:00:00.000Z",
    extensions: {
      "harness.finding": {
        blocking: true,
        rule: "budget_exhausted",
        blocks: ["task_contract"],
      },
    },
  };
  return { ...content, digest: contentDigest(content) };
}

function schedulerModel(operationId: string, control: SchedulerControl): SchedulerReadModel {
  const content = {
    capability_status: "active" as const,
    operation: {
      operation_id: operationId,
      iteration_id: "iteration_scheduler",
      status: "running",
      live_state: control.liveState,
    },
    plan: {
      plan_id: "plan_scheduler",
      plan_digest: "a".repeat(64),
      waves: [
        { wave_index: 0, task_ids: ["task_api", "task_contract"] },
        { wave_index: 1, task_ids: ["task_ui"] },
      ],
    },
    tasks: [
      {
        task_id: "task_api",
        title: "实现 API 契约",
        wave_index: 0,
        status: (control.cancelledTask ? "cancelled" : "running") as "cancelled" | "running",
        authority: "ledger" as const,
        dependency_ids: [],
        non_parallel_reasons: [],
        current_lease_digest: "e".repeat(64),
        current_run_id: "run_api",
      },
      {
        task_id: "task_contract",
        title: "验证数据契约",
        wave_index: 0,
        status: "blocked" as const,
        authority: "ledger" as const,
        dependency_ids: [],
        non_parallel_reasons: ["exclusive_resources"],
      },
      {
        task_id: "task_ui",
        title: "交付 Scheduler 视图",
        wave_index: 1,
        status: "waiting_dependency" as const,
        authority: "provisional" as const,
        dependency_ids: ["task_api", "task_contract"],
        non_parallel_reasons: ["write_path_overlap:task_contract"],
      },
    ],
    slots:
      control.liveState === "rebuilding"
        ? []
        : [
            {
              slot_id: "slot_1",
              state: "running" as const,
              task_id: "task_api",
              run_id: "run_api",
            },
            {
              slot_id: "slot_2",
              state: "running" as const,
              task_id: "task_contract",
              run_id: "run_contract",
            },
          ],
    budget: {
      limit: { steps: 100, tokens: 10_000, duration_ms: 120_000 },
      consumed_steps: 40,
      consumed_tokens: 4_000,
      reserved_steps: 20,
      reserved_tokens: 2_000,
    },
    approvals: control.approvals,
    findings: [budgetFinding()],
    presentation_map: {
      "task:task_api": "实现 API 契约",
      "task:task_contract": "验证数据契约",
      "task:task_ui": "交付 Scheduler 视图",
    },
  };
  return { ...content, digest: contentDigest(content) };
}

const test = base.extend<{ scheduler: SchedulerFixture }>({
  scheduler: async ({ page }, use) => {
    const parent = mkdtempSync(join(tmpdir(), "harness-dashboard-m4-e2e-"));
    const created = await createNewProject(
      { parentDirectory: parent, name: "dashboard-m4", intent: "observe local task scheduling" },
      { vcs: createGitVcsAdapter() },
    );
    if (!created.ok) throw new Error(created.error.message);
    const operationId = created.value.workflowOperationId;
    const control: SchedulerControl = {
      activeOperationId: operationId,
      liveState: "observed",
      approvals: [
        approval(operationId, "approval_dispatch", "task_api", "dispatch_task"),
        approval(operationId, "approval_integrate", "task_ui", "integrate_wave"),
      ],
      lockHeld: false,
      resumeCalls: 0,
      decisions: [],
      schedulerDelays: new Map(),
      cancelledTask: false,
      cancelCalls: [],
    };
    const writeApi: DashboardWriteApi = {
      decideApproval: (input) => {
        control.decisions.push({
          requestId: input.requestId,
          decision: input.decision,
          actor: input.actor,
        });
        if (input.decision !== "defer") {
          control.approvals = control.approvals.filter(
            (candidate) => candidate.request_id !== input.requestId,
          );
        }
        return Promise.resolve({
          request_id: input.requestId,
          decision: input.decision,
          workflow_operation_id: operationId,
          workflow_digest: "f".repeat(64),
          scheduler_driver_state: "exited",
          resume_command: `harness resume ${operationId}`,
        });
      },
      resumeWorkflow: () => {
        if (control.lockHeld) {
          return Promise.reject(
            new DashboardWriteError(
              "conflict",
              "the driver lock is held by another driver; retry once it is released",
            ),
          );
        }
        control.resumeCalls += 1;
        return Promise.resolve({ status: "running" });
      },
      resolveFindingGroup: () =>
        Promise.reject(new DashboardWriteError("unavailable", "not used by this fixture")),
      cancelSchedulerOperation: (input) => {
        control.cancelCalls.push(input);
        return Promise.resolve({ status: "cancelled" });
      },
    };
    const server = await startDashboardServer({
      projectRoot: created.value.projectRoot,
      schedulerOperationId: () => control.activeOperationId,
      schedulerApi: createDashboardSchedulerApi({
        readSchedulerModel: async (selectedOperationId) => {
          const delay = control.schedulerDelays.get(selectedOperationId) ?? 0;
          if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
          return schedulerModel(selectedOperationId, control);
        },
        controlCapabilities: { cancel: true, policyProposal: false },
      }),
      writeApi,
    });
    await page.goto(server.bootstrapUrl);
    await expect(page).toHaveURL(server.origin + "/");
    try {
      await use({ page, server, operationId, control });
    } finally {
      await server.close();
      rmSync(parent, { recursive: true, force: true });
    }
  },
});

test.describe("M4 Observatory Scheduler", () => {
  test("desktop flow exposes waves, live slots, task evidence context and governed approvals", async ({
    scheduler,
  }) => {
    const { page, control } = scheduler;
    await page.getByRole("link", { name: /Scheduler/u }).click();

    await expect(page.getByRole("heading", { name: "本地任务调度" })).toBeVisible();
    await expect(page.locator("#scheduler-waves .scheduler-wave")).toHaveCount(2);
    await expect(page.locator("#scheduler-agent-pool .agent-slot")).toHaveCount(2);
    await expect(page.getByText("2 / 2", { exact: true })).toBeVisible();
    await expect(page.getByText("验证数据契约的 Task 预算已耗尽")).toBeVisible();
    await expect(page.getByText("提交预算 Policy Proposal，或缩小 Plan")).toBeVisible();
    if (process.env["HARNESS_UPDATE_M4_DOC_SCREENSHOT"] === "1") {
      await page.screenshot({
        path: join(import.meta.dirname, "../../docs/assets/harness-observatory-scheduler.png"),
        fullPage: true,
      });
    }

    await page.getByRole("button", { name: "查看 Task：交付 Scheduler 视图" }).click();
    const detail = page.locator("#scheduler-task-detail");
    await expect(detail.getByRole("heading", { name: "交付 Scheduler 视图" })).toBeVisible();
    await expect(detail.getByText("Lease", { exact: true })).toBeVisible();
    await expect(detail.getByText("Integrate", { exact: true })).toBeVisible();
    await expect(detail.getByText("与 task_contract 的写路径重叠")).toBeVisible();
    await expect(detail.getByText(/不以 Agent 自述补齐/u)).toBeVisible();

    const dispatch = page
      .locator("#scheduler-approvals .scheduler-approval-card")
      .filter({ hasText: "实现 API 契约" });
    await dispatch.getByLabel("审批人身份：实现 API 契约").fill("human:desktop-reviewer");
    await dispatch.getByRole("button", { name: "APPROVE" }).click();
    await expect(dispatch.getByText("审批决议已写入 Ledger")).toBeVisible();
    await expect(dispatch.getByText(`harness resume ${control.activeOperationId}`)).toBeVisible();
    await dispatch.getByRole("button", { name: "RESUME WORKFLOW" }).click();
    await expect(page.getByText(/Resume settled as/u)).toBeVisible();
    expect(control.resumeCalls).toBe(1);

    const integrate = page
      .locator("#scheduler-approvals .scheduler-approval-card")
      .filter({ hasText: "交付 Scheduler 视图" });
    await integrate.getByLabel("审批人身份：交付 Scheduler 视图").fill("human:desktop-reviewer");
    await integrate.getByRole("button", { name: "REJECT" }).click();
    await expect(page.getByText("当前没有待处理 Scheduler 审批。")).toBeVisible();
    expect(control.decisions.map((item) => [item.requestId, item.decision])).toEqual([
      ["approval_dispatch", "approve"],
      ["approval_integrate", "reject"],
    ]);
    await page.getByLabel("Scheduler 控制操作人").fill("human:desktop-reviewer");
    await page.getByRole("button", { name: "取消 Operation" }).click();
    await expect(page.getByText("Operation 已取消；Ledger 状态已刷新。")).toBeVisible();
    expect(control.cancelCalls).toHaveLength(1);
    await expect(
      page.getByRole("button", { name: "Policy Proposal Provider 未配置" }),
    ).toBeDisabled();

    for (const name of [
      "force task success",
      "skip gate",
      "move task to slot",
      "force release lease",
      "force merge candidate",
      "ignore baseline drift",
    ]) {
      await expect(page.getByRole("button", { name: new RegExp(name, "iu") })).toHaveCount(0);
    }
  });

  test("360px flow remains one-column, reports rebuilding honestly and surfaces Driver Lock contention", async ({
    scheduler,
  }) => {
    const { page, control, operationId } = scheduler;
    await page.setViewportSize({ width: 360, height: 800 });
    await page.getByRole("link", { name: /Scheduler/u }).click();

    await expect(page.getByRole("heading", { name: "本地任务调度" })).toBeVisible();
    const overflowReport = await page.evaluate(() => ({
      pixels: document.documentElement.scrollWidth - innerWidth,
      offenders: Array.from(document.querySelectorAll<HTMLElement>("body *"))
        .filter((element) => element.getBoundingClientRect().right > innerWidth + 1)
        .map(
          (element) =>
            `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${
              element.className ? `.${String(element.className).trim().replaceAll(" ", ".")}` : ""
            }`,
        )
        .slice(0, 8),
    }));
    expect(overflowReport.pixels, overflowReport.offenders.join(", ")).toBeLessThanOrEqual(1);
    const primaryBox = await page.locator(".scheduler-primary").boundingBox();
    const detailBox = await page.locator("#scheduler-task-detail").boundingBox();
    expect(primaryBox).not.toBeNull();
    expect(detailBox).not.toBeNull();
    expect(detailBox?.y ?? 0).toBeGreaterThan(primaryBox?.y ?? 0);

    control.liveState = "rebuilding";
    await page.getByRole("button", { name: "刷新调度状态" }).click();
    await expect(page.getByText("正在从 Ledger 重建", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/权威 Task 进度保持不变/u)).toBeVisible();
    await expect(page.locator("#scheduler-agent-pool .agent-slot")).toHaveCount(0);
    await expect(page.getByText("实现 API 契约", { exact: true }).first()).toBeVisible();

    control.liveState = "observed";
    control.approvals = [approval(operationId, "approval_lock", "task_api", "dispatch_task")];
    control.lockHeld = true;
    await page.getByRole("button", { name: "刷新调度状态" }).click();
    await expect(page.locator("#scheduler-approvals .scheduler-approval-card")).toHaveCount(1);
    const card = page
      .locator("#scheduler-approvals .scheduler-approval-card")
      .filter({ hasText: "实现 API 契约" });
    await card.getByLabel("审批人身份：实现 API 契约").fill("human:mobile-reviewer");
    await card.getByRole("button", { name: "APPROVE" }).click();
    await card.getByRole("button", { name: "RESUME WORKFLOW" }).click();
    await expect(page.getByText(/driver lock is held by another driver/u)).toBeVisible();
    expect(control.resumeCalls).toBe(0);
  });

  test("refresh aborts stale Scheduler reads and cancelled tasks never fabricate completed phases", async ({
    scheduler,
  }) => {
    const { page, control } = scheduler;
    const staleOperation = control.activeOperationId;
    control.schedulerDelays.set(staleOperation, 250);
    await page.getByRole("link", { name: /Scheduler/u }).click();

    control.activeOperationId = "operation_new";
    control.cancelledTask = true;
    await page.getByRole("button", { name: "刷新调度状态" }).click();
    await expect(page.getByText(/Operation operation_new/u)).toBeVisible();
    await page.waitForTimeout(350);
    await expect(page.getByText(/Operation operation_new/u)).toBeVisible();

    await page.getByRole("button", { name: "查看 Task：实现 API 契约" }).click();
    const timeline = page.locator("#scheduler-task-detail .scheduler-task-timeline");
    await expect(timeline.locator('[data-state="complete"]')).toHaveCount(0);
    await expect(timeline.locator('[data-state="unknown"]')).toHaveCount(6);
  });
});
