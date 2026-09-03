import { readFindingExtension } from "@universal-harness-internal/core";
import {
  schedulerRecoveryActionFor,
  schedulerResumeCommand,
  type ApprovalRequestRecord,
  type SchedulerReadModel,
  type SchedulerTaskProjection,
} from "@universal-harness-internal/runtime";

import { DashboardProblem } from "./problem.js";

const STATUS_LABELS: Readonly<Record<SchedulerTaskProjection["status"], string>> = {
  waiting_dependency: "等待依赖",
  ready: "可调度",
  awaiting_approval: "等待审批",
  running: "执行中",
  verifying: "验证中",
  integration_queued: "等待集成",
  candidate_validated: "候选已验证",
  retry_pending: "等待重试",
  integrated: "已集成",
  blocked: "已阻塞",
  cancelled: "已取消",
};

const RISK_LABELS: Readonly<Record<ApprovalRequestRecord["risk"], string>> = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
  critical: "关键风险",
};

export interface DashboardSchedulerTask {
  readonly task_id: string;
  readonly title: string;
  readonly wave_index: number;
  readonly status: SchedulerTaskProjection["status"];
  readonly status_label: string;
  readonly authority: "authoritative" | "provisional";
  readonly success: boolean;
  readonly dependency_ids: readonly string[];
  readonly non_parallel_reasons: readonly string[];
  readonly current_run_id?: string;
  readonly retry_kind?: "executor_retry" | "integration_retry";
  readonly technical_details: {
    readonly task_id: string;
    readonly lease_digest?: string;
  };
}

export interface DashboardSchedulerSlot {
  readonly slot_id: string;
  readonly state: "idle" | "running" | "cancelling";
  readonly authority: "live";
  readonly task_id?: string;
  readonly run_id?: string;
}

export interface DashboardSchedulerApproval {
  readonly request_id: string;
  readonly action: string;
  readonly objective: string;
  readonly wave_index?: number;
  readonly risk: ApprovalRequestRecord["risk"];
  readonly risk_label: string;
  readonly reason: string;
  readonly allowed_decisions: readonly string[];
  readonly resume_command: string;
  readonly bindings: {
    readonly object_digest: string;
    readonly baseline_digest: string;
    readonly policy_digest: string;
    readonly plan_digest?: string;
  };
  readonly iteration_budget: SchedulerReadModel["budget"];
  readonly parallel_impact: readonly string[];
  readonly provider_context: {
    // ApprovalRequest 1.3 has no first-class grounded-brief field yet; keep
    // the explicit null (documented known limitation, plan Task 13) instead
    // of deriving governance facts from untrusted free text.
    readonly grounded_brief: null;
  };
}

export interface DashboardSchedulerFinding {
  readonly finding_id: string;
  readonly summary: string;
  readonly rule?: string;
  readonly recovery_action?: string;
}

export interface DashboardSchedulerView {
  readonly capability_status: SchedulerReadModel["capability_status"];
  readonly operation: SchedulerReadModel["operation"] & {
    readonly live_state_label: "实时投影可用" | "正在从 Ledger 重建";
  };
  readonly summary: {
    readonly current_wave: number | null;
    readonly total_waves: number;
    readonly running_slots: number;
    readonly total_slots: number;
    readonly task_progress: { readonly completed: number; readonly total: number };
    readonly blocking_findings: number;
    readonly pending_approvals: number;
  };
  readonly plan: SchedulerReadModel["plan"];
  readonly waves: readonly {
    readonly wave_index: number;
    readonly task_ids: readonly string[];
    readonly tasks: readonly DashboardSchedulerTask[];
  }[];
  readonly tasks: readonly DashboardSchedulerTask[];
  readonly slots: readonly DashboardSchedulerSlot[];
  readonly budget: SchedulerReadModel["budget"];
  readonly approvals: readonly DashboardSchedulerApproval[];
  readonly findings: readonly DashboardSchedulerFinding[];
  readonly presentation_map: SchedulerReadModel["presentation_map"];
  readonly control: {
    readonly read_branch_state: "aligned" | "mismatch" | "missing" | "stale";
    readonly writes_enabled: boolean;
    readonly cancel_available: boolean;
    readonly policy_proposal_available: boolean;
    readonly expected_digest: string;
    readonly reason?: string;
  };
  readonly technical_details: {
    readonly scheduler_digest: string;
    readonly plan_digest?: string;
  };
}

export interface DashboardSchedulerApi {
  read(input: { readonly operation_id: string }): Promise<DashboardSchedulerView>;
}

export interface DashboardSchedulerApiOptions {
  readonly readSchedulerModel: (operationId: string) => Promise<SchedulerReadModel>;
  readonly controlCapabilities?: {
    readonly cancel: boolean;
    readonly policyProposal: boolean;
  };
}

function findingRule(finding: SchedulerReadModel["findings"][number]): string | undefined {
  return readFindingExtension(finding)?.rule;
}

function approvalObjective(
  approval: ApprovalRequestRecord,
  taskById: ReadonlyMap<string, DashboardSchedulerTask>,
): string {
  return taskById.get(approval.object_id)?.title ?? approval.reason;
}

