import {
  contentDigest,
  validateCriterionAssertionCoverage,
  type CriterionAssertionDescriptor,
  type DesignProposalQuestion,
  type ModelPortFailure,
  type PlanProposalOutput,
  type PlanProposalTaskCandidate,
} from "@universal-harness-internal/core";
import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "@universal-harness-internal/core";

import type { TaskSpecification } from "./task.js";
import type { PlanTasksPort as LegacyPlanTasksPort } from "../orchestration/pipeline-types.js";

/**
 * The PlanProposalPort seam (model advisory design 8, provable TDD design
 * 7.1, prompt governance addendum PG-5, plan T13). The model only allocates
 * Harness-compiled canonical assertion descriptors into task candidates and
 * proposes the decomposition rationale; the Harness owns assertion identity,
 * task ids/digests, paths, gates, TDD contracts and the final DAG. The
 * deterministic allocation validator rejects created, merged or omitted
 * assertions, unknown gates, widened paths, unknown design bindings, cycles
 * and DAG overruns — the model can improve decomposition quality but never
 * its authority. The legacy PlanTasksPort keeps one major through the
 * adapter, which emits a deprecation warning and feeds the same chain.
 */
export type { PlanProposalTaskCandidate } from "@universal-harness-internal/core";

export interface PlanProposalInput {
  readonly workflow_operation_id: string;
  readonly iteration_id: string;
  readonly requirement_baseline_digest: string;
  readonly impact_set_digest: string;
  readonly policy_digest: string;
  readonly design_set_digest?: string;
  readonly capability_plan_digest?: string;
  readonly canonical_assertions: readonly CriterionAssertionDescriptor[];
  readonly known_requirement_ids: readonly string[];
  readonly known_decision_ids: readonly string[];
  readonly known_design_artifact_ids: readonly string[];
  readonly known_gate_ids: readonly string[];
  readonly allowed_write_paths: readonly string[];
  readonly max_tasks: number;
  readonly bundle_digest: string;
  readonly conversation_id: string;
  readonly run_id: string;
}

export type PlanProposalResult =
  | {
      readonly status: "proposed";
      readonly tasks: readonly PlanProposalTaskCandidate[];
      readonly questions: readonly DesignProposalQuestion[];
      readonly warnings?: readonly string[];
    }
  | {
      readonly status: "clarification_required";
      readonly questions: readonly DesignProposalQuestion[];
    }
  | { readonly status: "failed"; readonly failure: ModelPortFailure };

export interface PlanProposalPort {
  readonly name: string;
  propose(input: PlanProposalInput): Promise<PlanProposalResult>;
}

export const PLAN_PROPOSAL_ALLOCATION_ISSUE_CODES = [
  "unknown_assertion",
  "duplicate_task_key",
  "unknown_dependency",
  "dependency_cycle",
  "unknown_gate",
  "path_widening",
  "unknown_design_binding",
  "dag_limit_exceeded",
] as const;
export type PlanProposalAllocationIssueCode = (typeof PLAN_PROPOSAL_ALLOCATION_ISSUE_CODES)[number];

export interface PlanProposalAllocationIssue {
  readonly code: PlanProposalAllocationIssueCode | string;
  readonly message: string;
  readonly target_id?: string;
}

function issue(code: string, message: string, targetId?: string): PlanProposalAllocationIssue {
  return { code, message, ...(targetId === undefined ? {} : { target_id: targetId }) };
}

/** A suggested path may only narrow the authorized write set. */
function pathAllowed(suggested: string, allowed: readonly string[]): boolean {
  return allowed.some((base) => {
    const prefix = base.endsWith("/**") ? base.slice(0, -3) : base;
    return suggested === base || suggested.startsWith(prefix);
  });
}

