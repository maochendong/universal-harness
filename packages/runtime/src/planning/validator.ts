import {
  TASK_RISKS,
  hasIndependentValue,
  independentValueSignature,
  type TaskAcceptanceCriterion,
  type TaskAcceptanceAssertion,
  type TaskSpecification,
} from "./task.js";

/**
 * Plan proposal validation (design 10.1; completion rule 8). A planner
 * proposal is untrusted input: the Workflow Engine validates it before the
 * plan is accepted and rejects anything that is not a legal declarative plan
 * — embedded commands or raw shell, unknown tools, dependency cycles,
 * missing gates, unauthorized capability expansion and tasks without
 * independent value.
 */
export const PLANNING_ERROR_KINDS = [
  "invalid_specification",
  "embedded_command",
  "unknown_tool",
  "capability_expansion",
  "unknown_gate",
  "missing_gate",
  "dependency_cycle",
  "no_independent_value",
  "atomic_acceptance_required",
  "uncovered_test",
  "task_too_large",
  "dag_limit_exceeded",
] as const;

export type PlanningErrorKind = (typeof PLANNING_ERROR_KINDS)[number];

export class PlanningError extends Error {
  readonly kind: PlanningErrorKind;

  constructor(kind: PlanningErrorKind, message: string) {
    super(message);
    this.name = "PlanningError";
    this.kind = kind;
  }
}

/**
 * Bounds the proposal may not exceed: the capabilities the approved baseline
 * and policy authorize, plus the registered Harness tools and gates.
 */
export interface PlannerConstraints {
  readonly allowedCapabilities: readonly string[];
  readonly knownTools: readonly string[];
  readonly knownGates: readonly string[];
}

/**
 * Keys that would smuggle imperative execution into a declarative
 * specification. Scanned recursively, so a command hidden inside a nested
 * object or array is rejected just the same.
 */
export const FORBIDDEN_PROPOSAL_KEYS = [
  "command",
  "commands",
  "shell",
  "shell_command",
  "raw_shell",
  "script",
  "tool_invocation",
  "tool_invocations",
] as const;

