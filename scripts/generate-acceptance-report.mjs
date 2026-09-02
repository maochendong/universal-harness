/**
 * M1 acceptance report generator (plan Task 28 step 4).
 *
 * Merges the structured suite outputs under `.reports/acceptance/` (written
 * by `tests/reporting/vitest-acceptance-reporter.ts` during `pnpm test`,
 * `pnpm test:security`, `pnpm test:fault` and `pnpm test:performance`),
 * resolves the two non-test release gates (standalone content scan, CI
 * platform matrix), folds in the recorded performance baselines and renders
 * `docs/m1-acceptance-report.md`.
 *
 * The results section of the report is generated data: it must never be
 * hand-edited. Criterion statements are quoted from the approved design
 * (section 17) so the report and the design cannot drift apart. The script
 * exits non-zero unless every criterion holds passing evidence, which makes
 * it the final release gate of `pnpm test:release`.
 *
 * Kept dependency-free plain JavaScript (ASCII source); the Chinese
 * criterion text enters the report only as quoted design content.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateCiPlatformEvidence } from "./write-ci-platform-evidence.mjs";
import {
  CANONICAL_RELEASE_COMMANDS,
  M4_RESULTS_SCHEMA_VERSION,
  assertM4AcceptanceSidecar,
  assertCanonicalSuiteReports,
  digestTrackedEvidence,
  renderM4Markdown,
  verifyM4ReportCommit,
} from "./lib/m4-release-evidence.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportsDirectory = join(repositoryRoot, ".reports", "acceptance");
const ciPlatformEvidenceDirectory = join(repositoryRoot, ".reports", "ci-platform");
const designPath = join(
  repositoryRoot,
  "docs",
  "superpowers",
  "specs",
  "2026-08-11-universal-harness-m1-design.md",
);
const reportPath = join(repositoryRoot, "docs", "m1-acceptance-report.md");
const m2DesignPath = join(
  repositoryRoot,
  "docs",
  "superpowers",
  "specs",
  "2026-08-16-universal-harness-m2-design.md",
);
const m2ReportPath = join(repositoryRoot, "docs", "m2-acceptance-report.md");
const baselineDirectory = join(
  repositoryRoot,
  "node_modules",
  ".cache",
  "universal-harness",
  "performance-baseline",
);

const REQUIRED_SUITES = ["main", "security", "fault", "performance"];
const M4_REQUIRED_SUITES = Object.keys(CANONICAL_RELEASE_COMMANDS);
const CRITERION_COUNT = 28;
const STATUS_PRECEDENCE = ["failed", "blocked", "passed", "not_verified", "not_run"];
const currentCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();

function fail(message) {
  console.error(`acceptance report: ${message}`);
  process.exit(1);
}

if (process.argv.slice(2).includes("--verify-report-commit")) {
  const verified = verifyM4ReportCommit(repositoryRoot);
  console.log(
    `M4 report commit ${verified.report_commit} directly follows implementation ${verified.implementation_commit}.`,
  );
  process.exit(0);
}

// --- Load the criterion statements from the approved design -------------------

function designStatements() {
  const design = readFileSync(designPath, "utf8");
  const section = design.split("## 17. M1 ")[1]?.split("## 18.")[0];
  if (section === undefined) fail("design document section 17 not found");
  const statements = new Map();
  for (const line of section.split(/\r?\n/u)) {
    const match = /^(\d+)\.\s+(.+)$/u.exec(line.trim());
    if (match !== null) statements.set(Number(match[1]), match[2]);
  }
  if (statements.size !== CRITERION_COUNT) {
    fail(
      `design section 17 must list ${String(CRITERION_COUNT)} criteria, found ${String(statements.size)}`,
    );
  }
  return statements;
}

// --- Load suite reports ---------------------------------------------------------

const suiteReports = new Map();
for (const suite of REQUIRED_SUITES) {
  const path = join(reportsDirectory, `${suite}.json`);
  if (!existsSync(path)) {
    fail(
      `missing ${path}; run the suites first (pnpm verify, pnpm test:security, ` +
        `pnpm test:fault, pnpm test:performance)`,
    );
  }
  suiteReports.set(suite, JSON.parse(readFileSync(path, "utf8")));
}
assertCanonicalSuiteReports(
  suiteReports,
  Object.fromEntries(REQUIRED_SUITES.map((suite) => [suite, CANONICAL_RELEASE_COMMANDS[suite]])),
  currentCommit,
);
const canonicalReleaseReports = new Map(suiteReports);
for (const suite of M4_REQUIRED_SUITES) {
  if (canonicalReleaseReports.has(suite)) continue;
  const path = join(reportsDirectory, `${suite}.json`);
  if (!existsSync(path)) {
    fail(`missing canonical M4 release suite ${path}`);
  }
  canonicalReleaseReports.set(suite, JSON.parse(readFileSync(path, "utf8")));
}
const canonicalReleaseInvocationIds = assertCanonicalSuiteReports(
  canonicalReleaseReports,
  CANONICAL_RELEASE_COMMANDS,
  currentCommit,
);
// Optional extra suites (for example a standalone `pnpm test:e2e` run) merge
// in; "partial" reports from narrow local runs never affect the gate.
for (const entry of readdirSync(reportsDirectory)) {
  if (!entry.endsWith(".json")) continue;
  const suite = entry.slice(0, -".json".length);
  if (suite !== "partial" && !suiteReports.has(suite)) {
    const candidate = JSON.parse(readFileSync(join(reportsDirectory, entry), "utf8"));
    if (Array.isArray(candidate.records) && typeof candidate.files_failed === "number") {
      suiteReports.set(suite, candidate);
    }
  }
}

// --- Merge ----------------------------------------------------------------------

const criterionIds = Array.from(
  { length: CRITERION_COUNT },
  (_, index) => `AC-${String(index + 1)}`,
);

const merged = new Map();
for (const id of criterionIds) {
  const records = [...suiteReports.values()].flatMap((report) =>
    (report.records ?? []).filter((record) => record.criterion_id === id),
  );
  const status =
    STATUS_PRECEDENCE.find((candidate) => records.some((record) => record.status === candidate)) ??
    "not_run";
  const evidence = [...new Set(records.flatMap((record) => record.evidence ?? []))].sort();
  merged.set(id, { status, evidence, detail: records.at(-1)?.detail ?? "" });
}

// Verification commands come from the registry snapshot each suite report
// carries, so the generator never invents or duplicates the mapping.
const COMMAND_BY_ID = Object.fromEntries(
  (suiteReports.get("main").criteria ?? []).map((criterionEntry) => [
    criterionEntry.id,
    criterionEntry.command,
  ]),
);

// --- Non-test release gates -------------------------------------------------------

const allSuitesGreen = [...suiteReports.values()].every(
  (report) => (report.files_failed ?? 0) === 0,
);

const requiredCiPlatforms = ["ubuntu-latest", "macos-latest", "windows-latest"];
const ciArtifacts = existsSync(ciPlatformEvidenceDirectory)
  ? readdirSync(ciPlatformEvidenceDirectory)
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .map((entry) => JSON.parse(readFileSync(join(ciPlatformEvidenceDirectory, entry), "utf8")))
  : [];
const ciEvidence = evaluateCiPlatformEvidence({
  current_commit: currentCommit,
  required_platforms: requiredCiPlatforms,
  artifacts: ciArtifacts,
});
merged.set("AC-25", {
  status: ciEvidence.status,
  evidence: [
    ".github/workflows/ci.yml",
    ...requiredCiPlatforms.map((platform) => `.reports/ci-platform/${platform}.json`),
  ],
  detail:
    ciEvidence.status === "passed"
      ? `same-commit pnpm verify Evidence passed on ${requiredCiPlatforms.join(", ")}`
      : ciEvidence.status === "failed"
        ? `same-commit CI Evidence records failed platform(s): ${ciEvidence.failed_platforms.join(", ")}`
        : `cross-platform CI Evidence not verified; missing=${ciEvidence.missing_platforms.join(",") || "none"}, drifted=${ciEvidence.drifted_platforms.join(",") || "none"}, invalid=${String(ciEvidence.invalid_artifacts)}`,
});

const scan = spawnSync(
  process.execPath,
  [join(repositoryRoot, "scripts", "check-standalone.mjs")],
  {
    cwd: repositoryRoot,
    encoding: "utf8",
  },
);
merged.set("AC-28", {
  status: scan.status === 0 && allSuitesGreen ? "passed" : "failed",
  evidence: ["scripts/check-standalone.mjs"],
  detail:
    scan.status === 0
      ? "standalone content scan passed over files and Git history; provider mirror behavior is covered by the E2E suites"
      : `standalone content scan failed: ${scan.stderr.trim()}`,
});

// --- Performance baselines --------------------------------------------------------

function roundMs(value) {
  return typeof value === "number" ? Math.round(value * 100) / 100 : value;
}

/** Flatten each baseline file into rows; files may carry one `timing` or
 * several named `views`. */
