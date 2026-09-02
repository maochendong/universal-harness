import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test as base, type Page } from "@playwright/test";

import { createGitVcsAdapter } from "../../adapters/vcs-git/src/index.js";
import { contentDigest, type FeedbackRecord } from "../../packages/core/src/index.js";
import {
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

type CancellationPhase = "pending" | "confirmed";

interface GovernedControl {
  activeOperationId: string;
  approvals: ApprovalRequestRecord[];
  capabilities: { cancel: boolean; policyProposal: boolean };
  cancellation: CancellationPhase;
  decisions: { requestId: string; decision: string; actor: string }[];
  cancelCalls: { operationId: string; actor: string; expectedDigest: string }[];
  lastDigest: string;
}

interface GovernedFixture {
  readonly page: Page;
  readonly server: DashboardServer;
  readonly operationId: string;
  readonly control: GovernedControl;
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
    impact_path: ["plan_governed", taskId],
    risk: action === "integrate_wave" ? "critical" : "high",
    reason:
      action === "integrate_wave"
        ? "集成 Wave 1 前确认高风险契约变更。"
        : "并行启动 API Task 前确认写集与预算。",
    allowed_decisions: ["approve", "reject", "defer"],
    created_at: "2026-09-02T00:00:00.000Z",
    resume_phase: "execute",
  };
}

