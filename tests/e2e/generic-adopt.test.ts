import { writeFileSync } from "node:fs";
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
 * Generic `harness adopt` E2E (plan Task 23): scan an existing repository,
 * approve the staged adoption out of band, then run the requested iteration
 * through deterministic Lite Capture and the execution authorization to a
 * completed Snapshot.
 */
afterEach(cleanupE2eRoots);

function makePlainRepo(): string {
  const root = makeTempDir("harness-e2e-adopt-");
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Harness E2E");
  git(root, "config", "user.email", "harness-e2e@example.com");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "index.ts"), "export const answer = 42;\n");
  writeFileSync(join(root, "README.md"), "# plain project\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "initial commit");
  return root;
}

describe("generic adopt E2E", { timeout: 60000 }, () => {
  it("runs adopt through staging and all iteration approvals", async () => {
    const repo = makePlainRepo();
    const newId = sequentialIds();
    const harness = makeHarness(repo, newId);
    const session = { cwd: repo, runtime: harness.runtime };

    // Staging is deterministic and touches no authoritative state.
    const headBefore = git(repo, "rev-parse", "HEAD").trim();
    let result = await runJson(
      ["adopt", ".", "--intent", "introduce the change", "--profile", "lite"],
      session,
    );
    expect(result.exitCode).toBe(EXIT_CODES.approvalRequired);
    let data = result.json["data"] as Record<string, unknown>;
    expect(data["object_type"]).toBe("AdoptionBaseline");
    const stagingId = data["staging_operation_id"] as string;
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(headBefore);

    // The non-interactive approval commits the baseline and runs the first
    // iteration until the mandatory execution authorization. Deterministic
    // Lite Capture auto-accepts its low-risk RequirementBaseline.
    result = await runJson(
      [
        "adopt",
        ".",
        "--intent",
        "introduce the change",
        "--profile",
        "lite",
        "--approve",
        stagingId,
      ],
      session,
    );
    expect(result.exitCode).toBe(EXIT_CODES.approvalRequired);
    data = result.json["data"] as Record<string, unknown>;
    expect(data["object_type"]).toBe("ExecutionAuthorizationSpec");

    result = await approveAndResume(result, session);
    expect(result.json["status"]).toBe("ok");
    expect(typeof (result.json["data"] as Record<string, unknown>)["snapshot_id"]).toBe("string");
    expect(harness.executorCalls).toHaveLength(1);

    const snapshot = await runJson(["snapshot"], session);
    expect((snapshot.json["data"] as Record<string, unknown>)["status"]).toBe("completed");
  });
});
