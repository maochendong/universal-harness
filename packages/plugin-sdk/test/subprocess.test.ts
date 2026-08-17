import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runPluginSubprocess } from "../src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function worktree(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-plugin-subprocess-"));
  roots.push(root);
  return root;
}

describe("plugin subprocess output observation", () => {
  it("observes stdout and stderr chunks before the process settles", async () => {
    const outputs: Array<{ stream: string; chunk: string }> = [];
    let settled = false;
    const running = runPluginSubprocess(process.execPath, {
      args: [
        "-e",
        "process.stdout.write('phase one\\n'); setTimeout(() => { process.stderr.write('phase two\\n'); }, 20); setTimeout(() => {}, 40);",
      ],
      cwd: worktree(),
      env: {},
      timeout_ms: 2_000,
      max_output_bytes: 4_096,
      on_output: (output) => {
        expect(settled).toBe(false);
        outputs.push(output);
      },
    });
    const result = await running.finally(() => {
      settled = true;
    });

    expect(result).toMatchObject({ exit_code: 0, stdout: "phase one\n", stderr: "phase two\n" });
    expect(outputs).toEqual([
      { stream: "stdout", chunk: "phase one\n" },
      { stream: "stderr", chunk: "phase two\n" },
    ]);
  });

  it("isolates observer failures from the governed process result", async () => {
    const result = await runPluginSubprocess(process.execPath, {
      args: ["-e", "process.stdout.write('done\\n')"],
      cwd: worktree(),
      env: {},
      timeout_ms: 2_000,
      max_output_bytes: 4_096,
      on_output: () => {
        throw new Error("disposable observer failed");
      },
    });

    expect(result).toMatchObject({ exit_code: 0, stdout: "done\n", timed_out: false });
  });
});
