/**
 * Acceptance aggregation (M1 plan Task 28, design section 17).
 *
 * The registry binds each of the 28 M1 acceptance criteria to its
 * verification command and the repository-relative test path prefixes whose
 * executed results prove it. The Vitest acceptance reporter executes the
 * mapping per suite run; the release aggregation merges the per-suite
 * structured outputs into one typed evidence record per criterion. Criteria
 * proven by a non-test gate (the standalone content scan, the CI platform
 * matrix) carry a `gate` marker and are resolved by the report generator.
 *
 * Source files stay ASCII; the human-readable criterion statements live in
 * the approved design document and are quoted from there at render time.
 */
import {
  assertAcceptanceEvidenceRecord,
  type AcceptanceCriterionId,
  type AcceptanceEvidenceRecord,
  type AcceptanceEvidenceStatus,
} from "./acceptance-evidence.js";

export type AcceptanceGate = "standalone-scan" | "ci-matrix";

export interface AcceptanceCriterion {
  readonly id: AcceptanceCriterionId;
  /** Verification command a release engineer runs for this criterion. */
  readonly command: string;
  /**
   * Repository-relative path prefixes of the test files whose execution
   * evidences the criterion; artifact paths for gate-backed criteria.
   */
  readonly evidence: readonly string[];
  /** Non-test release gate that backs the criterion, when applicable. */
  readonly gate?: AcceptanceGate;
}

function criterion(
  n: number,
  command: string,
  evidence: readonly string[],
  gate?: AcceptanceGate,
): AcceptanceCriterion {
  return {
    id: `AC-${String(n)}` as AcceptanceCriterionId,
    command,
    evidence,
    ...(gate === undefined ? {} : { gate }),
  };
}

