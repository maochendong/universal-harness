import { afterEach, describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";
import { contentDigest, type FeedbackRecord } from "@universal-harness-internal/core";
import {
  createNewProject,
  type ApprovalRequestRecord,
  type SchedulerReadModel,
} from "@universal-harness-internal/runtime";

import {
  createDashboardSchedulerApi,
  startDashboardServer,
  type DashboardSchedulerApi,
  type DashboardServer,
  type DashboardWriteApi,
} from "../src/index.js";

const roots: string[] = [];
const servers: DashboardServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  const { rmSync } = await import("node:fs");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function project(): Promise<string> {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const parent = mkdtempSync(join(tmpdir(), "harness-dashboard-scheduler-"));
  roots.push(parent);
  const created = await createNewProject(
    { parentDirectory: parent, name: "dashboard-scheduler", intent: "inspect task waves" },
    { vcs: createGitVcsAdapter() },
  );
  if (!created.ok) throw new Error(created.error.message);
  return created.value.projectRoot;
}

function approval(): ApprovalRequestRecord {
  return {
    protocol_version: "1.3.0",
    record_kind: "approval_request",
    request_id: "approval_dispatch_api",
    workflow_operation_id: "operation_1",
    object_id: "task_api",
    object_type: "dispatch_task",
    object_digest: "d".repeat(64),
    baseline_digest: "b".repeat(64),
    policy_digest: "p".repeat(64),
    preview_digest: "v".repeat(64),
    impact_path: ["plan_1", "task_api"],
    risk: "high",
    reason: "并行写入需要人工确认。",
    allowed_decisions: ["approve", "reject", "defer"],
    created_at: "2026-08-31T00:00:00.000Z",
    resume_phase: "execute",
  };
}

function finding(): FeedbackRecord {
  const content = {
    protocol_version: "1.3.0",
    record_kind: "feedback" as const,
    id: "finding_budget",
    type: "Finding" as const,
    iteration_id: "iteration_1",
    status: "proposed" as const,
    summary: "Task 预算不足。",
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

function schedulerModel(liveState: "observed" | "rebuilding" = "observed"): SchedulerReadModel {
  const content = {
    capability_status: "active" as const,
    operation: {
      operation_id: "operation_1",
      iteration_id: "iteration_1",
      status: "running",
      live_state: liveState,
    },
    plan: {
      plan_id: "plan_1",
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
        status: "candidate_validated" as const,
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
        title: "交付调度视图",
        wave_index: 1,
        status: "waiting_dependency" as const,
        authority: "provisional" as const,
        dependency_ids: ["task_api", "task_contract"],
        non_parallel_reasons: [],
      },
    ],
    slots: [
      { slot_id: "slot_1", state: "running" as const, task_id: "task_api", run_id: "run_api" },
      { slot_id: "slot_2", state: "idle" as const },
    ],
    budget: {
      limit: { steps: 100, tokens: 10_000, duration_ms: 60_000 },
      consumed_steps: 24,
      consumed_tokens: 2_400,
      reserved_steps: 20,
      reserved_tokens: 2_000,
    },
    approvals: [approval()],
    findings: [finding()],
    presentation_map: { "task:task_api": "实现 API 契约" },
  };
  return { ...content, digest: contentDigest(content) };
}

async function authenticated(server: DashboardServer): Promise<string> {
  const response = await fetch(server.bootstrapUrl, { redirect: "manual" });
  return (response.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
}

async function session(server: DashboardServer): Promise<{ cookie: string; csrf: string }> {
  const cookie = await authenticated(server);
  const response = await fetch(`${server.origin}/api/v1/session`, { headers: { cookie } });
  const body = (await response.json()) as { data: { csrf_token: string } };
  return { cookie, csrf: body.data.csrf_token };
}

describe("Dashboard Scheduler API", () => {
  it("projects one coherent, source-labelled Scheduler snapshot without raw local details", async () => {
    const api = createDashboardSchedulerApi({
      readSchedulerModel: () => Promise.resolve(schedulerModel()),
    });

    const response = await api.read({ operation_id: "operation_1" });

    expect(response.summary).toMatchObject({
      current_wave: 0,
      total_waves: 2,
      running_slots: 1,
      total_slots: 2,
      task_progress: { completed: 0, total: 3 },
    });
    expect(response.tasks[0]).toMatchObject({
      task_id: "task_api",
      title: "实现 API 契约",
      status_label: "候选已验证",
      authority: "authoritative",
    });
    expect(response.tasks[2]).toMatchObject({
      task_id: "task_ui",
      authority: "provisional",
      success: false,
    });
    expect(response.slots[0]).toMatchObject({
      slot_id: "slot_1",
      authority: "live",
      task_id: "task_api",
    });
    expect(response.approvals[0]).toMatchObject({
      action: "dispatch_task",
      risk_label: "高风险",
      resume_command: "harness resume operation_1",
    });
    expect(response.findings[0]).toMatchObject({
      recovery_action: "submit_budget_policy_proposal",
    });
    expect(JSON.stringify(response)).not.toMatch(
      /(?:\/Users\/|\.harness\/managed|raw_trace|environment|api[_-]?key)/iu,
    );
  });

  it("keeps authoritative progress while explicitly reporting a lost live projection", async () => {
    const api = createDashboardSchedulerApi({
      readSchedulerModel: () => Promise.resolve(schedulerModel("rebuilding")),
    });

    const response = await api.read({ operation_id: "operation_1" });

    expect(response.operation.live_state).toBe("rebuilding");
    expect(response.operation.live_state_label).toBe("正在从 Ledger 重建");
    expect(response.tasks[0]?.status).toBe("candidate_validated");
    expect(response.slots).toEqual([]);
  });

  it("fails controls closed for mismatched, missing and stale operation read branches", async () => {
    const mismatched = await createDashboardSchedulerApi({
      readSchedulerModel: () => Promise.resolve(schedulerModel()),
      controlCapabilities: { cancel: true, policyProposal: false },
    }).read({ operation_id: "operation_other" });
    expect(mismatched.control).toMatchObject({
      read_branch_state: "mismatch",
      writes_enabled: false,
      cancel_available: false,
      policy_proposal_available: false,
    });

    const activeModel = schedulerModel("rebuilding");
    const missingModel: SchedulerReadModel = {
      ...activeModel,
      capability_status: "inactive_by_profile",
      plan: null,
      digest: contentDigest({ missing: activeModel.digest }),
    };
    const missing = await createDashboardSchedulerApi({
      readSchedulerModel: () => Promise.resolve(missingModel),
      controlCapabilities: { cancel: true, policyProposal: true },
    }).read({ operation_id: "operation_1" });
    expect(missing.control).toMatchObject({
      read_branch_state: "missing",
      writes_enabled: false,
      cancel_available: false,
      policy_proposal_available: false,
      expected_digest: missingModel.digest,
    });

    const staleModel = schedulerModel();
    const stale = await createDashboardSchedulerApi({
      readSchedulerModel: () =>
        Promise.resolve({
          ...staleModel,
          operation: { ...staleModel.operation, status: "completed" },
          digest: contentDigest({ stale: staleModel.digest }),
        }),
      controlCapabilities: { cancel: true, policyProposal: true },
    }).read({ operation_id: "operation_1" });
    expect(stale.control).toMatchObject({ read_branch_state: "stale", writes_enabled: false });
  });

  it("resolves the authoritative active Scheduler operation on every project refresh", async () => {
    const operationIds = ["operation_first", "operation_second", undefined];
    const server = await startDashboardServer({
      projectRoot: await project(),
      schedulerOperationId: () => operationIds.shift(),
    });
    servers.push(server);
    const cookie = await authenticated(server);

    const read = async (): Promise<string | undefined> => {
      const response = await fetch(`${server.origin}/api/v1/project`, { headers: { cookie } });
      const body = (await response.json()) as { data: { scheduler_operation_id?: string } };
      return body.data.scheduler_operation_id;
    };
    await expect(read()).resolves.toBe("operation_first");
    await expect(read()).resolves.toBe("operation_second");
    await expect(read()).resolves.toBeUndefined();
  });

  it("serves GET /api/v1/scheduler and rejects missing, malformed or repeated operation_id", async () => {
    const schedulerApi: DashboardSchedulerApi = createDashboardSchedulerApi({
      readSchedulerModel: () => Promise.resolve(schedulerModel()),
    });
    const server = await startDashboardServer({
      projectRoot: await project(),
      schedulerApi,
    });
    servers.push(server);
    const cookie = await authenticated(server);

    const accepted = await fetch(`${server.origin}/api/v1/scheduler?operation_id=operation_1`, {
      headers: { cookie },
    });
    expect(accepted.status).toBe(200);
    const acceptedBody = (await accepted.json()) as {
      data: { operation: { operation_id: string }; tasks: { title: string }[] };
    };
    expect(acceptedBody.data.operation.operation_id).toBe("operation_1");
    expect(acceptedBody.data.tasks[0]?.title).toBe("实现 API 契约");

    for (const suffix of [
      "",
      "?operation_id=../../secret",
      "?operation_id=operation_1&operation_id=operation_2",
      "?operation_id=operation_1&raw_trace=true",
    ]) {
      const response = await fetch(`${server.origin}/api/v1/scheduler${suffix}`, {
        headers: { cookie },
      });
      expect(response.status).toBe(400);
    }
  });

  it("admits only governed Scheduler writes and exposes no force-action route", async () => {
    const calls: unknown[] = [];
    const writeApi: DashboardWriteApi = {
      decideApproval: () => Promise.resolve({ status: "decided" }),
      resumeWorkflow: () => Promise.resolve({ status: "resumed" }),
      resolveFindingGroup: () => Promise.resolve({ status: "resolved" }),
      cancelSchedulerOperation: (input) => {
        calls.push(["cancel", input]);
        return Promise.resolve({ status: "cancelled", evidence_digest: "1".repeat(64) });
      },
      proposeSchedulerPolicy: (input) => {
        calls.push(["policy", input]);
        return Promise.resolve({ status: "proposed", evidence_digest: "2".repeat(64) });
      },
    };
    const server = await startDashboardServer({
      projectRoot: await project(),
      schedulerApi: createDashboardSchedulerApi({
        readSchedulerModel: () => Promise.resolve(schedulerModel()),
      }),
      writeApi,
    });
    servers.push(server);
    const auth = await session(server);
    const headers = {
      cookie: auth.cookie,
      origin: server.origin,
      "content-type": "application/json",
      "x-harness-csrf": auth.csrf,
    };

    const cancelled = await fetch(
      `${server.origin}/api/v1/scheduler/operations/operation_1/cancel`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ expected_digest: "a".repeat(64), actor: "human:operator" }),
      },
    );
    expect(cancelled.status).toBe(200);

    const proposed = await fetch(`${server.origin}/api/v1/scheduler/policy-proposals`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        operation_id: "operation_1",
        proposal_kind: "concurrency",
        max_concurrency: 3,
        expected_digest: "b".repeat(64),
        actor: "human:operator",
      }),
    });
    expect(proposed.status).toBe(200);
    expect(calls).toEqual([
      [
        "cancel",
        {
          operationId: "operation_1",
          expectedDigest: "a".repeat(64),
          actor: "human:operator",
        },
      ],
      [
        "policy",
        {
          operationId: "operation_1",
          proposalKind: "concurrency",
          maxConcurrency: 3,
          expectedDigest: "b".repeat(64),
          actor: "human:operator",
        },
      ],
    ]);

    for (const action of [
      "force_task_success",
      "skip_gate",
      "move_task_to_slot",
      "force_release_lease",
      "force_merge_candidate",
      "ignore_baseline_drift",
    ]) {
      const response = await fetch(`${server.origin}/api/v1/scheduler/actions/${action}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ expected_digest: "c".repeat(64), actor: "human:operator" }),
      });
      expect(response.status).toBe(404);
    }
    expect(calls).toHaveLength(2);
  });
});
