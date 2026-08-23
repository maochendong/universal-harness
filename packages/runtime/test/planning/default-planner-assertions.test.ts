import { afterEach, describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";
import { materializeLedger, pageNodes } from "@universal-harness-internal/graph";

import {
  PlanningError,
  createDirectExecutor,
  createNewProject,
  resolveApproval,
  resumeIteration,
  runIteration,
  type OrchestrationOutcome,
  type OrchestratorDependencies,
} from "../../src/index.js";
import {
  contentDigest,
  criterionAssertionId,
  criterionSemanticDigest,
  sha256Hex,
} from "../../../core/src/index.js";
import {
  FIXED_NOW,
  cleanupDirectories,
  headOf,
  makeTempDir,
  sequentialIds,
} from "../bootstrap/helpers.js";

/**
 * Default-planner criterion assertions (provable TDD design 7.1): with
 * neither a PlanProposalPort nor the legacy planTasks channel configured, the
 * deterministic decomposition still compiles every accepted criterion to its
 * canonical criterion_assertion — identity fixed by the
 * harness:criterion-assertion formula, stable under unrelated insertions —
 * and fails closed when coverage breaks.
 */
const INTENT = "Ship the monthly report export.";
const REQUIREMENT_STATEMENT = "the monthly report export ships";

interface CriterionInput {
  readonly description: string;
  readonly verification: string;
}

const CRITERION_ALPHA: CriterionInput = {
  description: "the export produces the monthly CSV",
  verification: "mandatory gate suite passes",
};
const CRITERION_BETA: CriterionInput = {
  description: "the export is downloadable from the report page",
  verification: "mandatory gate suite passes",
};
const CRITERION_INSERTED: CriterionInput = {
  description: "the export lists the reporting period",
  verification: "mandatory gate suite passes",
};

afterEach(cleanupDirectories);

function makeDeps(
  projectRoot: string,
  newId: (kind: string) => string,
  criteria: readonly CriterionInput[],
): OrchestratorDependencies {
  return {
    projectRoot,
    readBaseline: () => headOf(projectRoot),
    now: () => FIXED_NOW,
    newId,
    vcs: createGitVcsAdapter(),
    execution: {
      kind: "workflow",
      name: "test-explicit-direct-workflow",
      deterministic: true,
      execute: createDirectExecutor(),
    },
    interpret: () => ({
      requirements: [{ statement: REQUIREMENT_STATEMENT, acceptance: criteria }],
    }),
  };
}

async function bootstrap(name: string, newId: (kind: string) => string): Promise<string> {
  const outcome = await createNewProject(
    { parentDirectory: makeTempDir("harness-default-plan-"), name, intent: INTENT },
    { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId },
  );
  if (!outcome.ok) throw new Error(outcome.error.message);
  return outcome.value.projectRoot;
}

async function approveOnce(
  deps: OrchestratorDependencies,
  outcome: OrchestrationOutcome,
): Promise<OrchestrationOutcome> {
  if (outcome.status !== "approval_required") {
    throw new Error(`expected approval_required, got ${outcome.status}`);
  }
  await resolveApproval(deps, {
    requestId: outcome.required.request_id,
    decision: "approve",
    actor: "human:reviewer",
  });
  return resumeIteration(deps, outcome.required.workflow_operation_id, undefined);
}

async function driveToCompletion(deps: OrchestratorDependencies): Promise<OrchestrationOutcome> {
  let outcome = await runIteration(deps, { intent: INTENT, intentShape: "pack-converted" });
  let guard = 0;
  while (outcome.status === "approval_required") {
    guard += 1;
    if (guard > 10) throw new Error("approval loop did not terminate");
    outcome = await approveOnce(deps, outcome);
  }
  return outcome;
}

/** Assertions of the iteration's persisted default-planner task, in specification order. */
function planAssertions(
  projectRoot: string,
  iterationId: string,
): { assertion_id: string; test_ids: string[] }[] {
  const { database } = materializeLedger({ projectRoot, databasePath: ":memory:" });
  try {
    const tasks = pageNodes(database, { type: "Task", limit: 100 }).items.filter(
      (task) => task.provenance.iteration_id === iterationId,
    );
    if (tasks.length !== 1) throw new Error(`expected one task, got ${tasks.length}`);
    const spec = tasks[0]?.extensions?.["harness.plan"] as
      { assertions: { assertion_id: string; test_ids: string[] }[] } | undefined;
    return spec?.assertions ?? [];
  } finally {
    database.close();
  }
}

function planAssertionIds(projectRoot: string, iterationId: string): string[] {
  return planAssertions(projectRoot, iterationId).map((assertion) => assertion.assertion_id);
}

/**
 * The canonical identity the default planner must compile: the legacy
 * baseline carries no criterion records, so the criterion id derives from the
 * requirement plus the semantic digest of the pair (the legacy semantic
 * mapping the proposal adapter establishes), and the assertion id follows
 * the harness:criterion-assertion formula over both.
 */
function canonicalAssertionIdFor(criterion: CriterionInput): string {
  const requirementId = `requirement_${sha256Hex(REQUIREMENT_STATEMENT).slice(0, 16)}`;
  const semanticDigest = criterionSemanticDigest({
    requirement_id: requirementId,
    precondition: "",
    action: criterion.description,
    observable_outcome: criterion.description,
    verification_intent: criterion.verification,
    scenario_kind: "primary",
  });
  const criterionId = `criterion_${contentDigest({ requirement: requirementId, criterion_semantic_digest: semanticDigest }).slice(0, 16)}`;
  return criterionAssertionId({
    criterion_id: criterionId,
    criterion_semantic_digest: semanticDigest,
  });
}

describe("default planner criterion assertions", { timeout: 90000 }, () => {
  it("compiles assertion identity with the canonical criterion-assertion formula", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrap("default-plan-canonical", newId);
    const deps = makeDeps(projectRoot, newId, [CRITERION_ALPHA, CRITERION_BETA]);

    const outcome = await driveToCompletion(deps);
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;

    const assertions = planAssertions(projectRoot, outcome.iterationId);
    expect(assertions.map((assertion) => assertion.assertion_id)).toEqual([
      canonicalAssertionIdFor(CRITERION_ALPHA),
      canonicalAssertionIdFor(CRITERION_BETA),
    ]);
    for (const assertion of assertions) {
      expect(assertion.assertion_id).toMatch(/^criterion-assertion_/u);
    }
    // Criterion → Assertion → corresponding Test seed is 1:1. A task may own
    // multiple assertions, but their test bindings must not be merged.
    expect(assertions.map((assertion) => assertion.test_ids)).toEqual([
      ["test_t0001"],
      ["test_t0002"],
    ]);
  });

  it("keeps assertion identity stable when an unrelated criterion is inserted", async () => {
    const firstIds = sequentialIds();
    const firstRoot = await bootstrap("default-plan-stable-a", firstIds);
    const first = await driveToCompletion(
      makeDeps(firstRoot, firstIds, [CRITERION_ALPHA, CRITERION_BETA]),
    );
    expect(first.status).toBe("completed");
    if (first.status !== "completed") return;

    const secondIds = sequentialIds();
    const secondRoot = await bootstrap("default-plan-stable-b", secondIds);
    const second = await driveToCompletion(
      makeDeps(secondRoot, secondIds, [CRITERION_ALPHA, CRITERION_INSERTED, CRITERION_BETA]),
    );
    expect(second.status).toBe("completed");
    if (second.status !== "completed") return;

    const before = planAssertionIds(firstRoot, first.iterationId);
    const after = planAssertionIds(secondRoot, second.iterationId);
    expect(after).toHaveLength(3);
    // Insertion in the middle rotates nothing: both pre-existing criteria keep
    // their canonical assertion ids and positions, and the new criterion
    // mints its own.
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[1]);
    expect(after[1]).toBe(canonicalAssertionIdFor(CRITERION_INSERTED));
  });

  it("fails closed when two accepted criteria compile to the same assertion", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrap("default-plan-duplicate", newId);
    const deps = makeDeps(projectRoot, newId, [CRITERION_ALPHA, CRITERION_ALPHA]);

    let outcome = await runIteration(deps, { intent: INTENT, intentShape: "pack-converted" });
    outcome = await approveOnce(deps, outcome); // RequirementBaseline
    // The ImpactSet approval resume drives into the plan phase, where the
    // duplicate criterion identity fails coverage validation closed.
    const rejection = await approveOnce(deps, outcome).then(
      () => {
        throw new Error("expected the plan phase to fail closed");
      },
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(PlanningError);
    expect((rejection as Error).message).toContain("duplicate_assertion");
  });
});
