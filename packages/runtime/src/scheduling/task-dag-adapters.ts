import type { EdgeRecord, NodeRecord } from "@universal-harness-internal/core";

import {
  readExecutionPlanContent,
  type ExecutionPlanGraphProjection,
} from "../planning/execution-plan.js";
import type { Protocol13TaskSpecification } from "../planning/task.js";
import { assertParallelWaves } from "../planning/waves.js";
import { SchedulingPortError, type TaskDagPort, type TaskDagSnapshot } from "./ports.js";

/**
 * TaskDagPort Adapters (design §5.1, plan Task 4 step 2). The Workflow Adapter
 * wraps narrow read functions over the Workflow Engine/Ledger projection; the
 * InMemory Adapter serves an immutable fixture for conformance and fault
 * injection. Both funnel every read through the same assertTaskDagSnapshot()
 * guard, which recomputes Task semantic digests, edge-set equality and the
 * deterministic waves on every call — the Graph projection is never trusted
 * as a second, independently editable truth.
 *
 * Neither Adapter receives — or could smuggle — a write capability: the
 * Workflow Adapter's inputs are read-only functions, and the InMemory
 * Adapter's fixture is deep-frozen at construction.
 */

/** Everything the shared guard needs to trust a snapshot. */
export interface TaskDagGuardInput {
  readonly operation_id: string;
  /** The ExecutionPlan node as read from the Workflow projection. */
  readonly plan: NodeRecord;
  /** The plan's exact Task node projection. */
  readonly task_nodes: readonly NodeRecord[];
  /** The plan's exact CONTAINS + DEPENDS_ON edge projection. */
  readonly edges: readonly EdgeRecord[];
  /** The baseline commit the Workflow Engine currently binds as approved. */
  readonly current_baseline_commit: string;
  readonly expected_plan_digest?: string;
}

/**
 * Fail-closed guard shared by every TaskDagPort Adapter. Throws a typed
 * SchedulingPortError for approval, digest, baseline and protocol violations;
 * PlanningError (plan_projection_drift / wave_drift) propagates from the
 * plan-content reader for projection drift. Returns the canonical snapshot.
 */
export function assertTaskDagSnapshot(input: TaskDagGuardInput): TaskDagSnapshot {
  if (input.plan.type !== "ExecutionPlan") {
    throw new SchedulingPortError(
      "plan_not_found",
      `operation ${input.operation_id} does not bind an ExecutionPlan node (got ${input.plan.type})`,
    );
  }
  if (input.plan.status !== "accepted") {
    throw new SchedulingPortError(
      "plan_not_approved",
      `execution plan ${input.plan.id} is "${input.plan.status}"; only an approved (accepted) plan may be scheduled`,
    );
  }
  const projection: ExecutionPlanGraphProjection = {
    tasks: input.task_nodes,
    edges: input.edges,
  };
  // The 1.3 path re-computes every Task semantic digest, byte-compares the
  // CONTAINS/DEPENDS_ON edge set and recompiles the persisted waves.
  const content = readExecutionPlanContent(input.plan, projection);
  if (content.parallel_waves === undefined || content.iteration_budget === undefined) {
    throw new SchedulingPortError(
      "legacy_plan",
      `execution plan ${input.plan.id} is a legacy sequential plan; parallel scheduling requires a protocol 1.3 plan`,
    );
  }
  if (
    input.expected_plan_digest !== undefined &&
    input.expected_plan_digest !== content.content_digest
  ) {
    throw new SchedulingPortError(
      "plan_digest_drift",
      `expected plan digest ${input.expected_plan_digest} drifted from the approved plan content ${content.content_digest}`,
    );
  }
  const baseline = content.shared_context.baseline_commit;
  if (baseline === undefined || baseline === "") {
    throw new SchedulingPortError(
      "baseline_drift",
      `execution plan ${input.plan.id} carries no baseline_commit binding`,
    );
  }
  if (baseline !== input.current_baseline_commit) {
    throw new SchedulingPortError(
      "baseline_drift",
      `execution plan ${input.plan.id} binds baseline ${baseline} but the currently approved baseline is ${input.current_baseline_commit}`,
    );
  }
  const tasks = content.tasks as readonly Protocol13TaskSpecification[];
  // Guard contract: recompute the waves on every read, independently of the
  // reader's internal check.
  assertParallelWaves(tasks, content.parallel_waves);
  return {
    operation_id: input.operation_id,
    iteration_id: input.plan.provenance.iteration_id,
    plan_id: input.plan.id,
    plan_digest: content.content_digest,
    baseline_commit: baseline,
    tasks,
    parallel_waves: content.parallel_waves,
    iteration_budget: content.iteration_budget,
  };
}

