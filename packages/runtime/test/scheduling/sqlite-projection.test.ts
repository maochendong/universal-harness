import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { projectSchedulerState } from "../../src/scheduling/projection.js";
import type { SchedulerLiveSnapshot } from "../../src/scheduling/ports.js";
import {
  createSqliteSchedulerProjectionStore,
  SCHEDULER_PROJECTION_SCHEMA_VERSION,
} from "../../src/scheduling/sqlite-projection.js";
import {
  closedLease,
  fixtureDag,
  fixtureTask,
  gateEvidence,
  grantedLease,
  runStarted,
  runTerminated,
} from "./scheduler-facts.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-scheduler-projection-"));
  roots.push(root);
  return join(root, "scheduler-live.sqlite");
}

function liveSnapshot(overrides: Partial<SchedulerLiveSnapshot> = {}): SchedulerLiveSnapshot {
  return {
    operation_id: "operation_1",
    observed_at: "2026-08-31T00:10:00.000Z",
    slots: [
      { slot_id: "slot_1", state: "idle" },
      { slot_id: "slot_2", state: "running", task_id: "task_a", run_id: "run_a" },
    ],
    tasks: [
      {
        task_id: "task_a",
        pid: 4242,
        heartbeat_at: "2026-08-31T00:09:30.000Z",
        output_tail: "compiling <redacted-path>",
        steps: null,
        tokens: null,
        duration_ms: 500,
        worktree_id: "worktree_0123456789ab",
      },
    ],
    ...overrides,
  };
}

describe("sqlite scheduler projection store", () => {
  it("replaces and reads back a full snapshot", async () => {
    const store = createSqliteSchedulerProjectionStore({ path: databasePath() });
    const snapshot = liveSnapshot();

    await store.replace(snapshot);
    expect(await store.read("operation_1")).toEqual(snapshot);

    store.close();
  });

  it("returns null for an unknown operation", async () => {
    const store = createSqliteSchedulerProjectionStore({ path: databasePath() });
    expect(await store.read("operation_missing")).toBeNull();
    store.close();
  });

  it("clears one operation without touching another", async () => {
    const store = createSqliteSchedulerProjectionStore({ path: databasePath() });
    await store.replace(liveSnapshot());
    await store.replace(liveSnapshot({ operation_id: "operation_2" }));

    await store.clear("operation_1");

    expect(await store.read("operation_1")).toBeNull();
    expect((await store.read("operation_2"))?.operation_id).toBe("operation_2");
    store.close();
  });

  it("replaces the previous snapshot of the same operation in one transaction", async () => {
    const store = createSqliteSchedulerProjectionStore({ path: databasePath() });
    await store.replace(liveSnapshot());
    const next = liveSnapshot({
      observed_at: "2026-08-31T00:11:00.000Z",
      slots: [{ slot_id: "slot_1", state: "idle" }],
      tasks: [],
    });

    await store.replace(next);
    expect(await store.read("operation_1")).toEqual(next);
    store.close();
  });

  it("discards malformed live rows on read without failing the snapshot", async () => {
    const store = createSqliteSchedulerProjectionStore({ path: databasePath() });
    await store.replace(liveSnapshot());
    const database = store.unsafeDatabase();
    database
      .prepare(
        "INSERT INTO slot_live (operation_id, slot_id, state, task_id, run_id, observed_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("operation_1", "slot_9", "bogus-state", null, null, "not-a-timestamp");
    database
      .prepare(
        "INSERT INTO task_live (operation_id, task_id, pid, heartbeat_at, output_tail, steps, tokens, duration_ms, worktree_id, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "operation_1",
        "task_broken",
        "not-a-pid",
        null,
        null,
        null,
        null,
        "not-a-duration",
        null,
        "x",
      );

    const snapshot = await store.read("operation_1");
    expect(snapshot?.slots.map((slot) => slot.slot_id)).toEqual(["slot_1", "slot_2"]);
    expect(snapshot?.tasks.map((task) => task.task_id)).toEqual(["task_a"]);
    store.close();
  });

  it("stores exactly the three live tables and no authority content", async () => {
    const path = databasePath();
    const store = createSqliteSchedulerProjectionStore({ path });
    const home = process.env.HOME ?? "/nonexistent-home";
    await store.replace(
      liveSnapshot({
        tasks: [
          {
            task_id: "task_a",
            pid: null,
            heartbeat_at: "2026-08-31T00:09:30.000Z",
            output_tail: "wrote <redacted-path> and <redacted-path>",
            steps: null,
            tokens: null,
            duration_ms: 12,
            worktree_id: "worktree_0123456789ab",
          },
        ],
      }),
    );
    store.close();

    const tables = tableNames(path);
    expect(tables).toEqual(["operation_live", "slot_live", "task_live"]);

    // Byte-level proof: no API key, environment dump, raw transcript marker,
    // approval reason, user home path or authoritative digest chain is stored.
    const bytes = readFileSync(path).toString("latin1");
    expect(bytes).not.toContain("DEEPSEEK_API_KEY");
    expect(bytes).not.toContain("record_digest");
    expect(bytes).not.toContain("previous_lease_record_digest");
    expect(bytes).not.toContain("dispatch requires approval");
    expect(bytes).not.toContain("stdout");
    if (home !== "/") expect(bytes).not.toContain(home);
  });

  it("rebuilds after deletion with identical authoritative projection (AC-18)", async () => {
    const granted = grantedLease("task_a", "run_a");
    const released = closedLease(granted, "released");
    const authorityFacts = {
      dag: fixtureDag([fixtureTask("task_a")]),
      leases: [granted, released],
      runs: [
        runStarted("task_a", "run_a"),
        runTerminated("task_a", "run_a", "handoff", "completion"),
      ],
      gate_evidence: [gateEvidence("task_a")],
      approvals: [],
      findings: [],
      wave_integrations: [],
    };

    const path = databasePath();
    const first = createSqliteSchedulerProjectionStore({ path });
    await first.replace(liveSnapshot());
    first.close();
    rmSync(path, { force: true });

    const rebuilt = createSqliteSchedulerProjectionStore({ path });
    await rebuilt.replace(liveSnapshot({ observed_at: "2026-08-31T00:12:00.000Z" }));
    const rebuiltLive = await rebuilt.read("operation_1");
    rebuilt.close();

    // Deleting the live store never changes the authoritative projection;
    // only the authoritative fields are compared (live decoration differs).
    const authoritativeOnly = (projection: ReturnType<typeof projectSchedulerState>): unknown => ({
      operation_id: projection.operation_id,
      plan_digest: projection.plan_digest,
      baseline_commit: projection.baseline_commit,
      tasks: projection.tasks.map((task) => ({
        task_id: task.task_id,
        wave_index: task.wave_index,
        status: task.status,
        provisional: task.provisional,
      })),
    });
    expect(authoritativeOnly(projectSchedulerState(authorityFacts, null))).toEqual(
      authoritativeOnly(projectSchedulerState(authorityFacts, rebuiltLive)),
    );
    // And the surviving difference is decoration only.
    const withLive = projectSchedulerState(authorityFacts, rebuiltLive);
    expect(withLive.live_state).toBe("observed");
    expect(withLive.tasks[0]?.status).toBe("candidate_validated");
  });

  it("keeps a stable schema version across rebuilds", () => {
    expect(SCHEDULER_PROJECTION_SCHEMA_VERSION).toBe(1);
  });
});

function tableNames(path: string): string[] {
  const store = createSqliteSchedulerProjectionStore({ path });
  const rows = store
    .unsafeDatabase()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  store.close();
  return rows.map((row) => row.name);
}
