import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  artifactFiles,
  assertCompleteLoopArtifacts,
  assertProviderProjection,
  cleanupE2eRoots,
  createNodeStackGateSuite,
  drivePastApprovals,
  makeFixtureRepo,
  runAdoptLoop,
  runCleanCloneAdopt,
  sequentialIds,
  stackSpec,
} from "./complete-loop.assertions.js";
import { git, makeHarness, runJson } from "./helpers.js";

/**
 * Node `harness adopt` E2E (plan Task 26): the deterministic scanner detects
 * the Node stack from `package.json`, adoption pins the Node pack into the
 * lockfile, and the closed loop completes with the full artifact battery. The
 * follow-up iteration runs the pack-declared `node_test` stack gate for real.
 * The clean-clone rerun compares the normalized ledger, the human projection
 * digests and the provider mirror digest byte for byte.
 */
const spec = stackSpec("node");

beforeEach(() => {
  // Fixed Git authorship timestamps make every commit digest reproducible
  // across independent reruns of the same fixture scenario.
  vi.stubEnv("GIT_AUTHOR_DATE", "2026-08-12T00:00:00+00:00");
  vi.stubEnv("GIT_COMMITTER_DATE", "2026-08-12T00:00:00+00:00");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupE2eRoots();
});

describe("node adopt E2E", { timeout: 90000 }, () => {
  it("detects the node stack, pins the pack and completes the closed loop", async () => {
    const repo = makeFixtureRepo(spec);
    // One id mint per project: identifiers are project-scoped, so every
    // session over the same repository must share the sequence.
    const newId = sequentialIds();
    const loop = await runAdoptLoop(spec, repo, newId);
    expect(loop.approved).toEqual(["RequirementBaseline", "ImpactSet"]);

    await assertCompleteLoopArtifacts(repo, loop.session, loop.harness, {
      intentFragment: spec.adoptIntent,
    });

    // The pack-declared mandatory stack gate runs for real on the next
    // iteration: node is the one declared host toolchain.
    const suite = createNodeStackGateSuite(repo);
    const harness = makeHarness(repo, newId, {
      gates: suite.gates,
      toolRegistry: suite.toolRegistry,
    });
    const session = { cwd: repo, runtime: harness.runtime };
    const driven = await drivePastApprovals(
      await runJson(["iterate", spec.iterateIntent], session),
      session,
    );
    expect(driven.result.json["status"]).toBe("ok");
    expect(artifactFiles(repo, "artifacts/evidence/evidence_node_test").length).toBeGreaterThan(0);

    assertProviderProjection(repo, spec, harness);
    expect(git(repo, "status", "--porcelain").trim()).toBe("");
  });

  it("replays the fixture from clean clones with identical records", async () => {
    const source = makeFixtureRepo(spec);
    const first = await runCleanCloneAdopt(spec, source);
    const second = await runCleanCloneAdopt(spec, source);
    expect(second.normalizedLedger).toEqual(first.normalizedLedger);
    expect(second.prdDigest).toBe(first.prdDigest);
    expect(second.planDigest).toBe(first.planDigest);
    expect(second.mirrorDigest).toBe(first.mirrorDigest);
  });
});
