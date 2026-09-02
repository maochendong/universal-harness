import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, it } from "vitest";

import { createCommandAgentAdapter } from "@universal-harness-internal/adapter-agent-command";
import {
  createDshAgentAdapter,
  type DshProcessRunner,
} from "@universal-harness-internal/adapter-agent-dsh";
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
    const worktree = trackedTempDir("harness-conf-worktree-");
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
      worktree,
      evidence_dir: trackedTempDir("harness-conf-evidence-"),
      inspector: {
        inspect: () =>
          Promise.resolve({
            head: "1".repeat(40),
            changed_paths: [],
            digest: "a".repeat(64),
          }),
      },
    });
    const report = await runConformanceSuite({
      plugin: "adapter-agent-command",
      kind: "agent",
      cases: agentAdapterConformanceCases(adapter, fixtureAgentEnvelope()),
    });
    assertConformance(report);
  });
});

describe("adapter-agent-dsh conformance", () => {
  it("satisfies the shared agent adapter contract and remains supervised-only", async () => {
    const worktree = trackedTempDir("harness-conf-dsh-worktree-");
    const evidenceDir = trackedTempDir("harness-conf-dsh-evidence-");
    const spawnProcess: DshProcessRunner = (_executable, options) =>
      Promise.resolve({
        exit_code: 0,
        signal: null,
        stdout: options.args.at(-1) === "--version" ? "0.1.0-rc.6\n" : "done\n",
        stderr: "",
        timed_out: false,
        output_truncated: false,
        aborted: false,
        duration_ms: 1,
      });
    const adapter = createDshAgentAdapter({
      executable: "dsh-conformance-fixture",
      launcher_args: [],
      expected_version: "0.1.0-rc.6",
      worktree,
      evidence_dir: evidenceDir,
      inspector: {
        inspect: () =>
          Promise.resolve({
            head: "1".repeat(40),
            changed_paths: [],
            digest: "a".repeat(64),
          }),
      },
      spawnProcess,
    });
    const report = await runConformanceSuite({
      plugin: "adapter-agent-dsh",
      kind: "agent",
      cases: agentAdapterConformanceCases(adapter, fixtureAgentEnvelope()),
    });
    assertConformance(report);
  });
});
