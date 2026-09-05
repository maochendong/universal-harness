import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { cleanupDirectories } from "../../packages/runtime/test/bootstrap/helpers.js";
import {
  createLedgerSchedulerAuthority,
  createM4E2eFixture,
  readRefFile,
} from "./m4-scheduler-fixture.js";

describe("M4 real-Git local multi-agent release proof", () => {
  it.each(["standard", "governed"] as const)(
    "runs four isolated %s-profile tasks through scheduling and the generic tail",
    async (profileId) => {
      const fixture = await createM4E2eFixture({ profileId });
      try {
        const outcome = await fixture.host.parallelExecution.port.run({
          operation_id: fixture.operationId,
          iteration_id: "iteration_m4_release_e2e",
          capability_plan_digest: fixture.capabilityPlan.record_digest,
          expected_plan_digest: fixture.planDigest,
          driver_lock: fixture.host.parallelExecution.driverLock(),
        });

        expect(outcome.status).toBe("completed");
        expect(outcome.wave_integration_digests).toHaveLength(3);

        const model = await fixture.host.readSchedulerModel(fixture.operationId);
        expect(model.plan?.waves).toEqual([
          { wave_index: 0, task_ids: ["task_api", "task_ui"] },
          { wave_index: 1, task_ids: ["task_contract"] },
          { wave_index: 2, task_ids: ["task_release"] },
        ]);
        expect(model.tasks.map((task) => [task.task_id, task.status])).toEqual([
          ["task_api", "integrated"],
          ["task_contract", "integrated"],
          ["task_release", "integrated"],
          ["task_ui", "integrated"],
        ]);

        const api = fixture.intervals.find((entry) => entry.task_id === "task_api");
        const ui = fixture.intervals.find((entry) => entry.task_id === "task_ui");
        expect(api).toBeDefined();
        expect(ui).toBeDefined();
        expect(api?.slot_id).not.toBe(ui?.slot_id);
        expect(Math.max(api?.start_ms ?? 0, ui?.start_ms ?? 0)).toBeLessThanOrEqual(
          Math.min(api?.end_ms ?? 0, ui?.end_ms ?? 0),
        );

        const facts = await createLedgerSchedulerAuthority({ deps: fixture.deps }).readFacts(
          fixture.operationId,
        );
        const grants = facts.leases.filter((lease) => lease.state === "granted");
        expect(grants).toHaveLength(4);
        expect(new Set(grants.map((lease) => lease.lease_id)).size).toBe(4);
        expect(new Set(grants.map((lease) => lease.run_id)).size).toBe(4);
        expect(grants.reduce((sum, lease) => sum + lease.reserved_budget.steps, 0)).toBe(40);
        expect(grants.reduce((sum, lease) => sum + lease.reserved_budget.tokens, 0)).toBe(4_000);
        expect(facts.wave_integrations).toHaveLength(3);
        expect(facts.gate_evidence).toHaveLength(11);
        expect(
          facts.gate_evidence.every((evidence) => {
            const gate = evidence.extensions?.["harness.gate"] as
              { readonly passed?: boolean } | undefined;
            return (
              gate?.passed === true && evidence.extensions?.["harness.scheduling"] !== undefined
            );
          }),
        ).toBe(true);
        for (const taskId of ["task_api", "task_ui", "task_contract", "task_release"]) {
          const layers = facts.gate_evidence
            .filter((evidence) => evidence.subject_id === taskId)
            .map(
              (evidence) =>
                (evidence.extensions?.["harness.scheduling"] as { layer?: string } | undefined)
                  ?.layer,
            )
            .sort();
          expect(layers).toEqual(["candidate", "task"]);
        }
        expect(fixture.gateWorkspaceRoots).toHaveLength(11);
        expect(fixture.gateWorkspaceRoots.every((root) => root !== fixture.projectRoot)).toBe(true);
        expect(new Set(fixture.gateWorkspaceRoots).size).toBeGreaterThanOrEqual(7);

        const terminalRuns = facts.runs.filter((run) => run.record_kind === "run_terminated");
        expect(terminalRuns).toHaveLength(4);
        expect(JSON.stringify(terminalRuns)).not.toContain("adapter-private-transcript");
        expect(JSON.stringify(terminalRuns)).not.toContain("file:///private-agent-output");

        for (const taskId of ["task_api", "task_ui", "task_contract", "task_release"]) {
          expect(
            readRefFile(fixture.projectRoot, fixture.operationRef, `src/${taskId}/outcome.ts`),
          ).toContain(taskId);
        }

        const tail = await fixture.runGenericTail();
        expect(tail.status).toBe("completed");
        if (tail.status === "completed") {
          expect(tail.snapshotId).toMatch(/^snapshot_/u);
          expect(tail.sourceCommit).toBe(
            execFileSync("git", ["rev-parse", fixture.operationRef], {
              cwd: fixture.projectRoot,
              encoding: "utf8",
            }).trim(),
          );
        }
        expect(existsSync(join(fixture.projectRoot, "src/task_api/outcome.ts"))).toBe(false);
      } finally {
        fixture.closeHosts();
        cleanupDirectories();
      }
    },
    120_000,
  );
});
