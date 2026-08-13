import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EXIT_CODES, runCli, type CliIo } from "../src/index.js";

/**
 * Thin contract tests for the Task 9 bootstrap wiring: the `new` and `adopt`
 * routes parse arguments and delegate to the real runtime service; all
 * behavior assertions live in the runtime and integration tests.
 */
interface Captured {
  readonly io: CliIo;
  stdout(): string;
  stderr(): string;
}

function captureIo(): Captured {
  const out: string[] = [];
  const err: string[] = [];
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

const createdRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  createdRoots.push(directory);
  return directory;
}

function git(cwd: string, ...args: string[]): string {
  // Pin autocrlf off: Windows CI runners default it to true, which would
  // rewrite line endings and dirty otherwise clean test repositories.
  return execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" });
}

function makeRepo(): string {
  const root = makeTempDir("harness-cli-adopt-");
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Harness Test");
  git(root, "config", "user.email", "harness-test@example.com");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "index.ts"), "export const answer = 42;\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "initial commit");
  return root;
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined)
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

describe("harness new route", () => {
  it("bootstraps the project and pauses at the mandatory baseline approval", async () => {
    const parent = makeTempDir("harness-cli-new-");
    const captured = captureIo();
    const exitCode = await runCli(["new", "demo-app", "--intent", "build a demo", "--json"], {
      io: captured.io,
      cwd: parent,
    });
    expect(exitCode).toBe(EXIT_CODES.approvalRequired);
    expect(captured.stderr()).toBe("");
    const result = JSON.parse(captured.stdout()) as Record<string, unknown>;
    expect(result["status"]).toBe("approval_required");
    const data = result["data"] as Record<string, unknown>;
    expect(data["object_type"]).toBe("RequirementBaseline");
    expect(typeof data["request_id"]).toBe("string");
    expect(typeof data["workflow_operation_id"]).toBe("string");
    expect(typeof data["resume_command"]).toBe("string");
    expect(existsSync(join(parent, "demo-app", ".harness", "manifest.yaml"))).toBe(true);
  });

  it("refuses an existing target path as a typed failure", async () => {
    const parent = makeTempDir("harness-cli-new-existing-");
    mkdirSync(join(parent, "demo-app"));
    const captured = captureIo();
    const exitCode = await runCli(["new", "demo-app", "--intent", "build a demo", "--json"], {
      io: captured.io,
      cwd: parent,
    });
    expect(exitCode).toBe(EXIT_CODES.operationFailed);
    const result = JSON.parse(captured.stdout()) as Record<string, unknown>;
    expect((result["data"] as Record<string, unknown>)["kind"]).toBe("target_exists");
  });
});

describe("harness adopt route", () => {
  it("stages a preview and returns a resumable approval request", async () => {
    const repo = makeRepo();
    const headBefore = git(repo, "rev-parse", "HEAD").trim();
    const captured = captureIo();
    const exitCode = await runCli(["adopt", repo, "--intent", "change it", "--json"], {
      io: captured.io,
      cwd: "/",
    });
    expect(exitCode).toBe(EXIT_CODES.approvalRequired);
    const result = JSON.parse(captured.stdout()) as Record<string, unknown>;
    const data = result["data"] as Record<string, unknown>;
    expect(data["object_type"]).toBe("AdoptionBaseline");
    expect(typeof data["staging_operation_id"]).toBe("string");
    expect(typeof data["preview_digest"]).toBe("string");
    expect(typeof data["resume_command"]).toBe("string");
    expect(data["files"]).toBe(1);
    // Approval has not happened: no manifest, no ledger, no git mutation.
    expect(existsSync(join(repo, ".harness", "manifest.yaml"))).toBe(false);
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(headBefore);
    expect(git(repo, "branch", "--list").trim()).toBe("* main");
  });

  it("rejects adopting a path that is not a repository", async () => {
    const outside = makeTempDir("harness-cli-adopt-outside-");
    const captured = captureIo();
    const exitCode = await runCli(["adopt", outside, "--intent", "change it", "--json"], {
      io: captured.io,
      cwd: "/",
    });
    expect(exitCode).toBe(EXIT_CODES.operationFailed);
    const result = JSON.parse(captured.stdout()) as Record<string, unknown>;
    expect((result["data"] as Record<string, unknown>)["kind"]).toBe("not_a_repository");
  });
});
