import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  PluginSubprocessError,
  buildScrubbedEnvironment,
  runPluginSubprocess,
} from "@universal-harness-internal/plugin-sdk";

import { makeTempDir, removeTempDir } from "../src/index.js";

const exampleDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../examples/plugin-minimal",
);
const pluginExecutable = join(exampleDirectory, "plugin.mjs");

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

function runExample(request: unknown) {
  const directory = trackedTempDir("harness-conf-example-");
  const requestPath = join(directory, "request.json");
  writeFileSync(requestPath, JSON.stringify(request));
  return runPluginSubprocess(process.execPath, {
    args: [pluginExecutable, requestPath],
    cwd: directory,
    env: buildScrubbedEnvironment([], process.env),
    timeout_ms: 10000,
    max_output_bytes: 64 * 1024,
  });
}

describe("minimal example plugin", () => {
  it("runs in a scrubbed subprocess and returns a typed result", async () => {
    const result = await runExample({ text: "hello harness" });

    expect(result.exit_code).toBe(0);
    expect(result.timed_out).toBe(false);
    expect(result.output_truncated).toBe(false);
    expect(JSON.parse(result.stdout)).toEqual({
      status: "ok",
      capability: "tool.echo",
      echo: "hello harness",
    });
  });

  it("returns a structured failure for a malformed request", async () => {
    const result = await runExample({ not_text: 42 });

    expect(result.exit_code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "error" });
  });

  it("passes no ambient environment into the plugin process", () => {
    const scrubbed = buildScrubbedEnvironment([], {
      HARNESS_SECRET: "must-not-leak",
      PATH: "/usr/bin",
    });
    expect(scrubbed).toEqual({});

    const allowlisted = buildScrubbedEnvironment(["PATH"], {
      HARNESS_SECRET: "must-not-leak",
      PATH: "/usr/bin",
    });
    expect(allowlisted).toEqual({ PATH: "/usr/bin" });
  });

  it("reports an unavailable plugin executable as a typed spawn error", async () => {
    await expect(
      runPluginSubprocess("harness-no-such-plugin", {
        args: [],
        cwd: trackedTempDir("harness-conf-example-"),
        env: {},
        timeout_ms: 1000,
        max_output_bytes: 1024,
      }),
    ).rejects.toThrowError(PluginSubprocessError);

    const error = await runPluginSubprocess("harness-no-such-plugin", {
      args: [],
      cwd: trackedTempDir("harness-conf-example-"),
      env: {},
      timeout_ms: 1000,
      max_output_bytes: 1024,
    }).catch((caught: unknown) => caught);
    expect((error as PluginSubprocessError).kind).toBe("spawn_failed");
  });
});
