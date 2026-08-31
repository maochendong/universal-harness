import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
  contentDigest,
  type EdgeRecord,
  type NodeRecord,
} from "@universal-harness-internal/core";

import {
  PLAN_EXTENSION_KEY,
  readExecutionPlanContent,
  type ExecutionPlanContent,
} from "../../src/planning/execution-plan.js";
import { taskSemanticDigest, type Protocol13TaskSpecification } from "../../src/planning/task.js";
import { PlanningError } from "../../src/planning/validator.js";
import { compileParallelWaves, type ParallelWave } from "../../src/planning/waves.js";
import { SchedulingPortError } from "../../src/scheduling/ports.js";
import {
  assertTaskDagSnapshot,
  createInMemoryTaskDagPort,
  createWorkflowTaskDagAdapter,
} from "../../src/scheduling/task-dag-adapters.js";

/**
 * Plan Task 4 step 2: TaskDagPort unit tests. The shared rejection contract
 * lives in the conformance suite; these tests pin the guard's typed errors,
 * the narrow read wiring of the Workflow Adapter and the immutability of the
 * InMemory Adapter's fixture.
 */

const NOW = "2026-08-31T00:00:00.000Z";
const OPERATION_ID = "operation_unit_task_dag";
const ITERATION_ID = "iteration_unit_task_dag";
const BASELINE = "0123456789abcdef0123456789abcdef01234567";
const digest = (letter: string): string => letter.repeat(64);

function unitTasks(): Protocol13TaskSpecification[] {
  const budget = { steps: 10, tokens: 20_000, duration_ms: 600_000 };
  const base = {
    impact_paths: [],
    capabilities: ["edit-source"],
    tools: ["apply_patch"],
    risk: "medium" as const,
    budget,
    exclusive_resources: [],
    acceptance: [{ description: "unit tests pass", verification: "unit-tests" }],
    required_gates: ["unit-tests"],
  };
  return [
    {
      ...base,
      id: "task_alpha",
      objective: "Implement the alpha module",
      expected_outputs: ["node_alpha"],
      dependencies: [],
      write_paths: ["src/alpha"],
    },
    {
      ...base,
      id: "task_beta",
      objective: "Implement the beta module",
      expected_outputs: ["node_beta"],
      dependencies: [],
      write_paths: ["src/beta"],
    },
    {
      ...base,
      id: "task_gamma",
      objective: "Integrate alpha and beta into the gamma module",
      expected_outputs: ["node_gamma"],
      dependencies: ["task_alpha", "task_beta"],
      write_paths: ["src/gamma"],
    },
  ];
}

interface UnitFixture {
  readonly plan: NodeRecord;
  readonly taskNodes: readonly NodeRecord[];
  readonly edges: readonly EdgeRecord[];
  readonly content: ExecutionPlanContent;
  readonly tasks: readonly Protocol13TaskSpecification[];
}

interface UnitFixtureOptions {
  readonly planStatus?: NodeRecord["status"];
  readonly persistedWaves?: readonly ParallelWave[];
  readonly planBaseline?: string;
  readonly legacy?: boolean;
  readonly tamperTaskNode?: (node: NodeRecord) => NodeRecord;
  readonly edgeProjection?: (edges: readonly EdgeRecord[]) => readonly EdgeRecord[];
}

function nodeRecord(
  id: string,
  type: "ExecutionPlan" | "Task",
  extensions: Record<string, unknown>,
  status: NodeRecord["status"],
): NodeRecord {
  const record = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "node",
    id,
    type,
    revision: 1,
    status,
    source: "workflow",
    provenance: { iteration_id: ITERATION_ID, actor: "unit-test", timestamp: NOW },
    confidence: 1,
    extensions: { [PLAN_EXTENSION_KEY]: extensions },
  };
  return { ...record, digest: contentDigest(record) } as unknown as NodeRecord;
}

