import {
  PROTOCOL_VERSION,
  contentDigest,
  type EdgeRecord,
  type NodeRecord,
} from "@universal-harness-internal/core";
import { assertApprovedImpactSet, readImpactSetContent } from "@universal-harness-internal/graph";

import { selectExecutionMode, type ExecutionMode, type IntentShape } from "./mode-selector.js";
import type { TaskSpecification } from "./task.js";
import { PlanningError, validatePlanProposal, type PlannerConstraints } from "./validator.js";

/**
 * ExecutionPlan compilation (design 9 step 6 and 10.1; completion rule 8).
 * Planning starts only from an ImpactSet frozen by an approval whose digest
 * still verifies; the planner proposal is validated into declarative Task
 * Specifications and compiled into an ExecutionPlan node, one Task node per
 * specification, CONTAINS edges from plan to task and DEPENDS_ON edges
 * between tasks. The content digest is metadata-free, so replanning the same
 * approved set with the same proposal reproduces the exact same plan.
 */
export const PLAN_EXTENSION_KEY = "harness.plan";

/** Immutable digests every task shares; nothing mutable crosses task boundaries. */
export interface PlanSharedContext {
  readonly goal: string;
  readonly requirement_baseline_digest: string;
  readonly policy_digest: string;
}

/** Canonical, metadata-free ExecutionPlan content. */
export interface ExecutionPlanContent {
  readonly content_digest: string;
  readonly mode: ExecutionMode;
  readonly mode_reason: string;
  readonly restricted: boolean;
  readonly impact_set_id: string;
  readonly impact_set_digest: string;
  readonly shared_context: PlanSharedContext;
  readonly tasks: readonly TaskSpecification[];
}

export interface PlanContext {
  readonly iterationId: string;
  readonly actor: string;
  readonly timestamp: string;
}

export interface PlanGenerationInput {
  readonly intentShape: IntentShape;
  readonly hasExistingGraph: boolean;
  readonly deterministicWork: boolean;
  readonly shared: PlanSharedContext;
  /** Untrusted planner output; validated before anything is planned. */
  readonly proposal: readonly unknown[];
  readonly constraints: PlannerConstraints;
}

export interface ExecutionPlanRecords {
  readonly plan: NodeRecord;
  readonly tasks: readonly NodeRecord[];
  readonly edges: readonly EdgeRecord[];
}

function digestContent(content: Omit<ExecutionPlanContent, "content_digest">): string {
  // contentDigest canonicalizes key order, so the whole metadata-free base
  // object digests identically regardless of construction order.
  return contentDigest(content);
}

/** Every approved ImpactSet entry path, canonicalized for binding checks. */
function approvedPaths(impactSet: NodeRecord): Set<string> {
  const content = readImpactSetContent(impactSet);
  return new Set(content.entries.map((entry) => JSON.stringify(entry.path)));
}

/** Paths of approved entries classified `must-change`; all must be covered. */
function mustChangePaths(impactSet: NodeRecord): Set<string> {
  const content = readImpactSetContent(impactSet);
  return new Set(
    content.entries
      .filter((entry) => entry.classification === "must-change")
      .map((entry) => JSON.stringify(entry.path)),
  );
}

function assertBoundToApprovedImpactSet(
  tasks: readonly TaskSpecification[],
  impactSet: NodeRecord,
): void {
  const approved = approvedPaths(impactSet);
  const covered = new Set<string>();
  for (const task of tasks) {
    for (const path of task.impact_paths) {
      const key = JSON.stringify(path);
      if (!approved.has(key)) {
        throw new PlanningError(
          "invalid_specification",
          `task ${task.id} binds a path that is not part of the approved impact set ${impactSet.id}`,
        );
      }
      covered.add(key);
    }
  }
  for (const required of mustChangePaths(impactSet)) {
    if (!covered.has(required)) {
      throw new PlanningError(
        "invalid_specification",
        `plan leaves a must-change entry of impact set ${impactSet.id} without an owning task`,
      );
    }
  }
}

