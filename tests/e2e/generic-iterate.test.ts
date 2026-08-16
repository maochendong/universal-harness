import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EXIT_CODES } from "../../packages/cli/src/index.js";
import {
  approveAndResume,
  cleanupE2eRoots,
  git,
  makeHarness,
  makeTempDir,
  runJson,
  sequentialIds,
} from "./helpers.js";

/**
 * Generic `harness iterate` E2E (plan Task 23): a follow-up change runs the
 * same full closed loop inside an existing managed project, and the advanced
 * inspection commands report the committed pipeline state.
 */
afterEach(cleanupE2eRoots);

async function completeIteration(
  first: Awaited<ReturnType<typeof runJson>>,
  session: { cwd: string; runtime: ReturnType<typeof makeHarness>["runtime"] },
): Promise<Awaited<ReturnType<typeof runJson>>> {
  let result = first;
  for (let step = 0; step < 4 && result.json["status"] === "approval_required"; step += 1) {
    result = await approveAndResume(result, session);
  }
  return result;
}

describe("generic iterate E2E", { timeout: 90000 }, () => {
  it("runs a second iteration to a completed snapshot with full inspection", async () => {
    const parent = makeTempDir("harness-e2e-iterate-");
    const newId = sequentialIds();

    // First iteration via `new`.
    let result = await runJson(["new", "demo-app", "--intent", "build the first capability"], {
      cwd: parent,
      runtime: makeHarness(parent, newId).runtime,
    });
    expect(result.exitCode).toBe(EXIT_CODES.approvalRequired);
    const projectRoot = join(parent, "demo-app");
    const harness = makeHarness(projectRoot, newId);
    const session = { cwd: projectRoot, runtime: harness.runtime };
    result = await completeIteration(result, session);
    expect(result.json["status"]).toBe("ok");

    // Follow-up change: same closed loop, same approval points.
    result = await runJson(["iterate", "implement the next change"], session);
    expect(result.exitCode).toBe(EXIT_CODES.approvalRequired);
    result = await completeIteration(result, session);
    expect(result.json["status"]).toBe("ok");
    const data = result.json["data"] as Record<string, unknown>;
    expect(typeof data["snapshot_id"]).toBe("string");
    expect(harness.executorCalls).toHaveLength(2);

    // Advanced commands report the committed pipeline state.
    const plan = await runJson(["plan"], session);
    expect(plan.json["status"]).toBe("ok");
    expect((plan.json["data"] as Record<string, unknown>)["mode"]).toBe("single-loop");

    const impact = await runJson(["impact"], session);
    expect(impact.json["status"]).toBe("ok");

    const dryRun = await runJson(["run", "--dry-run"], session);
    expect(dryRun.json["status"]).toBe("ok");
    expect((dryRun.json["data"] as Record<string, unknown>)["dry_run"]).toBe(true);

    const audit = await runJson(["audit"], session);
    expect(["ok", "failed"]).toContain(audit.json["status"]);

    const check = await runJson(["graph", "check"], session);
    expect(check.json["status"]).toBe("ok");

    const sync = await runJson(["graph", "sync"], session);
    expect(sync.json["status"]).toBe("ok");
    expect((sync.json["data"] as Record<string, unknown>)["nodes"] as number).toBeGreaterThan(0);

    const status = await runJson(["status"], session);
    expect(status.json["status"]).toBe("ok");
    expect(git(projectRoot, "status", "--porcelain").trim()).toBe("");
  });
});