function edgeRecord(
  type: "CONTAINS" | "DEPENDS_ON",
  sourceId: string,
  targetId: string,
): EdgeRecord {
  const record = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "edge",
    id: `edge_${contentDigest({ type, source: sourceId, target: targetId }).slice(0, 16)}`,
    type,
    source_id: sourceId,
    target_id: targetId,
    status: "accepted",
    source: "workflow",
    provenance: { iteration_id: ITERATION_ID, actor: "unit-test", timestamp: NOW },
    confidence: 1,
  };
  return { ...record, digest: contentDigest(record) } as unknown as EdgeRecord;
}

function buildFixture(options: UnitFixtureOptions = {}): UnitFixture {
  const tasks = unitTasks();
  const planBaseline = options.planBaseline ?? BASELINE;
  const base: Record<string, unknown> = {
    execution_kind: "agent",
    impact_coverage: {
      execution_kind: "agent",
      entries: [],
      status: "complete",
      covered_layers: [],
      missing_layers: [],
      forecast_paths: [],
      diagnostics: [],
      risk: "low",
      digest: digest("i"),
    },
    mode: options.legacy === true ? "single-loop" : "dag",
    mode_reason: "unit fixture",
    restricted: false,
    impact_set_id: "impact_unit",
    impact_set_digest: digest("s"),
    shared_context:
      options.legacy === true
        ? {
            goal: "unit goal",
            requirement_baseline_digest: digest("r"),
            policy_digest: digest("p"),
          }
        : {
            goal: "unit goal",
            requirement_baseline_digest: digest("r"),
            policy_digest: digest("p"),
            baseline_commit: planBaseline,
            capability_plan_digest: digest("c"),
          },
    tasks,
  };
  if (options.legacy !== true) {
    base.iteration_budget = { steps: 40, tokens: 80_000, duration_ms: 3_600_000 };
    base.parallel_waves = options.persistedWaves ?? compileParallelWaves(tasks);
  }
  const content = {
    ...base,
    content_digest: contentDigest(base),
  } as unknown as ExecutionPlanContent;
  const planId = `plan_${content.content_digest.slice(0, 16)}`;
  const plan = nodeRecord(
    planId,
    "ExecutionPlan",
    content as unknown as Record<string, unknown>,
    options.planStatus ?? "accepted",
  );
  const taskNodes = tasks.map((task) => {
    const node = nodeRecord(
      task.id,
      "Task",
      {
        ...task,
        semantic_digest: taskSemanticDigest(task),
      },
      "accepted",
    );
    return options.tamperTaskNode?.(node) ?? node;
  });
  const edges: EdgeRecord[] = [
    ...tasks.map((task) => edgeRecord("CONTAINS", planId, task.id)),
    ...tasks.flatMap((task) =>
      task.dependencies.map((dependency) => edgeRecord("DEPENDS_ON", task.id, dependency)),
    ),
  ];
  return {
    plan,
    taskNodes,
    edges: options.edgeProjection?.(edges) ?? edges,
    content,
    tasks,
  };
}

function guardInput(fixture: UnitFixture, overrides: Record<string, unknown> = {}) {
  return {
    operation_id: OPERATION_ID,
    plan: fixture.plan,
    task_nodes: fixture.taskNodes,
    edges: fixture.edges,
    current_baseline_commit: BASELINE,
    ...overrides,
  };
}