export const ACCEPTANCE_CRITERIA: readonly AcceptanceCriterion[] = [
  criterion(1, "pnpm test:e2e", [
    "tests/e2e/generic-new.test.ts",
    "tests/e2e/node-new.test.ts",
    "tests/e2e/python-new.test.ts",
    "tests/e2e/java-new.test.ts",
  ]),
  criterion(2, "pnpm test:e2e", [
    "tests/e2e/generic-adopt.test.ts",
    "tests/e2e/node-adopt.test.ts",
    "tests/e2e/python-adopt.test.ts",
    "tests/e2e/java-adopt.test.ts",
    "tests/integration/adopt-preview.test.ts",
  ]),
  criterion(3, "pnpm test:e2e", [
    "tests/e2e/generic-iterate.test.ts",
    "tests/e2e/node-iterate.test.ts",
    "tests/e2e/python-iterate.test.ts",
    "tests/e2e/java-iterate.test.ts",
  ]),
  criterion(4, "pnpm test && pnpm test:fault", [
    "packages/runtime/test/workflow",
    "tests/e2e/generic-resume.test.ts",
    "tests/fault/workflow-resume.test.ts",
    "tests/fault/process-kill.test.ts",
  ]),
  criterion(5, "pnpm test", [
    "packages/core/test/identity",
    "packages/core/test/ledger",
    "tests/golden/ledger",
    "packages/graph/test/integrity.property.test.ts",
  ]),
  criterion(6, "pnpm test", [
    "packages/graph/test/graph-views.test.ts",
    "tests/golden/graph-views",
  ]),
  criterion(7, "pnpm test", ["packages/graph/test/impact", "tests/golden/impact"]),
  criterion(8, "pnpm test", ["packages/runtime/test/planning", "tests/golden/plans"]),
  criterion(9, "pnpm test", [
    "packages/runtime/test/planning/mode-selector.test.ts",
    "packages/runtime/test/orchestration",
    "tests/integration/execution-governance-vertical-loop.test.ts",
  ]),
  criterion(10, "pnpm test", [
    "packages/runtime/test/loop/task-envelope.test.ts",
    "packages/runtime/test/context",
  ]),
  criterion(11, "pnpm test", ["packages/runtime/test/context"]),
  criterion(12, "pnpm test && pnpm test:security", [
    "packages/runtime/test/tools",
    "tests/security/tool-validation.test.ts",
    "tests/security/secret-redaction.test.ts",
    "tests/security/capability-escalation.test.ts",
    "tests/security/delegated-provider.test.ts",
    "tests/security/command-injection.test.ts",
  ]),
  criterion(13, "pnpm test:fault", ["tests/fault/uncertain-external-action.test.ts"]),
  criterion(14, "pnpm test && pnpm test:fault", [
    "packages/runtime/test/loop",
    "packages/runtime/test/policy",
    "tests/fault/budget-exhaustion.test.ts",
  ]),
  criterion(15, "pnpm test", [
    "packages/runtime/test/loop/outcome.test.ts",
    "packages/conformance/test/agent-adapters.conformance.test.ts",
  ]),
  criterion(16, "pnpm test && pnpm test:fault", [
    "packages/runtime/test/gates",
    "tests/integration/three-layer-gates.test.ts",
    "tests/fault/partial-gate.test.ts",
  ]),
  criterion(17, "pnpm test", [
    "packages/eval/test/feedback",
    "tests/integration/feedback-cascade.test.ts",
    "tests/golden/feedback",
  ]),
  criterion(18, "pnpm test", ["packages/eval/test/feedback"]),
  criterion(19, "pnpm test", [
    "packages/eval/test/feedback",
    "tests/integration/feedback-cascade.test.ts",
  ]),
  criterion(20, "pnpm test && pnpm test:fault", [
    "packages/runtime/test/approval",
    "tests/fault/approval-cascade-invalidation.test.ts",
    "tests/fault/expired-approval.test.ts",
  ]),
  criterion(21, "pnpm test", [
    "packages/runtime/test/snapshot",
    "tests/e2e",
    "tests/e2e/delegated-agent-vertical-loop.test.ts",
  ]),
  criterion(22, "pnpm test && pnpm test:fault", [
    "packages/graph/test/materializer.test.ts",
    "tests/fault/sqlite-corruption.test.ts",
  ]),
  criterion(23, "pnpm test", ["packages/conformance/test/agent-adapters.conformance.test.ts"]),
  criterion(24, "pnpm test", [
    "packs/generic/test",
    "packs/node/test",
    "packs/python/test",
    "packs/java/test",
    "packages/conformance/test/packs.conformance.test.ts",
  ]),
  criterion(25, "pnpm verify", [".github/workflows/ci.yml"], "ci-matrix"),
  criterion(26, "pnpm test", ["packages/runtime/test/packs"]),
  criterion(27, "pnpm test:performance", ["tests/performance"]),
  criterion(28, "pnpm verify", ["scripts/check-standalone.mjs", "tests/e2e"], "standalone-scan"),
];

/** Suites whose structured output a release report must merge. */
export const REQUIRED_SUITES = ["main", "security", "fault", "performance"] as const;

export const SUITE_REPORT_SCHEMA_VERSION = "harness.acceptance-suite-report/1" as const;

export type SuiteCoverage = "full" | "partial";

export interface SuiteInvocation {
  readonly suite: string;
  readonly command: string;
  readonly coverage: SuiteCoverage;
}

export interface SuiteReportProvenance extends SuiteInvocation {
  readonly schema_version: typeof SUITE_REPORT_SCHEMA_VERSION;
  readonly implementation_commit: string;
  readonly invocation_id: string;
}

export interface SuiteFileResult {
  /** Repository-relative test file path using forward slashes. */
  readonly path: string;
  readonly state: "pass" | "fail" | "skip";
}

export interface SuiteAcceptanceReport {
  readonly schema_version: typeof SUITE_REPORT_SCHEMA_VERSION;
  readonly implementation_commit: string;
  readonly invocation_id: string;
  readonly command: string;
  readonly coverage: SuiteCoverage;
  readonly suite: string;
  readonly recorded_at: string;
  readonly files_total: number;
  readonly files_failed: number;
  readonly failed_files: readonly string[];
  /** Every executed module, retained so later milestones can bind evidence. */
  readonly files: readonly SuiteFileResult[];
  readonly records: readonly AcceptanceEvidenceRecord[];
  /**
   * Registry snapshot (id, command, gate) so the report generator renders
   * commands without duplicating the mapping.
   */
  readonly criteria: readonly {
    readonly id: AcceptanceCriterionId;
    readonly command: string;
    readonly gate?: AcceptanceGate;
  }[];
}

