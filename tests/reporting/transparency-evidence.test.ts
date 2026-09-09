import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CANONICAL_RELEASE_COMMANDS } from "../../scripts/lib/m4-release-evidence.mjs";
import {
  M4_RELEASE_REPORT_PATH,
  TRANSPARENCY_ACCEPTANCE_REGISTRY,
  TRANSPARENCY_DOGFOOD_COMMAND,
  TRANSPARENCY_DOGFOOD_REPORT_PATH,
  TRANSPARENCY_DOGFOOD_SCHEMA_VERSION,
  TRANSPARENCY_DESIGN_PATH,
  TransparencyEvidenceError,
  assertTransparencyAcceptanceSidecar,
  buildTransparencyAcceptanceSidecar,
  renderTransparencyMarkdown,
  transparencyTrackedEvidencePaths,
  verifyTransparencyEvidence,
} from "../../scripts/lib/transparency-evidence.mjs";

const GENERATED_AT = "2026-09-08T00:00:00.000Z";

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
  const root = mkdtempSync(join(tmpdir(), "harness-transparency-evidence-"));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Harness Test"]);
  git(root, ["config", "user.email", "harness@test.invalid"]);
  return root;
}

const COVERAGE_TABLE_PATH = "docs/evidence/artifact-reference-coverage.md";
const PERFORMANCE_EVIDENCE_PATH = "docs/evidence/2026-09-08-event-stream-perf.json";

const ARTIFACT_KINDS = [
  "approval_decision",
  "prd",
  "design_set",
  "plan",
  "context_manifest",
  "run_summary",
  "gate_result",
  "evidence",
  "evaluation",
  "snapshot",
  "tdd_artifact",
  "finding_group",
  "wave_result",
  "integration_record",
  "task_lease",
] as const;

function performanceEvidence(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: "event-stream-incremental-performance",
    method: { seed: 1, warmup_rounds: 20, sample_rounds: 200 },
    scenarios: [
      { name: "f-layout-discovery-poll", p95_ms: 100, threshold_ms: 200 },
      { name: "e-layout-index-rss", rss_delta_mib: 14, threshold_mib: 256 },
      { name: "warm-poll-zero-history-reread", read_file_sync_calls: 0 },
      {
        name: "shared-scan-4-caught-up-clients",
        source_refreshes_one_client: 30,
        source_refreshes_four_clients: 30,
      },
    ],
    ...overrides,
  });
}

function coverageTable(): string {
  return ["# SSE 产出引用盘点", "", ...ARTIFACT_KINDS.map((kind) => `| ${kind} | ok |`), ""].join(
    "\n",
  );
}

function evidenceBaseline(root: string): string {
  for (const path of transparencyTrackedEvidencePaths()) {
    const content =
      path === PERFORMANCE_EVIDENCE_PATH
        ? performanceEvidence()
        : path === COVERAGE_TABLE_PATH
          ? coverageTable()
          : `proof for ${path}\n`;
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "implementation"]);
  return git(root, ["rev-parse", "HEAD"]);
}

interface ReportOptions {
  failFile?: string;
  staleCommit?: string;
}

function suiteReport(
  suite: string,
  root: string,
  implementationCommit: string,
  files: readonly string[],
  options: ReportOptions = {},
): Record<string, unknown> {
  const fileEntries = files.map((path) => ({
    path,
    state: path === options.failFile ? "fail" : "pass",
  }));
  const commit = options.staleCommit ?? implementationCommit;
  return {
    schema_version: "harness.acceptance-suite-report/1",
    implementation_commit: commit,
    started_commit: commit,
    finished_commit: commit,
    tracked_worktree_clean_at_start: true,
    tracked_worktree_clean_at_finish: true,
    tracked_worktree_clean: true,
    invocation_id: `inv-${suite}`,
    suite,
    command: CANONICAL_RELEASE_COMMANDS[suite as keyof typeof CANONICAL_RELEASE_COMMANDS],
    coverage: "full",
    config_path:
      suite === "performance"
        ? resolve(root, "vitest.performance.ts")
        : suite === "playwright-dashboard"
          ? resolve(root, "playwright.dashboard.config.ts")
          : resolve(root, "vitest.workspace.ts"),
    files_total: fileEntries.length,
    files_failed: fileEntries.filter((file) => file.state === "fail").length,
    failed_files: fileEntries.filter((file) => file.state === "fail").map((file) => file.path),
    files: fileEntries,
  };
}

