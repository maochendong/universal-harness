import { canonicalizeJson } from "@universal-harness-internal/core";
import { describe, expect, it } from "vitest";

import type { PolicyDecision } from "../../src/policy/decision.js";
import type { Protocol13TaskSpecification } from "../../src/planning/task.js";
import {
  buildTaskLeaseChain,
  grantTaskLease,
  terminateTaskLease,
  type GrantTaskLeaseInput,
  type TaskLeaseChain,
} from "../../src/scheduling/lease.js";
import {
  ResourceLockError,
  acquireTaskResources,
  emptyResourceLockTable,
  rebuildResourceLocks,
  releaseTaskResources,
  resourceKeys,
  type ResourceLockTable,
  type TaskResourceClaim,
} from "../../src/scheduling/resource-locks.js";

/**
 * Plan Task 6 step 1/2: the runtime resource lock projection (design §12).
 * Lock keys are exactly `write:<normalized-path>` and
 * `exclusive:<resource-key>`, every acquisition is sorted and all-or-nothing,
 * path conflicts reuse compileParallelWaves()'s ancestor/descendant
 * writePathsOverlap, release binds the exact task_id + fencing_token, and a
 * Coordinator restart rebuilds a byte-equivalent table from the currently
 * granted Leases. No ResourceLockRecord is ever written.
 */

const digest = (char: string): string => char.repeat(64);
const BASELINE = "0123456789abcdef0123456789abcdef01234567";
const ISSUED_AT = "2026-08-31T00:00:00.000Z";
const EXPIRES_AT = "2026-08-31T01:00:00.000Z";

function makeTask(
  id: string,
  writePaths: readonly string[],
  exclusiveResources: readonly string[],
): Protocol13TaskSpecification {
  return {
    id,
    objective: `objective of ${id}`,
    impact_paths: [],
    expected_outputs: [`output_${id}`],
    capabilities: ["edit-source"],
    tools: ["apply_patch"],
    dependencies: [],
    risk: "low",
    budget: { steps: 5, tokens: 1_000, duration_ms: 60_000 },
    write_paths: writePaths,
    exclusive_resources: exclusiveResources,
    acceptance: [{ description: "works", verification: "vitest" }],
    required_gates: [],
  };
}

