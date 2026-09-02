import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export const SUITE_REPORT_SCHEMA_VERSION = "harness.acceptance-suite-report/1";
export const M4_RESULTS_SCHEMA_VERSION = "harness.m4-acceptance-results/1";

export const CANONICAL_RELEASE_COMMANDS = Object.freeze({
  main: "pnpm test",
  security: "pnpm test:security",
  fault: "pnpm test:fault",
  performance: "pnpm test:performance",
  e2e: "pnpm test:e2e",
  "playwright-dashboard": "pnpm test:e2e:dashboard",
});

function ac(id, statement, required_suites, evidence, dogfood_rule) {
  return Object.freeze({
    acceptance_id: id,
    statement,
    required_suites: Object.freeze(required_suites),
    evidence: Object.freeze(evidence),
    ...(dogfood_rule === undefined ? {} : { dogfood_rule }),
  });
}

/** Frozen M4 acceptance contract. Generator and immutable-report verifier share it. */
export const M4_ACCEPTANCE_REGISTRY = Object.freeze([
  ac(
    "AC-01",
    "Plan 是 Task 规划语义唯一权威源，并原子生成全部 `DEPENDS_ON` 和 digest-bound waves。",
    ["main"],
    [
      "packages/runtime/test/planning/waves.test.ts",
      "packages/runtime/test/scheduling/task-dag-port.test.ts",
      "tests/e2e/m4-local-multi-agent.test.ts",
    ],
  ),
  ac(
    "AC-02",
    "循环、缺失依赖、不一致 wave 及不确定拆分被拒绝。",
    ["main"],
    ["packages/runtime/test/planning/waves.test.ts"],
  ),
  ac(
    "AC-03",
    "写路径与独占资源冲突被机械串行化。",
    ["main", "performance"],
    ["packages/runtime/test/planning/waves.test.ts", "tests/performance/m4-wave-compiler.test.ts"],
  ),
  ac(
    "AC-04",
    "`parallel_task_execution` 满足完整 Module Contract；Lite disabled，Standard/Governed required 并按有效上限并行。",
    ["main"],
    [
      "packages/runtime/test/orchestration/capability-plan-routing.test.ts",
      "tests/e2e/m4-sequential-compatibility.test.ts",
    ],
  ),
  ac(
    "AC-05",
    "不合格 Adapter 不能无人值守并行。",
    ["main"],
    [
      "packages/conformance/test/scheduling.conformance.test.ts",
      "packages/runtime/test/scheduling/agent-pool.test.ts",
      ".reports/acceptance/m4-dogfood.json",
    ],
    "adapter_eligibility",
  ),
  ac(
    "AC-06",
    "至少两个真实 Task 在隔离槽位并行。",
    [],
    [".reports/acceptance/m4-dogfood.json"],
    "parallel_overlap",
  ),
  ac(
    "AC-07",
    "Context、Budget、Run、worktree 和隐藏历史互不共享；Strict TDD 无嵌套 worktree 且 四层写集取交集。",
    ["main", "e2e"],
    [
      "packages/runtime/test/scheduling/workspace-manager.test.ts",
      "packages/runtime/test/scheduling/agent-pool.test.ts",
      "tests/e2e/m4-local-multi-agent.test.ts",
    ],
  ),
  ac(
    "AC-08",
    "Task Lease、fencing、Protocol Envelope 和重启恢复无重复接受。",
    ["main", "fault"],
    [
      "packages/runtime/test/scheduling/recovery.test.ts",
      "tests/fault/m4-scheduler-crash-matrix.test.ts",
    ],
  ),
  ac(
    "AC-09",
    "并发预算预留不突破 Iteration 总上限。",
    ["main", "e2e"],
    ["packages/runtime/test/scheduling/budget.test.ts", "tests/e2e/m4-local-multi-agent.test.ts"],
  ),
  ac(
    "AC-10",
    "三个调度 Action 及 Policy `allow/deny/requires_approval/block` 四态、Approval 漂移正确生效。",
    ["main", "fault"],
    [
      "packages/runtime/test/scheduling/policy-decision-port.test.ts",
      "packages/runtime/test/scheduling/scheduler.test.ts",
    ],
  ),
  ac(
    "AC-11",
    "三层 Gate 与 wave 原子集成成立。",
    ["main", "e2e"],
    [
      "packages/runtime/test/scheduling/integration.test.ts",
      "tests/e2e/m4-local-multi-agent.test.ts",
    ],
  ),
  ac(
    "AC-12",
    "executor retry 和 patch-apply integration retry 均最多一次；语义冲突与 baseline drift 不进入 retry。",
    ["main", "fault"],
    [
      "packages/runtime/test/scheduling/scheduler.test.ts",
      "tests/fault/m4-scheduler-crash-matrix.test.ts",
    ],
  ),
  ac(
    "AC-13",
    "第二次失败、越权写入和预算耗尽正确阻塞。",
    ["main", "security"],
    [
      "packages/runtime/test/scheduling/scheduler.test.ts",
      "tests/security/m4-scheduler-boundaries.test.ts",
    ],
  ),
  ac(
    "AC-14",
    "baseline drift 不会自动 force/rebase。",
    ["fault"],
    [
      "packages/runtime/test/scheduling/recovery.test.ts",
      "tests/fault/m4-scheduler-crash-matrix.test.ts",
    ],
  ),
  ac(
    "AC-15",
    "Evidence 绑定 Task、Run、Lease token 和实际基线；丢弃 candidate 后旧 Evidence provisional 且完整重验。",
    ["main", "e2e"],
    [
      "packages/runtime/test/scheduling/integration.test.ts",
      "tests/e2e/m4-local-multi-agent.test.ts",
    ],
  ),
  ac(
    "AC-16",
    "Dashboard 展示完整调度与恢复状态。",
    ["main", "playwright-dashboard"],
    ["packages/dashboard/test/scheduler-api.test.ts", "tests/e2e/dashboard-m4-scheduler.test.ts"],
  ),
  ac(
    "AC-17",
    "CLI run/resume/status/watch/abort 形成闭环，CLI 与 Dashboard 对同一 Operation 保持 单驱动。",
    ["main", "fault"],
    ["packages/cli/test/m4-scheduling.test.ts", "tests/fault/m4-scheduler-crash-matrix.test.ts"],
  ),
  ac(
    "AC-18",
    "SQLite 删除后可从 Ledger 恢复权威状态。",
    ["performance"],
    ["tests/performance/m4-sqlite-rebuild.test.ts"],
  ),
  ac(
    "AC-19",
    "Protocol 1.3 Envelope/Reader/`required_reader_version`、M1/M2/M3 与顺序执行回归全部通过。",
    ["main", "e2e"],
    [
      "packages/core/test/protocol/protocol-1.3.test.ts",
      "tests/e2e/m4-sequential-compatibility.test.ts",
    ],
  ),
  ac(
    "AC-20",
    "真实 Dogfood 完成并生成绑定当前提交的验收报告。",
    ["main", "security", "fault", "performance", "e2e", "playwright-dashboard"],
    [
      "scripts/dogfood-m4-local-scheduler.mjs",
      "scripts/dogfood-m4-redaction.mjs",
      ".reports/acceptance/m4-dogfood.json",
    ],
    "full_vertical_dogfood",
  ),
]);