const baselines = [];
if (existsSync(baselineDirectory)) {
  for (const entry of readdirSync(baselineDirectory).sort()) {
    if (!entry.endsWith(".json")) continue;
    const baseline = JSON.parse(readFileSync(join(baselineDirectory, entry), "utf8"));
    const rows =
      baseline.timing !== undefined
        ? [{ name: baseline.metric, timing: baseline.timing }]
        : Object.entries(baseline.views ?? {}).map(([view, timing]) => ({
            name: `${baseline.metric}.${view}`,
            timing,
          }));
    for (const row of rows) {
      baselines.push({
        ...row,
        operation_scale: baseline.operation_scale,
        environment: baseline.environment,
      });
    }
  }
}
if (baselines.length === 0 && merged.get("AC-27").status === "passed") {
  merged.set("AC-27", {
    ...merged.get("AC-27"),
    status: "blocked",
    detail: "performance suite passed but no baseline files were recorded",
  });
}

// --- Render -----------------------------------------------------------------------

function lastCommitFor(evidencePath) {
  try {
    return (
      execFileSync("git", ["log", "-1", "--format=%h", "--", evidencePath], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }).trim() || "-"
    );
  } catch {
    return "-";
  }
}

const statements = designStatements();
const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();

const counts = { passed: 0, failed: 0, blocked: 0, not_verified: 0, not_run: 0 };
for (const id of criterionIds) counts[merged.get(id).status] += 1;

