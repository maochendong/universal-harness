import { PROTOCOL_VERSION, contentDigest } from "@universal-harness-internal/core";
import type { BudgetObservation } from "@universal-harness-internal/plugin-sdk";

import type { RunOutcome } from "../loop/outcome.js";
import type { AdapterControlProfile } from "../policy/action.js";
import {
  ABORT_REASONS,
  RECOVERABLE_BLOCK_REASONS,
  type AbortReason,
  type RecoverableBlockReason,
} from "../workflow/state-machine.js";
import type { BudgetUse, ExternalActionIntent } from "../workflow/working-state.js";

/**
 * Iteration Snapshot builder (design 10.3, plan Task 22). A Snapshot anchors
 * an iteration to its final Git commit and records what Evidence proves:
 * execution results, a redacted trajectory/coverage summary, budget use,
 * approvals, current Evidence, closed Findings, unresolved non-blocking items,
 * rejected hypotheses and ImprovementCandidates. The status is derived from
 * evidence, never declared: `completed` is refused while any required task or
 * run is not a success, any blocking Finding is open, any mandatory Evidence
 * is stale or any external action is unfinished; recoverable states produce
 * `blocked` with a resume phase, and only an explicit cancellation or a typed
 * unrecoverable reason produces the terminal `aborted`.
 */
export const SNAPSHOT_ERROR_KINDS = [
  "invalid_snapshot",
  "completion_blocked",
  "invalid_block",
  "invalid_abort",
] as const;

export type SnapshotErrorKind = (typeof SNAPSHOT_ERROR_KINDS)[number];

export class SnapshotError extends Error {
  readonly kind: SnapshotErrorKind;
  /** Reasons `completed` was refused, for the `completion_blocked` kind. */
  readonly blockers: readonly string[];

  constructor(kind: SnapshotErrorKind, message: string, blockers: readonly string[] = []) {
    super(message);
    this.name = "SnapshotError";
    this.kind = kind;
    this.blockers = blockers;
  }
}

export const SNAPSHOT_STATUSES = ["completed", "blocked", "aborted"] as const;

export type SnapshotStatus = (typeof SNAPSHOT_STATUSES)[number];

export interface SnapshotTaskResult {
  readonly task_id: string;
  /** Required tasks must succeed before `completed` is allowed. */
  readonly required: boolean;
  readonly outcome: RunOutcome | "pending";
}

export interface SnapshotRunResult {
  readonly run_id: string;
  readonly required: boolean;
  readonly outcome: RunOutcome;
}

export interface SnapshotTaskVerdict {
  readonly verdict_id: string;
  readonly task_id: string;
  readonly verdict: "passed" | "failed" | "blocked";
}

export interface SnapshotFindingState {
  readonly finding_id: string;
  readonly blocking: boolean;
  readonly status: "proposed" | "accepted" | "closed" | "superseded";
}

export interface SnapshotEvidenceState {
  readonly evidence_id: string;
  readonly mandatory: boolean;
  readonly passed: boolean;
  readonly provisional: boolean;
  readonly stale: boolean;
}

export interface SnapshotImprovementState {
  readonly candidate_id: string;
  readonly status: "proposed" | "promoted" | "superseded";
}

export interface SnapshotInput {
  readonly snapshot_id: string;
  readonly iteration_id: string;
  /** Git commit containing the exact source tree proved by gates. */
  readonly source_commit: string;
  readonly workflow_operation_id: string;
  readonly created_at: string;
  readonly execution_plan_id?: string;
  readonly adapter_control_profile?: AdapterControlProfile;
  readonly adapter_profile_digest?: string;
  readonly tasks: readonly SnapshotTaskResult[];
  readonly task_verdicts?: readonly SnapshotTaskVerdict[];
  readonly runs?: readonly SnapshotRunResult[];
  readonly findings?: readonly SnapshotFindingState[];
  readonly evidence?: readonly SnapshotEvidenceState[];
  readonly external_actions?: readonly ExternalActionIntent[];
  /** Digests of the approval decisions relied on. */
  readonly approvals?: readonly string[];
  readonly budget?: BudgetUse;
  readonly budget_observations?: readonly BudgetObservation[];
  /** Redacted trajectory/coverage summaries; never raw provider payloads. */
  readonly trajectory_summary?: string;
  readonly coverage_summary?: string;
  readonly unresolved_items?: readonly string[];
  readonly rejected_hypotheses?: readonly string[];
  readonly improvement_candidates?: readonly SnapshotImprovementState[];
  /** Required for `blocked`: phase the resume re-enters. */
  readonly resume_phase?: string;
  /** Required for `blocked`: the typed recoverable reason. */
  readonly block_reason?: RecoverableBlockReason;
  /** Latest valid checkpoint the resume starts from. */
  readonly checkpoint_id?: string;
  /** Required for `aborted`: explicit cancel or typed unrecoverable reason. */
  readonly abort_reason?: AbortReason;
}

