import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EXIT_CODES,
  createStubRuntimeService,
  runCli,
  type CliIo,
  type FindingGroupRequest,
} from "../src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function managedProject(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-cli-finding-"));
  roots.push(root);
  mkdirSync(join(root, ".harness"));
  writeFileSync(
    join(root, ".harness", "manifest.yaml"),
    `${JSON.stringify({
      manifest_version: 1,
      name: "finding-route",
      repository_id: "repository_01",
      created_at: "2026-08-12T00:00:00.000Z",
    })}\n`,
    "utf8",
  );
  return root;
}

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

describe("harness finding group route", () => {
  it("requires a membership digest and delegates the complete batch request", async () => {
    const calls: FindingGroupRequest[] = [];
    const runtime = {
      ...createStubRuntimeService(),
      findingGroup: (request: FindingGroupRequest) => {
        calls.push(request);
        return Promise.resolve({
          command: "finding",
          status: "ok" as const,
          message: "group superseded",
          data: { group_id: request.groupId },
        });
      },
    };
    const captured = captureIo();
    const digest = "a".repeat(64);
    const projectRoot = managedProject();

    const exitCode = await runCli(
      [
        "finding",
        "group",
        "supersede",
        "finding-group_0123456789abcdef",
        "--digest",
        digest,
        "--actor",
        "human:reviewer",
        "--json",
      ],
      { io: captured.io, cwd: projectRoot, runtime },
    );

    expect(exitCode).toBe(EXIT_CODES.ok);
    expect(calls).toEqual([
      {
        action: "supersede",
        groupId: "finding-group_0123456789abcdef",
        membershipDigest: digest,
        projectRoot,
        actor: "human:reviewer",
      },
    ]);
    expect(JSON.parse(captured.stdout())).toMatchObject({ status: "ok" });
    expect(captured.stderr()).toBe("");
  });
});
