import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fixtureEnvelope } from "../../../tests/helpers/agent-profiles.js";
import { createCommandAgentAdapter, undeclaredWrites } from "../src/adapter.js";
import { cleanupDirectories, directoryInspector, fixtureManifest, makeTempDir } from "./helpers.js";

afterEach(cleanupDirectories);

function makeAdapter(script: string, options: Record<string, unknown> = {}) {
  const worktree = makeTempDir("harness-worktree-");
  const evidenceDir = makeTempDir("harness-evidence-");
  const adapter = createCommandAgentAdapter({
    manifest: fixtureManifest(script),
    worktree,
    evidence_dir: evidenceDir,
    ...options,
  });
  return { adapter, worktree, evidenceDir };
}

describe("command agent adapter", () => {
  it("runs a provider to a completion claim with metered usage", async () => {
    const { adapter, evidenceDir } = makeAdapter("complete.mjs");
    const result = await adapter.run(fixtureEnvelope(), { mode: "supervised" });

    expect(result.outcome).toBe("handoff");
    expect(result.termination_reason).toBe("completion");
    expect(result.completion_claimed).toBe(true);
    expect(result.summary).toContain("provider completed task task-1");
    expect(result.usage).toMatchObject({
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      metering: "provider_reported",
    });
    expect(result.usage.duration_ms).toBeGreaterThan(0);

    // Internal provider tools are reported but never as Harness-governed.
    expect(result.tool_activity).toEqual({
      total_calls: 3,
      governed_calls: 0,
      by_tool: { edit: 2, test: 1 },
    });

    // Undeclared proposal fields are dropped and disclosed.
    expect(result.state_proposal).toEqual({ summary: "implemented", open_questions: [] });
    expect(result.dropped_proposal_fields).toEqual(["budget_use"]);

    // One transcript artifact plus the provider-attached evidence.
    const kinds = result.evidence.map((entry) => entry.kind);
    expect(kinds).toContain("transcript");
    expect(kinds).toContain("artifact");
    const transcript = result.evidence.find((entry) => entry.kind === "transcript");
    expect(transcript?.locator.startsWith(evidenceDir)).toBe(true);
    expect(transcript?.digest).toMatch(/^[a-f0-9]{64}$/u);
    const persisted = JSON.parse(readFileSync(transcript?.locator ?? "", "utf8")) as {
      envelope_digest: string;
      exit_code: number;
    };
    expect(persisted.envelope_digest).toBe(fixtureEnvelope().digest);
    expect(persisted.exit_code).toBe(0);
  });

  it("passes only allowlisted environment variables to the provider", async () => {
    process.env.HARNESS_TEST_PASS = "yes";
    process.env.HARNESS_TEST_DROP = "secret";
    try {
      const { adapter } = makeAdapter("env-check.mjs");
      const manifestWithEnv = fixtureManifest("env-check.mjs", {
        env_allowlist: ["HARNESS_TEST_PASS"],
      });
      const worktree = makeTempDir("harness-worktree-");
      const scoped = createCommandAgentAdapter({
        manifest: manifestWithEnv,
        worktree,
        evidence_dir: makeTempDir("harness-evidence-"),
      });
      void adapter;
      const result = await scoped.run(fixtureEnvelope(), { mode: "supervised" });
      expect(result.summary).toBe("pass=yes drop=unset");
    } finally {
      delete process.env.HARNESS_TEST_PASS;
      delete process.env.HARNESS_TEST_DROP;
    }
  });

  it("maps a provider-reported failure to failed/adapter_failure", async () => {
    const { adapter } = makeAdapter("fail-status.mjs");
    const result = await adapter.run(fixtureEnvelope(), { mode: "supervised" });
    expect(result.outcome).toBe("failed");
    expect(result.termination_reason).toBe("adapter_failure");
    expect(result.completion_claimed).toBe(false);
    expect(result.summary).toContain("tests red");
  });

  it("maps a non-zero exit to failed/adapter_failure with stderr", async () => {
    const { adapter } = makeAdapter("exit-nonzero.mjs");
    const result = await adapter.run(fixtureEnvelope(), { mode: "supervised" });
    expect(result.outcome).toBe("failed");
    expect(result.termination_reason).toBe("adapter_failure");
    expect(result.summary).toContain("provider crashed hard");
  });

  it("rejects unparseable provider output instead of trusting it", async () => {
    const { adapter } = makeAdapter("malformed.mjs");
    const result = await adapter.run(fixtureEnvelope(), { mode: "supervised" });
    expect(result.outcome).toBe("failed");
    expect(result.termination_reason).toBe("adapter_failure");
    expect(result.completion_claimed).toBe(false);
    expect(result.summary).toContain("not valid JSON");
  });

  it("enforces the Harness duration ceiling with a timeout", async () => {
    const { adapter } = makeAdapter("sleep.mjs", { timeout_ms: 250 });
    const result = await adapter.run(fixtureEnvelope(), { mode: "supervised" });
    expect(result.outcome).toBe("partial");
    expect(result.termination_reason).toBe("timeout");
    expect(result.summary).toContain("duration ceiling");
  });

  it("clamps the timeout to the envelope duration ceiling", async () => {
    const { adapter } = makeAdapter("sleep.mjs", { timeout_ms: 60000 });
    const envelope = fixtureEnvelope({
      loop_policy: { max_steps: 30, max_tokens: 120000, max_duration_ms: 250 },
    });
    const result = await adapter.run(envelope, { mode: "supervised" });
    expect(result.termination_reason).toBe("timeout");
    expect(result.summary).toContain("250 ms");
  });

  it("fails when a metering manifest reports no usage", async () => {
    const { adapter } = makeAdapter("no-usage.mjs");
    const result = await adapter.run(fixtureEnvelope(), { mode: "supervised" });
    expect(result.outcome).toBe("failed");
    expect(result.termination_reason).toBe("adapter_failure");
    expect(result.summary).toContain("no token usage");
  });

  it("terminates at the token ceiling when reported usage exceeds it", async () => {
    const { adapter } = makeAdapter("over-budget.mjs");
    const result = await adapter.run(fixtureEnvelope(), { mode: "supervised" });
    expect(result.outcome).toBe("partial");
    expect(result.termination_reason).toBe("budget_ceiling");
    expect(result.usage.total_tokens).toBe(1000000);
  });
});