export interface SnapshotRecord {
  readonly protocol_version: string;
  readonly record_kind: "snapshot";
  readonly snapshot_id: string;
  readonly iteration_id: string;
  readonly status: SnapshotStatus;
  readonly source_commit?: string;
  /** Compatibility alias for pre-hardening readers; always equals source_commit on new records. */
  readonly final_commit: string;
  readonly workflow_operation_id: string;
  readonly created_at: string;
  readonly execution_plan_id?: string;
  readonly adapter_control_profile?: AdapterControlProfile;
  readonly adapter_profile_digest?: string;
  readonly run_outcomes: readonly { readonly id: string; readonly outcome: string }[];
  readonly task_verdicts: readonly SnapshotTaskVerdict[];
  readonly budget?: BudgetUse;
  readonly budget_observations?: readonly BudgetObservation[];
  readonly trajectory_summary?: string;
  readonly coverage_summary?: string;
  readonly approvals: readonly string[];
  readonly evidence: readonly string[];
  readonly closed_findings: readonly string[];
  readonly unresolved_items: readonly string[];
  readonly rejected_hypotheses: readonly string[];
  readonly improvement_candidates: readonly {
    readonly id: string;
    readonly status: string;
  }[];
  readonly resume_phase?: string;
  readonly blockers?: readonly string[];
  readonly checkpoint_id?: string;
  readonly abort_reason?: string;
  readonly digest: string;
}

const FINAL_COMMIT_PATTERN = /^[0-9a-f]{7,40}$/u;

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

/**
 * Every reason the iteration may not snapshot as `completed`, in a fixed
 * order: unfinished required tasks, unsuccessful required runs, open blocking
 * findings, stale or non-passing mandatory evidence, then unfinished external
 * actions. An empty result means `completed` is allowed.
 */
export function snapshotCompletionBlockers(input: SnapshotInput): readonly string[] {
  const blockers: string[] = [];
  const verdictByTask = new Map(
    (input.task_verdicts ?? []).map((verdict) => [verdict.task_id, verdict]),
  );
  for (const task of [...input.tasks].sort((left, right) =>
    left.task_id < right.task_id ? -1 : 1,
  )) {
    if (!task.required) continue;
    if (input.task_verdicts !== undefined) {
      const verdict = verdictByTask.get(task.task_id);
      if (verdict === undefined) {
        blockers.push(`required task ${task.task_id} has no TaskVerdict`);
      } else if (verdict.verdict !== "passed") {
        blockers.push(`required task ${task.task_id} verdict is ${verdict.verdict}`);
      }
    } else if (task.outcome === "pending") {
      blockers.push(`required task ${task.task_id} has not finished`);
    } else if (task.outcome !== "success") {
      blockers.push(`required task ${task.task_id} ended with outcome ${task.outcome}`);
    }
  }
  if (input.task_verdicts === undefined) {
    for (const run of [...(input.runs ?? [])].sort((left, right) =>
      left.run_id < right.run_id ? -1 : 1,
    )) {
      if (run.required && run.outcome !== "success") {
        blockers.push(`required run ${run.run_id} ended with outcome ${run.outcome}`);
      }
    }
  }
  for (const finding of [...(input.findings ?? [])].sort((left, right) =>
    left.finding_id < right.finding_id ? -1 : 1,
  )) {
    if (!finding.blocking) continue;
    if (finding.status !== "closed" && finding.status !== "superseded") {
      blockers.push(`blocking finding ${finding.finding_id} is ${finding.status}`);
    }
  }
  for (const evidence of [...(input.evidence ?? [])].sort((left, right) =>
    left.evidence_id < right.evidence_id ? -1 : 1,
  )) {
    if (!evidence.mandatory) continue;
    if (evidence.stale) {
      blockers.push(`mandatory evidence ${evidence.evidence_id} is stale`);
    } else if (evidence.provisional || !evidence.passed) {
      blockers.push(`mandatory evidence ${evidence.evidence_id} has no current passing verdict`);
    }
  }
  for (const action of [...(input.external_actions ?? [])].sort((left, right) =>
    left.intent_id < right.intent_id ? -1 : 1,
  )) {
    if (action.status !== "completed") {
      blockers.push(`external action ${action.intent_id} is ${action.status}`);
    }
  }
  return blockers;
}