export function m4Commands(registryEntry) {
  return [
    ...registryEntry.required_suites.map((suite) => CANONICAL_RELEASE_COMMANDS[suite]),
    ...(registryEntry.dogfood_rule === undefined ? [] : ["pnpm dogfood:m4"]),
  ];
}

const REPORT_PATHS = new Set([
  "docs/m1-acceptance-report.md",
  "docs/m2-acceptance-report.md",
  "docs/evidence/m3-remote-collaboration-completion.md",
  "docs/evidence/m4-local-multi-agent-scheduling-completion.md",
  "docs/evidence/m4-local-multi-agent-scheduling-results.json",
]);

export class ReleaseEvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseEvidenceError";
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertString(value, field, suite) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ReleaseEvidenceError(`${suite}: ${field} must be a non-empty string`);
  }
}

/**
 * Fail-closed validation for release Evidence. Callers provide only the
 * reports loaded from canonical full-report paths; partial artifacts never
 * enter this map.
 */
export function assertCanonicalSuiteReports(reports, commands, implementationCommit) {
  const invocationIds = {};
  for (const [suite, command] of Object.entries(commands)) {
    const report = reports.get(suite);
    if (!isObject(report)) {
      throw new ReleaseEvidenceError(`${suite}: canonical suite report is missing`);
    }
    if (report.schema_version !== SUITE_REPORT_SCHEMA_VERSION) {
      throw new ReleaseEvidenceError(`${suite}: unsupported suite report schema`);
    }
    if (report.suite !== suite) {
      throw new ReleaseEvidenceError(`${suite}: report suite identity mismatch`);
    }
    if (report.coverage !== "full") {
      throw new ReleaseEvidenceError(`${suite}: partial coverage cannot prove a release`);
    }
    if (report.command !== command) {
      throw new ReleaseEvidenceError(
        `${suite}: command does not match the canonical release command`,
      );
    }
    if (report.implementation_commit !== implementationCommit) {
      throw new ReleaseEvidenceError(`${suite}: implementation commit is stale or mixed`);
    }
    if (
      report.started_commit !== implementationCommit ||
      report.finished_commit !== implementationCommit
    ) {
      throw new ReleaseEvidenceError(`${suite}: repository HEAD changed during the suite run`);
    }
    if (
      report.tracked_worktree_clean_at_start !== true ||
      report.tracked_worktree_clean_at_finish !== true
    ) {
      throw new ReleaseEvidenceError(`${suite}: tracked worktree changed during the suite run`);
    }
    if (report.tracked_worktree_clean !== true) {
      throw new ReleaseEvidenceError(`${suite}: tests did not run from a clean tracked worktree`);
    }
    assertString(report.invocation_id, "invocation_id", suite);
    if (!Array.isArray(report.files) || report.files.length === 0) {
      throw new ReleaseEvidenceError(`${suite}: no executed files were recorded`);
    }
    if (report.files_failed !== 0 || report.files.some((file) => file?.state === "fail")) {
      throw new ReleaseEvidenceError(`${suite}: suite contains failed files`);
    }
    invocationIds[suite] = report.invocation_id;
  }
  return invocationIds;
}

