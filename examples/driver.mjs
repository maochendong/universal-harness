/**
 * Shared driver for the executable documentation examples (plan Task 28).
 * Every example runs the real CLI in-process through its public API against
 * temporary Git repositories, with deterministic ports (fixed clock,
 * sequential ids) injected through the public service factory. Examples are
 * executed as tests by tests/e2e/documentation-examples.test.ts.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOrchestratedRuntimeService, runCli } from "universal-harness";

export const FIXED_NOW = "2026-08-13T00:00:00.000Z";

// Example repositories commit through the real Git adapter; give it a stable
// identity so examples work on machines without a configured Git user.
process.env.GIT_AUTHOR_NAME ??= "Harness Example";
process.env.GIT_AUTHOR_EMAIL ??= "harness-example@example.com";
process.env.GIT_COMMITTER_NAME ??= "Harness Example";
process.env.GIT_COMMITTER_EMAIL ??= "harness-example@example.com";

export function makeTempDir(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function git(cwd, ...args) {
  // Pin autocrlf off (Windows runners default it to true, which would dirty
  // clean repositories) and disable auto gc (no detached maintenance).
  return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "gc.auto=0", ...args], {
    cwd,
    encoding: "utf8",
  });
}

export function sequentialIds() {
  const counters = new Map();
  return (kind) => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${kind}_t${String(next).padStart(4, "0")}`;
  };
}

/**
 * One id sequence per example process, shared across every runtime instance:
 * runtime services re-created per command must never re-mint an id that an
 * earlier instance already committed to the ledger.
 */
const sharedIds = sequentialIds();

export function evidenceDigest(text) {
  return createHash("sha256").update(text).digest("hex");
}

function captureIo() {
  const out = [];
  const err = [];
  return {
    io: {
      writeStdout: (text) => out.push(text),
      writeStderr: (text) => err.push(text),
      isInteractive: false,
    },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

/**
 * Runtime service wired the way the production CLI wires it, with only the
 * clock, id mint and (optionally) the executor injected for determinism.
 */
export function makeRuntime(cwd, options = {}) {
  const io = captureIo().io;
  return createOrchestratedRuntimeService({
    cwd,
    io,
    now: () => FIXED_NOW,
    newId: sharedIds,
    ...(options.execute === undefined ? {} : { execute: options.execute }),
  });
}

export async function runJson(argv, options) {
  const captured = captureIo();
  const exitCode = await runCli([...argv, "--json"], {
    io: captured.io,
    cwd: options.cwd,
    runtime: options.runtime,
  });
  return {
    exitCode,
    stdout: captured.stdout(),
    stderr: captured.stderr(),
    json: parseJsonOutput(argv, captured),
  };
}

function parseJsonOutput(argv, captured) {
  try {
    return JSON.parse(captured.stdout());
  } catch {
    throw new Error(
      `harness ${argv.join(" ")} emitted no JSON (exit output on stderr): ${captured.stderr()}`,
    );
  }
}

export function expect(condition, message) {
  if (!condition) throw new Error(`example assertion failed: ${message}`);
}

/** Drive an approval-paused orchestration to completion. */
export async function drivePastApprovals(first, session) {
  let result = first;
  const approved = [];
  for (let round = 0; result.json.status === "approval_required" && round < 8; round += 1) {
    const data = result.json.data;
    approved.push(data.object_type);
    const decision = await runJson(
      ["approve", data.request_id, "--decision", "approve", "--actor", "human:example"],
      session,
    );
    expect(decision.json.status === "ok", `approve failed: ${decision.stdout}`);
    result = await runJson(["resume", data.workflow_operation_id], session);
  }
  expect(result.json.status === "ok", `loop did not complete: ${result.stdout}`);
  return { result, approved };
}
