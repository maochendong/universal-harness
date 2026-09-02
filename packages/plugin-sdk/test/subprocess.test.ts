import { getEventListeners } from "node:events";
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

describe("plugin subprocess abort signal", () => {
  it("sends one SIGTERM on abort and reports the aborted flag distinctly", async () => {
    const controller = new AbortController();
    const running = runPluginSubprocess(process.execPath, {
      // Trap SIGTERM so a second signal would be observable; exit on the first.
      args: [
        "-e",
        "process.on('SIGTERM', () => { process.stdout.write('sigterm\\n'); process.exit(42); }); process.stdout.write('ready\\n'); setTimeout(() => {}, 5000);",
      ],
      cwd: worktree(),
      env: {},
      timeout_ms: 10_000,
      max_output_bytes: 4_096,
      signal: controller.signal,
      // Wait until the child proves its handler is installed. A fixed wall-clock
      // delay races process startup when the full release suite is I/O-bound.
      on_output: ({ stream, chunk }) => {
        if (stream === "stdout" && chunk.includes("ready\n")) controller.abort();
      },
    });
    const result = await running;

    expect(result.aborted).toBe(true);
    expect(result.timed_out).toBe(false);
    expect(result.output_truncated).toBe(false);
    expect(result.stdout).toBe("ready\nsigterm\n");
    expect(result.exit_code).toBe(42);
  });

  it("kills a process that never traps SIGTERM and reports the signal", async () => {
    const controller = new AbortController();
    const running = runPluginSubprocess(process.execPath, {
      args: ["-e", "setTimeout(() => {}, 5000)"],
      cwd: worktree(),
      env: {},
      timeout_ms: 10_000,
      max_output_bytes: 4_096,
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 100);
    const result = await running;

    expect(result.aborted).toBe(true);
    expect(result.signal).toBe("SIGTERM");
    expect(result.exit_code).toBeNull();
  });

  it("removes the abort listener after the process closes", async () => {
    const controller = new AbortController();
    const result = await runPluginSubprocess(process.execPath, {
      args: ["-e", "process.stdout.write('done\\n')"],
      cwd: worktree(),
      env: {},
      timeout_ms: 2_000,
      max_output_bytes: 4_096,
      signal: controller.signal,
    });

    expect(result).toMatchObject({ exit_code: 0, aborted: false });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("aborts immediately when the signal is already aborted at spawn time", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runPluginSubprocess(process.execPath, {
      args: ["-e", "setTimeout(() => {}, 5000)"],
      cwd: worktree(),
      env: {},
      timeout_ms: 10_000,
      max_output_bytes: 4_096,
      signal: controller.signal,
    });

    expect(result.aborted).toBe(true);
  });

  it("preserves timeout behavior when a signal is attached but never aborted", async () => {
    const controller = new AbortController();
    const result = await runPluginSubprocess(process.execPath, {
      args: ["-e", "setTimeout(() => {}, 5000)"],
      cwd: worktree(),
      env: {},
      timeout_ms: 150,
      max_output_bytes: 4_096,
      signal: controller.signal,
    });

    expect(result.timed_out).toBe(true);
    expect(result.aborted).toBe(false);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("preserves the output cap when a signal is attached but never aborted", async () => {
    const controller = new AbortController();
    const result = await runPluginSubprocess(process.execPath, {
      args: ["-e", "process.stdout.write('x'.repeat(100_000))"],
      cwd: worktree(),
      env: {},
      timeout_ms: 10_000,
      max_output_bytes: 1_024,
      signal: controller.signal,
    });

    expect(result.output_truncated).toBe(true);
    expect(result.aborted).toBe(false);
  });

  it("reports aborted false when no signal is provided", async () => {
    const result = await runPluginSubprocess(process.execPath, {
      args: ["-e", "process.stdout.write('done\\n')"],
      cwd: worktree(),
      env: {},
      timeout_ms: 2_000,
      max_output_bytes: 4_096,
    });

    expect(result.aborted).toBe(false);
  });
});