describe("repository pre/post inspection", () => {
  it("accepts writes inside the declared scope and attaches diff evidence", async () => {
    const worktree = makeTempDir("harness-worktree-");
    const adapter = createCommandAgentAdapter({
      manifest: fixtureManifest("writer-declared.mjs"),
      worktree,
      evidence_dir: makeTempDir("harness-evidence-"),
      inspector: directoryInspector(),
    });
    const result = await adapter.run(fixtureEnvelope(), { mode: "supervised" });
    expect(result.completion_claimed).toBe(true);
    expect(result.undeclared_writes).toEqual([]);
    expect(result.change_summary.paths).toEqual(["src/greeting.txt"]);
    expect(result.evidence.map((entry) => entry.kind)).toContain("diff");
  });

  it("fails a completion claim that wrote outside the declared scope", async () => {
    const worktree = makeTempDir("harness-worktree-");
    const adapter = createCommandAgentAdapter({
      manifest: fixtureManifest("writer-undeclared.mjs"),
      worktree,
      evidence_dir: makeTempDir("harness-evidence-"),
      inspector: directoryInspector(),
    });
    const result = await adapter.run(fixtureEnvelope(), { mode: "supervised" });
    expect(result.outcome).toBe("failed");
    expect(result.termination_reason).toBe("adapter_failure");
    expect(result.completion_claimed).toBe(false);
    expect(result.undeclared_writes).toEqual(["secrets.txt"]);
    expect(result.summary).toContain("undeclared");
  });
});

describe("undeclaredWrites", () => {
  const snapshot = (paths: string[]) => ({
    head: null,
    changed_paths: paths,
    digest: "0".repeat(64),
  });

  it("reports only newly changed paths outside the declared write set", () => {
    const before = snapshot(["docs/old.md"]);
    const after = snapshot(["docs/old.md", "src/a.ts", "src/deep/b.ts", "etc/c"]);
    expect(undeclaredWrites(before, after, ["src"])).toEqual(["etc/c"]);
  });

  it("treats a declared file path as an exact match", () => {
    const before = snapshot([]);
    const after = snapshot(["src/a.ts", "src/a.ts.bak"]);
    expect(undeclaredWrites(before, after, ["src/a.ts"])).toEqual(["src/a.ts.bak"]);
  });
});

describe("unattended gating", () => {
  it("refuses unattended runs when the manifest proves insufficient control", async () => {
    const { adapter } = makeAdapter("complete.mjs");
    const opaque = createCommandAgentAdapter({
      manifest: fixtureManifest("complete.mjs", {
        usage_metering: false,
        side_effect_interception: false,
        trajectory_visibility: "external-only",
        resume_semantics: "none",
      }),
      worktree: makeTempDir("harness-worktree-"),
      evidence_dir: makeTempDir("harness-evidence-"),
    });
    void adapter;
    const result = await opaque.run(fixtureEnvelope(), { mode: "unattended" });
    expect(result.outcome).toBe("correct_block");
    expect(result.termination_reason).toBe("policy_denial");
    expect(result.summary).toContain("usage metering");
    expect(result.summary).toContain("side-effect interception");
    expect(result.summary).toContain("trajectory");
    expect(result.summary).toContain("resume");
  });

  it("allows unattended runs when the manifest proves metering, interception and resume", async () => {
    const { adapter } = makeAdapter("complete.mjs");
    const result = await adapter.run(fixtureEnvelope(), { mode: "unattended" });
    expect(result.completion_claimed).toBe(true);
  });
});

describe("explicit resume", () => {
  it("hands the resume context to the provider through the input file", async () => {
    const { adapter } = makeAdapter("complete.mjs");
    let seen: string | undefined;
    const worktree = makeTempDir("harness-worktree-");
    const observing = createCommandAgentAdapter({
      manifest: fixtureManifest("complete.mjs"),
      worktree,
      evidence_dir: makeTempDir("harness-evidence-"),
      spawnProcess: async (executable, spawnOptions) => {
        const inputFile = spawnOptions.args.find((arg) => arg.endsWith("envelope.json"));
        seen = inputFile;
        const { runCommandProcess } = await import("../src/process.js");
        return runCommandProcess(executable, spawnOptions);
      },
    });
    void adapter;
    const prior = {
      note: "continue",
      prior_evidence: [{ kind: "transcript", locator: "t.json", digest: "a".repeat(64) }],
    };
    await observing.run(fixtureEnvelope(), { mode: "supervised", resume: prior });
    expect(seen).toBeDefined();
    const payload = JSON.parse(readFileSync(seen ?? join(worktree, "none"), "utf8")) as {
      resume: { note: string };
    };
    expect(payload.resume.note).toBe("continue");
  });
});
