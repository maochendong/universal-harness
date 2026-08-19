import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";

import { collectProjectStatus, readLatestSnapshot } from "../../packages/runtime/src/index.js";

import {
  approveAndResume,
  cleanupE2eRoots,
  git,
  makeHarness,
  makeTempDir,
  runJson,
  sequentialIds,
} from "./helpers.js";

afterEach(cleanupE2eRoots);

describe("delegated Agent governed vertical loop", { timeout: 60_000 }, () => {
  it("keeps Run handoff, passes TaskVerdict and exposes unambiguous commit refs", async () => {
    const parent = makeTempDir("harness-e2e-governed-agent-");
    const newId = sequentialIds();
    let result = await runJson(
      ["new", "governed-agent", "--intent", "ship governed work", "--profile", "lite"],
      {
        cwd: parent,
        runtime: makeHarness(parent, newId).runtime,
      },
    );
    const projectRoot = join(parent, "governed-agent");
    const harness = makeHarness(projectRoot, newId);
    const session = { cwd: projectRoot, runtime: harness.runtime };
    for (let round = 0; result.json["status"] === "approval_required" && round < 8; round += 1) {
      result = await approveAndResume(result, session);
    }

    expect(result.json["status"]).toBe("ok");
    const data = result.json["data"] as Record<string, unknown>;
    expect(data).toMatchObject({
      source_commit: expect.stringMatching(/^[a-f0-9]{40}$/u),
      repository_head: expect.stringMatching(/^[a-f0-9]{40}$/u),
    });
    expect(data).toHaveProperty("ledger_commit");

    const snapshot = readLatestSnapshot(projectRoot);
    expect(snapshot?.run_outcomes).toEqual([expect.objectContaining({ outcome: "handoff" })]);
    expect(snapshot?.task_verdicts).toEqual([expect.objectContaining({ verdict: "passed" })]);
    expect(snapshot).not.toHaveProperty("ledger_commit");

    const status = collectProjectStatus(projectRoot);
    expect(status.blockers).toEqual([]);
    expect(status.stale_evidence).toEqual([]);
    expect(status.evaluation_coverage.runs).toMatchObject({ covered: 1, total: 1 });
    expect(status.evaluation_coverage.tasks).toMatchObject({ covered: 1, total: 1 });
    expect(git(projectRoot, "status", "--porcelain").trim()).toBe("");
  });
});
