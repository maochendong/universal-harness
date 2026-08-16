/**
 * Declarative Task Specification (design 10.1). A planner emits objectives,
 * expected outputs, dependencies, capabilities, risk, budgets, acceptance
 * criteria and required gates — never privileged shell commands or direct
 * tool invocations. The specification is the only shape of work the Workflow
 * Engine will route; anything imperative is rejected at validation time.
 */
export const TASK_RISKS = ["low", "medium", "high", "critical"] as const;

export type TaskRisk = (typeof TASK_RISKS)[number];

/** Per-task termination ceiling; never shared between tasks. */
export interface TaskBudget {
  readonly steps: number;
  readonly tokens: number;
}

export interface TaskAcceptanceCriterion {
  readonly description: string;
  /** How the criterion is verified (gate, test or check name). */
  readonly verification: string;
}

/** Atomic, machine-checkable acceptance binding for newly authorized Agent work. */
export interface TaskAcceptanceAssertion {
  readonly assertion_id: string;
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
  readonly budget: TaskBudget;
  readonly acceptance: readonly TaskAcceptanceCriterion[];
  /** Legacy plans may omit this field, but new Agent plans are refused without it. */
  readonly assertions?: readonly TaskAcceptanceAssertion[];
  readonly required_gates: readonly string[];
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