function assertCommonShape(input: SnapshotInput): void {
  if (!FINAL_COMMIT_PATTERN.test(input.source_commit)) {
    throw new SnapshotError(
      "invalid_snapshot",
      `source commit ${JSON.stringify(input.source_commit)} is not a lowercase hex commit id; a Snapshot must anchor to a real Git commit`,
    );
  }
  if (input.snapshot_id.trim().length === 0 || input.iteration_id.trim().length === 0) {
    throw new SnapshotError("invalid_snapshot", "snapshot and iteration ids must be non-empty");
  }
  if (input.workflow_operation_id.trim().length === 0) {
    throw new SnapshotError("invalid_snapshot", "a Snapshot must record its workflow operation id");
  }
  if (input.adapter_control_profile !== undefined) {
    const expected = contentDigest(input.adapter_control_profile);
    if (input.adapter_profile_digest !== expected) {
      throw new SnapshotError(
        "invalid_snapshot",
        `adapter profile digest must match the embedded control profile: expected ${expected}`,
      );
    }
  } else if (input.adapter_profile_digest !== undefined) {
    throw new SnapshotError(
      "invalid_snapshot",
      "adapter profile digest cannot exist without an embedded control profile",
    );
  }
}

function buildRecord(input: SnapshotInput, status: SnapshotStatus): SnapshotRecord {
  const content: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "snapshot",
    snapshot_id: input.snapshot_id,
    iteration_id: input.iteration_id,
    status,
    source_commit: input.source_commit,
    final_commit: input.source_commit,
    workflow_operation_id: input.workflow_operation_id,
    created_at: input.created_at,
    ...(input.execution_plan_id === undefined
      ? {}
      : { execution_plan_id: input.execution_plan_id }),
    ...(input.adapter_control_profile === undefined
      ? {}
      : { adapter_control_profile: input.adapter_control_profile }),
    ...(input.adapter_profile_digest === undefined
      ? {}
      : { adapter_profile_digest: input.adapter_profile_digest }),
    run_outcomes: (input.runs ?? [])
      .map((run) => ({ id: run.run_id, outcome: run.outcome }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    task_verdicts: [...(input.task_verdicts ?? [])].sort((left, right) =>
      left.task_id.localeCompare(right.task_id),
    ),
    ...(input.budget === undefined ? {} : { budget: input.budget }),
    ...(input.budget_observations === undefined
      ? {}
      : { budget_observations: input.budget_observations }),
    ...(input.trajectory_summary === undefined
      ? {}
      : { trajectory_summary: input.trajectory_summary }),
    ...(input.coverage_summary === undefined ? {} : { coverage_summary: input.coverage_summary }),
    approvals: sortedUnique(input.approvals ?? []),
    evidence: sortedUnique((input.evidence ?? []).map((entry) => entry.evidence_id)),
    closed_findings: sortedUnique(
      (input.findings ?? [])
        .filter((finding) => finding.status === "closed")
        .map((finding) => finding.finding_id),
    ),
    unresolved_items: sortedUnique(input.unresolved_items ?? []),
    rejected_hypotheses: sortedUnique(input.rejected_hypotheses ?? []),
    improvement_candidates: [...(input.improvement_candidates ?? [])]
      .map((candidate) => ({ id: candidate.candidate_id, status: candidate.status }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
  };
  if (status === "blocked") {
    content.resume_phase = input.resume_phase;
    content.blockers = snapshotCompletionBlockers(input);
    if (input.checkpoint_id !== undefined) content.checkpoint_id = input.checkpoint_id;
  }
  if (status === "aborted") content.abort_reason = input.abort_reason;
  return { ...content, digest: contentDigest(content) } as unknown as SnapshotRecord;
}

/**
 * Build the Snapshot for an iteration. Classification is deterministic:
 * an abort reason yields `aborted` (and only the allowed reasons), a clean
 * completion check yields `completed`, anything else yields `blocked` -- which
 * requires a typed recoverable reason and a resume phase so the iteration can
 * actually be resumed. Asking for `completed` while blockers exist throws
 * `completion_blocked` with every reason; the state is what evidence says,
 * never what an agent claims.
 */
export function buildSnapshot(input: SnapshotInput): SnapshotRecord {
  assertCommonShape(input);
  if (input.abort_reason !== undefined) {
    if (!(ABORT_REASONS as readonly string[]).includes(input.abort_reason)) {
      throw new SnapshotError(
        "invalid_abort",
        `abort reason ${JSON.stringify(input.abort_reason)} is not an explicit cancellation or a typed unrecoverable reason`,
      );
    }
    return buildRecord(input, "aborted");
  }
  const blockers = snapshotCompletionBlockers(input);
  if (blockers.length === 0) return buildRecord(input, "completed");
  if (input.block_reason === undefined || input.resume_phase === undefined) {
    throw new SnapshotError(
      "completion_blocked",
      `iteration ${input.iteration_id} cannot snapshot as completed: ${blockers.join("; ")}`,
      blockers,
    );
  }
  if (!(RECOVERABLE_BLOCK_REASONS as readonly string[]).includes(input.block_reason)) {
    throw new SnapshotError(
      "invalid_block",
      `block reason ${JSON.stringify(input.block_reason)} is not a typed recoverable reason`,
    );
  }
  if (input.resume_phase.trim().length === 0) {
    throw new SnapshotError("invalid_block", "a blocked Snapshot must record its resume phase");
  }
  return buildRecord(input, "blocked");
}