function claim(task: Protocol13TaskSpecification, fencingToken: number): TaskResourceClaim {
  return {
    task_id: task.id,
    fencing_token: fencingToken,
    write_paths: task.write_paths,
    exclusive_resources: task.exclusive_resources,
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

function grantInput(taskId: string, commandId: string): GrantTaskLeaseInput {
  return {
    chain: buildTaskLeaseChain([]),
    decision: allowDecision(),
    expected_action_digest: digest("0"),
    operation_id: "operation_m4_locks",
    iteration_id: "iteration_m4_locks",
    plan_digest: digest("a"),
    task_id: taskId,
    task_digest: digest("b"),
    run_id: `run_${taskId}`,
    slot_id: "slot_01",
    baseline_commit: BASELINE,
    agent_adapter_digest: digest("c"),
    reserved_budget: { steps: 5, tokens: 1_000 },
    issued_at: ISSUED_AT,
    expires_at: EXPIRES_AT,
    command_id: commandId,
  };
}

function grantedChain(taskIds: readonly string[]): TaskLeaseChain {
  const records = [];
  const chainSoFar: typeof records = [];
  for (const taskId of taskIds) {
    const granted = grantTaskLease({
      ...grantInput(taskId, `command_grant_${taskId}`),
      chain: buildTaskLeaseChain(chainSoFar),
    });
    records.push(granted);
    chainSoFar.push(granted);
  }
  return buildTaskLeaseChain(records);
}

describe("resourceKeys", () => {
  it("derives exactly write:/exclusive: keys from normalized claims, sorted", () => {
    expect(
      resourceKeys({
        write_paths: ["packages/runtime/src", "docs"],
        exclusive_resources: ["service-port:8080", "database-schema"],
      }),
    ).toEqual([
      "exclusive:database-schema",
      "exclusive:service-port:8080",
      "write:docs",
      "write:packages/runtime/src",
    ]);
  });

  it("rejects non-canonical claims before any key exists", () => {
    expect(() =>
      resourceKeys({ write_paths: ["../escape"], exclusive_resources: [] }),
    ).toThrowError(expect.objectContaining({ name: "PlanningError" }));
    expect(() => resourceKeys({ write_paths: [], exclusive_resources: ["UPPER"] })).toThrowError(
      expect.objectContaining({ name: "PlanningError" }),
    );
  });
});

describe("acquireTaskResources", () => {
  it("holds one sorted entry per claimed key", () => {
    const table = acquireTaskResources(emptyResourceLockTable(), {
      task_id: "task_a",
      fencing_token: 1,
      write_paths: ["packages/runtime/src"],
      exclusive_resources: ["database-schema"],
    });
    expect(table.entries).toEqual([
      { key: "exclusive:database-schema", task_id: "task_a", fencing_token: 1 },
      { key: "write:packages/runtime/src", task_id: "task_a", fencing_token: 1 },
    ]);
  });

  it("rejects a descendant path conflict all-or-nothing and holds nothing", () => {
    const first = acquireTaskResources(emptyResourceLockTable(), {
      task_id: "task_a",
      fencing_token: 1,
      write_paths: ["packages/runtime/src"],
      exclusive_resources: ["database-schema"],
    });
    expect(() =>
      acquireTaskResources(first, {
        task_id: "task_b",
        fencing_token: 1,
        write_paths: ["packages/runtime/src/scheduling"],
        exclusive_resources: [],
      }),
    ).toThrowError(expect.objectContaining({ kind: "resource_busy" }));
    expect(first.entries).toHaveLength(2);
  });

  it("rejects ancestor, exact and exclusive-resource conflicts with nothing held", () => {
    let table = acquireTaskResources(emptyResourceLockTable(), {
      task_id: "task_a",
      fencing_token: 1,
      write_paths: ["src/api/routes"],
      exclusive_resources: ["database-schema"],
    });
    const attempts: readonly TaskResourceClaim[] = [
      // Ancestor of the held path.
      { task_id: "task_b", fencing_token: 1, write_paths: ["src/api"], exclusive_resources: [] },
      // Exact same path.
      {
        task_id: "task_b",
        fencing_token: 1,
        write_paths: ["src/api/routes"],
        exclusive_resources: [],
      },
      // Same exclusive resource.
      {
        task_id: "task_b",
        fencing_token: 1,
        write_paths: ["src/web"],
        exclusive_resources: ["database-schema"],
      },
      // Conflict appears only on the second key: still nothing is held.
      {
        task_id: "task_b",
        fencing_token: 1,
        write_paths: ["src/web", "src/api/routes/members"],
        exclusive_resources: [],
      },
    ];
    for (const attempt of attempts) {
      expect(() => acquireTaskResources(table, attempt)).toThrowError(ResourceLockError);
      expect(() => acquireTaskResources(table, attempt)).toThrowError(
        expect.objectContaining({ kind: "resource_busy" }),
      );
    }
    expect(table.entries).toHaveLength(2);
    // Disjoint claims still acquire cleanly on the untouched table.
    table = acquireTaskResources(table, {
      task_id: "task_b",
      fencing_token: 1,
      write_paths: ["src/web"],
      exclusive_resources: ["service-port:8080"],
    });
    expect(table.entries).toHaveLength(4);
  });

  it("never conflicts on sibling prefix paths", () => {
    let table = acquireTaskResources(emptyResourceLockTable(), {
      task_id: "task_a",
      fencing_token: 1,
      write_paths: ["src/alpha"],
      exclusive_resources: [],
    });
    table = acquireTaskResources(table, {
      task_id: "task_b",
      fencing_token: 1,
      write_paths: ["src/alphabet"],
      exclusive_resources: [],
    });
    expect(table.entries).toHaveLength(2);
  });

  it("returns a new table and never mutates the previous one", () => {
    const first = acquireTaskResources(emptyResourceLockTable(), {
      task_id: "task_a",
      fencing_token: 1,
      write_paths: ["src/api"],
      exclusive_resources: [],
    });
    const snapshot = canonicalizeJson(first);
    const second = acquireTaskResources(first, {
      task_id: "task_b",
      fencing_token: 1,
      write_paths: ["src/web"],
      exclusive_resources: [],
    });
    expect(canonicalizeJson(first)).toBe(snapshot);
    expect(second.entries).toHaveLength(2);
  });
});

describe("releaseTaskResources", () => {
  function heldTable(): ResourceLockTable {
    let table = acquireTaskResources(emptyResourceLockTable(), {
      task_id: "task_a",
      fencing_token: 3,
      write_paths: ["src/api"],
      exclusive_resources: ["database-schema"],
    });
    table = acquireTaskResources(table, {
      task_id: "task_b",
      fencing_token: 1,
      write_paths: ["src/web"],
      exclusive_resources: [],
    });
    return table;
  }

  it("drops exactly the entries of the released task", () => {
    const released = releaseTaskResources(heldTable(), { task_id: "task_a", fencing_token: 3 });
    expect(released.entries).toEqual([
      { key: "write:src/web", task_id: "task_b", fencing_token: 1 },
    ]);
  });

  it("refuses a stale fencing token and keeps every lock", () => {
    const table = heldTable();
    expect(() => releaseTaskResources(table, { task_id: "task_a", fencing_token: 2 })).toThrowError(
      expect.objectContaining({ kind: "release_mismatch" }),
    );
    expect(table.entries).toHaveLength(3);
  });

  it("refuses a task that holds no lock", () => {
    expect(() =>
      releaseTaskResources(heldTable(), { task_id: "task_ghost", fencing_token: 1 }),
    ).toThrowError(expect.objectContaining({ kind: "release_mismatch" }));
  });
});

describe("rebuildResourceLocks", () => {
  const taskA = makeTask("task_a", ["src/api"], ["database-schema"]);
  const taskB = makeTask("task_b", ["src/web"], []);

  it("rebuilds a byte-equivalent table from the currently granted Leases", () => {
    const chain = grantedChain(["task_a", "task_b"]);
    let live = emptyResourceLockTable();
    for (const [taskId, lease] of chain.latest_by_task) {
      const task = taskId === "task_a" ? taskA : taskB;
      live = acquireTaskResources(live, claim(task, lease.fencing_token));
    }
    const rebuilt = rebuildResourceLocks([taskA, taskB], chain);
    expect(canonicalizeJson(rebuilt)).toBe(canonicalizeJson(live));
  });

  it("drops locks whose Lease reached a terminal state", () => {
    const grantedA = grantTaskLease(grantInput("task_a", "command_grant_task_a"));
    const releasedA = terminateTaskLease(grantedA, {
      state: "released",
      consumed_budget: { steps: 5, tokens: 1_000 },
      command_id: "command_release_task_a",
    });
    const grantedB = grantTaskLease(grantInput("task_b", "command_grant_task_b"));
    const chain = buildTaskLeaseChain([grantedA, releasedA, grantedB]);
    const rebuilt = rebuildResourceLocks([taskA, taskB], chain);
    expect(rebuilt.entries).toEqual([
      { key: "write:src/web", task_id: "task_b", fencing_token: 1 },
    ]);
  });

  it("fails closed when a granted Lease has no Task specification", () => {
    const chain = grantedChain(["task_ghost"]);
    expect(() => rebuildResourceLocks([taskA], chain)).toThrowError(
      expect.objectContaining({ kind: "unknown_task" }),
    );
  });

  it("fails closed when granted Leases conflict at runtime", () => {
    const overlapping = makeTask("task_c", ["src/api/handlers"], []);
    const chain = grantedChain(["task_a", "task_c"]);
    expect(() => rebuildResourceLocks([taskA, overlapping], chain)).toThrowError(
      expect.objectContaining({ kind: "resource_busy" }),
    );
  });
});