const lines = [];
lines.push("# M1 验收报告");
lines.push("");
lines.push(
  "本文件由 `scripts/generate-acceptance-report.mjs` 从各测试套件的结构化输出生成；结果区禁止人工改写（实施计划 Task 28）。验收标准原文引用自已批准的设计文档第 17 节。",
);
lines.push("");
lines.push(`- 生成基线 commit：\`${head}\``);
lines.push(`- 输入套件：${[...suiteReports.keys()].join(", ")}（\`.reports/acceptance/*.json\`）`);
lines.push(
  `- 汇总：${String(counts.passed)}/${String(CRITERION_COUNT)} 通过；failed ${String(counts.failed)}，blocked ${String(counts.blocked)}，not_verified ${String(counts.not_verified)}，not_run ${String(counts.not_run)}`,
);
lines.push("");
lines.push("## 验收标准追溯");
lines.push("");
lines.push("| AC | 验收标准（设计第 17 节） | 测试命令 | Evidence | 结果 | Commit |");
lines.push("|---|---|---|---|---|---|");
for (const id of criterionIds) {
  const n = Number(id.slice("AC-".length));
  const entry = merged.get(id);
  const command = COMMAND_BY_ID[id] ?? "pnpm verify";
  const evidence = entry.evidence.length > 0 ? entry.evidence.join("<br>") : "-";
  const commit = entry.evidence.length > 0 ? lastCommitFor(entry.evidence[0]) : "-";
  lines.push(
    `| ${id} | ${statements.get(n)} | \`${command}\` | ${evidence} | ${entry.status} | ${commit} |`,
  );
}
lines.push("");
lines.push("## 性能基线（AC-27）");
lines.push("");
if (baselines.length === 0) {
  lines.push("未找到已记录的基线文件；缺少基线会阻止发布。");
} else {
  lines.push("| Metric | p50 (ms) | p95 (ms) | max (ms) | 规模 | 环境 |");
  lines.push("|---|---|---|---|---|---|");
  for (const baseline of baselines) {
    const timing = baseline.timing ?? {};
    const scale = JSON.stringify(baseline.operation_scale ?? {});
    const environment = baseline.environment ?? {};
    lines.push(
      `| ${baseline.name} | ${String(roundMs(timing.p50_ms))} | ${String(roundMs(timing.p95_ms))} | ${String(roundMs(timing.max_ms))} | ${scale} | ${String(environment.platform)} ci=${String(environment.ci)} |`,
    );
  }
}
lines.push("");
lines.push("## 发布声明");
lines.push("");
if (counts.passed === CRITERION_COUNT) {
  lines.push(
    "28 条验收标准全部具有通过证据；没有未解决 P0/P1 缺陷、Schema 迁移缺口或批准绕过。M1 发布退出门禁通过。",
  );
} else {
  lines.push(
    `存在未通过的验收标准（failed ${String(counts.failed)}，blocked ${String(counts.blocked)}，not_verified ${String(counts.not_verified)}，not_run ${String(counts.not_run)}）；M1 发布被阻止。`,
  );
}
lines.push("");

writeFileSync(reportPath, `${lines.join("\n")}`, "utf8");

// --- M2 acceptance matrix ------------------------------------------------------

function m2Statements() {
  const design = readFileSync(m2DesignPath, "utf8");
  const section = design.split("## 15. ")[1]?.split("## 16.")[0];
  if (section === undefined) fail("M2 design section 15 not found");
  return section
    .split(/\r?\n/u)
    .map((line) => line.split("|").map((cell) => cell.trim()))
    .filter(
      (cells) => cells.length >= 5 && cells[1] !== "范围" && cells[1] !== "---" && cells[1] !== "",
    )
    .map((cells) => ({ scope: cells[1], statement: cells[2] }));
}

const m2Matrix = [
  {
    command: "pnpm test && pnpm test:performance",
    evidence: [
      "packages/runtime/test/finding/groups.test.ts",
      "packages/cli/test/status.test.ts",
      "tests/performance/m2-finding-semantic.test.ts",
      "docs/evidence/m2-atlas-readonly-dogfood.md",
    ],
  },
  {
    command: "pnpm test",
    evidence: ["packages/runtime/test/finding/decay.test.ts"],
  },
  {
    command: "pnpm test",
    evidence: ["packages/runtime/test/finding/group-service.test.ts"],
  },
  {
    command: "pnpm test",
    evidence: [
      "packages/cli/test/project-runtime-config.test.ts",
      "adapters/gate-llm-judge/test/transport.test.ts",
    ],
  },
  {
    command: "pnpm test",
    evidence: [
      "packages/runtime/test/gates/llm-judge.test.ts",
      "packages/cli/test/project-runtime-config.test.ts",
    ],
  },
  {
    command: "pnpm test",
    evidence: [
      "adapters/gate-llm-judge/test/provider.test.ts",
      "adapters/gate-llm-judge/test/review-bundle.test.ts",
      "adapters/gate-llm-judge/test/response.test.ts",
    ],
  },
  {
    command: "pnpm test",
    evidence: [
      "packages/graph/test/semantic/provider.test.ts",
      "packages/conformance/test/semantic-seed-provider.test.ts",
    ],
  },
  {
    command: "pnpm test",
    evidence: [
      "packages/cli/test/impact.test.ts",
      "packages/graph/test/semantic/graph-policy.test.ts",
    ],
  },
  {
    command: "pnpm test && pnpm test:fault",
    evidence: [
      "packages/runtime/test/observability/event-stream.test.ts",
      "packages/runtime/test/observability/publisher.test.ts",
      "tests/fault/event-stream-recovery.test.ts",
    ],
  },
  {
    command: "pnpm test && pnpm test:e2e:dashboard && pnpm pack:smoke",
    evidence: [
      "packages/dashboard/test/server.test.ts",
      "packages/cli/test/serve.test.ts",
      "tests/e2e/dashboard-readonly.test.ts",
    ],
    playwright: true,
    dogfood: true,
    pack: true,
  },
  {
    command: "pnpm test && pnpm test:e2e && pnpm test:e2e:dashboard",
    evidence: [
      "packages/dashboard/test/write-api.test.ts",
      "tests/e2e/m2-vertical-loop.test.ts",
      "tests/e2e/dashboard-live-approval.test.ts",
    ],
    playwright: true,
  },
  {
    command: "pnpm test:security",
    evidence: [
      "tests/security/dashboard-security.test.ts",
      "tests/security/judge-security.test.ts",
    ],
  },
  {
    command: "pnpm verify && pnpm pack:smoke",
    evidence: ["scripts/check-standalone.mjs", "scripts/pack-smoke.mjs"],
    pack: true,
    standalone: true,
  },
];

