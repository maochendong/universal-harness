import { describe, expect, it } from "vitest";

import {
  buildOperationDag,
  type CapabilityId,
  type OperationDagNode,
} from "@universal-harness-internal/core";

import {
  InMemoryDagCheckpointStore,
  WorkflowDagEngine,
  type DagEngineEvent,
  type DagNodeContext,
  type DagNodeResult,
  type DagNodeRunner,
} from "../../src/index.js";

/**
 * T8-A: the Workflow Engine executes the nodes a CapabilityPlan DAG actually
 * contains — nothing more. These fixtures are capability sets, not profiles:
 * the engine never sees a profile name, only DAG nodes, runners, checkpoints
 * and typed results (slim-profiles design 9.5).
 */
const LITE_NODES = buildOperationDag(new Set());
const STANDARD_NODES = buildOperationDag(
  new Set<CapabilityId>(["impact_analysis", "design_governance", "independent_evaluation"]),
);
const GOVERNED_NODES = buildOperationDag(
  new Set<CapabilityId>([
    "impact_analysis",
    "design_governance",
    "independent_evaluation",
    "strict_tdd",
    "advanced_audit",
  ]),
);

const KERNEL_NODE_IDS = [
  "capture",
  "capability_decision",
  "plan",
  "context",
  "execute",
  "verify",
  "snapshot",
] as const;

interface SpyRunner {
  readonly runner: DagNodeRunner;
  readonly contexts: DagNodeContext[];
}

/** A runner that commits every declared output with a deterministic digest. */
function spyRunner(override?: (context: DagNodeContext) => DagNodeResult): SpyRunner {
  const contexts: DagNodeContext[] = [];
  const runner: DagNodeRunner = (context) => {
    contexts.push(context);
    if (override !== undefined) return override(context);
    return {
      status: "committed",
      produces: context.node.produces.map((kind) => ({
        kind,
        digest: `digest_${context.node.node_id}_${kind}`,
      })),
    };
  };
  return { runner, contexts };
}

function kernelRunners(
  overrides: Partial<Record<string, (context: DagNodeContext) => DagNodeResult>> = {},
): { registry: Record<string, DagNodeRunner>; spies: Map<string, SpyRunner> } {
  const registry: Record<string, DagNodeRunner> = {};
  const spies = new Map<string, SpyRunner>();
  for (const nodeId of KERNEL_NODE_IDS) {
    const spy = spyRunner(overrides[nodeId]);
    registry[nodeId] = spy.runner;
    spies.set(nodeId, spy);
  }
  return { registry, spies };
}

function moduleRunners(capabilities: readonly CapabilityId[]): {
  registry: Partial<Record<CapabilityId, DagNodeRunner>>;
  spies: Map<string, SpyRunner>;
} {
  const registry: Partial<Record<CapabilityId, DagNodeRunner>> = {};
  const spies = new Map<string, SpyRunner>();
  for (const capabilityId of capabilities) {
    const spy = spyRunner();
    registry[capabilityId] = spy.runner;
    spies.set(capabilityId, spy);
  }
  return { registry, spies };
}

function makeEngine(
  nodes: readonly OperationDagNode[],
  options: {
    readonly store?: InMemoryDagCheckpointStore;
    readonly kernelOverrides?: Partial<Record<string, (context: DagNodeContext) => DagNodeResult>>;
    readonly moduleCapabilities?: readonly CapabilityId[];
    readonly events?: DagEngineEvent[];
  } = {},
): {
  engine: WorkflowDagEngine;
  store: InMemoryDagCheckpointStore;
  kernelSpies: Map<string, SpyRunner>;
  moduleSpies: Map<string, SpyRunner>;
  events: DagEngineEvent[];
} {
  const store = options.store ?? new InMemoryDagCheckpointStore();
  const events: DagEngineEvent[] = options.events ?? [];
  const kernel = kernelRunners(options.kernelOverrides);
  const modules = moduleRunners(options.moduleCapabilities ?? []);
  const engine = new WorkflowDagEngine({
    store,
    runners: { kernel: kernel.registry, modules: modules.registry },
    onEvent: (event) => events.push(event),
  });
  void nodes;
  return { engine, store, kernelSpies: kernel.spies, moduleSpies: modules.spies, events };
}

const PLAN_DIGEST = "plan_digest_fixture";

