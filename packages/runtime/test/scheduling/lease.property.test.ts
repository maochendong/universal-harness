import { describe, expect, it } from "vitest";

import type { TaskLeaseRecord, TaskRetryKind } from "@universal-harness-internal/core";

import type { PolicyDecision } from "../../src/policy/decision.js";
import {
  assertCurrentFencingToken,
  buildTaskLeaseChain,
  grantTaskLease,
  terminateTaskLease,
  type GrantTaskLeaseInput,
  type TaskLeaseChain,
  type TerminateTaskLeaseInput,
} from "../../src/scheduling/lease.js";
import { mulberry32, pick, randomInt } from "../context/seeds.js";

/**
 * Plan Task 5 step 1: seeded property tests over random lease chains. The
 * invariants under test: fencing tokens strictly increase across attempts, an
 * old token never becomes current again, command_id replays are byte-identical
 * no-ops, and only a granted record can transition.
 */

const digest = (char: string): string => char.repeat(64);
const BASELINE = "0123456789abcdef0123456789abcdef01234567";
const TERMINAL_STATES = ["released", "expired", "revoked"] as const;
const RETRY_KINDS: readonly TaskRetryKind[] = ["executor_retry", "integration_retry"];
const TASK_IDS = ["task_alpha", "task_beta", "task_gamma"] as const;
// Four hundred stateful steps deliberately exercise the whole lease chain.
// Bound this property locally instead of widening every unit test in the suite.
const PROPERTY_TIMEOUT = 30_000;

