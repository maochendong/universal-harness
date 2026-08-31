/**
 * M4 local multi-agent scheduling barrel (plan Task 8). Task 4–8 modules are
 * unified here so later tasks (Scheduler, integration, orchestration wiring)
 * import one surface. These symbols stay runtime-internal: nothing here is
 * re-exported through packages/runtime/src/index.ts (Task 10's boundary).
 *
 * Export decisions:
 * - `deriveTaskLeaseId` IS exported (via lease.js): it is a pure function of
 *   (task_id, attempt_number, command_id) and the deterministic identity the
 *   Task 9 scheduler and Task 10 recovery need to make command replays
 *   idempotent before granting a lease. It carries no side channel and no
 *   authority — the Ledger records remain the only proof.
 * - `TaskDagPort`/`PolicyDecisionPort` remain internal ports; the barrel does
 *   not widen them beyond the runtime package.
 */

export * from "./agent-pool.js";
export * from "./budget.js";
export * from "./driver-lock.js";
export * from "./events.js";
export * from "./lease.js";
export * from "./policy-adapters.js";
export * from "./ports.js";
export * from "./projection.js";
export * from "./resource-locks.js";
export * from "./sqlite-projection.js";
export * from "./task-dag-adapters.js";
export * from "./workspace-manager.js";
