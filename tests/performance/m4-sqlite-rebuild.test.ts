import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { contentDigest } from "../../packages/core/src/index.js";
import { afterEach, describe, expect, it } from "vitest";

import { projectSchedulerState } from "../../packages/runtime/src/scheduling/projection.js";
import { buildSchedulerReadModelBenchmarkFixture } from "../../packages/runtime/src/scheduling/read-model.js";
import { createSqliteSchedulerProjectionStore } from "../../packages/runtime/src/scheduling/sqlite-projection.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function authorityDigest(projection: ReturnType<typeof projectSchedulerState>): string {
  return contentDigest({
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
}

describe("m4 SQLite rebuild release gate", () => {
  it("preserves the authoritative scheduler digest after deleting the live projection", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-m4-rebuild-"));
    roots.push(root);
    const databasePath = join(root, "scheduler.sqlite");
    const fixture = buildSchedulerReadModelBenchmarkFixture({
      task_count: 1_000,
      wave_size: 8,
      integrated_waves: 20,
    });
    const facts = { dag: fixture.dag, ...fixture.facts };
    const original = projectSchedulerState(facts, null);

    const first = createSqliteSchedulerProjectionStore({ path: databasePath });
    await first.replace({
      operation_id: fixture.dag.operation_id,
      observed_at: "2026-08-31T00:10:00.000Z",
      slots: [{ slot_id: "slot_1", state: "idle" }],
      tasks: [],
    });
    first.close();
    rmSync(databasePath, { force: true });

    const rebuilt = createSqliteSchedulerProjectionStore({ path: databasePath });
    await rebuilt.replace({
      operation_id: fixture.dag.operation_id,
      observed_at: "2026-08-31T00:11:00.000Z",
      slots: [{ slot_id: "slot_2", state: "idle" }],
      tasks: [],
    });
    const live = await rebuilt.read(fixture.dag.operation_id);
    rebuilt.close();

    const afterRebuild = projectSchedulerState(facts, live);
    expect(authorityDigest(afterRebuild)).toBe(authorityDigest(original));
    expect(afterRebuild.live_state).toBe("observed");
  });
});
