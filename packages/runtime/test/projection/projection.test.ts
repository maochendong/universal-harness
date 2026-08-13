import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Hex } from "@universal-harness-internal/core";

import {
  ProjectionError,
  buildProviderInstructionMirror,
  detectProjectionDrift,
  detectProjectionDrifts,
  managedProjectionPath,
  planManagedWrite,
  providerInstructionPath,
  writeManagedOutput,
} from "../../src/index.js";

const created: string[] = [];

afterEach(() => {
  while (created.length > 0) {
    const directory = created.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function makeHarnessRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "harness-projection-"));
  created.push(directory);
  return directory;
}

const ENVELOPE_DIGEST = "a".repeat(64);
const BUNDLE_DIGEST = "b".repeat(64);

describe("managed projection output", () => {
  it("accepts nested relative names and stays under the managed root", () => {
    expect(managedProjectionPath("views/prd.md")).toBe("projections/views/prd.md");
  });

  it("rejects names that would escape the managed root", () => {
    for (const name of ["../secret.md", "/abs/path.md", "a/../b.md", "win\\path.md", ""]) {
      expect(() => managedProjectionPath(name)).toThrowError(ProjectionError);
      try {
        managedProjectionPath(name);
      } catch (error) {
        expect((error as ProjectionError).kind).toBe("unmanaged_path");
      }
    }
  });

  it("creates, no-ops and refuses unapproved rewrites", () => {
    const harnessRoot = makeHarnessRoot();
    const output = { name: "views/prd.md", content: "# PRD\n" };
    const first = writeManagedOutput(harnessRoot, output);
    expect(first.action).toBe("create");
    expect(first.digest).toBe(sha256Hex("# PRD\n"));

    const second = writeManagedOutput(harnessRoot, output);
    expect(second.action).toBe("noop");

    // A hand edit makes the on-disk bytes foreign: rewriting them needs approval.
    writeFileSync(join(harnessRoot, "projections/views/prd.md"), "# hand edit\n", "utf8");
    const plan = planManagedWrite(harnessRoot, output);
    expect(plan.action).toBe("rewrite");
    expect(() => writeManagedOutput(harnessRoot, output)).toThrowError(ProjectionError);
    expect(readFileSync(join(harnessRoot, "projections/views/prd.md"), "utf8")).toBe(
      "# hand edit\n",
    );

    const approved = writeManagedOutput(harnessRoot, output, { overwriteApproved: true });
    expect(approved.action).toBe("rewrite");
    expect(readFileSync(join(harnessRoot, "projections/views/prd.md"), "utf8")).toBe("# PRD\n");
  });

  it("never writes outside the managed projection directory", () => {
    const harnessRoot = makeHarnessRoot();
    expect(() =>
      writeManagedOutput(harnessRoot, { name: "../../CLAUDE.md", content: "x" }),
    ).toThrowError(ProjectionError);
    expect(existsSync(join(harnessRoot, "..", "CLAUDE.md"))).toBe(false);
  });
});

describe("provider instruction mirror", () => {
  it("is reproducible: same inputs produce the same bytes and digest", () => {
    const spec = {
      provider: "claude",
      instruction: "Follow the pack rules.",
      task_envelope_digest: ENVELOPE_DIGEST,
      context_bundle_digest: BUNDLE_DIGEST,
    };
    const first = buildProviderInstructionMirror(spec);
    const second = buildProviderInstructionMirror(spec);
    expect(second.output.content).toBe(first.output.content);
    expect(second.digest).toBe(first.digest);
    expect(first.output.name).toBe("providers/claude.md");
    expect(providerInstructionPath("claude")).toBe("projections/providers/claude.md");
    expect(first.output.content).toContain(`task_envelope_digest: ${ENVELOPE_DIGEST}`);
    expect(first.output.content).toContain("Follow the pack rules.");
  });

  it("changes the digest when any bound input changes", () => {
    const base = buildProviderInstructionMirror({
      provider: "claude",
      instruction: "Follow the pack rules.",
      task_envelope_digest: ENVELOPE_DIGEST,
      context_bundle_digest: BUNDLE_DIGEST,
    });
    const changed = buildProviderInstructionMirror({
      provider: "claude",
      instruction: "Follow the pack rules.",
      task_envelope_digest: ENVELOPE_DIGEST,
      context_bundle_digest: "c".repeat(64),
    });
    expect(changed.digest).not.toBe(base.digest);
  });

  it("rejects invalid provider ids and malformed digests", () => {
    expect(() =>
      buildProviderInstructionMirror({
        provider: "Claude Code",
        instruction: "x",
        task_envelope_digest: ENVELOPE_DIGEST,
        context_bundle_digest: BUNDLE_DIGEST,
      }),
    ).toThrowError(ProjectionError);
    expect(() =>
      buildProviderInstructionMirror({
        provider: "claude",
        instruction: "x",
        task_envelope_digest: "not-a-digest",
        context_bundle_digest: BUNDLE_DIGEST,
      }),
    ).toThrowError(ProjectionError);
  });
});

describe("projection drift", () => {
  it("reports current, drifted and missing projections", () => {
    const harnessRoot = makeHarnessRoot();
    const mirror = buildProviderInstructionMirror({
      provider: "claude",
      instruction: "Follow the pack rules.",
      task_envelope_digest: ENVELOPE_DIGEST,
      context_bundle_digest: BUNDLE_DIGEST,
    });
    const target = { path: mirror.output.name, expectedDigest: mirror.digest };

    expect(detectProjectionDrift(harnessRoot, target).status).toBe("missing");

    writeManagedOutput(harnessRoot, mirror.output);
    expect(detectProjectionDrift(harnessRoot, target).status).toBe("current");

    const absolute = join(harnessRoot, "projections", "providers", "claude.md");
    writeFileSync(absolute, "# hand edit\n", "utf8");
    const drifted = detectProjectionDrift(harnessRoot, target);
    expect(drifted.status).toBe("drifted");
    expect(drifted.actual_digest).toBe(sha256Hex("# hand edit\n"));
  });

  it("reports several targets in deterministic path order", () => {
    const harnessRoot = makeHarnessRoot();
    mkdirSync(join(harnessRoot, "projections/views"), { recursive: true });
    writeFileSync(join(harnessRoot, "projections/views/b.md"), "b\n", "utf8");
    const report = detectProjectionDrifts(harnessRoot, [
      { path: "views/b.md", expectedDigest: sha256Hex("b\n") },
      { path: "views/a.md", expectedDigest: sha256Hex("a\n") },
    ]);
    expect(report.map((entry) => entry.path)).toEqual([
      "projections/views/a.md",
      "projections/views/b.md",
    ]);
    expect(report.map((entry) => entry.status)).toEqual(["missing", "current"]);
  });
});
