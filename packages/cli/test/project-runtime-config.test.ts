import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runGate } from "@universal-harness-internal/runtime";

import {
  createConfiguredAgentExecutor,
  createConfiguredGateSuite,
  readProjectRuntimeConfig,
} from "../src/index.js";
import { fixtureEnvelope } from "../../../tests/helpers/agent-profiles.js";

const roots: string[] = [];

function projectWithConfig(config: unknown): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-project-runtime-")));
  roots.push(root);
  mkdirSync(join(root, ".harness"));
  writeFileSync(join(root, ".harness", "runtime.json"), JSON.stringify(config), "utf8");
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("project runtime configuration", () => {
  it("loads deterministic Agent scope and project gate commands", () => {
    const root = projectWithConfig({
      runtime_config_version: 1,
      agent: {
        provider: "dsh",
        expected_version: "0.1.0-rc.6",
        allowed_read_paths: ["docs", "src"],
        proposed_write_paths: ["scripts", "src"],
      },
      gates: [
        {
          gate_id: "gate_atlas_maven_test",
          name: "Atlas Maven tests",
          mandatory: true,
          subject_id: "test_atlas_maven",
          executable: "scripts/harness/maven-test",
          args: [],
          timeout_ms: 120000,
        },
      ],
    });

    expect(readProjectRuntimeConfig(root)).toEqual({
      runtime_config_version: 1,
      agent: {
        provider: "dsh",
        expected_version: "0.1.0-rc.6",
        executable: "npx",
        launcher_args: ["--no-install", "@deepseek-ai/dsh"],
        env_allowlist: ["DEEPSEEK_API_KEY", "DSH_HOME", "HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"],
        allowed_read_paths: ["docs", "src"],
        proposed_write_paths: ["scripts", "src"],
      },
      gates: [
        {
          gate_id: "gate_atlas_maven_test",
          name: "Atlas Maven tests",
          mandatory: true,
          subject_id: "test_atlas_maven",
          executable: "scripts/harness/maven-test",
          args: [],
          env_allowlist: ["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"],
          timeout_ms: 120000,
        },
      ],
    });
  });

  it("executes a configured project gate through the Tool Registry", async () => {
    const root = projectWithConfig({
      runtime_config_version: 1,
      gates: [
        {
          gate_id: "gate_atlas_maven_test",
          name: "Atlas Maven tests",
          mandatory: true,
          subject_id: "test_atlas_maven",
          executable: "scripts/harness/maven-test",
          args: ["--batch"],
          timeout_ms: 120000,
        },
      ],
    });
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const suite = createConfiguredGateSuite(root, readProjectRuntimeConfig(root), {
      spawnProcess: (executable, options) => {
        calls.push({ executable, args: options.args });
        return Promise.resolve({
          exit_code: 0,
          signal: null,
          stdout: "Tests run: 102, Failures: 0\nBUILD SUCCESS\n",
          stderr: "",
          timed_out: false,
          output_truncated: false,
          duration_ms: 50,
        });
      },
    });
    const gate = suite.gates.find((candidate) => candidate.gate_id === "gate_atlas_maven_test");
    if (gate === undefined) throw new Error("configured gate not found");

    const outcome = await runGate(suite.registry, gate, { intentId: "intent_gate_test" });

    expect(calls).toEqual([
      { executable: join(root, "scripts", "harness", "maven-test"), args: ["--batch"] },
    ]);
    expect(outcome).toMatchObject({ passed: true, exit_code: 0, layer: "project" });
    expect(outcome.artifact_hashes[".harness/raw-traces/gates/gate_atlas_maven_test.log"]).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(
      existsSync(join(root, ".harness", "raw-traces", "gates", "gate_atlas_maven_test.log")),
    ).toBe(true);
  });

  it("selects dsh as the configured orchestration executor", async () => {
    const root = projectWithConfig({
      runtime_config_version: 1,
      agent: {
        provider: "dsh",
        expected_version: "0.1.0-rc.6",
        allowed_read_paths: ["docs", "src"],
        proposed_write_paths: ["src"],
      },
      gates: [],
    });
    const config = readProjectRuntimeConfig(root);
    if (config.agent === undefined) throw new Error("agent config missing");
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const configured = createConfiguredAgentExecutor(root, config.agent, {
      inspector: {
        inspect: () =>
          Promise.resolve({
            head: "0123456789abcdef0123456789abcdef01234567",
            changed_paths: [],
            digest: "a".repeat(64),
          }),
      },
      spawnProcess: (_executable, options) => {
        mutableCalls.push([...options.args]);
        return Promise.resolve({
          exit_code: 0,
          signal: null,
          stdout: options.args.at(-1) === "--version" ? "0.1.0-rc.6\n" : "done\n",
          stderr: "",
          timed_out: false,
          output_truncated: false,
          duration_ms: 1,
        });
      },
    });

    const result = await configured.execute(
      fixtureEnvelope({
        allowed_read_paths: configured.scope.allowed_read_paths,
        proposed_write_paths: configured.scope.proposed_write_paths,
      }),
    );

    expect(configured.name).toBe("agent-dsh");
    expect(configured.trajectoryVisibility).toBe("external-only");
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ outcome: "handoff", completion_claimed: true });
  });
});
