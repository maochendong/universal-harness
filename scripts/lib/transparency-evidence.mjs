import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import {
  CANONICAL_RELEASE_COMMANDS,
  ReleaseEvidenceError,
  assertCanonicalSuiteReports,
  buildCanonicalSuiteProof,
  digestCanonicalResult,
  digestTrackedEvidence,
  readTrackedEvidence,
} from "./m4-release-evidence.mjs";

export const TRANSPARENCY_REPORT_SCHEMA_VERSION = "harness.transparency-acceptance/1";
export const TRANSPARENCY_DOGFOOD_SCHEMA_VERSION = "harness.transparency-dogfood/1";
export const TRANSPARENCY_SIDECAR_PATH = "docs/evidence/transparency-sse-completion.json";
export const TRANSPARENCY_MARKDOWN_PATH = "docs/evidence/transparency-sse-completion.md";
export const TRANSPARENCY_DESIGN_PATH =
  "docs/superpowers/specs/2026-09-05-harness-transparency-sse-design.md";
export const TRANSPARENCY_DOGFOOD_COMMAND =
  "node scripts/dogfood-transparency-sse.mjs --samples 30";
export const TRANSPARENCY_DOGFOOD_REPORT_PATH = ".reports/acceptance/transparency-dogfood.json";
export const M4_RELEASE_REPORT_PATH = "docs/evidence/m4-local-multi-agent-scheduling-results.json";
export const TRANSPARENCY_STEADY_P95_BUDGET_MS = 1000;
export const TRANSPARENCY_DOGFOOD_MIN_SAMPLES = 30;

const ARTIFACT_KINDS = Object.freeze([
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
]);

const PERFORMANCE_EVIDENCE_PATH = "docs/evidence/2026-09-08-event-stream-perf.json";
const PERFORMANCE_REQUIRED_SCENARIOS = Object.freeze([
  "f-layout-discovery-poll",
  "e-layout-index-rss",
  "warm-poll-zero-history-reread",
  "shared-scan-4-caught-up-clients",
]);

function acceptanceEntry({ acceptance_id, statement, tasks, proof }) {
  return Object.freeze({
    acceptance_id,
    statement,
    design_anchor: "§11",
    tasks: Object.freeze(tasks),
    proof: Object.freeze(proof),
  });
}

function suiteProof(suites, trackedEvidence, extra = {}) {
  return {
    kind: "suite",
    suites: Object.freeze({ ...suites }),
    tracked_evidence: Object.freeze(trackedEvidence),
    ...extra,
  };
}

/**
 * Frozen HT acceptance contract (design §11). Statements are quoted verbatim
 * from the design table so this registry and the design cannot drift apart;
 * tests/reporting/transparency-evidence.test.ts enforces the quotation.
 */