/**
 * Narrow read functions over the Workflow Engine projection. This is the only
 * surface the production Adapter sees — no Ledger, transaction or mutation
 * handle exists in this shape.
 */
export interface WorkflowTaskDagReads {
  /** The approved ExecutionPlan node bound to the operation, if any. */
  readonly readPlan: (operationId: string) => NodeRecord | undefined;
  /** The exact Task node projection of one plan. */
  readonly readTaskNodes: (planId: string) => readonly NodeRecord[];
  /** The exact CONTAINS + DEPENDS_ON edge projection of one plan. */
  readonly readEdgeRecords: (planId: string) => readonly EdgeRecord[];
  /** The baseline commit currently approved for the operation, if any. */
  readonly readApprovedBaseline: (operationId: string) => string | undefined;
}

/** Production Adapter over the Workflow Engine/Ledger read projection. */
export function createWorkflowTaskDagAdapter(reads: WorkflowTaskDagReads): TaskDagPort {
  return {
    name: "workflow-task-dag",
    async readApproved(input) {
      const plan = reads.readPlan(input.operation_id);
      if (plan === undefined) {
        throw new SchedulingPortError(
          "plan_not_found",
          `operation ${input.operation_id} has no approved execution plan`,
        );
      }
      const baseline = reads.readApprovedBaseline(input.operation_id);
      if (baseline === undefined) {
        throw new SchedulingPortError(
          "baseline_drift",
          `operation ${input.operation_id} has no currently approved baseline`,
        );
      }
      return assertTaskDagSnapshot({
        operation_id: input.operation_id,
        plan,
        task_nodes: reads.readTaskNodes(plan.id),
        edges: reads.readEdgeRecords(plan.id),
        current_baseline_commit: baseline,
        ...(input.expected_plan_digest === undefined
          ? {}
          : { expected_plan_digest: input.expected_plan_digest }),
      });
    },
  };
}

/** Immutable arrangement the InMemory Adapter serves. */
export interface InMemoryTaskDagFixture {
  readonly operation_id: string;
  readonly baseline_commit: string;
  readonly plan: NodeRecord;
  readonly task_nodes: readonly NodeRecord[];
  readonly edges: readonly EdgeRecord[];
}

function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  for (const entry of Object.values(value)) deepFreeze(entry);
  Object.freeze(value);
}

/**
 * Conformance/fault-injection Adapter. The fixture is deep-frozen at
 * construction, and every read runs the full assertTaskDagSnapshot() guard —
 * the InMemory Adapter is never a weaker truth than the production one.
 */
export function createInMemoryTaskDagPort(fixture: InMemoryTaskDagFixture): TaskDagPort {
  deepFreeze(fixture);
  return {
    name: "in-memory-task-dag",
    async readApproved(input) {
      if (input.operation_id !== fixture.operation_id) {
        throw new SchedulingPortError(
          "plan_not_found",
          `operation ${input.operation_id} has no approved execution plan`,
        );
      }
      return assertTaskDagSnapshot({
        operation_id: fixture.operation_id,
        plan: fixture.plan,
        task_nodes: fixture.task_nodes,
        edges: fixture.edges,
        current_baseline_commit: fixture.baseline_commit,
        ...(input.expected_plan_digest === undefined
          ? {}
          : { expected_plan_digest: input.expected_plan_digest }),
      });
    },
  };
}