describe("assertTaskDagSnapshot", () => {
  it("returns the canonical snapshot of the approved plan", () => {
    const fixture = buildFixture();
    const snapshot = assertTaskDagSnapshot(guardInput(fixture));
    expect(snapshot.operation_id).toBe(OPERATION_ID);
    expect(snapshot.iteration_id).toBe(ITERATION_ID);
    expect(snapshot.plan_id).toBe(fixture.plan.id);
    expect(snapshot.plan_digest).toBe(fixture.content.content_digest);
    expect(snapshot.baseline_commit).toBe(BASELINE);
    expect(snapshot.tasks).toEqual(fixture.tasks);
    expect(snapshot.parallel_waves).toEqual([
      { wave_index: 0, task_ids: ["task_alpha", "task_beta"] },
      { wave_index: 1, task_ids: ["task_gamma"] },
    ]);
    expect(snapshot.iteration_budget).toEqual({
      steps: 40,
      tokens: 80_000,
      duration_ms: 3_600_000,
    });
  });

  it("accepts a matching expected_plan_digest", () => {
    const fixture = buildFixture();
    const snapshot = assertTaskDagSnapshot(
      guardInput(fixture, { expected_plan_digest: fixture.content.content_digest }),
    );
    expect(snapshot.plan_digest).toBe(fixture.content.content_digest);
  });

  it("rejects an unapproved plan as plan_not_approved", () => {
    const fixture = buildFixture({ planStatus: "proposed" });
    try {
      assertTaskDagSnapshot(guardInput(fixture));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SchedulingPortError);
      expect((error as SchedulingPortError).kind).toBe("plan_not_approved");
    }
  });

  it("rejects expected_plan_digest drift as plan_digest_drift", () => {
    const fixture = buildFixture();
    try {
      assertTaskDagSnapshot(guardInput(fixture, { expected_plan_digest: digest("0") }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SchedulingPortError);
      expect((error as SchedulingPortError).kind).toBe("plan_digest_drift");
    }
  });

  it("rejects a plan bound to a stale baseline as baseline_drift", () => {
    const fixture = buildFixture({ planBaseline: "f".repeat(40) });
    try {
      assertTaskDagSnapshot(guardInput(fixture));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SchedulingPortError);
      expect((error as SchedulingPortError).kind).toBe("baseline_drift");
    }
  });

  it("rejects a legacy plan requested for parallel execution as legacy_plan", () => {
    const fixture = buildFixture({ legacy: true });
    // A legacy plan reads back without a projection; the guard refuses it.
    expect(readExecutionPlanContent(fixture.plan).parallel_waves).toBeUndefined();
    try {
      assertTaskDagSnapshot(guardInput(fixture));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SchedulingPortError);
      expect((error as SchedulingPortError).kind).toBe("legacy_plan");
    }
  });

  it("rejects a missing DEPENDS_ON edge as plan_projection_drift", () => {
    const fixture = buildFixture({
      edgeProjection: (edges) => edges.filter((edge) => edge.type !== "DEPENDS_ON"),
    });
    try {
      assertTaskDagSnapshot(guardInput(fixture));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PlanningError);
      expect((error as PlanningError).kind).toBe("plan_projection_drift");
    }
  });

  it("rejects an extra DEPENDS_ON edge as plan_projection_drift", () => {
    const fixture = buildFixture({
      edgeProjection: (edges) => [
        ...edges,
        { ...edges.find((edge) => edge.type === "DEPENDS_ON"), id: "edge_extra" } as EdgeRecord,
      ],
    });
    // Duplicate triples still change the sorted edge multiset.
    try {
      assertTaskDagSnapshot(guardInput(fixture));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PlanningError);
      expect((error as PlanningError).kind).toBe("plan_projection_drift");
    }
  });

  it("rejects a reversed DEPENDS_ON edge as plan_projection_drift", () => {
    const fixture = buildFixture({
      edgeProjection: (edges) =>
        edges.map((edge) =>
          edge.type === "DEPENDS_ON"
            ? ({ ...edge, source_id: edge.target_id, target_id: edge.source_id } as EdgeRecord)
            : edge,
        ),
    });
    try {
      assertTaskDagSnapshot(guardInput(fixture));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PlanningError);
      expect((error as PlanningError).kind).toBe("plan_projection_drift");
    }
  });

  it("rejects Task node semantic digest drift as plan_projection_drift", () => {
    const fixture = buildFixture({
      tamperTaskNode: (node) =>
        node.id === "task_alpha"
          ? nodeRecord(
              node.id,
              "Task",
              {
                ...(node.extensions?.[PLAN_EXTENSION_KEY] as Record<string, unknown>),
                semantic_digest: digest("0"),
              },
              "accepted",
            )
          : node,
    });
    try {
      assertTaskDagSnapshot(guardInput(fixture));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PlanningError);
      expect((error as PlanningError).kind).toBe("plan_projection_drift");
    }
  });

  it("rejects persisted waves that differ from a fresh compilation as wave_drift", () => {
    const fixture = buildFixture({
      persistedWaves: [
        { wave_index: 0, task_ids: ["task_alpha", "task_beta", "task_gamma"] },
        { wave_index: 1, task_ids: [] },
      ],
    });
    try {
      assertTaskDagSnapshot(guardInput(fixture));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PlanningError);
      expect((error as PlanningError).kind).toBe("wave_drift");
    }
  });
});