export const TRANSPARENCY_ACCEPTANCE_REGISTRY = Object.freeze([
  acceptanceEntry({
    acceptance_id: "HT-AC-01",
    statement:
      "每条已提交本地/远程 Decision 恰好一条绑定正确的成果事件；孤立/未提交事件不可见；远程重试不重复",
    tasks: ["Task 1", "Task 3"],
    proof: suiteProof(
      {
        main: [
          "packages/core/test/ledger/repository.test.ts",
          "packages/runtime/test/approval/approval-decided-event.test.ts",
        ],
        fault: [
          "tests/fault/event-stream-recovery.test.ts",
          "tests/fault/remote-approval-materialization.test.ts",
        ],
      },
      [
        "packages/core/test/ledger/repository.test.ts",
        "packages/runtime/test/approval/approval-decided-event.test.ts",
        "tests/fault/event-stream-recovery.test.ts",
        "tests/fault/remote-approval-materialization.test.ts",
      ],
    ),
  }),
  acceptanceEntry({
    acceptance_id: "HT-AC-02",
    statement:
      "approve/reject 为终态、defer 仍 pending、EOF/Ctrl-C 无伪造决定；CLI/Dashboard 身份与时间一致，刷新能恢复",
    tasks: ["Task 3", "Task 4", "Task 5"],
    proof: suiteProof(
      {
        main: [
          "packages/runtime/test/approval/interaction.test.ts",
          "packages/runtime/test/observability/approval-summary.test.ts",
          "packages/cli/test/watch.test.ts",
        ],
        "playwright-dashboard": ["tests/e2e/dashboard-live-approval.test.ts"],
      },
      [
        "packages/runtime/test/approval/interaction.test.ts",
        "packages/runtime/test/observability/approval-summary.test.ts",
        "packages/cli/test/watch.test.ts",
        "tests/e2e/dashboard-live-approval.test.ts",
      ],
    ),
  }),
  acceptanceEntry({
    acceptance_id: "HT-AC-03",
    statement:
      "1.4 registry/pin/default Reader 完整；新读旧兼容、旧权威 Reader 明确升级阻断、未知类型与损坏分类正确",
    tasks: ["Task 1", "Task 3"],
    proof: suiteProof(
      {
        main: [
          "packages/core/test/protocol/protocol-1.4.test.ts",
          "packages/conformance/test/event-stream.conformance.test.ts",
        ],
      },
      [
        "packages/core/test/protocol/protocol-1.4.test.ts",
        "packages/conformance/src/event-stream.ts",
        "packages/conformance/test/event-stream.conformance.test.ts",
      ],
    ),
  }),
  acceptanceEntry({
    acceptance_id: "HT-AC-04",
    statement: "固定类别覆盖表、实际事件订阅、指定版本导航、安全正文读取及32 KiB运行时护栏均有测试",
    tasks: ["Task 4", "Task 5"],
    proof: suiteProof(
      {
        main: ["packages/runtime/test/observability/artifact-reader.test.ts"],
        security: ["tests/security/dashboard-artifact-boundaries.test.ts"],
        "playwright-dashboard": ["tests/e2e/dashboard-transparency.test.ts"],
      },
      [
        "packages/runtime/test/observability/artifact-reader.test.ts",
        "tests/security/dashboard-artifact-boundaries.test.ts",
        "tests/e2e/dashboard-transparency.test.ts",
        "docs/evidence/artifact-reference-coverage.md",
      ],
      {
        coverage_table: Object.freeze({
          path: "docs/evidence/artifact-reference-coverage.md",
          required_kinds: ARTIFACT_KINDS,
        }),
      },
    ),
  }),
  acceptanceEntry({
    acceptance_id: "HT-AC-05",
    statement: "§7.3 全部性能预算通过；冷启动、发现成本、内存、源读取与扇出输出分开报告",
    tasks: ["Task 1", "Task 2", "Task 6"],
    proof: suiteProof(
      { performance: ["tests/performance/event-stream-incremental.test.ts"] },
      [
        "tests/performance/event-stream-incremental.test.ts",
        "scripts/generate-performance-dataset.mjs",
        PERFORMANCE_EVIDENCE_PATH,
      ],
      {
        performance_evidence: Object.freeze({
          path: PERFORMANCE_EVIDENCE_PATH,
          warmup_rounds: 20,
          sample_rounds: 200,
          required_scenarios: PERFORMANCE_REQUIRED_SCENARIOS,
        }),
      },
    ),
  }),
  acceptanceEntry({
    acceptance_id: "HT-AC-06",
    statement:
      "相同时间戳/逆序id/迟到项读全；交接无空窗；过滤与背压隔离；reset/重连可恢复且UI幂等，Live缺口明确",
    tasks: ["Task 1", "Task 2", "Task 4"],
    proof: suiteProof(
      {
        main: [
          "packages/runtime/test/observability/event-stream.test.ts",
          "packages/runtime/test/observability/event-stream-recovery.test.ts",
          "packages/dashboard/test/event-hub.test.ts",
          "packages/dashboard/test/sse.test.ts",
          "packages/conformance/test/event-stream.conformance.test.ts",
        ],
        e2e: ["tests/e2e/sse-reconnect.test.ts"],
      },
      [
        "packages/runtime/test/observability/event-stream.test.ts",
        "packages/runtime/test/observability/event-stream-recovery.test.ts",
        "packages/dashboard/test/event-hub.test.ts",
        "packages/dashboard/test/sse.test.ts",
        "packages/conformance/test/event-stream.conformance.test.ts",
        "tests/e2e/sse-reconnect.test.ts",
      ],
    ),
  }),
  acceptanceEntry({
    acceptance_id: "HT-AC-07",
    statement: "仓库完整发布入口通过；旧客户端/旧项目兼容；HT验收机器报告绑定实现提交与不可变证据",
    tasks: ["Task 6"],
    proof: {
      kind: "release",
      release_report: M4_RELEASE_REPORT_PATH,
      dogfood_report: TRANSPARENCY_DOGFOOD_REPORT_PATH,
      min_samples: TRANSPARENCY_DOGFOOD_MIN_SAMPLES,
      steady_p95_budget_ms: TRANSPARENCY_STEADY_P95_BUDGET_MS,
      tracked_evidence: Object.freeze([
        "scripts/dogfood-transparency-sse.mjs",
        "scripts/lib/transparency-evidence.mjs",
        "scripts/verify-transparency-evidence.mjs",
        "tests/reporting/transparency-evidence.test.ts",
      ]),
    },
  }),
]);

