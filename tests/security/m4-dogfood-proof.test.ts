import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectPackageBuildProvenance,
  resolveDshExecutable,
  verifyProbeWorkspace,
} from "../../scripts/m4-dogfood-proof.mjs";

const roots: string[] = [];

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-m4-dogfood-proof-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Harness Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "harness@example.invalid"], { cwd: root });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("M4 real-provider dogfood proof", () => {
  it("uses a portable dsh command unless an explicit path is configured", () => {
    expect(resolveDshExecutable({})).toBe("dsh");
    expect(resolveDshExecutable({ environment: "/opt/harness/dsh" })).toBe("/opt/harness/dsh");
    expect(resolveDshExecutable({ argument: "./tools/dsh", environment: "/opt/harness/dsh" })).toBe(
      "./tools/dsh",
    );
  });

  it("requires the exact expected bytes and no path outside the probe output", () => {
    const root = repository();
    writeFileSync(join(root, "README.md"), "baseline\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: root });
    mkdirSync(join(root, "src", "dogfood"), { recursive: true });
    const expected = "export const m4DogfoodProbe = 'real-dsh';\n";
    writeFileSync(join(root, "src", "dogfood", "probe.ts"), expected, "utf8");

    expect(
      verifyProbeWorkspace({
        repositoryRoot: root,
        expectedPath: "src/dogfood/probe.ts",
        expectedBytes: expected,
      }),
    ).toMatchObject({
      status: "passed",
      exact_bytes_match: true,
      only_allowed_path_changed: true,
      changed_paths: ["src/dogfood/probe.ts"],
    });

    writeFileSync(join(root, "unexpected.txt"), "not allowed\n", "utf8");
    expect(
      verifyProbeWorkspace({
        repositoryRoot: root,
        expectedPath: "src/dogfood/probe.ts",
        expectedBytes: expected,
      }),
    ).toMatchObject({ status: "failed", only_allowed_path_changed: false });

    rmSync(join(root, "unexpected.txt"));
    writeFileSync(join(root, "src", "dogfood", "probe.ts"), "export const wrong = true;\n");
    expect(
      verifyProbeWorkspace({
        repositoryRoot: root,
        expectedPath: "src/dogfood/probe.ts",
        expectedBytes: expected,
      }),
    ).toMatchObject({ status: "failed", exact_bytes_match: false });
  });

  it("binds package source trees and built entry bytes to the implementation commit", () => {
    const root = repository();
    mkdirSync(join(root, "packages", "demo", "src"), { recursive: true });
    mkdirSync(join(root, "packages", "demo", "dist"), { recursive: true });
    writeFileSync(join(root, "packages", "demo", "package.json"), '{"name":"demo"}\n');
    writeFileSync(join(root, "packages", "demo", "src", "index.ts"), "export const x = 1;\n");
    writeFileSync(join(root, "packages", "demo", "dist", "index.js"), "export const x = 1;\n");
    execFileSync("git", ["add", "packages/demo/package.json", "packages/demo/src/index.ts"], {
      cwd: root,
    });
    execFileSync("git", ["commit", "-qm", "source"], { cwd: root });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();

    const proof = collectPackageBuildProvenance({
      repositoryRoot: root,
      implementationCommit: commit,
      packages: [{ name: "demo", path: "packages/demo" }],
    });

    expect(proof).toMatchObject({
      implementation_commit: commit,
      source_head_matches_implementation_commit: true,
      tracked_source_clean: true,
      provenance_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      packages: [
        {
          name: "demo",
          path: "packages/demo",
          source_tree_oid: expect.stringMatching(/^[a-f0-9]{40,64}$/u),
          package_json_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          dist_entry_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      ],
    });
  });
});
