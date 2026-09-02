import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const M4_FAULT_INVARIANTS = [
  "no_duplicate_process_acceptance",
  "no_duplicate_integration",
  "no_stale_fencing_acceptance",
  "no_incorrect_budget_return",
  "no_ref_ledger_split",
  "no_false_success",
];

/** Exact executable cases over production fault seams; never source indexing. */
export const M4_FAULT_CASES = [
  {
    id: "lease_commit_before_process",
    file: "tests/fault/m4-lease-budget-boundaries.test.ts",
    test: "treats a kill at the commit point as durable and replays idempotently",
  },
  {
    id: "process_start_before_pid_projection",
    file: "packages/runtime/test/scheduling/scheduler.test.ts",
    test: "fails closed when a granted Lease has no live driver, then recover() revokes and retries",
  },
  {
    id: "agent_result_before_evidence",
    file: "packages/runtime/test/scheduling/scheduler.test.ts",
    test: "rejects results carrying a stale fencing token",
  },
  {
    id: "task_gate_before_integration_queue",
    file: "packages/runtime/test/scheduling/scheduler.test.ts",
    test: "fails closed instead of releasing a Lease when a required Task Gate has no Evidence",
  },
  {
    id: "task_commit_before_candidate_gate",
    file: "tests/fault/m4-wave-integration-boundaries.test.ts",
    test: "blocks on a candidate gate failure without consuming the integration retry",
  },
  {
    id: "candidate_gate_before_lease_release",
    file: "packages/runtime/test/scheduling/integration.test.ts",
    test: "keeps the Lease granted when candidate Gate execution crashes before the atomic release",
  },
  {
    id: "wave_gate_before_cas",
    file: "tests/fault/m4-wave-integration-boundaries.test.ts",
    test: "keeps the ref unchanged and never retries when a mandatory wave gate fails",
  },
  {
    id: "cas_preparation_before_ledger_transaction",
    file: "tests/fault/m4-wave-integration-boundaries.test.ts",
    test: "rolls back a successful ref CAS when the Ledger acceptance transaction fails",
  },
  {
    id: "cas_success_lost_response",
    file: "tests/fault/m4-wave-integration-boundaries.test.ts",
    test: "recovers a successful CAS with a lost response without duplicate integration",
  },
  {
    id: "approval_request_decision_arrival",
    file: "packages/runtime/test/scheduling/scheduler.test.ts",
    test: "requires_approval creates one digest-bound request and pauses only that Task",
  },
  {
    id: "driver_lock_acquisition_driver_exit",
    file: "tests/fault/m4-driver-lock-recovery.test.ts",
    test: "reclaims a dead same-host owner's lock; the old handle cannot release it",
  },
  {
    id: "coordinator_restart_sqlite_deletion",
    file: "packages/runtime/test/scheduling/host.test.ts",
    test: "rebuilds from Ledger authority after the real SQLite live projection is deleted",
  },
];

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function commandExecutable() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function gitHead(repositoryRoot) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || "git rev-parse HEAD failed");
  return result.stdout.trim();
}

function readSelectedResult(reportPath, expectedTitle) {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const assertions = (report.testResults ?? []).flatMap((result) => result.assertionResults ?? []);
  const selected = assertions.filter(
    (assertion) => assertion.title === expectedTitle && assertion.status !== "skipped",
  );
  if (selected.length !== 1) {
    return {
      status: "failed",
      detail: `expected one executed case named ${expectedTitle}; observed ${String(selected.length)}`,
    };
  }
  return {
    status: selected[0].status === "passed" ? "passed" : "failed",
    detail:
      selected[0].status === "passed"
        ? "exact production-seam fault case passed"
        : (selected[0].failureMessages ?? []).join("\n"),
  };
}

export function runM4FaultMatrix(options = {}) {
  const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
  const implementationCommit = options.implementationCommit ?? gitHead(repositoryRoot);
  const invocationId = `m4-fault-${digest({ implementationCommit, cases: M4_FAULT_CASES }).slice(0, 16)}`;
  const resultRoot = resolve(
    repositoryRoot,
    options.resultRoot ?? `.reports/acceptance/m4-fault-cases/${invocationId}`,
  );
  mkdirSync(resultRoot, { recursive: true });

  const results = M4_FAULT_CASES.map((faultCase, index) => {
    const reportPath = resolve(resultRoot, `${String(index + 1).padStart(2, "0")}.json`);
    const args = [
      "exec",
      "vitest",
      "run",
      "--config",
      "vitest.workspace.ts",
      faultCase.file,
      "-t",
      escapeRegex(faultCase.test),
      "--reporter=json",
      `--outputFile=${reportPath}`,
    ];
    const processResult = spawnSync(commandExecutable(), args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    const selected =
      processResult.status === 0
        ? readSelectedResult(reportPath, faultCase.test)
        : {
            status: "failed",
            detail: (processResult.stderr || processResult.stdout || "vitest failed").trim(),
          };
    const status = selected.status === "passed" ? "passed" : "failed";
    return {
      boundary_id: faultCase.id,
      status,
      case_identity: `${faultCase.file}::${faultCase.test}`,
      command: [commandExecutable(), ...args],
      exit_code: processResult.status ?? 1,
      implementation_commit: implementationCommit,
      design_section: "M4 §23.3 / plan Task 14 Step 3",
      invariants: M4_FAULT_INVARIANTS.map((invariant) => ({ id: invariant, status })),
      detail: selected.detail,
    };
  });

  const report = {
    schema_version: "1.0.0",
    suite: "m4_fault_matrix",
    invocation_id: invocationId,
    implementation_commit: implementationCommit,
    coverage: "full",
    command: ["pnpm", "test:m4:fault-matrix"],
    status: results.every((result) => result.status === "passed") ? "passed" : "failed",
    results,
  };
  const outputPath = resolve(
    repositoryRoot,
    options.outputPath ?? ".reports/acceptance/m4-fault-matrix.json",
  );
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = runM4FaultMatrix();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.status === "passed" ? 0 : 1;
}
