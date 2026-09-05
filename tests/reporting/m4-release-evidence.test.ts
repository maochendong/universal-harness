import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ReleaseEvidenceError,
  M4_ACCEPTANCE_REGISTRY,
  assertM4AcceptanceSidecar,
  assertCanonicalSuiteReports,
  buildCanonicalDogfoodProof,
  buildM4AcceptanceSidecar,
  buildCanonicalSuiteProof,
  CANONICAL_RELEASE_COMMANDS,
  digestCanonicalResult,
  digestTrackedEvidence,
  isM4ReportCommit,
  m4Commands,
  renderM4Markdown,
  verifyM4ReportCommit,
} from "../../scripts/lib/m4-release-evidence.mjs";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
// The fake repository root is POSIX-shaped; resolve() renders the platform's
// canonical form so fixtures match production expectations on Windows too.
const FAKE_REPOSITORY_ROOT = "/repo";
// Synthetic user paths are assembled at runtime so the standalone scan does
// not mistake them for real machine paths; release-safe text validation must
// still recognize the resulting value.
const SYNTHETIC_USERS = ["", "Users"].join("/");
const PRIVATE_REPOSITORY = `${SYNTHETIC_USERS}/private/repository`;

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
        ? resolve(FAKE_REPOSITORY_ROOT, "vitest.performance.ts")
        : suite === "playwright-dashboard"
          ? resolve(FAKE_REPOSITORY_ROOT, "playwright.dashboard.config.ts")
          : resolve(FAKE_REPOSITORY_ROOT, "vitest.workspace.ts"),
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

function addPassingReadinessTests(reports: Map<string, object>): void {
  const additions = {
    e2e: [
      "tests/e2e/m4-production-policy-source.test.ts",
      "tests/e2e/m4-live-driver-approval.test.ts",
    ],
    "playwright-dashboard": ["tests/e2e/dashboard-m4-governed-controls.test.ts"],
  } as const;
  for (const [suite, paths] of Object.entries(additions)) {
    const current = reports.get(suite) as { files: Array<{ path: string; state: string }> };
    current.files.push(...paths.map((path) => ({ path, state: "pass" })));
    Object.assign(current, { files_total: current.files.length });
  }
}

