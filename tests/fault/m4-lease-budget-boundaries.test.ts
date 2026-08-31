import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalizeJson } from "../../packages/core/src/identity/canonical-json.js";
import { sha256Hex } from "../../packages/core/src/ledger/event-store.js";
import { LedgerRepository } from "../../packages/core/src/ledger/repository.js";
import type { DurableBoundary } from "../../packages/core/src/ledger/transaction.js";
import type { TaskLeaseRecord } from "../../packages/core/src/schema/scheduling.js";
import {
  BASELINE,
  FIXED_NOW,
  makeInput,
  makeProjectRoot,
} from "../../packages/core/test/ledger/fixtures.js";
import { actionDigest } from "../../packages/runtime/src/policy/action.js";
import { buildDecision } from "../../packages/runtime/src/policy/decision.js";
import { mergePolicyLayers } from "../../packages/runtime/src/policy/evaluator.js";
import type {
  IterationBudget,
  Protocol13TaskBudget,
} from "../../packages/runtime/src/planning/task.js";
import {
  createIterationBudgetAccount,
  remainingBudget,
  reserveTaskBudget,
  restoreBudgetAccount,
  type IterationBudgetAccount,
} from "../../packages/runtime/src/scheduling/budget.js";
import {
  buildTaskLeaseChain,
  deriveTaskLeaseId,
  grantTaskLease,
  nextFencingToken,
} from "../../packages/runtime/src/scheduling/lease.js";
import { createInMemoryPolicyDecisionPort } from "../../packages/runtime/src/scheduling/policy-adapters.js";
import type { SchedulerPolicyInput } from "../../packages/runtime/src/scheduling/ports.js";
import {
  SimulatedProcessKill,
  createFaultInjector,
  type FaultSpec,
} from "../helpers/fault-injection.js";

/**
 * Plan Task 5 step 5: atomic commit boundary faults on the dispatch chain
 *
 *   policy allow → reserve → granted Lease → process start
 *
 * The in-memory coordinator below reserves budget and grants the Lease purely,
 * commits the Lease record through the real Ledger transaction protocol, and
 * only then applies the in-memory account change and starts the process.
 * Killing the coordinator at every durable boundary must prove: no state ever
 * exposes a reservation without its committed granted Lease, no process
 * starts before the commit point, a replayed command_id is a no-op, and a
 * failed transaction returns all of its budget.
 */

const digest = (char: string): string => char.repeat(64);
const RECORD_DIR = "records/scheduling/task-lease";
const OPERATION_ID = "operation_m4_fault";
const ITERATION_ID = "iteration_m4_fault";
const TASK_ID = "task_fault_alpha";
const COMMAND_ID = "command_dispatch_fault_01";
const DEADLINE = "2026-08-12T01:00:00.000Z";
const LIMIT: IterationBudget = { steps: 10, tokens: 8_000, duration_ms: 3_600_000 };
const TASK_BUDGET: Protocol13TaskBudget = { steps: 8, tokens: 6_000, duration_ms: 1_800_000 };
const RESERVE_STEPS = 6;
const RESERVE_TOKENS = 4_000;

const policyPort = createInMemoryPolicyDecisionPort({
  resolve: (action) =>
    buildDecision({
      outcome: "allow",
      reasons: ["fault harness always allows"],
      action_digest: actionDigest(action),
      effective: mergePolicyLayers([]).effective,
    }),
});

function schedulerPolicyInput(): SchedulerPolicyInput {
  return {
    action: "dispatch_task",
    operation_id: OPERATION_ID,
    iteration_id: ITERATION_ID,
    plan_digest: digest("a"),
    task_digest: digest("b"),
    baseline_commit: BASELINE,
    risk: "medium",
    capabilities: ["edit-source"],
    tools: ["apply_patch"],
    write_paths: ["src/alpha"],
    exclusive_resources: [],
    task_remaining_budget: TASK_BUDGET,
    iteration_remaining_budget: LIMIT,
    adapter_manifest_digest: digest("c"),
    adapter_control_profile: {
      control: "managed",
      trajectory_visibility: "full",
      usage_metering: true,
      side_effect_interception: true,
    },
    effective_policy_digest: mergePolicyLayers([]).effective.digest,
  };
}

/** Coordinator-local state; dies with the simulated process on a kill. */
interface CoordinatorState {
  account: IterationBudgetAccount;
  records: TaskLeaseRecord[];
  startedProcesses: string[];
}

function freshCoordinator(): CoordinatorState {
  return {
    account: createIterationBudgetAccount({ limit: LIMIT, iteration_deadline: DEADLINE }),
    records: [],
    startedProcesses: [],
  };
}

/**
 * One dispatch pass. The reservation and the Lease stay coordinator-local
 * until the Ledger commit point; only a successful commit applies them and
 * starts the process. An already-committed replay of the same command_id
 * changes nothing and starts nothing.
 */
