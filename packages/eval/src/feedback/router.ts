import type { FeedbackRecord, NodeRecord } from "@universal-harness-internal/core";
import type { TaskRisk, TaskSpecification } from "@universal-harness-internal/runtime";

import { FeedbackError } from "./finding.js";
import { readRootCauseContent } from "./rca.js";

/**
 * Deterministic owner-phase routing (design 9.1 and principle 5, plan Task
 * 21). Every repair target resolves to one of eight target layers; each
 * layer has exactly one owning phase and a fixed set of owning node types.
 * A downstream phase may never write an upstream artifact directly -- it
 * creates a Finding and the Workflow Engine routes a revision Task back to
 * the owner phase. Routing predicates are deterministic code; no model
 * output can select a privileged route.
 */
export const TARGET_LAYERS = [
  "prd",
  "architecture",
  "spec",
  "plan",
  "policy",
  "tool",
  "test",
  "eval",
] as const;

export type TargetLayer = (typeof TARGET_LAYERS)[number];

/** Owning node types per target layer (design 9.1 table). */
export const OWNING_NODE_TYPES: Readonly<Record<TargetLayer, readonly NodeRecord["type"][]>> = {
  prd: ["Intent", "Requirement"],
  architecture: ["Decision", "Component"],
  spec: ["Requirement", "Constraint", "Test"],
  plan: ["ExecutionPlan", "Task"],
  policy: ["Policy", "Constraint"],
  tool: ["ToolDefinition"],
  test: ["Test"],
  eval: ["EvaluationCase"],
};

/** Delivery phases in pipeline order; verification is the most downstream. */
export const DELIVERY_PHASES = [
  "prd",
  "architecture",
  "spec",
  "plan",
  "implementation",
  "verification",
] as const;

export type DeliveryPhase = (typeof DELIVERY_PHASES)[number];

/** The single phase that owns revisions of each target layer. */
export const OWNER_PHASE: Readonly<Record<TargetLayer, DeliveryPhase>> = {
  prd: "prd",
  architecture: "architecture",
  spec: "spec",
  plan: "plan",
  policy: "architecture",
  tool: "plan",
  test: "verification",
  eval: "verification",
};

export function ownerPhaseForLayer(layer: TargetLayer): DeliveryPhase {
  return OWNER_PHASE[layer];
}

function phaseRank(phase: DeliveryPhase): number {
  return DELIVERY_PHASES.indexOf(phase);
}

/**
 * Write guard (completion rule 17): a phase may write artifacts of its own
 * layer or of downstream layers, but never artifacts owned upstream. A
 * forbidden write is rejected with a typed error whose remedy is the
 * feedback protocol: create a Finding and let the Workflow Engine route a
 * revision Task to the owner phase.
 */
export function assertWriteAllowed(writer: DeliveryPhase, targetLayer: TargetLayer): void {
  const owner = ownerPhaseForLayer(targetLayer);
  if (phaseRank(writer) > phaseRank(owner)) {
    throw new FeedbackError(
      "upstream_write_forbidden",
      `phase ${writer} must not modify ${targetLayer} artifacts owned by phase ${owner}; create a Finding and route a revision task instead`,
    );
  }
}

export interface RevisionTaskRequest {
  /** Structured diagnosis this repair answers. */
  readonly rca: FeedbackRecord;
  /** Owning node ids the revision is expected to produce or revise. */
  readonly targetNodeIds: readonly string[];
  /** Approved ImpactSet entry paths the revision binds to. */
  readonly impactPaths?: readonly (readonly string[])[];
  readonly taskId: string;
  readonly risk?: TaskRisk;
  readonly requiredGates?: readonly string[];
}

export interface RepairRouting {
  readonly owner_phase: DeliveryPhase;
  readonly responsible_layer: TargetLayer;
  readonly task: TaskSpecification;
}

const REVISION_TASK_BUDGET = { steps: 20, tokens: 20_000 } as const;

/**
 * Route a diagnosed repair to the owner phase as a declarative revision
 * Task. The task is fully determined by the RCA: its objective names the
 * category and layer, its acceptance criterion is the RCA's proposed
 * verification, and its expected outputs are the owning nodes to revise.
 * Low-confidence or high-risk diagnoses escalate the task risk.
 */
export function routeRevisionTask(request: RevisionTaskRequest): RepairRouting {
  const content = readRootCauseContent(request.rca);
  const expectedOutputs = [...new Set(request.targetNodeIds)].sort();
  if (expectedOutputs.length === 0) {
    throw new FeedbackError(
      "invalid_revision_task",
      `revision task for ${request.rca.id} needs at least one target node`,
    );
  }
  const ownerPhase = ownerPhaseForLayer(content.responsible_layer);
  const task: TaskSpecification = {
    id: request.taskId,
    objective:
      `Revise ${content.responsible_layer} artifacts to resolve ` +
      `${content.category} diagnosed in ${content.finding_id}`,
    impact_paths: request.impactPaths ?? [],
    expected_outputs: expectedOutputs,
    capabilities: [],
    tools: [],
    dependencies: [],
    risk: request.risk ?? (content.requires_human_review ? "high" : "medium"),
    budget: REVISION_TASK_BUDGET,
    acceptance: [
      { description: content.proposed_verification, verification: content.proposed_verification },
    ],
    required_gates: request.requiredGates ?? [],
  };
  return { owner_phase: ownerPhase, responsible_layer: content.responsible_layer, task };
}
