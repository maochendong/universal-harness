import { describe, expect, it } from "vitest";

import {
  SchedulingRecordError,
  buildTaskLeaseRecord,
  sealRecordEnvelope,
  type TaskLeaseRecord,
} from "@universal-harness-internal/core";

import type { PolicyDecision } from "../../src/policy/decision.js";
import {
  assertCurrentFencingToken,
  buildTaskLeaseChain,
  grantTaskLease,
  nextFencingToken,
  terminateTaskLease,
  type GrantTaskLeaseInput,
  type TaskLeaseChain,
} from "../../src/scheduling/lease.js";

/**
 * Plan Task 5 step 1/2: Task Lease fencing state machine. The only legal
 * transition is granted → released/expired/revoked; terminal records never
 * move again, every transition mints a new task_lease_record_id linked by
 * previous_lease_record_digest, and command_id replays are byte-identical.
 */

const digest = (char: string): string => char.repeat(64);
const BASELINE = "0123456789abcdef0123456789abcdef01234567";
const ISSUED_AT = "2026-08-31T00:00:00.000Z";
const EXPIRES_AT = "2026-08-31T01:00:00.000Z";

const EMPTY_CHAIN: TaskLeaseChain = buildTaskLeaseChain([]);

function allowDecision(overrides?: Partial<PolicyDecision>): PolicyDecision {
  return {
    outcome: "allow",
    reasons: [],
    action_digest: digest("0"),
    effective_policy_digest: digest("d"),
    layers: [],
    field_traces: [],
    digest: digest("9"),
    ...overrides,
  };
}

function grantInput(
  chain: TaskLeaseChain,
  overrides?: Partial<GrantTaskLeaseInput>,
): GrantTaskLeaseInput {
  return {
    chain,
    decision: allowDecision(),
    expected_action_digest: digest("0"),
    operation_id: "operation_m4_lease",
    iteration_id: "iteration_m4_lease",
    plan_digest: digest("a"),
    task_id: "task_api",
    task_digest: digest("b"),
    run_id: "run_01",
    slot_id: "slot_01",
    baseline_commit: BASELINE,
    agent_adapter_digest: digest("c"),
    reserved_budget: { steps: 10, tokens: 5_000 },
    issued_at: ISSUED_AT,
    expires_at: EXPIRES_AT,
    command_id: "command_grant_01",
    ...overrides,
  };
}

/** Grant + release a fresh single-attempt lease, returning both records. */
function grantedThenReleased(taskId: string): {
  readonly granted: TaskLeaseRecord;
  readonly released: TaskLeaseRecord;
  readonly chain: TaskLeaseChain;
} {
  const granted = grantTaskLease(grantInput(EMPTY_CHAIN, { task_id: taskId }));
  const released = terminateTaskLease(granted, {
    state: "released",
    consumed_budget: { steps: 7, tokens: 3_200 },
    command_id: `command_release_${taskId}`,
  });
  return { granted, released, chain: buildTaskLeaseChain([granted, released]) };
}

