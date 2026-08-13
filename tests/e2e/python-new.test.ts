import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EXIT_CODES } from "../../packages/cli/src/index.js";
import {
  assertCompleteLoopArtifacts,
  assertProviderProjection,
  cleanupE2eRoots,
  drivePastApprovals,
  lockedPackNames,
  makeTempDir,
  sequentialIds,
  stackSpec,
} from "./complete-loop.assertions.js";
import { git, makeHarness, runJson } from "./helpers.js";

/**
 * Python `harness new` E2E (plan Task 26): `new` is stack-neutral by design
 * and pins the generic pack; the follow-up iteration proves the same closed
 * loop completes over real Python content. Python stack gates are covered at
 * the detection and scan level (no interpreter is assumed on the host).
 */
const spec = stackSpec("python");

afterEach(cleanupE2eRoots);

describe("python new E2E", { timeout: 90000 }, () => {
  it("runs new, then iterates over python content through the same loop", async () => {
    const parent = makeTempDir("harness-e2e-python-new-");
    const newId = sequentialIds();
    const intent = "build the first python capability";

    const result = await runJson(["new", "demo-app", "--intent", intent], {
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
    expect(driven.approved).toEqual(["RequirementBaseline", "ImpactSet"]);

    cpSync(spec.fixtureDirectory, projectRoot, { recursive: true });
    git(projectRoot, "add", "-A");
    git(projectRoot, "commit", "-m", "import the python fixture content");

    const iterated = await drivePastApprovals(
      await runJson(["iterate", spec.iterateIntent], session),
      session,
    );
    expect(iterated.result.json["status"]).toBe("ok");
    expect(harness.executorCalls).toHaveLength(2);

    await assertCompleteLoopArtifacts(projectRoot, session, harness, {
      intentFragment: intent,
    });
    assertProviderProjection(projectRoot, spec, harness);
    expect(git(projectRoot, "status", "--porcelain").trim()).toBe("");
  });
});
