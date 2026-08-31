import { describe, expect, it } from "vitest";

import type { TaskLeaseRecord } from "@universal-harness-internal/core";

import type { IterationBudget, Protocol13TaskBudget } from "../../src/planning/task.js";
import type { PolicyDecision } from "../../src/policy/decision.js";
import {
  remainingBudget,
  reserveTaskBudget,
  restoreBudgetAccount,
  settleTaskBudget,
  createIterationBudgetAccount,
  type IterationBudgetAccount,
} from "../../src/scheduling/budget.js";
import {
  buildTaskLeaseChain,
  grantTaskLease,
  nextFencingToken,
  terminateTaskLease,
  type TaskLeaseChain,
} from "../../src/scheduling/lease.js";
import { mulberry32, pick, randomInt } from "../context/seeds.js";

/**
 * Plan Task 5 step 3: seeded budget-accounting properties (design §8.4/§15.1).
 * Invariants under test:
 *  - accumulated_consumption + active_reservations never exceeds the approved
 *    iteration limit, after every single operation;
 *  - an unused reservation returns exactly once (remaining grows by exactly
 *    the returned amount, and a second settle has nothing to return);
 *  - a retry may reserve at most the Task original remainder — never a fresh
 *    budget;
 *  - duration is enforced by deadline: lease expiry is
 *    min(now + task_remaining_duration, iteration_deadline) and no duration
 *    is ever reserved additively;
 *  - incremental accounting and restore-from-Ledger replay agree exactly.
 */

const digest = (char: string): string => char.repeat(64);
const BASELINE = "0123456789abcdef0123456789abcdef01234567";
const NOW = "2026-08-31T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const DEADLINE_MS = NOW_MS + 7_200_000;
const DEADLINE = new Date(DEADLINE_MS).toISOString();
const LIMIT: IterationBudget = { steps: 120, tokens: 240_000, duration_ms: 7_200_000 };
const TASK_BUDGET: Protocol13TaskBudget = { steps: 60, tokens: 120_000, duration_ms: 3_600_000 };
const TASK_IDS = ["task_alpha", "task_beta", "task_gamma"] as const;

interface TaskShadow {
  consumedSteps: number;
  consumedTokens: number;
  attempts: number;
  executorRetryUsed: boolean;
  open: TaskLeaseRecord | null;
}

function allowDecision(): PolicyDecision {
  return {
    outcome: "allow",
    reasons: [],
    action_digest: digest("0"),
    effective_policy_digest: digest("d"),
    layers: [],
    field_traces: [],
    digest: digest("9"),
  };
}

function totalConsumed(account: IterationBudgetAccount): { steps: number; tokens: number } {
  return Object.values(account.consumed).reduce(
    (sum, entry) => ({ steps: sum.steps + entry.steps, tokens: sum.tokens + entry.tokens }),
    { steps: 0, tokens: 0 },
  );
}

function totalReserved(account: IterationBudgetAccount): { steps: number; tokens: number } {
  return Object.values(account.reservations).reduce(
    (sum, entry) => ({ steps: sum.steps + entry.steps, tokens: sum.tokens + entry.tokens }),
    { steps: 0, tokens: 0 },
  );
}

function assertAccountInvariant(account: IterationBudgetAccount): void {
  const consumed = totalConsumed(account);
  const reserved = totalReserved(account);
  // accumulated_consumption + active_reservations ≤ approved iteration limit.
  expect(consumed.steps + reserved.steps).toBeLessThanOrEqual(LIMIT.steps);
  expect(consumed.tokens + reserved.tokens).toBeLessThanOrEqual(LIMIT.tokens);
  // Duration is never reserved additively: the deadline is fixed and no
  // reservation carries a duration field.
  expect(account.iteration_deadline).toBe(DEADLINE);
  for (const reservation of Object.values(account.reservations)) {
    expect(Object.keys(reservation).sort()).toEqual([
      "fencing_token",
      "lease_id",
      "steps",
      "tokens",
    ]);
  }
}