const executedFiles = new Map();
for (const report of suiteReports.values()) {
  for (const file of report.files ?? []) {
    const previous = executedFiles.get(file.path);
    executedFiles.set(
      file.path,
      previous === "fail" || file.state === "fail"
        ? "fail"
        : previous === "pass" || file.state === "pass"
          ? "pass"
          : "skip",
    );
  }
}
const playwrightPath = join(reportsDirectory, "playwright-dashboard.json");
let playwrightPassed = false;
if (existsSync(playwrightPath)) {
  const report = JSON.parse(readFileSync(playwrightPath, "utf8"));
  playwrightPassed =
    report.schema_version === "harness.acceptance-suite-report/1" &&
    report.implementation_commit === currentCommit &&
    report.command === CANONICAL_RELEASE_COMMANDS["playwright-dashboard"] &&
    report.coverage === "full" &&
    report.files_failed === 0 &&
    report.files_total > 0;
}
const packPath = join(reportsDirectory, "pack-smoke.json");
let packPassed = false;
if (existsSync(packPath)) {
  const report = JSON.parse(readFileSync(packPath, "utf8"));
  packPassed =
    report.status === "passed" &&
    report.commit ===
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
}
const dogfoodPath = join(reportsDirectory, "m2-dogfood.json");
let dogfood;
if (existsSync(dogfoodPath)) {
  dogfood = JSON.parse(readFileSync(dogfoodPath, "utf8"));
}
const dogfoodPassed =
  dogfood?.status === "passed" &&
  dogfood?.snapshot_status === "completed" &&
  dogfood?.judge_calls === 1 &&
  dogfood?.worktree_clean === true;

const threeProfileDogfoodPath = join(reportsDirectory, "three-profile-dogfood.json");
let threeProfileDogfood;
if (existsSync(threeProfileDogfoodPath)) {
  threeProfileDogfood = JSON.parse(readFileSync(threeProfileDogfoodPath, "utf8"));
}
const requiredProfiles = ["lite", "standard", "governed"];
const threeProfileDogfoodPassed =
  threeProfileDogfood?.status === "passed" &&
  requiredProfiles.every((profile) => {
    const result = threeProfileDogfood.profiles?.find((entry) => entry.profile === profile);
    return (
      result?.terminal_status === "completed" &&
      result?.snapshot_status === "completed" &&
      result?.gate_status === "passed" &&
      result?.worktree_clean === true &&
      typeof result?.capability_plan_digest === "string"
    );
  });

const m2DesignStatements = m2Statements();
if (m2DesignStatements.length !== m2Matrix.length) {
  fail(
    `M2 design section 15 must list ${String(m2Matrix.length)} rows, found ${String(m2DesignStatements.length)}`,
  );
}
const m2Results = m2Matrix.map((entry, index) => {
  const missing = entry.evidence.filter(
    (path) =>
      path.startsWith("scripts/") === false &&
      path.startsWith("tests/e2e/dashboard-") === false &&
      (path.startsWith("docs/")
        ? !existsSync(join(repositoryRoot, path))
        : executedFiles.get(path) !== "pass"),
  );
  const failed = entry.evidence.some((path) => executedFiles.get(path) === "fail");
  const externalMissing =
    (entry.playwright === true && !playwrightPassed) ||
    (entry.pack === true && !packPassed) ||
    (entry.dogfood === true && !dogfoodPassed) ||
    (entry.standalone === true && scan.status !== 0);
  return {
    id: `M2-AC-${String(index + 1).padStart(2, "0")}`,
    ...m2DesignStatements[index],
    ...entry,
    status: failed ? "failed" : missing.length > 0 || externalMissing ? "not_run" : "passed",
  };
});
const m2Passed = m2Results.filter((entry) => entry.status === "passed").length;
const m2Lines = [
  "# M2 验收报告",
  "",
  "本文件由 `scripts/generate-acceptance-report.mjs` 从测试、Playwright、性能与打包门禁的结构化输出生成；验收语句引用自 M2 设计第 15 节。",
  "",
  `- 生成基线 commit：\`${head}\``,
  `- 汇总：${String(m2Passed)}/${String(m2Results.length)} 通过`,
  "",
  "| AC | 范围 | 必须证明的结果 | 命令 | Evidence | 结果 |",
  "|---|---|---|---|---|---|",
  ...m2Results.map(
    (entry) =>
      `| ${entry.id} | ${entry.scope} | ${entry.statement} | \`${entry.command}\` | ${entry.evidence.join("<br>")} | ${entry.status} |`,
  ),
  "",
  "## 纵向闭环 dogfood",
  "",
  dogfoodPassed
    ? `已保存真实受管 fixture 的脱敏证据：\`${dogfood.workflow_operation_id}\` → \`${dogfood.snapshot_id}\`；Judge 调用 ${String(dogfood.judge_calls)} 次，终态 ${dogfood.snapshot_status}，工作树干净。`
    : "缺少通过的 `.reports/acceptance/m2-dogfood.json` 纵向闭环证据。",
  "",
  "## Full-remediation 三档闭环",
  "",
  threeProfileDogfoodPassed
    ? `Packaged CLI 已完成 Lite / Standard / Governed 三档闭环；三个终态均为 completed Snapshot、Gate passed 且工作树干净。脱敏清单见 \`docs/evidence/full-remediation-three-profile-dogfood.md\`。`
    : "缺少通过的 `.reports/acceptance/three-profile-dogfood.json` 三档闭环证据。",
  "",
  m2Passed === m2Results.length
    ? "M2 验收矩阵全部具有当前运行证据，发布退出门禁通过。"
    : "M2 尚有缺失或失败证据，发布退出门禁未通过。",
  "",
];
writeFileSync(m2ReportPath, m2Lines.join("\n"), "utf8");

// --- M3 acceptance matrix (plan M3 Task 9 step 5) -----------------------------

