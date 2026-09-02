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
    invariants: [
      {
        id: "no_duplicate_process_acceptance",
        assertion: "replay starts no process after the granted Lease command is already committed",
      },
      {
        id: "no_incorrect_budget_return",
        assertion: "the recovered account retains the durable granted Lease reservation",
      },
      {
        id: "no_false_success",
        assertion: "the crash leaves one granted Lease, never a terminal success",
      },
    ],
  },
  {
    id: "process_start_before_pid_projection",
    file: "packages/runtime/test/scheduling/scheduler.test.ts",
    test: "keeps an orphan's unmeasured reservation charged and blocks automatic retry",
    invariants: [
      {
        id: "no_duplicate_process_acceptance",
        assertion: "a fresh driver starts no replacement process while usage is unknown",
      },
      {
        id: "no_incorrect_budget_return",
        assertion: "the revoked Lease conservatively charges the full reservation",
      },
      {
        id: "no_false_success",
        assertion: "recovery returns blocked with a budget_usage_unknown Finding",
      },
    ],
  },
  {
    id: "agent_result_before_evidence",
    file: "packages/runtime/test/scheduling/scheduler.test.ts",
    test: "rejects results carrying a stale fencing token",
    invariants: [
      {
        id: "no_stale_fencing_acceptance",
        assertion: "the old fencing token is rejected twice while the current token is accepted",
      },
      {
        id: "no_false_success",
        assertion: "a stale Agent result cannot advance Task authority",
      },
    ],
  },
  {
    id: "task_gate_before_integration_queue",
    file: "packages/runtime/test/scheduling/scheduler.test.ts",
    test: "fails closed instead of releasing a Lease when a required Task Gate has no Evidence",
    invariants: [
      {
        id: "no_false_success",
        assertion: "missing required Gate Evidence blocks the Task and records task_gate_failed",
      },
    ],
  },
  {
    id: "task_commit_before_candidate_gate",
    file: "tests/fault/m4-wave-integration-boundaries.test.ts",
    test: "blocks on a candidate gate failure without consuming the integration retry",
    invariants: [
      {
        id: "no_duplicate_integration",
        assertion: "candidate Gate failure writes no WaveIntegration record",
      },
      {
        id: "no_ref_ledger_split",
        assertion: "candidate Gate failure leaves both operation ref and WaveIntegration absent",
      },
      {
        id: "no_false_success",
        assertion: "the semantic conflict is blocked and never becomes an integration retry",
      },
    ],
  },
  {
    id: "candidate_gate_before_lease_release",
    file: "packages/runtime/test/scheduling/integration.test.ts",
    test: "keeps the Lease granted when candidate Gate execution crashes before the atomic release",
    invariants: [
      {
        id: "no_incorrect_budget_return",
        assertion: "the granted Lease keeps its reservation when candidate Gate execution crashes",
      },
      {
        id: "no_false_success",
        assertion: "the crash produces no candidate_validated terminal state",
      },
    ],
  },
  {
    id: "wave_gate_before_cas",
    file: "tests/fault/m4-wave-integration-boundaries.test.ts",
    test: "keeps the ref unchanged and never retries when a mandatory wave gate fails",
    invariants: [
      {
        id: "no_duplicate_integration",
        assertion: "wave Gate failure writes no WaveIntegration record",
      },
      {
        id: "no_ref_ledger_split",
        assertion: "wave Gate failure leaves the operation ref and Ledger acceptance unchanged",
      },
      {
        id: "no_false_success",
        assertion: "wave Gate failure records a blocker and never retries",
      },
    ],
  },
  {
    id: "cas_preparation_before_ledger_transaction",
    file: "tests/fault/m4-wave-integration-boundaries.test.ts",
    test: "rolls back a successful ref CAS when the Ledger acceptance transaction fails",
    invariants: [
      {
        id: "no_duplicate_integration",
        assertion: "the failed Ledger transaction leaves no WaveIntegration record",
      },
      {
        id: "no_ref_ledger_split",
        assertion: "the exact reverse CAS restores the ref when Ledger acceptance fails in-process",
      },
      {
        id: "no_false_success",
        assertion: "the acceptance call rejects instead of returning an accepted wave",
      },
    ],
  },
  {
    id: "cas_success_lost_response",
    file: "tests/fault/m4-wave-integration-boundaries.test.ts",
    test: "lets a fresh driver reconcile an exact candidate ref after CAS succeeds before Ledger acceptance",
    invariants: [
      {
        id: "no_duplicate_integration",
        assertion: "fresh-driver reconciliation records the wave once without a second CAS",
      },
      {
        id: "no_ref_ledger_split",
        assertion:
          "the exact candidate ref is reconciled into one authoritative WaveIntegration record",
      },
      {
        id: "no_false_success",
        assertion:
          "the first process reports failure until a fresh driver reruns validation and records acceptance",
      },
    ],
  },
  {
    id: "approval_request_decision_arrival",
    file: "packages/runtime/test/scheduling/scheduler.test.ts",
    test: "requires_approval creates one digest-bound request and pauses only that Task",
    invariants: [
      {
        id: "no_duplicate_process_acceptance",
        assertion: "the unapproved Task is not dispatched while its independent peer runs once",
      },
      {
        id: "no_false_success",
        assertion: "the unapproved Task remains paused without a Lease",
      },
    ],
  },
  {
    id: "driver_lock_acquisition_driver_exit",
    file: "tests/fault/m4-driver-lock-recovery.test.ts",
    test: "reclaims a dead same-host owner's lock; the old handle cannot release it",
    invariants: [
      {
        id: "no_duplicate_process_acceptance",
        assertion: "the stale driver owner cannot release or supersede the recovered live owner",
      },
    ],
  },
  {
    id: "coordinator_restart_sqlite_deletion",
    file: "packages/runtime/test/scheduling/host.test.ts",
    test: "rebuilds from Ledger authority after the real SQLite live projection is deleted",
    invariants: [
      {
        id: "no_false_success",
        assertion: "deleting live SQLite preserves the exact authority-derived Task statuses",
      },
    ],
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
      invariants: faultCase.invariants.map((invariant) => ({ ...invariant, status })),
      detail: selected.detail,
    };
  });

  const coverageGaps = results.flatMap((result) => {
    const covered = new Set(result.invariants.map((invariant) => invariant.id));
    return M4_FAULT_INVARIANTS.filter((invariant) => !covered.has(invariant)).map((invariant) => ({
      boundary_id: result.boundary_id,
      invariant_id: invariant,
    }));
  });
  const executionStatus = results.every((result) => result.status === "passed")
    ? "passed"
    : "failed";
  const coverage = coverageGaps.length === 0 ? "full" : "partial";

  const report = {
    schema_version: "1.0.0",
    suite: "m4_fault_matrix",
    invocation_id: invocationId,
    implementation_commit: implementationCommit,
    coverage,
    coverage_basis: "each boundary must bind every required invariant to an executed assertion",
    coverage_gaps: coverageGaps,
    command: ["pnpm", "test:m4:fault-matrix"],
    execution_status: executionStatus,
    status: executionStatus === "passed" && coverage === "full" ? "passed" : "failed",
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
