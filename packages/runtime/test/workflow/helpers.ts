import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StartOperationInput, WorkflowDependencies, WorkflowIdKind } from "../../src/index.js";

export const FIXED_NOW = "2026-08-12T00:00:00.000Z";
export const BASELINE = "0123456789abcdef0123456789abcdef01234567";
export const REQUIREMENT_DIGEST = "a".repeat(64);
export const POLICY_DIGEST = "b".repeat(64);

const createdDirectories: string[] = [];

export function cleanupDirectories(): void {
  while (createdDirectories.length > 0) {
    const directory = createdDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
}

export function makeProjectRoot(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "harness-workflow-")));
  createdDirectories.push(directory);
  return directory;
}

/**
 * Deterministic ids scoped to one logical operation attempt: retrying the
 * same attempt with a fresh mint of the same tag reproduces the exact same
 * ids (so ledger retries are idempotent), while different tags never
 * collide across phases.
 */
export function phaseIds(tag: string): (kind: WorkflowIdKind) => string {
  const counters = new Map<string, number>();
  return (kind) => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${kind}_${tag}${String(next).padStart(2, "0")}`;
  };
}

export function makeDeps(
  projectRoot: string,
  overrides?: Partial<WorkflowDependencies>,
): WorkflowDependencies {
  return {
    projectRoot,
    readBaseline: () => BASELINE,
    now: () => FIXED_NOW,
    newId: phaseIds("t"),
    ...overrides,
  };
}

export function makeStartInput(overrides?: Partial<StartOperationInput>): StartOperationInput {
  return {
    projectId: "project_demo",
    iterationId: "iteration_t0001",
    goal: "ship the demo feature",
    baselineCommit: BASELINE,
    requirementBaselineDigest: REQUIREMENT_DIGEST,
    policyDigest: POLICY_DIGEST,
    phase: "capture",
    pendingTaskIds: ["task_alpha"],
    budgetCeiling: { steps: 10, tokens: 1000 },
    ...overrides,
  };
}
