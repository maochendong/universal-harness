import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EXIT_CODES, createOrchestratedRuntimeService, runCli, type CliIo } from "../src/index.js";

/**
 * Protocol 1.1 profile selection contract (slim-profiles design 10): new/adopt
 * never default a tier silently — non-interactive runs without --profile get
 * a typed input_required result; explicit or interactively confirmed choices
 * are persisted as append-only profile records before any capture runs.
 */
interface Captured {
  readonly io: CliIo;
  stdout(): string;
  stderr(): string;
}

function captureIo(isInteractive = false): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      writeStdout: (text) => out.push(text),
      writeStderr: (text) => err.push(text),
      isInteractive,
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
  return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "gc.auto=0", ...args], {
    cwd,
    encoding: "utf8",
  });
}

function makeRepo(prefix = "harness-cli-profile-repo-"): string {
  const root = makeTempDir(prefix);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Harness Test");
  git(root, "config", "user.email", "harness-test@example.com");
  git(root, "config", "commit.gpgsign", "false");
  mkdirSync(join(root, "src"), { recursive: true });
  return root;
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined)
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

function parseResult(captured: Captured): Record<string, unknown> {
  return JSON.parse(captured.stdout()) as Record<string, unknown>;
}

describe("profile selection on new/adopt", () => {
  it("returns input_required for new without --profile in non-interactive mode", async () => {
    const parent = makeTempDir("harness-cli-profile-new-");
    const captured = captureIo();
    const exitCode = await runCli(["new", "demo-app", "--intent", "build a demo", "--json"], {
      io: captured.io,
      cwd: parent,
    });
    expect(exitCode).toBe(EXIT_CODES.inputRequired);
    const result = parseResult(captured);
    expect(result["status"]).toBe("input_required");
    const data = result["data"] as Record<string, unknown>;
    expect(data["reason"]).toBe("profile_required");
    expect(data["options"]).toEqual(["lite", "standard", "governed"]);
    // Nothing is created before the explicit selection.
    expect(existsSync(join(parent, "demo-app"))).toBe(false);
  });

  it("returns input_required for adopt without --profile in non-interactive mode", async () => {
    const repo = makeRepo();
    const captured = captureIo();
    const exitCode = await runCli(["adopt", repo, "--intent", "change it", "--json"], {
      io: captured.io,
      cwd: "/",
    });
    expect(exitCode).toBe(EXIT_CODES.inputRequired);
    const result = parseResult(captured);
    expect(result["status"]).toBe("input_required");
    expect((result["data"] as Record<string, unknown>)["reason"]).toBe("profile_required");
  });

  it("fails closed on an unknown --profile instead of falling back", async () => {
    const parent = makeTempDir("harness-cli-profile-unknown-");
    const captured = captureIo();
    const exitCode = await runCli(
      ["new", "demo-app", "--intent", "build a demo", "--profile", "turbo", "--json"],
      { io: captured.io, cwd: parent },
    );
    expect(exitCode).toBe(EXIT_CODES.operationFailed);
    const result = parseResult(captured);
    expect(result["status"]).toBe("failed");
    expect((result["data"] as Record<string, unknown>)["kind"]).toBe("unknown_profile");
  });

  it(
    "persists the explicit profile before the first capture on new",
    { timeout: 60_000 },
    async () => {
      const parent = makeTempDir("harness-cli-profile-new-ok-");
      const captured = captureIo();
      const exitCode = await runCli(
        ["new", "demo-app", "--intent", "build a demo", "--profile", "lite", "--json"],
        { io: captured.io, cwd: parent },
      );
      expect(exitCode).toBe(EXIT_CODES.approvalRequired);
      const result = parseResult(captured);
      const data = result["data"] as Record<string, unknown>;
      expect(data["profile_id"]).toBe("lite");
      expect(data["profile_revision"]).toBe(1);

      const projectRoot = join(parent, "demo-app");
      const profilePath = join(
        projectRoot,
        ".harness",
        "artifacts",
        "project-profiles",
        "project_demo-app",
        "1.json",
      );
      expect(existsSync(profilePath)).toBe(true);
      const profile = JSON.parse(readFileSync(profilePath, "utf8")) as Record<string, unknown>;
      expect(profile["record_kind"]).toBe("project_profile");
      expect(profile["profile_id"]).toBe("lite");
      expect(profile["revision"]).toBe(1);
    },
  );

  it("lets an interactive session choose the profile explicitly", { timeout: 60_000 }, async () => {
    const parent = makeTempDir("harness-cli-profile-interactive-");
    const captured = captureIo(true);
    const runtime = createOrchestratedRuntimeService({
      cwd: parent,
      io: captured.io,
      // Lite: the interactive choice is the point; Standard/Governed now also
      // require committed model_providers before the pipeline may run.
      selectProfile: () => Promise.resolve("lite"),
      // The baseline approval still pauses; this test only pins the profile choice.
      prompter: { prompt: () => Promise.resolve(null) },
    });
    const exitCode = await runCli(["new", "demo-app", "--intent", "build a demo", "--json"], {
      io: captured.io,
      cwd: parent,
      runtime,
    });
    expect(exitCode).toBe(EXIT_CODES.approvalRequired);
    const data = parseResult(captured)["data"] as Record<string, unknown>;
    expect(data["profile_id"]).toBe("lite");
  });

  it(
    "adopts with --profile and carries it through the staged approval path",
    { timeout: 60_000 },
    async () => {
      const repo = makeRepo();
      writeFileSync(join(repo, "index.ts"), "export const answer = 42;\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-m", "initial commit");

      const staged = captureIo();
      const stagedExit = await runCli(
        ["adopt", repo, "--intent", "change it", "--profile", "lite", "--json"],
        { io: staged.io, cwd: "/" },
      );
      expect(stagedExit).toBe(EXIT_CODES.approvalRequired);
      const stagedData = parseResult(staged)["data"] as Record<string, unknown>;
      expect(String(stagedData["resume_command"])).toContain("--profile lite");

      const approved = captureIo();
      const approvedExit = await runCli(
        [
          "adopt",
          repo,
          "--intent",
          "change it",
          "--profile",
          "lite",
          "--approve",
          String(stagedData["staging_operation_id"]),
          "--json",
        ],
        { io: approved.io, cwd: "/" },
      );
      expect(approvedExit).toBe(EXIT_CODES.approvalRequired);
      const approvedData = parseResult(approved)["data"] as Record<string, unknown>;
      expect(approvedData["profile_id"]).toBe("lite");

      const profilesRoot = join(repo, ".harness", "artifacts", "project-profiles");
      const [projectDirectory] = readdirSync(profilesRoot);
      const profile = JSON.parse(
        readFileSync(join(profilesRoot, projectDirectory, "1.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(profile["profile_id"]).toBe("lite");
      expect(profile["revision"]).toBe(1);
    },
  );
});

describe("profile selection on iterate/resume", () => {
  async function createLegacyProject(): Promise<string> {
    // A project whose profile artifacts were never written behaves like a
    // protocol 1.0 project: the next iterate/resume must ask explicitly.
    const parent = makeTempDir("harness-cli-profile-legacy-");
    const created = captureIo();
    const exitCode = await runCli(
      ["new", "legacy-app", "--intent", "build a demo", "--profile", "lite", "--json"],
      { io: created.io, cwd: parent },
    );
    expect(exitCode).toBe(EXIT_CODES.approvalRequired);
    const projectRoot = join(parent, "legacy-app");
    // Close the first paused operation so a follow-up iterate can start fresh.
    const operationId = String(
      (parseResult(created)["data"] as Record<string, unknown>)["workflow_operation_id"],
    );
    const aborted = captureIo();
    await runCli(["abort", operationId, "--json"], { io: aborted.io, cwd: projectRoot });
    // A protocol 1.0 project has neither profile revisions nor decisions.
    rmSync(join(projectRoot, ".harness", "artifacts", "project-profiles"), {
      recursive: true,
      force: true,
    });
    rmSync(join(projectRoot, ".harness", "artifacts", "profile-decisions"), {
      recursive: true,
      force: true,
    });
    return projectRoot;
  }

  it(
    "returns profile_required for a legacy project instead of guessing",
    { timeout: 60_000 },
    async () => {
      const projectRoot = await createLegacyProject();
      const captured = captureIo();
      const exitCode = await runCli(["iterate", "next change", "--json"], {
        io: captured.io,
        cwd: projectRoot,
      });
      expect(exitCode).toBe(EXIT_CODES.inputRequired);
      const data = parseResult(captured)["data"] as Record<string, unknown>;
      expect(data["reason"]).toBe("profile_required");
      expect(data["migration"]).toBe("legacy_project_without_profile");
    },
  );

  it(
    "migrates a legacy project only through an explicit --profile",
    { timeout: 60_000 },
    async () => {
      const projectRoot = await createLegacyProject();
      const migrated = captureIo();
      const exitCode = await runCli(["iterate", "next change", "--profile", "lite", "--json"], {
        io: migrated.io,
        cwd: projectRoot,
      });
      // The pipeline itself is free to pause for the baseline approval; the
      // profile migration must already be persisted by then.
      expect(exitCode).toBe(EXIT_CODES.approvalRequired);
      const data = parseResult(migrated)["data"] as Record<string, unknown>;
      expect(data["profile_id"]).toBe("lite");
      expect(data["profile_revision"]).toBe(1);

      // Afterwards the current revision is picked up without any flag.
      const migratedOperationId = String(
        (parseResult(migrated)["data"] as Record<string, unknown>)["workflow_operation_id"],
      );
      const aborted = captureIo();
      await runCli(["abort", migratedOperationId, "--json"], { io: aborted.io, cwd: projectRoot });
      const followUp = captureIo();
      const followUpExit = await runCli(["iterate", "another change", "--json"], {
        io: followUp.io,
        cwd: projectRoot,
      });
      expect(followUpExit).toBe(EXIT_CODES.approvalRequired);
      expect((parseResult(followUp)["data"] as Record<string, unknown>)["profile_revision"]).toBe(
        1,
      );
    },
  );

  it(
    "applies an explicit project profile change to future operations only",
    { timeout: 60_000 },
    async () => {
      const parent = makeTempDir("harness-cli-profile-change-");
      const created = captureIo();
      await runCli(["new", "demo-app", "--intent", "build a demo", "--profile", "lite", "--json"], {
        io: created.io,
        cwd: parent,
      });
      const projectRoot = join(parent, "demo-app");
      // Close the first paused operation so the profile change starts fresh.
      const operationId = String(
        (parseResult(created)["data"] as Record<string, unknown>)["workflow_operation_id"],
      );
      const aborted = captureIo();
      await runCli(["abort", operationId, "--json"], { io: aborted.io, cwd: projectRoot });
      const profilesDirectory = join(
        projectRoot,
        ".harness",
        "artifacts",
        "project-profiles",
        "project_demo-app",
      );
      const revisionOne = readFileSync(join(profilesDirectory, "1.json"), "utf8");

      const changed = captureIo();
      const exitCode = await runCli(
        ["iterate", "bigger change", "--profile", "standard", "--json"],
        {
          io: changed.io,
          cwd: projectRoot,
        },
      );
      // The change is committed before the pipeline preflight runs; Standard
      // without committed model_providers then fails closed (design 11.2)
      // instead of silently degrading to the deterministic path.
      expect(exitCode).toBe(EXIT_CODES.operationFailed);
      const changedData = parseResult(changed)["data"] as Record<string, unknown>;
      expect(changedData["kind"]).toBe("configuration");

      // Append-only history: revision 1 is untouched, revision 2 supersedes it.
      expect(readFileSync(join(profilesDirectory, "1.json"), "utf8")).toBe(revisionOne);
      const revisionTwo = JSON.parse(
        readFileSync(join(profilesDirectory, "2.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(revisionTwo["profile_id"]).toBe("standard");
      expect(revisionTwo["supersedes_digest"]).toBe(
        (JSON.parse(revisionOne) as Record<string, unknown>)["record_digest"],
      );
    },
  );
});