describe("createWorkflowTaskDagAdapter", () => {
  /** `baseline: null` simulates an operation with no approved baseline. */
  function workflowPort(fixture: UnitFixture, baseline: string | null = BASELINE) {
    return createWorkflowTaskDagAdapter({
      readPlan: (operationId) => (operationId === OPERATION_ID ? fixture.plan : undefined),
      readTaskNodes: (planId) => (planId === fixture.plan.id ? fixture.taskNodes : []),
      readEdgeRecords: (planId) => (planId === fixture.plan.id ? fixture.edges : []),
      readApprovedBaseline: (operationId) =>
        operationId === OPERATION_ID && baseline !== null ? baseline : undefined,
    });
  }

  it("reads the approved plan through the narrow read functions", async () => {
    const fixture = buildFixture();
    const port = workflowPort(fixture);
    expect(port.name).toContain("workflow");
    const snapshot = await port.readApproved({ operation_id: OPERATION_ID });
    expect(snapshot.plan_digest).toBe(fixture.content.content_digest);
    expect(snapshot.tasks).toEqual(fixture.tasks);
  });

  it("rejects an unknown operation as plan_not_found", async () => {
    const port = workflowPort(buildFixture());
    try {
      await port.readApproved({ operation_id: "operation_unknown" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SchedulingPortError);
      expect((error as SchedulingPortError).kind).toBe("plan_not_found");
    }
  });

  it("rejects when no approved baseline is bound as baseline_drift", async () => {
    const port = workflowPort(buildFixture(), null);
    try {
      await port.readApproved({ operation_id: OPERATION_ID });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SchedulingPortError);
      expect((error as SchedulingPortError).kind).toBe("baseline_drift");
    }
  });
});

describe("createInMemoryTaskDagPort", () => {
  function memoryFixture(fixture: UnitFixture) {
    return {
      operation_id: OPERATION_ID,
      baseline_commit: BASELINE,
      plan: fixture.plan,
      task_nodes: fixture.taskNodes,
      edges: fixture.edges,
    };
  }

  it("runs the same guard on every read", async () => {
    const fixture = buildFixture();
    const port = createInMemoryTaskDagPort(memoryFixture(fixture));
    expect(port.name).toContain("in-memory");
    const first = await port.readApproved({ operation_id: OPERATION_ID });
    const second = await port.readApproved({
      operation_id: OPERATION_ID,
      expected_plan_digest: fixture.content.content_digest,
    });
    expect(second).toEqual(first);
    await expect(
      port.readApproved({ operation_id: OPERATION_ID, expected_plan_digest: digest("0") }),
    ).rejects.toBeInstanceOf(SchedulingPortError);
  });

  it("rejects reads for a different operation", async () => {
    const port = createInMemoryTaskDagPort(memoryFixture(buildFixture()));
    try {
      await port.readApproved({ operation_id: "operation_unknown" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SchedulingPortError);
      expect((error as SchedulingPortError).kind).toBe("plan_not_found");
    }
  });

  it("deep-freezes the fixture so drift between reads is impossible", async () => {
    const fixture = memoryFixture(buildFixture());
    createInMemoryTaskDagPort(fixture);
    expect(Object.isFrozen(fixture.plan)).toBe(true);
    expect(Object.isFrozen(fixture.task_nodes)).toBe(true);
    expect(Object.isFrozen(fixture.edges)).toBe(true);
    const extensions = fixture.plan.extensions as Record<string, unknown>;
    expect(Object.isFrozen(extensions)).toBe(true);
  });

  it("rejects an unapproved fixture plan", async () => {
    const port = createInMemoryTaskDagPort(memoryFixture(buildFixture({ planStatus: "proposed" })));
    await expect(port.readApproved({ operation_id: OPERATION_ID })).rejects.toMatchObject({
      kind: "plan_not_approved",
    });
  });
});