function blockedDogfood(implementationCommit: string): Record<string, unknown> {
  return {
    schema_version: 1,
    implementation_commit: implementationCommit,
    status: "blocked",
    blocker: "real_adapter_unattended_ineligible",
    provider: "dsh",
    provider_profile: "headless",
    provider_backend: "deepseek-official",
    provider_model: "deepseek-v4-flash",
    provider_model_source: "dsh_session_request_context_and_assistant_source",
    requested_provider_model: "deepseek-v4-flash",
    requested_provider_model_source: "project_dotenv_injected_process_env",
    requested_provider_model_matches_observed: true,
    expected_provider_version: "0.1.0-rc.6",
    expected_provider_version_source: "cli_argument",
    observed_provider_version: "0.1.0-rc.6",
    credential_source: "project_dotenv_injected_process_env",
    credential_material_recorded: false,
    credential_material_hashed: false,
    exit_code: 0,
    adapter_manifest_digest: "7".repeat(64),
    build_provenance: {
      implementation_commit: implementationCommit,
      source_head: implementationCommit,
      source_head_matches_implementation_commit: true,
      tracked_source_clean: true,
      build_command: "pnpm build",
      clean_rebuild_from_committed_archive: true,
      root_package_json_sha256: "3".repeat(64),
      lockfile_sha256: "4".repeat(64),
      runtime_dependency_closure: ["universal-harness"],
      packages: [{ name: "universal-harness", path: "packages/cli" }],
      external_runtime_dependencies: [{ name: "ajv", version: "8.20.0" }],
      provenance_sha256: "5".repeat(64),
    },
    requested_task_count: 4,
    requested_wave_count: 3,
    requested_max_concurrency: 2,
    effective_max_concurrency: 1,
    unattended_eligible: false,
    eligibility_reasons: ["external provider is not eligible for unattended execution"],
    provider_probe: {
      verification_status: "verified",
      task_id: "task_real_dsh_probe",
      agent_outcome_claim: "handoff",
      termination_reason: "completion",
      verification: {
        status: "passed",
        output_exists: true,
        output_regular_file: true,
        output_realpath_contained: true,
        exact_bytes_match: true,
        only_allowed_path_changed: true,
        unauthorized_paths: [],
      },
    },
    scheduler_eligibility: { status: "blocked" },
    adapter_reported_usage: {
      metering: "unmetered",
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
    },
    dsh_session_observation: {
      source: "dsh_local_zstd_session",
      session_sha256: "8".repeat(64),
      raw_session_persisted_in_release_bundle: false,
      usage: {
        metering: "dsh_session_observed",
        model_call_count: 2,
        input_tokens: 110,
        cache_read_input_tokens: 130,
        output_tokens: 24,
        reasoning_tokens: 6,
        total_tokens: 264,
      },
    },
    supervised_probe: {
      task_id: "task_real_dsh_probe",
      outcome: "handoff",
      termination_reason: "completion",
      output_exists: true,
      exact_bytes_match: true,
      only_allowed_path_changed: true,
      changed_paths: ["src/dogfood/probe.ts"],
      evidence: [{ kind: "diff", digest: "6".repeat(64) }],
      duration_ms: 1234,
    },
    overlap_proven: false,
    overlap_intervals: [],
    raw_transcript_persisted_in_release_bundle: false,
    command_executable_basename: "dsh",
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
    expect(assertCanonicalSuiteReports(reports, commands, COMMIT_A, FAKE_REPOSITORY_ROOT)).toEqual({
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
    expect(() =>
      assertCanonicalSuiteReports(reports, commands, COMMIT_A, FAKE_REPOSITORY_ROOT),
    ).toThrow(ReleaseEvidenceError);
  });

  it("digests canonical executed-result payload rather than source names alone", () => {
    const first = buildCanonicalSuiteProof(report("main", "pnpm test"), FAKE_REPOSITORY_ROOT);
    const second = buildCanonicalSuiteProof(
      report("main", "pnpm test", {
        invocation_id: "inv-main-2",
        files: [{ path: "main.test.ts", state: "skip" }],
      }),
      FAKE_REPOSITORY_ROOT,
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

function evidenceBaseline(root: string, options: { readinessTests?: boolean } = {}): string {
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
  if (options.readinessTests === true) {
    for (const path of [
      "tests/e2e/m4-production-policy-source.test.ts",
      "tests/e2e/dashboard-m4-governed-controls.test.ts",
      "tests/e2e/m4-live-driver-approval.test.ts",
    ]) {
      const absolute = join(root, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, `black-box proof for ${path}\n`, "utf8");
    }
  }
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

  it("accepts only a direct pure-document successor with real tracked Evidence", () => {
    const root = repository();
    const implementation = evidenceBaseline(root, { readinessTests: true });
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
    expect(isM4ReportCommit(root)).toBe(true);
    expect(verifyM4ReportCommit(root)).toMatchObject({ implementation_commit: implementation });

    const tampered = JSON.parse(JSON.stringify(sidecar)) as typeof sidecar;
    const first = tampered.results[0];
    first.tracked_evidence_digest = "2".repeat(64);
    first.evidence_digest = digestCanonicalResult({
      acceptance_id: first.acceptance_id,
      tracked_evidence_digest: first.tracked_evidence_digest,
      suite_result_digests: first.suite_result_digests,
      dogfood_result_digest: first.dogfood_result_digest ?? null,
    });
    writeFileSync(
      join(root, "docs/evidence/m4-local-multi-agent-scheduling-results.json"),
      `${JSON.stringify(tampered)}\n`,
      "utf8",
    );
    writeFileSync(
      join(root, "docs/evidence/m4-local-multi-agent-scheduling-completion.md"),
      renderM4Markdown(tampered),
      "utf8",
    );
    git(root, ["add", "docs/evidence"]);
    git(root, ["commit", "--amend", "--no-edit"]);
    expect(() => verifyM4ReportCommit(root)).toThrow(/tracked Evidence does not match/u);

    writeFileSync(
      join(root, "docs/evidence/m4-local-multi-agent-scheduling-results.json"),
      `${JSON.stringify(sidecar)}\n`,
      "utf8",
    );
    writeFileSync(
      join(root, "docs/evidence/m4-local-multi-agent-scheduling-completion.md"),
      renderM4Markdown(sidecar),
      "utf8",
    );
    git(root, ["add", "docs/evidence"]);
    git(root, ["commit", "--amend", "--no-edit"]);
    commitFile(root, "src/drift.ts", "export {};\n", "not pure docs");
    expect(isM4ReportCommit(root)).toBe(false);
    expect(() => verifyM4ReportCommit(root)).toThrow(ReleaseEvidenceError);
  }, 20_000);
});

describe("M4 Markdown projection", () => {
  it("projects the frozen dogfood proof without credentials or machine paths", () => {
    const source = {
      ...blockedDogfood(COMMIT_A),
      feature_readiness: {
        production_policy_source: "verified",
        dashboard_provider_context: "verified",
        dashboard_policy_proposal: "verified",
        approval_live_driver_auto_wake: "verified",
      },
      api_key: "sk-must-not-survive",
      credential_material_hash: "secret-hash-must-not-survive",
      repository_root: PRIVATE_REPOSITORY,
    };
    const proof = buildCanonicalDogfoodProof(source, COMMIT_A);

    expect(proof).toMatchObject({
      expected_provider_version: "0.1.0-rc.6",
      observed_provider_version: "0.1.0-rc.6",
      provider_profile: "headless",
      provider_backend: "deepseek-official",
      provider_model: "deepseek-v4-flash",
      provider_model_source: "dsh_session_request_context_and_assistant_source",
      requested_provider_model: "deepseek-v4-flash",
      requested_provider_model_source: "project_dotenv_injected_process_env",
      requested_provider_model_matches_observed: true,
      credential_source: "project_dotenv_injected_process_env",
      credential_material_recorded: false,
      credential_material_hashed: false,
      adapter_reported_usage: {
        metering: "unmetered",
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
      },
      dsh_session_observation: {
        source: "dsh_local_zstd_session",
        session_sha256: "8".repeat(64),
        raw_session_persisted_in_release_bundle: false,
        usage: {
          metering: "dsh_session_observed",
          model_call_count: 2,
          input_tokens: 110,
          cache_read_input_tokens: 130,
          output_tokens: 24,
          reasoning_tokens: 6,
          total_tokens: 264,
        },
      },
      provider_probe: { verification_status: "verified" },
      build_provenance: {
        implementation_commit: COMMIT_A,
        source_head_matches_implementation_commit: true,
        tracked_source_clean: true,
        clean_rebuild_from_committed_archive: true,
        runtime_dependency_closure: ["universal-harness"],
        package_count: 1,
        external_runtime_dependency_count: 1,
      },
    });
    const serialized = JSON.stringify(proof);
    expect(serialized).not.toContain("sk-must-not-survive");
    expect(serialized).not.toContain("secret-hash-must-not-survive");
    expect(serialized).not.toContain(PRIVATE_REPOSITORY);
    expect(proof).not.toHaveProperty("provider_version");
    expect(proof).not.toHaveProperty("feature_readiness");
  });

  it("rejects dogfood that recorded or hashed credential material", () => {
    expect(() =>
      buildCanonicalDogfoodProof(
        { ...blockedDogfood(COMMIT_A), credential_material_hashed: true },
        COMMIT_A,
      ),
    ).toThrow(ReleaseEvidenceError);
    expect(() =>
      buildCanonicalDogfoodProof(
        {
          ...blockedDogfood(COMMIT_A),
          provider_model: `error at ${SYNTHETIC_USERS}/private/model`,
        },
        COMMIT_A,
      ),
    ).toThrow(/absolute path/u);
  });

  it.each([
    ["embedded POSIX path", `model error x,${SYNTHETIC_USERS}/private/model`],
    ["labelled POSIX path", `model error path:${SYNTHETIC_USERS}/private/model`],
    ["prefixed POSIX path", `model error x${SYNTHETIC_USERS}/private/model`],
    ["prefixed arbitrary POSIX path", "model error x/workspace/project/file"],
    ["backtick POSIX path", "model error `/workspace/project/file`"],
    ["semicolon POSIX path", "model error;/mnt/data/file"],
    ["bracketed Windows path", String.raw`model error [C:\private\model]`],
    ["UNC path", String.raw`model error \\server\share\model`],
  ])("rejects %s in release-safe text", (_name, providerModel) => {
    expect(() =>
      buildCanonicalDogfoodProof(
        {
          ...blockedDogfood(COMMIT_A),
          provider_model: providerModel,
          requested_provider_model: providerModel,
        },
        COMMIT_A,
      ),
    ).toThrow(/absolute path/u);
  });

  it("allows a URL in release-safe text", () => {
    expect(() =>
      buildCanonicalDogfoodProof(
        {
          ...blockedDogfood(COMMIT_A),
          provider_model: `https://models.example.invalid/path/C:/model?redirect=${SYNTHETIC_USERS}/private#C:/temp`,
          requested_provider_model: `https://models.example.invalid/path/C:/model?redirect=${SYNTHETIC_USERS}/private#C:/temp`,
        },
        COMMIT_A,
      ),
    ).not.toThrow();
  });

  it("allows a requested/observed model mismatch only as its exact blocked result", () => {
    const mismatch = {
      ...blockedDogfood(COMMIT_A),
      requested_provider_model: "deepseek-v4-pro",
      requested_provider_model_matches_observed: false,
    };
    expect(() =>
      buildCanonicalDogfoodProof({ ...mismatch, status: "passed", blocker: null }, COMMIT_A),
    ).toThrow(/model contract mismatch/u);
    expect(() => buildCanonicalDogfoodProof(mismatch, COMMIT_A)).toThrow(
      /model contract mismatch/u,
    );
    expect(() =>
      buildCanonicalDogfoodProof(
        { ...mismatch, blocker: "provider_model_contract_mismatch" },
        COMMIT_A,
      ),
    ).not.toThrow();
  });

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
    const implementation = evidenceBaseline(root, { readinessTests: true });
    const reports = releaseReports(root, implementation);
    const blocked = buildM4AcceptanceSidecar({
      repositoryRoot: root,
      implementationCommit: implementation,
      suiteReports: reports,
      dogfood: blockedDogfood(implementation),
      generatedAt: "2026-09-02T00:00:00.000Z",
    });
    expect(blocked.results.find((entry) => entry.acceptance_id === "AC-10")?.status).toBe(
      "blocked",
    );
    expect(blocked.results.find((entry) => entry.acceptance_id === "AC-16")?.status).toBe(
      "blocked",
    );
    expect(blocked.results.find((entry) => entry.acceptance_id === "AC-17")?.status).toBe(
      "blocked",
    );
    expect(blocked.results.find((entry) => entry.acceptance_id === "AC-06")?.status).toBe(
      "blocked",
    );
    expect(blocked.results.find((entry) => entry.acceptance_id === "AC-20")?.status).toBe(
      "blocked",
    );

    const dogfoodCompleted = {
      ...blockedDogfood(implementation),
      status: "passed",
      blocker: null,
      effective_max_concurrency: 2,
      unattended_eligible: true,
      scheduler_eligibility: { status: "eligible", unattended_eligible: true, reasons: [] },
      feature_readiness: {
        production_policy_source: "verified",
        dashboard_provider_context: "verified",
        dashboard_policy_proposal: "verified",
        approval_live_driver_auto_wake: "verified",
      },
      overlap_proven: true,
      overlap_intervals: [{ task_id: "a" }, { task_id: "b" }],
      gate_status: "passed",
      evaluation_status: "passed",
      snapshot_status: "completed",
      wave_integration_count: 3,
    };
    const withoutBlackBoxTests = buildM4AcceptanceSidecar({
      repositoryRoot: root,
      implementationCommit: implementation,
      suiteReports: reports,
      dogfood: dogfoodCompleted,
      generatedAt: "2026-09-02T00:00:00.000Z",
    });
    expect(
      withoutBlackBoxTests.results.find((entry) => entry.acceptance_id === "AC-10")?.status,
    ).toBe("blocked");
    expect(
      withoutBlackBoxTests.results.find((entry) => entry.acceptance_id === "AC-16")?.status,
    ).toBe("blocked");
    expect(
      withoutBlackBoxTests.results.find((entry) => entry.acceptance_id === "AC-17")?.status,
    ).toBe("blocked");

    addPassingReadinessTests(reports);
    const completed = buildM4AcceptanceSidecar({
      repositoryRoot: root,
      implementationCommit: implementation,
      suiteReports: reports,
      dogfood: dogfoodCompleted,
      generatedAt: "2026-09-02T00:00:00.000Z",
    });
    expect(completed.results.find((entry) => entry.acceptance_id === "AC-06")?.status).toBe(
      "passed",
    );
    expect(completed.results.find((entry) => entry.acceptance_id === "AC-20")?.status).toBe(
      "passed",
    );
    expect(completed.results.find((entry) => entry.acceptance_id === "AC-10")?.status).toBe(
      "passed",
    );
    expect(completed.results.find((entry) => entry.acceptance_id === "AC-16")?.status).toBe(
      "passed",
    );
    expect(completed.results.find((entry) => entry.acceptance_id === "AC-17")?.status).toBe(
      "passed",
    );
  }, 20_000);

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
        join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"),
        "utf8",
      ),
    ) as { scripts: { "test:release": string; "verify:m4:report": string } };
    expect(packageJson.scripts["test:release"]).toMatch(/^pnpm verify && pnpm test:security/u);
    expect(packageJson.scripts["test:release"]).toContain("pnpm test:m4:fault-matrix");
    expect(packageJson.scripts["test:release"]).not.toContain("pnpm verify && pnpm test &&");
    expect(packageJson.scripts["verify:m4:report"]).toBe(
      "node scripts/generate-acceptance-report.mjs --verify-report-commit",
    );
  });

  it("uploads both M4 report projections as one CI evidence bundle", () => {
    const workflow = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const uploadStep = workflow.match(
      /- name: Upload acceptance reports[\s\S]*?if-no-files-found: error/u,
    )?.[0];
    expect(uploadStep).toBeDefined();
    expect(uploadStep).toContain("docs/evidence/m4-local-multi-agent-scheduling-completion.md");
    expect(uploadStep).toContain("docs/evidence/m4-local-multi-agent-scheduling-results.json");
  });
});
