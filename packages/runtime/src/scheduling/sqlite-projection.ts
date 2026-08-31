import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  AGENT_POOL_SLOT_STATES,
  type AgentPoolSlot,
  type SchedulerLiveSnapshot,
  type SchedulerProjectionStore,
  type SchedulerTaskLiveObservation,
} from "./ports.js";

/**
 * Disposable SQLite live projection of the scheduler (M4 design §4.4, plan
 * Task 8 step 6). Three tables — operation_live, slot_live, task_live — keyed
 * by operation; one operation's snapshot is replaced in a single
 * transaction. The store holds only live decoration (PID, heartbeat, redacted
 * output tail, slot state, digest-based worktree locator): it can never make
 * a Task succeed, approved or integrated, and deleting the database never
 * changes the authoritative projection derived from the Ledger and Git.
 *
 * Rows are validated on read; malformed live rows are discarded without
 * affecting the rest of the snapshot. No API key, environment dump, raw
 * transcript, approval reason, absolute user path or authoritative digest
 * chain is ever written here — the columns below are the complete list.
 */

export const SCHEDULER_PROJECTION_SCHEMA_VERSION = 1;

const DDL = `
PRAGMA user_version = ${String(SCHEDULER_PROJECTION_SCHEMA_VERSION)};
CREATE TABLE IF NOT EXISTS operation_live (
  operation_id TEXT PRIMARY KEY,
  observed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS slot_live (
  operation_id TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  state TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (operation_id, slot_id)
);
CREATE TABLE IF NOT EXISTS task_live (
  operation_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  pid INTEGER,
  heartbeat_at TEXT,
  output_tail TEXT,
  steps INTEGER,
  tokens INTEGER,
  duration_ms INTEGER NOT NULL,
  worktree_id TEXT,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (operation_id, task_id)
);
`;

const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u;

type Row = Record<string, unknown>;

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && ISO_TIMESTAMP_PATTERN.test(value);
}

