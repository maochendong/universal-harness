import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EXIT_CODES, runCli, type CliIo } from "../src/index.js";
import { FileLiveSpool, ObservationPublisher } from "@universal-harness-internal/runtime";

interface CapturedIo {
  readonly io: CliIo;
  stdout(): string;
}

function captureIo(): CapturedIo {
  const stdout: string[] = [];
  return {
    io: {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => undefined,
      isInteractive: false,
    },
    stdout: () => stdout.join(""),
  };
}

const roots: string[] = [];

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-cli-status-")));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("harness status rendering", () => {
  it("shows a live active_run until its disposable stream terminates", async () => {
    const parent = tempRoot();
    await runCli(
      ["new", "active-demo", "--intent", "exercise live status", "--profile", "lite", "--json"],
      {
        io: captureIo().io,
        cwd: parent,
      },
    );
    const projectRoot = join(parent, "active-demo");
    const publisher = new ObservationPublisher(new FileLiveSpool(projectRoot), {
      projectId: "project_active-demo",
      iterationId: "iteration_active-demo",
      workflowOperationId: "workflow_active-demo",
      attemptId: "attempt_active-demo",
    });
    publisher.phaseStarted("execute");
    publisher.runStarted("run_active-demo", { task_id: "task_active-demo" });

    const running = captureIo();
    await runCli(["status", "--json"], { io: running.io, cwd: projectRoot });
    expect(
      (JSON.parse(running.stdout()) as { data: { active_run?: { run_id: string } } }).data
        .active_run?.run_id,
    ).toBe("run_active-demo");

    publisher.runTerminated("run_active-demo", { outcome: "handoff" });
    const completed = captureIo();
    await runCli(["status", "--json"], { io: completed.io, cwd: projectRoot });
    expect(
      (JSON.parse(completed.stdout()) as { data: { active_run?: unknown } }).data.active_run,
    ).toBeUndefined();
  });

  it("keeps compatibility arrays in JSON but renders only grouped Finding summaries for humans", async () => {
    const parent = tempRoot();
    const bootstrap = captureIo();
    await runCli(
      ["new", "status-demo", "--intent", "exercise status", "--profile", "lite", "--json"],
      {
        io: bootstrap.io,
        cwd: parent,
      },
    );
    const projectRoot = join(parent, "status-demo");

    const human = captureIo();
    expect(await runCli(["status"], { io: human.io, cwd: projectRoot })).toBe(EXIT_CODES.ok);
    expect(human.stdout()).toContain("finding_group_count: 0");
    expect(human.stdout()).toContain("finding_groups: []");
    expect(human.stdout()).not.toMatch(/^ {2}warnings:/mu);
    expect(human.stdout()).not.toContain("blocking finding ");
    expect(human.stdout()).not.toContain("warning finding ");

    const json = captureIo();
    expect(await runCli(["status", "--json"], { io: json.io, cwd: projectRoot })).toBe(
      EXIT_CODES.ok,
    );
    const data = (JSON.parse(json.stdout()) as { data: Record<string, unknown> }).data;
    expect(data["blockers"]).toEqual([
      expect.stringMatching(/^approval request .+ awaiting a decision$/u),
    ]);
    expect(data["warnings"]).toEqual([]);
    expect(data["finding_groups"]).toEqual([]);
    expect(data["finding_group_count"]).toBeUndefined();
    expect(data["control_level"]).toBe("none");
    expect(data["budget_observations"]).toBeUndefined();
  });
});
