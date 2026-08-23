import {
  harnessRootFor,
  readCommittedOperations,
  sha256Hex,
} from "@universal-harness-internal/core";

import {
  approvalRequiredOutcome,
  promptForApprovalDecision,
  resumeCommandFor,
  type ApprovalRequiredOutcome,
} from "../approval/interaction.js";
import {
  approvalDecisionArtifact,
  readApprovalDecisions,
  readApprovalRequests,
  type ApprovalDecision,
  type ApprovalDecisionRecord,
  type ApprovalRequestRecord,
  type ApprovalRisk,
} from "../approval/request.js";
import { ApprovalService, type ApprovalIdKind } from "../approval/service.js";
import type { PipelineContext } from "./kernel-coordinator.js";
import type { OrchestrationPhase } from "./phases.js";
import {
  OrchestrationError,
  type OrchestrationOutcome,
  type OrchestratorDependencies,
} from "./pipeline-types.js";

/** Approval request reuse, interactive resolution, blocking and rejection. */
export type ApprovalStep =
  | { readonly status: "approved"; readonly approvalDigest: string }
  | { readonly status: "rejected" }
  | { readonly status: "required"; readonly required: ApprovalRequiredOutcome };

export interface ApprovalRuntime {
  ensure(
    ctx: PipelineContext,
    spec: {
      readonly objectId: string;
      readonly objectType: string;
      readonly objectDigest: string;
      readonly risk: ApprovalRisk;
      readonly reason: string;
      readonly resumePhase: OrchestrationPhase;
    },
  ): Promise<ApprovalStep>;
  reject(ctx: PipelineContext, detail: string): Promise<OrchestrationOutcome>;
}

export function approvalService(deps: OrchestratorDependencies): ApprovalService {
  return new ApprovalService({
    projectRoot: deps.projectRoot,
    readBaseline: deps.readBaseline,
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.newId === undefined
      ? {}
      : { newId: (kind: ApprovalIdKind) => (deps.newId as (kind: string) => string)(kind) }),
    ...(deps.hooks === undefined ? {} : { hooks: deps.hooks }),
    ...(deps.lock === undefined ? {} : { lock: deps.lock }),
  });
}

export function approvalDigestOf(record: ApprovalDecisionRecord): string {
  return sha256Hex(approvalDecisionArtifact(record).content);
}

function refresh(ctx: PipelineContext): void {
  const state = ctx.engine.getWorkingState(ctx.workflowOperationId);
  if (state === undefined) {
    throw new OrchestrationError(
      "operation_not_found",
      `workflow operation ${ctx.workflowOperationId} has no working state`,
    );
  }
  ctx.workingState = state;
}

export function createApprovalRuntime(): ApprovalRuntime {
  return {
    async ensure(ctx, spec): Promise<ApprovalStep> {
      const { deps } = ctx;
      const root = harnessRootFor(deps.projectRoot);
      const service = approvalService(deps);
      const operations = readCommittedOperations(root);
      const requests = readApprovalRequests(root, operations, ctx.workflowOperationId).filter(
        (request) =>
          request.object_id === spec.objectId && request.object_digest === spec.objectDigest,
      );
      const decisions = readApprovalDecisions(root, operations, ctx.workflowOperationId);

      const blockAndReport = async (request: ApprovalRequestRecord): Promise<ApprovalStep> => {
        const current = ctx.engine.getOperation(ctx.workflowOperationId);
        if (current !== undefined && current.state !== "blocked") {
          await ctx.engine.block(ctx.workflowOperationId, {
            reason: "awaiting_approval",
            detail: `approval request ${request.request_id} awaiting a decision`,
            proposal: {
              phase: spec.resumePhase,
              set_next_action: resumeCommandFor(ctx.workflowOperationId),
            },
          });
        }
        refresh(ctx);
        return { status: "required", required: approvalRequiredOutcome(request) };
      };

      const resolveInteractive = async (request: ApprovalRequestRecord): Promise<ApprovalStep> => {
        const prompter = deps.prompter;
        if (prompter === undefined) return blockAndReport(request);
        const decision: ApprovalDecision = await promptForApprovalDecision(request, prompter);
        if (decision === "defer") return blockAndReport(request);
        const record = await service.resolveDecision({
          requestId: request.request_id,
          decision,
          objectDigest: request.object_digest,
          actor: deps.decisionActor ?? "human:interactive",
        });
        refresh(ctx);
        if (decision === "reject") return { status: "rejected" };
        return { status: "approved", approvalDigest: approvalDigestOf(record) };
      };

      const existing = requests.at(-1);
      if (existing !== undefined) {
        const terminal = decisions.find(
          (decision) =>
            decision.request_id === existing.request_id && decision.decision !== "defer",
        );
        if (terminal !== undefined) {
          if (terminal.decision === "reject") return { status: "rejected" };
          return { status: "approved", approvalDigest: approvalDigestOf(terminal) };
        }
        return resolveInteractive(existing);
      }

      const input = {
        workflowOperationId: ctx.workflowOperationId,
        objectId: spec.objectId,
        objectType: spec.objectType,
        objectDigest: spec.objectDigest,
        baselineDigest: ctx.baselineDigest,
        policyDigest: ctx.workingState.policy_digest,
        impactPath: [],
        risk: spec.risk,
        reason: spec.reason,
        resumePhase: spec.resumePhase,
        proposedBy: "orchestrator",
      };
      if (deps.prompter === undefined) {
        const required = await service.requestApproval(input);
        refresh(ctx);
        return { status: "required", required };
      }
      const awaited = await service.requestApprovalInteractively(
        input,
        deps.prompter,
        deps.decisionActor ?? "human:interactive",
      );
      refresh(ctx);
      if (awaited.status === "deferred") {
        return { status: "required", required: awaited.required };
      }
      if (awaited.decision.decision === "reject") return { status: "rejected" };
      return { status: "approved", approvalDigest: approvalDigestOf(awaited.decision) };
    },

    async reject(ctx, detail): Promise<OrchestrationOutcome> {
      await ctx.engine.abort(ctx.workflowOperationId, {
        reason: "user_cancellation",
        detail,
      });
      return {
        status: "aborted",
        workflowOperationId: ctx.workflowOperationId,
        iterationId: ctx.iterationId,
        reason: "user_cancellation",
        detail,
      };
    },
  };
}

const runtime = createApprovalRuntime();

export const ensureApproval: ApprovalRuntime["ensure"] = (ctx, spec) => runtime.ensure(ctx, spec);
export const rejectOperation: ApprovalRuntime["reject"] = (ctx, detail) =>
  runtime.reject(ctx, detail);
