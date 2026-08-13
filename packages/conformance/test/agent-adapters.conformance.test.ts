import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, it } from "vitest";

import { createCommandAgentAdapter } from "@universal-harness-internal/adapter-agent-command";
import { createManualAgentAdapter } from "@universal-harness-internal/adapter-agent-manual";

import {
  agentAdapterConformanceCases,
  assertConformance,
  fixtureAgentEnvelope,
  makeTempDir,
  removeTempDir,
  runConformanceSuite,
} from "../src/index.js";

const providerFixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/provider-complete.mjs",
);

const createdDirectories: string[] = [];

function trackedTempDir(prefix: string): string {
  const directory = makeTempDir(prefix);
  createdDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (createdDirectories.length > 0) {
    const directory = createdDirectories.pop();
    if (directory !== undefined) removeTempDir(directory);
  }
});

describe("adapter-agent-manual conformance", () => {
  it("satisfies the shared agent adapter contract", async () => {
    const adapter = createManualAgentAdapter({
      handoff: (request) =>
        Promise.resolve({
          status: "completed",
          summary: `human completed ${request.envelope.task_id}`,
          evidence: [
            {
              kind: "attestation",
              locator: "attestations/task_01.txt",
              digest: "f".repeat(64),
            },
          ],
          state_proposal: { summary: "done", rogue_field: "must be dropped" },
        }),
    });
    const report = await runConformanceSuite({
      plugin: "adapter-agent-manual",
      kind: "agent",
      cases: agentAdapterConformanceCases(adapter, fixtureAgentEnvelope()),
    });
    assertConformance(report);
  });
});

describe("adapter-agent-command conformance", () => {
  it("satisfies the shared agent adapter contract", async () => {
    const adapter = createCommandAgentAdapter({
      manifest: {
        provider: "conformance-provider",
        control: "delegated",
        trajectory_visibility: "summarized",
        usage_metering: true,
        side_effect_interception: true,
        resume_semantics: "explicit",
        executable: process.execPath,
        args: [providerFixture, "{input_file}"],
        env_allowlist: [],
      },
      worktree: trackedTempDir("harness-conf-worktree-"),
      evidence_dir: trackedTempDir("harness-conf-evidence-"),
    });
    const report = await runConformanceSuite({
      plugin: "adapter-agent-command",
      kind: "agent",
      cases: agentAdapterConformanceCases(adapter, fixtureAgentEnvelope()),
    });
    assertConformance(report);
  });
});