function nodeRecord(
  context: PlanContext,
  spec: {
    readonly id: string;
    readonly type: "ExecutionPlan" | "Task";
    readonly extensions: Record<string, unknown>;
  },
): NodeRecord {
  const record: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "node",
    id: spec.id,
    type: spec.type,
    revision: 1,
    status: "proposed",
    source: "workflow",
    provenance: {
      iteration_id: context.iterationId,
      actor: context.actor,
      timestamp: context.timestamp,
    },
    confidence: 1,
    extensions: { [PLAN_EXTENSION_KEY]: spec.extensions },
  };
  return { ...record, digest: contentDigest(record) } as unknown as NodeRecord;
}

function edgeRecord(
  context: PlanContext,
  spec: {
    readonly type: "CONTAINS" | "DEPENDS_ON";
    readonly sourceId: string;
    readonly targetId: string;
  },
): EdgeRecord {
  const record: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "edge",
    id: `edge_${contentDigest({ type: spec.type, source: spec.sourceId, target: spec.targetId }).slice(0, 16)}`,
    type: spec.type,
    source_id: spec.sourceId,
    target_id: spec.targetId,
    status: "proposed",
    source: "workflow",
    provenance: {
      iteration_id: context.iterationId,
      actor: context.actor,
      timestamp: context.timestamp,
    },
    confidence: 1,
  };
  return { ...record, digest: contentDigest(record) } as unknown as EdgeRecord;
}

/** Read the canonical content of an ExecutionPlan node, or throw. */
export function readExecutionPlanContent(plan: NodeRecord): ExecutionPlanContent {
  if (plan.type !== "ExecutionPlan") {
    throw new PlanningError(
      "invalid_specification",
      `expected an ExecutionPlan node, got ${plan.type}`,
    );
  }
  const content = plan.extensions?.[PLAN_EXTENSION_KEY];
  if (typeof content !== "object" || content === null) {
    throw new PlanningError(
      "invalid_specification",
      `execution plan ${plan.id} carries no ${PLAN_EXTENSION_KEY} content`,
    );
  }
  return content as ExecutionPlanContent;
}

/**
 * Compile an approved ImpactSet into a declarative ExecutionPlan. The
 * approved-set guard runs first — an unfrozen or drifted set throws before
 * the proposal is even read. The proposal is then validated (declarative
 * shape only, known tools and gates, authorized capabilities, acyclic,
 * independent value), bound to the approved impact paths and compiled into
 * deterministic records.
 */
export function generateExecutionPlan(
  impactSet: NodeRecord,
  approvedContentDigest: string,
  input: PlanGenerationInput,
  context: PlanContext,
): ExecutionPlanRecords {
  assertApprovedImpactSet(impactSet, approvedContentDigest);
  const tasks = validatePlanProposal(input.proposal, input.constraints);
  assertBoundToApprovedImpactSet(tasks, impactSet);
  const selection = selectExecutionMode({
    intentShape: input.intentShape,
    hasExistingGraph: input.hasExistingGraph,
    deterministicWork: input.deterministicWork,
    taskCount: tasks.length,
  });
  const base = {
    mode: selection.mode,
    mode_reason: selection.reason,
    restricted: selection.restricted,
    impact_set_id: impactSet.id,
    impact_set_digest: approvedContentDigest,
    shared_context: input.shared,
    tasks,
  };
  const content: ExecutionPlanContent = { ...base, content_digest: digestContent(base) };
  const planId = `plan_${content.content_digest.slice(0, 16)}`;
  const plan = nodeRecord(context, {
    id: planId,
    type: "ExecutionPlan",
    extensions: content as unknown as Record<string, unknown>,
  });
  const taskNodes = tasks.map((task) =>
    nodeRecord(context, {
      id: task.id,
      type: "Task",
      extensions: task as unknown as Record<string, unknown>,
    }),
  );
  const edges: EdgeRecord[] = [
    ...tasks.map((task) =>
      edgeRecord(context, { type: "CONTAINS", sourceId: planId, targetId: task.id }),
    ),
    ...tasks.flatMap((task) =>
      task.dependencies.map((dependency) =>
        edgeRecord(context, { type: "DEPENDS_ON", sourceId: task.id, targetId: dependency }),
      ),
    ),
  ];
  return { plan, tasks: taskNodes, edges };
}
