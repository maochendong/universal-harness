import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProcessSpawnError, runCommandProcess } from "../src/process.js";
import { cleanupDirectories, FIXTURES, makeTempDir } from "./helpers.js";

afterEach(cleanupDirectories);

function runFixture(
  script: string,
  options: { timeout_ms?: number; max_output_bytes?: number } = {},
) {
  return runCommandProcess(process.execPath, {
    args: [join(FIXTURES, script), "/dev/null"],
    cwd: makeTempDir("harness-proc-"),
    env: {},
    timeout_ms: options.timeout_ms ?? 10000,
    max_output_bytes: options.max_output_bytes ?? 1024 * 1024,
  });
}

describe("runCommandProcess", () => {
  it("captures stdout of a clean exit", async () => {
    const result = await runFixture("fail-status.mjs");
    expect(result.exit_code).toBe(0);
    expect(result.timed_out).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "failed" });
  });

  it("reports a non-zero exit with stderr", async () => {
    const result = await runFixture("exit-nonzero.mjs");
    expect(result.exit_code).toBe(3);
    expect(result.stderr).toContain("provider crashed hard");
  });

  it("kills a runaway provider at the timeout", async () => {
    const result = await runFixture("sleep.mjs", { timeout_ms: 250 });
    expect(result.timed_out).toBe(true);
    expect(result.exit_code).toBeNull();
    expect(result.duration_ms).toBeLessThan(10000);
  });

  it("truncates and kills on an output flood", async () => {
    const result = await runFixture("flood.mjs", { max_output_bytes: 128 * 1024 });
    expect(result.output_truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(128 * 1024);
  });

  it("reports an unavailable executable as a typed spawn error", async () => {
    await expect(
      runCommandProcess("harness-no-such-executable", {
        args: [],
        cwd: makeTempDir("harness-proc-"),
        env: {},
        timeout_ms: 1000,
        max_output_bytes: 1024,
      }),
    ).rejects.toThrowError(ProcessSpawnError);
  });
});
