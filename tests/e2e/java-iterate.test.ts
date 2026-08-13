import { afterEach, describe, expect, it } from "vitest";

import {
  assertGateFailureFeedbackAndResume,
  assertInvalidToolOutputFeedbackAndResume,
  assertUncertainExternalActionFeedback,
  cleanupE2eRoots,
  drivePastApprovals,
  makeFixtureRepo,
  runAdoptLoop,
  sequentialIds,
  stackSpec,
} from "./complete-loop.assertions.js";
import { git, runJson } from "./helpers.js";

/**
 * Java `harness iterate` E2E (plan Task 26): the follow-up change runs the
 * same full closed loop inside the adopted Java project, the inspection
 * commands report the committed pipeline state, and the negative paths --
 * injected gate failure, invalid tool output and uncertain external action --
 * produce feedback and a blocked-resume, never silent upstream rewrites.
 */
const spec = stackSpec("java");

afterEach(cleanupE2eRoots);

describe("java iterate E2E", { timeout: 90000 }, () => {
  it("runs a follow-up iterate loop with full inspection", async () => {
    const repo = makeFixtureRepo(spec);
    const newId = sequentialIds();
    const loop = await runAdoptLoop(spec, repo, newId);

    const driven = await drivePastApprovals(
      await runJson(["iterate", spec.iterateIntent], loop.session),
      loop.session,
    );
    expect(driven.result.json["status"]).toBe("ok");
    expect(driven.approved).toEqual(["RequirementBaseline", "ImpactSet"]);
    expect(loop.harness.executorCalls).toHaveLength(2);

    const plan = await runJson(["plan"], loop.session);
    expect(plan.json["status"]).toBe("ok");
    const impact = await runJson(["impact"], loop.session);
    expect(impact.json["status"]).toBe("ok");
    const dryRun = await runJson(["run", "--dry-run"], loop.session);
    expect((dryRun.json["data"] as Record<string, unknown>)["dry_run"]).toBe(true);
    const audit = await runJson(["audit"], loop.session);
    expect(["ok", "failed"]).toContain(audit.json["status"]);
    const sync = await runJson(["graph", "sync"], loop.session);
    expect(sync.json["status"]).toBe("ok");
    const check = await runJson(["graph", "check"], loop.session);
    expect(check.json["status"]).toBe("ok");
    const status = await runJson(["status"], loop.session);
    expect(status.json["status"]).toBe("ok");
    expect(git(repo, "status", "--porcelain").trim()).toBe("");
  });

  it("gate failure produces feedback and a blocked-resume", async () => {
    const repo = makeFixtureRepo(spec);
    const newId = sequentialIds();
    await runAdoptLoop(spec, repo, newId);
    await assertGateFailureFeedbackAndResume(spec, repo, newId);
    expect(git(repo, "status", "--porcelain").trim()).toBe("");
  });

  it("invalid tool output produces feedback and a blocked-resume", async () => {
    const repo = makeFixtureRepo(spec);
    const newId = sequentialIds();
    await runAdoptLoop(spec, repo, newId);
    await assertInvalidToolOutputFeedbackAndResume(spec, repo, newId);
    expect(git(repo, "status", "--porcelain").trim()).toBe("");
  });

  it("uncertain external action blocks blind retry and resumes via reconciliation", async () => {
    await assertUncertainExternalActionFeedback();
  });
});