describe("iteration budget accounting properties", () => {
  it("never over-commits, returns reservations exactly once, and replays identically", () => {
    const random = mulberry32(40_0831);
    let account = createIterationBudgetAccount({ limit: LIMIT, iteration_deadline: DEADLINE });
    const records: TaskLeaseRecord[] = [];
    const shadows = new Map<string, TaskShadow>(
      TASK_IDS.map((taskId) => [
        taskId,
        { consumedSteps: 0, consumedTokens: 0, attempts: 0, executorRetryUsed: false, open: null },
      ]),
    );
    let commandSequence = 0;
    let reserveAttempts = 0;
    let settleCount = 0;
    let taskBudgetRejections = 0;
    let exhaustedRejections = 0;

    for (let step = 0; step < 400; step += 1) {
      const taskId = pick(random, TASK_IDS);
      const shadow = shadows.get(taskId) as TaskShadow;
      const chain: TaskLeaseChain = buildTaskLeaseChain(records);

      if (shadow.open === null) {
        // Reserve: grant the (pure) lease first, then atomically account the
        // reservation; a failed reservation never commits the lease.
        reserveAttempts += 1;
        const taskRemainderSteps = TASK_BUDGET.steps - shadow.consumedSteps;
        const taskRemainderTokens = TASK_BUDGET.tokens - shadow.consumedTokens;
        const available = remainingBudget(account);
        const retry = shadow.attempts > 0 && !shadow.executorRetryUsed;
        // Sometimes deliberately overshoot the Task remainder or the
        // iteration availability to exercise both rejection kinds.
        const overshootTask = shadow.attempts > 0 && random() < 0.2;
        const overshootIteration = !overshootTask && random() < 0.15;
        const steps = overshootTask
          ? taskRemainderSteps + 1 + randomInt(random, 3)
          : overshootIteration
            ? available.steps + 1 + randomInt(random, 5)
            : randomInt(random, Math.max(taskRemainderSteps, 1));
        const tokens = overshootTask
          ? taskRemainderTokens + 1 + randomInt(random, 300)
          : overshootIteration
            ? available.tokens + 1 + randomInt(random, 500)
            : randomInt(random, Math.max(taskRemainderTokens, 1));

        const granted = grantTaskLease({
          chain,
          decision: allowDecision(),
          expected_action_digest: digest("0"),
          operation_id: "operation_m4_prop",
          iteration_id: "iteration_m4_prop",
          plan_digest: digest("a"),
          task_id: taskId,
          task_digest: digest("b"),
          run_id: `run_${taskId}_${shadow.consumedSteps}_${step}`,
          slot_id: "slot_01",
          baseline_commit: BASELINE,
          agent_adapter_digest: digest("c"),
          reserved_budget: { steps, tokens },
          issued_at: NOW,
          expires_at: DEADLINE,
          command_id: `command_prop_grant_${commandSequence}`,
          ...(retry ? { retry_kind: "executor_retry" as const } : {}),
        });
        commandSequence += 1;
        const fitsTask = steps <= taskRemainderSteps && tokens <= taskRemainderTokens;
        const fitsIteration = steps <= available.steps && tokens <= available.tokens;
        if (!fitsTask) {
          // Retry never exceeds the original Task remainder.
          expect(() =>
            reserveTaskBudget(account, {
              task_id: taskId,
              lease_id: granted.lease_id,
              fencing_token: granted.fencing_token,
              task_budget: TASK_BUDGET,
              task_remaining_duration_ms: TASK_BUDGET.duration_ms,
              steps,
              tokens,
              now: NOW,
            }),
          ).toThrowError(expect.objectContaining({ kind: "task_budget_exceeded" }) as Error);
          taskBudgetRejections += 1;
          continue;
        }
        if (!fitsIteration) {
          expect(() =>
            reserveTaskBudget(account, {
              task_id: taskId,
              lease_id: granted.lease_id,
              fencing_token: granted.fencing_token,
              task_budget: TASK_BUDGET,
              task_remaining_duration_ms: TASK_BUDGET.duration_ms,
              steps,
              tokens,
              now: NOW,
            }),
          ).toThrowError(expect.objectContaining({ kind: "budget_exhausted" }) as Error);
          exhaustedRejections += 1;
          continue;
        }
        const durationMs = randomInt(random, TASK_BUDGET.duration_ms) + 1;
        const reserved = reserveTaskBudget(account, {
          task_id: taskId,
          lease_id: granted.lease_id,
          fencing_token: granted.fencing_token,
          task_budget: TASK_BUDGET,
          task_remaining_duration_ms: durationMs,
          steps,
          tokens,
          now: NOW,
        });
        // Duration deadline: min(now + remaining duration, iteration deadline).
        const expectedExpiry = Math.min(NOW_MS + durationMs, DEADLINE_MS);
        expect(Date.parse(reserved.expires_at)).toBe(expectedExpiry);
        // The reservation written into the account is exactly what the
        // granted Lease carries.
        expect(reserved.reserved_budget).toEqual(granted.reserved_budget);
        expect(reserved.account.reservations[taskId]).toEqual({
          lease_id: granted.lease_id,
          fencing_token: granted.fencing_token,
          steps,
          tokens,
        });
        expect(granted.fencing_token).toBe(nextFencingToken(chain, taskId));
        account = reserved.account;
        records.push(granted);
        shadow.attempts += 1;
        if (retry) shadow.executorRetryUsed = true;
        shadow.open = granted;
      } else {
        // Settle the open attempt with a random in-reservation consumption.
        const open = shadow.open;
        const consumed = {
          steps: randomInt(random, open.reserved_budget.steps + 1),
          tokens: randomInt(random, open.reserved_budget.tokens + 1),
        };
        const before = remainingBudget(account);
        const settled = settleTaskBudget(account, {
          task_id: taskId,
          lease_id: open.lease_id,
          fencing_token: open.fencing_token,
          consumed,
        });
        settleCount += 1;
        // Unused reservation returns exactly once: remaining grows by exactly
        // the returned amount.
        expect(settled.returned).toEqual({
          steps: open.reserved_budget.steps - consumed.steps,
          tokens: open.reserved_budget.tokens - consumed.tokens,
        });
        expect(settled.remaining).toEqual({
          steps: before.steps + settled.returned.steps,
          tokens: before.tokens + settled.returned.tokens,
        });
        expect(settled.account.reservations[taskId]).toBeUndefined();
        // A second settle of the same reservation has nothing to return.
        expect(() =>
          settleTaskBudget(settled.account, {
            task_id: taskId,
            lease_id: open.lease_id,
            fencing_token: open.fencing_token,
            consumed,
          }),
        ).toThrowError(expect.objectContaining({ kind: "unknown_reservation" }) as Error);
        // A stale token against a live account never settles.
        if (random() < 0.3) {
          expect(() =>
            settleTaskBudget(account, {
              task_id: taskId,
              lease_id: open.lease_id,
              fencing_token: open.fencing_token + 1,
              consumed,
            }),
          ).toThrowError(expect.objectContaining({ kind: "stale_fencing_token" }) as Error);
        }
        const terminal = terminateTaskLease(open, {
          state: pick(random, ["released", "expired", "revoked"] as const),
          consumed_budget: consumed,
          command_id: `command_prop_settle_${commandSequence}`,
        });
        commandSequence += 1;
        account = settled.account;
        records.push(terminal);
        shadow.consumedSteps += consumed.steps;
        shadow.consumedTokens += consumed.tokens;
        shadow.open = null;
        // Per-Task invariant: consumption never exceeds the Task budget.
        expect(shadow.consumedSteps).toBeLessThanOrEqual(TASK_BUDGET.steps);
        expect(shadow.consumedTokens).toBeLessThanOrEqual(TASK_BUDGET.tokens);
      }

      assertAccountInvariant(account);

      // Incremental accounting and authoritative replay agree exactly.
      if (step % 10 === 0) {
        const restored = restoreBudgetAccount({
          limit: LIMIT,
          iteration_deadline: DEADLINE,
          records,
        });
        expect(restored).toEqual(account);
      }
    }

    // The simulation must have exercised every shape it claims to cover.
    expect(reserveAttempts).toBeGreaterThan(60);
    expect(settleCount).toBeGreaterThan(40);
    expect(taskBudgetRejections).toBeGreaterThan(0);
    expect(exhaustedRejections).toBeGreaterThan(0);
  });
});
