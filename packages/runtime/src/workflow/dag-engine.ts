import {
  contentDigest,
  validateOperationDag,
  type BindingKind,
  type OperationDagNode,
} from "@universal-harness-internal/core";

import type {
  DagApprovalNotice,
  DagCheckpointEntry,
  DagCheckpointStore,
  DagEngineEvent,
  DagNodeContext,
  DagNodeRunner,
  DagRunnerRegistry,
} from "./dag.js";

/**
 * DAG execution engine (plan Task 8-A; slim-profiles design 9.5). Executes
 * exactly the nodes a CapabilityPlan DAG contains, in dependency order, with
 * one authoritative checkpoint per committed node. The engine understands
 * only the DAG, the runner contract, the checkpoint journal and typed
 * results — it carries no profile names and no per-tier branches.
 *
 * Resume and invalidation share one mechanism: the journal is replayed entry
 * by entry, and an entry is accepted only when the node's id, wiring digest
 * and resolved inputs all match the current DAG. The first mismatch rewinds
 * the journal to that point and re-executes the tail, which makes a
 * capability upgrade (new nodes, rewired inputs) invalidate the earliest
 * necessary node and recover deterministically.
 */
export const DAG_ENGINE_ERROR_KINDS = [
  "missing_node_runner",
  "module_node_without_capability",
  "runner_output_mismatch",
] as const;

export type DagEngineErrorKind = (typeof DAG_ENGINE_ERROR_KINDS)[number];

export class DagEngineError extends Error {
  readonly kind: DagEngineErrorKind;

  constructor(kind: DagEngineErrorKind, message: string) {
    super(message);
    this.name = "DagEngineError";
    this.kind = kind;
  }
}

export type DagRunOutcome =
  | {
      readonly status: "paused";
      readonly operation_id: string;
      readonly node_id: string;
      readonly reason: "until_phase";
      readonly executed_nodes: readonly string[];
      readonly replayed_nodes: readonly string[];
    }
  | {
      readonly status: "replan_required";
      readonly operation_id: string;
      readonly node_id: string;
      readonly next_plan_digest: string;
      readonly executed_nodes: readonly string[];
      readonly replayed_nodes: readonly string[];
    }
  | {
      readonly status: "completed";
      readonly operation_id: string;
      /** Nodes whose runners executed during this run, in execution order. */
      readonly executed_nodes: readonly string[];
      /** Nodes accepted from the checkpoint journal without re-execution. */
      readonly replayed_nodes: readonly string[];
    }
  | {
      readonly status: "awaiting_approval";
      readonly operation_id: string;
      readonly node_id: string;
      readonly approval: DagApprovalNotice;
    }
  | {
      readonly status: "blocked";
      readonly operation_id: string;
      readonly node_id: string;
      readonly reason: string;
      readonly detail: string;
    }
  | {
      readonly status: "failed";
      readonly operation_id: string;
      readonly node_id: string;
      readonly message: string;
    };

export interface DagRunRequest {
  readonly operation_id: string;
  /** Digest of the CapabilityPlan revision being executed. */
  readonly plan_digest: string;
  readonly nodes: readonly OperationDagNode[];
}

export interface WorkflowDagEngineConfig {
  readonly store: DagCheckpointStore;
  readonly runners: DagRunnerRegistry;
  readonly onEvent?: (event: DagEngineEvent) => void;
  /** Deterministic by default; injectable for hosts that mint their own ids. */
  readonly newCheckpointId?: (operationId: string, nodeId: string, sequence: number) => string;
}

/** The node shape that must survive a resume unchanged for a replay to hit. */
function wiringDigest(node: OperationDagNode): string {
  return contentDigest({
    node_id: node.node_id,
    node_kind: node.node_kind,
    ...(node.capability_id === undefined ? {} : { capability_id: node.capability_id }),
    depends_on: [...node.depends_on],
    consumes: [...node.consumes],
    produces: [...node.produces],
    ...(node.subgraph === undefined ? {} : { subgraph: node.subgraph }),
  });
}

