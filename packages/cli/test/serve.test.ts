import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EXIT_CODES,
  createStubRuntimeService,
  runCli,
  type CliIo,
  type ServeRequest,
} from "../src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-cli-serve-"));
  roots.push(root);
  mkdirSync(join(root, ".harness"));
  writeFileSync(
    join(root, ".harness", "manifest.yaml"),
    `${JSON.stringify({
      manifest_version: 1,
      name: "serve-route",
      repository_id: "repository_serve",
      created_at: "2026-08-16T00:00:00.000Z",
    })}\n`,
    "utf8",
  );
  return root;
}

function io(): { readonly value: CliIo; stdout(): string; stderr(): string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    value: {
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text),
      isInteractive: false,
    },
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  };
}

describe("harness serve route", () => {
  it("defaults to a random port and delegates to the Dashboard composition root", async () => {
    const requests: ServeRequest[] = [];
    const runtime = {
      ...createStubRuntimeService(),
      serve: (request: ServeRequest) => {
        requests.push(request);
        return Promise.resolve({
          command: "serve",
          status: "ok" as const,
          message: "Dashboard started",
          data: { bootstrap_url: "http://127.0.0.1:43123/?token=secret" },
        });
      },
    };
    const captured = io();
    const projectRoot = project();

    const exitCode = await runCli(["serve", "--json"], {
      cwd: projectRoot,
      io: captured.value,
      runtime,
    });

    expect(exitCode).toBe(EXIT_CODES.ok);
    expect(requests).toEqual([{ projectRoot, port: 0 }]);
    expect(JSON.parse(captured.stdout())).toMatchObject({ command: "serve", status: "ok" });
    expect(captured.stderr()).toBe("");
  });

  it("accepts a fixed valid port and rejects invalid ports before delegation", async () => {
    const requests: ServeRequest[] = [];
    const runtime = {
      ...createStubRuntimeService(),
      serve: (request: ServeRequest) => {
        requests.push(request);
        return Promise.resolve({
          command: "serve",
          status: "ok" as const,
          message: "started",
          data: {},
        });
      },
    };
    const projectRoot = project();
    const valid = io();
    expect(
      await runCli(["serve", "--port", "43210"], {
        cwd: projectRoot,
        io: valid.value,
        runtime,
      }),
    ).toBe(EXIT_CODES.ok);
    expect(requests).toEqual([{ projectRoot, port: 43210 }]);

    const invalid = io();
    expect(
      await runCli(["serve", "--port", "70000", "--json"], {
        cwd: projectRoot,
        io: invalid.value,
        runtime,
      }),
    ).toBe(EXIT_CODES.usage);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(invalid.stderr())).toMatchObject({ category: "usage_error" });
  });
});