function git(repositoryRoot, args, encoding = "utf8") {
  try {
    return execFileSync("git", args, { cwd: repositoryRoot, encoding });
  } catch (error) {
    throw new ReleaseEvidenceError(
      `git ${args.join(" ")} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function readTrackedEvidence(repositoryRoot, commit, path) {
  if (path.startsWith(".reports/")) {
    throw new ReleaseEvidenceError(`${path}: generated runtime artifact is not tracked Evidence`);
  }
  return git(repositoryRoot, ["show", `${commit}:${path}`], null);
}

/** Hash repository-relative path and the exact bytes committed at `commit`. */
export function digestTrackedEvidence(repositoryRoot, commit, paths) {
  const hash = createHash("sha256");
  for (const path of [...new Set(paths)].sort()) {
    hash.update(path);
    hash.update("\0");
    hash.update(readTrackedEvidence(repositoryRoot, commit, path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function assertM4AcceptanceSidecar(sidecar, options = {}) {
  if (!isObject(sidecar) || sidecar.schema_version !== M4_RESULTS_SCHEMA_VERSION) {
    throw new ReleaseEvidenceError("M4 sidecar schema is missing or unsupported");
  }
  assertString(sidecar.implementation_commit, "implementation_commit", "M4 sidecar");
  if (!Array.isArray(sidecar.results)) {
    throw new ReleaseEvidenceError("M4 sidecar results must be an array");
  }
  const expectedCount = options.requireComplete === true ? 20 : sidecar.results.length;
  if (sidecar.results.length !== expectedCount) {
    throw new ReleaseEvidenceError(`M4 sidecar must contain ${String(expectedCount)} results`);
  }
  if (options.requireComplete === true) {
    if (!isObject(sidecar.suite_invocation_ids)) {
      throw new ReleaseEvidenceError(
        "M4 sidecar must retain canonical suite invocation identities",
      );
    }
    for (const suite of Object.keys(CANONICAL_RELEASE_COMMANDS)) {
      assertString(sidecar.suite_invocation_ids[suite], "invocation_id", suite);
    }
  }
  const seen = new Set();
  for (const [index, entry] of sidecar.results.entries()) {
    if (!isObject(entry)) throw new ReleaseEvidenceError("M4 sidecar result must be an object");
    const expectedId = `AC-${String(index + 1).padStart(2, "0")}`;
    const registryEntry = M4_ACCEPTANCE_REGISTRY[index];
    if (registryEntry === undefined) {
      throw new ReleaseEvidenceError(`${expectedId}: no frozen registry entry exists`);
    }
    if (entry.acceptance_id !== expectedId || seen.has(entry.acceptance_id)) {
      throw new ReleaseEvidenceError(`M4 sidecar result identity must be ${expectedId}`);
    }
    seen.add(entry.acceptance_id);
    if (entry.statement !== registryEntry.statement) {
      throw new ReleaseEvidenceError(`${expectedId}: statement drifted from the frozen registry`);
    }
    if (!Array.isArray(entry.required_suites) || !isObject(entry.suite_invocation_ids)) {
      throw new ReleaseEvidenceError(`${expectedId}: required suites/invocations are malformed`);
    }
    if (JSON.stringify(entry.required_suites) !== JSON.stringify(registryEntry.required_suites)) {
      throw new ReleaseEvidenceError(`${expectedId}: required suites drifted from the registry`);
    }
    for (const suite of entry.required_suites) {
      if (!(suite in CANONICAL_RELEASE_COMMANDS)) {
        throw new ReleaseEvidenceError(`${expectedId}: unknown required suite ${String(suite)}`);
      }
      assertString(entry.suite_invocation_ids[suite], "suite invocation id", expectedId);
      if (
        isObject(sidecar.suite_invocation_ids) &&
        entry.suite_invocation_ids[suite] !== sidecar.suite_invocation_ids[suite]
      ) {
        throw new ReleaseEvidenceError(`${expectedId}: suite invocation identity drifted`);
      }
    }
    if (!Array.isArray(entry.commands) || !Array.isArray(entry.evidence)) {
      throw new ReleaseEvidenceError(`${expectedId}: commands/evidence must be arrays`);
    }
    if (JSON.stringify(entry.commands) !== JSON.stringify(m4Commands(registryEntry))) {
      throw new ReleaseEvidenceError(`${expectedId}: canonical commands drifted from the registry`);
    }
    if (
      entry.evidence.length === 0 ||
      JSON.stringify(entry.evidence) !== JSON.stringify(registryEntry.evidence)
    ) {
      throw new ReleaseEvidenceError(`${expectedId}: Evidence drifted from the registry`);
    }
    if (!/^[a-f0-9]{64}$/u.test(entry.evidence_digest ?? "")) {
      throw new ReleaseEvidenceError(`${expectedId}: evidence digest must be sha256`);
    }
    if (!["passed", "failed", "blocked", "not_run"].includes(entry.status)) {
      throw new ReleaseEvidenceError(`${expectedId}: invalid status`);
    }
  }
  return sidecar;
}

/** Render-only projection: every result cell originates in the typed JSON. */
export function renderM4Markdown(sidecar) {
  assertM4AcceptanceSidecar(sidecar);
  const passed = sidecar.results.filter((entry) => entry?.status === "passed").length;
  const blocked = sidecar.results.filter((entry) => entry?.status === "blocked").length;
  const lines = [
    "# M4 本地 Multi-Agent 调度完成证据",
    "",
    "本文件由 `scripts/generate-acceptance-report.mjs` 对 typed JSON sidecar 做纯投影生成；结果区禁止人工改写。M4 必须 20/20 才能声明完成。",
    "",
    `- 被评估实现 commit：\`${String(sidecar.implementation_commit)}\``,
    `- 汇总：${String(passed)}/${String(sidecar.results.length)} 通过，${String(blocked)} 项阻塞`,
    "",
    "| AC | 必须证明的结果 | Required suites / invocation | 命令 | Evidence digest | 结果 | 说明 |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const entry of sidecar.results) {
    const invocations = Object.entries(entry.suite_invocation_ids ?? {})
      .map(([suite, id]) => `${suite}:\`${String(id)}\``)
      .join("<br>");
    lines.push(
      `| ${escapeCell(entry.acceptance_id)} | ${escapeCell(entry.statement)} | ${invocations || "-"} | ${escapeCell((entry.commands ?? []).map((command) => `\`${String(command)}\``).join("<br>"))} | \`${String(entry.evidence_digest).slice(0, 16)}\` | ${escapeCell(entry.status)} | ${escapeCell(entry.detail)} |`,
    );
  }
  lines.push("", "## 真实 dsh Evidence", "");
  const dogfood = sidecar.dogfood_summary;
  lines.push(
    !isObject(dogfood) || dogfood.present !== true
      ? "- 未找到 `.reports/acceptance/m4-dogfood.json`。"
      : `- provider=${String(dogfood.provider)} ${String(dogfood.provider_version)}；exit=${String(dogfood.exit_code)}；requested concurrency=${String(dogfood.requested_max_concurrency)}，effective concurrency=${String(dogfood.effective_max_concurrency)}；blocker=${String(dogfood.blocker)}。`,
  );
  lines.push(
    "- 发布报告不包含原始 transcript、凭据或机器绝对路径；只保存脱敏后的结构化结果与 digest。",
    "",
    passed === 20
      ? "M4 AC-01～20 全部具有同一实现提交的通过证据，完成声明成立。"
      : "M4 完成声明不成立；blocked/not_run 项必须补齐机器 Evidence 后重新生成。",
    "",
  );
  return lines.join("\n");
}

