import type { TaskLeaseRecord } from "@universal-harness-internal/core";

import type { IterationBudget, Protocol13TaskBudget } from "../planning/task.js";
import { buildTaskLeaseChain } from "./lease.js";

/**
 * Atomic iteration budget accounting (M4 design §8.4/§15.1, plan Task 5 step
 * 4). The account is immutable accounting state: every operation returns a
 * new account and never mutates its input. Only steps and tokens are reserved
 * — duration is enforced by deadline
 * (`lease.expires_at = min(now + task_remaining_duration, iteration_deadline)`),
 * never by additive reservation, so parallel Tasks cannot multiply the time
 * axis.
 *
 *   available = iteration_limit − accumulated_consumption − active_reservations
 *
 * A reservation is created in the same Ledger transaction as the granted
 * Lease that carries its exact steps/tokens, and settlement only accepts the
 * current Lease token (lease_id + fencing_token). restoreBudgetAccount
 * replays the authoritative Lease records through buildTaskLeaseChain — full
 * envelope, schema and state-machine validation on the read path — and fails
 * closed on duplicate settlement, settlement without a granted Lease, or an
 * accumulated overrun of the approved limit.
 */

export const BUDGET_ACCOUNTING_ERROR_KINDS = [
  "invalid_amount",
  "budget_exhausted",
  "task_budget_exceeded",
  "reservation_conflict",
  "unknown_reservation",
  "stale_fencing_token",
  "consumed_exceeds_reserved",
  "deadline_exceeded",
  "account_inconsistent",
] as const;

export type BudgetAccountingErrorKind = (typeof BUDGET_ACCOUNTING_ERROR_KINDS)[number];

/** Fail-closed rejection raised by the budget accounting functions. */
export class BudgetAccountingError extends Error {
  readonly kind: BudgetAccountingErrorKind;

  constructor(kind: BudgetAccountingErrorKind, message: string) {
    super(message);
    this.name = "BudgetAccountingError";
    this.kind = kind;
  }
}

export interface BudgetAmount {
  readonly steps: number;
  readonly tokens: number;
}

/** One active reservation, bound to the exact granted Lease it funds. */
export interface BudgetReservation extends BudgetAmount {
  readonly lease_id: string;
  readonly fencing_token: number;
}

/**
 * Immutable accounting state of one iteration. `consumed` is the accumulated
 * per-Task settled consumption; `reservations` holds at most one active
 * reservation per Task, keyed by task_id.
 */
export interface IterationBudgetAccount {
  readonly limit: IterationBudget;
  readonly consumed: Readonly<Record<string, BudgetAmount>>;
  readonly reservations: Readonly<Record<string, BudgetReservation>>;
  readonly iteration_deadline: string;
}

export function createIterationBudgetAccount(input: {
  readonly limit: IterationBudget;
  readonly iteration_deadline: string;
}): IterationBudgetAccount {
  return {
    limit: input.limit,
    consumed: {},
    reservations: {},
    iteration_deadline: input.iteration_deadline,
  };
}

function assertAmount(amount: BudgetAmount, what: string): void {
  for (const axis of ["steps", "tokens"] as const) {
    if (!Number.isInteger(amount[axis]) || amount[axis] < 0) {
      throw new BudgetAccountingError(
        "invalid_amount",
        `${what} must be a non-negative integer ${axis} amount: ${String(amount[axis])}`,
      );
    }
  }
}

function sumAmounts(amounts: readonly BudgetAmount[]): BudgetAmount {
  return amounts.reduce<BudgetAmount>(
    (sum, amount) => ({ steps: sum.steps + amount.steps, tokens: sum.tokens + amount.tokens }),
    { steps: 0, tokens: 0 },
  );
}

/**
 * Iteration availability: limit − accumulated_consumption −
 * active_reservations (design §8.4). Duration is deliberately absent — it is
 * enforced by `iteration_deadline`, not by reservation arithmetic.
 */
export function remainingBudget(account: IterationBudgetAccount): BudgetAmount {
  const consumed = sumAmounts(Object.values(account.consumed));
  const reserved = sumAmounts(Object.values(account.reservations));
  return {
    steps: account.limit.steps - consumed.steps - reserved.steps,
    tokens: account.limit.tokens - consumed.tokens - reserved.tokens,
  };
}

export interface ReserveTaskBudgetInput {
  readonly task_id: string;
  /** Identity of the granted Lease this reservation funds. */
  readonly lease_id: string;
  readonly fencing_token: number;
  /** The Task's approved budget ceiling (Plan Task after ceiling reduction). */
  readonly task_budget: Protocol13TaskBudget;
  /** Remaining duration allowance of the Task; never added to other Tasks. */
  readonly task_remaining_duration_ms: number;
  readonly steps: number;
  readonly tokens: number;
  readonly now: string;
}

export interface ReserveTaskBudgetResult {
  readonly account: IterationBudgetAccount;
  /** The exact steps/tokens the granted Lease record must carry. */
  readonly reserved_budget: BudgetAmount;
  /** min(now + task_remaining_duration_ms, iteration_deadline). */
  readonly expires_at: string;
}

