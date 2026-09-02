import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { contentDigest } from "../../packages/core/src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");

const INVARIANTS = [
  "no_duplicate_process_acceptance",
  "no_duplicate_integration",
  "no_stale_fencing_acceptance",
  "no_incorrect_budget_return",
  "no_ref_ledger_split",
  "no_false_success",
] as const;

type FaultInvariant = (typeof INVARIANTS)[number];

interface FaultBoundaryEvidence {
  readonly boundary: string;
  readonly evidence_files: readonly string[];
  readonly invariants: readonly FaultInvariant[];
}

/**
 * Release-owned index over the executable fault tests introduced by Tasks
 * 6-13. The index is deliberately data, not prose: missing/untracked/empty
 * evidence or a missing invariant fails this suite and therefore Task 14.
 */
export const M4_FAULT_MATRIX: readonly FaultBoundaryEvidence[] = [
  {
    boundary: "lease_commit_before_process",
    evidence_files: ["tests/fault/m4-lease-budget-boundaries.test.ts"],
    invariants: [
      "no_duplicate_process_acceptance",
      "no_incorrect_budget_return",
      "no_false_success",
    ],
  },
  {
    boundary: "process_start_before_pid_projection",
    evidence_files: [
      "packages/runtime/test/scheduling/agent-pool.test.ts",
      "tests/fault/m4-driver-lock-recovery.test.ts",
    ],
    invariants: ["no_duplicate_process_acceptance", "no_false_success"],
  },
  {
    boundary: "agent_result_before_evidence",
    evidence_files: ["packages/runtime/test/scheduling/scheduler.test.ts"],
    invariants: ["no_stale_fencing_acceptance", "no_false_success"],
  },
  {
    boundary: "task_gate_before_integration_queue",
    evidence_files: ["packages/runtime/test/scheduling/scheduler.test.ts"],
    invariants: ["no_duplicate_integration", "no_false_success"],
  },
  {
    boundary: "task_commit_before_candidate_gate",
    evidence_files: ["tests/fault/m4-wave-integration-boundaries.test.ts"],
    invariants: ["no_duplicate_integration", "no_false_success"],
  },
  {
    boundary: "candidate_gate_before_lease_release",
    evidence_files: ["tests/fault/m4-wave-integration-boundaries.test.ts"],
    invariants: ["no_stale_fencing_acceptance", "no_false_success"],
  },
  {
    boundary: "wave_gate_before_cas",
    evidence_files: ["tests/fault/m4-wave-integration-boundaries.test.ts"],
    invariants: ["no_ref_ledger_split", "no_false_success"],
  },
  {
    boundary: "cas_preparation_before_ledger_transaction",
    evidence_files: [
      "tests/fault/m4-wave-integration-boundaries.test.ts",
      "tests/integration/m4-wave-cas.test.ts",
    ],
    invariants: ["no_duplicate_integration", "no_ref_ledger_split"],
  },
  {
    boundary: "cas_success_lost_response",
    evidence_files: ["tests/fault/m4-wave-integration-boundaries.test.ts"],
    invariants: ["no_duplicate_integration", "no_ref_ledger_split", "no_false_success"],
  },
  {
    boundary: "approval_request_decision_arrival",
    evidence_files: [
      "packages/runtime/test/scheduling/scheduler.test.ts",
      "tests/fault/expired-approval.test.ts",
    ],
    invariants: ["no_duplicate_process_acceptance", "no_false_success"],
  },
  {
    boundary: "driver_lock_acquisition_driver_exit",
    evidence_files: ["tests/fault/m4-driver-lock-recovery.test.ts"],
    invariants: ["no_duplicate_process_acceptance", "no_false_success"],
  },
  {
    boundary: "coordinator_restart_sqlite_deletion",
    evidence_files: [
      "packages/runtime/test/scheduling/host.test.ts",
      "packages/runtime/test/scheduling/sqlite-projection.test.ts",
    ],
    invariants: ["no_duplicate_integration", "no_incorrect_budget_return", "no_false_success"],
  },
];

describe("M4 scheduler fault-injection release matrix", () => {
  it("binds all twelve approved crash boundaries to tracked executable tests", () => {
    expect(M4_FAULT_MATRIX.map((entry) => entry.boundary)).toEqual([
      "lease_commit_before_process",
      "process_start_before_pid_projection",
      "agent_result_before_evidence",
      "task_gate_before_integration_queue",
      "task_commit_before_candidate_gate",
      "candidate_gate_before_lease_release",
      "wave_gate_before_cas",
      "cas_preparation_before_ledger_transaction",
      "cas_success_lost_response",
      "approval_request_decision_arrival",
      "driver_lock_acquisition_driver_exit",
      "coordinator_restart_sqlite_deletion",
    ]);
    for (const entry of M4_FAULT_MATRIX) {
      expect(entry.evidence_files.length, entry.boundary).toBeGreaterThan(0);
      for (const path of entry.evidence_files) {
        const absolute = resolve(repositoryRoot, path);
        expect(existsSync(absolute), `${entry.boundary}: ${path}`).toBe(true);
        execFileSync("git", ["ls-files", "--error-unmatch", path], {
          cwd: repositoryRoot,
          stdio: "pipe",
        });
        const source = readFileSync(absolute, "utf8");
        expect(source, `${entry.boundary}: ${path}`).toMatch(/\b(it|test)\s*\(/u);
        expect(contentDigest(source), `${entry.boundary}: ${path}`).toMatch(/^[a-f0-9]{64}$/u);
      }
    }
  });

  it("covers every fail-closed release invariant with multiple independent boundaries", () => {
    for (const invariant of INVARIANTS) {
      const boundaries = M4_FAULT_MATRIX.filter((entry) => entry.invariants.includes(invariant));
      expect(boundaries.length, invariant).toBeGreaterThanOrEqual(2);
    }
  });
});
