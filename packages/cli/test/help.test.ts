import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPackLock,
  createProjectManifest,
  initializeManagedLayout,
} from "@universal-harness-internal/core";

import { EXIT_CODES, createStubRuntimeService, runCli, type CliIo } from "../src/index.js";

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

const fixedNow = () => "2026-08-12T00:00:00.000Z";
const createdRoots: string[] = [];

/** Replace machine-specific temp roots so snapshots stay deterministic. */
function sanitize(text: string): string {
  let sanitized = text;
  for (const root of createdRoots) {
    // Windows emits the same root in several shapes: verbatim (backslashes),
    // JSON-escaped (doubled backslashes) and POSIX-normalized (slashes).
    for (const variant of [root.replaceAll("\\", "\\\\"), root, root.replaceAll("\\", "/")]) {
      sanitized = sanitized.replaceAll(variant, "<PROJECT_ROOT>");
    }
  }
  // Path tails joined under the root keep host separators (JSON-escaped in
  // stdout); flatten them so snapshots match the POSIX-recorded ones.
  return sanitized.replaceAll("\\\\", "/");
}

function makeManagedProject(): string {
  // realpathSync resolves 8.3 short names (e.g. RUNNER~1) on Windows so the
  // root matches the canonical paths the CLI prints.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-cli-")));
  createdRoots.push(root);
  initializeManagedLayout({
    projectRoot: root,
    manifest: createProjectManifest({ name: "demo", repositoryId: "repo.demo", now: fixedNow }),
    packLock: createPackLock([{ name: "pack-generic", version: "0.1.0", digest: "a".repeat(64) }]),
  });
  return root;
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined)
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

describe("harness CLI help and version", () => {
  it("prints global help for --help, -h and no arguments", async () => {
    for (const argv of [["--help"], ["-h"], []]) {
      const captured = captureIo();
      const exitCode = await runCli(argv, { io: captured.io, cwd: "/" });
      expect(exitCode).toBe(EXIT_CODES.ok);
      expect(captured.stderr()).toBe("");
      expect(captured.stdout()).toMatchSnapshot();
    }
  });

  it("prints per-command help", async () => {
    for (const command of [
      "new",
      "adopt",
      "iterate",
      "resume",
      "abort",
      "approve",
      "finding",
      "impact",
      "plan",
      "run",
      "verify",
      "eval",
      "snapshot",
      "audit",
      "status",
      "serve",
      "doctor",
      "graph",
      "connect",
      "disconnect",
      "sync",
      "integrate",
      "coordinator",
    ]) {
      const captured = captureIo();
      const exitCode = await runCli([command, "--help"], { io: captured.io, cwd: "/" });
      expect(exitCode).toBe(EXIT_CODES.ok);
      expect(captured.stdout()).toMatchSnapshot();
    }
  });

  it("prints the CLI version", async () => {
    const captured = captureIo();
    const exitCode = await runCli(["--version"], { io: captured.io, cwd: "/" });
    expect(exitCode).toBe(EXIT_CODES.ok);
    expect(captured.stdout()).toMatchSnapshot();
  });
});

describe("harness CLI usage errors", () => {
  it("rejects unknown commands with the usage exit code", async () => {
    const captured = captureIo();
    const exitCode = await runCli(["frobnicate"], { io: captured.io, cwd: "/" });
    expect(exitCode).toBe(EXIT_CODES.usage);
    expect(captured.stderr()).toMatchSnapshot();
  });

  it("rejects unknown options as usage errors", async () => {
    const captured = captureIo();
    const exitCode = await runCli(["status", "--bogus"], { io: captured.io, cwd: "/" });
    expect(exitCode).toBe(EXIT_CODES.usage);
    expect(captured.stderr()).toMatchSnapshot();
  });

  it("requires --intent for new and adopt", async () => {
    for (const argv of [
      ["new", "demo"],
      ["adopt", "."],
    ]) {
      const captured = captureIo();
      const exitCode = await runCli(argv, { io: captured.io, cwd: "/" });
      expect(exitCode).toBe(EXIT_CODES.usage);
      expect(captured.stderr()).toMatchSnapshot();
    }
  });

  it("reports structured JSON usage errors in --json mode", async () => {
    const captured = captureIo();
    const exitCode = await runCli(["new", "demo", "--json"], { io: captured.io, cwd: "/" });
    expect(exitCode).toBe(EXIT_CODES.usage);
    const envelope = JSON.parse(captured.stderr()) as Record<string, unknown>;
    expect(envelope["status"]).toBe("error");
    expect(envelope["category"]).toBe("usage_error");
    expect(captured.stderr()).toMatchSnapshot();
  });
});