function recordDigestsEqual(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function canonicalDigests(digests: ReadonlyMap<string, string>): Record<string, string> {
  return Object.fromEntries([...digests.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * Deterministic topological order: Kahn's algorithm with the declaration
 * order as the stable tie-break, so the same DAG always executes identically.
 */
function topologicalOrder(nodes: readonly OperationDagNode[]): OperationDagNode[] {
  const indegree = new Map(nodes.map((node) => [node.node_id, node.depends_on.length]));
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dependency of node.depends_on) {
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), node.node_id]);
    }
  }
  const byId = new Map(nodes.map((node) => [node.node_id, node]));
  const ready = nodes.filter((node) => node.depends_on.length === 0).map((node) => node.node_id);
  const ordered: OperationDagNode[] = [];
  while (ready.length > 0) {
    const current = ready.shift() as string;
    const node = byId.get(current);
    if (node === undefined) break;
    ordered.push(node);
    for (const dependent of dependents.get(current) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) ready.push(dependent);
    }
  }
  return ordered;
}

export class WorkflowDagEngine {
  private readonly config: WorkflowDagEngineConfig;

  constructor(config: WorkflowDagEngineConfig) {
    this.config = config;
  }

  private emit(event: DagEngineEvent): void {
    this.config.onEvent?.(event);
  }

  private resolveRunner(node: OperationDagNode): DagNodeRunner {
    if (node.node_kind === "kernel") {
      const runner = this.config.runners.kernel[node.node_id];
      if (runner === undefined) {
        throw new DagEngineError(
          "missing_node_runner",
          `no kernel runner registered for dag node ${node.node_id}`,
        );
      }
      return runner;
    }
    if (node.capability_id === undefined) {
      throw new DagEngineError(
        "module_node_without_capability",
        `module dag node ${node.node_id} carries no capability identity`,
      );
    }
    const runner = this.config.runners.modules?.[node.capability_id];
    if (runner === undefined) {
      throw new DagEngineError(
        "missing_node_runner",
        `no module runner registered for capability ${node.capability_id} (node ${node.node_id})`,
      );
    }
    return runner;
  }

