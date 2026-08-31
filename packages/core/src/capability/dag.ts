import { PROTOCOL_1_3_VERSION } from "../protocol.js";
import type { BindingKindV13 } from "../schema/capability.js";
import type { CapabilityId, CapabilityIdV13 } from "../schema/profile.js";
import { capabilityModuleDefinition } from "./registry.js";

/**
 * Operation DAG construction and validation (slim-profiles design 9.4; M4
 * design 10.2). The Kernel nodes form a fixed spine; modules contribute nodes
 * at fixed positions only when the CapabilityPlan activates them. strict_tdd
 * and parallel_task_execution stay subgraphs inside `execute`, never a global
 * phase — when both are active the outer subgraph is parallel_task_execution
 * and Strict TDD runs per Task inside it; the generic tail is always
 * `verify → [evaluate?] → snapshot`. The 1.1 DAG bytes are unchanged.
 */
export interface OperationDagNode {
  readonly node_id: string;
  readonly node_kind: "kernel" | "module";
  readonly capability_id?: CapabilityId;
  readonly depends_on: readonly string[];
  readonly consumes: readonly BindingKindV13[];
  readonly produces: readonly BindingKindV13[];
  readonly checkpoint: boolean;
  readonly subgraph?: "strict_tdd" | "parallel_task_execution";
}

export class OperationDagError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "OperationDagError";
    this.kind = kind;
  }
}

function kernelNode(
  nodeId: string,
  dependsOn: readonly string[],
  consumes: readonly BindingKindV13[],
  produces: readonly BindingKindV13[],
): OperationDagNode {
  return {
    node_id: nodeId,
    node_kind: "kernel",
    depends_on: dependsOn,
    consumes,
    produces,
    checkpoint: true,
  };
}

function moduleNode(
  capabilityId: CapabilityId,
  nodeId: string,
  dependsOn: readonly string[],
  protocolVersion: string,
): OperationDagNode {
  const module = capabilityModuleDefinition(capabilityId, protocolVersion);
  return {
    node_id: nodeId,
    node_kind: "module",
    capability_id: capabilityId,
    depends_on: dependsOn,
    consumes: [...module.input_bindings],
    produces: [...module.output_bindings],
    checkpoint: true,
  };
}

/**
 * The fixed DAG for a set of active capabilities. Inactive modules contribute
 * no node, no bindings and no checkpoint — nothing exists to invoke. Protocol
 * 1.3 adds `parallel_task_execution` (M4 design 10.2): it contributes no new
 * node, only the outer `execute` subgraph plus its `execution_plan` input and
 * `wave_integration` output; `gate_evidence` keeps the Kernel `verify` node
 * as its sole producer. A 1.1 caller asking for the parallel module fails
 * closed instead of silently building a 1.3 shape.
 */
