import { describe, expect, it } from "vitest";

import { SchedulingRecordError, sealRecordEnvelope } from "@universal-harness-internal/core";

import type { IterationBudget, Protocol13TaskBudget } from "../../src/planning/task.js";
import type { PolicyDecision } from "../../src/policy/decision.js";
import {
  createIterationBudgetAccount,
  remainingBudget,
  reserveTaskBudget,
  restoreBudgetAccount,
  settleTaskBudget,
  type IterationBudgetAccount,
  type ReserveTaskBudgetInput,
} from "../../src/scheduling/budget.js";
import {
  buildTaskLeaseChain,
  grantTaskLease,
  terminateTaskLease,
  type GrantTaskLeaseInput,
  type TaskLeaseChain,
} from "../../src/scheduling/lease.js";

/**
 * Plan Task 5 step 3/4: atomic iteration budget accounting (design §8.4). The
 * account is immutable accounting state: every reserve/settle returns a new
 * account; available = limit − accumulated_consumption − active_reservations;
 * duration is enforced by deadline, never by additive reservation; restore
 * replays authoritative Lease records and fails closed on any inconsistency.
 */

const digest = (char: string): string => char.repeat(64);
const BASELINE = "0123456789abcdef0123456789abcdef01234567";
const NOW = "2026-08-31T00:00:00.000Z";
const DEADLINE = "2026-08-31T01:00:00.000Z";
const LIMIT: IterationBudget = { steps: 10, tokens: 8_000, duration_ms: 3_600_000 };
const TASK_BUDGET: Protocol13TaskBudget = { steps: 8, tokens: 6_000, duration_ms: 1_800_000 };

function emptyAccount(): IterationBudgetAccount {
  return createIterationBudgetAccount({ limit: LIMIT, iteration_deadline: DEADLINE });
}