/**
 * Derive the suite name from the vitest invocation: the performance config
 * or a positional path filter names the suite; a full run without filters is
 * the main run. Unrecognized filters map to "partial" so a narrow local run
 * never clobbers the full main report the release gate consumes.
 */
export function suiteNameFromInvocation(
  configFile: string | undefined,
  argv: readonly string[],
): string {
  // The config path is the reliable performance-suite marker: `ctx.config`
  // does not always carry `configFile`, so match the `--config` value too.
  const configArgs = [configFile, ...argv].filter((arg): arg is string => typeof arg === "string");
  if (configArgs.some((arg) => /vitest\.performance\.ts$/u.test(arg))) {
    return "performance";
  }
  const filters: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined || arg === "run") continue;
    if (arg === "--config") {
      index += 1; // the config path is a flag value, not a test filter
      continue;
    }
    if (!arg.startsWith("-")) filters.push(arg);
  }
  if (filters.some((arg) => arg.includes("tests/security"))) return "security";
  if (filters.some((arg) => arg.includes("tests/fault"))) return "fault";
  if (filters.some((arg) => arg.includes("tests/e2e"))) return "e2e";
  return filters.length === 0 ? "main" : "partial";
}

function canonicalArgs(argv: readonly string[]): readonly string[] {
  const normalized: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--config") {
      const value = argv[index + 1];
      normalized.push(arg, value?.split(/[\\/]/u).at(-1) ?? "");
      index += 1;
      continue;
    }
    if (arg.startsWith("--config=")) {
      normalized.push(`--config=${arg.slice("--config=".length).split(/[\\/]/u).at(-1) ?? ""}`);
      continue;
    }
    normalized.push(arg);
  }
  return normalized;
}

const FULL_INVOCATIONS: readonly {
  readonly args: readonly string[];
  readonly suite: string;
  readonly command: string;
}[] = [
  { args: ["run", "--config", "vitest.workspace.ts"], suite: "main", command: "pnpm test" },
  {
    args: ["run", "--config", "vitest.workspace.ts", "tests/security"],
    suite: "security",
    command: "pnpm test:security",
  },
  {
    args: ["run", "--config", "vitest.workspace.ts", "tests/fault"],
    suite: "fault",
    command: "pnpm test:fault",
  },
  {
    args: ["run", "--config", "vitest.workspace.ts", "tests/e2e"],
    suite: "e2e",
    command: "pnpm test:e2e",
  },
  {
    args: ["run", "--config", "vitest.performance.ts"],
    suite: "performance",
    command: "pnpm test:performance",
  },
];

/**
 * Classify the actual Vitest invocation. Only package.json's exact release
 * commands are full coverage; adding a filter, flag or file always creates a
 * partial artifact that cannot replace a release report.
 */
export function resolveSuiteInvocation(
  configFile: string | undefined,
  argv: readonly string[],
): SuiteInvocation {
  const normalized = canonicalArgs(argv);
  const full = FULL_INVOCATIONS.find(
    (candidate) => JSON.stringify(candidate.args) === JSON.stringify(normalized),
  );
  if (full !== undefined) {
    return { suite: full.suite, command: full.command, coverage: "full" };
  }
  const inferred = suiteNameFromInvocation(configFile, argv);
  return {
    suite: inferred,
    command: `vitest ${normalized.join(" ")}`.trim(),
    coverage: "partial",
  };
}

export function resolvePlaywrightInvocation(argv: readonly string[]): SuiteInvocation {
  const normalized = canonicalArgs(argv);
  const canonical = ["test", "--config", "playwright.dashboard.config.ts"];
  if (JSON.stringify(normalized) === JSON.stringify(canonical)) {
    return {
      suite: "playwright-dashboard",
      command: "pnpm test:e2e:dashboard",
      coverage: "full",
    };
  }
  return {
    suite: "playwright-dashboard",
    command: `playwright ${normalized.join(" ")}`.trim(),
    coverage: "partial",
  };
}

