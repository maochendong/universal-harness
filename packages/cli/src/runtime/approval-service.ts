import {
  resolveApproval,
  type OrchestratorDependencies,
} from "@universal-harness-internal/runtime";

export interface CliApprovalService {
  resolve(input: {
    readonly projectRoot: string;
    readonly requestId: string;
    readonly decision: Parameters<typeof resolveApproval>[1]["decision"];
    readonly actor?: string;
  }): ReturnType<typeof resolveApproval>;
}

/** CLI translation seam; runtime ApprovalService remains the sole ledger owner. */
export function createCliApprovalService(input: {
  readonly dependencies: (projectRoot: string) => OrchestratorDependencies;
  readonly defaultActor: string;
}): CliApprovalService {
  return {
    resolve(request) {
      return resolveApproval(input.dependencies(request.projectRoot), {
        requestId: request.requestId,
        decision: request.decision,
        actor: request.actor ?? input.defaultActor,
      });
    },
  };
}