const m3DesignPath = join(
  repositoryRoot,
  "docs",
  "superpowers",
  "specs",
  "2026-08-29-universal-harness-m3-remote-collaboration-design.md",
);
const m3ReportPath = join(
  repositoryRoot,
  "docs",
  "evidence",
  "m3-remote-collaboration-completion.md",
);

function m3Statements() {
  const design = readFileSync(m3DesignPath, "utf8");
  const section = design.split("## 22. ")[1]?.split("## 23.")[0];
  if (section === undefined) fail("M3 design section 22 not found");
  return section
    .split(/\r?\n/u)
    .map((line) => line.split("|").map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 3 && /^M3-AC-\d+$/u.test(cells[1] ?? ""))
    .map((cells) => ({ id: cells[1], statement: cells[2] }));
}

const M3_DOGFOOD_PROVIDERS = ["github", "gitlab", "gitee"];
const m3DogfoodBundles = new Map();
for (const provider of M3_DOGFOOD_PROVIDERS) {
  const path = join(repositoryRoot, "docs", "evidence", `m3-dogfood-${provider}.json`);
  if (existsSync(path)) {
    m3DogfoodBundles.set(provider, JSON.parse(readFileSync(path, "utf8")));
  }
}
const m3DogfoodPassed = M3_DOGFOOD_PROVIDERS.every((provider) => {
  const bundle = m3DogfoodBundles.get(provider);
  return bundle?.status === "passed" && bundle?.commit === currentCommit;
});

const m3Matrix = [
  {
    command: "pnpm test",
    evidence: [
      "packages/runtime/test/collaboration/remote-discovery.test.ts",
      "packages/conformance/test/collaboration.conformance.test.ts",
    ],
  },
  {
    command: "pnpm test && pnpm test:security",
    evidence: [
      "packages/runtime/test/collaboration/oauth-session.test.ts",
      "packages/runtime/test/collaboration/platform-adapters.test.ts",
      "packages/runtime/test/collaboration/sqlite-projection.test.ts",
      "tests/security/m3-collaboration-boundary.test.ts",
      "tests/security/m3-dogfood-redaction.test.ts",
    ],
  },
  {
    command: "pnpm test && pnpm test:e2e",
    evidence: [
      "tests/e2e/m3-remote-collaboration.test.ts",
      "packages/runtime/test/collaboration/lease.test.ts",
      "packages/runtime/test/collaboration/coordinator-git.test.ts",
    ],
  },
  {
    command: "pnpm test && pnpm test:e2e",
    evidence: [
      "packages/runtime/test/collaboration/lease.test.ts",
      "tests/e2e/m3-remote-collaboration.test.ts",
    ],
  },
  {
    command: "pnpm test && pnpm test:e2e",
    evidence: [
      "tests/e2e/m3-remote-collaboration.test.ts",
      "packages/runtime/test/collaboration/coordinator-git.test.ts",
    ],
  },
  {
    command: "pnpm test && pnpm test:fault && pnpm test:security && pnpm test:e2e",
    evidence: [
      "packages/runtime/test/collaboration/remote-approval.test.ts",
      "tests/fault/remote-approval-materialization.test.ts",
      "tests/security/m3-collaboration-boundary.test.ts",
      "tests/e2e/m3-remote-collaboration.test.ts",
    ],
  },
  {
    command: "pnpm test && pnpm test:e2e",
    evidence: [
      "tests/integration/m3-ledger-sequence-fork.test.ts",
      "packages/runtime/test/collaboration/ledger-resequence.test.ts",
      "packages/runtime/test/collaboration/integration.test.ts",
      "tests/e2e/m3-remote-collaboration.test.ts",
    ],
  },
  {
    command: "pnpm test",
    evidence: ["packages/runtime/test/collaboration/integration.test.ts"],
  },
  {
    command: "pnpm test:fault",
    evidence: ["tests/fault/integration-cas-recovery.test.ts"],
  },
  {
    command: "pnpm test && pnpm test:performance",
    evidence: [
      "packages/runtime/test/collaboration/sqlite-projection.test.ts",
      "tests/performance/m3-control-ref-rebuild.test.ts",
      "packages/runtime/test/collaboration/coordinator-git.test.ts",
    ],
  },
  {
    command: "pnpm test",
    evidence: [
      "packages/core/test/protocol/protocol-1.2.test.ts",
      "packages/core/test/protocol/registry.test.ts",
      "packages/cli/test/collaboration-commands.test.ts",
    ],
  },
  {
    command: "pnpm test && pnpm test:e2e:dashboard",
    evidence: [
      "packages/cli/test/collaboration-commands.test.ts",
      "tests/e2e/dashboard-m3-collaboration.test.ts",
    ],
    playwright: true,
  },
  {
    command: "pnpm test && node scripts/dogfood-m3-platform.mjs --provider github|gitlab|gitee",
    evidence: [
      "packages/conformance/test/collaboration.conformance.test.ts",
      "scripts/dogfood-m3-platform.mjs",
      "scripts/dogfood-m3-redaction.mjs",
      "docs/evidence/m3-dogfood-github.json",
      "docs/evidence/m3-dogfood-gitlab.json",
      "docs/evidence/m3-dogfood-gitee.json",
    ],
    dogfood: true,
  },
  {
    command: "pnpm test:release",
    evidence: ["scripts/generate-acceptance-report.mjs"],
    releaseGate: true,
  },
];

const m3DesignStatements = m3Statements();
if (m3DesignStatements.length !== m3Matrix.length) {
  fail(
    `M3 design section 22 must list ${String(m3Matrix.length)} rows, found ${String(m3DesignStatements.length)}`,
  );
}

