import {
  PROTOCOL_VERSION,
  canonicalizeJson,
  contentDigest,
  type EdgeRecord,
  type NodeRecord,
} from "@universal-harness-internal/core";
import { assertApprovedImpactSet, readImpactSetContent } from "@universal-harness-internal/graph";

import type { AdapterControlProfile } from "../policy/action.js";
import { deriveEffectiveRisk, type GovernanceRisk, type PathScope } from "./effective-risk.js";
import {
  assessImpactCoverage,
  type ImpactCoverageAssessment,
  type PathForecast,
} from "./impact-coverage.js";
import {
  selectExecutionMode,
  type ExecutionKind,
  type ExecutionMode,
  type IntentShape,
} from "./mode-selector.js";
import {
  taskSemanticDigest,
  type IterationBudget,
  type Protocol13TaskBudget,
  type Protocol13TaskSpecification,
  type TaskSpecification,
} from "./task.js";
import { assessTaskSize, assertAgentPlanSize } from "./task-sizing.js";
import {
  PlanningError,
  assertProtocol13TaskSpecification,
  validatePlanProposal,
  type PlanProtocolMode,
  type PlannerConstraints,
} from "./validator.js";
import { compileParallelWaves, type ParallelWave } from "./waves.js";

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
  /**
   * Protocol 1.3 bindings (M4 design 6.2/17): the frozen baseline commit wave
   * 0 reads from, and the approved CapabilityPlan digest. Mandatory for
   * protocol 1.3 plans; legacy plans never carry them.
   */
  readonly baseline_commit?: string;
  readonly capability_plan_digest?: string;
}

/** Canonical, metadata-free ExecutionPlan content. */
export interface ExecutionPlanContent {
  readonly content_digest: string;
  readonly execution_kind: ExecutionKind;
  readonly impact_coverage: ImpactCoverageAssessment;
  readonly mode: ExecutionMode;
  readonly mode_reason: string;
  readonly restricted: boolean;
  readonly impact_set_id: string;
  readonly impact_set_digest: string;
  readonly shared_context: PlanSharedContext;
  readonly tasks: readonly TaskSpecification[];
  /**
   * Protocol 1.3 only: the runtime aggregate budget authority for this
   * iteration, proposed within the approved ceiling and frozen into the Plan
   * digest (M4 design 6.2). Never synthesized for legacy plans.
   */
  readonly iteration_budget?: IterationBudget;
  /**
   * Protocol 1.3 only: the deterministic parallel wave projection compiled
   * from `tasks`. Not independently editable; readers recompile and compare.
   */
  readonly parallel_waves?: readonly ParallelWave[];
}

export interface PlanContext {
  readonly iterationId: string;
  readonly actor: string;
  readonly timestamp: string;
}

/**
 * Approved budget ceilings and the proposed iteration aggregate (M4 design
 * 6.2). Required for protocol 1.3 plans: every Task budget must stay within
 * `task_ceiling` and the proposed `iteration` aggregate within
 * `iteration_ceiling`. The aggregate is the runtime authority; it is never
 * rejected merely because the sum of Task maxima is larger.
 */
export interface PlanBudgetBinding {
  readonly task_ceiling: Protocol13TaskBudget;
  readonly iteration_ceiling: IterationBudget;
  readonly iteration: IterationBudget;
}