/**
 * Reserve steps/tokens for one Task attempt. The reservation must fit both
 * the iteration availability and the Task's remaining budget — a retry never
 * earns a fresh budget, only the original Task remainder (design §15.1). A
 * Task holds at most one active reservation at a time.
 */
export function reserveTaskBudget(
  account: IterationBudgetAccount,
  input: ReserveTaskBudgetInput,
): ReserveTaskBudgetResult {
  assertAmount({ steps: input.steps, tokens: input.tokens }, "reservation");
  if (!Number.isInteger(input.task_remaining_duration_ms) || input.task_remaining_duration_ms < 0) {
    throw new BudgetAccountingError(
      "invalid_amount",
      `task_remaining_duration_ms must be a non-negative integer: ${String(input.task_remaining_duration_ms)}`,
    );
  }
  const nowMs = Date.parse(input.now);
  const deadlineMs = Date.parse(account.iteration_deadline);
  if (Number.isNaN(nowMs) || Number.isNaN(deadlineMs)) {
    throw new BudgetAccountingError(
      "invalid_amount",
      `now and iteration_deadline must be ISO timestamps: ${input.now}, ${account.iteration_deadline}`,
    );
  }
  if (nowMs >= deadlineMs) {
    throw new BudgetAccountingError(
      "deadline_exceeded",
      `iteration deadline ${account.iteration_deadline} has passed at ${input.now}; no new ` +
        "reservation may be created",
    );
  }
  if (account.reservations[input.task_id] !== undefined) {
    throw new BudgetAccountingError(
      "reservation_conflict",
      `task ${input.task_id} already holds an active reservation for lease ` +
        `${account.reservations[input.task_id]?.lease_id ?? "unknown"}; settle it first`,
    );
  }
  const consumed = account.consumed[input.task_id] ?? { steps: 0, tokens: 0 };
  const taskRemainder: BudgetAmount = {
    steps: input.task_budget.steps - consumed.steps,
    tokens: input.task_budget.tokens - consumed.tokens,
  };
  if (input.steps > taskRemainder.steps || input.tokens > taskRemainder.tokens) {
    throw new BudgetAccountingError(
      "task_budget_exceeded",
      `task ${input.task_id} remainder is ${taskRemainder.steps} steps/${taskRemainder.tokens} ` +
        `tokens; a reservation of ${input.steps}/${input.tokens} would exceed the original ` +
        "Task budget (a retry never earns a new one)",
    );
  }
  const available = remainingBudget(account);
  if (input.steps > available.steps || input.tokens > available.tokens) {
    throw new BudgetAccountingError(
      "budget_exhausted",
      `iteration availability is ${available.steps} steps/${available.tokens} tokens; ` +
        `reserving ${input.steps}/${input.tokens} for task ${input.task_id} would exceed the ` +
        "approved iteration limit",
    );
  }
  const reservation: BudgetReservation = {
    lease_id: input.lease_id,
    fencing_token: input.fencing_token,
    steps: input.steps,
    tokens: input.tokens,
  };
  return {
    account: {
      ...account,
      reservations: { ...account.reservations, [input.task_id]: reservation },
    },
    reserved_budget: { steps: input.steps, tokens: input.tokens },
    expires_at: new Date(
      Math.min(nowMs + input.task_remaining_duration_ms, deadlineMs),
    ).toISOString(),
  };
}

export interface SettleTaskBudgetInput {
  readonly task_id: string;
  /** Settlement only accepts the current Lease token. */
  readonly lease_id: string;
  readonly fencing_token: number;
  readonly consumed: BudgetAmount;
}

export interface SettleTaskBudgetResult {
  readonly account: IterationBudgetAccount;
  /** Iteration availability after the settlement. */
  readonly remaining: BudgetAmount;
  /** The unused part of the reservation, returned exactly once. */
  readonly returned: BudgetAmount;
}

/**
 * Settle an active reservation: actual consumption enters the accumulated
 * per-Task use and the unused remainder returns to the iteration pool exactly
 * once — the reservation is gone from the new account, so a replayed settle
 * finds nothing to return.
 */