export function validatePlanProposalAllocation(input: {
  readonly tasks: readonly PlanProposalTaskCandidate[];
  readonly canonical_assertions: readonly CriterionAssertionDescriptor[];
  readonly known_gate_ids: readonly string[];
  readonly allowed_write_paths: readonly string[];
  readonly known_requirement_ids: readonly string[];
  readonly known_decision_ids: readonly string[];
  readonly known_design_artifact_ids: readonly string[];
  readonly max_tasks: number;
}): PlanProposalAllocationIssue[] {
  const issues: PlanProposalAllocationIssue[] = [];
  if (input.tasks.length > input.max_tasks) {
    issues.push(
      issue(
        "dag_limit_exceeded",
        `${input.tasks.length} tasks exceed the limit ${input.max_tasks}`,
      ),
    );
  }

  const canonicalIds = new Set(input.canonical_assertions.map((entry) => entry.assertion_id));
  const knownGates = new Set(input.known_gate_ids);
  const knownBindings = new Set([
    ...input.known_requirement_ids,
    ...input.known_decision_ids,
    ...input.known_design_artifact_ids,
  ]);

  const keys = new Set<string>();
  for (const task of input.tasks) {
    if (keys.has(task.task_key)) {
      issues.push(
        issue("duplicate_task_key", `task key ${task.task_key} appears twice`, task.task_key),
      );
    }
    keys.add(task.task_key);
  }
  for (const task of input.tasks) {
    for (const assertionId of task.assertion_ids) {
      if (!canonicalIds.has(assertionId)) {
        issues.push(
          issue(
            "unknown_assertion",
            `task ${task.task_key} allocates non-canonical assertion ${assertionId}`,
            assertionId,
          ),
        );
      }
    }
    for (const dependency of task.depends_on) {
      if (!keys.has(dependency)) {
        issues.push(
          issue(
            "unknown_dependency",
            `task ${task.task_key} depends on unknown key ${dependency}`,
            task.task_key,
          ),
        );
      }
    }
    for (const gateId of task.suggested_gate_ids) {
      if (!knownGates.has(gateId)) {
        issues.push(
          issue(
            "unknown_gate",
            `task ${task.task_key} suggests unknown gate ${gateId}`,
            task.task_key,
          ),
        );
      }
    }
    for (const path of task.suggested_write_paths) {
      if (!pathAllowed(path, input.allowed_write_paths)) {
        issues.push(
          issue(
            "path_widening",
            `task ${task.task_key} suggests write path ${path} outside the authorized set`,
            task.task_key,
          ),
        );
      }
    }
    for (const binding of [
      ...task.requirement_ids,
      ...task.decision_ids,
      ...task.design_artifact_ids,
    ]) {
      if (!knownBindings.has(binding)) {
        issues.push(
          issue(
            "unknown_design_binding",
            `task ${task.task_key} binds unknown object ${binding}`,
            binding,
          ),
        );
      }
    }
  }

  // Key-level dependency cycle check (iterative DFS, deterministic order).
  const adjacency = new Map<string, string[]>();
  for (const task of input.tasks) {
    adjacency.set(
      task.task_key,
      task.depends_on.filter((dependency) => keys.has(dependency)).sort(),
    );
  }
  const state = new Map<string, number>();
  const visit = (key: string, stack: string[]): boolean => {
    state.set(key, 1);
    for (const dependency of adjacency.get(key) ?? []) {
      if (state.get(dependency) === 1) return true;
      if ((state.get(dependency) ?? 0) === 0 && visit(dependency, [...stack, key])) return true;
    }
    state.set(key, 2);
    return false;
  };
  for (const key of [...adjacency.keys()].sort()) {
    if ((state.get(key) ?? 0) === 0 && visit(key, [])) {
      issues.push(issue("dependency_cycle", `task dependency cycle reaches ${key}`, key));
      break;
    }
  }

  // Criterion coverage: every canonical assertion allocated exactly once.
  const assignments: Record<string, readonly string[]> = {};
  for (const task of input.tasks) {
    assignments[task.task_key] = task.assertion_ids.filter((id) => canonicalIds.has(id));
  }
  const coverage = validateCriterionAssertionCoverage({
    descriptors: input.canonical_assertions,
    accepted_criteria: input.canonical_assertions.map((entry) => ({
      criterion_id: entry.acceptance_criterion_id,
      criterion_semantic_digest: entry.criterion_semantic_digest,
    })),
    task_assertion_assignments: assignments,
  });
  issues.push(...coverage);

  return issues.sort((left, right) => left.code.localeCompare(right.code));
}

function invalidOutput(summary: string): ModelPortFailure {
  return { code: "invalid_output", summary, retryable: false };
}