export function buildOperationDag(
  active: ReadonlySet<CapabilityIdV13>,
  protocolVersion: "1.1.0" | "1.3.0" = "1.1.0",
): OperationDagNode[] {
  const parallel = active.has("parallel_task_execution");
  if (parallel && protocolVersion !== PROTOCOL_1_3_VERSION) {
    throw new OperationDagError(
      "unknown_capability",
      "parallel_task_execution requires protocol 1.3.0",
    );
  }
  const nodes: OperationDagNode[] = [
    kernelNode("capture", [], [], ["requirement_baseline"]),
    kernelNode("capability_decision", ["capture"], ["requirement_baseline"], []),
  ];
  if (active.has("impact_analysis")) {
    nodes.push(moduleNode("impact_analysis", "impact", ["capability_decision"], protocolVersion));
  }
  if (active.has("design_governance")) {
    nodes.push(moduleNode("design_governance", "design", ["impact"], protocolVersion));
  }
  const planDependsOn = ["capability_decision"];
  const planConsumes: BindingKindV13[] = ["requirement_baseline"];
  if (active.has("impact_analysis")) {
    planDependsOn.push("impact");
    planConsumes.push("impact_set");
  }
  if (active.has("design_governance")) {
    planDependsOn.push("design");
    planConsumes.push("design_set");
  }
  nodes.push(kernelNode("plan", planDependsOn, planConsumes, ["execution_plan"]));

  const contextConsumes: BindingKindV13[] = ["execution_plan"];
  if (active.has("design_governance")) {
    contextConsumes.push("design_set");
  }
  nodes.push(kernelNode("context", ["plan"], contextConsumes, ["context_bundle"]));

  const strictTdd = active.has("strict_tdd");
  const executeConsumes: BindingKindV13[] = ["context_bundle"];
  const executeProduces: BindingKindV13[] = [];
  if (strictTdd) {
    executeConsumes.push("design_set");
    executeProduces.push("tdd_contract");
  }
  if (parallel) {
    executeConsumes.push("execution_plan");
    executeProduces.push("wave_integration");
  }
  const subgraph = parallel
    ? ("parallel_task_execution" as const)
    : strictTdd
      ? ("strict_tdd" as const)
      : undefined;
  nodes.push({
    ...kernelNode("execute", ["context"], executeConsumes, executeProduces),
    ...(subgraph === undefined ? {} : { subgraph }),
  });

  nodes.push(kernelNode("verify", ["execute"], ["context_bundle"], ["gate_evidence"]));

  const evaluation = active.has("independent_evaluation");
  if (evaluation) {
    nodes.push(moduleNode("independent_evaluation", "evaluate", ["verify"], protocolVersion));
  }
  const snapshotDependsOn = evaluation ? ["verify", "evaluate"] : ["verify"];
  const snapshotConsumes: BindingKindV13[] = evaluation
    ? ["gate_evidence", "evaluation_report"]
    : ["gate_evidence"];
  nodes.push(kernelNode("snapshot", snapshotDependsOn, snapshotConsumes, ["snapshot"]));

  if (active.has("advanced_audit")) {
    nodes.push(moduleNode("advanced_audit", "audit", ["snapshot"], protocolVersion));
  }
  return nodes;
}

/**
 * Fail-closed structural validation: duplicate node ids, dependencies on
 * nodes that do not exist, cycles, two nodes producing the same binding and
 * consumed bindings nobody produces are all compile blockers.
 */
export function validateOperationDag(nodes: readonly OperationDagNode[]): void {
  const byId = new Map<string, OperationDagNode>();
  for (const node of nodes) {
    if (byId.has(node.node_id)) {
      throw new OperationDagError("duplicate_node", `duplicate dag node: ${node.node_id}`);
    }
    byId.set(node.node_id, node);
  }
  for (const node of nodes) {
    for (const dependency of node.depends_on) {
      if (!byId.has(dependency)) {
        throw new OperationDagError(
          "unknown_dependency",
          `dag node ${node.node_id} depends on unknown node ${dependency}`,
        );
      }
    }
  }

  // Kahn's algorithm: if not every node can be emitted, the graph cycles.
  const indegree = new Map([...byId.keys()].map((id) => [id, 0]));
  for (const node of nodes) {
    for (const dependency of node.depends_on) {
      indegree.set(node.node_id, (indegree.get(node.node_id) ?? 0) + 1);
      void dependency;
    }
  }
  const queue = nodes.filter((node) => (indegree.get(node.node_id) ?? 0) === 0);
  let emitted = 0;
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dependency of node.depends_on) {
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), node.node_id]);
    }
  }
  const pending = [...queue];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined) break;
    emitted += 1;
    for (const dependent of dependents.get(current.node_id) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        const node = byId.get(dependent);
        if (node !== undefined) pending.push(node);
      }
    }
  }
  if (emitted !== nodes.length) {
    throw new OperationDagError("dag_cycle", "operation dag contains a dependency cycle");
  }

  const producers = new Map<BindingKindV13, string>();
  for (const node of nodes) {
    for (const produced of node.produces) {
      const existing = producers.get(produced);
      if (existing !== undefined) {
        throw new OperationDagError(
          "output_conflict",
          `binding ${produced} is produced by both ${existing} and ${node.node_id}`,
        );
      }
      producers.set(produced, node.node_id);
    }
  }
  for (const node of nodes) {
    for (const consumed of node.consumes) {
      if (!producers.has(consumed)) {
        throw new OperationDagError(
          "unsatisfied_input",
          `dag node ${node.node_id} consumes ${consumed}, which no node produces`,
        );
      }
    }
  }
}