export function settleTaskBudget(
  account: IterationBudgetAccount,
  input: SettleTaskBudgetInput,
): SettleTaskBudgetResult {
  assertAmount(input.consumed, "consumed");
  const reservation = account.reservations[input.task_id];
  if (reservation === undefined) {
    throw new BudgetAccountingError(
      "unknown_reservation",
      `task ${input.task_id} holds no active reservation; the reservation was already ` +
        "settled or never existed",
    );
  }
  if (
    reservation.lease_id !== input.lease_id ||
    reservation.fencing_token !== input.fencing_token
  ) {
    throw new BudgetAccountingError(
      "stale_fencing_token",
      `settlement for task ${input.task_id} must present the current lease token ` +
        `${reservation.lease_id}#${reservation.fencing_token}, not ${input.lease_id}#` +
        `${input.fencing_token}`,
    );
  }
  if (input.consumed.steps > reservation.steps || input.consumed.tokens > reservation.tokens) {
    throw new BudgetAccountingError(
      "consumed_exceeds_reserved",
      `task ${input.task_id} consumed ${input.consumed.steps} steps/${input.consumed.tokens} ` +
        `tokens but the reservation only covers ${reservation.steps}/${reservation.tokens}`,
    );
  }
  const previous = account.consumed[input.task_id] ?? { steps: 0, tokens: 0 };
  const reservations = { ...account.reservations };
  delete reservations[input.task_id];
  const next: IterationBudgetAccount = {
    ...account,
    consumed: {
      ...account.consumed,
      [input.task_id]: {
        steps: previous.steps + input.consumed.steps,
        tokens: previous.tokens + input.consumed.tokens,
      },
    },
    reservations,
  };
  return {
    account: next,
    remaining: remainingBudget(next),
    returned: {
      steps: reservation.steps - input.consumed.steps,
      tokens: reservation.tokens - input.consumed.tokens,
    },
  };
}

export interface RestoreBudgetAccountInput {
  readonly limit: IterationBudget;
  readonly iteration_deadline: string;
  /** Authoritative TaskLeaseRecord history, in Ledger order. */
  readonly records: readonly TaskLeaseRecord[];
}

/**
 * Rebuild the account from the authoritative Lease records. The records first
 * pass buildTaskLeaseChain — sealed-envelope verification,
 * assertSchedulingRecordSemantics and the fencing state machine — then replay
 * per Task in fencing order. A granted record opens a reservation bound to
 * its lease_id/token; a terminal record settles it with the recorded
 * consumption. Duplicate command_id replays collapse to one effect; a
 * settlement without a granted Lease, consumption above the reservation, or
 * an accumulated overrun of the (possibly tightened) limit all fail closed.
 */
export function restoreBudgetAccount(input: RestoreBudgetAccountInput): IterationBudgetAccount {
  const chain = buildTaskLeaseChain(input.records);
  let account = createIterationBudgetAccount({
    limit: input.limit,
    iteration_deadline: input.iteration_deadline,
  });

  // Replay per Task in fencing order so a later Ledger interleaving cannot
  // change the accounting result.
  const byTask = new Map<string, TaskLeaseRecord[]>();
  for (const record of chain.records) {
    const list = byTask.get(record.task_id) ?? [];
    list.push(record);
    byTask.set(record.task_id, list);
  }
  for (const [taskId, taskRecords] of byTask) {
    const ordered = [...taskRecords].sort(
      (a, b) => a.fencing_token - b.fencing_token || (a.state === "granted" ? -1 : 1),
    );
    for (const record of ordered) {
      if (record.state === "granted") {
        if (account.reservations[taskId] !== undefined) {
          throw new BudgetAccountingError(
            "account_inconsistent",
            `task ${taskId} lease ${record.lease_id} granted while reservation for lease ` +
              `${account.reservations[taskId]?.lease_id ?? "unknown"} is still active`,
          );
        }
        account = {
          ...account,
          reservations: {
            ...account.reservations,
            [taskId]: {
              lease_id: record.lease_id,
              fencing_token: record.fencing_token,
              steps: record.reserved_budget.steps,
              tokens: record.reserved_budget.tokens,
            },
          },
        };
      } else {
        const reservation = account.reservations[taskId];
        if (
          reservation === undefined ||
          reservation.lease_id !== record.lease_id ||
          reservation.fencing_token !== record.fencing_token
        ) {
          throw new BudgetAccountingError(
            "account_inconsistent",
            `task ${taskId} record ${record.task_lease_record_id} settles lease ` +
              `${record.lease_id}#${record.fencing_token} but no current granted lease ` +
              "reservation matches it",
          );
        }
        if (
          record.consumed_budget.steps > reservation.steps ||
          record.consumed_budget.tokens > reservation.tokens
        ) {
          throw new BudgetAccountingError(
            "consumed_exceeds_reserved",
            `task ${taskId} lease ${record.lease_id} consumed more than its reservation`,
          );
        }
        const reservations = { ...account.reservations };
        delete reservations[taskId];
        const previous = account.consumed[taskId] ?? { steps: 0, tokens: 0 };
        account = {
          ...account,
          consumed: {
            ...account.consumed,
            [taskId]: {
              steps: previous.steps + record.consumed_budget.steps,
              tokens: previous.tokens + record.consumed_budget.tokens,
            },
          },
          reservations,
        };
      }
    }
  }

  const remaining = remainingBudget(account);
  if (remaining.steps < 0 || remaining.tokens < 0) {
    throw new BudgetAccountingError(
      "account_inconsistent",
      `accumulated consumption plus active reservations exceeds the approved iteration ` +
        `limit ${input.limit.steps} steps/${input.limit.tokens} tokens; the ceiling may ` +
        "have tightened after leases were granted, which must fail closed",
    );
  }
  return account;
}
