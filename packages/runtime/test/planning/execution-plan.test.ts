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
import { PlanningError } from "../../src/planning/validator.js";

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
});