function run(
  engine: WorkflowDagEngine,
  nodes: readonly OperationDagNode[],
  operationId = "op_1",
  planDigest = PLAN_DIGEST,
) {
  return engine.run({
    operation_id: operationId,
    plan_digest: planDigest,
    nodes,
  });
}

describe("workflow DAG engine", () => {
  it("executes the lite kernel DAG in dependency order with one checkpoint per node", async () => {
    const { engine, store, kernelSpies, events } = makeEngine(LITE_NODES);
    const outcome = await run(engine, LITE_NODES);

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") throw new Error("unreachable");
    expect(outcome.executed_nodes).toEqual([...KERNEL_NODE_IDS]);
    expect(outcome.replayed_nodes).toEqual([]);

    // Every node committed authoritatively exactly once, in order.
    const journal = store.load("op_1");
    expect(journal.map((entry) => entry.node_id)).toEqual([...KERNEL_NODE_IDS]);
    expect(journal.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const entry of journal) {
      expect(entry.checkpoint_id.length).toBeGreaterThan(0);
      expect(entry.plan_digest).toBe(PLAN_DIGEST);
    }

    // Inputs flow from producer outputs: plan consumes the capture baseline.
    const planContexts = kernelSpies.get("plan")?.contexts ?? [];
    expect(planContexts).toHaveLength(1);
    expect(planContexts[0]?.inputs).toEqual({
      requirement_baseline: "digest_capture_requirement_baseline",
    });
    // The generic tail: snapshot consumes gate evidence only (no evaluation).
    const snapshotContexts = kernelSpies.get("snapshot")?.contexts ?? [];
    expect(snapshotContexts[0]?.inputs).toEqual({
      gate_evidence: "digest_verify_gate_evidence",
    });

    // Events bracket every executed node; none reference absent modules.
    expect(events.map((event) => event.type)).toEqual(
      KERNEL_NODE_IDS.flatMap(() => ["node_started", "node_committed"] as const),
    );
    expect(JSON.stringify(events)).not.toMatch(/impact|design|evaluate|audit/);
  });

  it("executes standard and governed DAGs including exactly the active module nodes", async () => {
    const standard = makeEngine(STANDARD_NODES, {
      moduleCapabilities: ["impact_analysis", "design_governance", "independent_evaluation"],
    });
    const standardOutcome = await run(standard.engine, STANDARD_NODES);
    expect(standardOutcome.status).toBe("completed");
    if (standardOutcome.status !== "completed") throw new Error("unreachable");
    expect(standardOutcome.executed_nodes).toEqual([
      "capture",
      "capability_decision",
      "impact",
      "design",
      "plan",
      "context",
      "execute",
      "verify",
      "evaluate",
      "snapshot",
    ]);
    // The generic tail is verify -> evaluate -> snapshot; snapshot consumes
    // the evaluation report only because the DAG says so.
    const snapshotInputs = standard.kernelSpies.get("snapshot")?.contexts[0]?.inputs;
    expect(snapshotInputs).toEqual({
      gate_evidence: "digest_verify_gate_evidence",
      evaluation_report: "digest_evaluate_evaluation_report",
    });
    const planInputs = standard.kernelSpies.get("plan")?.contexts[0]?.inputs;
    expect(planInputs).toEqual({
      requirement_baseline: "digest_capture_requirement_baseline",
      impact_set: "digest_impact_impact_set",
      design_set: "digest_design_design_set",
    });

    const governed = makeEngine(GOVERNED_NODES, {
      moduleCapabilities: [
        "impact_analysis",
        "design_governance",
        "independent_evaluation",
        "strict_tdd",
        "advanced_audit",
      ],
    });
    const governedOutcome = await run(governed.engine, GOVERNED_NODES);
    expect(governedOutcome.status).toBe("completed");
    if (governedOutcome.status !== "completed") throw new Error("unreachable");
    expect(governedOutcome.executed_nodes).toEqual([
      "capture",
      "capability_decision",
      "impact",
      "design",
      "plan",
      "context",
      "execute",
      "verify",
      "evaluate",
      "snapshot",
      "audit",
    ]);
    // strict_tdd stays a subgraph inside execute, never a global phase.
    const executeContexts = governed.kernelSpies.get("execute")?.contexts ?? [];
    expect(executeContexts[0]?.node.subgraph).toBe("strict_tdd");
    expect(executeContexts[0]?.inputs.design_set).toBe("digest_design_design_set");
  });

  it("never invokes, checkpoints or emits events for absent optional modules", async () => {
    // All five module runners are registered; the lite DAG contains none of
    // their nodes, so the engine must not touch them at all.
    const { engine, store, moduleSpies, events } = makeEngine(LITE_NODES, {
      moduleCapabilities: [
        "impact_analysis",
        "design_governance",
        "independent_evaluation",
        "strict_tdd",
        "advanced_audit",
      ],
    });
    const outcome = await run(engine, LITE_NODES);
    expect(outcome.status).toBe("completed");

    for (const spy of moduleSpies.values()) {
      expect(spy.contexts).toEqual([]);
    }
    const journalText = JSON.stringify(store.load("op_1"));
    expect(journalText).not.toMatch(/impact|design|evaluate|audit/);
    expect(JSON.stringify(events)).not.toMatch(/impact|design|evaluate|audit/);
  });

  it("fails closed when a DAG node has no registered runner", async () => {
    const store = new InMemoryDagCheckpointStore();
    const engine = new WorkflowDagEngine({
      store,
      runners: { kernel: {} }, // no runners at all
    });
    await expect(run(engine, LITE_NODES)).rejects.toMatchObject({
      name: "DagEngineError",
      kind: "missing_node_runner",
    });
  });

  it("fails closed when a module node carries no capability identity", async () => {
    const store = new InMemoryDagCheckpointStore();
    const kernel = kernelRunners();
    const engine = new WorkflowDagEngine({
      store,
      runners: { kernel: kernel.registry, modules: {} },
    });
    const broken: OperationDagNode[] = STANDARD_NODES.map((node) =>
      node.node_kind === "module" ? { ...node, capability_id: undefined } : node,
    );
    await expect(run(engine, broken)).rejects.toMatchObject({
      name: "DagEngineError",
      kind: "module_node_without_capability",
    });
  });

  it("rejects a structurally invalid DAG before invoking any runner", async () => {
    const { engine, kernelSpies } = makeEngine(LITE_NODES);
    const cyclic: OperationDagNode[] = [
      {
        node_id: "a",
        node_kind: "kernel",
        depends_on: ["b"],
        consumes: [],
        produces: [],
        checkpoint: true,
      },
      {
        node_id: "b",
        node_kind: "kernel",
        depends_on: ["a"],
        consumes: [],
        produces: [],
        checkpoint: true,
      },
    ];
    await expect(run(engine, cyclic)).rejects.toMatchObject({ name: "OperationDagError" });
    for (const spy of kernelSpies.values()) {
      expect(spy.contexts).toEqual([]);
    }
  });

  it("treats a runner crash as a typed failure and resumes from the crashed node", async () => {
    let executeAttempts = 0;
    const store = new InMemoryDagCheckpointStore();
    const first = makeEngine(LITE_NODES, {
      store,
      kernelOverrides: {
        execute: (context) => {
          executeAttempts += 1;
          if (executeAttempts === 1) {
            throw new Error("process died mid-node");
          }
          return {
            status: "committed",
            produces: context.node.produces.map((kind) => ({
              kind,
              digest: `digest_${context.node.node_id}_${kind}`,
            })),
          };
        },
      },
    });
    const crashed = await run(first.engine, LITE_NODES);
    expect(crashed).toMatchObject({ status: "failed", node_id: "execute" });

    // The journal stops at the last authoritative commit before the crash.
    expect(store.load("op_1").map((entry) => entry.node_id)).toEqual([
      "capture",
      "capability_decision",
      "plan",
      "context",
    ]);

    // A fresh engine over the same store resumes deterministically: committed
    // nodes are replayed, never re-invoked; the tail re-runs exactly once.
    const second = makeEngine(LITE_NODES, {
      store,
      kernelOverrides: {
        execute: (context) => {
          executeAttempts += 1;
          return {
            status: "committed",
            produces: context.node.produces.map((kind) => ({
              kind,
              digest: `digest_${context.node.node_id}_${kind}`,
            })),
          };
        },
      },
    });
    const recovered = await run(second.engine, LITE_NODES);
    expect(recovered.status).toBe("completed");
    if (recovered.status !== "completed") throw new Error("unreachable");
    expect(recovered.replayed_nodes).toEqual(["capture", "capability_decision", "plan", "context"]);
    expect(recovered.executed_nodes).toEqual(["execute", "verify", "snapshot"]);
    expect(executeAttempts).toBe(2);
    for (const nodeId of ["capture", "capability_decision", "plan", "context"]) {
      expect(second.kernelSpies.get(nodeId)?.contexts).toEqual([]);
    }
    expect(store.load("op_1").map((entry) => entry.node_id)).toEqual([...KERNEL_NODE_IDS]);

    // A third run is a pure replay: zero invocations, identical journal.
    const third = makeEngine(LITE_NODES, { store });
    const settled = await run(third.engine, LITE_NODES);
    expect(settled.status).toBe("completed");
    if (settled.status !== "completed") throw new Error("unreachable");
    expect(settled.executed_nodes).toEqual([]);
    expect(settled.replayed_nodes).toEqual([...KERNEL_NODE_IDS]);
    for (const spy of third.kernelSpies.values()) {
      expect(spy.contexts).toEqual([]);
    }
  });

  it("pauses with a typed awaiting-approval outcome and resumes after the decision", async () => {
    let verifyAttempts = 0;
    const store = new InMemoryDagCheckpointStore();
    const verifyGate = (context: DagNodeContext): DagNodeResult => {
      verifyAttempts += 1;
      if (verifyAttempts === 1) {
        return {
          status: "awaiting_approval",
          approval: {
            object_id: "gate-evidence-1",
            object_kind: "gate_evidence",
            object_digest: "digest_pending_gate_evidence",
          },
        };
      }
      return {
        status: "committed",
        produces: context.node.produces.map((kind) => ({
          kind,
          digest: `digest_${context.node.node_id}_${kind}`,
        })),
      };
    };
    const first = makeEngine(LITE_NODES, { store, kernelOverrides: { verify: verifyGate } });
    const paused = await run(first.engine, LITE_NODES);
    expect(paused).toEqual({
      status: "awaiting_approval",
      operation_id: "op_1",
      node_id: "verify",
      approval: {
        object_id: "gate-evidence-1",
        object_kind: "gate_evidence",
        object_digest: "digest_pending_gate_evidence",
      },
    });
    // No checkpoint and no downstream invocation while awaiting approval.
    expect(store.load("op_1").map((entry) => entry.node_id)).toEqual([
      "capture",
      "capability_decision",
      "plan",
      "context",
      "execute",
    ]);
    expect(first.kernelSpies.get("snapshot")?.contexts).toEqual([]);

    const second = makeEngine(LITE_NODES, { store, kernelOverrides: { verify: verifyGate } });
    const decided = await run(second.engine, LITE_NODES);
    expect(decided.status).toBe("completed");
    expect(verifyAttempts).toBe(2);
    expect(store.load("op_1").map((entry) => entry.node_id)).toEqual([...KERNEL_NODE_IDS]);
  });

  it("returns a typed blocked outcome without committing the blocked node", async () => {
    const store = new InMemoryDagCheckpointStore();
    const { engine, kernelSpies } = makeEngine(LITE_NODES, {
      store,
      kernelOverrides: {
        context: () => ({
          status: "blocked",
          reason: "provider_unavailable",
          detail: "context provider quota exhausted",
        }),
      },
    });
    const outcome = await run(engine, LITE_NODES);
    expect(outcome).toEqual({
      status: "blocked",
      operation_id: "op_1",
      node_id: "context",
      reason: "provider_unavailable",
      detail: "context provider quota exhausted",
    });
    expect(store.load("op_1").map((entry) => entry.node_id)).toEqual([
      "capture",
      "capability_decision",
      "plan",
    ]);
    expect(kernelSpies.get("execute")?.contexts).toEqual([]);
  });

  it("commits every node authoritatively before its dependents start", async () => {
    const { engine, events } = makeEngine(GOVERNED_NODES, {
      moduleCapabilities: [
        "impact_analysis",
        "design_governance",
        "independent_evaluation",
        "strict_tdd",
        "advanced_audit",
      ],
    });
    const outcome = await run(engine, GOVERNED_NODES);
    expect(outcome.status).toBe("completed");

    const committedAt = new Map<string, number>();
    const startedAt = new Map<string, number>();
    events.forEach((event, index) => {
      if (event.type === "node_committed") committedAt.set(event.node_id, index);
      if (event.type === "node_started" && !startedAt.has(event.node_id)) {
        startedAt.set(event.node_id, index);
      }
    });
    for (const node of GOVERNED_NODES) {
      for (const dependency of node.depends_on) {
        const committed = committedAt.get(dependency);
        const started = startedAt.get(node.node_id);
        expect(committed, `${dependency} committed`).toBeDefined();
        expect(started, `${node.node_id} started`).toBeDefined();
        expect(committed as number).toBeLessThan(started as number);
      }
    }
  });

  it("invalidates the earliest necessary node on capability upgrade and recovers deterministically", async () => {
    const store = new InMemoryDagCheckpointStore();
    const lite = makeEngine(LITE_NODES, { store });
    const liteOutcome = await run(lite.engine, LITE_NODES);
    expect(liteOutcome.status).toBe("completed");
    expect(store.load("op_1")).toHaveLength(7);

    // Upgrade: impact_analysis activates. The new DAG inserts the impact node
    // and rewires plan's inputs, so the earliest necessary node is `impact`;
    // capture and capability_decision stay authoritative and are replayed.
    const upgradedNodes = buildOperationDag(new Set<CapabilityId>(["impact_analysis"]));
    const upgraded = makeEngine(upgradedNodes, {
      store,
      moduleCapabilities: ["impact_analysis"],
    });
    const recovered = await run(upgraded.engine, upgradedNodes, "op_1", "plan_digest_upgraded");
    expect(recovered.status).toBe("completed");
    if (recovered.status !== "completed") throw new Error("unreachable");
    expect(recovered.replayed_nodes).toEqual(["capture", "capability_decision"]);
    expect(recovered.executed_nodes).toEqual([
      "impact",
      "plan",
      "context",
      "execute",
      "verify",
      "snapshot",
    ]);
    expect(upgraded.kernelSpies.get("capture")?.contexts).toEqual([]);
    expect(upgraded.kernelSpies.get("capability_decision")?.contexts).toEqual([]);

    // plan now consumes the impact set produced by the new module node.
    const planInputs = upgraded.kernelSpies.get("plan")?.contexts[0]?.inputs;
    expect(planInputs).toEqual({
      requirement_baseline: "digest_capture_requirement_baseline",
      impact_set: "digest_impact_impact_set",
    });
    const journal = store.load("op_1");
    expect(journal.map((entry) => entry.node_id)).toEqual([
      "capture",
      "capability_decision",
      "impact",
      "plan",
      "context",
      "execute",
      "verify",
      "snapshot",
    ]);

    // Deterministic recovery: re-running the upgraded plan replays everything.
    const settled = makeEngine(upgradedNodes, {
      store,
      moduleCapabilities: ["impact_analysis"],
    });
    const settledOutcome = await run(settled.engine, upgradedNodes, "op_1", "plan_digest_upgraded");
    expect(settledOutcome.status).toBe("completed");
    if (settledOutcome.status !== "completed") throw new Error("unreachable");
    expect(settledOutcome.executed_nodes).toEqual([]);
    for (const spy of settled.kernelSpies.values()) {
      expect(spy.contexts).toEqual([]);
    }
    for (const spy of settled.moduleSpies.values()) {
      expect(spy.contexts).toEqual([]);
    }
  });

  it("fails closed when a runner does not produce a declared output binding", async () => {
    const { engine } = makeEngine(LITE_NODES, {
      kernelOverrides: {
        capture: () => ({ status: "committed", produces: [] }),
      },
    });
    await expect(run(engine, LITE_NODES)).rejects.toMatchObject({
      name: "DagEngineError",
      kind: "runner_output_mismatch",
    });
  });

  it("rejects runner output the DAG never declared", async () => {
    const { engine } = makeEngine(LITE_NODES, {
      kernelOverrides: {
        capture: (context) => ({
          status: "committed",
          produces: [
            ...context.node.produces.map((kind) => ({ kind, digest: "ok" })),
            { kind: "snapshot", digest: "not_declared" },
          ],
        }),
      },
    });
    await expect(run(engine, LITE_NODES)).rejects.toMatchObject({
      name: "DagEngineError",
      kind: "runner_output_mismatch",
    });
  });

  it("keeps journals of different operations isolated", async () => {
    const store = new InMemoryDagCheckpointStore();
    const first = makeEngine(LITE_NODES, { store });
    await run(first.engine, LITE_NODES, "op_1");
    const second = makeEngine(LITE_NODES, { store });
    const outcome = await run(second.engine, LITE_NODES, "op_2");
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") throw new Error("unreachable");
    expect(outcome.executed_nodes).toEqual([...KERNEL_NODE_IDS]);
    expect(store.load("op_1")).toHaveLength(7);
    expect(store.load("op_2")).toHaveLength(7);
  });
});
