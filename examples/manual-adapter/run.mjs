/**
 * Executable example: manual AgentAdapter (docs/plugin-contracts.md).
 *
 * Wires the manual adapter into the real orchestration: the execute phase
 * hands the Task Envelope to a handoff channel (here a scripted "human" that
 * completes the task with attestation evidence), and the loop drives to a
 * completed snapshot. The adapter itself never executes anything; its
 * control profile is `control: "manual"`, `trajectory_visibility:
 * "external-only"`.
 *
 * Run from the repository root after `pnpm build`:
 *
 *   node examples/manual-adapter/run.mjs
 */
import { rmSync } from "node:fs";
import { join } from "node:path";

import { createManualAgentAdapter } from "../../adapters/agent-manual/dist/index.js";
import {
  drivePastApprovals,
  evidenceDigest,
  expect,
  makeRuntime,
  makeTempDir,
  runJson,
} from "../driver.mjs";

const parent = makeTempDir("harness-example-manual-");
try {
  const handoffs = [];
  const adapter = createManualAgentAdapter({
    handoff: (request) => {
      handoffs.push(request);
      return Promise.resolve({
        status: "completed",
        summary: `human completed ${request.envelope.task_id}`,
        evidence: [
          {
            kind: "attestation",
            locator: `attestations/${request.envelope.task_id}.txt`,
            digest: evidenceDigest(request.envelope.task_id),
          },
        ],
      });
    },
  });
  expect(adapter.manifest.control === "manual", "manual adapter declares manual control");

  const execute = (envelope) => adapter.run(envelope, { mode: "supervised" });
  const first = await runJson(
    ["new", "manual-app", "--intent", "build the first capability", "--profile", "lite"],
    {
      cwd: parent,
      runtime: makeRuntime(parent, { execute }),
    },
  );
  const projectRoot = join(parent, "manual-app");
  const session = { cwd: projectRoot, runtime: makeRuntime(projectRoot, { execute }) };
  const { result } = await drivePastApprovals(first, session);

  expect(handoffs.length === 1, "exactly one task envelope reached the human channel");
  expect(
    handoffs[0].instructions.includes("Objective:"),
    "handoff carries the rendered task brief",
  );
  expect(typeof result.json.data.snapshot_id === "string", "manual loop lands a snapshot");

  console.log(`manual-adapter example passed: snapshot ${result.json.data.snapshot_id}`);
} finally {
  rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
