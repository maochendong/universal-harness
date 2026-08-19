import { existsSync } from "node:fs";
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
 * Generic `harness new` E2E (plan Task 23): one entry command bootstraps the
 * project and drives the full closed loop, pausing only at the mandatory
 * baseline, impact and execution-authorization approvals, and lands a
 * completed Snapshot.
 */
afterEach(cleanupE2eRoots);

describe("generic new E2E", { timeout: 60000 }, () => {
  it("runs new through all approvals to a completed snapshot", async () => {
    const parent = makeTempDir("harness-e2e-new-");
    const newId = sequentialIds();
    const bootstrapHarness = makeHarness(parent, newId);

    let result = await runJson(
      ["new", "demo-app", "--intent", "build the first capability", "--profile", "lite"],
      {
        cwd: parent,
        runtime: bootstrapHarness.runtime,
      },
    );
    expect(result.exitCode).toBe(EXIT_CODES.approvalRequired);
    let data = result.json["data"] as Record<string, unknown>;
    expect(data["object_type"]).toBe("RequirementBaseline");
    const projectRoot = join(parent, "demo-app");
    expect(existsSync(join(projectRoot, ".harness", "manifest.yaml"))).toBe(true);

    // From here on the project root is the cwd, like a real user session.
    const harness = makeHarness(projectRoot, newId);
    const session = { cwd: projectRoot, runtime: harness.runtime };

    result = await approveAndResume(result, session);
    expect(result.json["status"]).toBe("approval_required");
    data = result.json["data"] as Record<string, unknown>;
    expect(data["object_type"]).toBe("ImpactSet");

    result = await approveAndResume(result, session);
    expect(result.json["status"]).toBe("approval_required");
    data = result.json["data"] as Record<string, unknown>;
    expect(data["object_type"]).toBe("ExecutionAuthorizationSpec");

    result = await approveAndResume(result, session);
    expect(result.json["status"]).toBe("ok");
    data = result.json["data"] as Record<string, unknown>;
    expect(typeof data["snapshot_id"]).toBe("string");
    expect(harness.executorCalls).toHaveLength(1);

    // The terminal snapshot is inspectable and the worktree is clean.
    const snapshot = await runJson(["snapshot"], session);
    expect(snapshot.json["status"]).toBe("ok");
    expect((snapshot.json["data"] as Record<string, unknown>)["status"]).toBe("completed");
    const status = await runJson(["status"], session);
    expect(status.json["status"]).toBe("ok");
    expect(git(projectRoot, "status", "--porcelain").trim()).toBe("");
  });
});
