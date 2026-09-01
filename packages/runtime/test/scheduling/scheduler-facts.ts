import {
  buildTaskLeaseRecord,
  buildWaveIntegrationRecord,
  contentDigest,
  type FeedbackRecord,
  type RunRecord,
  type TaskLeaseRecord,
  type WaveIntegrationRecord,
} from "@universal-harness-internal/core";

import type { ApprovalRequestRecord } from "../../src/approval/request.js";
import type { GateEvidenceRecord } from "../../src/gates/evidence.js";
import type { Protocol13TaskSpecification } from "../../src/planning/task.js";
import type { TaskDagSnapshot } from "../../src/scheduling/ports.js";

/**
 * Shared authority fixtures for the scheduler projection tests (plan Task 8
 * step 3). Everything is built through the real record builders where one
 * exists, so fixtures carry valid digests and pass the semantic invariants.
 */

export const OPERATION_ID = "operation_1";
export const ITERATION_ID = "iteration_1";
export const PLAN_DIGEST = "c".repeat(64);
export const BASELINE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

export function fixtureTask(
  id: string,
  dependencies: readonly string[] = [],
): Protocol13TaskSpecification {
  return {
    id,
    objective: `Implement ${id}`,
    impact_paths: [[`impact-${id}`]],
    expected_outputs: [`${id}-output`],
    capabilities: ["code-edit"],
    tools: [],
    dependencies: [...dependencies],
    risk: "low",
    budget: { max_steps: 10, max_tokens: 1000, max_duration_ms: 60_000 },
    write_paths: ["src"],
    exclusive_resources: [],
    acceptance: [{ description: "works", verification: "unit test" }],
    required_gates: [],
  };
}

export function fixtureDag(tasks: readonly Protocol13TaskSpecification[]): TaskDagSnapshot {
  const waves = tasks.length === 0 ? [] : [{ wave_index: 0, task_ids: tasks.map((t) => t.id) }];
  return {
    operation_id: OPERATION_ID,
    iteration_id: ITERATION_ID,
    plan_id: "plan_1",
    plan_digest: PLAN_DIGEST,
    baseline_commit: BASELINE_COMMIT,
    tasks,
    parallel_waves: waves,
    iteration_budget: { steps: 100, tokens: 100_000, duration_ms: 3_600_000 },
  };
}

export function fixtureDagWithWaves(
  tasks: readonly Protocol13TaskSpecification[],
  waves: readonly { wave_index: number; task_ids: readonly string[] }[],
): TaskDagSnapshot {
  return { ...fixtureDag(tasks), parallel_waves: waves };
}

let leaseCounter = 0;

export function grantedLease(
  taskId: string,
  runId: string,
  overrides: Partial<TaskLeaseRecord> = {},
): TaskLeaseRecord {
  leaseCounter += 1;
  const commandId = `command_${String(leaseCounter)}`;
  return buildTaskLeaseRecord({
    operation_id: OPERATION_ID,
    iteration_id: ITERATION_ID,
    plan_digest: PLAN_DIGEST,
    task_id: taskId,
    task_digest: contentDigest({ task: taskId }),
    run_id: runId,
    slot_id: "slot_1",
    baseline_commit: BASELINE_COMMIT,
    agent_adapter_digest: "d".repeat(64),
    policy_digest: "e".repeat(64),
    approval_digests: [],
    task_lease_record_id: `task-lease-record_${String(leaseCounter)}_granted`,
    lease_id: `lease_${taskId}_${String(leaseCounter)}`,
    fencing_token: leaseCounter,
    state: "granted",
    attempt_number: 1,
    reserved_budget: { steps: 10, tokens: 1000 },
    consumed_budget: { steps: 0, tokens: 0 },
    issued_at: "2026-08-31T00:00:00.000Z",
    expires_at: "2026-08-31T01:00:00.000Z",
    command_id: commandId,
    ...overrides,
  });
}

export function closedLease(
  granted: TaskLeaseRecord,
  state: "released" | "expired" | "revoked",
  overrides: Partial<TaskLeaseRecord> = {},
): TaskLeaseRecord {
  // Strip the sealed envelope fields; the builder re-derives them.
  const identity: Record<string, unknown> = { ...granted };
  delete identity.record_digest;
  delete identity.protocol_version;
  delete identity.record_kind;
  return buildTaskLeaseRecord({
    ...(identity as unknown as Omit<
      TaskLeaseRecord,
      "protocol_version" | "record_kind" | "record_digest"
    >),
    task_lease_record_id: `${granted.task_lease_record_id}_${state}`,
    previous_lease_record_digest: granted.record_digest,
    state,
    consumed_budget: { steps: 1, tokens: 10 },
    ...overrides,
  });
}

