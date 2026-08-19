/**
 * Executable example: command AgentAdapter (docs/plugin-contracts.md).
 *
 * Wires the command adapter into the real orchestration: the execute phase
 * runs a delegated provider (`provider.mjs`, a deterministic local command)
 * under the Harness-enforced envelope — argument array, scrubbed
 * environment, confined worktree, timeout and output cap — and the loop
 * drives to a completed snapshot. The adapter declares
 * `control: "delegated"`, so it always runs supervised.
 *
 * Run from the repository root after `pnpm build`:
 *
 *   node examples/command-adapter/run.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createCommandAgentAdapter } from "../../adapters/agent-command/dist/index.js";
import { drivePastApprovals, expect, makeRuntime, makeTempDir, runJson } from "../driver.mjs";

const providerScript = join(dirname(fileURLToPath(import.meta.url)), "provider.mjs");
const parent = makeTempDir("harness-example-command-");
const evidenceDir = mkdtempSync(join(tmpdir(), "harness-example-command-evidence-"));
try {
  // Created lazily so the confined worktree is the managed project itself.
  const execute = (envelope) =>
    createCommandAgentAdapter({
      manifest: {
        provider: "example-command-provider",
        control: "delegated",
        trajectory_visibility: "summarized",
        usage_metering: true,
        side_effect_interception: true,
        resume_semantics: "explicit",
        executable: process.execPath,
        args: [providerScript, "{input_file}"],
        env_allowlist: [],
      },
      worktree: join(parent, "command-app"),
      evidence_dir: evidenceDir,
    }).run(envelope, { mode: "supervised" });

  const first = await runJson(
    ["new", "command-app", "--intent", "build the first capability", "--profile", "lite"],
    {
      cwd: parent,
      runtime: makeRuntime(parent, { execute }),
    },
  );
  const projectRoot = join(parent, "command-app");
  const session = { cwd: projectRoot, runtime: makeRuntime(projectRoot, { execute }) };
  const { result } = await drivePastApprovals(first, session);
  expect(typeof result.json.data.snapshot_id === "string", "command loop lands a snapshot");

  console.log(`command-adapter example passed: snapshot ${result.json.data.snapshot_id}`);
} finally {
  rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(evidenceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
