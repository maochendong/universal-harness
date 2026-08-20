import { describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";
import { materializeLedger, pageNodes } from "@universal-harness-internal/graph";

import {
  OrchestrationError,
  createGenericInterpreter,
  createInMemoryPlanProposalPort,
  createNewProject,
  resolveApproval,
  resumeIteration,
  runIteration,
  type OrchestrationOutcome,
  type OrchestratorDependencies,
} from "../../src/index.js";
import {
  FIXED_NOW,
  cleanupDirectories,
  headOf,
  makeTempDir,
  sequentialIds,
} from "../bootstrap/helpers.js";

/**
 * T13 plan proposal wiring: with a PlanProposalPort configured, the plan
 * phase compiles canonical assertions, lets the port allocate them and
 * materializes the candidates with Harness-owned identities; the legacy
 * planTasks channel and the new port are mutually exclusive.
 */
const INTENT = "Ship a CSV export for the monthly report.";

function makeDeps(
  projectRoot: string,
  newId: (kind: string) => string,
  overrides?: Partial<OrchestratorDependencies>,
): OrchestratorDependencies {
  return {
    projectRoot,
    readBaseline: () => headOf(projectRoot),
    now: () => FIXED_NOW,
    newId,
    vcs: createGitVcsAdapter(),
    interpret: createGenericInterpreter(),
    ...overrides,
  };
}

async function bootstrap(name: string, newId: (kind: string) => string): Promise<string> {
  const outcome = await createNewProject(
    { parentDirectory: makeTempDir("harness-planprop-"), name, intent: INTENT },
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

describe("plan proposal wiring", { timeout: 90000 }, () => {
  it("drives a full iteration through the PlanProposalPort", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrap("plan-proposal-loop", newId);
    const deps = makeDeps(projectRoot, newId, {
      planProposal: createInMemoryPlanProposalPort((input) => ({
        tasks: [
          {
            task_key: "task-export",
            goal: "implement the CSV export",
            atomicity_rationale: "single independently reviewable output",
            assertion_ids: [],
            requirement_ids: [...input.known_requirement_ids],
            decision_ids: [],
            design_artifact_ids: [],
            depends_on: [],
            suggested_gate_ids: [],
            suggested_write_paths: [],
          },
        ],
        questions: [],
      })),
    });
    try {
      let outcome = await runIteration(deps, { intent: INTENT, intentShape: "pack-converted" });
      let guard = 0;
      while (outcome.status === "approval_required") {
        guard += 1;
        if (guard > 10) throw new Error("approval loop did not terminate");
        outcome = await approveOnce(deps, outcome);
      }
      expect(outcome.status).toBe("completed");
      const { database } = materializeLedger({ projectRoot, databasePath: ":memory:" });
      try {
        const tasks = pageNodes(database, { type: "Task", limit: 20 }).items;
        expect(tasks).toHaveLength(1);
        const spec = tasks[0]?.extensions?.["harness.plan"] as Record<string, unknown> | undefined;
        expect(spec?.["objective"]).toBe("implement the CSV export");
        // The Harness owns the task id and the assertion binding: the id is
        // content-derived from the candidate key and goal, and the fallback
        // assertion carries the accepted test and the full gate suite.
        expect(tasks[0]?.id).toMatch(/^task_[a-f0-9]{16}$/u);
        const assertions = spec?.["assertions"] as Array<Record<string, unknown>>;
        expect(assertions[0]?.["test_ids"]).toEqual(["test_t0001"]);
        expect(assertions[0]?.["required_gate_ids"]).toEqual(["gate_ledger_integrity"]);
      } finally {
        database.close();
      }
    } finally {
      cleanupDirectories();
    }
  });

  it("rejects configuring both the legacy and the proposal channels", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrap("plan-both-channels", newId);
    const deps = makeDeps(projectRoot, newId, {
      planTasks: () => [],
      planProposal: createInMemoryPlanProposalPort(() => ({ tasks: [], questions: [] })),
    });
    try {
      let outcome = await runIteration(deps, { intent: INTENT, intentShape: "pack-converted" });
      outcome = await approveOnce(deps, outcome); // RequirementBaseline
      // The ImpactSet approval resume drives into the plan phase, where the
      // mutually exclusive channels fail fast with a configuration error.
      await expect(approveOnce(deps, outcome)).rejects.toThrow(OrchestrationError);
    } finally {
      cleanupDirectories();
    }
  });
});