describe("harness CLI orchestration stubs", () => {
  it("returns an explicit stage status instead of faking success", async () => {
    const projectRoot = makeManagedProject();
    const cases: { argv: string[]; cwd: string; stage: string }[] = [
      { argv: ["iterate", "next change"], cwd: projectRoot, stage: "orchestration.iterate" },
      { argv: ["resume", "wf-op_1"], cwd: projectRoot, stage: "orchestration.resume" },
    ];
    for (const { argv, cwd, stage } of cases) {
      const captured = captureIo();
      const exitCode = await runCli([...argv, "--json"], {
        io: captured.io,
        cwd,
        runtime: createStubRuntimeService(),
      });
      expect(exitCode).toBe(EXIT_CODES.stageUnavailable);
      const result = JSON.parse(captured.stdout()) as Record<string, unknown>;
      expect(result["status"]).toBe("stage_unavailable");
      expect((result["data"] as Record<string, unknown>)["stage"]).toBe(stage);
      expect(sanitize(captured.stdout())).toMatchSnapshot();
    }
  });

  it("fails iterate and resume outside a managed project", async () => {
    for (const argv of [["iterate", "next change"], ["resume", "wf-op_1"], ["status"]]) {
      const captured = captureIo();
      const exitCode = await runCli([...argv, "--json"], { io: captured.io, cwd: "/" });
      expect(exitCode).toBe(EXIT_CODES.projectNotFound);
      const envelope = JSON.parse(captured.stderr()) as Record<string, unknown>;
      expect(envelope["category"]).toBe("project_not_found");
      expect(captured.stderr()).toMatchSnapshot();
    }
  });
});

describe("harness CLI inspection commands", () => {
  it("reports project status as structured JSON", async () => {
    const projectRoot = makeManagedProject();
    const captured = captureIo();
    const exitCode = await runCli(["status", "--json"], { io: captured.io, cwd: projectRoot });
    expect(exitCode).toBe(EXIT_CODES.ok);
    const result = JSON.parse(captured.stdout()) as Record<string, unknown>;
    const data = result["data"] as Record<string, unknown>;
    expect(data["name"]).toBe("demo");
    expect(data["committed_operations"]).toBe(0);
    expect(data["graph_cache"]).toBe("missing");
  });

  it("runs doctor checks in and outside a project", async () => {
    const projectRoot = makeManagedProject();
    const inside = captureIo();
    const insideExit = await runCli(["doctor", "--json"], {
      io: inside.io,
      cwd: projectRoot,
      gitVersion: () => "git version 2.50.0",
    });
    expect(insideExit).toBe(EXIT_CODES.ok);
    const insideResult = JSON.parse(inside.stdout()) as Record<string, unknown>;
    expect((insideResult["data"] as Record<string, unknown>)["failed_checks"]).toBe(0);

    const outside = captureIo();
    const outsideExit = await runCli(["doctor", "--json"], {
      io: outside.io,
      cwd: "/",
      gitVersion: () => "git version 2.50.0",
    });
    expect(outsideExit).toBe(EXIT_CODES.ok);
    expect(JSON.parse(outside.stdout())).toMatchSnapshot();
  });

  it("fails doctor when git is unavailable", async () => {
    const captured = captureIo();
    const exitCode = await runCli(["doctor", "--json"], {
      io: captured.io,
      cwd: "/",
      gitVersion: () => undefined,
    });
    expect(exitCode).toBe(EXIT_CODES.operationFailed);
    const result = JSON.parse(captured.stdout()) as Record<string, unknown>;
    expect((result["data"] as Record<string, unknown>)["failed_checks"]).toBe(1);
  });

  it("syncs, queries and checks the graph cache", async () => {
    const projectRoot = makeManagedProject();
    const syncCapture = captureIo();
    const syncExit = await runCli(["graph", "sync", "--json"], {
      io: syncCapture.io,
      cwd: projectRoot,
    });
    expect(syncExit).toBe(EXIT_CODES.ok);
    const syncResult = JSON.parse(syncCapture.stdout()) as Record<string, unknown>;
    const syncData = syncResult["data"] as Record<string, unknown>;
    expect(syncData["nodes"]).toBe(0);
    expect(syncData["recovered_from"]).toBe("missing");
    expect(sanitize(syncCapture.stdout())).toMatchSnapshot();

    const checkCapture = captureIo();
    const checkExit = await runCli(["graph", "check", "--json"], {
      io: checkCapture.io,
      cwd: projectRoot,
    });
    expect(checkExit).toBe(EXIT_CODES.ok);
    expect(sanitize(checkCapture.stdout())).toMatchSnapshot();

    const queryCapture = captureIo();
    const queryExit = await runCli(["graph", "query", "--json"], {
      io: queryCapture.io,
      cwd: projectRoot,
    });
    expect(queryExit).toBe(EXIT_CODES.ok);
    expect(sanitize(queryCapture.stdout())).toMatchSnapshot();
  });

  it("fails graph query before the first sync", async () => {
    const projectRoot = makeManagedProject();
    const captured = captureIo();
    const exitCode = await runCli(["graph", "query", "--json"], {
      io: captured.io,
      cwd: projectRoot,
    });
    expect(exitCode).toBe(EXIT_CODES.operationFailed);
    const envelope = JSON.parse(captured.stderr()) as Record<string, unknown>;
    expect(envelope["category"]).toBe("command_failed");
    expect(captured.stderr()).toMatchSnapshot();
  });

  it("rejects unknown graph subcommands and node types", async () => {
    const projectRoot = makeManagedProject();
    for (const argv of [
      ["graph", "explode"],
      ["graph", "query", "--type", "Nonsense"],
    ]) {
      const captured = captureIo();
      const exitCode = await runCli(argv, { io: captured.io, cwd: projectRoot });
      expect(exitCode).toBe(EXIT_CODES.usage);
      expect(captured.stderr()).toMatchSnapshot();
    }
  });
});
