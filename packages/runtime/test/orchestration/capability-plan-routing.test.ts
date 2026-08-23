import { describe, expect, it } from "vitest";

import {
  buildOperationDag,
  contentDigest,
  createProfileDecisionRecord,
  createProjectProfileRecord,
  compileCapabilityPlan,
  type CapabilityId,
  type CapabilityPlanRecord,
} from "@universal-harness-internal/core";

import {
  InMemoryDagCheckpointStore,
  createCapabilityDagRunnerRegistry,
  createCapabilityDagRuntime,
  type DagNodeRunner,
} from "../../src/index.js";

const OPERATION_ID = "operation_capability-routing";

function litePlan(): CapabilityPlanRecord {
  const profile = createProjectProfileRecord({
    project_id: "project_capability-routing",
    revision: 1,
    profile_id: "lite",
    policy_digest: "a".repeat(64),
    actor: "human:test",
    effective_from: "2026-08-23T00:00:00.000Z",
  });
  const decision = createProfileDecisionRecord({
    decision_kind: "project_profile_change",
    project_id: "project_capability-routing",
    actor: "human:test",
    idempotency_key: "profile-decision:capability-routing:1",
    current_profile_id: "lite",
    decided_profile_id: "lite",
    policy_digest: "a".repeat(64),
    decided_at: "2026-08-23T00:00:00.000Z",
  });
  return compileCapabilityPlan({
    operation_id: OPERATION_ID,
    stage: "final",
    project_profile: profile,
    profile_decision: decision,
    requirement_digest: "b".repeat(64),
    risk_digest: "c".repeat(64),
    policy_digest: "a".repeat(64),
    baseline_digest: "d".repeat(64),
  });
}

function planWithCapabilities(ids: readonly CapabilityId[]): CapabilityPlanRecord {
  const base = litePlan();
  const operation_dag = { nodes: buildOperationDag(new Set(ids)) };
  return {
    ...base,
    operation_dag,
    record_digest: contentDigest({ base: base.record_digest, operation_dag }),
  } as CapabilityPlanRecord;
}

function runners(calls: string[]) {
  const runner: DagNodeRunner = (context) => {
    calls.push(context.node.node_id);
    return {
      status: "committed",
      produces: context.node.produces.map((kind) => ({
        kind,
        digest: contentDigest({ node: context.node.node_id, kind }),
      })),
    };
  };
  return createCapabilityDagRunnerRegistry({
    kernel: Object.fromEntries(
      ["capture", "capability_decision", "plan", "context", "execute", "verify", "snapshot"].map(
        (node) => [node, runner],
      ),
    ),
    modules: {
      impact_analysis: runner,
      design_governance: runner,
      independent_evaluation: runner,
      strict_tdd: runner,
      advanced_audit: runner,
    },
  });
}

describe("CapabilityPlan production routing", () => {
  it("executes exactly the accepted operation DAG and gives inactive nodes zero calls", async () => {
    const calls: string[] = [];
    const runtime = createCapabilityDagRuntime({
      store: new InMemoryDagCheckpointStore(),
      runners: runners(calls),
    });
    const plan = planWithCapabilities(["impact_analysis", "design_governance"]);

    expect(await runtime.run({ operation_id: OPERATION_ID, plan })).toMatchObject({
      status: "completed",
    });
    expect(calls).toEqual(plan.operation_dag.nodes.map((node) => node.node_id));
    expect(calls).not.toContain("evaluate");
    expect(calls).not.toContain("audit");
  });

  it("blocks a missing plan and stops a provisional plan before Plan", async () => {
    const calls: string[] = [];
    const runtime = createCapabilityDagRuntime({
      store: new InMemoryDagCheckpointStore(),
      runners: runners(calls),
    });
    expect(await runtime.run({ operation_id: OPERATION_ID })).toMatchObject({
      status: "blocked",
      reason: "capability_plan_required",
    });
    const provisional = { ...planWithCapabilities([]), compilation_stage: "provisional" };
    expect(
      await runtime.run({ operation_id: OPERATION_ID, plan: provisional as CapabilityPlanRecord }),
    ).toMatchObject({ status: "blocked", node_id: "plan", reason: "capability_plan_not_final" });
    expect(calls).toEqual(["capture", "capability_decision"]);
  });

  it("invalidates checkpoints when an unrelated plan digest replaces the accepted plan", async () => {
    const store = new InMemoryDagCheckpointStore();
    const firstCalls: string[] = [];
    const first = litePlan();
    await createCapabilityDagRuntime({ store, runners: runners(firstCalls) }).run({
      operation_id: OPERATION_ID,
      plan: first,
    });
    const replacement = {
      ...first,
      record_digest: "f".repeat(64),
      supersedes_digest: undefined,
    } as CapabilityPlanRecord;
    const replacementCalls: string[] = [];
    await createCapabilityDagRuntime({ store, runners: runners(replacementCalls) }).run({
      operation_id: OPERATION_ID,
      plan: replacement,
    });
    expect(replacementCalls).toEqual(replacement.operation_dag.nodes.map((node) => node.node_id));
  });
});
