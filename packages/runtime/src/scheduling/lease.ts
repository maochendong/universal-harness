import {
  assertSchedulingRecordSemantics,
  buildTaskLeaseRecord,
  contentDigest,
  verifyRecordEnvelope,
  type TaskLeaseRecord,
  type TaskLeaseState,
  type TaskRetryKind,
} from "@universal-harness-internal/core";

import type { PolicyDecision } from "../policy/decision.js";

/**
 * Task Lease fencing state machine (M4 design §8, plan Task 5 step 2). The
 * only legal transition is granted → released/expired/revoked; terminal
 * records never move again. Every transition mints a new
 * task_lease_record_id and links the exact record_digest it replaces, while
 * lease_id stays stable for the whole attempt. fencing_token increases
 * strictly across attempts of one Task and only the latest token is current —
 * output bound to an older token can never pass a verification or
 * integration check again (design §8.2/§16).
 *
 * Everything here is a pure reducer over authoritative Ledger records; the
 * Workflow Engine owns persistence. Both the construction path
 * (grantTaskLease/terminateTaskLease) and the read path (buildTaskLeaseChain)
 * validate every record through assertSchedulingRecordSemantics, so a
 * syntactically valid but semantically impossible chain fails closed in both
 * directions.
 */

export const TASK_LEASE_ERROR_KINDS = [
  "policy_not_allowed",
  "approval_not_satisfied",
  "decision_binding_mismatch",
  "invalid_retry",
  "invalid_transition",
  "consumed_budget_regression",
  "stale_fencing_token",
  "command_conflict",
  "lease_chain_inconsistent",
] as const;

export type TaskLeaseErrorKind = (typeof TASK_LEASE_ERROR_KINDS)[number];

/** Fail-closed rejection raised by the lease reducer and its guards. */
export class TaskLeaseError extends Error {
  readonly kind: TaskLeaseErrorKind;

  constructor(kind: TaskLeaseErrorKind, message: string) {
    super(message);
    this.name = "TaskLeaseError";
    this.kind = kind;
  }
}

export interface TaskLeaseBudgetAmount {
  readonly steps: number;
  readonly tokens: number;
}

/**
 * The authoritative lease history of one operation: every deduplicated record
 * in Ledger order plus the latest record per Task. Rebuilt from the Ledger on
 * every scheduling pass; never mutated in place.
 */
export interface TaskLeaseChain {
  readonly latest_by_task: ReadonlyMap<string, TaskLeaseRecord>;
  readonly records: readonly TaskLeaseRecord[];
}

const TERMINAL_STATES: readonly TaskLeaseState[] = ["released", "expired", "revoked"];

