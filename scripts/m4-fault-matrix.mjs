import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
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
        assertion:
          "the crashed coordinator started no process and the command_id replay starts none either",
      },
      {
        id: "no_duplicate_integration",
        assertion:
          "a byte-identical Ledger replay of the committed command is already_committed, never appended",
      },
      {
        id: "no_stale_fencing_acceptance",
        assertion:
          "exactly one fencing token exists; the production guard rejects a token no granted Lease carries",
      },
      {
        id: "no_incorrect_budget_return",
        assertion:
          "the recovered account retains the durable granted Lease reservation, unchanged by the replay",
      },
      {
        id: "no_ref_ledger_split",
        assertion:
          "committed manifest digests and on-disk record bytes reference each other exactly — no orphans, no dangling digests",
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
        id: "no_duplicate_integration",
        assertion:
          "recovery settles exactly once: one revocation and one interruption record, no re-classified run, no integration queue entry",
      },
      {
        id: "no_stale_fencing_acceptance",
        assertion:
          "recovery mints no new token; the chain head stays terminal at token 1 and a never-granted token is rejected",
      },
      {
        id: "no_incorrect_budget_return",
        assertion: "the revoked Lease conservatively charges the full reservation",
      },
      {
        id: "no_ref_ledger_split",
        assertion:
          "a fresh read derives the same blocked Task and charged budget from the same authoritative records",
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
        id: "no_duplicate_process_acceptance",
        assertion:
          "exactly two attempts ever ran — the crashed original and the single executor retry",
      },
      {
        id: "no_duplicate_integration",
        assertion:
          "each attempt was classified exactly once (unique run records) and no integration record exists",
      },
      {
        id: "no_stale_fencing_acceptance",
        assertion: "the old fencing token is rejected twice while the current token is accepted",
      },
      {
        id: "no_incorrect_budget_return",
        assertion:
          "the rejections moved no budget: the crash's measured consumption plus the retry reservation is exactly what remains",
      },
      {
        id: "no_ref_ledger_split",
        assertion:
          "the fencing guard and the read model consult the same authority: both agree on the current token and status",
      },
      {
        id: "no_false_success",
        assertion:
          "the stale rejections committed nothing and recorded no validation or integration success",
      },
    ],
  },
  {
    id: "task_gate_before_integration_queue",
    file: "packages/runtime/test/scheduling/scheduler.test.ts",
    test: "fails closed instead of releasing a Lease when a required Task Gate has no Evidence",
    invariants: [
      {
        id: "no_duplicate_process_acceptance",
        assertion:
          "the process ran exactly once and a repeated drive re-dispatches nothing and commits nothing",
      },
      {
        id: "no_duplicate_integration",
        assertion:
          "the Task never entered the integration queue and no WaveIntegration record exists",
      },
      {
        id: "no_stale_fencing_acceptance",
        assertion:
          "token 1 stays the only minted token with a terminal chain head; any other token is rejected",
      },
      {
        id: "no_incorrect_budget_return",
        assertion:
          "the revocation settled exactly once: the read model charged exactly the recorded consumption",
      },
      {
        id: "no_ref_ledger_split",
        assertion:
          "a fresh read derives the same blocked Task and budget from the same authoritative records",
      },
      {
        id: "no_false_success",
        assertion:
          "missing required Gate Evidence blocks the Task, records task_gate_failed, and fabricates no Evidence",
      },
    ],
  },
  {
    id: "task_commit_before_candidate_gate",
    file: "tests/fault/m4-wave-integration-boundaries.test.ts",
    test: "blocks on a candidate gate failure without consuming the integration retry",
    invariants: [
      {
        id: "no_duplicate_process_acceptance",
        assertion:
          "the blocked validation committed exactly one batch of Evidence plus Finding — no dispatch, run or lease transition",
      },
      {
        id: "no_duplicate_integration",
        assertion: "candidate Gate failure writes no WaveIntegration record",
      },
      {
        id: "no_stale_fencing_acceptance",
        assertion:
          "Evidence bound to a fencing token the chain never minted is rejected by the same validation seam, committing nothing",
      },
      {
        id: "no_incorrect_budget_return",
        assertion:
          "the Lease remains granted with its reservation intact — neither released nor revoked by the failure",
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
        id: "no_duplicate_process_acceptance",
        assertion:
          "the crash committed nothing; a clean retry validates exactly once in one atomic batch",
      },
      {
        id: "no_duplicate_integration",
        assertion: "no WaveIntegration record exists at this seam before or after the retry",
      },
      {
        id: "no_stale_fencing_acceptance",
        assertion:
          "replaying validation with the released (superseded) grant is rejected as no longer current",
      },
      {
        id: "no_incorrect_budget_return",
        assertion:
          "the crash kept the granted Lease's reservation untouched; the retry released it exactly once with the measured consumption",
      },
      {
        id: "no_ref_ledger_split",
        assertion:
          "the candidate commit never reached the operation ref nor the WaveIntegration authority",
      },
      {
        id: "no_false_success",
        assertion:
          "the crash produced no candidate_validated terminal state on its own — only the real retried validation did",
      },
    ],
  },
  {
    id: "wave_gate_before_cas",
    file: "tests/fault/m4-wave-integration-boundaries.test.ts",
    test: "keeps the ref unchanged and never retries when a mandatory wave gate fails",
    invariants: [
      {
        id: "no_duplicate_process_acceptance",
        assertion:
          "the failed wave Gate committed one batch of Evidence, event and Finding; nothing was dispatched and the CAS was never attempted",
      },
      {
        id: "no_duplicate_integration",
        assertion: "wave Gate failure writes no WaveIntegration record",
      },
      {
        id: "no_stale_fencing_acceptance",
        assertion:
          "a validation naming Evidence bound to a never-minted fencing token is rejected at the acceptance seam before any gate run or CAS",
      },
      {
        id: "no_incorrect_budget_return",
        assertion:
          "validation released the Lease exactly once with the measured consumption; the failed wave Gate never settled budget again",
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
        id: "no_duplicate_process_acceptance",
        assertion:
          "the rollback restored the exact pre-acceptance state, so the same command succeeds once on retry and its replay adds nothing",
      },
      {
        id: "no_duplicate_integration",
        assertion:
          "the failed Ledger transaction left no WaveIntegration record; retry plus replay recorded exactly one",
      },
      {
        id: "no_stale_fencing_acceptance",
        assertion:
          "the acceptance record binds exactly the current released Lease digest — the fencing-token chain head",
      },
      {
        id: "no_incorrect_budget_return",
        assertion:
          "the Lease was released exactly once with the measured consumption; neither the failed acceptance nor the retry settled budget again",
      },
      {
        id: "no_ref_ledger_split",
        assertion:
          "the exact reverse CAS restored the ref on failure; after the retry ref and Ledger hold the same candidate commit",
      },
      {
        id: "no_false_success",
        assertion: "the acceptance call rejected instead of returning an accepted wave",
      },
    ],
  },
  {
    id: "cas_success_lost_response",
    file: "tests/fault/m4-wave-integration-boundaries.test.ts",
    test: "lets a fresh driver reconcile an exact candidate ref after CAS succeeds before Ledger acceptance",
    invariants: [
      {
        id: "no_duplicate_process_acceptance",
        assertion:
          "the fresh driver reconciled without dispatching or settling anything new: one run, one Lease chain, one CAS",
      },
      {
        id: "no_duplicate_integration",
        assertion: "fresh-driver reconciliation records the wave once without a second CAS",
      },
      {
        id: "no_stale_fencing_acceptance",
        assertion:
          "the reconciled record binds exactly the current released Lease digest — the fencing-token chain head",
      },
      {
        id: "no_incorrect_budget_return",
        assertion:
          "the single release kept its measured consumption; the crash and reconciliation settled no budget a second time",
      },
      {
        id: "no_ref_ledger_split",
        assertion:
          "the exact candidate ref is reconciled into one authoritative WaveIntegration record holding the same commit",
      },
      {
        id: "no_false_success",
        assertion:
          "the first process reported failure until a fresh driver reran validation and recorded acceptance",
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
        assertion:
          "the unapproved Task was never dispatched on the first or the repeated drive while its peer ran once",
      },
      {
        id: "no_duplicate_integration",
        assertion:
          "one decision produced exactly one digest-bound request and, after approval, exactly one granted Lease",
      },
      {
        id: "no_stale_fencing_acceptance",
        assertion:
          "the request binds task_b's exact action digest (a different action digests differently) and a never-minted token is rejected",
      },
      {
        id: "no_incorrect_budget_return",
        assertion:
          "while paused the Task held no reservation; after approval both reservations are held exactly once",
      },
      {
        id: "no_ref_ledger_split",
        assertion:
          "the pending request was visible through the read path with the same identity, and the granted Lease carries the approval binding",
      },
      {
        id: "no_false_success",
        assertion: "the unapproved Task remained paused without a Lease",
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
        assertion:
          "reclamation produced exactly one live owner on the lock path; a second live driver is refused",
      },
      {
        id: "no_duplicate_integration",
        assertion:
          "exactly one authoritative ownership record exists and it names the recovered owner",
      },
      {
        id: "no_stale_fencing_acceptance",
        assertion:
          "the superseded owner token cannot release or supersede the recovered live owner",
      },
      {
        id: "no_incorrect_budget_return",
        assertion:
          "the stale release returned nothing; the live owner's release removed the lock exactly once and its replay was a no-op",
      },
      {
        id: "no_ref_ledger_split",
        assertion:
          "lock directory and owner metadata agreed while held and disappeared together on release",
      },
      {
        id: "no_false_success",
        assertion:
          "the superseded owner's release reported failure; the recovered ownership names the live pid, not the dead one",
      },
    ],
  },
  {
    id: "coordinator_restart_sqlite_deletion",
    file: "packages/runtime/test/scheduling/host.test.ts",
    test: "rebuilds from Ledger authority after the real SQLite live projection is deleted",
    invariants: [
      {
        id: "no_duplicate_process_acceptance",
        assertion:
          "the rebuild resurrected no process: no live slots and byte-identical run records",
      },
      {
        id: "no_duplicate_integration",
        assertion:
          "the WaveIntegration records are byte-identical before and after the projection loss",
      },
      {
        id: "no_stale_fencing_acceptance",
        assertion:
          "the fencing-token chain rebuilt byte-identically from Ledger authority; no stale token regressed",
      },
      {
        id: "no_incorrect_budget_return",
        assertion: "budget-relevant Lease fields are exactly what the Ledger held before the loss",
      },
      {
        id: "no_ref_ledger_split",
        assertion:
          "the real operation ref did not move and still agrees with the unchanged integration records",
      },
      {
        id: "no_false_success",
        assertion:
          "deleting live SQLite preserves the exact authority-derived Task statuses and honestly reports rebuilding",
      },
    ],
  },
];

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function vitestEntrypoint(repositoryRoot) {
  const require = createRequire(join(repositoryRoot, "package.json"));
  const vitestPackage = require.resolve("vitest/package.json");
  const { bin } = require(vitestPackage);
  return join(dirname(vitestPackage), typeof bin === "string" ? bin : bin.vitest);
}

function vitestCommand(repositoryRoot) {
  // Windows exposes pnpm only as a .cmd shim, and since Node 20.12
  // (CVE-2024-27980) spawning a .cmd without a shell throws EINVAL. A shell
  // would re-split the space-bearing -t titles, so Windows runs the vitest
  // entrypoint directly with the current Node binary instead.
  if (process.platform === "win32") {
    return { file: process.execPath, argsPrefix: [vitestEntrypoint(repositoryRoot)] };
  }
  return { file: "pnpm", argsPrefix: ["exec", "vitest"] };
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
    const command = vitestCommand(repositoryRoot);
    const args = [
      ...command.argsPrefix,
      "run",
      "--config",
      "vitest.workspace.ts",
      faultCase.file,
      "-t",
      escapeRegex(faultCase.test),
      "--reporter=json",
      `--outputFile=${reportPath}`,
    ];
    const processResult = spawnSync(command.file, args, {
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
      command: [command.file, ...args],
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
