/**
 * Executable example: `harness adopt` full vertical loop (docs/adopting-a-project.md).
 *
 * Creates a tiny pre-existing Git project, adopts it through the staged
 * preview (approve the AdoptionBaseline via --approve), then drives the
 * requested iteration to a completed snapshot.
 *
 * Run from the repository root after `pnpm build`:
 *
 *   node examples/adopt-project/run.mjs
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { drivePastApprovals, expect, git, makeRuntime, makeTempDir, runJson } from "../driver.mjs";

const parent = makeTempDir("harness-example-adopt-");
try {
  // A small pre-existing project the harness knows nothing about.
  const projectRoot = join(parent, "legacy-app");
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(
    join(projectRoot, "package.json"),
    `${JSON.stringify({ name: "legacy-app", version: "1.0.0", type: "module" })}\n`,
    "utf8",
  );
  writeFileSync(join(projectRoot, "src", "index.js"), "export const answer = 42;\n", "utf8");
  git(projectRoot, "init", "-b", "main");
  git(projectRoot, "add", "-A");
  git(projectRoot, "commit", "-m", "legacy baseline");

  const intent = "introduce the requested change";
  const staged = await runJson(["adopt", "legacy-app", "--intent", intent, "--profile", "lite"], {
    cwd: parent,
    runtime: makeRuntime(parent),
  });
  expect(staged.json.status === "approval_required", "adoption preview awaits approval");
  expect(staged.json.data.object_type === "AdoptionBaseline", "staged object is the baseline");

  // Nothing outside .harness happened before approval; staging shows up as
  // the only untracked entry.
  expect(
    git(projectRoot, "status", "--porcelain").trim() === "?? .harness/",
    "preview only stages under .harness",
  );

  const committed = await runJson(
    [
      "adopt",
      "legacy-app",
      "--intent",
      intent,
      "--profile",
      "lite",
      "--approve",
      staged.json.data.staging_operation_id,
    ],
    { cwd: parent, runtime: makeRuntime(parent) },
  );
  const session = { cwd: projectRoot, runtime: makeRuntime(projectRoot) };
  const { result } = await drivePastApprovals(committed, session);
  expect(typeof result.json.data.snapshot_id === "string", "adopt loop lands a snapshot");

  console.log(`adopt-project example passed: snapshot ${result.json.data.snapshot_id}`);
} finally {
  rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