function isTerminal(state: TaskLeaseState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** Fields that must stay identical across every record of one lease_id. */
function assertSameLeaseIdentity(current: TaskLeaseRecord, previous: TaskLeaseRecord): void {
  const stable: ReadonlyArray<keyof TaskLeaseRecord> = [
    "operation_id",
    "iteration_id",
    "plan_digest",
    "task_id",
    "task_digest",
    "run_id",
    "slot_id",
    "baseline_commit",
    "agent_adapter_digest",
    "policy_digest",
    "lease_id",
    "fencing_token",
    "attempt_number",
    "issued_at",
    "expires_at",
  ];
  for (const field of stable) {
    if (current[field] !== previous[field]) {
      throw new TaskLeaseError(
        "lease_chain_inconsistent",
        `lease ${previous.lease_id} record ${current.task_lease_record_id} changes stable field ` +
          `${String(field)} from ${String(previous[field])} to ${String(current[field])}`,
      );
    }
  }
  if (
    current.reserved_budget.steps !== previous.reserved_budget.steps ||
    current.reserved_budget.tokens !== previous.reserved_budget.tokens
  ) {
    throw new TaskLeaseError(
      "lease_chain_inconsistent",
      `lease ${previous.lease_id} must keep its reserved_budget across transitions`,
    );
  }
  if (current.retry_kind !== previous.retry_kind) {
    throw new TaskLeaseError(
      "lease_chain_inconsistent",
      `lease ${previous.lease_id} must keep its retry_kind across transitions`,
    );
  }
  if (
    current.approval_digests.length !== previous.approval_digests.length ||
    current.approval_digests.some(
      (approval, index) => approval !== previous.approval_digests[index],
    )
  ) {
    throw new TaskLeaseError(
      "lease_chain_inconsistent",
      `lease ${previous.lease_id} must keep its approval_digests across transitions`,
    );
  }
}

/**
 * Rebuild the authoritative lease chain from Ledger records. Read-side
 * validation is fail-closed: every record must verify its sealed envelope and
 * pass assertSchedulingRecordSemantics; a command_id replayed byte-identically
 * is dropped as a no-op while the same command_id with different content is a
 * conflict; per lease_id the chain is exactly one granted record plus at most
 * one terminal record linked by digest; per Task the fencing tokens and
 * attempt numbers strictly increase and a new attempt is only valid once the
 * previous lease is terminal.
 */
export function buildTaskLeaseChain(records: readonly TaskLeaseRecord[]): TaskLeaseChain {
  const deduped: TaskLeaseRecord[] = [];
  const byCommandId = new Map<string, TaskLeaseRecord>();
  for (const record of records) {
    if (!verifyRecordEnvelope(record)) {
      throw new TaskLeaseError(
        "lease_chain_inconsistent",
        `record ${record.task_lease_record_id} fails its sealed-envelope check: the ` +
          "record_digest does not cover the record content",
      );
    }
    assertSchedulingRecordSemantics(record);
    const existing = byCommandId.get(record.command_id);
    if (existing !== undefined) {
      if (existing.record_digest !== record.record_digest) {
        throw new TaskLeaseError(
          "command_conflict",
          `command_id ${record.command_id} was committed with two different records ` +
            `(${existing.task_lease_record_id}, ${record.task_lease_record_id})`,
        );
      }
      // Byte-identical command replay: idempotent no-op.
      continue;
    }
    byCommandId.set(record.command_id, record);
    deduped.push(record);
  }

  // Per-lease validation in Ledger encounter order.
  const groups = new Map<string, TaskLeaseRecord[]>();
  for (const record of deduped) {
    const group = groups.get(record.lease_id) ?? [];
    group.push(record);
    groups.set(record.lease_id, group);
  }
  for (const [leaseId, group] of groups) {
    const granted = group[0] as TaskLeaseRecord;
    if (granted.state !== "granted" || granted.previous_lease_record_digest !== undefined) {
      throw new TaskLeaseError(
        "lease_chain_inconsistent",
        `lease ${leaseId} must open with a granted record without a previous link`,
      );
    }
    if (group.length > 2) {
      throw new TaskLeaseError(
        "invalid_transition",
        `lease ${leaseId} has ${group.length} records: a terminal lease record is final ` +
          "and never transitions again",
      );
    }
    const terminal = group[1];
    if (terminal !== undefined) {
      if (!isTerminal(terminal.state)) {
        throw new TaskLeaseError(
          "invalid_transition",
          `lease ${leaseId} may only transition granted → released/expired/revoked`,
        );
      }
      if (terminal.previous_lease_record_digest !== granted.record_digest) {
        throw new TaskLeaseError(
          "lease_chain_inconsistent",
          `lease ${leaseId} record ${terminal.task_lease_record_id} links ` +
            `${String(terminal.previous_lease_record_digest)} but the granted record digests to ` +
            granted.record_digest,
        );
      }
      assertSameLeaseIdentity(terminal, granted);
      if (
        terminal.consumed_budget.steps < granted.consumed_budget.steps ||
        terminal.consumed_budget.tokens < granted.consumed_budget.tokens
      ) {
        throw new TaskLeaseError(
          "consumed_budget_regression",
          `lease ${leaseId} terminal record must not decrease the consumed budget`,
        );
      }
    }
  }

  // Per-Task validation across lease groups in encounter order: strictly
  // increasing fencing tokens and attempts, and no overlapping live leases.
  const latestByTask = new Map<string, TaskLeaseRecord>();
  const lastGroupByTask = new Map<string, TaskLeaseRecord[]>();
  for (const group of groups.values()) {
    const granted = group[0] as TaskLeaseRecord;
    const latest = group[group.length - 1] as TaskLeaseRecord;
    const previousGroup = lastGroupByTask.get(granted.task_id);
    if (previousGroup !== undefined) {
      const previousGranted = previousGroup[0] as TaskLeaseRecord;
      const previousLatest = previousGroup[previousGroup.length - 1] as TaskLeaseRecord;
      if (granted.fencing_token <= previousGranted.fencing_token) {
        throw new TaskLeaseError(
          "lease_chain_inconsistent",
          `task ${granted.task_id} fencing token ${granted.fencing_token} does not strictly ` +
            `increase past ${previousGranted.fencing_token}`,
        );
      }
      if (!isTerminal(previousLatest.state)) {
        throw new TaskLeaseError(
          "invalid_transition",
          `task ${granted.task_id} attempt ${granted.attempt_number} was granted while lease ` +
            `${previousGranted.lease_id} is still ${previousLatest.state}; only a terminal ` +
            "lease allows the next attempt",
        );
      }
      if (granted.attempt_number <= previousGranted.attempt_number) {
        throw new TaskLeaseError(
          "lease_chain_inconsistent",
          `task ${granted.task_id} attempt number ${granted.attempt_number} does not strictly ` +
            `increase past ${previousGranted.attempt_number}`,
        );
      }
      for (const field of ["operation_id", "iteration_id", "plan_digest", "task_digest"] as const) {
        if (granted[field] !== previousGranted[field]) {
          throw new TaskLeaseError(
            "lease_chain_inconsistent",
            `task ${granted.task_id} attempt ${granted.attempt_number} changes ${field} ` +
              "across attempts of the same Task",
          );
        }
      }
    }
    latestByTask.set(granted.task_id, latest);
    lastGroupByTask.set(granted.task_id, group);
  }

  return { latest_by_task: latestByTask, records: deduped };
}

/** The fencing token the next attempt of this Task must carry (1-based). */
export function nextFencingToken(chain: TaskLeaseChain, taskId: string): number {
  const latest = chain.latest_by_task.get(taskId);
  return latest === undefined ? 1 : latest.fencing_token + 1;
}

/**
 * Fail-closed check that a token is the current one for a Task. Output,
 * Evidence and integration requests bound to any older — or unknown — token
 * are rejected here before they reach verification or candidate integration.
 */
export function assertCurrentFencingToken(
  chain: TaskLeaseChain,
  taskId: string,
  token: number,
): void {
  const latest = chain.latest_by_task.get(taskId);
  if (latest === undefined) {
    throw new TaskLeaseError(
      "stale_fencing_token",
      `task ${taskId} has no lease: token ${token} can never be current`,
    );
  }
  if (token !== latest.fencing_token) {
    throw new TaskLeaseError(
      "stale_fencing_token",
      `task ${taskId} fencing token ${token} is not current (current: ${latest.fencing_token}); ` +
        "an old token never becomes current again",
    );
  }
}

/**
 * Deterministic lease identity of one attempt: a pure function of the Task,
 * the attempt number and the granting command, so every attempt mints a fresh
 * lease_id while a command replay derives the identical one. Callers that
 * must bind a budget reservation to the lease before granting derive the id
 * here; grantTaskLease uses the same derivation.
 */
export function deriveTaskLeaseId(
  taskId: string,
  attemptNumber: number,
  commandId: string,
): string {
  return `lease_${contentDigest({
    task_id: taskId,
    attempt_number: attemptNumber,
    command_id: commandId,
  }).slice(0, 32)}`;
}

export interface GrantTaskLeaseInput {
  /** Authoritative chain state this grant builds on. */
  readonly chain: TaskLeaseChain;
  /**
   * The decision authorizing this exact dispatch/retry. Only `allow`, or a
   * `requires_approval` decision carrying the satisfying approval digest, may
   * grant a lease; the decision must bind the normalized action digest of the
   * request being granted.
   */
  readonly decision: PolicyDecision;
  readonly expected_action_digest: string;
  readonly operation_id: string;
  readonly iteration_id: string;
  readonly plan_digest: string;
  readonly task_id: string;
  readonly task_digest: string;
  readonly run_id: string;
  readonly slot_id: string;
  readonly baseline_commit: string;
  readonly agent_adapter_digest: string;
  /** The exact steps/tokens the atomic budget reservation stored. */
  readonly reserved_budget: TaskLeaseBudgetAmount;
  readonly issued_at: string;
  /** min(now + task_remaining_duration, iteration_deadline) — design §8.4. */
  readonly expires_at: string;
  readonly command_id: string;
  readonly retry_kind?: TaskRetryKind;
}

/**
 * Grant a new attempt lease. Every attempt mints a fresh lease_id and the
 * next fencing token; a retry kind is only valid once a previous attempt
 * exists and may be consumed at most once per Task (design §15.1). The pure
 * function is deterministic, so replaying the same command against the same
 * chain state reproduces the identical record.
 */
export function grantTaskLease(input: GrantTaskLeaseInput): TaskLeaseRecord {
  if (input.decision.action_digest !== input.expected_action_digest) {
    throw new TaskLeaseError(
      "decision_binding_mismatch",
      `decision binds action digest ${input.decision.action_digest} but the grant request ` +
        `normalized to ${input.expected_action_digest}`,
    );
  }
  // The TypeBox-static draft types arrays as mutable; the values here are
  // freshly built literals, so the local widening never leaks shared state.
  let approvalDigests: string[];
  if (input.decision.outcome === "allow") {
    approvalDigests = [];
  } else if (input.decision.outcome === "requires_approval") {
    if (input.decision.approval_digest === undefined) {
      throw new TaskLeaseError(
        "approval_not_satisfied",
        "a requires_approval decision only grants a lease when it carries the exact " +
          "approval digest that satisfied the rule",
      );
    }
    approvalDigests = [input.decision.approval_digest];
  } else {
    throw new TaskLeaseError(
      "policy_not_allowed",
      `policy outcome ${input.decision.outcome} never grants a task lease`,
    );
  }

  const latest = input.chain.latest_by_task.get(input.task_id);
  if (latest !== undefined && !isTerminal(latest.state)) {
    throw new TaskLeaseError(
      "invalid_transition",
      `task ${input.task_id} lease ${latest.lease_id} is still ${latest.state}; the previous ` +
        "attempt must reach a terminal state before the next grant",
    );
  }
  const attemptNumber = latest === undefined ? 1 : latest.attempt_number + 1;
  if (input.retry_kind !== undefined) {
    if (attemptNumber === 1) {
      throw new TaskLeaseError(
        "invalid_retry",
        `retry kind ${input.retry_kind} requires a previous attempt of task ${input.task_id}`,
      );
    }
    const alreadyUsed = input.chain.records.some(
      (record) => record.task_id === input.task_id && record.retry_kind === input.retry_kind,
    );
    if (alreadyUsed) {
      throw new TaskLeaseError(
        "invalid_retry",
        `task ${input.task_id} already consumed its ${input.retry_kind}; each scheduling ` +
          "retry kind fires at most once",
      );
    }
  }

  const fencingToken = nextFencingToken(input.chain, input.task_id);
  const leaseId = deriveTaskLeaseId(input.task_id, attemptNumber, input.command_id);
  return buildTaskLeaseRecord({
    operation_id: input.operation_id,
    iteration_id: input.iteration_id,
    plan_digest: input.plan_digest,
    task_id: input.task_id,
    task_digest: input.task_digest,
    run_id: input.run_id,
    slot_id: input.slot_id,
    baseline_commit: input.baseline_commit,
    agent_adapter_digest: input.agent_adapter_digest,
    policy_digest: input.decision.effective_policy_digest,
    approval_digests: approvalDigests,
    task_lease_record_id: `task-lease-record_${contentDigest({
      lease_id: leaseId,
      state: "granted",
      command_id: input.command_id,
    }).slice(0, 32)}`,
    lease_id: leaseId,
    fencing_token: fencingToken,
    state: "granted",
    attempt_number: attemptNumber,
    ...(input.retry_kind === undefined ? {} : { retry_kind: input.retry_kind }),
    reserved_budget: input.reserved_budget,
    consumed_budget: { steps: 0, tokens: 0 },
    issued_at: input.issued_at,
    expires_at: input.expires_at,
    command_id: input.command_id,
  });
}

export type TaskLeaseTerminalState = "released" | "expired" | "revoked";

export interface TerminateTaskLeaseInput {
  readonly state: TaskLeaseTerminalState;
  /** Final consumption of the attempt; never above the granted reservation. */
  readonly consumed_budget: TaskLeaseBudgetAmount;
  readonly command_id: string;
}

/**
 * Close a granted lease. The terminal record preserves lease_id and every
 * identity field, links the granted record by digest, mints a new
 * task_lease_record_id and records the final consumption — which may settle
 * the reservation upward from zero but never regresses and never exceeds the
 * reservation (the sealed-record invariants enforce the ceiling). Deterministic
 * in its inputs, so a command_id replay yields the byte-identical record.
 */
export function terminateTaskLease(
  current: TaskLeaseRecord,
  input: TerminateTaskLeaseInput,
): TaskLeaseRecord {
  if (current.state !== "granted") {
    throw new TaskLeaseError(
      "invalid_transition",
      `lease ${current.lease_id} is already terminal (${current.state}); a terminal lease ` +
        "record never transitions again",
    );
  }
  if (!isTerminal(input.state)) {
    throw new TaskLeaseError(
      "invalid_transition",
      `lease ${current.lease_id} may only transition granted → released/expired/revoked, ` +
        `not ${input.state}`,
    );
  }
  if (
    input.consumed_budget.steps < current.consumed_budget.steps ||
    input.consumed_budget.tokens < current.consumed_budget.tokens
  ) {
    throw new TaskLeaseError(
      "consumed_budget_regression",
      `lease ${current.lease_id} termination must not decrease the consumed budget below ` +
        `${current.consumed_budget.steps} steps/${current.consumed_budget.tokens} tokens`,
    );
  }
  return buildTaskLeaseRecord({
    ...current,
    task_lease_record_id: `task-lease-record_${contentDigest({
      lease_id: current.lease_id,
      state: input.state,
      command_id: input.command_id,
    }).slice(0, 32)}`,
    previous_lease_record_digest: current.record_digest,
    state: input.state,
    consumed_budget: input.consumed_budget,
    command_id: input.command_id,
  });
}
