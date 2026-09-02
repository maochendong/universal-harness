import { rmSync } from "node:fs";

import { contentDigest } from "../../packages/core/src/index.js";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupDirectories } from "../../packages/runtime/test/bootstrap/helpers.js";
import { createM4E2eFixture } from "../e2e/m4-scheduler-fixture.js";

afterEach(cleanupDirectories);

type SchedulerModel = Awaited<
  ReturnType<Awaited<ReturnType<typeof createM4E2eFixture>>["host"]["readSchedulerModel"]>
>;

/** Canonical durable read model: only the SQLite/live-spool fields are removed. */
function durableReadModelDigest(model: SchedulerModel): string {
  const durable = structuredClone(model) as unknown as Record<string, unknown>;
  delete durable.digest;
  delete durable.slots;
  const operation = durable.operation as Record<string, unknown>;
  delete operation.live_state;
  return contentDigest(durable);
}

describe("m4 SQLite rebuild release gate", () => {
  it("restarts the production Host from real Ledger facts after deleting SQLite", async () => {
    const fixture = await createM4E2eFixture({
      profileId: "governed",
      sqliteProjection: true,
    });
    const outcome = await fixture.host.parallelExecution.port.run({
      operation_id: fixture.operationId,
      iteration_id: "iteration_m4_release_e2e",
      capability_plan_digest: fixture.capabilityPlan.record_digest,
      expected_plan_digest: fixture.planDigest,
      driver_lock: fixture.host.parallelExecution.driverLock(),
    });
    expect(outcome.status).toBe("completed");

    const observed = await fixture.host.readSchedulerModel(fixture.operationId);
    expect(observed.operation.live_state).toBe("observed");
    expect(fixture.projectionStorePath).toMatch(/scheduler-projection-real\.sqlite$/u);
    rmSync(fixture.projectionStorePath, { force: true });

    const restarted = fixture.createHost();
    const rebuilt = await restarted.readSchedulerModel(fixture.operationId);
    expect(rebuilt.operation.live_state).toBe("rebuilding");
    expect(rebuilt.slots).toEqual([]);
    expect(rebuilt.operation).toMatchObject({
      operation_id: observed.operation.operation_id,
      iteration_id: observed.operation.iteration_id,
      status: observed.operation.status,
    });
    expect(rebuilt.presentation_map).toEqual(observed.presentation_map);
    expect(durableReadModelDigest(rebuilt)).toBe(durableReadModelDigest(observed));
    expect(rebuilt.tasks.every((task) => task.status === "integrated")).toBe(true);
  }, 120_000);
});
