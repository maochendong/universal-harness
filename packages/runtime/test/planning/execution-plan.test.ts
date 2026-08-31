import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateSchema, type NodeRecord } from "@universal-harness-internal/core";
import { ImpactError } from "@universal-harness-internal/graph";

import {
  generateExecutionPlan,
  readExecutionPlanContent,
  type PlanGenerationInput,
} from "../../src/planning/execution-plan.js";
import { taskSemanticDigest } from "../../src/planning/task.js";
import { PlanningError } from "../../src/planning/validator.js";
import { compileParallelWaves, type ParallelWave } from "../../src/planning/waves.js";

import {
  PLAN_CONSTRAINTS,
  PLAN_CONTEXT,
  SHARED_CONTEXT,
  approvedImpactSet,
  entryPath,
  mustChangeNodeIds,
} from "./fixtures.js";

const goldenDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../tests/golden/plans",
);

function readGolden(name: string): unknown {
  return JSON.parse(readFileSync(join(goldenDirectory, name), "utf8")) as unknown;
}

function allMustChangePaths(impactSet: NodeRecord): readonly (readonly string[])[] {
  return mustChangeNodeIds(impactSet).map((nodeId) => entryPath(impactSet, nodeId));
}

function taskSpec(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    impact_paths: [],
    capabilities: ["fs.read", "fs.write"],
    tools: ["tool:fs"],
    dependencies: [],
    risk: "medium",
    budget: { steps: 8, tokens: 4000 },
    acceptance: [{ description: "the output verifies", verification: "gate:test" }],
    assertions: [
      {
        assertion_id: "assertion_output",
        test_ids: ["test_01"],
        required_gate_ids: ["gate:test"],
        evidence_requirements: ["test_result"],
      },
    ],
    required_gates: ["gate:test"],
    ...overrides,
  };
}

function scenarioInput(name: string, impactSet: NodeRecord): PlanGenerationInput {
  const base = {
    executionKind: "agent" as const,
    hasExistingGraph: true,
    shared: SHARED_CONTEXT,
    constraints: PLAN_CONSTRAINTS,
  };
  if (name === "direct") {
    return {
      ...base,
      executionKind: "workflow",
      intentShape: "structured",
      deterministicWork: true,
      proposal: [
        taskSpec({
          id: "task_apply",
          objective: "apply the approved requirement change deterministically",
          impact_paths: allMustChangePaths(impactSet),
          expected_outputs: ["requirement_01", "code_01", "test_01"],
          capabilities: ["fs.read", "fs.write", "test.run"],
          tools: ["tool:fs", "tool:test-runner"],
          assertions: undefined,
        }),
      ],
    };
  }
  if (name === "single-loop") {
    return {
      ...base,
      intentShape: "structured",
      deterministicWork: false,
      proposal: [
        taskSpec({
          id: "task_deliver",
          objective: "deliver the health endpoint end to end",
          impact_paths: allMustChangePaths(impactSet),
          expected_outputs: ["requirement_01", "decision_01", "code_01", "test_01"],
        }),
      ],
    };
  }
  if (name === "dag") {
    return {
      ...base,
      intentShape: "structured",
      deterministicWork: false,
      proposal: [
        taskSpec({
          id: "task_implement",
          objective: "implement the component and code change",
          impact_paths: [
            entryPath(impactSet, "decision_01"),
            entryPath(impactSet, "component_01"),
            entryPath(impactSet, "code_01"),
          ],
          expected_outputs: ["decision_01", "component_01", "code_01"],
          dependencies: ["task_spec"],
          required_gates: ["gate:build", "gate:test"],
        }),
        taskSpec({
          id: "task_spec",
          objective: "revise the requirement and its acceptance test",
          impact_paths: [entryPath(impactSet, "requirement_01"), entryPath(impactSet, "test_01")],
          expected_outputs: ["requirement_01", "test_01"],
          capabilities: ["fs.read"],
        }),
      ],
    };
  }
  throw new Error(`unknown scenario ${name}`);
}

