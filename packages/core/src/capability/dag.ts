import type { BindingKind } from "../schema/capability.js";
import type { CapabilityId } from "../schema/profile.js";
import { capabilityModuleDefinition } from "./registry.js";

/**
 * Operation DAG construction and validation (slim-profiles design 9.4). The
 * Kernel nodes form a fixed spine; modules contribute nodes at fixed
 * positions only when the CapabilityPlan activates them. strict_tdd stays a
 * subgraph inside `execute`, never a global phase, and the generic tail is
 * always `verify → [evaluate?] → snapshot`.
 */
export interface OperationDagNode {
  readonly node_id: string;
  readonly node_kind: "kernel" | "module";
  readonly capability_id?: CapabilityId;
  readonly depends_on: readonly string[];
  readonly consumes: readonly BindingKind[];
  readonly produces: readonly BindingKind[];
  readonly checkpoint: boolean;
  readonly subgraph?: "strict_tdd";
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
  consumes: readonly BindingKind[],
  produces: readonly BindingKind[],
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
): OperationDagNode {
  const module = capabilityModuleDefinition(capabilityId);
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
 * no node, no bindings and no checkpoint — nothing exists to invoke.
 */
export function buildOperationDag(active: ReadonlySet<CapabilityId>): OperationDagNode[] {
  const nodes: OperationDagNode[] = [
    kernelNode("capture", [], [], ["requirement_baseline"]),
    kernelNode("capability_decision", ["capture"], ["requirement_baseline"], []),
  ];
  if (active.has("impact_analysis")) {
    nodes.push(moduleNode("impact_analysis", "impact", ["capability_decision"]));
  }
  if (active.has("design_governance")) {
    nodes.push(moduleNode("design_governance", "design", ["impact"]));
  }
  const planDependsOn = ["capability_decision"];
  const planConsumes: BindingKind[] = ["requirement_baseline"];
  if (active.has("impact_analysis")) {
    planDependsOn.push("impact");
    planConsumes.push("impact_set");
  }
  if (active.has("design_governance")) {
    planDependsOn.push("design");
    planConsumes.push("design_set");
  }
  nodes.push(kernelNode("plan", planDependsOn, planConsumes, ["execution_plan"]));

  const contextConsumes: BindingKind[] = ["execution_plan"];
  if (active.has("design_governance")) {
    contextConsumes.push("design_set");
  }
  nodes.push(kernelNode("context", ["plan"], contextConsumes, ["context_bundle"]));

  const strictTdd = active.has("strict_tdd");
  const executeConsumes: BindingKind[] = ["context_bundle"];
  const executeProduces: BindingKind[] = [];
  if (strictTdd) {
    executeConsumes.push("design_set");
    executeProduces.push("tdd_contract");
  }
  nodes.push({
    ...kernelNode("execute", ["context"], executeConsumes, executeProduces),
    ...(strictTdd ? { subgraph: "strict_tdd" as const } : {}),
  });

  nodes.push(kernelNode("verify", ["execute"], ["context_bundle"], ["gate_evidence"]));

  const evaluation = active.has("independent_evaluation");
  if (evaluation) {
    nodes.push(moduleNode("independent_evaluation", "evaluate", ["verify"]));
  }
  const snapshotDependsOn = evaluation ? ["verify", "evaluate"] : ["verify"];
  const snapshotConsumes: BindingKind[] = evaluation
    ? ["gate_evidence", "evaluation_report"]
    : ["gate_evidence"];
  nodes.push(kernelNode("snapshot", snapshotDependsOn, snapshotConsumes, ["snapshot"]));

  if (active.has("advanced_audit")) {
    nodes.push(moduleNode("advanced_audit", "audit", ["snapshot"]));
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

  const producers = new Map<BindingKind, string>();
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
