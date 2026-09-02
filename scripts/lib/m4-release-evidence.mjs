import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

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

function ac(id, statement, required_suites, evidence, dogfood_rule, readiness_rule) {
  return Object.freeze({
    acceptance_id: id,
    statement,
    required_suites: Object.freeze(required_suites),
    evidence: Object.freeze(evidence),
    ...(dogfood_rule === undefined ? {} : { dogfood_rule }),
    ...(readiness_rule === undefined ? {} : { readiness_rule }),
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
      ".reports/acceptance/m4-dogfood.json",
    ],
    undefined,
    "production_policy_source",
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
    [
      "packages/dashboard/test/scheduler-api.test.ts",
      "tests/e2e/dashboard-m4-scheduler.test.ts",
      ".reports/acceptance/m4-dogfood.json",
    ],
    undefined,
    "dashboard_controls",
  ),
  ac(
    "AC-17",
    "CLI run/resume/status/watch/abort 形成闭环，CLI 与 Dashboard 对同一 Operation 保持 单驱动。",
    ["main", "fault"],
    [
      "packages/cli/test/m4-scheduling.test.ts",
      "tests/fault/m4-scheduler-crash-matrix.test.ts",
      ".reports/acceptance/m4-dogfood.json",
    ],
    undefined,
    "approval_live_driver",
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
    ...(registryEntry.dogfood_rule === undefined && registryEntry.readiness_rule === undefined
      ? []
      : ["pnpm dogfood:m4"]),
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

function expectedConfigPath(repositoryRoot, suite) {
  return resolve(repositoryRoot, expectedConfigRepositoryPath(suite));
}

function expectedConfigRepositoryPath(suite) {
  return suite === "performance"
    ? "vitest.performance.ts"
    : suite === "playwright-dashboard"
      ? "playwright.dashboard.config.ts"
      : "vitest.workspace.ts";
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
export function assertCanonicalSuiteReports(
  reports,
  commands,
  implementationCommit,
  repositoryRoot,
) {
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
    if (
      repositoryRoot !== undefined &&
      report.config_path !== expectedConfigPath(repositoryRoot, suite)
    ) {
      throw new ReleaseEvidenceError(`${suite}: config is not the repository canonical config`);
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

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function digestCanonicalResult(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

/** Persistable, redacted proof of exactly what a canonical suite executed. */
export function buildCanonicalSuiteProof(report, repositoryRoot) {
  if (!isObject(report)) throw new ReleaseEvidenceError("suite proof source is malformed");
  const configPath = expectedConfigPath(repositoryRoot, report.suite);
  if (report.config_path !== configPath) {
    throw new ReleaseEvidenceError(`${String(report.suite)}: suite proof config drifted`);
  }
  const files = [...report.files]
    .map((file) => ({ path: file.path, state: file.state }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    schema_version: report.schema_version,
    suite: report.suite,
    implementation_commit: report.implementation_commit,
    started_commit: report.started_commit,
    finished_commit: report.finished_commit,
    invocation_id: report.invocation_id,
    command: report.command,
    coverage: report.coverage,
    config_path: relative(repositoryRoot, configPath).split("\\").join("/"),
    tracked_worktree_clean_at_start: report.tracked_worktree_clean_at_start,
    tracked_worktree_clean_at_finish: report.tracked_worktree_clean_at_finish,
    files_total: report.files_total,
    files_failed: report.files_failed,
    failed_files: [...report.failed_files].sort(),
    files,
    exit_semantics: {
      runner: report.suite === "playwright-dashboard" ? "playwright" : "vitest",
      success_condition: "no_failed_files_and_runner_success",
      observed_success:
        report.files_failed === 0 && (report.status === undefined || report.status === "passed"),
    },
  };
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function publicArray(value) {
  return Array.isArray(value) ? value : [];
}

function buildProvenanceSummary(value) {
  if (!isObject(value)) return null;
  return {
    implementation_commit: value.implementation_commit ?? null,
    source_head: value.source_head ?? null,
    source_head_matches_implementation_commit:
      value.source_head_matches_implementation_commit ?? false,
    tracked_source_clean: value.tracked_source_clean ?? false,
    build_command: value.build_command ?? null,
    clean_rebuild_from_committed_archive: value.clean_rebuild_from_committed_archive ?? false,
    root_package_json_sha256: value.root_package_json_sha256 ?? null,
    lockfile_sha256: value.lockfile_sha256 ?? null,
    runtime_dependency_closure: publicArray(value.runtime_dependency_closure),
    package_count: publicArray(value.packages).length,
    external_runtime_dependency_count: publicArray(value.external_runtime_dependencies).length,
    provenance_sha256: value.provenance_sha256 ?? null,
  };
}

function providerProbeSummary(value) {
  if (!isObject(value)) return null;
  const verification = isObject(value.verification) ? value.verification : {};
  return {
    verification_status: value.verification_status ?? null,
    task_id: value.task_id ?? null,
    agent_outcome_claim: value.agent_outcome_claim ?? null,
    termination_reason: value.termination_reason ?? null,
    workspace_verification_status: verification.status ?? null,
    output_exists: verification.output_exists ?? false,
    output_regular_file: verification.output_regular_file ?? false,
    output_realpath_contained: verification.output_realpath_contained ?? false,
    exact_bytes_match: verification.exact_bytes_match ?? false,
    only_allowed_path_changed: verification.only_allowed_path_changed ?? false,
    unauthorized_path_count: publicArray(verification.unauthorized_paths).length,
  };
}

function schedulerEligibilitySummary(value) {
  if (!isObject(value)) return null;
  return {
    status: value.status ?? null,
    unattended_eligible: value.unattended_eligible ?? null,
    reasons: publicArray(value.reasons),
    ac_06: value.ac_06 ?? null,
    ac_20: value.ac_20 ?? null,
    prerequisite_status: value.prerequisite_status ?? null,
  };
}

function usageSummary(value) {
  if (!isObject(value)) return null;
  return {
    metering: value.metering ?? null,
    input_tokens: value.input_tokens ?? null,
    output_tokens: value.output_tokens ?? null,
    total_tokens: value.total_tokens ?? null,
  };
}

function supervisedProbeSummary(value) {
  if (!isObject(value)) return null;
  return {
    task_id: value.task_id ?? null,
    outcome: value.outcome ?? null,
    termination_reason: value.termination_reason ?? null,
    output_exists: value.output_exists ?? false,
    exact_bytes_match: value.exact_bytes_match ?? false,
    only_allowed_path_changed: value.only_allowed_path_changed ?? false,
    changed_path_count: publicArray(value.changed_paths).length,
    evidence: publicArray(value.evidence).map((entry) => ({
      kind: isObject(entry) ? (entry.kind ?? null) : null,
      digest: isObject(entry) ? (entry.digest ?? null) : null,
    })),
    duration_ms: value.duration_ms ?? null,
  };
}

function featureReadinessSummary(value) {
  const source = isObject(value) ? value : {};
  return {
    production_policy_source: source.production_policy_source ?? "not_proven",
    dashboard_provider_context: source.dashboard_provider_context ?? "not_proven",
    dashboard_policy_proposal: source.dashboard_policy_proposal ?? "not_proven",
    approval_live_driver_auto_wake: source.approval_live_driver_auto_wake ?? "not_proven",
  };
}

function overlapIntervalSummary(value) {
  return publicArray(value).map((entry) => ({
    task_id: isObject(entry) ? (entry.task_id ?? null) : null,
    started_at: isObject(entry) ? (entry.started_at ?? null) : null,
    finished_at: isObject(entry) ? (entry.finished_at ?? null) : null,
    start_ms: isObject(entry) ? (entry.start_ms ?? null) : null,
    end_ms: isObject(entry) ? (entry.end_ms ?? null) : null,
  }));
}

function containsMachineAbsolutePath(value) {
  if (typeof value === "string") {
    return isAbsolute(value) || /(?:^|\s)[A-Za-z]:[\\/]/u.test(value);
  }
  if (Array.isArray(value)) return value.some(containsMachineAbsolutePath);
  if (isObject(value)) return Object.values(value).some(containsMachineAbsolutePath);
  return false;
}

/** Persist only the frozen, redacted subset of the real-provider dogfood result. */
export function buildCanonicalDogfoodProof(dogfood, implementationCommit) {
  if (!isObject(dogfood)) return { present: false, implementation_commit: implementationCommit };
  if (dogfood.implementation_commit !== implementationCommit) {
    throw new ReleaseEvidenceError("M4 dogfood implementation commit is stale");
  }
  if (
    dogfood.credential_material_recorded !== false ||
    dogfood.credential_material_hashed !== false
  ) {
    throw new ReleaseEvidenceError("M4 dogfood must not retain or hash credential material");
  }
  const proof = {
    present: true,
    schema_version: dogfood.schema_version,
    implementation_commit: dogfood.implementation_commit,
    status: dogfood.status,
    blocker: dogfood.blocker ?? null,
    command: dogfood.command ?? null,
    exit_code: dogfood.exit_code ?? null,
    provider: dogfood.provider ?? null,
    provider_profile: dogfood.provider_profile ?? null,
    provider_model: dogfood.provider_model ?? null,
    provider_model_source: dogfood.provider_model_source ?? null,
    expected_provider_version: dogfood.expected_provider_version ?? null,
    expected_provider_version_source: dogfood.expected_provider_version_source ?? null,
    observed_provider_version: dogfood.observed_provider_version ?? null,
    credential_source: dogfood.credential_source ?? null,
    credential_material_recorded: false,
    credential_material_hashed: false,
    build_provenance: buildProvenanceSummary(dogfood.build_provenance),
    adapter_manifest_digest: dogfood.adapter_manifest_digest ?? null,
    requested_task_count: dogfood.requested_task_count ?? null,
    requested_max_concurrency: dogfood.requested_max_concurrency ?? null,
    requested_wave_count: dogfood.requested_wave_count ?? null,
    effective_max_concurrency: dogfood.effective_max_concurrency ?? null,
    unattended_eligible: dogfood.unattended_eligible ?? null,
    eligibility_reasons: publicArray(dogfood.eligibility_reasons),
    provider_probe: providerProbeSummary(dogfood.provider_probe),
    scheduler_eligibility: schedulerEligibilitySummary(dogfood.scheduler_eligibility),
    adapter_reported_usage: usageSummary(dogfood.adapter_reported_usage),
    supervised_probe: supervisedProbeSummary(dogfood.supervised_probe),
    feature_readiness: featureReadinessSummary(dogfood.feature_readiness),
    overlap_proven: dogfood.overlap_proven ?? false,
    overlap_intervals: overlapIntervalSummary(dogfood.overlap_intervals),
    gate_status: dogfood.gate_status ?? null,
    evaluation_status: dogfood.evaluation_status ?? null,
    snapshot_status: dogfood.snapshot_status ?? null,
    wave_integration_count: dogfood.wave_integration_count ?? null,
    raw_transcript_persisted_in_release_bundle:
      dogfood.raw_transcript_persisted_in_release_bundle ?? null,
    command_executable_basename: dogfood.command_executable_basename ?? null,
  };
  if (containsMachineAbsolutePath(proof)) {
    throw new ReleaseEvidenceError("M4 dogfood release proof contains a machine absolute path");
  }
  assertCanonicalDogfoodProof(proof, implementationCommit);
  return proof;
}

function assertExactKeys(value, expected, label) {
  if (!isObject(value)) throw new ReleaseEvidenceError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(canonical)) {
    throw new ReleaseEvidenceError(`${label} fields drifted from the frozen projection`);
  }
}

function assertCanonicalDogfoodProof(proof, implementationCommit) {
  if (!isObject(proof)) throw new ReleaseEvidenceError("M4 dogfood proof is malformed");
  if (proof.present === false) {
    assertExactKeys(proof, ["present", "implementation_commit"], "M4 absent dogfood proof");
    if (proof.implementation_commit !== implementationCommit) {
      throw new ReleaseEvidenceError("M4 absent dogfood proof commit drifted");
    }
    return;
  }
  assertExactKeys(
    proof,
    [
      "present",
      "schema_version",
      "implementation_commit",
      "status",
      "blocker",
      "command",
      "exit_code",
      "provider",
      "provider_profile",
      "provider_model",
      "provider_model_source",
      "expected_provider_version",
      "expected_provider_version_source",
      "observed_provider_version",
      "credential_source",
      "credential_material_recorded",
      "credential_material_hashed",
      "build_provenance",
      "adapter_manifest_digest",
      "requested_task_count",
      "requested_max_concurrency",
      "requested_wave_count",
      "effective_max_concurrency",
      "unattended_eligible",
      "eligibility_reasons",
      "provider_probe",
      "scheduler_eligibility",
      "adapter_reported_usage",
      "supervised_probe",
      "feature_readiness",
      "overlap_proven",
      "overlap_intervals",
      "gate_status",
      "evaluation_status",
      "snapshot_status",
      "wave_integration_count",
      "raw_transcript_persisted_in_release_bundle",
      "command_executable_basename",
    ],
    "M4 dogfood proof",
  );
  if (
    proof.present !== true ||
    proof.schema_version !== 1 ||
    proof.implementation_commit !== implementationCommit ||
    !["passed", "blocked", "failed"].includes(proof.status) ||
    proof.credential_material_recorded !== false ||
    proof.credential_material_hashed !== false ||
    proof.raw_transcript_persisted_in_release_bundle !== false ||
    containsMachineAbsolutePath(proof)
  ) {
    throw new ReleaseEvidenceError("M4 dogfood proof violates release safety invariants");
  }
  for (const [field, value] of Object.entries({
    provider: proof.provider,
    provider_profile: proof.provider_profile,
    provider_model: proof.provider_model,
    provider_model_source: proof.provider_model_source,
    expected_provider_version: proof.expected_provider_version,
    expected_provider_version_source: proof.expected_provider_version_source,
    observed_provider_version: proof.observed_provider_version,
    credential_source: proof.credential_source,
    command_executable_basename: proof.command_executable_basename,
  })) {
    assertString(value, field, "M4 dogfood proof");
  }
  if (proof.expected_provider_version !== proof.observed_provider_version) {
    throw new ReleaseEvidenceError("M4 dogfood provider version does not match its contract");
  }
  if (!SHA256_PATTERN.test(proof.adapter_manifest_digest ?? "")) {
    throw new ReleaseEvidenceError("M4 dogfood Adapter manifest digest is invalid");
  }
  assertExactKeys(
    proof.build_provenance,
    [
      "implementation_commit",
      "source_head",
      "source_head_matches_implementation_commit",
      "tracked_source_clean",
      "build_command",
      "clean_rebuild_from_committed_archive",
      "root_package_json_sha256",
      "lockfile_sha256",
      "runtime_dependency_closure",
      "package_count",
      "external_runtime_dependency_count",
      "provenance_sha256",
    ],
    "M4 dogfood build provenance",
  );
  if (
    proof.build_provenance.implementation_commit !== implementationCommit ||
    proof.build_provenance.source_head !== implementationCommit ||
    proof.build_provenance.source_head_matches_implementation_commit !== true ||
    proof.build_provenance.tracked_source_clean !== true ||
    proof.build_provenance.build_command !== "pnpm build" ||
    proof.build_provenance.clean_rebuild_from_committed_archive !== true ||
    !SHA256_PATTERN.test(proof.build_provenance.root_package_json_sha256 ?? "") ||
    !SHA256_PATTERN.test(proof.build_provenance.lockfile_sha256 ?? "") ||
    !SHA256_PATTERN.test(proof.build_provenance.provenance_sha256 ?? "") ||
    !Array.isArray(proof.build_provenance.runtime_dependency_closure) ||
    proof.build_provenance.runtime_dependency_closure.length === 0
  ) {
    throw new ReleaseEvidenceError("M4 dogfood build provenance is incomplete or stale");
  }
  assertExactKeys(
    proof.adapter_reported_usage,
    ["metering", "input_tokens", "output_tokens", "total_tokens"],
    "M4 dogfood usage",
  );
  for (const tokenCount of [
    proof.adapter_reported_usage.input_tokens,
    proof.adapter_reported_usage.output_tokens,
    proof.adapter_reported_usage.total_tokens,
  ]) {
    if (tokenCount !== null && (!Number.isSafeInteger(tokenCount) || tokenCount < 0)) {
      throw new ReleaseEvidenceError("M4 dogfood usage contains an invalid token count");
    }
  }
  assertExactKeys(
    proof.provider_probe,
    [
      "verification_status",
      "task_id",
      "agent_outcome_claim",
      "termination_reason",
      "workspace_verification_status",
      "output_exists",
      "output_regular_file",
      "output_realpath_contained",
      "exact_bytes_match",
      "only_allowed_path_changed",
      "unauthorized_path_count",
    ],
    "M4 dogfood provider probe",
  );
  assertExactKeys(
    proof.scheduler_eligibility,
    ["status", "unattended_eligible", "reasons", "ac_06", "ac_20", "prerequisite_status"],
    "M4 dogfood scheduler eligibility",
  );
  assertExactKeys(
    proof.supervised_probe,
    [
      "task_id",
      "outcome",
      "termination_reason",
      "output_exists",
      "exact_bytes_match",
      "only_allowed_path_changed",
      "changed_path_count",
      "evidence",
      "duration_ms",
    ],
    "M4 dogfood supervised probe",
  );
  for (const evidence of proof.supervised_probe.evidence) {
    assertExactKeys(evidence, ["kind", "digest"], "M4 dogfood supervised Evidence");
    if (!SHA256_PATTERN.test(evidence.digest ?? "")) {
      throw new ReleaseEvidenceError("M4 dogfood supervised Evidence digest is invalid");
    }
  }
  for (const interval of proof.overlap_intervals) {
    assertExactKeys(
      interval,
      ["task_id", "started_at", "finished_at", "start_ms", "end_ms"],
      "M4 dogfood overlap interval",
    );
  }
  assertExactKeys(
    proof.feature_readiness,
    [
      "production_policy_source",
      "dashboard_provider_context",
      "dashboard_policy_proposal",
      "approval_live_driver_auto_wake",
    ],
    "M4 dogfood feature readiness",
  );
  for (const status of Object.values(proof.feature_readiness)) {
    if (!["verified", "not_proven"].includes(status)) {
      throw new ReleaseEvidenceError("M4 dogfood feature readiness status is invalid");
    }
  }
}

function suiteFileState(suiteProofs, requiredSuites, path) {
  const states = requiredSuites.flatMap((suite) =>
    (suiteProofs[suite]?.files ?? [])
      .filter((file) => file.path === path)
      .map((file) => file.state),
  );
  if (states.includes("fail")) return "fail";
  if (states.includes("pass")) return "pass";
  return "missing";
}

function dogfoodRuleStatus(rule, proof) {
  if (rule === undefined) return { status: "passed", detail: "canonical suites passed" };
  if (proof.present !== true) return { status: "not_run", detail: "dogfood Evidence is missing" };
  if (proof.status === "failed") return { status: "failed", detail: "dogfood execution failed" };
  if (rule === "adapter_eligibility") {
    const ineligibleBlocked =
      proof.provider_probe?.verification_status === "verified" &&
      proof.provider_probe?.workspace_verification_status === "passed" &&
      proof.provider_probe?.exact_bytes_match === true &&
      proof.provider_probe?.only_allowed_path_changed === true &&
      proof.unattended_eligible === false &&
      proof.effective_max_concurrency === 1 &&
      proof.scheduler_eligibility?.status === "blocked" &&
      proof.blocker === "real_adapter_unattended_ineligible";
    return ineligibleBlocked
      ? { status: "passed", detail: "real ineligible Adapter was mechanically clamped and blocked" }
      : { status: "blocked", detail: "Adapter eligibility proof is incomplete" };
  }
  const parallelComplete =
    proof.status === "passed" &&
    proof.unattended_eligible === true &&
    proof.scheduler_eligibility?.status === "eligible" &&
    proof.requested_task_count >= 4 &&
    proof.requested_wave_count >= 2 &&
    proof.effective_max_concurrency >= 2 &&
    proof.overlap_proven === true &&
    Array.isArray(proof.overlap_intervals) &&
    proof.overlap_intervals.length >= 2;
  if (rule === "parallel_overlap") {
    return parallelComplete
      ? { status: "passed", detail: "real Task intervals prove parallel overlap" }
      : { status: "blocked", detail: "real parallel overlap proof is incomplete" };
  }
  const verticalComplete =
    parallelComplete &&
    proof.gate_status === "passed" &&
    proof.evaluation_status === "passed" &&
    proof.snapshot_status === "completed" &&
    proof.wave_integration_count >= 2;
  return verticalComplete
    ? { status: "passed", detail: "real dogfood completed Gate/Evaluate/Snapshot" }
    : {
        status: "blocked",
        detail: "full real Scheduler/Gate/Evaluate/Snapshot dogfood is incomplete",
      };
}

function readinessRuleStatus(rule, proof) {
  if (rule === undefined) return { status: "passed", detail: "no extra readiness proof required" };
  const readiness = proof.feature_readiness;
  const verified =
    rule === "production_policy_source"
      ? readiness?.production_policy_source === "verified"
      : rule === "dashboard_controls"
        ? readiness?.dashboard_provider_context === "verified" &&
          readiness?.dashboard_policy_proposal === "verified"
        : readiness?.approval_live_driver_auto_wake === "verified";
  return verified
    ? { status: "passed", detail: `${rule} readiness is machine-verified` }
    : { status: "blocked", detail: `${rule} readiness is not machine-verified` };
}

function combineProofStatuses(...proofs) {
  for (const status of ["failed", "not_run", "blocked"]) {
    const match = proofs.find((proof) => proof.status === status);
    if (match !== undefined) return match;
  }
  return proofs[proofs.length - 1];
}

function acceptanceDigestPayload(result) {
  return {
    acceptance_id: result.acceptance_id,
    tracked_evidence_digest: result.tracked_evidence_digest,
    suite_result_digests: result.suite_result_digests,
    dogfood_result_digest: result.dogfood_result_digest ?? null,
  };
}

export function buildM4AcceptanceSidecar({
  repositoryRoot,
  implementationCommit,
  suiteReports,
  dogfood,
  generatedAt,
}) {
  const suiteInvocationIds = assertCanonicalSuiteReports(
    suiteReports,
    CANONICAL_RELEASE_COMMANDS,
    implementationCommit,
    repositoryRoot,
  );
  const suiteResults = Object.fromEntries(
    Object.keys(CANONICAL_RELEASE_COMMANDS).map((suite) => [
      suite,
      buildCanonicalSuiteProof(suiteReports.get(suite), repositoryRoot),
    ]),
  );
  const suiteResultDigests = Object.fromEntries(
    Object.entries(suiteResults).map(([suite, proof]) => [suite, digestCanonicalResult(proof)]),
  );
  const dogfoodResult = buildCanonicalDogfoodProof(dogfood, implementationCommit);
  const dogfoodResultDigest = digestCanonicalResult(dogfoodResult);
  const results = M4_ACCEPTANCE_REGISTRY.map((registryEntry) => {
    const trackedPaths = registryEntry.evidence.filter((path) => !path.startsWith(".reports/"));
    const trackedEvidenceDigest = digestTrackedEvidence(
      repositoryRoot,
      implementationCommit,
      trackedPaths,
    );
    const requiredSuiteDigests = Object.fromEntries(
      registryEntry.required_suites.map((suite) => [suite, suiteResultDigests[suite]]),
    );
    const testEvidence = registryEntry.evidence.filter(
      (path) => !path.startsWith("scripts/") && !path.startsWith(".reports/"),
    );
    const fileStates = testEvidence.map((path) =>
      suiteFileState(suiteResults, registryEntry.required_suites, path),
    );
    const suiteStatus = fileStates.includes("fail")
      ? "failed"
      : fileStates.includes("missing")
        ? "not_run"
        : "passed";
    const dogfoodStatus = dogfoodRuleStatus(registryEntry.dogfood_rule, dogfoodResult);
    const readinessStatus = readinessRuleStatus(registryEntry.readiness_rule, dogfoodResult);
    const supplementalStatus = combineProofStatuses(dogfoodStatus, readinessStatus);
    const status = suiteStatus === "passed" ? supplementalStatus.status : suiteStatus;
    const result = {
      acceptance_id: registryEntry.acceptance_id,
      statement: registryEntry.statement,
      status,
      required_suites: registryEntry.required_suites,
      suite_invocation_ids: Object.fromEntries(
        registryEntry.required_suites.map((suite) => [suite, suiteInvocationIds[suite]]),
      ),
      commands: m4Commands(registryEntry),
      evidence: registryEntry.evidence,
      tracked_evidence_digest: trackedEvidenceDigest,
      suite_result_digests: requiredSuiteDigests,
      ...(registryEntry.dogfood_rule === undefined && registryEntry.readiness_rule === undefined
        ? {}
        : { dogfood_result_digest: dogfoodResultDigest }),
      design_section: "§24",
      detail:
        suiteStatus === "failed"
          ? "at least one canonical suite Evidence file failed"
          : suiteStatus === "not_run"
            ? "at least one required Evidence file is absent from canonical suite results"
            : supplementalStatus.detail,
    };
    return { ...result, evidence_digest: digestCanonicalResult(acceptanceDigestPayload(result)) };
  });
  const sidecar = {
    schema_version: M4_RESULTS_SCHEMA_VERSION,
    milestone: "M4",
    implementation_commit: implementationCommit,
    generated_at: generatedAt,
    suite_invocation_ids: suiteInvocationIds,
    suite_results: suiteResults,
    suite_result_digests: suiteResultDigests,
    dogfood_result: dogfoodResult,
    dogfood_result_digest: dogfoodResultDigest,
    results,
  };
  assertM4AcceptanceSidecar(sidecar, { requireComplete: true });
  return sidecar;
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
      const proof = sidecar.suite_results?.[suite];
      if (!isObject(proof)) {
        throw new ReleaseEvidenceError(`${suite}: persisted suite proof is missing`);
      }
      if (
        proof.suite !== suite ||
        proof.command !== CANONICAL_RELEASE_COMMANDS[suite] ||
        proof.config_path !== expectedConfigRepositoryPath(suite) ||
        proof.coverage !== "full" ||
        proof.implementation_commit !== sidecar.implementation_commit ||
        proof.started_commit !== sidecar.implementation_commit ||
        proof.finished_commit !== sidecar.implementation_commit ||
        proof.tracked_worktree_clean_at_start !== true ||
        proof.tracked_worktree_clean_at_finish !== true ||
        proof.files_failed !== 0 ||
        proof.files_total !== proof.files?.length ||
        proof.exit_semantics?.observed_success !== true
      ) {
        throw new ReleaseEvidenceError(`${suite}: persisted suite proof is not release-passing`);
      }
      if (proof.invocation_id !== sidecar.suite_invocation_ids[suite]) {
        throw new ReleaseEvidenceError(`${suite}: persisted invocation identity drifted`);
      }
      if (sidecar.suite_result_digests?.[suite] !== digestCanonicalResult(proof)) {
        throw new ReleaseEvidenceError(`${suite}: persisted result digest mismatch`);
      }
    }
    if (
      !isObject(sidecar.dogfood_result) ||
      sidecar.dogfood_result_digest !== digestCanonicalResult(sidecar.dogfood_result)
    ) {
      throw new ReleaseEvidenceError("M4 dogfood result digest mismatch");
    }
    assertCanonicalDogfoodProof(sidecar.dogfood_result, sidecar.implementation_commit);
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
    if (options.requireComplete === true) {
      if (!/^[a-f0-9]{64}$/u.test(entry.tracked_evidence_digest ?? "")) {
        throw new ReleaseEvidenceError(`${expectedId}: tracked Evidence digest is invalid`);
      }
      const expectedSuiteDigests = Object.fromEntries(
        registryEntry.required_suites.map((suite) => [suite, sidecar.suite_result_digests[suite]]),
      );
      if (JSON.stringify(entry.suite_result_digests) !== JSON.stringify(expectedSuiteDigests)) {
        throw new ReleaseEvidenceError(`${expectedId}: suite result digests drifted`);
      }
      if (
        registryEntry.dogfood_rule === undefined && registryEntry.readiness_rule === undefined
          ? entry.dogfood_result_digest !== undefined
          : entry.dogfood_result_digest !== sidecar.dogfood_result_digest
      ) {
        throw new ReleaseEvidenceError(`${expectedId}: dogfood result digest drifted`);
      }
      const expectedEvidenceDigest = digestCanonicalResult(acceptanceDigestPayload(entry));
      if (entry.evidence_digest !== expectedEvidenceDigest) {
        throw new ReleaseEvidenceError(`${expectedId}: combined Evidence digest mismatch`);
      }
      const testEvidence = registryEntry.evidence.filter(
        (path) => !path.startsWith("scripts/") && !path.startsWith(".reports/"),
      );
      const fileStates = testEvidence.map((path) =>
        suiteFileState(sidecar.suite_results, registryEntry.required_suites, path),
      );
      const suiteStatus = fileStates.includes("fail")
        ? "failed"
        : fileStates.includes("missing")
          ? "not_run"
          : "passed";
      const dogfoodStatus = dogfoodRuleStatus(registryEntry.dogfood_rule, sidecar.dogfood_result);
      const readinessStatus = readinessRuleStatus(
        registryEntry.readiness_rule,
        sidecar.dogfood_result,
      );
      const expectedStatus =
        suiteStatus === "passed"
          ? combineProofStatuses(dogfoodStatus, readinessStatus).status
          : suiteStatus;
      if (entry.status !== expectedStatus) {
        throw new ReleaseEvidenceError(`${expectedId}: status is not derived from persisted proof`);
      }
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
  const dogfood = sidecar.dogfood_result;
  lines.push(
    !isObject(dogfood) || dogfood.present !== true
      ? "- 未找到 `.reports/acceptance/m4-dogfood.json`。"
      : `- provider=${String(dogfood.provider)}；profile=${String(dogfood.provider_profile)}；model=${String(dogfood.provider_model)}（${String(dogfood.provider_model_source)}）；version expected=${String(dogfood.expected_provider_version)} / observed=${String(dogfood.observed_provider_version)}；exit=${String(dogfood.exit_code)}。`,
  );
  if (isObject(dogfood) && dogfood.present === true) {
    lines.push(
      `- credential source=${String(dogfood.credential_source)}；material recorded=${String(dogfood.credential_material_recorded)}；material hashed=${String(dogfood.credential_material_hashed)}。`,
      `- usage metering=${String(dogfood.adapter_reported_usage?.metering)}；input/output/total=${String(dogfood.adapter_reported_usage?.input_tokens)}/${String(dogfood.adapter_reported_usage?.output_tokens)}/${String(dogfood.adapter_reported_usage?.total_tokens)}。`,
      `- build commit=${String(dogfood.build_provenance?.implementation_commit)}；clean archive rebuild=${String(dogfood.build_provenance?.clean_rebuild_from_committed_archive)}；runtime packages=${String(dogfood.build_provenance?.package_count)}；provenance=${String(dogfood.build_provenance?.provenance_sha256).slice(0, 16)}。`,
      `- requested concurrency=${String(dogfood.requested_max_concurrency)}，effective concurrency=${String(dogfood.effective_max_concurrency)}；blocker=${String(dogfood.blocker)}。`,
    );
  }
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
  for (const [index, registryEntry] of M4_ACCEPTANCE_REGISTRY.entries()) {
    const trackedPaths = registryEntry.evidence.filter((path) => !path.startsWith(".reports/"));
    const expectedDigest = digestTrackedEvidence(repositoryRoot, parent, trackedPaths);
    if (sidecar.results[index]?.tracked_evidence_digest !== expectedDigest) {
      throw new ReleaseEvidenceError(
        `${registryEntry.acceptance_id}: tracked Evidence does not match the implementation parent`,
      );
    }
  }
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