/** Short sha256 of an evidence file's current bytes; "-" when absent. */
function evidenceDigest(path) {
  const absolute = join(repositoryRoot, path);
  if (!existsSync(absolute)) return "-";
  return createHash("sha256").update(readFileSync(absolute)).digest("hex").slice(0, 12);
}

/**
 * The exit code the evidence command last produced for one M3 criterion;
 * "-" when nothing ran. Suite-backed rows derive from the merged status
 * (passed → 0, failed → 1); the dogfood row reads the real per-provider
 * bundle outcomes (passed → 0, blocked → 2, failed → 1, worst wins) once
 * all three bundles exist.
 */
function m3ExitCode(entry) {
  if (
    entry.dogfood === true &&
    M3_DOGFOOD_PROVIDERS.every((provider) => m3DogfoodBundles.has(provider))
  ) {
    const codes = M3_DOGFOOD_PROVIDERS.map((provider) => {
      const status = m3DogfoodBundles.get(provider).status;
      return status === "passed" ? 0 : status === "blocked" ? 2 : 1;
    });
    return String(Math.max(...codes));
  }
  if (entry.status === "passed") return "0";
  if (entry.status === "failed") return "1";
  return "-";
}

const m3Results = m3Matrix.map((entry, index) => {
  const missing = entry.evidence.filter((path) => {
    if (path.startsWith("scripts/")) return false;
    if (path.startsWith("docs/")) return !existsSync(join(repositoryRoot, path));
    if (path.startsWith("tests/e2e/dashboard-")) return false;
    return executedFiles.get(path) !== "pass";
  });
  const failed = entry.evidence.some((path) => executedFiles.get(path) === "fail");
  const externalMissing =
    (entry.playwright === true && !playwrightPassed) ||
    (entry.dogfood === true && !m3DogfoodPassed) ||
    (entry.releaseGate === true &&
      (!allSuitesGreen || counts.passed !== CRITERION_COUNT || m2Passed !== m2Results.length));
  return {
    ...m3DesignStatements[index],
    ...entry,
    status: failed ? "failed" : missing.length > 0 || externalMissing ? "not_run" : "passed",
  };
});
const m3Passed = m3Results.filter((entry) => entry.status === "passed").length;
const m3Lines = [
  "# M3 远程协作完成证据",
  "",
  "本文件由 `scripts/generate-acceptance-report.mjs` 从测试、Playwright、性能与真实平台 dogfood 的结构化输出生成；验收语句引用自 M3 设计第 22 节，结果区禁止人工改写。",
  "",
  `- 生成基线 commit：\`${currentCommit}\``,
  `- 汇总：${String(m3Passed)}/${String(m3Results.length)} 通过`,
  "",
  "| AC | 必须证明的结果（设计第 22 节） | 命令 | Exit | Evidence（sha256 前 12 位） | 结果 | Commit |",
  "|---|---|---|---|---|---|---|",
  ...m3Results.map((entry) => {
    const evidence = entry.evidence
      .map((path) => `${path} (\`${evidenceDigest(path)}\`)`)
      .join("<br>");
    const commit = entry.evidence.length > 0 ? lastCommitFor(entry.evidence[0]) : "-";
    return `| ${entry.id} | ${entry.statement} | \`${entry.command}\` | ${m3ExitCode(entry)} | ${evidence} | ${entry.status} | ${commit} |`;
  }),
  "",
  "## 三平台真实 dogfood（M3-AC-13）",
  "",
  ...M3_DOGFOOD_PROVIDERS.map((provider) => {
    const bundle = m3DogfoodBundles.get(provider);
    if (bundle === undefined) {
      return `- ${provider}：缺少 \`docs/evidence/m3-dogfood-${provider}.json\`。`;
    }
    const commitMatch =
      bundle.commit === currentCommit
        ? "与基线 commit 一致"
        : `commit 漂移（${String(bundle.commit)}）`;
    return `- ${provider}：${String(bundle.status)}（${commitMatch}）。`;
  }),
  "",
  m3Passed === m3Results.length
    ? "M3 验收矩阵全部具有当前运行证据，发布退出门禁通过。"
    : "M3 尚有缺失或失败证据，发布退出门禁未通过。",
  "",
];
writeFileSync(m3ReportPath, `${m3Lines.join("\n")}`, "utf8");

// --- M4 local multi-Agent scheduling matrix (plan M4 Task 14 step 6) ---------

const m4DesignPath = join(
  repositoryRoot,
  "docs",
  "superpowers",
  "specs",
  "2026-08-31-universal-harness-m4-local-multi-agent-scheduling-design.md",
);
const m4ReportPath = join(
  repositoryRoot,
  "docs",
  "evidence",
  "m4-local-multi-agent-scheduling-completion.md",
);
const m4MachineResultPath = join(reportsDirectory, "m4-results.json");
const m4TrackedResultPath = join(
  repositoryRoot,
  "docs",
  "evidence",
  "m4-local-multi-agent-scheduling-results.json",
);
const m4DogfoodPath = join(reportsDirectory, "m4-dogfood.json");
const m4Dogfood = existsSync(m4DogfoodPath)
  ? JSON.parse(readFileSync(m4DogfoodPath, "utf8"))
  : undefined;
const m4ImplementationCommit = currentCommit;
const m4RequiredReports = canonicalReleaseReports;
const m4SuiteInvocationIds = canonicalReleaseInvocationIds;