export interface PlanGenerationInput {
  readonly executionKind: ExecutionKind;
  readonly intentShape: IntentShape;
  readonly hasExistingGraph: boolean;
  readonly deterministicWork: boolean;
  readonly shared: PlanSharedContext;
  /** Untrusted planner output; validated before anything is planned. */
  readonly proposal: readonly unknown[];
  readonly constraints: PlannerConstraints;
  /** Proposal contract; defaults to `legacy` (sequential-only plans). */
  readonly protocol?: PlanProtocolMode;
  /** Approved ceilings plus proposed iteration aggregate (protocol 1.3 only). */
  readonly budgets?: PlanBudgetBinding;
  readonly governance?: {
    /** Only paths independently approved by the control plane may set `approved`. */
    readonly forecastPaths?: readonly PathForecast[];
    readonly adapterProfile?: AdapterControlProfile;
  };
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

function approvedPathScope(forecasts: readonly PathForecast[]): PathScope {
  const approved = forecasts.filter((forecast) => forecast.approved);
  if (approved.some((forecast) => forecast.scope === "broad")) return "broad";
  if (approved.some((forecast) => forecast.scope === "bounded")) return "bounded";
  return "exact";
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

function assertAtomicAgentAcceptance(
  tasks: readonly TaskSpecification[],
  acceptedTestIds: readonly string[],
): void {
  const accepted = new Set(acceptedTestIds);
  const covered = new Set<string>();
  for (const task of tasks) {
    if (task.assertions === undefined || task.assertions.length === 0) {
      throw new PlanningError(
        "atomic_acceptance_required",
        `agent task ${task.id} has only legacy acceptance criteria and must be replanned`,
      );
    }
    for (const assertion of task.assertions) {
      for (const testId of assertion.test_ids) {
        if (!accepted.has(testId)) {
          throw new PlanningError(
            "uncovered_test",
            `assertion ${assertion.assertion_id} references unaccepted test ${testId}`,
          );
        }
        covered.add(testId);
      }
    }
  }
  for (const testId of acceptedTestIds) {
    if (!covered.has(testId)) {
      throw new PlanningError(
        "uncovered_test",
        `accepted test ${testId} is not covered by any task assertion`,
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

/** The deterministic Graph projection of a plan: its Task nodes and edges. */
export interface ExecutionPlanGraphProjection {
  readonly tasks: readonly NodeRecord[];
  readonly edges: readonly EdgeRecord[];
}

function assertProtocol13PlanConsistency(
  planId: string,
  content: ExecutionPlanContent,
  projection: ExecutionPlanGraphProjection | undefined,
): void {
  const waves = content.parallel_waves;
  const iterationBudget = content.iteration_budget;
  if (waves === undefined || iterationBudget === undefined) {
    // Both fields appear together or not at all; a half-bound plan is drift.
    throw new PlanningError(
      "plan_projection_drift",
      `execution plan ${planId} carries only part of the protocol 1.3 authority fields`,
    );
  }
  const tasks = content.tasks.map((task) => {
    assertProtocol13TaskSpecification(task);
    return task;
  });
  // Waves are a deterministic projection: a fresh compilation must
  // byte-match the persisted layout.
  if (canonicalizeJson(compileParallelWaves(tasks)) !== canonicalizeJson(waves)) {
    throw new PlanningError(
      "wave_drift",
      `execution plan ${planId} persisted parallel waves differ from a fresh compilation`,
    );
  }
  if (projection === undefined) {
    throw new PlanningError(
      "invalid_specification",
      `reading approved protocol 1.3 plan ${planId} requires its graph projection`,
    );
  }
  // Task nodes must byte-match the deterministic per-task projection,
  // including the recomputed semantic digest.
  const nodesById = new Map(projection.tasks.map((node) => [node.id, node]));
  if (nodesById.size !== tasks.length) {
    throw new PlanningError(
      "plan_projection_drift",
      `execution plan ${planId} graph projection carries a different task set`,
    );
  }
  for (const task of tasks) {
    const node = nodesById.get(task.id);
    if (node === undefined || node.type !== "Task") {
      throw new PlanningError(
        "plan_projection_drift",
        `execution plan ${planId} is missing the task node for ${task.id}`,
      );
    }
    const expected = canonicalizeJson({ ...task, semantic_digest: taskSemanticDigest(task) });
    if (canonicalizeJson(node.extensions?.[PLAN_EXTENSION_KEY] ?? null) !== expected) {
      throw new PlanningError(
        "plan_projection_drift",
        `task node ${task.id} of plan ${planId} differs from the approved specification`,
      );
    }
  }
  // CONTAINS and DEPENDS_ON are exact deterministic edge sets — a missing,
  // extra or reversed edge is drift, never a second editable truth.
  const edgeKey = (type: string, source: string, target: string): string =>
    `${type}|${source}|${target}`;
  const expectedEdges = [
    ...tasks.map((task) => edgeKey("CONTAINS", planId, task.id)),
    ...tasks.flatMap((task) =>
      task.dependencies.map((dependency) => edgeKey("DEPENDS_ON", task.id, dependency)),
    ),
  ].sort();
  const actualEdges = projection.edges
    .map((edge) => edgeKey(edge.type, edge.source_id, edge.target_id))
    .sort();
  if (canonicalizeJson(actualEdges) !== canonicalizeJson(expectedEdges)) {
    throw new PlanningError(
      "plan_projection_drift",
      `execution plan ${planId} graph edges differ from the approved task dependencies`,
    );
  }
}

/**
 * Read the canonical content of an ExecutionPlan node, or throw. Legacy
 * (pre-1.3) plans return as stored and never gain inferred resource claims.
 * A protocol 1.3 snapshot is only returned after its persisted waves are
 * recompiled and byte-compared, and its Task/CONTAINS/DEPENDS_ON graph
 * projection is byte-compared against the deterministic re-projection.
 */
export function readExecutionPlanContent(
  plan: NodeRecord,
  projection?: ExecutionPlanGraphProjection,
): ExecutionPlanContent {
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
  const planContent = content as ExecutionPlanContent;
  if (planContent.parallel_waves === undefined && planContent.iteration_budget === undefined) {
    return planContent;
  }
  assertProtocol13PlanConsistency(plan.id, planContent, projection);
  return planContent;
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
  return compileExecutionPlan(impactSet, approvedContentDigest, input, context);
}

/**
 * T9: the kernel-only Lite planning entry. The impact set comes from the
 * deterministic propagation of the iteration seed — never persisted, approved
 * or frozen — so the approval guard does not apply; every other plan
 * invariant (declarative shape, coverage, acyclicity, path binding) still
 * runs unchanged.
 */
export function generateKernelExecutionPlan(
  impactSet: NodeRecord,
  input: PlanGenerationInput,
  context: PlanContext,
): ExecutionPlanRecords {
  return compileExecutionPlan(
    impactSet,
    readImpactSetContent(impactSet).content_digest,
    input,
    context,
  );
}

/**
 * Bind the protocol 1.3 plan authority (M4 design 6.2): shared-context
 * baseline/capability-plan digests must be present, every Task budget and the
 * proposed iteration aggregate must stay within the approved ceilings, and
 * the deterministic waves are compiled from the final task list. The
 * iteration aggregate is the runtime authority — the plan is never rejected
 * merely because the sum of Task maxima exceeds it.
 */
function bindProtocol13Authority(
  input: PlanGenerationInput,
  tasks: readonly TaskSpecification[],
): { readonly iterationBudget: IterationBudget; readonly parallelWaves: readonly ParallelWave[] } {
  if (typeof input.shared.baseline_commit !== "string" || input.shared.baseline_commit === "") {
    throw new PlanningError(
      "invalid_specification",
      "protocol 1.3 plans require a baseline_commit shared-context binding",
    );
  }
  if (
    typeof input.shared.capability_plan_digest !== "string" ||
    input.shared.capability_plan_digest === ""
  ) {
    throw new PlanningError(
      "invalid_specification",
      "protocol 1.3 plans require a capability_plan_digest shared-context binding",
    );
  }
  const budgets = input.budgets;
  if (budgets === undefined) {
    throw new PlanningError(
      "invalid_specification",
      "protocol 1.3 plans require the approved budget binding",
    );
  }
  const assertWithinCeiling = (
    budget: Protocol13TaskBudget,
    ceiling: Protocol13TaskBudget,
    label: string,
  ): void => {
    for (const field of ["steps", "tokens", "duration_ms"] as const) {
      if (!Number.isInteger(budget[field]) || budget[field] < 1) {
        throw new PlanningError(
          "invalid_specification",
          `${label} requires a positive integer ${field}`,
        );
      }
      if (budget[field] > ceiling[field]) {
        throw new PlanningError(
          "invalid_specification",
          `${label} ${field} exceeds the approved ceiling ${String(ceiling[field])}`,
        );
      }
    }
  };
  for (const task of tasks) {
    assertProtocol13TaskSpecification(task);
    assertWithinCeiling(task.budget, budgets.task_ceiling, `task ${task.id} budget`);
  }
  assertWithinCeiling(budgets.iteration, budgets.iteration_ceiling, "iteration budget");
  return {
    iterationBudget: budgets.iteration,
    parallelWaves: compileParallelWaves(tasks as readonly Protocol13TaskSpecification[]),
  };
}

function compileExecutionPlan(
  impactSet: NodeRecord,
  impactSetDigest: string,
  input: PlanGenerationInput,
  context: PlanContext,
): ExecutionPlanRecords {
  const protocol = input.protocol ?? "legacy";
  const validatedTasks = validatePlanProposal(input.proposal, input.constraints, protocol);
  const impactContent = readImpactSetContent(impactSet);
  const forecasts = input.governance?.forecastPaths ?? [];
  const impactCoverage = assessImpactCoverage({
    executionKind: input.executionKind,
    entries: impactContent.entries.map((entry) => ({
      node_id: entry.node_id,
      node_type: entry.node_type,
      risk: entry.risk,
    })),
    forecastPaths: forecasts,
  });
  if (input.executionKind === "agent") {
    assertAtomicAgentAcceptance(
      validatedTasks,
      impactContent.entries
        .filter((entry) => entry.node_type === "Test")
        .map((entry) => entry.node_id),
    );
    assertAgentPlanSize(validatedTasks);
  }
  const riskRank: Readonly<Record<GovernanceRisk, number>> = {
    low: 0,
    medium: 1,
    high: 2,
    critical: 3,
  };
  const impactRisk = impactContent.entries.reduce<GovernanceRisk>(
    (current, entry) => (riskRank[entry.risk] > riskRank[current] ? entry.risk : current),
    "low",
  );
  const tasks = validatedTasks.map((task) => {
    const taskComplexity = assessTaskSize(task).class;
    return {
      ...task,
      risk: deriveEffectiveRisk({
        declaredTaskRisk: task.risk,
        impactRisk,
        coverageRisk: impactCoverage.risk,
        pathScope: approvedPathScope(forecasts),
        taskComplexity,
        ...(input.governance?.adapterProfile === undefined
          ? {}
          : { adapterProfile: input.governance.adapterProfile }),
      }),
    };
  });
  assertBoundToApprovedImpactSet(tasks, impactSet);
  const selection = selectExecutionMode({
    executionKind: input.executionKind,
    intentShape: input.intentShape,
    hasExistingGraph: input.hasExistingGraph,
    deterministicWork: input.deterministicWork,
    taskCount: tasks.length,
  });
  const protocol13 = protocol === "protocol13" ? bindProtocol13Authority(input, tasks) : undefined;
  const base = {
    execution_kind: input.executionKind,
    impact_coverage: impactCoverage,
    mode: selection.mode,
    mode_reason: selection.reason,
    restricted: selection.restricted,
    impact_set_id: impactSet.id,
    impact_set_digest: impactSetDigest,
    shared_context: input.shared,
    tasks,
    ...(protocol13 === undefined
      ? {}
      : {
          iteration_budget: protocol13.iterationBudget,
          parallel_waves: protocol13.parallelWaves,
        }),
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
      extensions:
        protocol13 === undefined
          ? (task as unknown as Record<string, unknown>)
          : ({ ...task, semantic_digest: taskSemanticDigest(task) } as Record<string, unknown>),
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