function transparencySuiteReports(
  root: string,
  implementationCommit: string,
  options: ReportOptions & { omitSuite?: string } = {},
): Map<string, object> {
  const filesBySuite = new Map<string, Set<string>>();
  for (const entry of TRANSPARENCY_ACCEPTANCE_REGISTRY) {
    if (entry.proof.kind !== "suite") continue;
    for (const [suite, files] of Object.entries(entry.proof.suites)) {
      const bucket = filesBySuite.get(suite) ?? new Set<string>();
      for (const file of files as readonly string[]) bucket.add(file);
      filesBySuite.set(suite, bucket);
    }
  }
  const reports = new Map<string, object>();
  for (const [suite, files] of filesBySuite) {
    if (suite === options.omitSuite) continue;
    reports.set(suite, suiteReport(suite, root, implementationCommit, [...files], options));
  }
  return reports;
}

function releaseReport(implementationCommit: string): string {
  return JSON.stringify({
    schema_version: "harness.m4-acceptance-results/1",
    implementation_commit: implementationCommit,
    results: Array.from({ length: 20 }, (_, index) => ({
      acceptance_id: `AC-${String(index + 1).padStart(2, "0")}`,
      status: "passed",
      evidence_digest: "1".repeat(64),
    })),
  });
}

function dogfoodReport(
  implementationCommit: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schema_version: TRANSPARENCY_DOGFOOD_SCHEMA_VERSION,
    implementation_commit: implementationCommit,
    command: TRANSPARENCY_DOGFOOD_COMMAND,
    exit_code: 0,
    status: "passed",
    steady_state: {
      samples: Array.from({ length: 30 }, (_, index) => ({ latency_ms: 100 + index })),
      p50_ms: 120,
      p95_ms: 500,
      max_ms: 700,
      within_budget: true,
    },
    ...overrides,
  });
}

function worktreeReader(files: Readonly<Record<string, string>>) {
  return (path: string): Buffer | undefined => {
    const content = files[path];
    return content === undefined ? undefined : Buffer.from(content, "utf8");
  };
}

function genuineWorktree(implementationCommit: string): Record<string, string> {
  return {
    [M4_RELEASE_REPORT_PATH]: releaseReport(implementationCommit),
    [TRANSPARENCY_DOGFOOD_REPORT_PATH]: dogfoodReport(implementationCommit),
  };
}

function genuineContext(root: string, implementationCommit: string) {
  return {
    repositoryRoot: root,
    implementationCommit,
    suiteReports: transparencySuiteReports(root, implementationCommit),
    readWorktreeBytes: worktreeReader(genuineWorktree(implementationCommit)),
  };
}

describe("transparency acceptance registry", () => {
  it("freezes exactly HT-AC-01..07 in order without duplicates", () => {
    const expectedIds = [
      "HT-AC-01",
      "HT-AC-02",
      "HT-AC-03",
      "HT-AC-04",
      "HT-AC-05",
      "HT-AC-06",
      "HT-AC-07",
    ];
    expect(TRANSPARENCY_ACCEPTANCE_REGISTRY.map((entry) => entry.acceptance_id)).toEqual(
      expectedIds,
    );
    expect(Object.isFrozen(TRANSPARENCY_ACCEPTANCE_REGISTRY)).toBe(true);
    for (const entry of TRANSPARENCY_ACCEPTANCE_REGISTRY) {
      expect(entry.design_anchor).toBe("§11");
      expect(entry.tasks.length).toBeGreaterThan(0);
    }
  });

  it("quotes every acceptance statement verbatim from the design §11 table", () => {
    const spec = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", TRANSPARENCY_DESIGN_PATH),
      "utf8",
    );
    for (const entry of TRANSPARENCY_ACCEPTANCE_REGISTRY) {
      expect(spec).toContain(entry.statement);
    }
  });
});

