import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SemanticSeedProvider } from "@universal-harness-internal/plugin-sdk";
import { materializeLedger, pageNodes } from "@universal-harness-internal/graph";

import {
  EXIT_CODES,
  createOrchestratedRuntimeService,
  createStubRuntimeService,
  runCli,
  type CliIo,
  type ImpactRequest,
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

describe("harness impact --semantic", () => {
  it("delegates the semantic intent without changing the structural route contract", async () => {
    const parent = mkdtempSync(join(tmpdir(), "harness-cli-impact-route-"));
    roots.push(parent);
    const bootstrapIo = captureIo();
    await runCli(["new", "project", "--intent", "route semantic impact", "--profile", "lite"], {
      cwd: parent,
      io: bootstrapIo.io,
    });
    const projectRoot = join(parent, "project");
    const requests: ImpactRequest[] = [];
    const runtime = {
      ...createStubRuntimeService(),
      impact: (request: ImpactRequest) => {
        requests.push(request);
        return Promise.resolve({
          command: "impact",
          status: "ok" as const,
          message: "semantic staged",
          data: {},
        });
      },
    };
    const output = captureIo();

    expect(
      await runCli(["impact", "requirement_route", "--semantic", "--json"], {
        cwd: projectRoot,
        io: output.io,
        runtime,
      }),
    ).toBe(EXIT_CODES.ok);
    expect(requests).toEqual([{ projectRoot, target: "requirement_route", semantic: true }]);
  });

  it("keeps the structural ImpactSet successful when the semantic provider fails", async () => {
    const parent = mkdtempSync(join(tmpdir(), "harness-cli-impact-failure-"));
    roots.push(parent);
    const bootstrapIo = captureIo();
    await runCli(
      ["new", "project", "--intent", "preserve structural impact", "--profile", "lite", "--json"],
      {
        cwd: parent,
        io: bootstrapIo.io,
      },
    );
    const projectRoot = join(parent, "project");
    const { database } = materializeLedger({ projectRoot, databasePath: ":memory:" });
    const seedNodeId = pageNodes(database, { limit: 1 }).items[0]?.id;
    database.close();
    if (seedNodeId === undefined) throw new Error("bootstrap graph has no seed node");
    const failingProvider: SemanticSeedProvider = {
      name: "failing-provider",
      version: "1.0.0",
      buildIndex: () => Promise.reject(new Error("provider intentionally unavailable")),
      suggest: () => Promise.resolve([]),
    };
    const output = captureIo();
    const runtime = createOrchestratedRuntimeService({
      cwd: projectRoot,
      io: output.io,
      semanticProvider: failingProvider,
    });

    expect(
      await runCli(["impact", seedNodeId, "--semantic", "--json"], {
        cwd: projectRoot,
        io: output.io,
        runtime,
      }),
    ).toBe(EXIT_CODES.ok);
    const result = JSON.parse(output.stdout()) as {
      status: string;
      data: {
        entries: unknown[];
        semantic_proposals: unknown[];
        semantic_diagnostic: string;
      };
    };
    expect(result.status).toBe("ok");
    expect(result.data.entries.length).toBeGreaterThan(0);
    expect(result.data.semantic_proposals).toEqual([]);
    expect(result.data.semantic_diagnostic).toContain("provider intentionally unavailable");
  });
});