async function dispatchTask(
  repository: LedgerRepository,
  state: CoordinatorState,
): Promise<"started" | "already_committed"> {
  // Recovery-first (design §9 step 1): rebuild from the authoritative Ledger
  // before any local work; a command whose Lease is already committed is an
  // idempotent no-op — no second reservation, no second process.
  const authoritative = readCommittedLeaseRecords(repository);
  if (authoritative.some((record) => record.command_id === COMMAND_ID)) {
    return "already_committed";
  }
  const input = schedulerPolicyInput();
  const decision = await policyPort.decide(input);
  const chain = buildTaskLeaseChain(state.records);
  const fencingToken = nextFencingToken(chain, TASK_ID);
  const latest = chain.latest_by_task.get(TASK_ID);
  const attemptNumber = latest === undefined ? 1 : latest.attempt_number + 1;
  const leaseId = deriveTaskLeaseId(TASK_ID, attemptNumber, COMMAND_ID);

  const reservation = reserveTaskBudget(state.account, {
    task_id: TASK_ID,
    lease_id: leaseId,
    fencing_token: fencingToken,
    task_budget: TASK_BUDGET,
    task_remaining_duration_ms: TASK_BUDGET.duration_ms,
    steps: RESERVE_STEPS,
    tokens: RESERVE_TOKENS,
    now: FIXED_NOW,
  });
  const granted = grantTaskLease({
    chain,
    decision,
    expected_action_digest: decision.action_digest,
    operation_id: OPERATION_ID,
    iteration_id: ITERATION_ID,
    plan_digest: digest("a"),
    task_id: TASK_ID,
    task_digest: digest("b"),
    run_id: "run_fault_01",
    slot_id: "slot_01",
    baseline_commit: BASELINE,
    agent_adapter_digest: digest("c"),
    reserved_budget: reservation.reserved_budget,
    issued_at: FIXED_NOW,
    expires_at: reservation.expires_at,
    command_id: COMMAND_ID,
  });
  expect(granted.lease_id).toBe(leaseId);

  const result = await repository.commit(
    makeInput(COMMAND_ID, {
      artifacts: [
        {
          path: `${RECORD_DIR}/${COMMAND_ID}.json`,
          content: `${canonicalizeJson(granted)}\n`,
        },
      ],
      required_reader_version: "1.3.0",
    }),
  );
  if (result.status === "already_committed") {
    // Idempotent replay: the lease, reservation and process already exist.
    return "already_committed";
  }
  state.account = reservation.account;
  state.records.push(granted);
  state.startedProcesses.push(granted.lease_id);
  return "started";
}

function makeRepository(projectRoot: string, fault?: FaultSpec): LedgerRepository {
  const injector = fault === undefined ? undefined : createFaultInjector(fault);
  return new LedgerRepository({
    projectRoot,
    readBaseline: () => BASELINE,
    now: () => FIXED_NOW,
    ...(injector === undefined ? {} : { hooks: injector.hooks }),
  });
}

/**
 * Authoritative read path: only artifact bytes referenced by a committed
 * manifest count. Shards an interrupted transaction renamed into place
 * without ever committing its manifest are orphaned bytes, never records.
 */
function readCommittedLeaseRecords(repository: LedgerRepository): TaskLeaseRecord[] {
  const committedDigests = new Set(
    repository.operations().flatMap((operation) => operation.manifest.artifact_digests),
  );
  const directory = join(repository.harnessRoot, RECORD_DIR);
  if (!existsSync(directory)) return [];
  const records: TaskLeaseRecord[] = [];
  for (const fileName of readdirSync(directory).sort()) {
    const content = readFileSync(join(directory, fileName), "utf8");
    if (!committedDigests.has(sha256Hex(content))) continue;
    records.push(JSON.parse(content) as TaskLeaseRecord);
  }
  return records;
}

const PRE_COMMIT_BOUNDARIES: readonly DurableBoundary[] = [
  "lock.acquired",
  "staging.prepared",
  "validation.completed",
  "shards.renamed",
];

