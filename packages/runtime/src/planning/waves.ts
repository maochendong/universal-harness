import { canonicalizeJson } from "@universal-harness-internal/core";

import type { Protocol13TaskSpecification } from "./task.js";
import {
  PlanningError,
  assertProtocol13TaskSpecification,
  normalizeExclusiveResourceKey,
  normalizeTaskWritePath,
} from "./validator.js";

/**
 * Deterministic parallel wave compilation (M4 design 6.2, plan Task 3). The
 * approved `ExecutionPlanContent.tasks` list is the only scheduling input:
 * dependencies come exclusively from `TaskSpecification.dependencies`, the
 * topological frontier is always selected in Plan declaration order, and a
 * Task moves to the first wave at or after its earliest dependency wave that
 * carries no write/write overlap and no shared exclusive resource. The result
 * is a deterministic projection stored on the Plan; persisted drift fails
 * closed through {@link assertParallelWaves}.
 *
 * The compiler is intentionally pure: it re-checks claims lexically, while
 * filesystem-level symlink verification happens at proposal validation —
 * the generateExecutionPlan() protocol 1.3 flow always passes a repository
 * root into validatePlanProposal(), so every specification reaching this
 * compiler has already been resolved against the real repository.
 */
export interface ParallelWave {
  readonly wave_index: number;
  readonly task_ids: readonly string[];
}

/**
 * Whether two normalized write paths conflict: exact equality or one being
 * an ancestor of the other. Sibling prefixes (`src/a` vs `src/ab`) never
 * conflict. Both inputs must already be normalized through
 * normalizeTaskWritePath().
 */
export function writePathsOverlap(first: string, second: string): boolean {
  return first === second || first.startsWith(`${second}/`) || second.startsWith(`${first}/`);
}

interface NormalizedTask {
  readonly task: Protocol13TaskSpecification;
  readonly position: number;
  readonly writePaths: readonly string[];
  readonly resources: ReadonlySet<string>;
}

function normalizeTasks(tasks: readonly Protocol13TaskSpecification[]): readonly NormalizedTask[] {
  const ids = new Set<string>();
  return tasks.map((task, position) => {
    if (ids.has(task.id)) {
      throw new PlanningError("invalid_specification", `duplicate task id ${task.id}`);
    }
    ids.add(task.id);
    assertProtocol13TaskSpecification(task);
    return {
      task,
      position,
      writePaths: task.write_paths.map((path) => normalizeTaskWritePath(path)),
      resources: new Set(
        task.exclusive_resources.map((resource) => normalizeExclusiveResourceKey(resource)),
      ),
    };
  });
}

/**
 * Stable topological order: Kahn's algorithm with the ready frontier always
 * selected in Plan declaration order, so the declaration order is the only
 * tie-break and no implicit second ordering can creep in.
 */
function stableTopologicalOrder(tasks: readonly NormalizedTask[]): readonly NormalizedTask[] {
  const byId = new Map(tasks.map((task) => [task.task.id, task]));
  const indegree = new Map<string, number>(tasks.map((task) => [task.task.id, 0]));
  const dependents = new Map<string, NormalizedTask[]>(tasks.map((task) => [task.task.id, []]));
  for (const task of tasks) {
    for (const dependency of task.task.dependencies) {
      const target = byId.get(dependency);
      if (target === undefined) {
        throw new PlanningError(
          "invalid_specification",
          `task ${task.task.id} depends on unknown task ${dependency}`,
        );
      }
      indegree.set(task.task.id, (indegree.get(task.task.id) as number) + 1);
      (dependents.get(dependency) as NormalizedTask[]).push(task);
    }
  }
  const ready = tasks.filter((task) => indegree.get(task.task.id) === 0);
  const order: NormalizedTask[] = [];
  while (ready.length > 0) {
    const current = ready.shift() as NormalizedTask;
    order.push(current);
    for (const dependent of dependents.get(current.task.id) as NormalizedTask[]) {
      const remaining = (indegree.get(dependent.task.id) as number) - 1;
      indegree.set(dependent.task.id, remaining);
      if (remaining === 0) {
        // Insert by declaration position so the frontier stays declaration ordered.
        const insertAt = ready.findIndex((task) => task.position > dependent.position);
        if (insertAt === -1) ready.push(dependent);
        else ready.splice(insertAt, 0, dependent);
      }
    }
  }
  if (order.length !== tasks.length) {
    throw new PlanningError(
      "dependency_cycle",
      "task dependencies form a cycle; parallel waves require a DAG",
    );
  }
  return order;
}

function conflictsWithWave(task: NormalizedTask, members: readonly NormalizedTask[]): boolean {
  return members.some(
    (member) =>
      task.writePaths.some((path) =>
        member.writePaths.some((other) => writePathsOverlap(path, other)),
      ) || [...task.resources].some((resource) => member.resources.has(resource)),
  );
}

/**
 * Compile the deterministic parallel wave layout for an approved Protocol
 * 1.3 Task list. Each Task takes the earliest wave strictly after all of its
 * dependencies' actual waves that is free of write/write and exclusive
 * resource conflicts; displaced Tasks push their dependents' earliest waves
 * forward through the actual placement. Throws a typed PlanningError on
 * unknown dependencies, cycles, duplicate Tasks and invalid resource claims.
 */
export function compileParallelWaves(
  tasks: readonly Protocol13TaskSpecification[],
): readonly ParallelWave[] {
  const normalized = normalizeTasks(tasks);
  const order = stableTopologicalOrder(normalized);
  const waveMembers: NormalizedTask[][] = [];
  const placement = new Map<string, number>();
  for (const task of order) {
    let wave = 0;
    for (const dependency of task.task.dependencies) {
      wave = Math.max(wave, (placement.get(dependency) as number) + 1);
    }
    while (wave < waveMembers.length && conflictsWithWave(task, waveMembers[wave] as never)) {
      wave += 1;
    }
    if (wave === waveMembers.length) waveMembers.push([]);
    (waveMembers[wave] as NormalizedTask[]).push(task);
    placement.set(task.task.id, wave);
  }
  return waveMembers.map((members, waveIndex) => ({
    wave_index: waveIndex,
    task_ids: members.map((member) => member.task.id),
  }));
}

/**
 * Fail-closed guard for the persisted projection (M4 design 6.2 step 5): the
 * persisted `parallel_waves` must byte-match a fresh compilation of the same
 * Task list. Any drift throws a typed PlanningError of kind `wave_drift`.
 */
export function assertParallelWaves(
  tasks: readonly Protocol13TaskSpecification[],
  persisted: readonly ParallelWave[],
): void {
  const compiled = compileParallelWaves(tasks);
  if (canonicalizeJson(compiled) !== canonicalizeJson(persisted)) {
    throw new PlanningError(
      "wave_drift",
      "persisted parallel waves differ from a fresh compilation; the plan projection is not independently editable",
    );
  }
}