function reserveInput(overrides?: Partial<ReserveTaskBudgetInput>): ReserveTaskBudgetInput {
  return {
    task_id: "task_a",
    lease_id: "lease_a_01",
    fencing_token: 1,
    task_budget: TASK_BUDGET,
    task_remaining_duration_ms: 1_800_000,
    steps: 6,
    tokens: 4_000,
    now: NOW,
    ...overrides,
  };
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

const EMPTY_CHAIN: TaskLeaseChain = buildTaskLeaseChain([]);

function leaseGrantInput(
  chain: TaskLeaseChain,
  overrides?: Partial<GrantTaskLeaseInput>,
): GrantTaskLeaseInput {
  return {
    chain,
    decision: allowDecision(),
    expected_action_digest: digest("0"),
    operation_id: "operation_m4_budget",
    iteration_id: "iteration_m4_budget",
    plan_digest: digest("a"),
    task_id: "task_a",
    task_digest: digest("b"),
    run_id: "run_01",
    slot_id: "slot_01",
    baseline_commit: BASELINE,
    agent_adapter_digest: digest("c"),
    reserved_budget: { steps: 6, tokens: 4_000 },
    issued_at: NOW,
    expires_at: DEADLINE,
    command_id: "command_grant_01",
    ...overrides,
  };
}

describe("createIterationBudgetAccount / remainingBudget", () => {
  it("starts empty with the full approved limit available", () => {
    const account = emptyAccount();
    expect(account.limit).toEqual(LIMIT);
    expect(account.consumed).toEqual({});
    expect(account.reservations).toEqual({});
    expect(account.iteration_deadline).toBe(DEADLINE);
    expect(remainingBudget(account)).toEqual({ steps: 10, tokens: 8_000 });
  });
});

describe("reserveTaskBudget", () => {
  it("returns a new account holding the exact reservation the Lease carries", () => {
    const account = emptyAccount();
    const reserved = reserveTaskBudget(account, reserveInput());
    expect(reserved.account).not.toBe(account);
    expect(account.reservations).toEqual({});
    expect(reserved.reserved_budget).toEqual({ steps: 6, tokens: 4_000 });
    expect(reserved.account.reservations["task_a"]).toEqual({
      lease_id: "lease_a_01",
      fencing_token: 1,
      steps: 6,
      tokens: 4_000,
    });
    expect(remainingBudget(reserved.account)).toEqual({ steps: 4, tokens: 4_000 });
  });

  it("rejects a reservation that exceeds the remaining iteration budget", () => {
    const first = reserveTaskBudget(emptyAccount(), reserveInput());
    expect(() =>
      reserveTaskBudget(first.account, reserveInput({ task_id: "task_b", lease_id: "lease_b_01" })),
    ).toThrowError(expect.objectContaining({ kind: "budget_exhausted" }) as Error);
  });

  it("rejects a reservation above the Task remaining budget, including retries", () => {
    // First attempt consumes 3 steps / 2_000 tokens of the Task budget.
    const account = emptyAccount();
    const reserved = reserveTaskBudget(account, reserveInput({ steps: 3, tokens: 2_000 }));
    const settled = settleTaskBudget(reserved.account, {
      task_id: "task_a",
      lease_id: "lease_a_01",
      fencing_token: 1,
      consumed: { steps: 3, tokens: 2_000 },
    });
    // Retry may reserve at most the Task remainder: 8−3 steps, 6_000−2_000 tokens.
    expect(() =>
      reserveTaskBudget(
        settled.account,
        reserveInput({ lease_id: "lease_a_02", fencing_token: 2, steps: 6, tokens: 4_000 }),
      ),
    ).toThrowError(expect.objectContaining({ kind: "task_budget_exceeded" }) as Error);
    const retry = reserveTaskBudget(
      settled.account,
      reserveInput({ lease_id: "lease_a_02", fencing_token: 2, steps: 5, tokens: 4_000 }),
    );
    expect(retry.reserved_budget).toEqual({ steps: 5, tokens: 4_000 });
  });

  it("rejects a second active reservation for the same Task", () => {
    const first = reserveTaskBudget(emptyAccount(), reserveInput());
    expect(() =>
      reserveTaskBudget(
        first.account,
        reserveInput({ lease_id: "lease_a_02", fencing_token: 2, steps: 1, tokens: 1 }),
      ),
    ).toThrowError(expect.objectContaining({ kind: "reservation_conflict" }) as Error);
  });

  it("computes the lease deadline as min(now + remaining duration, iteration deadline)", () => {
    const clamped = reserveTaskBudget(
      emptyAccount(),
      reserveInput({ task_remaining_duration_ms: 7_200_000 }),
    );
    expect(clamped.expires_at).toBe(DEADLINE);
    const unclamped = reserveTaskBudget(
      emptyAccount(),
      reserveInput({ task_remaining_duration_ms: 600_000 }),
    );
    expect(unclamped.expires_at).toBe("2026-08-31T00:10:00.000Z");
  });

  it("never reserves duration additively: the deadline does not move per Task", () => {
    let account = emptyAccount();
    account = reserveTaskBudget(account, reserveInput()).account;
    account = reserveTaskBudget(
      account,
      reserveInput({ task_id: "task_b", lease_id: "lease_b_01", steps: 1, tokens: 1 }),
    ).account;
    expect(account.iteration_deadline).toBe(DEADLINE);
    expect(remainingBudget(account)).toEqual({ steps: 3, tokens: 3_999 });
  });

  it("refuses a reservation once the iteration deadline has passed", () => {
    expect(() =>
      reserveTaskBudget(emptyAccount(), reserveInput({ now: "2026-08-31T01:00:00.000Z" })),
    ).toThrowError(expect.objectContaining({ kind: "deadline_exceeded" }) as Error);
  });

  it("rejects non-integer or negative reservation amounts", () => {
    expect(() => reserveTaskBudget(emptyAccount(), reserveInput({ steps: 1.5 }))).toThrowError(
      expect.objectContaining({ kind: "invalid_amount" }) as Error,
    );
    expect(() => reserveTaskBudget(emptyAccount(), reserveInput({ tokens: -1 }))).toThrowError(
      expect.objectContaining({ kind: "invalid_amount" }) as Error,
    );
  });
});

describe("settleTaskBudget", () => {
  it("settles consumption, returns the unused reservation exactly once", () => {
    const first = reserveTaskBudget(emptyAccount(), reserveInput());
    const settled = settleTaskBudget(first.account, {
      task_id: "task_a",
      lease_id: "lease_a_01",
      fencing_token: 1,
      consumed: { steps: 4, tokens: 2_500 },
    });
    expect(settled.remaining).toEqual({ steps: 6, tokens: 5_500 });
    expect(settled.returned).toEqual({ steps: 2, tokens: 1_500 });
    expect(settled.account.reservations).toEqual({});
    expect(settled.account.consumed["task_a"]).toEqual({ steps: 4, tokens: 2_500 });
    // The pre-settle account is untouched.
    expect(first.account.reservations["task_a"]).toBeDefined();
    expect(first.account.consumed).toEqual({});
    // The reservation was returned exactly once: a second settle has nothing.
    expect(() =>
      settleTaskBudget(settled.account, {
        task_id: "task_a",
        lease_id: "lease_a_01",
        fencing_token: 1,
        consumed: { steps: 4, tokens: 2_500 },
      }),
    ).toThrowError(expect.objectContaining({ kind: "unknown_reservation" }) as Error);
  });

  it("accepts only the current Lease token", () => {
    const first = reserveTaskBudget(emptyAccount(), reserveInput());
    const attempt =
      (leaseId: string, token: number): (() => void) =>
      () =>
        settleTaskBudget(first.account, {
          task_id: "task_a",
          lease_id: leaseId,
          fencing_token: token,
          consumed: { steps: 1, tokens: 1 },
        });
    expect(() => attempt("lease_a_01", 2)()).toThrowError(
      expect.objectContaining({ kind: "stale_fencing_token" }) as Error,
    );
    expect(() => attempt("lease_a_99", 1)()).toThrowError(
      expect.objectContaining({ kind: "stale_fencing_token" }) as Error,
    );
  });

  it("rejects consumption above the reservation", () => {
    const first = reserveTaskBudget(emptyAccount(), reserveInput());
    expect(() =>
      settleTaskBudget(first.account, {
        task_id: "task_a",
        lease_id: "lease_a_01",
        fencing_token: 1,
        consumed: { steps: 7, tokens: 2_500 },
      }),
    ).toThrowError(expect.objectContaining({ kind: "consumed_exceeds_reserved" }) as Error);
  });
});

describe("restoreBudgetAccount", () => {
  it("restores an empty account from no records", () => {
    const restored = restoreBudgetAccount({
      limit: LIMIT,
      iteration_deadline: DEADLINE,
      records: [],
    });
    expect(restored).toEqual(emptyAccount());
  });

  it("replays a granted Lease into an active reservation", () => {
    const granted = grantTaskLease(leaseGrantInput(EMPTY_CHAIN));
    const restored = restoreBudgetAccount({
      limit: LIMIT,
      iteration_deadline: DEADLINE,
      records: [granted],
    });
    expect(restored.reservations["task_a"]).toEqual({
      lease_id: granted.lease_id,
      fencing_token: granted.fencing_token,
      steps: 6,
      tokens: 4_000,
    });
    expect(remainingBudget(restored)).toEqual({ steps: 4, tokens: 4_000 });
  });

  it("replays a granted + released chain into accumulated consumption", () => {
    const granted = grantTaskLease(leaseGrantInput(EMPTY_CHAIN));
    const released = terminateTaskLease(granted, {
      state: "released",
      consumed_budget: { steps: 4, tokens: 2_500 },
      command_id: "command_release_01",
    });
    const restored = restoreBudgetAccount({
      limit: LIMIT,
      iteration_deadline: DEADLINE,
      records: [granted, released],
    });
    expect(restored.reservations).toEqual({});
    expect(restored.consumed["task_a"]).toEqual({ steps: 4, tokens: 2_500 });
    expect(remainingBudget(restored)).toEqual({ steps: 6, tokens: 5_500 });
  });

  it("replays a retry chain: first consumption plus the active retry reservation", () => {
    const first = grantTaskLease(leaseGrantInput(EMPTY_CHAIN));
    const expired = terminateTaskLease(first, {
      state: "expired",
      consumed_budget: { steps: 3, tokens: 2_000 },
      command_id: "command_expire_01",
    });
    const chain = buildTaskLeaseChain([first, expired]);
    const retry = grantTaskLease(
      leaseGrantInput(chain, {
        run_id: "run_02",
        command_id: "command_grant_02",
        retry_kind: "executor_retry",
        reserved_budget: { steps: 5, tokens: 4_000 },
      }),
    );
    const restored = restoreBudgetAccount({
      limit: LIMIT,
      iteration_deadline: DEADLINE,
      records: [first, expired, retry],
    });
    expect(restored.consumed["task_a"]).toEqual({ steps: 3, tokens: 2_000 });
    expect(restored.reservations["task_a"]).toEqual({
      lease_id: retry.lease_id,
      fencing_token: retry.fencing_token,
      steps: 5,
      tokens: 4_000,
    });
    // A retry never earns a new budget: remaining reflects both.
    expect(remainingBudget(restored)).toEqual({ steps: 2, tokens: 2_000 });
  });

  it("treats a byte-identical command replay as one settlement", () => {
    const granted = grantTaskLease(leaseGrantInput(EMPTY_CHAIN));
    const released = terminateTaskLease(granted, {
      state: "released",
      consumed_budget: { steps: 4, tokens: 2_500 },
      command_id: "command_release_01",
    });
    const once = restoreBudgetAccount({
      limit: LIMIT,
      iteration_deadline: DEADLINE,
      records: [granted, released],
    });
    const twice = restoreBudgetAccount({
      limit: LIMIT,
      iteration_deadline: DEADLINE,
      records: [granted, released, granted, released],
    });
    expect(twice).toEqual(once);
  });

  it("rejects a duplicate settlement with different content", () => {
    const granted = grantTaskLease(leaseGrantInput(EMPTY_CHAIN));
    const released = terminateTaskLease(granted, {
      state: "released",
      consumed_budget: { steps: 4, tokens: 2_500 },
      command_id: "command_release_01",
    });
    const settledAgain = terminateTaskLease(granted, {
      state: "released",
      consumed_budget: { steps: 5, tokens: 2_500 },
      command_id: "command_release_02",
    });
    expect(() =>
      restoreBudgetAccount({
        limit: LIMIT,
        iteration_deadline: DEADLINE,
        records: [granted, released, settledAgain],
      }),
    ).toThrowError(expect.objectContaining({ kind: "invalid_transition" }) as Error);
  });

  it("rejects a settlement without a current granted Lease", () => {
    const granted = grantTaskLease(leaseGrantInput(EMPTY_CHAIN));
    const released = terminateTaskLease(granted, {
      state: "released",
      consumed_budget: { steps: 4, tokens: 2_500 },
      command_id: "command_release_01",
    });
    // A terminal record with no granted record in the authoritative history
    // fails the chain read before any budget replay happens.
    expect(() =>
      restoreBudgetAccount({ limit: LIMIT, iteration_deadline: DEADLINE, records: [released] }),
    ).toThrowError(expect.objectContaining({ kind: "lease_chain_inconsistent" }) as Error);
  });

  it("rejects a terminal record for a lease this history never granted", () => {
    const granted = grantTaskLease(leaseGrantInput(EMPTY_CHAIN));
    const other = grantTaskLease(
      leaseGrantInput(EMPTY_CHAIN, { task_id: "task_b", command_id: "command_grant_b" }),
    );
    const otherReleased = terminateTaskLease(other, {
      state: "released",
      consumed_budget: { steps: 1, tokens: 1 },
      command_id: "command_release_b",
    });
    expect(() =>
      restoreBudgetAccount({
        limit: LIMIT,
        iteration_deadline: DEADLINE,
        records: [granted, otherReleased],
      }),
    ).toThrowError(expect.objectContaining({ kind: "lease_chain_inconsistent" }) as Error);
  });

  it("rejects accumulated consumption plus reservations over the approved limit", () => {
    // Policy tightened after the leases were granted: the restored account
    // must fail closed instead of silently projecting an over-limit state.
    const bigA = grantTaskLease(
      leaseGrantInput(EMPTY_CHAIN, { reserved_budget: { steps: 6, tokens: 4_000 } }),
    );
    const bigB = grantTaskLease(
      leaseGrantInput(EMPTY_CHAIN, {
        task_id: "task_b",
        command_id: "command_grant_b",
        reserved_budget: { steps: 6, tokens: 4_000 },
      }),
    );
    expect(() =>
      restoreBudgetAccount({
        limit: LIMIT,
        iteration_deadline: DEADLINE,
        records: [bigA, bigB],
      }),
    ).toThrowError(expect.objectContaining({ kind: "account_inconsistent" }) as Error);
  });

  it("rejects tampered records whose envelope digest no longer covers them", () => {
    const granted = grantTaskLease(leaseGrantInput(EMPTY_CHAIN));
    const tampered = { ...granted, reserved_budget: { steps: 99, tokens: 99 } };
    expect(() =>
      restoreBudgetAccount({
        limit: LIMIT,
        iteration_deadline: DEADLINE,
        records: [tampered as never],
      }),
    ).toThrowError(expect.objectContaining({ kind: "lease_chain_inconsistent" }) as Error);
  });

  it("validates every record on read through assertSchedulingRecordSemantics", () => {
    const granted = grantTaskLease(leaseGrantInput(EMPTY_CHAIN));
    // Well-sealed but semantically impossible (consumed > reserved): the
    // read-side semantics assertion, not the envelope, rejects it.
    const impossible = sealRecordEnvelope({
      ...granted,
      state: "released",
      consumed_budget: { steps: 7, tokens: 4_500 },
      task_lease_record_id: "task-lease-record_impossible",
      previous_lease_record_digest: granted.record_digest,
      command_id: "command_release_impossible",
    });
    expect(() =>
      restoreBudgetAccount({
        limit: LIMIT,
        iteration_deadline: DEADLINE,
        records: [granted, impossible as never],
      }),
    ).toThrow(SchedulingRecordError);
  });
});