export const PLAN_SCENARIOS = ["direct", "single-loop", "dag"] as const;

export function summarizeScenario(name: string): Record<string, unknown> {
  const { impactSet, approvedDigest } = approvedImpactSet();
  const records = generateExecutionPlan(
    impactSet,
    approvedDigest,
    scenarioInput(name, impactSet),
    PLAN_CONTEXT,
  );
  return {
    scenario: name,
    plan: { id: records.plan.id, status: records.plan.status, digest: records.plan.digest },
    content: readExecutionPlanContent(records.plan),
    tasks: records.tasks.map((task) => ({ id: task.id, digest: task.digest })),
    edges: records.edges.map((edge) => ({
      id: edge.id,
      type: edge.type,
      source_id: edge.source_id,
      target_id: edge.target_id,
    })),
  };
}

describe("generateExecutionPlan", () => {
  it.each(PLAN_SCENARIOS)("pins the %s plan golden", (name) => {
    expect(summarizeScenario(name)).toEqual(readGolden(`${name}.json`));
  });

  it("produces schema-valid plan, task and edge records", () => {
    for (const name of PLAN_SCENARIOS) {
      const { impactSet, approvedDigest } = approvedImpactSet();
      const records = generateExecutionPlan(
        impactSet,
        approvedDigest,
        scenarioInput(name, impactSet),
        PLAN_CONTEXT,
      );
      for (const node of [records.plan, ...records.tasks]) {
        const result = validateSchema("node", node);
        expect(result.valid, `${name}: ${JSON.stringify(result.errors)}`).toBe(true);
      }
      for (const edge of records.edges) {
        const result = validateSchema("edge", edge);
        expect(result.valid, `${name}: ${JSON.stringify(result.errors)}`).toBe(true);
      }
    }
  });

  it("is deterministic regardless of proposal ordering", () => {
    const { impactSet, approvedDigest } = approvedImpactSet();
    const input = scenarioInput("dag", impactSet);
    const baseline = generateExecutionPlan(impactSet, approvedDigest, input, PLAN_CONTEXT);
    const reversed = generateExecutionPlan(
      impactSet,
      approvedDigest,
      { ...input, proposal: [...input.proposal].reverse() },
      PLAN_CONTEXT,
    );
    expect(reversed.plan.id).toBe(baseline.plan.id);
    expect(reversed.plan.digest).toBe(baseline.plan.digest);
  });

  it("refuses to plan from an unapproved impact set", () => {
    const { proposed, approvedDigest } = approvedImpactSet();
    expect(() =>
      generateExecutionPlan(
        proposed,
        approvedDigest,
        scenarioInput("direct", proposed),
        PLAN_CONTEXT,
      ),
    ).toThrow(ImpactError);
  });

  it("refuses to plan when the approved digest no longer matches", () => {
    const { impactSet } = approvedImpactSet();
    expect(() =>
      generateExecutionPlan(
        impactSet,
        "e".repeat(64),
        scenarioInput("direct", impactSet),
        PLAN_CONTEXT,
      ),
    ).toThrow(ImpactError);
  });

  it("rejects proposals with embedded commands before planning", () => {
    const { impactSet, approvedDigest } = approvedImpactSet();
    const input = scenarioInput("direct", impactSet);
    const poisoned = [
      { ...(input.proposal[0] as Record<string, unknown>), shell_command: "npm publish" },
    ];
    expect(() =>
      generateExecutionPlan(
        impactSet,
        approvedDigest,
        { ...input, proposal: poisoned },
        PLAN_CONTEXT,
      ),
    ).toThrow(PlanningError);
  });

  it("refuses agent execution without atomic assertions covering every accepted test", () => {
    const { impactSet, approvedDigest } = approvedImpactSet();
    const input = scenarioInput("single-loop", impactSet);
    const withoutAssertions = input.proposal.map((task) => {
      const copy = { ...(task as Record<string, unknown>) };
      delete copy.assertions;
      return copy;
    });
    expect(() =>
      generateExecutionPlan(
        impactSet,
        approvedDigest,
        { ...input, proposal: withoutAssertions },
        PLAN_CONTEXT,
      ),
    ).toThrowError(expect.objectContaining({ kind: "atomic_acceptance_required" }));

    const inventedTest = input.proposal.map((task) => ({
      ...(task as Record<string, unknown>),
      assertions: [
        {
          assertion_id: "assertion_output",
          test_ids: ["test_missing"],
          required_gate_ids: ["gate:test"],
          evidence_requirements: ["test_result"],
        },
      ],
    }));
    expect(() =>
      generateExecutionPlan(
        impactSet,
        approvedDigest,
        { ...input, proposal: inventedTest },
        PLAN_CONTEXT,
      ),
    ).toThrowError(expect.objectContaining({ kind: "uncovered_test" }));
  });

  it("rejects unauthorized capability expansion", () => {
    const { impactSet, approvedDigest } = approvedImpactSet();
    const input = scenarioInput("direct", impactSet);
    const expanded = [
      {
        ...(input.proposal[0] as Record<string, unknown>),
        capabilities: ["fs.read", "network.egress"],
      },
    ];
    try {
      generateExecutionPlan(
        impactSet,
        approvedDigest,
        { ...input, proposal: expanded },
        PLAN_CONTEXT,
      );
      expect.unreachable("expected capability expansion to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(PlanningError);
      expect((error as PlanningError).kind).toBe("capability_expansion");
    }
  });

  it("rejects tasks bound to paths outside the approved impact set", () => {
    const { impactSet, approvedDigest } = approvedImpactSet();
    const input = scenarioInput("direct", impactSet);
    const unbound = [
      {
        ...(input.proposal[0] as Record<string, unknown>),
        impact_paths: [...allMustChangePaths(impactSet), ["edge-bogus"]],
      },
    ];
    expect(() =>
      generateExecutionPlan(
        impactSet,
        approvedDigest,
        { ...input, proposal: unbound },
        PLAN_CONTEXT,
      ),
    ).toThrow(PlanningError);
  });

  it("rejects plans that leave a must-change entry without an owning task", () => {
    const { impactSet, approvedDigest } = approvedImpactSet();
    const input = scenarioInput("dag", impactSet);
    const dropped = input.proposal[1] as Record<string, unknown>;
    const incomplete = [
      input.proposal[0],
      { ...dropped, impact_paths: [entryPath(impactSet, "requirement_01")] },
    ];
    expect(() =>
      generateExecutionPlan(
        impactSet,
        approvedDigest,
        { ...input, proposal: incomplete },
        PLAN_CONTEXT,
      ),
    ).toThrow(PlanningError);
  });

  it("keeps dag task state isolated and shares only immutable digests", () => {
    const { impactSet, approvedDigest } = approvedImpactSet();
    const records = generateExecutionPlan(
      impactSet,
      approvedDigest,
      scenarioInput("dag", impactSet),
      PLAN_CONTEXT,
    );
    const content = readExecutionPlanContent(records.plan);
    expect(content.mode).toBe("dag");
    expect(content.tasks).toHaveLength(2);
    const first = content.tasks[0];
    const second = content.tasks[1];
    if (first === undefined || second === undefined) {
      throw new Error("expected two dag tasks");
    }
    // Each task carries its own budget and capability set; nothing mutable is shared.
    expect(first.budget).not.toBe(second.budget);
    expect(first.budget).toEqual(second.budget);
    expect(first.capabilities).not.toEqual(second.capabilities);
    // The only shared state is the immutable goal and baseline/policy digests.
    expect(content.shared_context).toEqual(SHARED_CONTEXT);
    // Dependencies are the only cross-task channel, and they are explicit edges.
    const dependencies = records.edges.filter((edge) => edge.type === "DEPENDS_ON");
    expect(dependencies).toHaveLength(1);
    expect(dependencies[0]?.source_id).toBe("task_implement");
    expect(dependencies[0]?.target_id).toBe("task_spec");
    const contains = records.edges.filter((edge) => edge.type === "CONTAINS");
    expect(contains.map((edge) => edge.target_id).sort()).toEqual(
      content.tasks.map((task) => task.id).sort(),
    );
  });

  it("elevates planner task risk to the maximum impact and adapter risk", () => {
    const { impactSet, approvedDigest } = approvedImpactSet();
    const input = scenarioInput("single-loop", impactSet);
    const proposal = input.proposal.map((task) => ({
      ...(task as Record<string, unknown>),
      risk: "low",
    }));
    const records = generateExecutionPlan(
      impactSet,
      approvedDigest,
      {
        ...input,
        proposal,
        governance: {
          forecastPaths: [{ pattern: "backend/src", scope: "bounded", approved: true }],
          adapterProfile: {
            control: "delegated",
            trajectory_visibility: "external-only",
            usage_metering: false,
            side_effect_interception: false,
          },
        },
      },
      PLAN_CONTEXT,
    );
    const content = readExecutionPlanContent(records.plan);
    expect(content.tasks[0]?.risk).toBe("high");
    expect(content.impact_coverage).toMatchObject({
      status: "complete",
      covered_layers: expect.arrayContaining(["requirement", "test", "implementation", "path"]),
      forecast_paths: [{ pattern: "backend/src", scope: "bounded", approved: true }],
    });
  });
});

describe("generateExecutionPlan protocol 1.3", () => {
  const PROTOCOL13_SHARED = {
    ...SHARED_CONTEXT,
    baseline_commit: "c".repeat(40),
    capability_plan_digest: "d".repeat(64),
  } as const;

  const BUDGETS = {
    task_ceiling: { steps: 100, tokens: 100_000, duration_ms: 600_000 },
    iteration_ceiling: { steps: 1_000, tokens: 1_000_000, duration_ms: 3_600_000 },
    iteration: { steps: 50, tokens: 50_000, duration_ms: 1_200_000 },
  } as const;

  function protocol13Input(impactSet: NodeRecord): PlanGenerationInput {
    return {
      executionKind: "agent",
      intentShape: "structured",
      hasExistingGraph: true,
      deterministicWork: false,
      shared: PROTOCOL13_SHARED,
      constraints: PLAN_CONSTRAINTS,
      protocol: "protocol13",
      budgets: BUDGETS,
      proposal: [
        taskSpec({
          id: "task_implement",
          objective: "implement the component and code change",
          impact_paths: [
            entryPath(impactSet, "decision_01"),
            entryPath(impactSet, "component_01"),
            entryPath(impactSet, "code_01"),
          ],
          expected_outputs: ["decision_01", "component_01", "code_01"],
          dependencies: ["task_spec"],
          required_gates: ["gate:build", "gate:test"],
          write_paths: ["packages/runtime/src"],
          exclusive_resources: [],
          budget: { steps: 8, tokens: 4_000, duration_ms: 120_000 },
        }),
        taskSpec({
          id: "task_spec",
          objective: "revise the requirement and its acceptance test",
          impact_paths: [entryPath(impactSet, "requirement_01"), entryPath(impactSet, "test_01")],
          expected_outputs: ["requirement_01", "test_01"],
          capabilities: ["fs.read"],
          write_paths: ["docs/spec"],
          exclusive_resources: ["generated-client"],
          budget: { steps: 4, tokens: 2_000, duration_ms: 60_000 },
        }),
      ],
    };
  }

  function generateProtocol13() {
    const { impactSet, approvedDigest } = approvedImpactSet();
    const input = protocol13Input(impactSet);
    const records = generateExecutionPlan(impactSet, approvedDigest, input, PLAN_CONTEXT);
    return { impactSet, approvedDigest, input, records };
  }

  it("binds baseline, capability plan, iteration budget and waves into the plan", () => {
    const { records } = generateProtocol13();
    const content = readExecutionPlanContent(records.plan, {
      tasks: records.tasks,
      edges: records.edges,
    });
    expect(content.shared_context).toEqual(PROTOCOL13_SHARED);
    expect(content.iteration_budget).toEqual(BUDGETS.iteration);
    expect(content.parallel_waves).toEqual([
      { wave_index: 0, task_ids: ["task_spec"] },
      { wave_index: 1, task_ids: ["task_implement"] },
    ]);
    // Every Task node carries the semantic digest of its final specification.
    for (const node of records.tasks) {
      const spec = content.tasks.find((task) => task.id === node.id);
      expect(spec).toBeDefined();
      expect(node.extensions?.["harness.plan"]).toMatchObject({
        semantic_digest: taskSemanticDigest(spec as never),
      });
    }
  });

  it("is byte-stable across identical generation runs", () => {
    const first = generateProtocol13();
    const second = generateProtocol13();
    expect(second.records.plan.id).toBe(first.records.plan.id);
    expect(second.records.plan.digest).toBe(first.records.plan.digest);
  });

  it("compiles conflict-displaced waves for independent tasks", () => {
    const { impactSet, approvedDigest } = approvedImpactSet();
    const input = protocol13Input(impactSet);
    const [implement, spec] = input.proposal as readonly Record<string, unknown>[];
    const independent = [
      { ...implement, dependencies: [], write_paths: ["packages/runtime/src"] },
      { ...spec, write_paths: ["packages/runtime/src/scheduling"] },
    ];
    const records = generateExecutionPlan(
      impactSet,
      approvedDigest,
      { ...input, proposal: independent },
      PLAN_CONTEXT,
    );
    const content = readExecutionPlanContent(records.plan, {
      tasks: records.tasks,
      edges: records.edges,
    });
    expect(content.parallel_waves).toEqual([
      { wave_index: 0, task_ids: ["task_implement"] },
      { wave_index: 1, task_ids: ["task_spec"] },
    ]);
  });

  it("requires the 1.3 shared-context bindings and budget binding", () => {
    const { impactSet, approvedDigest, input } = generateProtocol13();
    const withoutBaseline = {
      ...input,
      shared: { ...PROTOCOL13_SHARED, baseline_commit: undefined },
    };
    expect(() =>
      generateExecutionPlan(impactSet, approvedDigest, withoutBaseline, PLAN_CONTEXT),
    ).toThrowError(expect.objectContaining({ kind: "invalid_specification" }));
    const withoutCapabilityPlan = {
      ...input,
      shared: { ...PROTOCOL13_SHARED, capability_plan_digest: undefined },
    };
    expect(() =>
      generateExecutionPlan(impactSet, approvedDigest, withoutCapabilityPlan, PLAN_CONTEXT),
    ).toThrowError(expect.objectContaining({ kind: "invalid_specification" }));
    const withoutBudgets = { ...input, budgets: undefined };
    expect(() =>
      generateExecutionPlan(impactSet, approvedDigest, withoutBudgets, PLAN_CONTEXT),
    ).toThrowError(expect.objectContaining({ kind: "invalid_specification" }));
  });

  it("rejects task and iteration budgets beyond the approved ceilings", () => {
    const { impactSet, approvedDigest, input } = generateProtocol13();
    const overTask = [
      {
        ...(input.proposal[0] as Record<string, unknown>),
        budget: { steps: 101, tokens: 4_000, duration_ms: 120_000 },
      },
      input.proposal[1],
    ];
    expect(() =>
      generateExecutionPlan(
        impactSet,
        approvedDigest,
        { ...input, proposal: overTask },
        PLAN_CONTEXT,
      ),
    ).toThrowError(expect.objectContaining({ kind: "invalid_specification" }));
    const overIteration = {
      ...input,
      budgets: { ...BUDGETS, iteration: { steps: 2_000, tokens: 50_000, duration_ms: 1_200_000 } },
    };
    expect(() =>
      generateExecutionPlan(impactSet, approvedDigest, overIteration, PLAN_CONTEXT),
    ).toThrowError(expect.objectContaining({ kind: "invalid_specification" }));
  });

  it("keeps iteration_budget as the aggregate authority even below the task maxima sum", () => {
    const { impactSet, approvedDigest, input } = generateProtocol13();
    // Sum of task maxima (steps 12) exceeds the iteration budget (steps 6);
    // the plan is still legal because iteration_budget is the runtime
    // aggregate authority, not a per-task sum.
    const tight = {
      ...input,
      budgets: { ...BUDGETS, iteration: { steps: 6, tokens: 3_000, duration_ms: 90_000 } },
    };
    const records = generateExecutionPlan(impactSet, approvedDigest, tight, PLAN_CONTEXT);
    const content = readExecutionPlanContent(records.plan, {
      tasks: records.tasks,
      edges: records.edges,
    });
    expect(content.iteration_budget).toEqual({ steps: 6, tokens: 3_000, duration_ms: 90_000 });
  });

  it("rejects a 1.3 proposal missing mandatory task fields", () => {
    const { impactSet, approvedDigest, input } = generateProtocol13();
    const legacyShape = input.proposal.map((task) => {
      const copy = { ...(task as Record<string, unknown>) };
      delete copy.write_paths;
      return copy;
    });
    expect(() =>
      generateExecutionPlan(
        impactSet,
        approvedDigest,
        { ...input, proposal: legacyShape },
        PLAN_CONTEXT,
      ),
    ).toThrowError(expect.objectContaining({ kind: "invalid_specification" }));
  });

  it("re-reads an approved 1.3 snapshot only after wave and projection verification", () => {
    const { records } = generateProtocol13();
    const content = readExecutionPlanContent(records.plan, {
      tasks: records.tasks,
      edges: records.edges,
    });
    // Persisted wave drift fails closed.
    const driftedWaves: readonly ParallelWave[] = [
      { wave_index: 0, task_ids: ["task_spec", "task_implement"] },
    ];
    const tamperedPlan = {
      ...records.plan,
      extensions: { "harness.plan": { ...content, parallel_waves: driftedWaves } },
    };
    expect(() =>
      readExecutionPlanContent(tamperedPlan, { tasks: records.tasks, edges: records.edges }),
    ).toThrowError(expect.objectContaining({ kind: "wave_drift" }));
    // The Graph projection is mandatory for a 1.3 snapshot.
    expect(() => readExecutionPlanContent(records.plan)).toThrowError(
      expect.objectContaining({ kind: "invalid_specification" }),
    );
    // Missing or reversed DEPENDS_ON edges fail closed.
    const droppedEdge = records.edges.filter((edge) => edge.type !== "DEPENDS_ON");
    expect(() =>
      readExecutionPlanContent(records.plan, { tasks: records.tasks, edges: droppedEdge }),
    ).toThrowError(expect.objectContaining({ kind: "plan_projection_drift" }));
    // Task node semantic digest drift fails closed.
    const driftedTasks = records.tasks.map((node) =>
      node.id === "task_spec"
        ? {
            ...node,
            extensions: {
              "harness.plan": {
                ...(node.extensions?.["harness.plan"] as Record<string, unknown>),
                semantic_digest: "0".repeat(64),
              },
            },
          }
        : node,
    );
    expect(() =>
      readExecutionPlanContent(records.plan, { tasks: driftedTasks, edges: records.edges }),
    ).toThrowError(expect.objectContaining({ kind: "plan_projection_drift" }));
  });

  it("never infers resource claims for legacy plans", () => {
    const { impactSet, approvedDigest } = approvedImpactSet();
    const records = generateExecutionPlan(
      impactSet,
      approvedDigest,
      scenarioInput("dag", impactSet),
      PLAN_CONTEXT,
    );
    const content = readExecutionPlanContent(records.plan);
    expect(content.parallel_waves).toBeUndefined();
    expect(content.iteration_budget).toBeUndefined();
    for (const task of content.tasks) {
      expect(task.write_paths).toBeUndefined();
      expect(task.exclusive_resources).toBeUndefined();
    }
  });

  it("matches compileParallelWaves for the persisted layout", () => {
    const { records } = generateProtocol13();
    const content = readExecutionPlanContent(records.plan, {
      tasks: records.tasks,
      edges: records.edges,
    });
    expect(compileParallelWaves(content.tasks as never)).toEqual(content.parallel_waves);
  });
});
