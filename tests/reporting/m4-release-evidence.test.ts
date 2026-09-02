import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ReleaseEvidenceError,
  M4_ACCEPTANCE_REGISTRY,
  assertM4AcceptanceSidecar,
  assertCanonicalSuiteReports,
  buildM4AcceptanceSidecar,
  buildCanonicalSuiteProof,
  CANONICAL_RELEASE_COMMANDS,
  digestCanonicalResult,
  digestTrackedEvidence,
  m4Commands,
  renderM4Markdown,
  verifyM4ReportCommit,
} from "../../scripts/lib/m4-release-evidence.mjs";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

function completeResults(): readonly Record<string, unknown>[] {
  const invocationIds = completeInvocationIds();
  return M4_ACCEPTANCE_REGISTRY.map((entry) => ({
    acceptance_id: entry.acceptance_id,
    statement: entry.statement,
    status: "passed",
    required_suites: entry.required_suites,
    suite_invocation_ids: Object.fromEntries(
      entry.required_suites.map((suite) => [suite, invocationIds[suite]]),
    ),
    commands: m4Commands(entry),
    evidence: entry.evidence,
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
    config_path:
      suite === "performance"
        ? "/repo/vitest.performance.ts"
        : suite === "playwright-dashboard"
          ? "/repo/playwright.dashboard.config.ts"
          : "/repo/vitest.workspace.ts",
    files_total: 1,
    files_failed: 0,
    failed_files: [],
    files: [{ path: `${suite}.test.ts`, state: "pass" }],
    ...overrides,
  };
}

function releaseReports(repositoryRoot: string, implementationCommit: string): Map<string, object> {
  const filesBySuite = new Map<string, Set<string>>(
    Object.keys(CANONICAL_RELEASE_COMMANDS).map((suite) => [suite, new Set()]),
  );
  for (const entry of M4_ACCEPTANCE_REGISTRY) {
    for (const path of entry.evidence) {
      if (path.startsWith("scripts/") || path.startsWith(".reports/")) continue;
      if (path === "tests/e2e/dashboard-m4-scheduler.test.ts") {
        filesBySuite.get("playwright-dashboard")?.add(path);
      } else if (path.startsWith("tests/performance/")) {
        filesBySuite.get("performance")?.add(path);
      } else if (path.startsWith("tests/fault/")) {
        filesBySuite.get("fault")?.add(path);
      } else if (path.startsWith("tests/security/")) {
        filesBySuite.get("security")?.add(path);
      } else {
        filesBySuite.get("main")?.add(path);
        if (path.startsWith("tests/e2e/")) filesBySuite.get("e2e")?.add(path);
      }
    }
  }
  return new Map(
    Object.entries(CANONICAL_RELEASE_COMMANDS).map(([suite, command]) => {
      const files = [...(filesBySuite.get(suite) ?? [])].map((path) => ({ path, state: "pass" }));
      return [
        suite,
        report(suite, command, {
          implementation_commit: implementationCommit,
          started_commit: implementationCommit,
          finished_commit: implementationCommit,
          invocation_id: `inv-${suite}`,
          config_path:
            suite === "performance"
              ? join(repositoryRoot, "vitest.performance.ts")
              : suite === "playwright-dashboard"
                ? join(repositoryRoot, "playwright.dashboard.config.ts")
                : join(repositoryRoot, "vitest.workspace.ts"),
          files,
          files_total: files.length,
        }),
      ];
    }),
  );
}

function blockedDogfood(implementationCommit: string): Record<string, unknown> {
  return {
    schema_version: 1,
    implementation_commit: implementationCommit,
    status: "blocked",
    blocker: "real_adapter_unattended_ineligible",
    provider: "dsh",
    provider_version: "test",
    exit_code: 0,
    requested_task_count: 4,
    requested_wave_count: 3,
    requested_max_concurrency: 2,
    effective_max_concurrency: 1,
    unattended_eligible: false,
    provider_probe: { status: "passed" },
    scheduler_eligibility: { status: "blocked" },
    overlap_proven: false,
    overlap_intervals: [],
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
    expect(assertCanonicalSuiteReports(reports, commands, COMMIT_A, "/repo")).toEqual({
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
    expect(() => assertCanonicalSuiteReports(reports, commands, COMMIT_A, "/repo")).toThrow(
      ReleaseEvidenceError,
    );
  });

  it("digests canonical executed-result payload rather than source names alone", () => {
    const first = buildCanonicalSuiteProof(report("main", "pnpm test"), "/repo");
    const second = buildCanonicalSuiteProof(
      report("main", "pnpm test", {
        invocation_id: "inv-main-2",
        files: [{ path: "main.test.ts", state: "skip" }],
      }),
      "/repo",
    );
    expect(first.config_path).toBe("vitest.workspace.ts");
    expect(digestCanonicalResult(first)).not.toBe(digestCanonicalResult(second));
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

function evidenceBaseline(root: string): string {
  for (const path of new Set(
    M4_ACCEPTANCE_REGISTRY.flatMap((entry) =>
      entry.evidence.filter((candidate) => !candidate.startsWith(".reports/")),
    ),
  )) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, `proof for ${path}\n`, "utf8");
  }
  writeFileSync(join(root, "vitest.workspace.ts"), "export {};\n", "utf8");
  writeFileSync(join(root, "vitest.performance.ts"), "export {};\n", "utf8");
  writeFileSync(join(root, "playwright.dashboard.config.ts"), "export {};\n", "utf8");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "implementation"]);
  return git(root, ["rev-parse", "HEAD"]);
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
    const implementation = evidenceBaseline(root);
    const sidecar = buildM4AcceptanceSidecar({
      repositoryRoot: root,
      implementationCommit: implementation,
      suiteReports: releaseReports(root, implementation),
      dogfood: blockedDogfood(implementation),
      generatedAt: "2026-09-02T00:00:00.000Z",
    });
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
  it("rejects a forged 20/20 sidecar with empty requirements and evidence", () => {
    expect(() =>
      assertM4AcceptanceSidecar(
        {
          schema_version: "harness.m4-acceptance-results/1",
          implementation_commit: COMMIT_A,
          suite_invocation_ids: completeInvocationIds(),
          results: completeResults().map((entry) => ({
            ...entry,
            required_suites: [],
            suite_invocation_ids: {},
            commands: [],
            evidence: [],
          })),
        },
        { requireComplete: true },
      ),
    ).toThrow(ReleaseEvidenceError);
  });

  it("derives formerly hard-coded blockers from persisted suite and dogfood proof", () => {
    const root = repository();
    const implementation = evidenceBaseline(root);
    const reports = releaseReports(root, implementation);
    const blocked = buildM4AcceptanceSidecar({
      repositoryRoot: root,
      implementationCommit: implementation,
      suiteReports: reports,
      dogfood: blockedDogfood(implementation),
      generatedAt: "2026-09-02T00:00:00.000Z",
    });
    expect(blocked.results.find((entry) => entry.acceptance_id === "AC-16")?.status).toBe("passed");
    expect(blocked.results.find((entry) => entry.acceptance_id === "AC-17")?.status).toBe("passed");
    expect(blocked.results.find((entry) => entry.acceptance_id === "AC-06")?.status).toBe(
      "blocked",
    );
    expect(blocked.results.find((entry) => entry.acceptance_id === "AC-20")?.status).toBe(
      "blocked",
    );

    const completed = buildM4AcceptanceSidecar({
      repositoryRoot: root,
      implementationCommit: implementation,
      suiteReports: reports,
      dogfood: {
        ...blockedDogfood(implementation),
        status: "passed",
        blocker: null,
        effective_max_concurrency: 2,
        unattended_eligible: true,
        overlap_proven: true,
        overlap_intervals: [{ task_id: "a" }, { task_id: "b" }],
        gate_status: "passed",
        evaluation_status: "passed",
        snapshot_status: "completed",
        wave_integration_count: 3,
      },
      generatedAt: "2026-09-02T00:00:00.000Z",
    });
    expect(completed.results.find((entry) => entry.acceptance_id === "AC-06")?.status).toBe(
      "passed",
    );
    expect(completed.results.find((entry) => entry.acceptance_id === "AC-20")?.status).toBe(
      "passed",
    );
  });

  it("rejects tampering with persisted canonical result digests", () => {
    const root = repository();
    const implementation = evidenceBaseline(root);
    const sidecar = buildM4AcceptanceSidecar({
      repositoryRoot: root,
      implementationCommit: implementation,
      suiteReports: releaseReports(root, implementation),
      dogfood: blockedDogfood(implementation),
      generatedAt: "2026-09-02T00:00:00.000Z",
    });
    const tampered = JSON.parse(JSON.stringify(sidecar)) as typeof sidecar;
    tampered.suite_results.main.invocation_id = "forged";
    expect(() => assertM4AcceptanceSidecar(tampered, { requireComplete: true })).toThrow(
      ReleaseEvidenceError,
    );
  });

  it("renders rows only from the typed sidecar", () => {
    const entry = M4_ACCEPTANCE_REGISTRY[0];
    const sidecar = {
      schema_version: "harness.m4-acceptance-results/1",
      implementation_commit: COMMIT_A,
      generated_at: "2026-09-02T00:00:00.000Z",
      results: [
        {
          acceptance_id: "AC-01",
          statement: entry.statement,
          status: "passed",
          required_suites: ["main"],
          suite_invocation_ids: { main: "inv-main" },
          commands: m4Commands(entry),
          evidence: entry.evidence,
          evidence_digest: "1".repeat(64),
          design_section: "§24",
          detail: "verified",
        },
      ],
    };
    const markdown = renderM4Markdown(sidecar);
    expect(markdown).toContain(`| AC-01 | ${entry.statement} |`);
    expect(markdown).toContain("`inv-main`");
    expect(markdown).not.toContain("hand-entered");
  });
});

describe("release command", () => {
  it("runs verify and the executable M4 fault matrix without repeating the main suite", () => {
    const packageJson = JSON.parse(
      readFileSync(
        join(dirname(new URL(import.meta.url).pathname), "..", "..", "package.json"),
        "utf8",
      ),
    ) as { scripts: { "test:release": string } };
    expect(packageJson.scripts["test:release"]).toMatch(/^pnpm verify && pnpm test:security/u);
    expect(packageJson.scripts["test:release"]).toContain("pnpm test:m4:fault-matrix");
    expect(packageJson.scripts["test:release"]).not.toContain("pnpm verify && pnpm test &&");
  });
});