describe("m4 lease/budget atomic commit boundaries", () => {
  it("commits the granted Lease and starts the process only after the commit point", async () => {
    const projectRoot = makeProjectRoot();
    const repository = makeRepository(projectRoot);
    const coordinator = freshCoordinator();

    const outcome = await dispatchTask(repository, coordinator);
    expect(outcome).toBe("started");
    expect(coordinator.startedProcesses).toHaveLength(1);

    // The transaction pins the 1.3 reader version exactly.
    const operations = repository.operations();
    expect(operations).toHaveLength(1);
    expect(operations[0]?.manifest.required_reader_version).toBe("1.3.0");

    // The authoritative read restores exactly the reservation the Lease holds.
    const records = readCommittedLeaseRecords(repository);
    expect(records).toHaveLength(1);
    expect(records[0]?.state).toBe("granted");
    const restored = restoreBudgetAccount({
      limit: LIMIT,
      iteration_deadline: DEADLINE,
      records,
    });
    expect(restored.reservations[TASK_ID]).toEqual({
      lease_id: records[0]?.lease_id,
      fencing_token: 1,
      steps: RESERVE_STEPS,
      tokens: RESERVE_TOKENS,
    });
    expect(remainingBudget(restored)).toEqual({ steps: 4, tokens: 4_000 });
  });

  for (const boundary of PRE_COMMIT_BOUNDARIES) {
    it(`exposes neither reservation nor process when killed at ${boundary}`, async () => {
      const projectRoot = makeProjectRoot();
      const crashed = freshCoordinator();
      const injector = createFaultInjector({ boundary, kind: "process-kill" });
      const crashingRepository = new LedgerRepository({
        projectRoot,
        readBaseline: () => BASELINE,
        now: () => FIXED_NOW,
        hooks: injector.hooks,
      });

      await expect(dispatchTask(crashingRepository, crashed)).rejects.toBeInstanceOf(
        SimulatedProcessKill,
      );
      expect(injector.fired()).toBe(true);
      // The commit never resolved: the coordinator never started a process and
      // its local reservation died with it.
      expect(crashed.startedProcesses).toEqual([]);

      // A fresh process observes no authoritative trace: no Lease record, no
      // reservation, and the full iteration budget remains available.
      const recovered = makeRepository(projectRoot);
      const records = readCommittedLeaseRecords(recovered);
      expect(records).toEqual([]);
      const restored = restoreBudgetAccount({
        limit: LIMIT,
        iteration_deadline: DEADLINE,
        records,
      });
      expect(restored.reservations).toEqual({});
      expect(restored.consumed).toEqual({});
      expect(remainingBudget(restored)).toEqual({ steps: LIMIT.steps, tokens: LIMIT.tokens });

      // At shards.renamed the record bytes may already sit in the ledger tree;
      // without a committed manifest they are orphans, never authoritative.
      const orphanPath = join(recovered.harnessRoot, RECORD_DIR, `${COMMAND_ID}.json`);
      if (boundary === "shards.renamed") {
        expect(existsSync(orphanPath)).toBe(true);
      }

      // Replaying the same command_id in a fresh coordinator commits exactly
      // once and starts the process exactly once.
      const retried = freshCoordinator();
      const outcome = await dispatchTask(recovered, retried);
      expect(outcome).toBe("started");
      expect(retried.startedProcesses).toHaveLength(1);
      expect(recovered.operations()).toHaveLength(1);
      expect(readCommittedLeaseRecords(recovered)).toHaveLength(1);
    });
  }

  it("treats a kill at the commit point as durable and replays idempotently", async () => {
    const projectRoot = makeProjectRoot();
    const crashed = freshCoordinator();
    const injector = createFaultInjector({ boundary: "manifest.committed", kind: "process-kill" });
    const crashingRepository = new LedgerRepository({
      projectRoot,
      readBaseline: () => BASELINE,
      now: () => FIXED_NOW,
      hooks: injector.hooks,
    });

    await expect(dispatchTask(crashingRepository, crashed)).rejects.toBeInstanceOf(
      SimulatedProcessKill,
    );
    // The caller saw a crash before the result returned, so no process was
    // started by the crashed coordinator even though the commit is durable.
    expect(crashed.startedProcesses).toEqual([]);

    const recovered = makeRepository(projectRoot);
    const records = readCommittedLeaseRecords(recovered);
    expect(records).toHaveLength(1);
    expect(records[0]?.state).toBe("granted");
    const restored = restoreBudgetAccount({
      limit: LIMIT,
      iteration_deadline: DEADLINE,
      records,
    });
    expect(restored.reservations[TASK_ID]?.lease_id).toBe(records[0]?.lease_id);

    // Replaying the same command_id against the recovered Ledger is a no-op:
    // no second record, no second reservation, no duplicate process start.
    const retried = freshCoordinator();
    const outcome = await dispatchTask(recovered, retried);
    expect(outcome).toBe("already_committed");
    expect(retried.startedProcesses).toEqual([]);
    expect(retried.records).toEqual([]);
    expect(recovered.operations()).toHaveLength(1);
    expect(readCommittedLeaseRecords(recovered)).toHaveLength(1);

    // The Ledger itself also rejects a duplicate commit of the same command:
    // byte-identical retry is recognized as already committed, never appended.
    const granted = records[0] as TaskLeaseRecord;
    const replay = await recovered.commit(
      makeInput(COMMAND_ID, {
        artifacts: [
          {
            path: `${RECORD_DIR}/${COMMAND_ID}.json`,
            content: `${canonicalizeJson(granted)}\n`,
          },
        ],
        required_reader_version: "1.3.0",
      }),
    );
    expect(replay.status).toBe("already_committed");
    expect(recovered.operations()).toHaveLength(1);
  });

  it("a replay after a fully successful dispatch changes nothing", async () => {
    const projectRoot = makeProjectRoot();
    const repository = makeRepository(projectRoot);
    const coordinator = freshCoordinator();

    expect(await dispatchTask(repository, coordinator)).toBe("started");
    const before = readCommittedLeaseRecords(repository);
    expect(await dispatchTask(repository, coordinator)).toBe("already_committed");
    expect(readCommittedLeaseRecords(repository)).toEqual(before);
    expect(coordinator.startedProcesses).toHaveLength(1);
    expect(coordinator.records).toHaveLength(1);
    expect(remainingBudget(coordinator.account)).toEqual({ steps: 4, tokens: 4_000 });
  });
});