/** Repository-relative output below `.reports/acceptance`. */
export function reportPathForInvocation(invocation: SuiteInvocation, invocationId: string): string {
  if (invocation.coverage === "full") return `${invocation.suite}.json`;
  if (!/^[A-Za-z0-9._-]+$/u.test(invocationId)) {
    throw new Error("suite invocation id is not path-safe");
  }
  return `partial/${invocation.suite}-${invocationId}.json`;
}

/** Criteria whose evidence prefixes match the executed file. */
export function criteriaForFile(path: string): readonly AcceptanceCriterion[] {
  return ACCEPTANCE_CRITERIA.filter(
    (c) => c.gate === undefined && c.evidence.some((prefix) => path.startsWith(prefix)),
  );
}

/**
 * Build the structured report for one executed suite: every criterion with
 * at least one executed evidence file gets a typed record; files a criterion
 * lists but this suite did not execute do not downgrade it (another suite
 * may cover them), but a failed executed file always fails the criterion.
 */
export function buildSuiteReport(
  suite: string,
  files: readonly SuiteFileResult[],
  recordedAt: string,
  provenance: SuiteReportProvenance,
): SuiteAcceptanceReport {
  const failedFiles = files.filter((file) => file.state === "fail").map((file) => file.path);
  const records: AcceptanceEvidenceRecord[] = [];
  for (const criterionEntry of ACCEPTANCE_CRITERIA) {
    if (criterionEntry.gate !== undefined) continue;
    const matched = files.filter((file) =>
      criterionEntry.evidence.some((prefix) => file.path.startsWith(prefix)),
    );
    if (matched.length === 0) continue;
    const failed = matched.some((file) => file.state === "fail");
    const record: AcceptanceEvidenceRecord = {
      criterion_id: criterionEntry.id,
      status: failed ? "failed" : "passed",
      evidence: matched.map((file) => file.path),
      recorded_at: recordedAt,
      detail: `suite ${suite}: ${String(matched.length)} evidence file(s), ${failed ? "failures present" : "all passed"}`,
    };
    assertAcceptanceEvidenceRecord(record);
    records.push(record);
  }
  return {
    schema_version: provenance.schema_version,
    implementation_commit: provenance.implementation_commit,
    invocation_id: provenance.invocation_id,
    command: provenance.command,
    coverage: provenance.coverage,
    suite,
    recorded_at: recordedAt,
    files_total: files.length,
    files_failed: failedFiles.length,
    failed_files: failedFiles,
    files: [...files].sort((left, right) => left.path.localeCompare(right.path)),
    records,
    criteria: ACCEPTANCE_CRITERIA.map((criterionEntry) => ({
      id: criterionEntry.id,
      command: criterionEntry.command,
      ...(criterionEntry.gate === undefined ? {} : { gate: criterionEntry.gate }),
    })),
  };
}

const STATUS_PRECEDENCE: readonly AcceptanceEvidenceStatus[] = [
  "failed",
  "blocked",
  "passed",
  "not_run",
];

/**
 * Merge per-suite reports into one record per criterion: the worst status
 * across suites wins and evidence pointers accumulate in deterministic
 * order. Gate-backed criteria stay `not_run` here; the report generator
 * resolves them from their non-test gate.
 */
export function mergeSuiteReports(
  reports: readonly SuiteAcceptanceReport[],
  recordedAt: string,
): readonly AcceptanceEvidenceRecord[] {
  return ACCEPTANCE_CRITERIA.map((criterionEntry) => {
    const matching = reports.flatMap((report) =>
      report.records.filter((record) => record.criterion_id === criterionEntry.id),
    );
    const status =
      STATUS_PRECEDENCE.find((candidate) =>
        matching.some((record) => record.status === candidate),
      ) ?? "not_run";
    const evidence = [...new Set(matching.flatMap((record) => record.evidence))].sort();
    const record: AcceptanceEvidenceRecord = {
      criterion_id: criterionEntry.id,
      status,
      evidence: evidence.length > 0 ? evidence : [...criterionEntry.evidence],
      recorded_at: recordedAt,
      detail:
        matching.length === 0
          ? criterionEntry.gate === undefined
            ? "no suite executed the evidence files"
            : "resolved by the release gate, not a test suite"
          : `merged from ${String(matching.length)} suite record(s)`,
    };
    assertAcceptanceEvidenceRecord(record);
    return record;
  });
}
