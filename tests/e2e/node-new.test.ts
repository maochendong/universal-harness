import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EXIT_CODES } from "../../packages/cli/src/index.js";
import {
  assertCompleteLoopArtifacts,
  assertProviderProjection,
  cleanupE2eRoots,
  createNodeStackGateSuite,
  drivePastApprovals,
  lockedPackNames,
  makeTempDir,
  sequentialIds,
  stackSpec,
} from "./complete-loop.assertions.js";
import { git, makeHarness, runJson } from "./helpers.js";

/**
 * Node `harness new` E2E (plan Task 26): `new` is stack-neutral by design and
 * pins the generic pack; once the project carries real Node content, the
 * follow-up iteration runs the Node pack's declared mandatory stack gate for
 * real through the Tool Registry (`node --test`, the one declared host
 * toolchain) and lands a completed Snapshot.
 */
const spec = stackSpec("node");

afterEach(cleanupE2eRoots);

describe("node new E2E", { timeout: 90000 }, () => {
  it("runs new, then iterates over node content with the pack stack gate", async () => {
    const parent = makeTempDir("harness-e2e-node-new-");
    const newId = sequentialIds();
    const intent = "build the first node capability";

    const result = await runJson(["new", "demo-app", "--intent", intent, "--profile", "lite"], {
      cwd: parent,
      runtime: makeHarness(parent, newId).runtime,
    });
    expect(result.exitCode).toBe(EXIT_CODES.approvalRequired);
    const projectRoot = join(parent, "demo-app");
    expect(existsSync(join(projectRoot, ".harness", "manifest.yaml"))).toBe(true);
    expect(lockedPackNames(projectRoot)).toContain("pack-generic");
    git(projectRoot, "config", "user.name", "Harness E2E");
    git(projectRoot, "config", "user.email", "harness-e2e@example.com");
    git(projectRoot, "config", "commit.gpgsign", "false");

    const harness = makeHarness(projectRoot, newId);
    const session = { cwd: projectRoot, runtime: harness.runtime };
    const driven = await drivePastApprovals(result, session);
    expect(driven.result.json["status"]).toBe("ok");
    expect(driven.approved).toEqual([
      "RequirementBaseline",
      "ImpactSet",
      "ExecutionAuthorizationSpec",
    ]);

    // The project takes on real stack content; the loop is content-agnostic.
    cpSync(spec.fixtureDirectory, projectRoot, { recursive: true });
    git(projectRoot, "add", "-A");
    git(projectRoot, "commit", "-m", "import the node fixture content");

    const suite = createNodeStackGateSuite(projectRoot);
    const stackHarness = makeHarness(projectRoot, newId, {
      gates: suite.gates,
      toolRegistry: suite.toolRegistry,
    });
    const stackSession = { cwd: projectRoot, runtime: stackHarness.runtime };
    const iterated = await drivePastApprovals(
      await runJson(["iterate", spec.iterateIntent], stackSession),
      stackSession,
    );
    expect(iterated.result.json["status"]).toBe("ok");

    await assertCompleteLoopArtifacts(projectRoot, stackSession, stackHarness, {
      intentFragment: intent,
      extraGateIds: ["gate_node_test"],
    });
    assertProviderProjection(projectRoot, spec, stackHarness);
    expect(git(projectRoot, "status", "--porcelain").trim()).toBe("");
  });
});