export function transparencyCommands(registryEntry) {
  if (registryEntry.proof.kind === "release") {
    return ["pnpm test:release", TRANSPARENCY_DOGFOOD_COMMAND];
  }
  return Object.keys(registryEntry.proof.suites).map((suite) => CANONICAL_RELEASE_COMMANDS[suite]);
}

export function transparencyTrackedEvidencePaths() {
  return [
    ...new Set(TRANSPARENCY_ACCEPTANCE_REGISTRY.flatMap((entry) => entry.proof.tracked_evidence)),
  ].sort();
}

export class TransparencyEvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "TransparencyEvidenceError";
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

function git(repositoryRoot, args, encoding = "utf8") {
  try {
    return execFileSync("git", args, { cwd: repositoryRoot, encoding });
  } catch (error) {
    throw new TransparencyEvidenceError(
      `git ${args.join(" ")} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function suiteFileState(report, path) {
  const states = (report?.files ?? [])
    .filter((file) => file?.path === path)
    .map((file) => file?.state);
  if (states.includes("fail")) return "fail";
  if (states.includes("pass")) return "pass";
  return "missing";
}

/**
 * Derive the status of one registry entry purely from source evidence:
 * canonical suite reports, tracked bytes at the implementation commit and
 * generated worktree reports. Never trusts a previously written result.
 */
function deriveAcceptanceResult(
  registryEntry,
  { repositoryRoot, implementationCommit, suiteReports, readWorktreeBytes },
) {
  const proof = registryEntry.proof;
  const suiteDigests = {};
  const suiteInvocationIds = {};
  const proofDigests = {};
  const result = {
    acceptance_id: registryEntry.acceptance_id,
    statement: registryEntry.statement,
    design_anchor: registryEntry.design_anchor,
    tasks: registryEntry.tasks,
    commands: transparencyCommands(registryEntry),
    evidence: [...proof.tracked_evidence],
    status: "passed",
    detail: "canonical evidence passed",
    tracked_evidence_digest: digestTrackedEvidence(
      repositoryRoot,
      implementationCommit,
      proof.tracked_evidence,
    ),
  };
  // Every outcome — passed, failed or not_run — carries the same digest
  // envelope so a recorded result always binds the exact source bytes.
  const finalize = (status, detail) => {
    result.status = status;
    result.detail = detail;
    result.suite_result_digests = suiteDigests;
    result.suite_invocation_ids = suiteInvocationIds;
    result.proof_digests = proofDigests;
    result.evidence_digest = digestCanonicalResult({
      acceptance_id: result.acceptance_id,
      tracked_evidence_digest: result.tracked_evidence_digest,
      suite_result_digests: suiteDigests,
      proof_digests: proofDigests,
    });
    return result;
  };

  if (proof.kind === "release") {
    const releaseBytes = readWorktreeBytes(proof.release_report);
    if (releaseBytes === undefined) {
      return finalize("not_run", `${proof.release_report} is missing; run pnpm test:release first`);
    }
    proofDigests.release_report_sha256 = sha256Bytes(releaseBytes);
    const releaseFailure = checkReleaseReport(
      releaseBytes,
      implementationCommit,
      proof.release_report,
    );
    if (releaseFailure !== undefined) {
      return finalize("failed", releaseFailure);
    }
    const dogfoodBytes = readWorktreeBytes(proof.dogfood_report);
    if (dogfoodBytes === undefined) {
      return finalize(
        "not_run",
        `${proof.dogfood_report} is missing; run ${TRANSPARENCY_DOGFOOD_COMMAND} first`,
      );
    }
    proofDigests.dogfood_report_sha256 = sha256Bytes(dogfoodBytes);
    const dogfoodFailure = checkDogfoodReport(dogfoodBytes, implementationCommit, proof);
    if (dogfoodFailure !== undefined) {
      return finalize("failed", dogfoodFailure);
    }
    return finalize("passed", "canonical evidence passed");
  }

  for (const [suite, requiredFiles] of Object.entries(proof.suites)) {
    const report = suiteReports.get(suite);
    if (!isObject(report)) {
      return finalize(
        "not_run",
        `${suite}: canonical suite report is missing; run ${CANONICAL_RELEASE_COMMANDS[suite]}`,
      );
    }
    try {
      const invocationIds = assertCanonicalSuiteReports(
        new Map([[suite, report]]),
        { [suite]: CANONICAL_RELEASE_COMMANDS[suite] },
        implementationCommit,
        repositoryRoot,
      );
      suiteInvocationIds[suite] = invocationIds[suite];
    } catch (error) {
      if (error instanceof ReleaseEvidenceError) {
        return finalize("failed", error.message);
      }
      throw error;
    }
    for (const path of requiredFiles) {
      const state = suiteFileState(report, path);
      if (state === "fail") {
        return finalize("failed", `${suite}: ${path} failed`);
      }
      if (state !== "pass") {
        return finalize(
          "not_run",
          `${suite}: ${path} has no passing proof in the canonical report`,
        );
      }
    }
    suiteDigests[suite] = digestCanonicalResult(buildCanonicalSuiteProof(report, repositoryRoot));
  }

  if (proof.coverage_table !== undefined) {
    const content = readTrackedEvidence(
      repositoryRoot,
      implementationCommit,
      proof.coverage_table.path,
    ).toString("utf8");
    const missing = proof.coverage_table.required_kinds.filter((kind) => !content.includes(kind));
    if (missing.length > 0) {
      return finalize(
        "failed",
        `${proof.coverage_table.path} does not cover: ${missing.join(", ")}`,
      );
    }
  }

  if (proof.performance_evidence !== undefined) {
    let performanceEvidence;
    try {
      performanceEvidence = JSON.parse(
        readTrackedEvidence(
          repositoryRoot,
          implementationCommit,
          proof.performance_evidence.path,
        ).toString("utf8"),
      );
    } catch {
      return finalize(
        "failed",
        `${proof.performance_evidence.path} is not valid JSON at the implementation commit`,
      );
    }
    const performanceFailure = checkPerformanceEvidence(
      performanceEvidence,
      proof.performance_evidence,
    );
    if (performanceFailure !== undefined) {
      return finalize("failed", performanceFailure);
    }
  }

  return finalize("passed", "canonical evidence passed");
}

function checkReleaseReport(bytes, implementationCommit, path) {
  let report;
  try {
    report = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return `${path} is not valid JSON`;
  }
  if (!isObject(report) || report.schema_version !== "harness.m4-acceptance-results/1") {
    return `${path} is not the canonical M4 release sidecar`;
  }
  if (report.implementation_commit !== implementationCommit) {
    return `${path} is bound to a different implementation commit`;
  }
  if (!Array.isArray(report.results) || report.results.length !== 20) {
    return `${path} does not contain the complete 20-result release verdict`;
  }
  const notPassed = report.results.filter((entry) => entry?.status !== "passed");
  if (notPassed.length > 0) {
    return `${path} has non-passing results: ${notPassed
      .map((entry) => String(entry?.acceptance_id))
      .join(", ")}`;
  }
  if (report.results.some((entry) => !SHA256_PATTERN.test(entry?.evidence_digest ?? ""))) {
    return `${path} contains results without a bound evidence digest`;
  }
  return undefined;
}

function checkDogfoodReport(bytes, implementationCommit, proof) {
  let report;
  try {
    report = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return `${proof.dogfood_report} is not valid JSON`;
  }
  if (!isObject(report) || report.schema_version !== TRANSPARENCY_DOGFOOD_SCHEMA_VERSION) {
    return `${proof.dogfood_report} is not the transparency dogfood schema`;
  }
  if (report.implementation_commit !== implementationCommit) {
    return `${proof.dogfood_report} is bound to a different implementation commit`;
  }
  if (report.command !== TRANSPARENCY_DOGFOOD_COMMAND) {
    return `${proof.dogfood_report} was not produced by the canonical dogfood command`;
  }
  if (report.exit_code !== 0 || report.status !== "passed") {
    return `${proof.dogfood_report} records a failed dogfood run`;
  }
  const samples = report.steady_state?.samples;
  if (!Array.isArray(samples) || samples.length < proof.min_samples) {
    return `${proof.dogfood_report} has fewer than ${String(proof.min_samples)} real decisions`;
  }
  const p95 = report.steady_state?.p95_ms;
  if (
    typeof p95 !== "number" ||
    report.steady_state?.within_budget !== true ||
    p95 >= proof.steady_p95_budget_ms
  ) {
    return `${proof.dogfood_report} steady-state p95 does not meet the 1s budget`;
  }
  return undefined;
}

function checkPerformanceEvidence(evidence, expectation) {
  if (!isObject(evidence) || !Array.isArray(evidence.scenarios)) {
    return `${expectation.path} has no scenario samples`;
  }
  const method = evidence.method;
  if (
    method?.warmup_rounds !== expectation.warmup_rounds ||
    method?.sample_rounds !== expectation.sample_rounds
  ) {
    return `${expectation.path} does not record the §7.3 warmup/sample rounds`;
  }
  for (const name of expectation.required_scenarios) {
    if (!evidence.scenarios.some((scenario) => scenario?.name === name)) {
      return `${expectation.path} is missing scenario ${name}`;
    }
  }
  for (const scenario of evidence.scenarios) {
    if (!isObject(scenario)) return `${expectation.path} contains a malformed scenario`;
    if (
      typeof scenario.threshold_ms === "number" &&
      (typeof scenario.p95_ms !== "number" || scenario.p95_ms > scenario.threshold_ms)
    ) {
      return `${expectation.path} scenario ${String(scenario.name)} exceeds its p95 budget`;
    }
    if (
      typeof scenario.threshold_mib === "number" &&
      (typeof scenario.rss_delta_mib !== "number" ||
        scenario.rss_delta_mib > scenario.threshold_mib)
    ) {
      return `${expectation.path} scenario ${String(scenario.name)} exceeds its RSS budget`;
    }
  }
  return undefined;
}

/** Build the typed sidecar from source evidence only; never from a prior report. */
export function buildTransparencyAcceptanceSidecar({
  repositoryRoot,
  implementationCommit,
  suiteReports,
  readWorktreeBytes,
  generatedAt,
}) {
  if (!COMMIT_PATTERN.test(implementationCommit)) {
    throw new TransparencyEvidenceError("implementation commit must be a full commit SHA");
  }
  const results = TRANSPARENCY_ACCEPTANCE_REGISTRY.map((entry) =>
    deriveAcceptanceResult(entry, {
      repositoryRoot,
      implementationCommit,
      suiteReports,
      readWorktreeBytes,
    }),
  );
  const sidecar = {
    schema_version: TRANSPARENCY_REPORT_SCHEMA_VERSION,
    design: TRANSPARENCY_DESIGN_PATH,
    implementation_commit: implementationCommit,
    generated_at: generatedAt,
    results,
  };
  assertTransparencyAcceptanceSidecar(sidecar);
  return sidecar;
}

export function assertTransparencyAcceptanceSidecar(sidecar) {
  if (!isObject(sidecar) || sidecar.schema_version !== TRANSPARENCY_REPORT_SCHEMA_VERSION) {
    throw new TransparencyEvidenceError("transparency sidecar schema is missing or unsupported");
  }
  if (!COMMIT_PATTERN.test(sidecar.implementation_commit ?? "")) {
    throw new TransparencyEvidenceError("transparency sidecar must bind a full implementation SHA");
  }
  if (!Array.isArray(sidecar.results)) {
    throw new TransparencyEvidenceError("transparency sidecar results must be an array");
  }
  if (sidecar.results.length !== TRANSPARENCY_ACCEPTANCE_REGISTRY.length) {
    throw new TransparencyEvidenceError(
      `transparency sidecar must contain ${String(TRANSPARENCY_ACCEPTANCE_REGISTRY.length)} results`,
    );
  }
  const seen = new Set();
  for (const [index, entry] of sidecar.results.entries()) {
    const registryEntry = TRANSPARENCY_ACCEPTANCE_REGISTRY[index];
    if (!isObject(entry)) {
      throw new TransparencyEvidenceError("transparency sidecar result must be an object");
    }
    if (seen.has(entry.acceptance_id)) {
      throw new TransparencyEvidenceError(`duplicate acceptance id ${String(entry.acceptance_id)}`);
    }
    seen.add(entry.acceptance_id);
    if (entry.acceptance_id !== registryEntry.acceptance_id) {
      throw new TransparencyEvidenceError(
        `result ${String(index)} must be ${registryEntry.acceptance_id}`,
      );
    }
    if (
      entry.statement !== registryEntry.statement ||
      entry.design_anchor !== registryEntry.design_anchor ||
      JSON.stringify(entry.tasks) !== JSON.stringify(registryEntry.tasks) ||
      JSON.stringify(entry.commands) !== JSON.stringify(transparencyCommands(registryEntry)) ||
      JSON.stringify(entry.evidence) !== JSON.stringify([...registryEntry.proof.tracked_evidence])
    ) {
      throw new TransparencyEvidenceError(
        `${registryEntry.acceptance_id}: result drifted from the frozen registry`,
      );
    }
    if (!["passed", "failed", "blocked", "not_run"].includes(entry.status)) {
      throw new TransparencyEvidenceError(`${registryEntry.acceptance_id}: invalid status`);
    }
    if (!SHA256_PATTERN.test(entry.tracked_evidence_digest ?? "")) {
      throw new TransparencyEvidenceError(
        `${registryEntry.acceptance_id}: tracked evidence digest is invalid`,
      );
    }
    if (!SHA256_PATTERN.test(entry.evidence_digest ?? "")) {
      throw new TransparencyEvidenceError(
        `${registryEntry.acceptance_id}: evidence digest must be sha256`,
      );
    }
  }
  return sidecar;
}

function assertTreeConstraints(repositoryRoot, implementationCommit) {
  try {
    execFileSync("git", ["cat-file", "-e", `${implementationCommit}^{commit}`], {
      cwd: repositoryRoot,
      stdio: "ignore",
    });
  } catch {
    throw new TransparencyEvidenceError("implementation commit is not a commit in this repository");
  }
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", implementationCommit, "HEAD"], {
      cwd: repositoryRoot,
      stdio: "ignore",
    });
  } catch {
    throw new TransparencyEvidenceError("implementation commit is not an ancestor of HEAD");
  }
  const tracked = transparencyTrackedEvidencePaths();
  const changed = git(repositoryRoot, [
    "diff",
    "--name-only",
    implementationCommit,
    "HEAD",
    "--",
    ...tracked,
  ])
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean);
  if (changed.length > 0) {
    throw new TransparencyEvidenceError(
      `tracked evidence changed after the implementation commit: ${changed.join(", ")}`,
    );
  }
  const dirty = git(repositoryRoot, ["status", "--porcelain", "--", ...tracked])
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean);
  if (dirty.length > 0) {
    throw new TransparencyEvidenceError(
      `tracked evidence is dirty in the worktree: ${dirty.join(", ")}`,
    );
  }
}

/**
 * Re-derive every result from live source evidence and require the sidecar
 * to match exactly; a hand-edited "passed" cannot survive re-derivation.
 * Verification succeeds only when all seven acceptance items genuinely pass.
 */
export function verifyTransparencyEvidence({
  repositoryRoot,
  sidecar,
  suiteReports,
  readWorktreeBytes,
  markdown,
}) {
  assertTransparencyAcceptanceSidecar(sidecar);
  const implementationCommit = sidecar.implementation_commit;
  assertTreeConstraints(repositoryRoot, implementationCommit);
  const expected = buildTransparencyAcceptanceSidecar({
    repositoryRoot,
    implementationCommit,
    suiteReports,
    readWorktreeBytes,
    generatedAt: sidecar.generated_at,
  });
  for (const [index, entry] of expected.results.entries()) {
    const recorded = sidecar.results[index];
    for (const field of [
      "status",
      "detail",
      "tracked_evidence_digest",
      "suite_result_digests",
      "suite_invocation_ids",
      "proof_digests",
      "evidence_digest",
    ]) {
      if (JSON.stringify(recorded[field] ?? null) !== JSON.stringify(entry[field] ?? null)) {
        throw new TransparencyEvidenceError(
          `${entry.acceptance_id}: recorded ${field} does not match re-derived source evidence`,
        );
      }
    }
    if (entry.status !== "passed") {
      throw new TransparencyEvidenceError(`${entry.acceptance_id}: ${entry.detail}`);
    }
  }
  if (markdown !== undefined && markdown !== renderTransparencyMarkdown(sidecar)) {
    throw new TransparencyEvidenceError(
      "transparency Markdown is not the exact typed-sidecar projection",
    );
  }
  return { implementation_commit: implementationCommit, results: expected.results };
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

/** Render-only projection: every row originates in the typed JSON sidecar. */
export function renderTransparencyMarkdown(sidecar) {
  assertTransparencyAcceptanceSidecar(sidecar);
  const passed = sidecar.results.filter((entry) => entry.status === "passed").length;
  const lines = [
    "# 开发过程透明化与 SSE 呈现验收证据",
    "",
    "本文件由 `scripts/verify-transparency-evidence.mjs --generate` 对 typed JSON sidecar 做纯投影生成；结果区禁止人工改写。HT-AC-01～07 必须全部通过才能声明完成。",
    "",
    `- 设计锚点：[开发过程透明化与 SSE 呈现设计](../superpowers/specs/2026-09-05-harness-transparency-sse-design.md) §11`,
    `- 被评估实现 commit：\`${sidecar.implementation_commit}\``,
    `- 汇总：${String(passed)}/${String(sidecar.results.length)} 通过`,
    "",
    "| HT-AC | 必须证明的结果 | 责任任务 | 命令 | Evidence digest | 结果 | 说明 |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const entry of sidecar.results) {
    lines.push(
      `| ${escapeCell(entry.acceptance_id)} | ${escapeCell(entry.statement)} | ${escapeCell(entry.tasks.join("、"))} | ${escapeCell(entry.commands.map((command) => `\`${command}\``).join("<br>"))} | \`${entry.evidence_digest.slice(0, 16)}\` | ${escapeCell(entry.status)} | ${escapeCell(entry.detail)} |`,
    );
  }
  lines.push(
    "",
    passed === sidecar.results.length
      ? "HT-AC-01～07 全部具有绑定同一实现提交的机器证据，完成声明成立。"
      : "完成声明不成立；未通过项必须补齐机器证据后重新生成。",
    "",
  );
  return lines.join("\n");
}
