import { describe, expect, it } from "vitest";

import { runThreeProfileLoop } from "../../scripts/dogfood-three-profile-loop.mjs";

const KERNEL_NODES = [
  "capture",
  "capability_decision",
  "plan",
  "context",
  "execute",
  "verify",
  "snapshot",
] as const;

describe("packaged CLI three-profile vertical loop", { timeout: 300_000 }, () => {
  it("completes Lite, Standard and Governed with profile-appropriate evidence", async () => {
    const report = await runThreeProfileLoop({ providerMode: "fake" });

    expect(report.status).toBe("passed");
    expect(report.profiles.map((entry) => entry.profile)).toEqual(["lite", "standard", "governed"]);
    for (const entry of report.profiles) {
      expect(entry.terminal_status).toBe("completed");
      expect(entry.snapshot_id).toMatch(/^snapshot_/u);
      expect(entry.snapshot_status).toBe("completed");
      expect(entry.explicit_execution_runs).toBeGreaterThan(0);
      expect(entry.gate_status).toBe("passed");
      expect(entry.worktree_clean).toBe(true);
      expect(entry.operation_dag_nodes).toEqual(expect.arrayContaining(KERNEL_NODES));
      expect(entry.approvals.every((approval) => approval.policy_permitted)).toBe(true);
    }

    const lite = report.profiles[0]!;
    expect(lite.model_invocations).toBe(0);
    expect(lite.evaluation_status).toBe("not_enabled_by_profile");
    expect(lite.tdd_status).toBe("not_enabled_by_profile");

    const standard = report.profiles[1]!;
    expect(standard.operation_dag_nodes).toEqual(
      expect.arrayContaining(["impact", "design", "evaluate"]),
    );
    expect(standard.model_invocations).toBeGreaterThan(0);
    expect(standard.evaluation_status).toBe("passed");
    expect(["tdd_proven", "controlled_not_applicable"]).toContain(standard.tdd_status);

    const governed = report.profiles[2]!;
    expect(governed.operation_dag_nodes).toEqual(
      expect.arrayContaining(["impact", "design", "evaluate", "audit"]),
    );
    expect(governed.execute_subgraph).toBe("strict_tdd");
    expect(governed.model_invocations).toBeGreaterThan(0);
    expect(governed.evaluation_status).toBe("passed");
    expect(["tdd_proven", "controlled_not_applicable"]).toContain(governed.tdd_status);
  });
});
