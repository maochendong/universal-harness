import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectManifest, serializeProjectManifest } from "@universal-harness-internal/core";
import { runCli, createStubRuntimeService } from "../src/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("doctor Agent capability preflight", () => {
  it("reports supervision and unavailable metering without launching the configured executable", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-doctor-agent-"));
    roots.push(root);
    mkdirSync(join(root, ".harness"));
    writeFileSync(
      join(root, ".harness/manifest.yaml"),
      serializeProjectManifest(
        createProjectManifest({
          name: "doctor-agent",
          repositoryId: "repository_doctor",
          now: () => "2026-09-08T00:00:00.000Z",
        }),
      ),
    );
    writeFileSync(
      join(root, ".harness/runtime.json"),
      JSON.stringify({
        runtime_config_version: 1,
        agent: {
          provider: "dsh",
          executable: "must-not-be-launched-doctor",
          launcher_args: [],
          expected_version: "0.1.1-rc.2",
          allowed_read_paths: ["src"],
          proposed_write_paths: ["src"],
        },
        agent_pool: { slots: 2 },
        gates: [],
      }),
    );
    let stdout = "";
    await runCli(["doctor", "--json"], {
      cwd: root,
      runtime: createStubRuntimeService(),
      gitVersion: () => "git version 2.33.0",
      io: {
        isInteractive: false,
        writeStdout: (chunk) => {
          stdout += chunk;
        },
        writeStderr: () => undefined,
      },
    });
    const result = JSON.parse(stdout) as {
      data: { checks: { name: string; detail: string; status: string }[] };
    };
    const check = result.data.checks.find((item) => item.name === "agent_execution_capabilities");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("external-only");
    expect(check?.detail).toContain("unavailable");
    expect(check?.detail).toContain("单槽位");
  });
});