/** Parse an untrusted raw payload into the typed port result. */
export function parsePlanProposalOutput(raw: unknown): PlanProposalResult {
  const shape = PROTOCOL_1_1_SCHEMA_REGISTRY.validate("plan-proposal-output", raw);
  if (!shape.valid) {
    return {
      status: "failed",
      failure: invalidOutput(
        `plan proposal output failed schema validation: ${shape.errors[0]?.message ?? "unknown"}`,
      ),
    };
  }
  const output = raw as PlanProposalOutput;
  if (output.tasks.length > 0) {
    return { status: "proposed", tasks: output.tasks, questions: output.questions };
  }
  if (output.questions.length > 0) {
    return { status: "clarification_required", questions: output.questions };
  }
  return {
    status: "failed",
    failure: invalidOutput("plan proposal output carries neither tasks nor questions"),
  };
}

/** The in-memory port: a script supplies candidates; the port validates. */
export function createInMemoryPlanProposalPort(
  script: (input: PlanProposalInput) => unknown,
): PlanProposalPort {
  return {
    name: "in-memory-plan-proposal",
    async propose(input) {
      const payload = script(input);
      const wrapped =
        typeof payload === "object" && payload !== null && !Array.isArray(payload)
          ? { purpose: "plan_proposal", schema_version: "plan_proposal.v1", ...payload }
          : payload;
      const parsed = parsePlanProposalOutput(wrapped);
      if (parsed.status !== "proposed") return parsed;
      const issues = validatePlanProposalAllocation({
        tasks: parsed.tasks,
        canonical_assertions: input.canonical_assertions,
        known_gate_ids: input.known_gate_ids,
        allowed_write_paths: input.allowed_write_paths,
        known_requirement_ids: input.known_requirement_ids,
        known_decision_ids: input.known_decision_ids,
        known_design_artifact_ids: input.known_design_artifact_ids,
        max_tasks: input.max_tasks,
      });
      if (issues.length > 0) {
        return {
          status: "failed",
          failure: invalidOutput(
            `plan proposal failed allocation validation: ${issues
              .map((entry) => entry.code)
              .join(", ")}`,
          ),
        };
      }
      return parsed;
    },
  };
}

/**
 * The one-major legacy bridge (model advisory design 8): the legacy
 * PlanTasksPort is invoked with its own input channel, its output maps into
 * task candidates and flows through the exact same allocation validation as
 * any model proposal, with a deprecation warning attached. The legacy port
 * never gains a prompt injection channel.
 */
export function createLegacyPlanTasksAdapter(
  legacy: LegacyPlanTasksPort,
  legacyInput: Parameters<LegacyPlanTasksPort>[0],
): PlanProposalPort {
  return {
    name: "legacy-plan-tasks-adapter",
    async propose(input) {
      const specifications = legacy(legacyInput);
      const tasks = mapLegacyTaskSpecifications(specifications);
      const issues = validatePlanProposalAllocation({
        tasks,
        canonical_assertions: input.canonical_assertions,
        known_gate_ids: input.known_gate_ids,
        allowed_write_paths: input.allowed_write_paths,
        known_requirement_ids: input.known_requirement_ids,
        known_decision_ids: input.known_decision_ids,
        known_design_artifact_ids: input.known_design_artifact_ids,
        max_tasks: input.max_tasks,
      });
      if (issues.length > 0) {
        return {
          status: "failed",
          failure: invalidOutput(
            `legacy plan output failed allocation validation: ${issues
              .map((entry) => entry.code)
              .join(", ")}`,
          ),
        };
      }
      return {
        status: "proposed",
        tasks,
        questions: [],
        warnings: [LEGACY_PLAN_TASKS_DEPRECATION],
      };
    },
  };
}

/**
 * Map legacy planner output into validated candidates. The caller supplies
 * the raw specifications; the mapping never invents assertions and the
 * result still passes the same allocation validator downstream.
 */
export function mapLegacyTaskSpecifications(
  specifications: readonly TaskSpecification[],
): PlanProposalTaskCandidate[] {
  return specifications.map((specification) => ({
    task_key: specification.id,
    goal: specification.objective,
    atomicity_rationale: "legacy planner output",
    assertion_ids: (specification.assertions ?? []).map((assertion) => assertion.assertion_id),
    requirement_ids: [],
    decision_ids: [],
    design_artifact_ids: [],
    depends_on: [...specification.dependencies],
    suggested_gate_ids: [...specification.required_gates],
    suggested_write_paths: [],
  }));
}