describe("grantTaskLease", () => {
  it("grants a sealed lease binding Plan/Task/baseline/Adapter/Policy digests", () => {
    const granted = grantTaskLease(grantInput(EMPTY_CHAIN));
    expect(granted).toMatchObject({
      record_kind: "task_lease",
      protocol_version: "1.3.0",
      state: "granted",
      operation_id: "operation_m4_lease",
      iteration_id: "iteration_m4_lease",
      plan_digest: digest("a"),
      task_id: "task_api",
      task_digest: digest("b"),
      run_id: "run_01",
      slot_id: "slot_01",
      baseline_commit: BASELINE,
      agent_adapter_digest: digest("c"),
      policy_digest: digest("d"),
      approval_digests: [],
      fencing_token: 1,
      attempt_number: 1,
      reserved_budget: { steps: 10, tokens: 5_000 },
      consumed_budget: { steps: 0, tokens: 0 },
      issued_at: ISSUED_AT,
      expires_at: EXPIRES_AT,
      command_id: "command_grant_01",
    });
    expect(granted.previous_lease_record_digest).toBeUndefined();
  });

  it("is deterministic: identical inputs reproduce the identical record", () => {
    const first = grantTaskLease(grantInput(EMPTY_CHAIN));
    const replay = grantTaskLease(grantInput(EMPTY_CHAIN));
    expect(replay).toEqual(first);
    expect(replay.record_digest).toBe(first.record_digest);
  });

  it("grants on a requires_approval decision satisfied by an exact approval digest", () => {
    const decision = allowDecision({
      outcome: "requires_approval",
      approval_digest: digest("e"),
    });
    const granted = grantTaskLease(grantInput(EMPTY_CHAIN, { decision }));
    expect(granted.state).toBe("granted");
    expect(granted.approval_digests).toEqual([digest("e")]);
  });

  it("refuses a requires_approval decision without the satisfying approval digest", () => {
    const decision = allowDecision({ outcome: "requires_approval" });
    expect(() => grantTaskLease(grantInput(EMPTY_CHAIN, { decision }))).toThrowError(
      expect.objectContaining({
        name: "TaskLeaseError",
        kind: "approval_not_satisfied",
      }) as Error,
    );
  });

  it.each(["deny", "block"] as const)("refuses a %s decision", (outcome) => {
    const decision = allowDecision({ outcome });
    expect(() => grantTaskLease(grantInput(EMPTY_CHAIN, { decision }))).toThrowError(
      expect.objectContaining({
        name: "TaskLeaseError",
        kind: "policy_not_allowed",
      }) as Error,
    );
  });

  it("refuses a decision that does not bind the requested action digest", () => {
    expect(() =>
      grantTaskLease(grantInput(EMPTY_CHAIN, { expected_action_digest: digest("f") })),
    ).toThrowError(
      expect.objectContaining({
        name: "TaskLeaseError",
        kind: "decision_binding_mismatch",
      }) as Error,
    );
  });

  it("refuses a retry kind on the first attempt", () => {
    expect(() =>
      grantTaskLease(grantInput(EMPTY_CHAIN, { retry_kind: "executor_retry" })),
    ).toThrowError(
      expect.objectContaining({ name: "TaskLeaseError", kind: "invalid_retry" }) as Error,
    );
  });

  it("refuses a new attempt while the previous lease is still granted", () => {
    const granted = grantTaskLease(grantInput(EMPTY_CHAIN));
    const chain = buildTaskLeaseChain([granted]);
    expect(() =>
      grantTaskLease(grantInput(chain, { command_id: "command_grant_02", run_id: "run_02" })),
    ).toThrowError(
      expect.objectContaining({ name: "TaskLeaseError", kind: "invalid_transition" }) as Error,
    );
  });

  it("mints a fresh lease_id and the next fencing token for every attempt", () => {
    const { granted, chain } = grantedThenReleased("task_api");
    const second = grantTaskLease(
      grantInput(chain, {
        command_id: "command_grant_02",
        run_id: "run_02",
        retry_kind: "executor_retry",
      }),
    );
    expect(second.lease_id).not.toBe(granted.lease_id);
    expect(second.fencing_token).toBe(granted.fencing_token + 1);
    expect(second.attempt_number).toBe(2);
    expect(second.retry_kind).toBe("executor_retry");
  });

  it("refuses to repeat a retry kind the Task history already consumed", () => {
    const first = grantTaskLease(grantInput(EMPTY_CHAIN));
    const released = terminateTaskLease(first, {
      state: "expired",
      consumed_budget: { steps: 1, tokens: 100 },
      command_id: "command_expire_01",
    });
    const second = grantTaskLease(
      grantInput(buildTaskLeaseChain([first, released]), {
        command_id: "command_grant_02",
        run_id: "run_02",
        retry_kind: "executor_retry",
      }),
    );
    const releasedSecond = terminateTaskLease(second, {
      state: "released",
      consumed_budget: { steps: 2, tokens: 200 },
      command_id: "command_release_02",
    });
    const chain = buildTaskLeaseChain([first, released, second, releasedSecond]);
    expect(() =>
      grantTaskLease(
        grantInput(chain, {
          command_id: "command_grant_03",
          run_id: "run_03",
          retry_kind: "executor_retry",
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ name: "TaskLeaseError", kind: "invalid_retry" }) as Error,
    );
  });
});

describe("terminateTaskLease", () => {
  it("links the previous digest, keeps lease_id and mints a new record id", () => {
    const granted = grantTaskLease(grantInput(EMPTY_CHAIN));
    const released = terminateTaskLease(granted, {
      state: "released",
      consumed_budget: { steps: 7, tokens: 3_200 },
      command_id: "command_release_1",
    });

    expect(released.previous_lease_record_digest).toBe(granted.record_digest);
    expect(released.lease_id).toBe(granted.lease_id);
    expect(released.task_lease_record_id).not.toBe(granted.task_lease_record_id);
    expect(released.state).toBe("released");
    expect(released.consumed_budget).toEqual({ steps: 7, tokens: 3_200 });
    expect(released.fencing_token).toBe(granted.fencing_token);
    expect(released.command_id).toBe("command_release_1");
  });

  it.each(["released", "expired", "revoked"] as const)(
    "rejects any transition out of the terminal %s state",
    (state) => {
      const granted = grantTaskLease(grantInput(EMPTY_CHAIN));
      const terminal = terminateTaskLease(granted, {
        state,
        consumed_budget: { steps: 1, tokens: 10 },
        command_id: `command_${state}_1`,
      });
      expect(() =>
        terminateTaskLease(terminal, {
          state: "released",
          consumed_budget: { steps: 1, tokens: 10 },
          command_id: "command_second",
        }),
      ).toThrow(/terminal/u);
    },
  );

  it("replays a command_id byte-identically instead of minting a second record", () => {
    const granted = grantTaskLease(grantInput(EMPTY_CHAIN));
    const input = {
      state: "released" as const,
      consumed_budget: { steps: 7, tokens: 3_200 },
      command_id: "command_release_1",
    };
    const first = terminateTaskLease(granted, input);
    const replay = terminateTaskLease(granted, input);
    expect(replay).toEqual(first);
    expect(replay.task_lease_record_id).toBe(first.task_lease_record_id);
    expect(replay.record_digest).toBe(first.record_digest);
  });

  it("rejects consumption above the granted reservation", () => {
    const granted = grantTaskLease(grantInput(EMPTY_CHAIN));
    expect(() =>
      terminateTaskLease(granted, {
        state: "released",
        consumed_budget: { steps: 11, tokens: 3_200 },
        command_id: "command_release_1",
      }),
    ).toThrow(SchedulingRecordError);
  });

  it("rejects a consumed budget below the one the current record carries", () => {
    const granted = buildTaskLeaseRecord({
      ...grantTaskLease(grantInput(EMPTY_CHAIN)),
      consumed_budget: { steps: 4, tokens: 400 },
    });
    expect(() =>
      terminateTaskLease(granted, {
        state: "released",
        consumed_budget: { steps: 3, tokens: 400 },
        command_id: "command_release_1",
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "TaskLeaseError",
        kind: "consumed_budget_regression",
      }) as Error,
    );
  });
});

describe("TaskLeaseChain fencing helpers", () => {
  it("starts every unknown Task at fencing token 1", () => {
    expect(nextFencingToken(EMPTY_CHAIN, "task_unknown")).toBe(1);
    expect(() => assertCurrentFencingToken(EMPTY_CHAIN, "task_unknown", 1)).toThrowError(
      expect.objectContaining({ name: "TaskLeaseError", kind: "stale_fencing_token" }) as Error,
    );
  });

  it("tracks the latest record per Task and rejects every older token", () => {
    const { granted, released, chain } = grantedThenReleased("task_api");
    expect(chain.latest_by_task.get("task_api")).toEqual(released);
    expect(nextFencingToken(chain, "task_api")).toBe(granted.fencing_token + 1);
    expect(() => assertCurrentFencingToken(chain, "task_api", granted.fencing_token)).not.toThrow();
    expect(() =>
      assertCurrentFencingToken(chain, "task_api", granted.fencing_token - 1),
    ).toThrowError(
      expect.objectContaining({ name: "TaskLeaseError", kind: "stale_fencing_token" }) as Error,
    );
    expect(() =>
      assertCurrentFencingToken(chain, "task_api", granted.fencing_token + 1),
    ).toThrowError(
      expect.objectContaining({ name: "TaskLeaseError", kind: "stale_fencing_token" }) as Error,
    );
  });

  it("keeps the released fencing token current after the lease is released", () => {
    const { released, chain } = grantedThenReleased("task_api");
    expect(() =>
      assertCurrentFencingToken(chain, "task_api", released.fencing_token),
    ).not.toThrow();
  });
});

describe("buildTaskLeaseChain", () => {
  it("drops byte-identical command_id replays without changing the chain", () => {
    const { granted, released } = grantedThenReleased("task_api");
    const chain = buildTaskLeaseChain([granted, released, granted, released]);
    expect(chain.records).toHaveLength(2);
    expect(chain.records).toEqual([granted, released]);
  });

  it("rejects a command_id reused with different content", () => {
    const granted = grantTaskLease(grantInput(EMPTY_CHAIN));
    const released = terminateTaskLease(granted, {
      state: "released",
      consumed_budget: { steps: 7, tokens: 3_200 },
      command_id: "command_release_1",
    });
    const conflicting = terminateTaskLease(granted, {
      state: "released",
      consumed_budget: { steps: 8, tokens: 3_200 },
      command_id: "command_release_1",
    });
    expect(conflicting.record_digest).not.toBe(released.record_digest);
    expect(() => buildTaskLeaseChain([granted, released, conflicting])).toThrowError(
      expect.objectContaining({ name: "TaskLeaseError", kind: "command_conflict" }) as Error,
    );
  });

  it("rejects a second transition after the terminal record", () => {
    const { granted, released } = grantedThenReleased("task_api");
    const forged = buildTaskLeaseRecord({
      ...released,
      task_lease_record_id: "task-lease-record_forged",
      state: "revoked",
      consumed_budget: { steps: 7, tokens: 3_200 },
      previous_lease_record_digest: released.record_digest,
      command_id: "command_revoke_forged",
    });
    expect(() => buildTaskLeaseChain([granted, released, forged])).toThrowError(
      expect.objectContaining({ name: "TaskLeaseError", kind: "invalid_transition" }) as Error,
    );
  });

  it("rejects a terminal record whose previous link does not match the granted digest", () => {
    const granted = grantTaskLease(grantInput(EMPTY_CHAIN));
    const other = grantTaskLease(grantInput(EMPTY_CHAIN, { task_id: "task_other" }));
    const released = terminateTaskLease(granted, {
      state: "released",
      consumed_budget: { steps: 1, tokens: 10 },
      command_id: "command_release_1",
    });
    // Well-sealed but linked to the wrong predecessor: reseal so the envelope
    // check passes and the chain-link invariant is what fails.
    const broken = buildTaskLeaseRecord({
      ...released,
      previous_lease_record_digest: other.record_digest,
    });
    expect(() => buildTaskLeaseChain([granted, broken])).toThrowError(
      expect.objectContaining({
        name: "TaskLeaseError",
        kind: "lease_chain_inconsistent",
      }) as Error,
    );
  });

  it("rejects a new attempt granted before the previous lease reached a terminal state", () => {
    const first = grantTaskLease(grantInput(EMPTY_CHAIN));
    // grantTaskLease already refuses this (covered above); a forged second
    // grant bypassing the reducer must still fail chain validation.
    const forgedSecond = buildTaskLeaseRecord({
      ...first,
      task_lease_record_id: "task-lease-record_forged2",
      lease_id: "lease_forged2",
      run_id: "run_02",
      fencing_token: 2,
      attempt_number: 2,
      command_id: "command_grant_forged2",
    });
    expect(() => buildTaskLeaseChain([first, forgedSecond])).toThrowError(
      expect.objectContaining({ name: "TaskLeaseError", kind: "invalid_transition" }) as Error,
    );
  });

  it("validates every record on read: tampered bytes fail the envelope check", () => {
    const granted = grantTaskLease(grantInput(EMPTY_CHAIN));
    // Post-seal tampering: record_digest no longer covers the content.
    const tampered = { ...granted, reserved_budget: { steps: 99, tokens: 99 } };
    expect(() => buildTaskLeaseChain([tampered as TaskLeaseRecord])).toThrowError(
      expect.objectContaining({
        name: "TaskLeaseError",
        kind: "lease_chain_inconsistent",
      }) as Error,
    );
  });

  it("validates every record on read through assertSchedulingRecordSemantics", () => {
    const granted = grantTaskLease(grantInput(EMPTY_CHAIN));
    // Well-sealed but semantically impossible: consumed exceeds reserved.
    const invalid = sealRecordEnvelope({
      ...granted,
      consumed_budget: { steps: 11, tokens: 6_000 },
      record_digest: undefined,
    } as unknown as Record<string, unknown>);
    expect(() => buildTaskLeaseChain([invalid as unknown as TaskLeaseRecord])).toThrow(
      SchedulingRecordError,
    );
  });
});

describe("grant/terminate integration through the chain", () => {
  it("orders independent Tasks independently", () => {
    const first = grantTaskLease(grantInput(EMPTY_CHAIN, { task_id: "task_a" }));
    const second = grantTaskLease(
      grantInput(EMPTY_CHAIN, { task_id: "task_b", command_id: "command_grant_b" }),
    );
    const chain = buildTaskLeaseChain([first, second]);
    expect(chain.latest_by_task.get("task_a")?.fencing_token).toBe(1);
    expect(chain.latest_by_task.get("task_b")?.fencing_token).toBe(1);
    expect(nextFencingToken(chain, "task_a")).toBe(2);
    expect(nextFencingToken(chain, "task_b")).toBe(2);
  });

  it("is a pure reducer: no input record or chain is mutated", () => {
    const granted = grantTaskLease(grantInput(EMPTY_CHAIN));
    const snapshot = { ...granted };
    const chain = buildTaskLeaseChain([granted]);
    terminateTaskLease(chain.latest_by_task.get("task_api") as TaskLeaseRecord, {
      state: "released",
      consumed_budget: { steps: 1, tokens: 1 },
      command_id: "command_release_1",
    });
    expect(granted).toEqual(snapshot);
    expect(chain.records).toHaveLength(1);
  });
});
