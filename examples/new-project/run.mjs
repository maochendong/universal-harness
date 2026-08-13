/**
 * Executable example: `harness new` full vertical loop (docs/getting-started.md).
 *
 * Runs the real CLI public API against a temporary Git repository: create a
 * managed project, approve the two mandatory approval points
 * (RequirementBaseline, ImpactSet), and land a completed Iteration Snapshot.
 *
 * Run from the repository root after `pnpm build`:
 *
 *   node examples/new-project/run.mjs
 */
import { join } from "node:path";
import { rmSync } from "node:fs";

import { drivePastApprovals, expect, git, makeRuntime, makeTempDir, runJson } from "../driver.mjs";

const parent = makeTempDir("harness-example-new-");
try {
  const intent = "build the first capability";
  const first = await runJson(["new", "example-app", "--intent", intent], {
    cwd: parent,
    runtime: makeRuntime(parent),
  });
  expect(first.json.status === "approval_required", "new should pause for the baseline approval");

  const projectRoot = join(parent, "example-app");
  const session = { cwd: projectRoot, runtime: makeRuntime(projectRoot) };
  const { result, approved } = await drivePastApprovals(first, session);
  expect(approved.includes("RequirementBaseline"), "baseline approval recorded");
  expect(approved.includes("ImpactSet"), "impact set approval recorded");
  expect(typeof result.json.data.snapshot_id === "string", "completed loop lands a snapshot");

  const snapshot = await runJson(["snapshot"], session);
  expect(snapshot.json.data.status === "completed", "snapshot status is completed");
  expect(
    git(projectRoot, "status", "--porcelain").trim() === "",
    "ledger commits leave a clean tree",
  );

  console.log(`new-project example passed: snapshot ${result.json.data.snapshot_id}`);
} finally {
  rmSync(parent, { recursive: true, force: true });
}
