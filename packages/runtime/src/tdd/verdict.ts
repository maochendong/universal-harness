import {
  TDD_VERDICT_TO_GENERIC,
  type TddCycleRecord,
  type TddVerdictState,
} from "@universal-harness-internal/core";

/**
 * TaskVerdict computation (provable TDD design 13, plan T16). The verdict
 * consumes accepted ledger facts only — cycle records, gate results,
 * evaluation outcomes and capability bindings. Agent completion claims,
 * transcripts, live events and model outputs never participate. The six
 * domain states stay mechanically distinct; the generic projection follows
 * the mandated mapping of design 14.3 and nothing else.
 */
export interface TaskTddVerdict {
  readonly verdict: TddVerdictState;
  readonly generic_status: string;
  readonly reason: string;
}

export interface TaskTddVerdictInput {
  /** strict_tdd active in the final CapabilityPlan. */
  readonly capability_enabled: boolean;
  /** Protocol 1.0 completed task: kept as history, never retro-proven. */
  readonly historical?: boolean;
  readonly contract_mode: "required" | "not_applicable" | "framework_bootstrap";
  readonly required_assertion_ids: readonly string[];
  readonly cycles: readonly TddCycleRecord[];
  readonly current_contract_digest: string;
  readonly gates_passed: boolean;
  /** Required when independent_evaluation is enabled. */
  readonly evaluation_passed?: boolean;
  readonly not_applicable_binding?: { readonly category: string; readonly reason: string };
  readonly framework_evidence?: { readonly accepted: boolean; readonly discovery_proven: boolean };
  readonly refactor_policy?: "planned" | "not_planned";
}

function verdict(state: TddVerdictState, reason: string): TaskTddVerdict {
  return { verdict: state, generic_status: TDD_VERDICT_TO_GENERIC[state], reason };
}

export function computeTaskTddVerdict(input: TaskTddVerdictInput): TaskTddVerdict {
  if (!input.capability_enabled) {
    return verdict("not_enabled_by_profile", "strict_tdd is not enabled by the capability plan");
  }
  if (input.historical === true) {
    return verdict(
      "historical_without_tdd_proof",
      "protocol 1.0 completed task; history is never retro-proven",
    );
  }
  if (input.contract_mode === "not_applicable") {
    if (
      input.not_applicable_binding !== undefined &&
      input.not_applicable_binding.reason.length > 0
    ) {
      return verdict(
        "controlled_not_applicable",
        `controlled exemption: ${input.not_applicable_binding.category}`,
      );
    }
    return verdict(
      "tdd_incomplete_or_invalid",
      "not_applicable without an accepted controlled binding",
    );
  }
  if (input.contract_mode === "framework_bootstrap") {
    return input.framework_evidence?.accepted === true && input.framework_evidence.discovery_proven
      ? verdict("framework_proven", "test infrastructure mechanically proven")
      : verdict("tdd_incomplete_or_invalid", "framework bootstrap evidence missing or unproven");
  }

  // required: every required assertion needs exactly one current valid
  // completed cycle bound to the current contract digest.
  for (const assertionId of input.required_assertion_ids) {
    const covering = input.cycles.filter(
      (cycle) => cycle.status === "completed" && cycle.assertion_ids.includes(assertionId),
    );
    if (covering.length !== 1) {
      return verdict(
        "tdd_incomplete_or_invalid",
        `assertion ${assertionId} has ${covering.length} completed cycles, expected exactly 1`,
      );
    }
    const cycle = covering[0] as TddCycleRecord;
    if (cycle.contract_digest !== input.current_contract_digest) {
      return verdict(
        "tdd_incomplete_or_invalid",
        `cycle ${cycle.logical_cycle_id} binds a drifted contract digest`,
      );
    }
    if (input.refactor_policy === "planned" && cycle.refactor_evidence_digest === undefined) {
      return verdict(
        "tdd_incomplete_or_invalid",
        `cycle ${cycle.logical_cycle_id} lacks accepted refactor evidence`,
      );
    }
  }
  if (!input.gates_passed) {
    return verdict("tdd_incomplete_or_invalid", "the full gate suite did not pass");
  }
  if (input.evaluation_passed === false) {
    return verdict("tdd_incomplete_or_invalid", "independent evaluation did not pass");
  }
  return verdict("tdd_proven", "baseline/red/green chain, gates and evaluation all accepted");
}
