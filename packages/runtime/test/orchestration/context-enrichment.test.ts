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
  type ContextEnrichmentInput,
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
 * PG-6 phase wiring: with a context enrichment port configured, the context
 * phase persists one grounded enrichment per committed bundle, bound to the
 * exact bundle digest; the bundles themselves are untouched.
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

// Windows CI needs the same headroom as the orchestrator suite: observed
// 60s+ for the enrichment loop there. Full-suite parallel load on developer
// machines can push individual enrichment tests past 60s as well.
const TEST_TIMEOUT_SCALE = process.platform === "win32" ? 4 : 1;

describe("context enrichment wiring", { timeout: 120_000 * TEST_TIMEOUT_SCALE }, () => {
  it("persists cited enrichments beside untouched bundles", async () => {
    const newId = sequentialIds();
    const outcome0 = await createNewProject(
      { parentDirectory: makeTempDir("harness-enrich-"), name: "enrich-loop", intent: INTENT },
      { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId },
    );
    if (!outcome0.ok) throw new Error(outcome0.error.message);
    const projectRoot = outcome0.value.projectRoot;
    const port = createInMemoryGroundedSynthesisAdapter((input) => {
      const enrichment = input as ContextEnrichmentInput;
      const source = enrichment.bundle.sources[0];
      return {
        status: "completed",
        output: {
          purpose: "context_enrichment",
          schema_version: "context-enrichment.v1",
          bundle_digest: enrichment.bundle.record_digest,
          terms: [
            {
              term: "requirement",
              definition: "the accepted objective",
              source_refs: [
                { locator: source?.locator ?? "", source_digest: source?.source_digest ?? "" },
              ],
            },
          ],
          segment_summaries: [],
          relevance_explanations: [],
        },
      };
    });
    const deps = makeDeps(projectRoot, newId, { contextEnrichment: port });
    try {
      let outcome = await runIteration(deps, { intent: INTENT, intentShape: "pack-converted" });
      let guard = 0;
      while (outcome.status === "approval_required") {
        guard += 1;
        if (guard > 10) throw new Error("approval loop did not terminate");
        outcome = await approveOnce(deps, outcome);
      }
      expect(outcome.status).toBe("completed");
      expect(port.invocations.length).toBeGreaterThan(0);

      const harnessRoot = harnessRootFor(projectRoot);
      const enrichmentDir = join(harnessRoot, "artifacts", "context-enrichments");
      expect(existsSync(enrichmentDir)).toBe(true);
      const enrichments = readdirSync(enrichmentDir).filter((name) => name.endsWith(".json"));
      expect(enrichments.length).toBeGreaterThan(0);
      const bundleDigests = readdirSync(join(harnessRoot, "artifacts", "context-bundles"))
        .filter((name) => name.endsWith(".json"))
        .map((name) => {
          const record = JSON.parse(
            readFileSync(join(harnessRoot, "artifacts", "context-bundles", name), "utf8"),
          ) as { digest: string };
          return record.digest;
        });
      for (const name of enrichments) {
        const record = JSON.parse(readFileSync(join(enrichmentDir, name), "utf8")) as {
          purpose: string;
          binding_digest: string;
        };
        expect(record.purpose).toBe("context_enrichment");
        expect(bundleDigests).toContain(record.binding_digest);
      }
    } finally {
      cleanupDirectories();
    }
  });

  it("runs no enrichment without a configured port", async () => {
    const newId = sequentialIds();
    const outcome0 = await createNewProject(
      { parentDirectory: makeTempDir("harness-enrich-off-"), name: "enrich-off", intent: INTENT },
      { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId },
    );
    if (!outcome0.ok) throw new Error(outcome0.error.message);
    const projectRoot = outcome0.value.projectRoot;
    const deps = makeDeps(projectRoot, newId);
    try {
      let outcome = await runIteration(deps, { intent: INTENT, intentShape: "pack-converted" });
      let guard = 0;
      while (outcome.status === "approval_required") {
        guard += 1;
        if (guard > 10) throw new Error("approval loop did not terminate");
        outcome = await approveOnce(deps, outcome);
      }
      expect(outcome.status).toBe("completed");
      expect(
        existsSync(join(harnessRootFor(projectRoot), "artifacts", "context-enrichments")),
      ).toBe(false);
    } finally {
      cleanupDirectories();
    }
  });
});
