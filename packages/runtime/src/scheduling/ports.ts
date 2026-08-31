import type {
  IterationBudget,
  Protocol13TaskBudget,
  Protocol13TaskSpecification,
  TaskRisk,
} from "../planning/task.js";
import type { ParallelWave } from "../planning/waves.js";
import type {
  AdapterControlProfile,
  PolicyAction,
  SchedulerPolicyActionKind,
} from "../policy/action.js";
import type { PolicyDecision } from "../policy/decision.js";

/**
 * M4 internal scheduling ports (design §5, plan Task 4). TaskDagPort reads the
 * approved, immutable ExecutionPlan projection; PolicyDecisionPort decides the
 * normalized scheduler control-plane actions. Both interfaces stay inside the
 * runtime — they are never re-exported through the public barrel or the
 * plugin SDK — and both are side-effect-free: no Adapter behind them writes
 * Approval, Lease, Finding or Ledger state.
 */

/** Fail-closed rejection raised by the scheduling ports and their guards. */
export const SCHEDULING_PORT_ERROR_KINDS = [
  "plan_not_found",
  "plan_not_approved",
  "plan_digest_drift",
  "baseline_drift",
  "legacy_plan",
  "invalid_decision",
] as const;

export type SchedulingPortErrorKind = (typeof SCHEDULING_PORT_ERROR_KINDS)[number];

export class SchedulingPortError extends Error {
  readonly kind: SchedulingPortErrorKind;

  constructor(kind: SchedulingPortErrorKind, message: string) {
    super(message);
    this.name = "SchedulingPortError";
    this.kind = kind;
  }
}

/**
 * The canonical, immutable scheduling view of one approved protocol 1.3 plan
 * (design §5.1). `plan_digest` binds the approved plan content; `tasks` are
 * the approved specifications in Plan declaration order; `parallel_waves` is
 * the deterministic projection that always byte-matches a fresh compilation.
 */
export interface TaskDagSnapshot {
  readonly operation_id: string;
  readonly iteration_id: string;
  readonly plan_id: string;
  readonly plan_digest: string;
  readonly baseline_commit: string;
  readonly tasks: readonly Protocol13TaskSpecification[];
  readonly parallel_waves: readonly ParallelWave[];
  readonly iteration_budget: IterationBudget;
}

export interface TaskDagPort {
  readonly name: string;
  readApproved(input: {
    readonly operation_id: string;
    readonly expected_plan_digest?: string;
  }): Promise<TaskDagSnapshot>;
}

/**
 * The complete decision input for one scheduler control-plane action (design
 * §11, plan Task 4 step 3): every binding that an approval or a policy digest
 * must cover. Optional bindings are normalized to explicit nulls inside the
 * canonical action parameters so the action digest is total.
 */
export interface SchedulerPolicyInput {
  readonly action: "dispatch_task" | "retry_task" | "integrate_wave";
  readonly operation_id: string;
  readonly iteration_id: string;
  readonly plan_digest: string;
  readonly task_digest?: string;
  readonly wave_index?: number;
  readonly baseline_commit: string;
  readonly risk: TaskRisk;
  readonly capabilities: readonly string[];
  readonly tools: readonly string[];
  readonly write_paths: readonly string[];
  readonly exclusive_resources: readonly string[];
  readonly task_remaining_budget?: Protocol13TaskBudget;
  readonly iteration_remaining_budget: IterationBudget;
  readonly adapter_manifest_digest: string;
  readonly adapter_control_profile: AdapterControlProfile;
  readonly retry_kind?: "executor_retry" | "integration_retry";
  readonly approval_digest?: string;
  readonly effective_policy_digest: string;
}

/**
 * A normalized scheduler action (design §5.2): a control-plane PolicyAction
 * whose kind is one of the protocol 1.3 scheduler kinds and whose canonical
 * parameters carry every SchedulerPolicyInput binding.
 */
export type SchedulerPolicyAction = PolicyAction & {
  readonly kind: SchedulerPolicyActionKind;
};

export interface PolicyDecisionPort {
  readonly name: string;
  decide(input: SchedulerPolicyInput): Promise<PolicyDecision>;
}
