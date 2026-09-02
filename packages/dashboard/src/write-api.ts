import { DashboardProblem } from "./problem.js";

export const DASHBOARD_APPROVAL_DECISIONS = ["approve", "reject", "defer"] as const;
export type DashboardApprovalDecision = (typeof DASHBOARD_APPROVAL_DECISIONS)[number];

export const DASHBOARD_FINDING_ACTIONS = ["accept", "close", "supersede"] as const;
export type DashboardFindingAction = (typeof DASHBOARD_FINDING_ACTIONS)[number];

export interface ApprovalDecisionWrite {
  readonly requestId: string;
  readonly decision: DashboardApprovalDecision;
  readonly expectedDigest: string;
  readonly actor: string;
}

export interface ResumeWorkflowWrite {
  readonly workflowOperationId: string;
  readonly expectedDigest: string;
  readonly actor: string;
}

export interface ResolveFindingGroupWrite {
  readonly groupId: string;
  readonly action: DashboardFindingAction;
  readonly expectedDigest: string;
  readonly actor: string;
  readonly evidenceId?: string;
}

export interface CancelSchedulerOperationWrite {
  readonly operationId: string;
  readonly expectedDigest: string;
  readonly actor: string;
}

export interface SchedulerPolicyProposalWrite {
  readonly operationId: string;
  readonly proposalKind: "budget" | "concurrency";
  readonly expectedDigest: string;
  readonly actor: string;
  readonly maxConcurrency?: number;
  readonly budget?: {
    readonly steps: number;
    readonly tokens: number;
    readonly durationMs: number;
  };
}

export interface DashboardWriteApi {
  decideApproval(input: ApprovalDecisionWrite): Promise<unknown>;
  resumeWorkflow(input: ResumeWorkflowWrite): Promise<unknown>;
  resolveFindingGroup(input: ResolveFindingGroupWrite): Promise<unknown>;
  /** The service applies Policy and persists cancellation Evidence. */
  cancelSchedulerOperation?(input: CancelSchedulerOperationWrite): Promise<unknown>;
  /** Proposes a Policy revision; it never mutates an effective limit directly. */
  proposeSchedulerPolicy?(input: SchedulerPolicyProposalWrite): Promise<unknown>;
}

export type DashboardWriteErrorKind = "conflict" | "not_found" | "unavailable" | "invalid";

const ERROR_DETAILS: Record<
  DashboardWriteErrorKind,
  { readonly status: number; readonly code: string; readonly title: string }
> = {
  conflict: { status: 409, code: "write_conflict", title: "Conflict" },
  not_found: { status: 404, code: "write_target_not_found", title: "Not Found" },
  unavailable: { status: 503, code: "write_operations_unavailable", title: "Unavailable" },
  invalid: { status: 400, code: "invalid_write", title: "Bad Request" },
};

/** Stable, sanitized boundary error for service-backed Dashboard mutations. */
export class DashboardWriteError extends DashboardProblem {
  readonly kind: DashboardWriteErrorKind;

  constructor(kind: DashboardWriteErrorKind, detail: string) {
    const mapped = ERROR_DETAILS[kind];
    super(mapped.status, mapped.code, mapped.title, detail);
    this.name = "DashboardWriteError";
    this.kind = kind;
  }
}

/** Default for library hosts that intentionally expose a read-only Dashboard. */
export function unavailableDashboardWriteApi(): DashboardWriteApi {
  const reject = (): Promise<never> =>
    Promise.reject(
      new DashboardWriteError(
        "unavailable",
        "this Dashboard host did not configure controlled write services",
      ),
    );
  return {
    decideApproval: reject,
    resumeWorkflow: reject,
    resolveFindingGroup: reject,
  };
}
