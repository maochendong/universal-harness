import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createCommandAgentAdapter } from "../../adapters/agent-command/src/adapter.js";
import { createManualAgentAdapter } from "../../adapters/agent-manual/src/adapter.js";
import { assessUnattendedEligibility } from "../../packages/plugin-sdk/src/agent.js";
import {
  DELEGATED_CAPABLE_PROFILE,
  DELEGATED_OPAQUE_PROFILE,
  fixtureEnvelope,
  manifestFromProfile,
  MANAGED_PROFILE,
  MANUAL_PROFILE,
} from "../helpers/agent-profiles.js";

/**
 * Delegated-provider capability mismatch and undeclared-write detection
 * (design 13.2, security test list; acceptance 14 and 23). A delegated
 * provider whose manifest cannot prove metering, interception, resume and
 * trajectory coverage is forced into supervised mode: unattended execution is
 * blocked with a policy denial. Capability claims are checked against actual
 * behavior -- a provider claiming completion without reporting usage, or
 * while writing outside the declared paths, fails instead of being trusted.
 */

const securityDirectory = dirname(fileURLToPath(import.meta.url));
const fixtures = join(securityDirectory, "../../adapters/agent-command/test/fixtures");

const createdDirectories: string[] = [];

afterEach(() => {
  while (createdDirectories.length > 0) {
    const directory = createdDirectories.pop();
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

function makeTempDir(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  createdDirectories.push(directory);
  return directory;
}

function commandAdapter(script: string, manifestOverrides: Record<string, unknown> = {}) {
  return createCommandAgentAdapter({
    manifest: {
      provider: "opaque-provider",
      control: "delegated",
      trajectory_visibility: "summarized",
      usage_metering: true,
      side_effect_interception: true,
      resume_semantics: "explicit",
      executable: process.execPath,
      args: [join(fixtures, script), "{input_file}"],
      env_allowlist: [],
      ...manifestOverrides,
    } as never,
    worktree: makeTempDir("harness-sec-worktree-"),
    evidence_dir: makeTempDir("harness-sec-evidence-"),
  });
}

describe("unattended eligibility assessment", () => {
  it("marks a managed profile eligible", () => {
    expect(
      assessUnattendedEligibility(manifestFromProfile("p", MANAGED_PROFILE, "native")),
    ).toEqual({ eligible: true, reasons: [] });
  });

  it("marks a fully capable delegated profile eligible", () => {
    const assessment = assessUnattendedEligibility(
      manifestFromProfile("p", DELEGATED_CAPABLE_PROFILE, "explicit"),
    );
    expect(assessment.eligible).toBe(true);
  });

  it("forces an opaque delegated provider into supervised mode with stable reasons", () => {
    const assessment = assessUnattendedEligibility(
      manifestFromProfile("p", DELEGATED_OPAQUE_PROFILE, "none"),
    );
    expect(assessment.eligible).toBe(false);
    expect(assessment.reasons.join(" ")).toContain("usage metering");
    expect(assessment.reasons.join(" ")).toContain("side-effect interception");
    expect(assessment.reasons.join(" ")).toContain("trajectory");
    expect(assessment.reasons.join(" ")).toContain("resume");
  });

  it("never marks a manual profile unattended-eligible", () => {
    const assessment = assessUnattendedEligibility(
      manifestFromProfile("manual", MANUAL_PROFILE, "explicit"),
    );
    expect(assessment.eligible).toBe(false);
    expect(assessment.reasons.join(" ")).toContain("never unattended");
  });
});

describe("delegated provider capability mismatch", () => {
  it("blocks an unattended run for an under-declared provider before spawning anything", async () => {
    const adapter = commandAdapter("complete.mjs", {
      usage_metering: false,
      side_effect_interception: false,
      trajectory_visibility: "external-only",
      resume_semantics: "none",
    });
    const result = await adapter.run(fixtureEnvelope(), { mode: "unattended" });
    expect(result.outcome).toBe("correct_block");
    expect(result.termination_reason).toBe("policy_denial");
    expect(result.completion_claimed).toBe(false);
    // Refused before execution: no transcript evidence exists.
    expect(result.evidence).toEqual([]);
  });

  it("fails a completion claim that reports no usage despite a metering manifest", async () => {
    const adapter = commandAdapter("no-usage.mjs");
    const result = await adapter.run(fixtureEnvelope(), { mode: "unattended" });
    expect(result.outcome).toBe("failed");
    expect(result.termination_reason).toBe("adapter_failure");
    expect(result.completion_claimed).toBe(false);
  });

  it("never reports opaque provider-internal tools as Harness-governed", async () => {
    const adapter = commandAdapter("complete.mjs");
    const result = await adapter.run(fixtureEnvelope(), { mode: "unattended" });
    expect(result.tool_activity.total_calls).toBe(3);
    expect(result.tool_activity.governed_calls).toBe(0);
  });

  it("turns unparseable provider output into an adapter failure, never a success", async () => {
    const adapter = commandAdapter("malformed.mjs");
    const result = await adapter.run(fixtureEnvelope(), { mode: "supervised" });
    expect(result.outcome).toBe("failed");
    expect(result.completion_claimed).toBe(false);
  });

  it("detects undeclared writes behind a completion claim", async () => {
    const worktree = makeTempDir("harness-sec-worktree-");
    const { readdirSync, statSync } = await import("node:fs");
    const adapter = createCommandAgentAdapter({
      manifest: {
        provider: "opaque-provider",
        control: "delegated",
        trajectory_visibility: "summarized",
        usage_metering: true,
        side_effect_interception: true,
        resume_semantics: "explicit",
        executable: process.execPath,
        args: [join(fixtures, "writer-undeclared.mjs"), "{input_file}"],
        env_allowlist: [],
      },
      worktree,
      evidence_dir: makeTempDir("harness-sec-evidence-"),
      inspector: {
        inspect(root: string) {
          const paths = readdirSync(root)
            .filter((entry) => !statSync(join(root, entry)).isDirectory())
            .sort();
          return Promise.resolve({ head: null, changed_paths: paths, digest: "0".repeat(64) });
        },
      },
    });
    const result = await adapter.run(fixtureEnvelope(), { mode: "unattended" });
    expect(result.outcome).toBe("failed");
    expect(result.completion_claimed).toBe(false);
    expect(result.undeclared_writes).toEqual(["secrets.txt"]);
  });

  it("never lets a manual adapter run unattended", async () => {
    let handoffCalled = false;
    const manual = createManualAgentAdapter({
      handoff: () => {
        handoffCalled = true;
        return Promise.resolve({ status: "completed", summary: "x", evidence: [] });
      },
    });
    const result = await manual.run(fixtureEnvelope(), { mode: "unattended" });
    expect(result.outcome).toBe("correct_block");
    expect(result.termination_reason).toBe("policy_denial");
    expect(handoffCalled).toBe(false);
  });
});