describe("transparency evidence derivation", () => {
  it("passes all seven items on genuine evidence and round-trips verification", () => {
    const root = repository();
    const implementation = evidenceBaseline(root);
    const context = genuineContext(root, implementation);
    const sidecar = buildTransparencyAcceptanceSidecar({ ...context, generatedAt: GENERATED_AT });
    expect(sidecar.results.map((entry) => entry.acceptance_id)).toEqual([
      "HT-AC-01",
      "HT-AC-02",
      "HT-AC-03",
      "HT-AC-04",
      "HT-AC-05",
      "HT-AC-06",
      "HT-AC-07",
    ]);
    expect(sidecar.implementation_commit).toBe(implementation);
    expect(sidecar.results.every((entry) => entry.status === "passed")).toBe(true);
    const verified = verifyTransparencyEvidence({
      ...context,
      sidecar,
      markdown: renderTransparencyMarkdown(sidecar),
    });
    expect(verified.implementation_commit).toBe(implementation);
  }, 20_000);

  it("reports not_run when a canonical suite report is missing", () => {
    const root = repository();
    const implementation = evidenceBaseline(root);
    const context = {
      ...genuineContext(root, implementation),
      suiteReports: transparencySuiteReports(root, implementation, { omitSuite: "fault" }),
    };
    const sidecar = buildTransparencyAcceptanceSidecar({ ...context, generatedAt: GENERATED_AT });
    const htac01 = sidecar.results.find((entry) => entry.acceptance_id === "HT-AC-01");
    expect(htac01?.status).toBe("not_run");
    expect(htac01?.detail).toContain("fault");
    expect(() => verifyTransparencyEvidence({ ...context, sidecar })).toThrow(
      TransparencyEvidenceError,
    );
  }, 20_000);

  it("reports failed when a required test file failed in its canonical suite", () => {
    const root = repository();
    const implementation = evidenceBaseline(root);
    const context = {
      ...genuineContext(root, implementation),
      suiteReports: transparencySuiteReports(root, implementation, {
        failFile: "tests/security/dashboard-artifact-boundaries.test.ts",
      }),
    };
    const sidecar = buildTransparencyAcceptanceSidecar({ ...context, generatedAt: GENERATED_AT });
    const htac04 = sidecar.results.find((entry) => entry.acceptance_id === "HT-AC-04");
    expect(htac04?.status).toBe("failed");
  }, 20_000);

  it("rejects evidence bound to the wrong implementation SHA", () => {
    const root = repository();
    const implementation = evidenceBaseline(root);
    const stale = "0".repeat(40);
    const context = {
      ...genuineContext(root, implementation),
      suiteReports: transparencySuiteReports(root, implementation, { staleCommit: stale }),
    };
    const sidecar = buildTransparencyAcceptanceSidecar({ ...context, generatedAt: GENERATED_AT });
    expect(sidecar.results.some((entry) => entry.status === "failed")).toBe(true);
    expect(() => verifyTransparencyEvidence({ ...context, sidecar })).toThrow(
      TransparencyEvidenceError,
    );
  }, 20_000);

  it("rejects tracked evidence changed after the implementation commit", () => {
    const root = repository();
    const implementation = evidenceBaseline(root);
    const context = genuineContext(root, implementation);
    const sidecar = buildTransparencyAcceptanceSidecar({ ...context, generatedAt: GENERATED_AT });
    commitFile(
      root,
      "packages/conformance/test/event-stream.conformance.test.ts",
      "rewritten after the fact\n",
      "tamper",
    );
    expect(() => verifyTransparencyEvidence({ ...context, sidecar })).toThrow(
      /changed after the implementation commit/u,
    );
  }, 20_000);

  it("rejects a dirty tracked evidence file in the worktree", () => {
    const root = repository();
    const implementation = evidenceBaseline(root);
    const context = genuineContext(root, implementation);
    const sidecar = buildTransparencyAcceptanceSidecar({ ...context, generatedAt: GENERATED_AT });
    writeFileSync(
      join(root, "docs/evidence/artifact-reference-coverage.md"),
      "dirty edit\n",
      "utf8",
    );
    expect(() => verifyTransparencyEvidence({ ...context, sidecar })).toThrow(
      /dirty in the worktree/u,
    );
  }, 20_000);

  it("rejects a hand-greened sidecar that source evidence cannot reproduce", () => {
    const root = repository();
    const implementation = evidenceBaseline(root);
    const sidecar = buildTransparencyAcceptanceSidecar({
      ...genuineContext(root, implementation),
      generatedAt: GENERATED_AT,
    });
    const degradedContext = {
      ...genuineContext(root, implementation),
      suiteReports: transparencySuiteReports(root, implementation, { omitSuite: "security" }),
    };
    expect(() => verifyTransparencyEvidence({ ...degradedContext, sidecar })).toThrow(
      /does not match re-derived source evidence/u,
    );
  }, 20_000);

  it("rejects duplicate acceptance ids", () => {
    const root = repository();
    const implementation = evidenceBaseline(root);
    const sidecar = buildTransparencyAcceptanceSidecar({
      ...genuineContext(root, implementation),
      generatedAt: GENERATED_AT,
    });
    const tampered = JSON.parse(JSON.stringify(sidecar)) as typeof sidecar;
    tampered.results[6] = tampered.results[0]!;
    expect(() => assertTransparencyAcceptanceSidecar(tampered)).toThrow(/duplicate/u);
  }, 20_000);

  it("rejects a Markdown file that is not the exact sidecar projection", () => {
    const root = repository();
    const implementation = evidenceBaseline(root);
    const context = genuineContext(root, implementation);
    const sidecar = buildTransparencyAcceptanceSidecar({ ...context, generatedAt: GENERATED_AT });
    expect(() =>
      verifyTransparencyEvidence({ ...context, sidecar, markdown: "# hand-written\n" }),
    ).toThrow(/Markdown is not the exact typed-sidecar projection/u);
  }, 20_000);

  it("fails HT-AC-05 when a recorded performance scenario exceeds its budget", () => {
    const root = repository();
    for (const path of transparencyTrackedEvidencePaths()) {
      const content =
        path === PERFORMANCE_EVIDENCE_PATH
          ? performanceEvidence({
              scenarios: [
                { name: "f-layout-discovery-poll", p95_ms: 500, threshold_ms: 200 },
                { name: "e-layout-index-rss", rss_delta_mib: 14, threshold_mib: 256 },
                { name: "warm-poll-zero-history-reread", read_file_sync_calls: 0 },
                { name: "shared-scan-4-caught-up-clients" },
              ],
            })
          : path === COVERAGE_TABLE_PATH
            ? coverageTable()
            : `proof for ${path}\n`;
      const absolute = join(root, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content, "utf8");
    }
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "implementation"]);
    const implementation = git(root, ["rev-parse", "HEAD"]);
    const sidecar = buildTransparencyAcceptanceSidecar({
      ...genuineContext(root, implementation),
      generatedAt: GENERATED_AT,
    });
    const htac05 = sidecar.results.find((entry) => entry.acceptance_id === "HT-AC-05");
    expect(htac05?.status).toBe("failed");
    expect(htac05?.detail).toContain("p95");
  }, 20_000);

  it.each([
    [
      "fewer than 30 real decisions",
      {
        steady_state: {
          samples: [{ latency_ms: 1 }],
          p95_ms: 500,
          within_budget: true,
        },
      },
      /fewer than 30/u,
    ],
    [
      "a steady-state p95 beyond the 1s budget",
      {
        steady_state: {
          samples: Array.from({ length: 30 }, () => ({ latency_ms: 1 })),
          p95_ms: 1000,
          within_budget: false,
        },
      },
      /1s budget/u,
    ],
    ["a non-zero dogfood exit code", { exit_code: 1, status: "failed" }, /failed dogfood run/u],
  ])(
    "fails HT-AC-07 on %s",
    (_name, dogfoodOverrides, pattern) => {
      const root = repository();
      const implementation = evidenceBaseline(root);
      const context = {
        ...genuineContext(root, implementation),
        readWorktreeBytes: worktreeReader({
          [M4_RELEASE_REPORT_PATH]: releaseReport(implementation),
          [TRANSPARENCY_DOGFOOD_REPORT_PATH]: dogfoodReport(
            implementation,
            dogfoodOverrides as Record<string, unknown>,
          ),
        }),
      };
      const sidecar = buildTransparencyAcceptanceSidecar({ ...context, generatedAt: GENERATED_AT });
      const htac07 = sidecar.results.find((entry) => entry.acceptance_id === "HT-AC-07");
      expect(htac07?.status).toBe("failed");
      expect(htac07?.detail).toMatch(pattern);
    },
    20_000,
  );

  it("reports HT-AC-07 not_run while the full release report is missing", () => {
    const root = repository();
    const implementation = evidenceBaseline(root);
    const context = {
      ...genuineContext(root, implementation),
      readWorktreeBytes: worktreeReader({
        [TRANSPARENCY_DOGFOOD_REPORT_PATH]: dogfoodReport(implementation),
      }),
    };
    const sidecar = buildTransparencyAcceptanceSidecar({ ...context, generatedAt: GENERATED_AT });
    const htac07 = sidecar.results.find((entry) => entry.acceptance_id === "HT-AC-07");
    expect(htac07?.status).toBe("not_run");
    expect(htac07?.detail).toContain("test:release");
  }, 20_000);
});

describe("transparency release command", () => {
  it("exposes pnpm verify:transparency as the mechanical gate", () => {
    const packageJson = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"),
        "utf8",
      ),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts["verify:transparency"]).toBe(
      "node scripts/verify-transparency-evidence.mjs",
    );
  });
});
