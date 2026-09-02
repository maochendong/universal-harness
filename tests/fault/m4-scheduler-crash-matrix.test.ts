import { describe, expect, it } from "vitest";

import {
  M4_FAULT_CASES,
  M4_FAULT_INVARIANTS,
  runM4FaultMatrix,
} from "../../scripts/m4-fault-matrix.mjs";

const BOUNDARIES = [
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
];

describe("M4 scheduler fault-injection release matrix", () => {
  it(
    "executes all twelve exact production-seam cases and proves six invariants per boundary",
    { timeout: 240_000 },
    () => {
      expect(M4_FAULT_CASES.map((faultCase) => faultCase.id)).toEqual(BOUNDARIES);
      expect(
        new Set(M4_FAULT_CASES.map((faultCase) => `${faultCase.file}::${faultCase.test}`)).size,
      ).toBe(12);

      const report = runM4FaultMatrix();

      expect(report.coverage).toBe("full");
      expect(report.status).toBe("passed");
      expect(report.results).toHaveLength(12);
      for (const result of report.results) {
        expect(result.status, result.boundary_id).toBe("passed");
        expect(result.exit_code, result.boundary_id).toBe(0);
        expect(result.case_identity, result.boundary_id).toContain("::");
        expect(result.invariants.map((invariant) => invariant.id)).toEqual(M4_FAULT_INVARIANTS);
        expect(result.invariants.every((invariant) => invariant.status === "passed")).toBe(true);
      }
    },
  );
});