function budgetFinding(): FeedbackRecord {
  const content = {
    protocol_version: "1.3.0",
    record_kind: "feedback" as const,
    id: "finding_budget_exhausted",
    type: "Finding" as const,
    iteration_id: "iteration_governed",
    status: "proposed" as const,
    summary: "验证数据契约的 Task 预算已耗尽",
    created_at: "2026-09-02T00:00:00.000Z",
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

function governedModel(operationId: string, control: GovernedControl): SchedulerReadModel {
  const cancellationPending = control.cancellation === "pending";
  const content = {
    capability_status: "active" as const,
    operation: {
      operation_id: operationId,
      iteration_id: "iteration_governed",
      status: "running",
      live_state: "observed" as const,
    },
    plan: {
      plan_id: "plan_governed",
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
        status: "running" as const,
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
        status: cancellationPending ? ("running" as const) : ("cancelled" as const),
        authority: "ledger" as const,
        dependency_ids: [],
        non_parallel_reasons: ["exclusive_resources"],
        ...(cancellationPending ? { current_run_id: "run_contract" } : {}),
      },
      {
        task_id: "task_ui",
        title: "交付 Governed 视图",
        wave_index: 1,
        status: "waiting_dependency" as const,
        authority: "provisional" as const,
        dependency_ids: ["task_api", "task_contract"],
        non_parallel_reasons: ["write_path_overlap:task_contract"],
      },
    ],
    slots: cancellationPending
      ? [
          {
            slot_id: "slot_1",
            state: "running" as const,
            task_id: "task_api",
            run_id: "run_api",
          },
          {
            slot_id: "slot_2",
            state: "cancelling" as const,
            task_id: "task_contract",
            run_id: "run_contract",
          },
        ]
      : [
          {
            slot_id: "slot_1",
            state: "running" as const,
            task_id: "task_api",
            run_id: "run_api",
          },
          { slot_id: "slot_2", state: "idle" as const },
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
      "task:task_ui": "交付 Governed 视图",
    },
  };
  const model = { ...content, digest: contentDigest(content) };
  control.lastDigest = model.digest;
  return model;
}

const test = base.extend<{ governed: GovernedFixture }>({
  governed: async ({ page }, use) => {
    const parent = mkdtempSync(join(tmpdir(), "harness-dashboard-governed-e2e-"));
    const created = await createNewProject(
      { parentDirectory: parent, name: "dashboard-governed", intent: "governed scheduler controls" },
      { vcs: createGitVcsAdapter() },
    );
    if (!created.ok) throw new Error(created.error.message);
    const operationId = created.value.workflowOperationId;
    const control: GovernedControl = {
      activeOperationId: operationId,
      approvals: [
        approval(operationId, "approval_dispatch", "task_api", "dispatch_task"),
        approval(operationId, "approval_integrate", "task_ui", "integrate_wave"),
      ],
      capabilities: { cancel: true, policyProposal: true },
      cancellation: "pending",
      decisions: [],
      cancelCalls: [],
      lastDigest: "",
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
      resumeWorkflow: () => Promise.resolve({ status: "running" }),
      resolveFindingGroup: () =>
        Promise.reject(new Error("not used by this fixture")),
      cancelSchedulerOperation: (input) => {
        control.cancelCalls.push({
          operationId: input.operationId,
          actor: input.actor,
          expectedDigest: input.expectedDigest,
        });
        control.cancellation = "confirmed";
        return Promise.resolve({ status: "cancelled" });
      },
    };
    const server = await startDashboardServer({
      projectRoot: created.value.projectRoot,
      schedulerOperationId: () => control.activeOperationId,
      schedulerApi: createDashboardSchedulerApi({
        readSchedulerModel: (selectedOperationId) =>
          Promise.resolve(governedModel(selectedOperationId, control)),
        controlCapabilities: control.capabilities,
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

test.describe("M4 Governed Controls", () => {
  test("governed surface renders grounded approvals, policy proposal availability and pending-cancel state", async ({
    governed,
  }) => {
    const { page, control, operationId } = governed;
    await page.getByRole("link", { name: /Scheduler/u }).click();

    await expect(page.getByRole("heading", { name: "本地任务调度" })).toBeVisible();
    // 摘要中的治理指标由真实 read model 投影：1 个阻塞 Finding / 2 个待审批。
    await expect(page.locator("#scheduler-control-metric")).toHaveText("1 / 2");

    const dispatchDigest = control.approvals[0]?.object_digest ?? "";
    const dispatch = page
      .locator("#scheduler-approvals .scheduler-approval-card")
      .filter({ hasText: "实现 API 契约" });
    await expect(page.locator("#scheduler-approvals .scheduler-approval-card")).toHaveCount(2);
    await expect(dispatch.locator(".risk-chip")).toHaveText("高风险");
    await dispatch.getByText("审批绑定与恢复命令").click();
    await expect(dispatch.getByText(dispatchDigest, { exact: true })).toBeVisible();
    await expect(dispatch.getByText("b".repeat(64), { exact: true })).toBeVisible();
    await expect(dispatch.getByText(`harness resume ${operationId}`, { exact: true })).toBeVisible();

    const integrate = page
      .locator("#scheduler-approvals .scheduler-approval-card")
      .filter({ hasText: "交付 Governed 视图" });
    await expect(integrate.locator(".risk-chip")).toHaveText("关键风险");

    // Pending-cancel 投影：取消已记录、等待 Agent 确认，槽位必须显式呈现该状态。
    const cancelling = page.locator("#scheduler-agent-pool .agent-slot.slot-cancelling");
    await expect(cancelling).toHaveCount(1);
    await expect(cancelling.getByText("取消待确认", { exact: true })).toBeVisible();
    await expect(cancelling.getByText("验证数据契约", { exact: true })).toBeVisible();
    await expect(
      page.locator("#scheduler-agent-pool .agent-slot.slot-running").getByText("取消待确认"),
    ).toHaveCount(0);

    // Policy Proposal 入口的可用性来自服务端 control 投影。
    const proposal = page.getByRole("button", { name: "提交预算 Policy Proposal" });
    await expect(proposal).toBeEnabled();
    await expect(
      page.getByText("预算/并发上限 Policy Proposal Provider 未配置", { exact: false }),
    ).toHaveCount(0);

    control.capabilities.policyProposal = false;
    await page.getByRole("button", { name: "刷新调度状态" }).click();
    const unavailable = page.getByRole("button", { name: "Policy Proposal Provider 未配置" });
    await expect(unavailable).toBeDisabled();
    await expect(
      page.getByText(/Policy Proposal Provider 未配置；本视图 fail-closed/u),
    ).toBeVisible();
    control.capabilities.policyProposal = true;
  });

  test("approval decision and operation cancel write through the real server and refresh governed state", async ({
    governed,
  }) => {
    const { page, control, operationId } = governed;
    await page.getByRole("link", { name: /Scheduler/u }).click();
    await expect(page.getByRole("heading", { name: "本地任务调度" })).toBeVisible();

    // 审批决议经真实 HTTP 写路径回到 fixture authority，并展示恢复命令。
    const dispatch = page
      .locator("#scheduler-approvals .scheduler-approval-card")
      .filter({ hasText: "实现 API 契约" });
    await dispatch.getByLabel("审批人身份：实现 API 契约").fill("human:release-manager");
    await dispatch.getByRole("button", { name: "APPROVE" }).click();
    await expect(dispatch.getByText("审批决议已写入 Ledger")).toBeVisible();
    await expect(dispatch.getByText(`harness resume ${operationId}`)).toBeVisible();
    expect(control.decisions).toEqual([
      { requestId: "approval_dispatch", decision: "approve", actor: "human:release-manager" },
    ]);

    // 决议后的 Ledger 状态驱动列表刷新：只剩 integrate 审批。
    await page.getByRole("button", { name: "刷新调度状态" }).click();
    await expect(page.locator("#scheduler-approvals .scheduler-approval-card")).toHaveCount(1);
    await expect(page.locator("#scheduler-control-metric")).toHaveText("1 / 1");

    // Operation 级取消携带 expected digest；确认后 pending-cancel 投影消失。
    const digestBeforeCancel = control.lastDigest;
    await page.getByLabel("Scheduler 控制操作人").fill("human:release-manager");
    await page.getByRole("button", { name: "取消 Operation" }).click();
    await expect(page.getByText("Operation 已取消；Ledger 状态已刷新。")).toBeVisible();
    expect(control.cancelCalls).toEqual([
      {
        operationId,
        actor: "human:release-manager",
        expectedDigest: digestBeforeCancel,
      },
    ]);
    await expect(
      page.locator("#scheduler-agent-pool .agent-slot.slot-cancelling"),
    ).toHaveCount(0);
    await expect(page.getByText("取消待确认", { exact: true })).toHaveCount(0);
    await expect(
      page.locator("#scheduler-waves .scheduler-task-card[data-status='cancelled']"),
    ).toHaveCount(1);
  });
});
