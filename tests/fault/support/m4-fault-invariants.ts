/**
 * Executes the six M4 fault-boundary proofs in their canonical order.
 *
 * Callers must assert over the production-seam state created by the fault
 * case. Keeping the assertions as callbacks makes an omitted proof a type
 * error without reducing a proof to a pre-computed boolean or a label.
 * Callbacks may be async; each is awaited so a rejected expectation fails
 * the case instead of floating as an unhandled rejection.
 */
export type M4FaultInvariantId =
  | "no_duplicate_process_acceptance"
  | "no_duplicate_integration"
  | "no_stale_fencing_acceptance"
  | "no_incorrect_budget_return"
  | "no_ref_ledger_split"
  | "no_false_success";

export const M4_FAULT_INVARIANT_IDS = [
  "no_duplicate_process_acceptance",
  "no_duplicate_integration",
  "no_stale_fencing_acceptance",
  "no_incorrect_budget_return",
  "no_ref_ledger_split",
  "no_false_success",
] as const satisfies readonly M4FaultInvariantId[];

export async function proveM4FaultInvariants(
  assertions: Readonly<Record<M4FaultInvariantId, () => void | Promise<void>>>,
): Promise<void> {
  for (const invariant of M4_FAULT_INVARIANT_IDS) await assertions[invariant]();
}
