import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EXIT_CODES,
  createStubRuntimeService,
  runCli,
  type CliIo,
  type ResumeRequest,
} from "../src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function captureIo(): { readonly io: CliIo; stdout(): string; stderr(): string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text),
      isInteractive: false,
    },
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  };
}

/** A managed project plus a stub runtime that records the resume request. */
async function projectWithRecordingRuntime(): Promise<{
  readonly projectRoot: string;
  readonly requests: ResumeRequest[];
  readonly runtime: ReturnType<typeof createStubRuntimeService>;
}> {
  const parent = mkdtempSync(join(tmpdir(), "harness-cli-resume-"));
  roots.push(parent);
  await runCli(["new", "project", "--intent", "resume answer routing", "--profile", "lite"], {
    cwd: parent,
    io: captureIo().io,
  });
  const projectRoot = join(parent, "project");
  const requests: ResumeRequest[] = [];
  const runtime = {
    ...createStubRuntimeService(),
    resume: (request: ResumeRequest) => {
      requests.push(request);
      return Promise.resolve({
        command: "resume",
        status: "ok" as const,
        message: "resumed",
        data: {},
      });
    },
  };
  return { projectRoot, requests, runtime };
}

describe("harness resume --answer/--answers", () => {
  it("routes repeated --answer flags as free-text clarification answers", async () => {
    const { projectRoot, requests, runtime } = await projectWithRecordingRuntime();
    const output = captureIo();

    expect(
      await runCli(
        [
          "resume",
          "wf-op_1",
          "--answer",
          "question_a=only visible rows",
          "--answer",
          "question_b=weekly",
        ],
        { cwd: projectRoot, io: output.io, runtime },
      ),
    ).toBe(EXIT_CODES.ok);
    expect(requests).toEqual([
      {
        workflowOperationId: "wf-op_1",
        projectRoot,
        answers: [
          { question_id: "question_a", answer_kind: "free_text", value: "only visible rows" },
          { question_id: "question_b", answer_kind: "free_text", value: "weekly" },
        ],
      },
    ]);
  });

  it("routes --answers file entries with their explicit answer kinds", async () => {
    const { projectRoot, requests, runtime } = await projectWithRecordingRuntime();
    writeFileSync(
      join(projectRoot, "answers.json"),
      JSON.stringify([
        { question_id: "question_a", value: "only visible rows" },
        { question_id: "question_b", answer_kind: "selected_option", value: "option_weekly" },
      ]),
      "utf8",
    );
    const output = captureIo();

    expect(
      await runCli(["resume", "wf-op_1", "--answers", "answers.json"], {
        cwd: projectRoot,
        io: output.io,
        runtime,
      }),
    ).toBe(EXIT_CODES.ok);
    expect(requests[0]?.answers).toEqual([
      { question_id: "question_a", answer_kind: "free_text", value: "only visible rows" },
      { question_id: "question_b", answer_kind: "selected_option", value: "option_weekly" },
    ]);
  });

  it("keeps the answer-less resume request shape unchanged", async () => {
    const { projectRoot, requests, runtime } = await projectWithRecordingRuntime();
    const output = captureIo();

    expect(await runCli(["resume", "wf-op_1"], { cwd: projectRoot, io: output.io, runtime })).toBe(
      EXIT_CODES.ok,
    );
    expect(requests).toEqual([{ workflowOperationId: "wf-op_1", projectRoot }]);
  });

  it("rejects malformed answer input as a typed usage error", async () => {
    const { projectRoot, requests, runtime } = await projectWithRecordingRuntime();

    expect(
      await runCli(["resume", "wf-op_1", "--answer", "no-equals-sign"], {
        cwd: projectRoot,
        io: captureIo().io,
        runtime,
      }),
    ).toBe(EXIT_CODES.usage);
    writeFileSync(join(projectRoot, "broken.json"), JSON.stringify({ not: "an array" }), "utf8");
    expect(
      await runCli(["resume", "wf-op_1", "--answers", "broken.json"], {
        cwd: projectRoot,
        io: captureIo().io,
        runtime,
      }),
    ).toBe(EXIT_CODES.usage);
    expect(requests).toEqual([]);
  });
});