export const LEGACY_PLAN_TASKS_DEPRECATION =
  "PlanTasksPort is deprecated; route planning through PlanProposalPort (one major of compatibility remains)";

/**
 * Materialize validated candidates into TaskSpecifications (T13): the
 * Harness owns task ids (content-derived), dependencies (key → id), gates
 * (intersected with the known registry) and assertion bindings (from the
 * canonical descriptors, with criterion identity and semantic digest). The
 * model's contribution is the decomposition; every authoritative field is
 * compiled here.
 */
export function materializePlanTasks(
  candidates: readonly PlanProposalTaskCandidate[],
  context: {
    readonly canonical_assertions: readonly CriterionAssertionDescriptor[];
    readonly impactPaths: readonly (readonly string[])[];
    readonly gateIds: readonly string[];
    /** Requirement id → its accepted acceptance criteria (baseline facts). */
    readonly requirement_acceptance: Readonly<
      Record<string, readonly { readonly description: string; readonly verification: string }[]>
    >;
    /** Requirement id → accepted Test node ids verifying it. */
    readonly requirement_test_ids: Readonly<Record<string, readonly string[]>>;
  },
): TaskSpecification[] {
  const idByKey = new Map(
    candidates.map((candidate) => [
      candidate.task_key,
      `task_${contentDigest({ key: candidate.task_key, goal: candidate.goal }).slice(0, 16)}`,
    ]),
  );
  const descriptors = new Map(
    context.canonical_assertions.map((descriptor) => [descriptor.assertion_id, descriptor]),
  );
  const knownGates = new Set(context.gateIds);
  // Gates are Harness-assigned: a suggestion narrows within the known set,
  // but an empty suggestion always falls back to the full phase suite — a
  // proposal can never weaken a task below the default gate coverage.
  const gatesFor = (candidate: PlanProposalTaskCandidate): string[] => {
    const suggested = candidate.suggested_gate_ids.filter((gateId) => knownGates.has(gateId));
    return (suggested.length > 0 ? suggested : [...context.gateIds]).sort();
  };
  return candidates.map((candidate) => {
    const canonicalAssertions = candidate.assertion_ids
      .map((assertionId) => descriptors.get(assertionId))
      .filter((descriptor): descriptor is CriterionAssertionDescriptor => descriptor !== undefined)
      .map((descriptor) => ({
        assertion_id: descriptor.assertion_id,
        assertion_kind: "criterion_assertion" as const,
        acceptance_criterion_id: descriptor.acceptance_criterion_id,
        criterion_semantic_digest: descriptor.criterion_semantic_digest,
        test_ids: [descriptor.test_node_id],
        required_gate_ids: gatesFor(candidate),
        evidence_requirements: ["gate_evidence"],
      }));
    // Without canonical criterion lineage (no managed-capture seeds), fall
    // back to the deterministic per-acceptance assertions of the default
    // decomposition so atomic-acceptance checks still hold.
    const assertions =
      canonicalAssertions.length > 0
        ? canonicalAssertions
        : candidate.requirement_ids.flatMap((requirementId) =>
            (context.requirement_acceptance[requirementId] ?? []).map((criterion, index) => ({
              assertion_id: `assertion_${contentDigest({ requirement: requirementId, criterion, index }).slice(0, 16)}`,
              test_ids: [...(context.requirement_test_ids[requirementId] ?? [])].sort(),
              required_gate_ids: gatesFor(candidate),
              evidence_requirements: ["gate_evidence"],
            })),
          );
    return {
      id: idByKey.get(candidate.task_key) as string,
      objective: candidate.goal,
      impact_paths: context.impactPaths.map((path) => [...path]),
      expected_outputs: [...candidate.requirement_ids].sort(),
      capabilities: [],
      tools: [],
      dependencies: candidate.depends_on
        .map((key) => idByKey.get(key))
        .filter((id): id is string => id !== undefined)
        .sort(),
      risk: "medium" as const,
      budget: { steps: 30, tokens: 120000 },
      acceptance: candidate.requirement_ids.flatMap((requirementId) =>
        (context.requirement_acceptance[requirementId] ?? []).map((criterion) => ({
          ...criterion,
        })),
      ),
      // Legacy semantics: omit the field entirely when no canonical
      // assertion was allocated; an empty array is invalid.
      ...(assertions.length === 0 ? {} : { assertions }),
      required_gates: gatesFor(candidate),
    };
  });
}
