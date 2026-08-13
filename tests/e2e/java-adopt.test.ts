import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertCompleteLoopArtifacts,
  assertProviderProjection,
  cleanupE2eRoots,
  makeFixtureRepo,
  runAdoptLoop,
  runCleanCloneAdopt,
  sequentialIds,
  stackSpec,
} from "./complete-loop.assertions.js";
import { git } from "./helpers.js";

/**
 * Java `harness adopt` E2E (plan Task 26): the deterministic scanner detects
 * the Java stack from `pom.xml`, adoption pins the Java pack into the
 * lockfile, and the closed loop completes with the full artifact battery. No
 * JDK is assumed on the host, so the stack is covered at the detection and
 * scan level rather than by executing a real build. The clean-clone rerun
 * compares the normalized ledger, the human projection digests and the
 * provider mirror digest byte for byte.
 */
const spec = stackSpec("java");

beforeEach(() => {
  // Fixed Git authorship timestamps make every commit digest reproducible
  // across independent reruns of the same fixture scenario.
  vi.stubEnv("GIT_AUTHOR_DATE", "2026-08-12T00:00:00+00:00");
  vi.stubEnv("GIT_COMMITTER_DATE", "2026-08-12T00:00:00+00:00");
});

afterEach(() => {
  vi.unstubAllEnvs();
  cleanupE2eRoots();
});

describe("java adopt E2E", { timeout: 90000 }, () => {
  it("detects the java stack, pins the pack and completes the closed loop", async () => {
    const repo = makeFixtureRepo(spec);
    const loop = await runAdoptLoop(spec, repo, sequentialIds());
    expect(loop.approved).toEqual(["RequirementBaseline", "ImpactSet"]);

    await assertCompleteLoopArtifacts(repo, loop.session, loop.harness, {
      intentFragment: spec.adoptIntent,
    });
    assertProviderProjection(repo, spec, loop.harness);
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