function m4Statements() {
  const section = readFileSync(m4DesignPath, "utf8")
    .split("## 24. 验收标准")[1]
    ?.split("## 25.")[0];
  if (section === undefined) fail("M4 design section 24 not found");
  const statements = [];
  let current;
  for (const line of section.split(/\r?\n/u)) {
    const match = /^- \*\*(AC-\d+)\*\*：(.+)$/u.exec(line);
    if (match !== null) {
      if (current !== undefined) statements.push(current);
      current = { id: match[1], statement: match[2] };
      continue;
    }
    if (current !== undefined && /^\s{2}\S/u.test(line)) {
      current.statement = `${current.statement} ${line.trim()}`;
    }
  }
  if (current !== undefined) statements.push(current);
  if (statements.length !== 20) {
    fail(`M4 design section 24 must list 20 criteria, found ${String(statements.length)}`);
  }
  return statements;
}

const m4Matrix = [
  {
    command: "pnpm test",
    requiredSuites: ["main"],
    evidence: [
      "packages/runtime/test/planning/waves.test.ts",
      "packages/runtime/test/scheduling/task-dag-port.test.ts",
      "tests/e2e/m4-local-multi-agent.test.ts",
    ],
  },
  {
    command: "pnpm test",
    requiredSuites: ["main"],
    evidence: ["packages/runtime/test/planning/waves.test.ts"],
  },
  {
    command: "pnpm test && pnpm test:performance",
    requiredSuites: ["main", "performance"],
    evidence: [
      "packages/runtime/test/planning/waves.test.ts",
      "tests/performance/m4-wave-compiler.test.ts",
    ],
  },
  {
    command: "pnpm test",
    requiredSuites: ["main"],
    evidence: [
      "packages/runtime/test/orchestration/capability-plan-routing.test.ts",
      "tests/e2e/m4-sequential-compatibility.test.ts",
    ],
  },
  {
    command: "pnpm test && pnpm dogfood:m4",
    requiredSuites: ["main"],
    evidence: [
      "packages/conformance/test/scheduling.conformance.test.ts",
      "packages/runtime/test/scheduling/agent-pool.test.ts",
      ".reports/acceptance/m4-dogfood.json",
    ],
    dogfoodIneligibleProof: true,
  },
  {
    command: "pnpm dogfood:m4",
    requiredSuites: [],
    evidence: [".reports/acceptance/m4-dogfood.json"],
    blockedReason: "真实 dsh Adapter 仅支持受监督单槽位，未形成两个真实 Agent Run 的时间重叠证据",
  },
  {
    command: "pnpm test && pnpm test:e2e",
    requiredSuites: ["main", "e2e"],
    evidence: [
      "packages/runtime/test/scheduling/workspace-manager.test.ts",
      "packages/runtime/test/scheduling/agent-pool.test.ts",
      "tests/e2e/m4-local-multi-agent.test.ts",
    ],
  },
  {
    command: "pnpm test && pnpm test:fault",
    requiredSuites: ["main", "fault"],
    evidence: [
      "packages/runtime/test/scheduling/recovery.test.ts",
      "tests/fault/m4-scheduler-crash-matrix.test.ts",
    ],
  },
  {
    command: "pnpm test && pnpm test:e2e",
    requiredSuites: ["main", "e2e"],
    evidence: [
      "packages/runtime/test/scheduling/budget.test.ts",
      "tests/e2e/m4-local-multi-agent.test.ts",
    ],
  },
  {
    command: "pnpm test && pnpm test:fault",
    requiredSuites: ["main", "fault"],
    evidence: [
      "packages/runtime/test/scheduling/policy-decision-port.test.ts",
      "packages/runtime/test/scheduling/scheduler.test.ts",
    ],
  },
  {
    command: "pnpm test && pnpm test:e2e",
    requiredSuites: ["main", "e2e"],
    evidence: [
      "packages/runtime/test/scheduling/integration.test.ts",
      "tests/e2e/m4-local-multi-agent.test.ts",
    ],
  },
  {
    command: "pnpm test && pnpm test:fault",
    requiredSuites: ["main", "fault"],
    evidence: [
      "packages/runtime/test/scheduling/scheduler.test.ts",
      "tests/fault/m4-scheduler-crash-matrix.test.ts",
    ],
  },
  {
    command: "pnpm test && pnpm test:security",
    requiredSuites: ["main", "security"],
    evidence: [
      "packages/runtime/test/scheduling/scheduler.test.ts",
      "tests/security/m4-scheduler-boundaries.test.ts",
    ],
  },
  {
    command: "pnpm test:fault",
    requiredSuites: ["fault"],
    evidence: [
      "packages/runtime/test/scheduling/recovery.test.ts",
      "tests/fault/m4-scheduler-crash-matrix.test.ts",
    ],
  },
  {
    command: "pnpm test && pnpm test:e2e",
    requiredSuites: ["main", "e2e"],
    evidence: [
      "packages/runtime/test/scheduling/integration.test.ts",
      "tests/e2e/m4-local-multi-agent.test.ts",
    ],
  },
  {
    command: "pnpm test && pnpm test:e2e:dashboard",
    requiredSuites: ["main", "playwright-dashboard"],
    evidence: [
      "packages/dashboard/test/scheduler-api.test.ts",
      "tests/e2e/dashboard-m4-scheduler.test.ts",
    ],
    playwright: true,
    blockedReason:
      "Dashboard 尚缺生产 Policy Proposal 入口、完整 grounded approval context 与 operation 级待取消任务投影",
  },
  {
    command: "pnpm test && pnpm test:fault",
    requiredSuites: ["main", "fault"],
    evidence: [
      "packages/cli/test/m4-scheduling.test.ts",
      "tests/fault/m4-scheduler-crash-matrix.test.ts",
    ],
    blockedReason:
      "driver 存活时批准不会自动唤醒，operation 级 durable cancellation 与 cancel digest/PolicyDecision 闭环尚不完整",
  },
  {
    command: "pnpm test:performance",
    requiredSuites: ["performance"],
    evidence: ["tests/performance/m4-sqlite-rebuild.test.ts"],
  },
  {
    command: "pnpm test && pnpm test:e2e",
    requiredSuites: ["main", "e2e"],
    evidence: [
      "packages/core/test/protocol/protocol-1.3.test.ts",
      "tests/e2e/m4-sequential-compatibility.test.ts",
    ],
  },
  {
    command: "pnpm test:release && pnpm dogfood:m4",
    requiredSuites: ["main", "security", "fault", "performance", "e2e", "playwright-dashboard"],
    evidence: [
      "scripts/dogfood-m4-local-scheduler.mjs",
      "scripts/dogfood-m4-redaction.mjs",
      ".reports/acceptance/m4-dogfood.json",
    ],
    blockedReason:
      "真实 dsh 未满足四 Task、至少两个并发 Task、至少两个 wave 的完整 Scheduler/Gate/Evaluate/Snapshot dogfood",
  },
];

