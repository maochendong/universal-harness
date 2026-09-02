import { describe, expect, it } from "vitest";

import {
  PROTOCOL_1_2_VERSION,
  assertProtocolReaderCanProject,
  buildOperationDag,
  compileCapabilityPlan,
  createProfileDecisionRecord,
  createProjectProfileRecord,
} from "../../packages/core/src/index.js";
import { capabilityPlanActivatesParallel } from "../../packages/runtime/src/orchestration/scheduler-runtime.js";

const DIGEST = "a".repeat(64);
const NOW = "2026-09-02T00:00:00.000Z";

function liteCapabilityPlan() {
  const projectProfile = createProjectProfileRecord({
    project_id: "project_m4_compat",
    revision: 1,
    profile_id: "lite",
    policy_digest: DIGEST,
    actor: "human:compat",
    effective_from: NOW,
  });
  return compileCapabilityPlan({
    operation_id: "operation_m4_compat",
    stage: "final",
    protocol_version: "1.3.0",
    project_profile: projectProfile,
    profile_decision: createProfileDecisionRecord({
      decision_kind: "project_profile_change",
      project_id: "project_m4_compat",
      actor: "human:compat",
      idempotency_key: "profile-decision:m4-compat",
      current_profile_id: "lite",
      decided_profile_id: "lite",
      policy_digest: DIGEST,
      decided_at: NOW,
    }),
    requirement_digest: "b".repeat(64),
    risk_digest: "c".repeat(64),
    policy_digest: DIGEST,
    baseline_digest: "d".repeat(64),
    providers: ["isolated_workspace_provider", "structured_gate_provider"],
    model_providers: [],
  });
}

describe("M4 sequential compatibility", () => {
  it("keeps Lite on the legacy execute path without M4 authority or events", () => {
    const plan = liteCapabilityPlan();
    expect(plan.protocol_version).toBe("1.1.0");
    expect(capabilityPlanActivatesParallel(plan)).toBe(false);
    expect(
      plan.capabilities.some((entry) => entry.capability_id === "parallel_task_execution"),
    ).toBe(false);
    const execute = plan.operation_dag.nodes.find((node) => node.node_id === "execute");
    expect(execute?.subgraph).toBeUndefined();
    expect(execute?.produces).not.toContain("wave_integration");
    expect(JSON.stringify(plan)).not.toMatch(
      /TaskLeaseGranted|WaveIntegrated|task_lease|wave_integration/u,
    );
  });

  it("keeps a Protocol 1.2 operation DAG byte-compatible and sequential", () => {
    const dag = buildOperationDag(new Set(), PROTOCOL_1_2_VERSION);
    const execute = dag.find((node) => node.node_id === "execute");
    expect(execute?.subgraph).toBeUndefined();
    expect(dag.flatMap((node) => [...node.consumes, ...node.produces])).not.toContain(
      "wave_integration",
    );
    expect(() =>
      assertProtocolReaderCanProject({
        readerVersion: PROTOCOL_1_2_VERSION,
        recordVersion: PROTOCOL_1_2_VERSION,
        authoritative: true,
      }),
    ).not.toThrow();
  });
});