function isNullableInteger(value: unknown): boolean {
  return value === null || Number.isInteger(value);
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function parseSlotRow(row: Row): AgentPoolSlot | null {
  const state = row.state;
  if (
    typeof row.slot_id !== "string" ||
    typeof state !== "string" ||
    !(AGENT_POOL_SLOT_STATES as readonly string[]).includes(state) ||
    !isNullableString(row.task_id) ||
    !isNullableString(row.run_id) ||
    !isIsoTimestamp(row.observed_at)
  ) {
    return null;
  }
  return {
    slot_id: row.slot_id,
    state: state as AgentPoolSlot["state"],
    ...(row.task_id === null ? {} : { task_id: row.task_id as string }),
    ...(row.run_id === null ? {} : { run_id: row.run_id as string }),
  };
}

function parseTaskRow(row: Row): SchedulerTaskLiveObservation | null {
  if (
    typeof row.task_id !== "string" ||
    !isNullableInteger(row.pid) ||
    !isNullableString(row.heartbeat_at) ||
    !isNullableString(row.output_tail) ||
    !isNullableInteger(row.steps) ||
    !isNullableInteger(row.tokens) ||
    !Number.isInteger(row.duration_ms) ||
    !isNullableString(row.worktree_id) ||
    !isIsoTimestamp(row.observed_at)
  ) {
    return null;
  }
  return {
    task_id: row.task_id,
    pid: row.pid === null ? null : Number(row.pid),
    heartbeat_at: row.heartbeat_at as string | null,
    output_tail: row.output_tail as string | null,
    steps: row.steps === null ? null : Number(row.steps),
    tokens: row.tokens === null ? null : Number(row.tokens),
    duration_ms: Number(row.duration_ms),
    worktree_id: row.worktree_id as string | null,
  };
}

export interface SqliteSchedulerProjectionStore extends SchedulerProjectionStore {
  /** Test/inspection escape hatch; production code must use the store methods. */
  unsafeDatabase(): DatabaseSync;
  close(): void;
}

export function createSqliteSchedulerProjectionStore(options: {
  readonly path: string;
}): SqliteSchedulerProjectionStore {
  if (options.path !== ":memory:") {
    mkdirSync(dirname(options.path), { recursive: true });
  }
  const database = new DatabaseSync(options.path);
  database.exec(DDL);

  return {
    unsafeDatabase(): DatabaseSync {
      return database;
    },

    close(): void {
      database.close();
    },

    replace(snapshot: SchedulerLiveSnapshot): Promise<void> {
      database.exec("BEGIN");
      try {
        database.prepare("DELETE FROM slot_live WHERE operation_id = ?").run(snapshot.operation_id);
        database.prepare("DELETE FROM task_live WHERE operation_id = ?").run(snapshot.operation_id);
        database
          .prepare("DELETE FROM operation_live WHERE operation_id = ?")
          .run(snapshot.operation_id);
        database
          .prepare("INSERT INTO operation_live (operation_id, observed_at) VALUES (?, ?)")
          .run(snapshot.operation_id, snapshot.observed_at);
        const insertSlot = database.prepare(
          "INSERT INTO slot_live (operation_id, slot_id, state, task_id, run_id, observed_at) VALUES (?, ?, ?, ?, ?, ?)",
        );
        for (const slot of snapshot.slots) {
          insertSlot.run(
            snapshot.operation_id,
            slot.slot_id,
            slot.state,
            slot.task_id ?? null,
            slot.run_id ?? null,
            snapshot.observed_at,
          );
        }
        const insertTask = database.prepare(
          "INSERT INTO task_live (operation_id, task_id, pid, heartbeat_at, output_tail, steps, tokens, duration_ms, worktree_id, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        for (const task of snapshot.tasks) {
          insertTask.run(
            snapshot.operation_id,
            task.task_id,
            task.pid,
            task.heartbeat_at,
            task.output_tail,
            task.steps,
            task.tokens,
            task.duration_ms,
            task.worktree_id,
            snapshot.observed_at,
          );
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return Promise.resolve();
    },

    read(operationId: string): Promise<SchedulerLiveSnapshot | null> {
      const operation = database
        .prepare("SELECT observed_at FROM operation_live WHERE operation_id = ?")
        .get(operationId) as Row | undefined;
      if (operation === undefined || !isIsoTimestamp(operation.observed_at)) {
        return Promise.resolve(null);
      }
      const slotRows = database
        .prepare(
          "SELECT slot_id, state, task_id, run_id, observed_at FROM slot_live WHERE operation_id = ? ORDER BY slot_id",
        )
        .all(operationId) as Row[];
      const taskRows = database
        .prepare(
          "SELECT task_id, pid, heartbeat_at, output_tail, steps, tokens, duration_ms, worktree_id, observed_at FROM task_live WHERE operation_id = ? ORDER BY task_id",
        )
        .all(operationId) as Row[];
      // Malformed live rows are discarded; they never affect authority.
      const slots = slotRows
        .map(parseSlotRow)
        .filter((slot): slot is AgentPoolSlot => slot !== null);
      const tasks = taskRows
        .map(parseTaskRow)
        .filter((task): task is SchedulerTaskLiveObservation => task !== null);
      return Promise.resolve({
        operation_id: operationId,
        observed_at: operation.observed_at,
        slots,
        tasks,
      });
    },

    clear(operationId: string): Promise<void> {
      database.exec("BEGIN");
      try {
        database.prepare("DELETE FROM slot_live WHERE operation_id = ?").run(operationId);
        database.prepare("DELETE FROM task_live WHERE operation_id = ?").run(operationId);
        database.prepare("DELETE FROM operation_live WHERE operation_id = ?").run(operationId);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return Promise.resolve();
    },
  };
}

/**
 * In-memory store with the identical contract, for tests and for callers
 * that keep live state purely ephemeral.
 */
export function createInMemorySchedulerProjectionStore(): SchedulerProjectionStore {
  const snapshots = new Map<string, SchedulerLiveSnapshot>();
  return {
    replace(snapshot: SchedulerLiveSnapshot): Promise<void> {
      snapshots.set(snapshot.operation_id, snapshot);
      return Promise.resolve();
    },
    read(operationId: string): Promise<SchedulerLiveSnapshot | null> {
      return Promise.resolve(snapshots.get(operationId) ?? null);
    },
    clear(operationId: string): Promise<void> {
      snapshots.delete(operationId);
      return Promise.resolve();
    },
  };
}