function project(
  model: SchedulerReadModel,
  requestedOperationId: string,
  capabilities: DashboardSchedulerApiOptions["controlCapabilities"],
): DashboardSchedulerView {
  const tasks: DashboardSchedulerTask[] = model.tasks.map((task) => {
    const authority = task.authority === "ledger" ? "authoritative" : "provisional";
    return {
      task_id: task.task_id,
      title: task.title,
      wave_index: task.wave_index,
      status: task.status,
      status_label: STATUS_LABELS[task.status],
      authority,
      success: authority === "authoritative" && task.status === "integrated",
      dependency_ids: [...task.dependency_ids],
      non_parallel_reasons: [...task.non_parallel_reasons],
      ...(task.current_run_id === undefined ? {} : { current_run_id: task.current_run_id }),
      ...(task.retry_kind === undefined ? {} : { retry_kind: task.retry_kind }),
      technical_details: {
        task_id: task.task_id,
        ...(task.current_lease_digest === undefined
          ? {}
          : { lease_digest: task.current_lease_digest }),
      },
    };
  });
  const taskById = new Map(tasks.map((task) => [task.task_id, task] as const));
  const waves =
    model.plan?.waves.map((wave) => ({
      wave_index: wave.wave_index,
      task_ids: [...wave.task_ids],
      tasks: wave.task_ids.flatMap((taskId) => {
        const task = taskById.get(taskId);
        return task === undefined ? [] : [task];
      }),
    })) ?? [];
  const incompleteWaves = waves.filter((wave) =>
    wave.tasks.some((task) => task.status !== "integrated" && task.status !== "cancelled"),
  );
  const currentWave = incompleteWaves[0]?.wave_index ?? null;
  const slots: DashboardSchedulerSlot[] =
    model.operation.live_state === "rebuilding"
      ? []
      : // The runtime read model intentionally omits raw heartbeat, process and
        // usage fields; the UI renders its fixed Provider 未提供 fallbacks.
        model.slots.map((slot) => ({
          slot_id: slot.slot_id,
          state: slot.state,
          authority: "live",
          ...(slot.task_id === undefined ? {} : { task_id: slot.task_id }),
          ...(slot.run_id === undefined ? {} : { run_id: slot.run_id }),
        }));
  const readBranchState =
    model.operation.operation_id !== requestedOperationId
      ? "mismatch"
      : model.capability_status !== "active" || model.plan === null
        ? "missing"
        : ["completed", "aborted", "cancelled"].includes(model.operation.status)
          ? "stale"
          : "aligned";
  const writesEnabled = readBranchState === "aligned";
  const controlReason =
    readBranchState === "mismatch"
      ? `读取结果属于 ${model.operation.operation_id}，不是请求的 ${requestedOperationId}`
      : readBranchState === "missing"
        ? "当前 Operation 没有可写的 Scheduler Plan/read branch"
        : readBranchState === "stale"
          ? `当前 Operation 已处于 ${model.operation.status}，只允许历史读取`
          : undefined;

  return {
    capability_status: model.capability_status,
    operation: {
      ...model.operation,
      live_state_label:
        model.operation.live_state === "observed" ? "实时投影可用" : "正在从 Ledger 重建",
    },
    summary: {
      current_wave: currentWave,
      total_waves: waves.length,
      running_slots: slots.filter((slot) => slot.state === "running").length,
      total_slots: slots.length,
      task_progress: {
        completed: tasks.filter((task) => task.status === "integrated").length,
        total: tasks.length,
      },
      blocking_findings: model.findings.length,
      pending_approvals: model.approvals.length,
    },
    plan: model.plan,
    waves,
    tasks,
    slots,
    budget: model.budget,
    approvals: model.approvals.map((approval) => {
      const task = taskById.get(approval.object_id);
      return {
        request_id: approval.request_id,
        action: approval.object_type,
        objective: approvalObjective(approval, taskById),
        ...(task === undefined ? {} : { wave_index: task.wave_index }),
        risk: approval.risk,
        risk_label: RISK_LABELS[approval.risk],
        reason: approval.reason,
        allowed_decisions: [...approval.allowed_decisions],
        resume_command: schedulerResumeCommand(approval.workflow_operation_id),
        bindings: {
          object_digest: approval.object_digest,
          baseline_digest: approval.baseline_digest,
          policy_digest: approval.policy_digest,
          ...(model.plan === null ? {} : { plan_digest: model.plan.plan_digest }),
        },
        iteration_budget: model.budget,
        parallel_impact: task?.non_parallel_reasons ?? [],
        provider_context: {
          grounded_brief: null,
        },
      };
    }),
    findings: model.findings.map((finding) => {
      const rule = findingRule(finding);
      const recovery = rule === undefined ? undefined : schedulerRecoveryActionFor(rule);
      return {
        finding_id: finding.id,
        summary: finding.summary,
        ...(rule === undefined ? {} : { rule }),
        ...(recovery === undefined ? {} : { recovery_action: recovery }),
      };
    }),
    presentation_map: model.presentation_map,
    control: {
      read_branch_state: readBranchState,
      writes_enabled: writesEnabled,
      cancel_available: writesEnabled && capabilities?.cancel === true,
      policy_proposal_available: writesEnabled && capabilities?.policyProposal === true,
      expected_digest: model.digest,
      ...(controlReason === undefined ? {} : { reason: controlReason }),
    },
    technical_details: {
      scheduler_digest: model.digest,
      ...(model.plan === null ? {} : { plan_digest: model.plan.plan_digest }),
    },
  };
}

/** Thin, read-only projection over the runtime-owned Scheduler Read Model. */
export function createDashboardSchedulerApi(
  options: DashboardSchedulerApiOptions,
): DashboardSchedulerApi {
  return {
    read: async ({ operation_id }) =>
      project(
        await options.readSchedulerModel(operation_id),
        operation_id,
        options.controlCapabilities,
      ),
  };
}

/** Default for hosts that have no Scheduler composition root. */
export function unavailableDashboardSchedulerApi(): DashboardSchedulerApi {
  return {
    read: () =>
      Promise.reject(
        new DashboardProblem(
          503,
          "scheduler_unavailable",
          "Service Unavailable",
          "this Dashboard host did not configure the Scheduler read service",
        ),
      ),
  };
}