  async run(request: DagRunRequest): Promise<DagRunOutcome> {
    // Fail closed on structurally invalid plans before any runner executes.
    validateOperationDag(request.nodes);
    const ordered = topologicalOrder(request.nodes);
    const journal = [...(await this.config.store.load(request.operation_id))];

    // Replay the journal against the current DAG: the first node whose
    // checkpoint entry no longer matches (identity, wiring or resolved
    // inputs) is the invalidation point; the journal rewinds to it.
    const produced = new Map<BindingKind, string>();
    let journalIndex = 0;
    let resumeAt = ordered.length;
    const replayedNodes: string[] = [];
    for (const [index, node] of ordered.entries()) {
      if (!node.checkpoint) {
        resumeAt = index;
        break;
      }
      const inputs = new Map<BindingKind, string>();
      let resolvable = true;
      for (const kind of node.consumes) {
        const digest = produced.get(kind);
        if (digest === undefined) {
          resolvable = false;
          break;
        }
        inputs.set(kind, digest);
      }
      const entry = journal[journalIndex];
      const outputsComplete =
        entry !== undefined &&
        node.produces.every((kind) => entry.output_digests[kind] !== undefined);
      const matches =
        resolvable &&
        outputsComplete &&
        entry !== undefined &&
        entry.node_id === node.node_id &&
        entry.wiring_digest === wiringDigest(node) &&
        recordDigestsEqual(entry.input_digests, canonicalDigests(inputs));
      if (!matches) {
        resumeAt = index;
        break;
      }
      journalIndex += 1;
      replayedNodes.push(node.node_id);
      for (const kind of node.produces) {
        produced.set(kind, entry.output_digests[kind] as string);
      }
      this.emit({ type: "node_replayed", node_id: node.node_id });
    }
    if (journalIndex < journal.length) {
      await this.config.store.truncate(request.operation_id, journalIndex);
    }

    const executedNodes: string[] = [];
    for (const node of ordered.slice(resumeAt)) {
      const inputs = new Map<BindingKind, string>();
      for (const kind of node.consumes) {
        const digest = produced.get(kind);
        if (digest === undefined) {
          // validateOperationDag guarantees a producer exists in the DAG; an
          // unresolvable input here means the producer declared the binding
          // but its runner did not commit it, which is a contract violation.
          throw new DagEngineError(
            "runner_output_mismatch",
            `node ${node.node_id} consumes ${kind}, but no committed output provides it`,
          );
        }
        inputs.set(kind, digest);
      }
      const runner = this.resolveRunner(node);
      const context: DagNodeContext = {
        operation_id: request.operation_id,
        plan_digest: request.plan_digest,
        node,
        inputs: canonicalDigests(inputs),
      };
      this.emit({ type: "node_started", node_id: node.node_id });
      let result;
      try {
        result = await runner(context);
      } catch (error) {
        // Crash boundary: the node is not committed, so a resume re-runs it.
        return {
          status: "failed",
          operation_id: request.operation_id,
          node_id: node.node_id,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (result.status === "awaiting_approval") {
        return {
          status: "awaiting_approval",
          operation_id: request.operation_id,
          node_id: node.node_id,
          approval: result.approval,
        };
      }
      if (result.status === "blocked") {
        return {
          status: "blocked",
          operation_id: request.operation_id,
          node_id: node.node_id,
          reason: result.reason,
          detail: result.detail,
        };
      }
      if (
        result.status === "plan_superseded" &&
        (!node.checkpoint || !/^[a-f0-9]{64}$/u.test(result.next_plan_digest))
      ) {
        throw new DagEngineError(
          "runner_output_mismatch",
          `runner for ${node.node_id} returned a non-durable or malformed superseding plan`,
        );
      }
      const outputs = new Map<BindingKind, string>();
      for (const binding of result.produces ?? []) {
        if (!node.produces.includes(binding.kind)) {
          throw new DagEngineError(
            "runner_output_mismatch",
            `runner for ${node.node_id} produced ${binding.kind}, which the DAG never declared`,
          );
        }
        outputs.set(binding.kind, binding.digest);
      }
      for (const kind of node.produces) {
        if (!outputs.has(kind)) {
          throw new DagEngineError(
            "runner_output_mismatch",
            `runner for ${node.node_id} did not produce declared output ${kind}`,
          );
        }
      }
      for (const [kind, digest] of outputs) produced.set(kind, digest);
      executedNodes.push(node.node_id);
      if (node.checkpoint) {
        const sequence = journalIndex + 1;
        const checkpointId = (
          this.config.newCheckpointId ??
          ((operationId, nodeId, seq) =>
            `checkpoint_${contentDigest({ operationId, nodeId, seq }).slice(0, 16)}`)
        )(request.operation_id, node.node_id, sequence);
        const entry: DagCheckpointEntry = {
          sequence,
          node_id: node.node_id,
          plan_digest: request.plan_digest,
          wiring_digest: wiringDigest(node),
          input_digests: canonicalDigests(inputs),
          output_digests: canonicalDigests(outputs),
          checkpoint_id: checkpointId,
        };
        await this.config.store.append(request.operation_id, entry);
        journalIndex += 1;
        this.emit({ type: "node_committed", node_id: node.node_id, checkpoint_id: checkpointId });
      }
      if (result.status === "plan_superseded") {
        return {
          status: "replan_required",
          operation_id: request.operation_id,
          node_id: node.node_id,
          next_plan_digest: result.next_plan_digest,
          executed_nodes: executedNodes,
          replayed_nodes: replayedNodes,
        };
      }
      if (result.status === "paused") {
        return {
          status: "paused",
          operation_id: request.operation_id,
          node_id: node.node_id,
          reason: result.reason,
          executed_nodes: executedNodes,
          replayed_nodes: replayedNodes,
        };
      }
    }
    return {
      status: "completed",
      operation_id: request.operation_id,
      executed_nodes: executedNodes,
      replayed_nodes: replayedNodes,
    };
  }
}