export function runStarted(taskId: string, runId: string, sequence = 1): RunRecord {
  return {
    protocol_version: "1.3.0",
    record_kind: "run_started",
    run_id: runId,
    task_id: taskId,
    workflow_operation_id: OPERATION_ID,
    attempt_id: `attempt_${runId}`,
    sequence,
    timestamp: "2026-08-31T00:00:01.000Z",
    context_bundle_id: `context_${runId}`,
  };
}

export function runTerminated(
  taskId: string,
  runId: string,
  outcome: "success" | "handoff" | "partial" | "failed" | "correct_block",
  terminationReason:
    | "completion"
    | "gate_failure"
    | "policy_denial"
    | "budget_ceiling"
    | "repeat_detection"
    | "timeout"
    | "adapter_failure"
    | "user_cancellation"
    | "manual_stop"
    | "process_interruption",
  sequence = 2,
): RunRecord {
  return {
    protocol_version: "1.3.0",
    record_kind: "run_terminated",
    run_id: runId,
    task_id: taskId,
    workflow_operation_id: OPERATION_ID,
    attempt_id: `attempt_${runId}`,
    sequence,
    timestamp: "2026-08-31T00:00:02.000Z",
    outcome,
    termination_reason: terminationReason,
  };
}

export function gateEvidence(
  taskId: string,
  options: { passed?: boolean; provisional?: boolean; id?: string } = {},
): GateEvidenceRecord {
  const evidenceId = options.id ?? `evidence_${taskId}`;
  return {
    protocol_version: "1.3.0",
    record_kind: "evidence",
    evidence_id: evidenceId,
    evidence_type: "gate_result",
    subject_id: taskId,
    digest: contentDigest({ evidence: evidenceId }),
    provisional: options.provisional ?? false,
    created_at: "2026-08-31T00:00:03.000Z",
    extensions: {
      "harness.gate": {
        gate_id: "gate_unit",
        layer: "project",
        mandatory: true,
        passed: options.passed ?? true,
        exit_code: 0,
        summary: "gate passed",
        log_summary: "ok",
        artifact_hashes: {},
        bindings: {
          artifact_digests: [],
          code_digests: [],
          gate_digest: "1".repeat(64),
          evaluation_case_digests: [],
          policy_digest: "e".repeat(64),
        },
      },
    },
  };
}

export function pendingApproval(taskId: string): ApprovalRequestRecord {
  return {
    protocol_version: "1.3.0",
    record_kind: "approval_request",
    request_id: `request_${taskId}`,
    workflow_operation_id: OPERATION_ID,
    object_id: taskId,
    object_type: "scheduler_action",
    object_digest: contentDigest({ object: taskId }),
    baseline_digest: "2".repeat(64),
    policy_digest: "e".repeat(64),
    preview_digest: "3".repeat(64),
    impact_path: [],
    risk: "low",
    reason: "dispatch requires approval",
    allowed_decisions: ["approve", "reject"],
    created_at: "2026-08-31T00:00:00.500Z",
    resume_phase: "execute",
  };
}

export function blockingFinding(
  taskId: string,
  status: FeedbackRecord["status"] = "proposed",
): FeedbackRecord {
  return {
    protocol_version: "1.3.0",
    record_kind: "feedback",
    id: `finding_${taskId}`,
    type: "Finding",
    iteration_id: ITERATION_ID,
    status,
    summary: `task ${taskId} is blocked`,
    created_at: "2026-08-31T00:00:04.000Z",
    digest: contentDigest({ finding: taskId }),
    extensions: {
      "harness.finding": {
        origin: "test",
        blocking: true,
        violates: [],
        blocks: [taskId],
        evidence: [],
      },
    },
  };
}

export function waveIntegration(
  waveIndex: number,
  taskIds: readonly string[],
): WaveIntegrationRecord {
  return buildWaveIntegrationRecord({
    wave_integration_id: `wave-integration_${String(waveIndex)}`,
    operation_id: OPERATION_ID,
    iteration_id: ITERATION_ID,
    plan_digest: PLAN_DIGEST,
    wave_index: waveIndex,
    task_ids: [...taskIds],
    base_commit: BASELINE_COMMIT,
    candidate_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    accepted_source_tree_digest: "4".repeat(64),
    task_lease_digests: ["5".repeat(64)],
    task_evidence_digests: ["6".repeat(64)],
    candidate_gate_evidence_digests: ["7".repeat(64)],
    wave_gate_evidence_digests: ["8".repeat(64)],
    policy_digest: "e".repeat(64),
    approval_digests: [],
    command_id: `command_integrate_${String(waveIndex)}`,
    integrated_at: "2026-08-31T00:00:05.000Z",
  });
}