function assertNoEmbeddedCommands(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoEmbeddedCommands(item, `${path}[${String(index)}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, nested] of Object.entries(value)) {
    if ((FORBIDDEN_PROPOSAL_KEYS as readonly string[]).includes(key)) {
      throw new PlanningError(
        "embedded_command",
        `plan proposal carries imperative execution at ${path}.${key}; ` +
          "task specifications are declarative and never embed commands, raw shell or tool invocations",
      );
    }
    assertNoEmbeddedCommands(nested, `${path}.${key}`);
  }
}

// Mirrors the persisted-record IdentifierSchema in core (schema/common.ts);
// duplicated here because common.ts is not part of the core public exports.
const IDENTIFIER_PATTERN = "^[a-z][a-z0-9-]*_[A-Za-z0-9_-]+$";
const IDENTIFIER_REGEX = new RegExp(IDENTIFIER_PATTERN);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringList(value: unknown, field: string, taskId: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    throw new PlanningError(
      "invalid_specification",
      `task ${taskId}: ${field} must be an array of non-empty strings`,
    );
  }
  return value as readonly string[];
}

function readTaskSpecification(raw: unknown, index: number): TaskSpecification {
  const position = `task[${String(index)}]`;
  if (!isPlainObject(raw)) {
    throw new PlanningError("invalid_specification", `${position} must be an object`);
  }
  const id = raw.id;
  if (typeof id !== "string" || !IDENTIFIER_REGEX.test(id)) {
    throw new PlanningError(
      "invalid_specification",
      `${position}: id must match ${IDENTIFIER_PATTERN}`,
    );
  }
  if (typeof raw.objective !== "string" || raw.objective.trim() === "") {
    throw new PlanningError("invalid_specification", `task ${id}: objective is required`);
  }
  if (
    !Array.isArray(raw.impact_paths) ||
    raw.impact_paths.length === 0 ||
    raw.impact_paths.some(
      (path) =>
        !Array.isArray(path) || path.some((edge) => typeof edge !== "string" || edge === ""),
    )
  ) {
    throw new PlanningError(
      "invalid_specification",
      `task ${id}: impact_paths must bind at least one approved impact path`,
    );
  }
  const expectedOutputs = readStringList(raw.expected_outputs, "expected_outputs", id);
  if (expectedOutputs.length === 0) {
    throw new PlanningError(
      "invalid_specification",
      `task ${id}: at least one expected output is required`,
    );
  }
  if (
    !Array.isArray(raw.acceptance) ||
    raw.acceptance.length === 0 ||
    raw.acceptance.some(
      (criterion) =>
        !isPlainObject(criterion) ||
        typeof criterion.description !== "string" ||
        criterion.description.trim() === "" ||
        typeof criterion.verification !== "string" ||
        criterion.verification.trim() === "",
    )
  ) {
    throw new PlanningError(
      "invalid_specification",
      `task ${id}: at least one verifiable acceptance criterion is required`,
    );
  }
  if (typeof raw.risk !== "string" || !(TASK_RISKS as readonly string[]).includes(raw.risk)) {
    throw new PlanningError(
      "invalid_specification",
      `task ${id}: risk must be one of ${TASK_RISKS.join(", ")}`,
    );
  }
  const budget = raw.budget;
  if (
    !isPlainObject(budget) ||
    !Number.isInteger(budget.steps) ||
    (budget.steps as number) < 1 ||
    !Number.isInteger(budget.tokens) ||
    (budget.tokens as number) < 1
  ) {
    throw new PlanningError(
      "invalid_specification",
      `task ${id}: budget requires positive integer steps and tokens`,
    );
  }
  const requiredGates = readStringList(raw.required_gates, "required_gates", id);
  if (requiredGates.length === 0) {
    throw new PlanningError("missing_gate", `task ${id}: every task requires at least one gate`);
  }
  let assertions: readonly TaskAcceptanceAssertion[] | undefined;
  if (raw.assertions !== undefined) {
    if (!Array.isArray(raw.assertions) || raw.assertions.length === 0) {
      throw new PlanningError(
        "invalid_specification",
        `task ${id}: assertions must be a non-empty array when present`,
      );
    }
    const seenAssertionIds = new Set<string>();
    assertions = raw.assertions.map((rawAssertion, assertionIndex) => {
      if (!isPlainObject(rawAssertion)) {
        throw new PlanningError(
          "invalid_specification",
          `task ${id}: assertion[${String(assertionIndex)}] must be an object`,
        );
      }
      const assertionId = rawAssertion.assertion_id;
      if (typeof assertionId !== "string" || !IDENTIFIER_REGEX.test(assertionId)) {
        throw new PlanningError(
          "invalid_specification",
          `task ${id}: assertion_id must match ${IDENTIFIER_PATTERN}`,
        );
      }
      if (seenAssertionIds.has(assertionId)) {
        throw new PlanningError(
          "invalid_specification",
          `task ${id}: duplicate assertion id ${assertionId}`,
        );
      }
      seenAssertionIds.add(assertionId);
      const testIds = readStringList(rawAssertion.test_ids, "assertion.test_ids", id);
      const assertionGateIds = readStringList(
        rawAssertion.required_gate_ids,
        "assertion.required_gate_ids",
        id,
      );
      const evidenceRequirements = readStringList(
        rawAssertion.evidence_requirements,
        "assertion.evidence_requirements",
        id,
      );
      if (
        testIds.length === 0 ||
        assertionGateIds.length === 0 ||
        evidenceRequirements.length === 0
      ) {
        throw new PlanningError(
          "invalid_specification",
          `task ${id}: every assertion requires tests, gates and evidence`,
        );
      }
      for (const gateId of assertionGateIds) {
        if (!requiredGates.includes(gateId)) {
          throw new PlanningError(
            "missing_gate",
            `task ${id}: assertion ${assertionId} requires gate ${gateId} outside task.required_gates`,
          );
        }
      }
      return {
        assertion_id: assertionId,
        test_ids: testIds,
        required_gate_ids: assertionGateIds,
        evidence_requirements: evidenceRequirements,
      };
    });
  }
  return {
    id,
    objective: raw.objective,
    impact_paths: (raw.impact_paths as readonly (readonly string[])[]).map((path) => [...path]),
    expected_outputs: expectedOutputs,
    capabilities: readStringList(raw.capabilities ?? [], "capabilities", id),
    tools: readStringList(raw.tools ?? [], "tools", id),
    dependencies: readStringList(raw.dependencies ?? [], "dependencies", id),
    risk: raw.risk as TaskSpecification["risk"],
    budget: { steps: budget.steps as number, tokens: budget.tokens as number },
    acceptance: (raw.acceptance as readonly TaskAcceptanceCriterion[]).map((criterion) => ({
      description: criterion.description,
      verification: criterion.verification,
    })),
    ...(assertions === undefined ? {} : { assertions }),
    required_gates: requiredGates,
  };
}

function assertAcyclic(tasks: readonly TaskSpecification[]): void {
  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (dependency === task.id) {
        throw new PlanningError("dependency_cycle", `task ${task.id} depends on itself`);
      }
      if (!ids.has(dependency)) {
        throw new PlanningError(
          "invalid_specification",
          `task ${task.id} depends on unknown task ${dependency}`,
        );
      }
    }
  }
  // Kahn's algorithm over the DEPENDS_ON graph.
  const indegree = new Map<string, number>(tasks.map((task) => [task.id, 0]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      indegree.set(task.id, (indegree.get(task.id) as number) + 1);
      (dependents.get(dependency) as string[]).push(task.id);
    }
  }
  const ready = tasks
    .filter((task) => indegree.get(task.id) === 0)
    .map((task) => task.id)
    .sort();
  let visited = 0;
  while (ready.length > 0) {
    const current = ready.shift() as string;
    visited += 1;
    for (const dependent of (dependents.get(current) as string[]).slice().sort()) {
      const remaining = (indegree.get(dependent) as number) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) ready.push(dependent);
    }
  }
  if (visited !== tasks.length) {
    throw new PlanningError(
      "dependency_cycle",
      "task dependencies form a cycle; a declarative plan must be a DAG",
    );
  }
}

/**
 * Validate a raw planner proposal against the planner constraints and return
 * the canonical declarative specifications, sorted by task id. Throws a typed
 * PlanningError on the first violation; a rejected proposal leaves no trace
 * in the authoritative graph.
 */
export function validatePlanProposal(
  rawTasks: unknown,
  constraints: PlannerConstraints,
): readonly TaskSpecification[] {
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    throw new PlanningError(
      "invalid_specification",
      "a plan proposal requires at least one task specification",
    );
  }
  assertNoEmbeddedCommands(rawTasks, "proposal");
  const tasks = rawTasks.map((raw, index) => readTaskSpecification(raw, index));
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) {
      throw new PlanningError("invalid_specification", `duplicate task id ${task.id}`);
    }
    ids.add(task.id);
  }
  for (const task of tasks) {
    for (const tool of task.tools) {
      if (!constraints.knownTools.includes(tool)) {
        throw new PlanningError(
          "unknown_tool",
          `task ${task.id} references unregistered tool ${tool}`,
        );
      }
    }
    for (const capability of task.capabilities) {
      if (!constraints.allowedCapabilities.includes(capability)) {
        throw new PlanningError(
          "capability_expansion",
          `task ${task.id} requests capability ${capability} beyond the authorized set`,
        );
      }
    }
    for (const gate of task.required_gates) {
      if (!constraints.knownGates.includes(gate)) {
        throw new PlanningError(
          "unknown_gate",
          `task ${task.id} requires unregistered gate ${gate}`,
        );
      }
    }
  }
  assertAcyclic(tasks);
  if (tasks.length > 1) {
    const signatures = new Set<string>();
    for (const task of tasks) {
      if (!hasIndependentValue(task)) {
        throw new PlanningError(
          "no_independent_value",
          `task ${task.id} has no independently reviewable output`,
        );
      }
      const signature = independentValueSignature(task);
      if (signatures.has(signature)) {
        throw new PlanningError(
          "no_independent_value",
          `task ${task.id} duplicates the objective and outputs of a sibling task`,
        );
      }
      signatures.add(signature);
    }
  }
  return [...tasks].sort((left, right) => (left.id < right.id ? -1 : 1));
}
