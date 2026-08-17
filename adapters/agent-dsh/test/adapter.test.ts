import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { fixtureEnvelope } from "../../../tests/helpers/agent-profiles.js";
import { createDshAgentAdapter, type DshProcessRunner } from "../src/index.js";
import { cleanupDirectories, makeTempDir } from "../../agent-command/test/helpers.js";

afterEach(cleanupDirectories);

describe("dsh agent adapter", () => {
  it("forwards task stdout and stderr while excluding the version probe", async () => {
    const observed: Array<{ stream: string; chunk: string }> = [];
    const adapter = createDshAgentAdapter({
      executable: "npx",
      launcher_args: ["--no-install", "@deepseek-ai/dsh"],
      expected_version: "0.1.0-rc.6",
      worktree: makeTempDir("harness-dsh-worktree-"),
      evidence_dir: makeTempDir("harness-dsh-evidence-"),
      inspector: {
        inspect: () => Promise.resolve({ head: null, changed_paths: [], digest: "a".repeat(64) }),
      },
      spawnProcess: (_executable, options) => {
        const probe = options.args.at(-1) === "--version";
        options.on_output?.({
          stream: probe ? "stdout" : "stderr",
          chunk: probe ? "0.1.0-rc.6\n" : "working on tests\n",
        });
        return Promise.resolve({
          exit_code: 0,
          signal: null,
          stdout: probe ? "0.1.0-rc.6\n" : "done\n",
          stderr: "",
          timed_out: false,
          output_truncated: false,
          duration_ms: 2,
        });
      },
    });

    await adapter.run(fixtureEnvelope(), {
      mode: "supervised",
      on_output: (output) => observed.push(output),
    });

    expect(observed).toEqual([{ stream: "stderr", chunk: "working on tests\n" }]);
  });

  it("turns a successful headless run into a verifiable handoff", async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const runner: DshProcessRunner = (executable, options) => {
      calls.push({ executable, args: options.args });
      if (options.args.at(-1) === "--version") {
        return Promise.resolve({
          exit_code: 0,
          signal: null,
          stdout: "0.1.0-rc.6\n",
          stderr: "",
          timed_out: false,
          output_truncated: false,
          duration_ms: 5,
        });
      }
      return Promise.resolve({
        exit_code: 0,
        signal: null,
        stdout: "Implemented the greeting module and tests.\n",
        stderr: "",
        timed_out: false,
        output_truncated: false,
        duration_ms: 25,
      });
    };
    let inspection = 0;
    const adapter = createDshAgentAdapter({
      executable: "npx",
      launcher_args: ["--no-install", "@deepseek-ai/dsh"],
      expected_version: "0.1.0-rc.6",
      worktree: makeTempDir("harness-dsh-worktree-"),
      evidence_dir: makeTempDir("harness-dsh-evidence-"),
      spawnProcess: runner,
      inspector: {
        inspect: () => {
          inspection += 1;
          return Promise.resolve({
            head: "0123456789abcdef0123456789abcdef01234567",
            changed_paths: inspection === 1 ? [] : ["src/greeting.ts"],
            digest: inspection === 1 ? "a".repeat(64) : "b".repeat(64),
          });
        },
      },
    });

    const result = await adapter.run(fixtureEnvelope(), { mode: "supervised" });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      executable: "npx",
      args: ["--no-install", "@deepseek-ai/dsh", "--version"],
    });
    expect(calls[1]?.args.slice(0, 4)).toEqual([
      "--no-install",
      "@deepseek-ai/dsh",
      "--profile",
      "headless",
    ]);
    expect(calls[1]?.args.at(-1)).toContain("Objective: Implement the greeting module");
    expect(result).toMatchObject({
      outcome: "handoff",
      termination_reason: "completion",
      completion_claimed: true,
      summary: "Implemented the greeting module and tests.",
      change_summary: { files_changed: 1, paths: ["src/greeting.ts"] },
      usage: { duration_ms: 25, metering: "unmetered", total_tokens: null },
      budget_observations: [
        { dimension: "steps", availability: "unavailable", used: null, enforcement: "none" },
        { dimension: "tokens", availability: "unavailable", used: null, enforcement: "none" },
        {
          dimension: "duration_ms",
          availability: "measured",
          used: 25,
          enforcement: "harness",
        },
      ],
      undeclared_writes: [],
    });
    expect(result.evidence.map((entry) => entry.kind)).toEqual(["transcript", "diff"]);
    const transcript = result.evidence[0];
    expect(transcript?.digest).toMatch(/^[a-f0-9]{64}$/u);
    const stored = JSON.parse(readFileSync(transcript?.locator ?? "", "utf8")) as {
      stdout: string;
      envelope_digest: string;
    };
    expect(stored.stdout).toBe("Implemented the greeting module and tests.\n");
    expect(stored.envelope_digest).toBe(fixtureEnvelope().digest);
  });

  it("maps a headless credential failure to adapter_failure", async () => {
    let call = 0;
    const adapter = createDshAgentAdapter({
      executable: "npx",
      launcher_args: ["--no-install", "@deepseek-ai/dsh"],
      expected_version: "0.1.0-rc.6",
      worktree: makeTempDir("harness-dsh-worktree-"),
      evidence_dir: makeTempDir("harness-dsh-evidence-"),
      inspector: {
        inspect: () => Promise.resolve({ head: null, changed_paths: [], digest: "a".repeat(64) }),
      },
      spawnProcess: () => {
        call += 1;
        return Promise.resolve({
          exit_code: call === 1 ? 0 : 1,
          signal: null,
          stdout: call === 1 ? "0.1.0-rc.6\n" : "",
          stderr: call === 1 ? "" : "MISSING_CREDENTIAL: no API key",
          timed_out: false,
          output_truncated: false,
          duration_ms: 2,
        });
      },
    });

    const result = await adapter.run(fixtureEnvelope(), { mode: "supervised" });

    expect(result).toMatchObject({
      outcome: "failed",
      termination_reason: "adapter_failure",
      completion_claimed: false,
    });
    expect(result.summary).toContain("MISSING_CREDENTIAL");
    expect(result.evidence.map((entry) => entry.kind)).toEqual(["transcript", "diff"]);
  });

  it("rejects a completion claim that writes outside the envelope", async () => {
    let inspection = 0;
    const adapter = createDshAgentAdapter({
      executable: "npx",
      launcher_args: ["--no-install", "@deepseek-ai/dsh"],
      expected_version: "0.1.0-rc.6",
      worktree: makeTempDir("harness-dsh-worktree-"),
      evidence_dir: makeTempDir("harness-dsh-evidence-"),
      inspector: {
        inspect: () => {
          inspection += 1;
          return Promise.resolve({
            head: null,
            changed_paths: inspection === 1 ? [] : ["outside.txt"],
            digest: inspection === 1 ? "a".repeat(64) : "b".repeat(64),
          });
        },
      },
      spawnProcess: (_executable, options) =>
        Promise.resolve({
          exit_code: 0,
          signal: null,
          stdout: options.args.at(-1) === "--version" ? "0.1.0-rc.6\n" : "done\n",
          stderr: "",
          timed_out: false,
          output_truncated: false,
          duration_ms: 2,
        }),
    });

    const result = await adapter.run(fixtureEnvelope(), { mode: "supervised" });

    expect(result).toMatchObject({
      outcome: "failed",
      completion_claimed: false,
      undeclared_writes: ["outside.txt"],
    });
  });
});
