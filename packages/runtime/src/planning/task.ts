import { contentDigest } from "@universal-harness-internal/core";

/**
 * Declarative Task Specification (design 10.1). A planner emits objectives,
 * expected outputs, dependencies, capabilities, risk, budgets, acceptance
 * criteria and required gates — never privileged shell commands or direct
 * tool invocations. The specification is the only shape of work the Workflow
 * Engine will route; anything imperative is rejected at validation time.
 */
export const TASK_RISKS = ["low", "medium", "high", "critical"] as const;

export type TaskRisk = (typeof TASK_RISKS)[number];

/**
 * Legacy per-task termination ceiling; never shared between tasks. Protocol
 * 1.0–1.2 plans carry only steps and tokens; an optional duration is
 * validated when present but never synthesized.
 */
export interface LegacyTaskBudget {
  readonly steps: number;
  readonly tokens: number;
  readonly duration_ms?: number;
}

/** Backwards-compatible name for the pre-1.3 budget shape. */
export type TaskBudget = LegacyTaskBudget;

/** Protocol 1.3 per-task ceiling: the duration bound is mandatory. */
export interface Protocol13TaskBudget extends LegacyTaskBudget {
  readonly duration_ms: number;
}

/**
 * Iteration-wide aggregate budget (M4 design 6.2): the runtime authority for
 * how much one iteration may spend in total, proposed by the planner within
 * the approved ceiling and frozen into the Plan digest at approval time.
 */
export interface IterationBudget {
  readonly steps: number;
  readonly tokens: number;
  readonly duration_ms: number;
}

export interface TaskAcceptanceCriterion {
  readonly description: string;
  /** How the criterion is verified (gate, test or check name). */
  readonly verification: string;
}

/** Atomic, machine-checkable acceptance binding for newly authorized Agent work. */
export interface TaskAcceptanceAssertion {
  readonly assertion_id: string;
  /**
   * T13 canonical kinds: `criterion_assertion` binds exactly one accepted
   * criterion (id + semantic digest mandatory); `task_internal_assertion`
   * carries neither and never satisfies criterion coverage. Legacy plans may
   * omit the kind; the plan-level validator enforces the invariant.
   */
  readonly assertion_kind?: "criterion_assertion" | "task_internal_assertion";
  readonly acceptance_criterion_id?: string;
  readonly criterion_semantic_digest?: string;
  /** Accepted Test graph nodes that prove this assertion. */
  readonly test_ids: readonly string[];
  readonly required_gate_ids: readonly string[];
  /** Evidence kinds that must exist before the assertion can pass. */
  readonly evidence_requirements: readonly string[];
}

/**
 * One declarative unit of planned work. `impact_paths` binds the task to
 * explanation paths of the approved ImpactSet it was planned from;
 * `dependencies` reference the ids of sibling specifications.
 */
export interface TaskSpecification {
  readonly id: string;
  readonly objective: string;
  /** Approved ImpactSet entry paths (ordered edge id chains) this task binds to. */
  readonly impact_paths: readonly (readonly string[])[];
  /** Node ids the task is expected to produce or revise. */
  readonly expected_outputs: readonly string[];
  /** Capabilities the task requests; must stay within the authorized set. */
  readonly capabilities: readonly string[];
  /** Registered Harness tool ids the task may use. */
  readonly tools: readonly string[];
  /** Ids of specifications that must complete first. */
  readonly dependencies: readonly string[];
  readonly risk: TaskRisk;
  readonly budget: LegacyTaskBudget;
  /**
   * Repository-relative write claims (M4 design 6.1), normalized and
   * validated at plan time. Protocol 1.3 tasks always carry the array;
   * legacy plans omit it and are never assigned inferred claims.
   */
  readonly write_paths?: readonly string[];
  /** Stable project resource keys (e.g. `database-schema`, `service-port:8080`). */
  readonly exclusive_resources?: readonly string[];
  readonly acceptance: readonly TaskAcceptanceCriterion[];
  /** Legacy plans may omit this field, but new Agent plans are refused without it. */
  readonly assertions?: readonly TaskAcceptanceAssertion[];
  readonly required_gates: readonly string[];
}

/**
 * Protocol 1.3 Task Specification (M4 design 6.1): resource claims and the
 * duration bound are mandatory so the Plan stays the sole authority for
 * scheduling decisions. Legacy plans are never widened into this shape.
 */
export interface Protocol13TaskSpecification extends TaskSpecification {
  readonly budget: Protocol13TaskBudget;
  readonly write_paths: readonly string[];
  readonly exclusive_resources: readonly string[];
}

/**
 * Independent value signature (completion rule 9): a task only earns its own
 * node when it delivers an independently reviewable output — its own
 * objective plus its own expected outputs. Two tasks with the same signature
 * are one task split for no engineering reason and are rejected.
 */
export function independentValueSignature(spec: TaskSpecification): string {
  return JSON.stringify({
    objective: spec.objective.trim().toLowerCase(),
    expected_outputs: [...spec.expected_outputs].sort(),
  });
}

/**
 * Whether one specification carries independent value on its own: a stated
 * objective, at least one expected output and at least one verifiable
 * acceptance criterion.
 */
export function hasIndependentValue(spec: TaskSpecification): boolean {
  return (
    spec.objective.trim().length > 0 &&
    spec.expected_outputs.length > 0 &&
    spec.acceptance.length > 0
  );
}

/**
 * Semantic digest of a Task's planning content (M4 design 17): objective,
 * outputs, impact paths, dependencies, resource claims, budget, capabilities,
 * tools, risk, assertions and required gates — in canonical order, so two
 * plans that agree on the semantics digest identically regardless of the
 * order in which the planner listed the arrays. Identity (`id`) and
 * provenance stay out: this is a meaning digest, not a record digest.
 */
export function taskSemanticDigest(spec: TaskSpecification): string {
  const sortedStrings = (values: readonly string[]): readonly string[] => [...values].sort();
  return contentDigest({
    objective: spec.objective,
    expected_outputs: sortedStrings(spec.expected_outputs),
    impact_paths: spec.impact_paths
      .map((path) => [...path])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    dependencies: sortedStrings(spec.dependencies),
    write_paths: sortedStrings(spec.write_paths ?? []),
    exclusive_resources: sortedStrings(spec.exclusive_resources ?? []),
    budget: {
      steps: spec.budget.steps,
      tokens: spec.budget.tokens,
      ...(spec.budget.duration_ms === undefined ? {} : { duration_ms: spec.budget.duration_ms }),
    },
    capabilities: sortedStrings(spec.capabilities),
    tools: sortedStrings(spec.tools),
    risk: spec.risk,
    assertions: (spec.assertions ?? [])
      .map((assertion) => ({
        assertion_id: assertion.assertion_id,
        ...(assertion.assertion_kind === undefined
          ? {}
          : { assertion_kind: assertion.assertion_kind }),
        ...(assertion.acceptance_criterion_id === undefined
          ? {}
          : { acceptance_criterion_id: assertion.acceptance_criterion_id }),
        ...(assertion.criterion_semantic_digest === undefined
          ? {}
          : { criterion_semantic_digest: assertion.criterion_semantic_digest }),
        test_ids: sortedStrings(assertion.test_ids),
        required_gate_ids: sortedStrings(assertion.required_gate_ids),
        evidence_requirements: sortedStrings(assertion.evidence_requirements),
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    required_gates: sortedStrings(spec.required_gates),
  });
}
