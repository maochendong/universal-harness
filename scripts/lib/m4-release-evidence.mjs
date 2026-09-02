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
    if (entry.acceptance_id !== expectedId || seen.has(entry.acceptance_id)) {
      throw new ReleaseEvidenceError(`M4 sidecar result identity must be ${expectedId}`);
    }
    seen.add(entry.acceptance_id);
    if (!Array.isArray(entry.required_suites) || !isObject(entry.suite_invocation_ids)) {
      throw new ReleaseEvidenceError(`${expectedId}: required suites/invocations are malformed`);
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