interface TaskSim {
  readonly records: TaskLeaseRecord[];
  open: TaskLeaseRecord | null;
  attempts: number;
  lastToken: number;
  readonly usedRetryKinds: TaskRetryKind[];
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

function grantInput(
  chain: TaskLeaseChain,
  taskId: string,
  commandId: string,
  random: () => number,
  retryKind?: TaskRetryKind,
): GrantTaskLeaseInput {
  return {
    chain,
    decision: allowDecision(),
    expected_action_digest: digest("0"),
    operation_id: "operation_m4_prop",
    iteration_id: "iteration_m4_prop",
    plan_digest: digest("a"),
    task_id: taskId,
    task_digest: digest("b"),
    run_id: `run_${commandId}`,
    slot_id: `slot_${String(randomInt(random, 4) + 1).padStart(2, "0")}`,
    baseline_commit: BASELINE,
    agent_adapter_digest: digest("c"),
    reserved_budget: { steps: randomInt(random, 20) + 1, tokens: randomInt(random, 9_000) + 1 },
    issued_at: "2026-08-31T00:00:00.000Z",
    expires_at: "2026-08-31T01:00:00.000Z",
    command_id: commandId,
    ...(retryKind === undefined ? {} : { retry_kind: retryKind }),
  };
}

function allRecords(sims: readonly TaskSim[]): TaskLeaseRecord[] {
  return sims.flatMap((sim) => sim.records);
}

describe("task lease chain properties", { timeout: PROPERTY_TIMEOUT }, () => {
  it("fencing strictly increases, old tokens never return, commands are idempotent", () => {
    const random = mulberry32(2026_0831);
    const sims: TaskSim[] = TASK_IDS.map(() => ({
      records: [],
      open: null,
      attempts: 0,
      lastToken: 0,
      usedRetryKinds: [],
    }));
    // Remember the last accepted command per shape so replay checks re-issue
    // the exact same input against the exact same pre-state.
    let lastGrant: { input: GrantTaskLeaseInput; record: TaskLeaseRecord } | null = null;
    const pastTerminations: Array<{
      target: TaskLeaseRecord;
      input: TerminateTaskLeaseInput;
      record: TaskLeaseRecord;
    }> = [];

    for (let step = 0; step < 400; step += 1) {
      const sim = sims[randomInt(random, sims.length)] as TaskSim;
      const preChain = buildTaskLeaseChain(allRecords(sims));
      const roll = random();

      if (roll < 0.08 && lastGrant !== null) {
        // Grant replay: identical command against the identical chain state
        // reproduces the identical record — no new lease_id, no new token.
        const replay = grantTaskLease(lastGrant.input);
        expect(replay).toEqual(lastGrant.record);
        continue;
      }
      if (roll < 0.16 && pastTerminations.length > 0) {
        // Termination replay by command_id: byte-identical record.
        const remembered = pick(random, pastTerminations);
        const replay = terminateTaskLease(remembered.target, remembered.input);
        expect(replay).toEqual(remembered.record);
        continue;
      }
      if (roll < 0.24 && pastTerminations.length > 0) {
        // Only granted can transition: every terminal record refuses.
        const remembered = pick(random, pastTerminations);
        expect(() =>
          terminateTaskLease(remembered.record, {
            state: pick(random, TERMINAL_STATES),
            consumed_budget: remembered.record.consumed_budget,
            command_id: `command_reterm_${step}`,
          }),
        ).toThrowError(
          expect.objectContaining({ name: "TaskLeaseError", kind: "invalid_transition" }) as Error,
        );
        continue;
      }

      if (sim.open === null) {
        // New attempt: fencing token strictly increases by exactly one.
        const retryCandidates = RETRY_KINDS.filter((kind) => !sim.usedRetryKinds.includes(kind));
        const retryKind =
          sim.attempts > 0 && retryCandidates.length > 0 && random() < 0.5
            ? pick(random, retryCandidates)
            : undefined;
        const input = grantInput(
          preChain,
          TASK_IDS[sims.indexOf(sim)],
          `command_g_${step}`,
          random,
          retryKind,
        );
        const granted = grantTaskLease(input);
        expect(granted.fencing_token).toBe(sim.lastToken + 1);
        expect(granted.attempt_number).toBe(sim.attempts + 1);
        if (sim.records.length > 0) {
          const previousLeaseIds = new Set(sim.records.map((record) => record.lease_id));
          expect(previousLeaseIds.has(granted.lease_id)).toBe(false);
        }
        sim.records.push(granted);
        sim.open = granted;
        sim.attempts += 1;
        sim.lastToken = granted.fencing_token;
        if (retryKind !== undefined) sim.usedRetryKinds.push(retryKind);
        lastGrant = { input, record: granted };
      } else {
        // Terminate the open lease with a random in-reservation consumption.
        const open = sim.open;
        const input: TerminateTaskLeaseInput = {
          state: pick(random, TERMINAL_STATES),
          consumed_budget: {
            steps: randomInt(random, open.reserved_budget.steps + 1),
            tokens: randomInt(random, open.reserved_budget.tokens + 1),
          },
          command_id: `command_t_${step}`,
        };
        const terminal = terminateTaskLease(open, input);
        expect(terminal.lease_id).toBe(open.lease_id);
        expect(terminal.fencing_token).toBe(open.fencing_token);
        expect(terminal.previous_lease_record_digest).toBe(open.record_digest);
        expect(terminal.task_lease_record_id).not.toBe(open.task_lease_record_id);
        sim.records.push(terminal);
        sim.open = null;
        pastTerminations.push({ target: open, input, record: terminal });
      }

      // Chain-level invariants after every accepted step.
      const chain = buildTaskLeaseChain(allRecords(sims));
      for (const check of sims) {
        if (check.records.length === 0) continue;
        const latest = chain.latest_by_task.get(TASK_IDS[sims.indexOf(check)]) as TaskLeaseRecord;
        expect(latest.fencing_token).toBe(check.lastToken);
        assertCurrentFencingToken(chain, latest.task_id, check.lastToken);
        for (let token = 1; token < check.lastToken; token += 1) {
          expect(() => assertCurrentFencingToken(chain, latest.task_id, token)).toThrowError(
            expect.objectContaining({
              name: "TaskLeaseError",
              kind: "stale_fencing_token",
            }) as Error,
          );
        }
      }

      // Duplicate-injected replays of the authoritative history reduce to the
      // identical chain (command_id idempotence at read time).
      if (step % 7 === 0) {
        const records = allRecords(sims);
        const injected = [...records];
        for (let copy = 0; copy < 3 && records.length > 0; copy += 1) {
          // A replay duplicate always arrives after its original commit; the
          // read side must drop it without disturbing the chain.
          const record = pick(random, records);
          const originalAt = injected.indexOf(record);
          const position = originalAt + 1 + randomInt(random, injected.length - originalAt);
          injected.splice(position, 0, record);
        }
        const deduped = buildTaskLeaseChain(injected);
        expect(deduped.records).toEqual(chain.records);
      }
    }

    // The simulation must have exercised every shape it claims to cover.
    expect(pastTerminations.length).toBeGreaterThan(10);
    expect(sims.some((sim) => sim.attempts > 1)).toBe(true);
    expect(sims.some((sim) => sim.usedRetryKinds.length > 0)).toBe(true);
  });
});