/**
 * Verify the immutable report topology after a human/CI has committed the
 * generated files. This is intentionally separate from generation: a report
 * cannot embed the SHA of the commit that contains itself.
 */
export function verifyM4ReportCommit(repositoryRoot, head = "HEAD") {
  const ancestry = git(repositoryRoot, ["rev-list", "--parents", "-n", "1", head])
    .trim()
    .split(/\s+/u);
  if (ancestry.length !== 2) {
    throw new ReleaseEvidenceError("M4 report commit must have exactly one parent");
  }
  const [reportCommit, parent] = ancestry;
  const sidecarPath = "docs/evidence/m4-local-multi-agent-scheduling-results.json";
  let sidecar;
  try {
    sidecar = JSON.parse(git(repositoryRoot, ["show", `${reportCommit}:${sidecarPath}`]));
  } catch (error) {
    if (error instanceof ReleaseEvidenceError) throw error;
    throw new ReleaseEvidenceError("M4 report sidecar is not valid JSON");
  }
  if (sidecar.schema_version !== M4_RESULTS_SCHEMA_VERSION) {
    throw new ReleaseEvidenceError("M4 report sidecar schema is unsupported");
  }
  if (sidecar.implementation_commit !== parent) {
    throw new ReleaseEvidenceError("report parent is not the evaluated implementation commit");
  }
  assertM4AcceptanceSidecar(sidecar, { requireComplete: true });
  const changed = git(repositoryRoot, [
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    reportCommit,
  ])
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean);
  if (changed.length === 0 || changed.some((path) => !REPORT_PATHS.has(path))) {
    throw new ReleaseEvidenceError(
      "report commit must change only approved Markdown/typed JSON reports",
    );
  }
  const completionPath = "docs/evidence/m4-local-multi-agent-scheduling-completion.md";
  if (!changed.includes(sidecarPath) || !changed.includes(completionPath)) {
    throw new ReleaseEvidenceError(
      "report commit must contain both M4 typed JSON and Markdown projection",
    );
  }
  const committedMarkdown = git(repositoryRoot, ["show", `${reportCommit}:${completionPath}`]);
  if (committedMarkdown !== renderM4Markdown(sidecar)) {
    throw new ReleaseEvidenceError("M4 Markdown is not the exact typed-sidecar projection");
  }
  return { report_commit: reportCommit, implementation_commit: parent, changed_paths: changed };
}
