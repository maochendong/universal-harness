import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";

import {
  createGenericInterpreter,
  createDirectExecutor,
  createNewProject,
  resolveApproval,
  resumeIteration,
  runIteration,
  type IterationNarrativeInput,
  type OrchestrationOutcome,
  type OrchestratorDependencies,
} from "../../src/index.js";
import { createInMemoryGroundedSynthesisAdapter, harnessRootFor } from "../../../core/src/index.js";
import {
  FIXED_NOW,
  cleanupDirectories,
  headOf,
  makeTempDir,
  sequentialIds,
} from "../bootstrap/helpers.js";

/**
 * PG-7 snapshot narrative wiring: the narrative compiles only after the
 * authoritative snapshot commits; a clean narrative persists beside it, a
 * failed one produces a recoverable projection finding, and neither ever
 * changes the completed snapshot or its verdicts.
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
    execute: createDirectExecutor(),
    ...overrides,
  };
}

async function driveToCompletion(
  deps: OrchestratorDependencies,
  first: OrchestrationOutcome,
): Promise<OrchestrationOutcome> {
  let outcome = first;
  let guard = 0;
  while (outcome.status === "approval_required") {
    guard += 1;
    if (guard > 10) throw new Error("approval loop did not terminate");
    await resolveApproval(deps, {
      requestId: outcome.required.request_id,
      decision: "approve",
      actor: "human:reviewer",
    });
    outcome = await resumeIteration(deps, outcome.required.workflow_operation_id, undefined);
  }
  return outcome;
}

async function bootstrap(name: string, newId: (kind: string) => string): Promise<string> {
  const outcome = await createNewProject(
    { parentDirectory: makeTempDir("harness-narrative-"), name, intent: INTENT },
    { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId },
  );
  if (!outcome.ok) throw new Error(outcome.error.message);
  return outcome.value.projectRoot;
}

describe("iteration narrative wiring", { timeout: 60000 }, () => {
  it("persists a cited narrative after the snapshot commits", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrap("narrative-clean", newId);
    const port = createInMemoryGroundedSynthesisAdapter((input) => {
      const narrative = input as IterationNarrativeInput;
      const source = narrative.bundle.sources[0];
      return {
        status: "completed",
        output: {
          purpose: "iteration_narrative",
          schema_version: "iteration-narrative.v1",
          bundle_digest: narrative.bundle.record_digest,
          outcomes: [
            {
              summary: "the iteration completed",
              source_refs: [
                { locator: source?.locator ?? "", source_digest: source?.source_digest ?? "" },
              ],
            },
          ],
          residual_risks: [],
          follow_ups: [],
        },
      };
    });
    const deps = makeDeps(projectRoot, newId, { iterationNarrative: port });
    try {
      const first = await runIteration(deps, { intent: INTENT, intentShape: "pack-converted" });
      const outcome = await driveToCompletion(deps, first);
      expect(outcome.status).toBe("completed");
      const dir = join(harnessRootFor(projectRoot), "artifacts", "iteration-narratives");
      expect(existsSync(dir)).toBe(true);
      const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
      expect(files).toHaveLength(1);
      const record = JSON.parse(readFileSync(join(dir, files[0] ?? ""), "utf8")) as {
        purpose: string;
      };
      expect(record.purpose).toBe("iteration_narrative");
    } finally {
      cleanupDirectories();
    }
  });

  it("turns a failed narrative into a recoverable projection finding only", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrap("narrative-fail", newId);
    const port = createInMemoryGroundedSynthesisAdapter(() => ({
      status: "failed",
      failure: { code: "provider_unavailable", summary: "simulated outage", retryable: true },
    }));
    const deps = makeDeps(projectRoot, newId, { iterationNarrative: port });
    try {
      const first = await runIteration(deps, { intent: INTENT, intentShape: "pack-converted" });
      const outcome = await driveToCompletion(deps, first);
      // The snapshot completes regardless of the narrative failure.
      expect(outcome.status).toBe("completed");
      const harnessRoot = harnessRootFor(projectRoot);
      expect(existsSync(join(harnessRoot, "artifacts", "iteration-narratives"))).toBe(false);
      const findingsDir = join(harnessRoot, "artifacts", "findings");
      expect(existsSync(findingsDir)).toBe(true);
      const projectionFinding = readdirSync(findingsDir)
        .map((name) => join(findingsDir, name, "1.json"))
        .map((path) =>
          existsSync(path)
            ? (JSON.parse(readFileSync(path, "utf8")) as {
                extensions: { "harness.finding": { rule: string; severity: string } };
              })
            : undefined,
        )
        .find(
          (finding) =>
            finding?.extensions["harness.finding"].rule === "projection/iteration_narrative",
        );
      expect(projectionFinding?.extensions["harness.finding"].severity).toBe("warning");
    } finally {
      cleanupDirectories();
    }
  });
});
