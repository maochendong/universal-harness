import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ReleaseEvidenceError,
  assertCanonicalSuiteReports,
  digestTrackedEvidence,
  renderM4Markdown,
  verifyM4ReportCommit,
} from "../../scripts/lib/m4-release-evidence.mjs";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

function completeResults(): readonly Record<string, unknown>[] {
  return Array.from({ length: 20 }, (_, index) => ({
    acceptance_id: `AC-${String(index + 1).padStart(2, "0")}`,
    statement: "proof",
    status: "passed",
    required_suites: [],
    suite_invocation_ids: {},
    commands: [],
    evidence: [],
    evidence_digest: "1".repeat(64),
    design_section: "§24",
    detail: "verified",
  }));
}

function completeInvocationIds(): Record<string, string> {
  return {
    main: "inv-main",
    security: "inv-security",
    fault: "inv-fault",
    performance: "inv-performance",
    e2e: "inv-e2e",
    "playwright-dashboard": "inv-playwright-dashboard",
  };
}

function report(
  suite: string,
  command: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: "harness.acceptance-suite-report/1",
    implementation_commit: COMMIT_A,
    started_commit: COMMIT_A,
    finished_commit: COMMIT_A,
    tracked_worktree_clean_at_start: true,
    tracked_worktree_clean_at_finish: true,
    tracked_worktree_clean: true,
    invocation_id: `inv-${suite}`,
    suite,
    command,
    coverage: "full",
    files_total: 1,
    files_failed: 0,
    failed_files: [],
    files: [{ path: `${suite}.test.ts`, state: "pass" }],
    ...overrides,
  };
}

describe("canonical M4 release suite reports", () => {
  const commands = {
    main: "pnpm test",
    security: "pnpm test:security",
    fault: "pnpm test:fault",
  } as const;

  it("accepts same-commit, full, canonical invocations", () => {
    const reports = new Map([
      ["main", report("main", commands.main)],
      ["security", report("security", commands.security)],
      ["fault", report("fault", commands.fault)],
    ]);
    expect(assertCanonicalSuiteReports(reports, commands, COMMIT_A)).toEqual({
      main: "inv-main",
      security: "inv-security",
      fault: "inv-fault",
    });
  });

  it.each([
    ["stale commit", "main", { implementation_commit: COMMIT_B }],
    ["partial coverage", "security", { coverage: "partial" }],
    ["mixed commit", "fault", { implementation_commit: COMMIT_B }],
    ["command mismatch", "main", { command: "pnpm test -- one.test.ts" }],
    ["dirty tracked worktree", "main", { tracked_worktree_clean: false }],
    ["commit changed during run", "main", { finished_commit: COMMIT_B }],
  ])("rejects %s", (_name, changedSuite, overrides) => {
    const reports = new Map([
      ["main", report("main", commands.main)],
      ["security", report("security", commands.security)],
      ["fault", report("fault", commands.fault)],
    ]);
    reports.set(
      changedSuite,
      report(changedSuite, commands[changedSuite as keyof typeof commands], overrides),
    );
    expect(() => assertCanonicalSuiteReports(reports, commands, COMMIT_A)).toThrow(
      ReleaseEvidenceError,
    );
  });
});

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function commitFile(root: string, path: string, content: string, message: string): string {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
  git(root, ["add", path]);
  git(root, ["commit", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-release-evidence-"));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Harness Test"]);
  git(root, ["config", "user.email", "harness@test.invalid"]);
  return root;
}

describe("tracked Evidence and report commit", () => {
  it("digests bytes from git show instead of the mutable worktree", () => {
    const root = repository();
    const implementation = commitFile(root, "proof.txt", "committed\n", "implementation");
    writeFileSync(join(root, "proof.txt"), "dirty worktree\n", "utf8");
    const expected = createHash("sha256")
      .update("proof.txt")
      .update("\0")
      .update("committed\n")
      .update("\0")
      .digest("hex");
    expect(digestTrackedEvidence(root, implementation, ["proof.txt"])).toBe(expected);
  });

  it("accepts only a direct pure-document successor of the implementation", () => {
    const root = repository();
    const implementation = commitFile(root, "src/app.ts", "export {};\n", "implementation");
    const sidecar = {
      schema_version: "harness.m4-acceptance-results/1",
      implementation_commit: implementation,
      suite_invocation_ids: completeInvocationIds(),
      dogfood_summary: { present: false },
      results: completeResults(),
    };
    commitFile(
      root,
      "docs/evidence/m4-local-multi-agent-scheduling-results.json",
      `${JSON.stringify(sidecar)}\n`,
      "report",
    );
    writeFileSync(
      join(root, "docs/evidence/m4-local-multi-agent-scheduling-completion.md"),
      renderM4Markdown(sidecar),
      "utf8",
    );
    git(root, ["add", "docs/evidence/m4-local-multi-agent-scheduling-completion.md"]);
    git(root, ["commit", "--amend", "--no-edit"]);
    expect(verifyM4ReportCommit(root)).toMatchObject({ implementation_commit: implementation });

    commitFile(root, "src/drift.ts", "export {};\n", "not pure docs");
    expect(() => verifyM4ReportCommit(root)).toThrow(ReleaseEvidenceError);
  });
});

describe("M4 Markdown projection", () => {
  it("renders rows only from the typed sidecar", () => {
    const sidecar = {
      schema_version: "harness.m4-acceptance-results/1",
      implementation_commit: COMMIT_A,
      generated_at: "2026-09-02T00:00:00.000Z",
      results: [
        {
          acceptance_id: "AC-01",
          statement: "typed proof",
          status: "passed",
          required_suites: ["main"],
          suite_invocation_ids: { main: "inv-main" },
          commands: ["pnpm test"],
          evidence: ["proof.txt"],
          evidence_digest: "1".repeat(64),
          design_section: "§24",
          detail: "verified",
        },
      ],
    };
    const markdown = renderM4Markdown(sidecar);
    expect(markdown).toContain("| AC-01 | typed proof |");
    expect(markdown).toContain("`inv-main`");
    expect(markdown).not.toContain("hand-entered");
  });
});

describe("release command", () => {
  it("runs the full main suite before specialized release suites", () => {
    const packageJson = JSON.parse(
      readFileSync(
        join(dirname(new URL(import.meta.url).pathname), "..", "..", "package.json"),
        "utf8",
      ),
    ) as { scripts: { "test:release": string } };
    expect(packageJson.scripts["test:release"]).toMatch(/^pnpm test && pnpm test:security/u);
  });
});