function m4EvidenceDigest(paths) {
  const tracked = paths.filter((path) => !path.startsWith(".reports/"));
  const hash = createHash("sha256");
  hash.update(digestTrackedEvidence(repositoryRoot, m4ImplementationCommit, tracked));
  for (const path of paths.filter((entry) => entry.startsWith(".reports/")).sort()) {
    const absolute = join(repositoryRoot, path);
    hash.update(path);
    hash.update("\0");
    if (existsSync(absolute)) hash.update(readFileSync(absolute));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function m4FileState(path, requiredSuites) {
  const states = requiredSuites.flatMap((suite) =>
    (m4RequiredReports.get(suite)?.files ?? [])
      .filter((file) => file.path === path)
      .map((file) => file.state),
  );
  if (states.includes("fail")) return "fail";
  if (states.includes("pass")) return "pass";
  return "missing";
}

const m4DesignStatements = m4Statements();
const m4Results = m4Matrix.map((entry, index) => {
  const statement = m4DesignStatements[index];
  const missing = entry.evidence.filter((path) => {
    if (path.startsWith(".reports/")) {
      return (
        !existsSync(join(repositoryRoot, path)) ||
        (path === ".reports/acceptance/m4-dogfood.json" &&
          m4Dogfood?.implementation_commit !== m4ImplementationCommit)
      );
    }
    if (path.startsWith("scripts/")) return false;
    return m4FileState(path, entry.requiredSuites) === "missing";
  });
  const failed = entry.evidence.some(
    (path) =>
      !path.startsWith(".reports/") &&
      !path.startsWith("scripts/") &&
      m4FileState(path, entry.requiredSuites) === "fail",
  );
  const ineligibleProofValid =
    entry.dogfoodIneligibleProof !== true ||
    (m4Dogfood?.implementation_commit === m4ImplementationCommit &&
      m4Dogfood?.blocker === "real_adapter_unattended_ineligible" &&
      m4Dogfood?.unattended_eligible === false &&
      m4Dogfood?.effective_max_concurrency === 1);
  const status =
    entry.blockedReason !== undefined
      ? "blocked"
      : failed
        ? "failed"
        : missing.length > 0 || !ineligibleProofValid
          ? "not_run"
          : "passed";
  return {
    acceptance_id: statement.id,
    statement: statement.statement,
    status,
    required_suites: entry.requiredSuites,
    suite_invocation_ids: Object.fromEntries(
      entry.requiredSuites.map((suite) => [suite, m4SuiteInvocationIds[suite]]),
    ),
    commands: [
      ...entry.requiredSuites.map((suite) => CANONICAL_RELEASE_COMMANDS[suite]),
      ...(entry.evidence.includes(".reports/acceptance/m4-dogfood.json")
        ? ["pnpm dogfood:m4"]
        : []),
    ],
    evidence: entry.evidence,
    evidence_digest: m4EvidenceDigest(entry.evidence),
    design_section: "§24",
    detail:
      entry.blockedReason ??
      (failed
        ? "至少一个绑定测试失败"
        : missing.length > 0
          ? `未在本次机器结果中执行：${missing.join(", ")}`
          : !ineligibleProofValid
            ? "真实 Adapter 不合格阻止证据无效或提交漂移"
            : "绑定测试与结构化 Evidence 已通过"),
  };
});
const m4Passed = m4Results.filter((entry) => entry.status === "passed").length;
const m4Sidecar = {
  schema_version: M4_RESULTS_SCHEMA_VERSION,
  milestone: "M4",
  implementation_commit: m4ImplementationCommit,
  generated_at: new Date().toISOString(),
  suite_invocation_ids: m4SuiteInvocationIds,
  results: m4Results,
};
assertM4AcceptanceSidecar(m4Sidecar, { requireComplete: true });
const m4SidecarJson = `${JSON.stringify(m4Sidecar, null, 2)}\n`;
writeFileSync(m4MachineResultPath, m4SidecarJson, "utf8");
writeFileSync(m4TrackedResultPath, m4SidecarJson, "utf8");
writeFileSync(m4ReportPath, renderM4Markdown(m4Sidecar, m4Dogfood), "utf8");

if (
  counts.passed !== CRITERION_COUNT ||
  m2Passed !== m2Results.length ||
  m3Passed !== m3Results.length ||
  m4Passed !== m4Results.length
) {
  fail(
    `reports written but release criteria are incomplete (M1 ${String(counts.passed)}/${String(CRITERION_COUNT)}, M2 ${String(m2Passed)}/${String(m2Results.length)}, M3 ${String(m3Passed)}/${String(m3Results.length)}, M4 ${String(m4Passed)}/${String(m4Results.length)})`,
  );
}
console.log(
  `Acceptance reports written: M1 28/28, M2 ${String(m2Passed)}/${String(m2Results.length)}, M3 ${String(m3Passed)}/${String(m3Results.length)}, M4 ${String(m4Passed)}/${String(m4Results.length)}.`,
);
