import { describe, expect, it } from "vitest";

import { LedgerRepository, harnessRootFor } from "../../packages/core/src/index.js";
import {
  ApprovalError,
  ApprovalService,
  WorkflowEngine,
  readApprovalRequests,
  resumeWorkflowOperation,
  type ApprovalBindingSnapshot,
  type ApprovalDependencies,
  type ApprovalRequestRecord,
} from "../../packages/runtime/src/index.js";
import {
  BASELINE,
  FIXED_NOW,
  cleanupDirectories,
  makeProjectRoot,
  makeStartInput,
  phaseIds,
} from "../../packages/runtime/test/workflow/helpers.js";

/**
 * Expired approval fault injection (design 11.3, 15.2). An approval binds
 * exact digests: the controlled object, the baseline, the policy and the
 * impact path. Once any of them moves, the earlier decision attempt is
 * expired -- resolving it appends an invalidation trail, re-issues the
 * request against current digests, and the stale decision is never reusable.
 */
const OBJECT_DIGEST = "c".repeat(64);
const POLICY_DIGEST = "b".repeat(64);
const BASELINE_DIGEST = "a".repeat(64);

function deps(
  projectRoot: string,
  tag: string,
  readBinding?: (request: ApprovalRequestRecord) => ApprovalBindingSnapshot,
): ApprovalDependencies {
  return {
    projectRoot,
    readBaseline: () => BASELINE,
    now: () => FIXED_NOW,
    newId: phaseIds(tag),
    ...(readBinding === undefined ? {} : { readBinding }),
  };
}

async function bootOperation(projectRoot: string): Promise<string> {
  const engine = new WorkflowEngine(deps(projectRoot, "boot"));
  const started = await engine.startOperation(makeStartInput());
  return started.operation.workflow_operation_id;
}

function requestInput(workflowOperationId: string) {
  return {
    workflowOperationId,
    objectId: "plan_01",
    objectType: "ExecutionPlan",
    objectDigest: OBJECT_DIGEST,
    baselineDigest: BASELINE_DIGEST,
    policyDigest: POLICY_DIGEST,
    impactPath: ["edge_impact01"],
    risk: "high" as const,
    reason: "plan requires human approval",
    resumePhase: "planned",
    proposedBy: "agent_planner",
  };
}

function committedRequests(projectRoot: string, workflowOperationId: string) {
  const operations = new LedgerRepository({
    projectRoot,
    readBaseline: () => BASELINE,
  }).operations();
  return readApprovalRequests(harnessRootFor(projectRoot), operations, workflowOperationId);
}

/** Reopen a paused operation, like the production approval flow does. */
async function resumeOperation(projectRoot: string, workflowOperationId: string): Promise<void> {
  await resumeWorkflowOperation(deps(projectRoot, "resume"), workflowOperationId);
}

describe("expired approvals", () => {
  it("rejects a decision whose object digest no longer matches the request", async () => {
    const projectRoot = makeProjectRoot();
    try {
      const workflowOperationId = await bootOperation(projectRoot);
      const service = new ApprovalService(deps(projectRoot, "main"));
      const outcome = await service.requestApproval(requestInput(workflowOperationId));
      // The object moved after the request was minted: the exact digest the
      // decision presents no longer matches the request binding.
      await expect(
        service.resolveDecision({
          requestId: outcome.request_id,
          decision: "approve",
          objectDigest: "f".repeat(64),
          actor: "human_reviewer",
        }),
      ).rejects.toMatchObject({ name: "ApprovalError", kind: "approval_binding_mismatch" });
      // Nothing was decided: the request is still pending.
      expect(service.pendingRequests(workflowOperationId)).toHaveLength(1);
    } finally {
      cleanupDirectories();
    }
  });

  it("invalidates and re-issues a request whose bindings drifted", async () => {
    const projectRoot = makeProjectRoot();
    try {
      const workflowOperationId = await bootOperation(projectRoot);
      // The policy was rotated after the request was committed: the binding
      // snapshot now reports the new policy digest.
      const driftedBinding = (request: ApprovalRequestRecord): ApprovalBindingSnapshot => ({
        objectDigest: request.object_digest,
        baselineDigest: request.baseline_digest,
        policyDigest: "e".repeat(64),
        impactPath: [...request.impact_path],
      });
      const service = new ApprovalService(deps(projectRoot, "drift", driftedBinding));
      // Request against the pre-rotation bindings, using an undrifted reader.
      const minted = new ApprovalService(deps(projectRoot, "main"));
      const outcome = await minted.requestApproval(requestInput(workflowOperationId));
      await resumeOperation(projectRoot, workflowOperationId);

      await expect(
        service.resolveDecision({
          requestId: outcome.request_id,
          decision: "approve",
          objectDigest: OBJECT_DIGEST,
          actor: "human_reviewer",
        }),
      ).rejects.toMatchObject({
        name: "ApprovalError",
        kind: "approval_binding_drift",
        data: { changed: ["policy_digest"] },
      });

      // The stale request is superseded; its replacement binds current
      // digests and links back to the drifted request.
      const requests = committedRequests(projectRoot, workflowOperationId);
      expect(requests).toHaveLength(2);
      const pending = service.pendingRequests(workflowOperationId);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.request_id).not.toBe(outcome.request_id);
      expect(pending[0]?.policy_digest).toBe("e".repeat(64));

      // The expired request can never be resolved anymore.
      await expect(
        service.resolveDecision({
          requestId: outcome.request_id,
          decision: "approve",
          objectDigest: OBJECT_DIGEST,
          actor: "human_reviewer",
        }),
      ).rejects.toBeInstanceOf(ApprovalError);
    } finally {
      cleanupDirectories();
    }
  });

  it("refuses to resolve a request that was already terminally decided", async () => {
    const projectRoot = makeProjectRoot();
    try {
      const workflowOperationId = await bootOperation(projectRoot);
      const service = new ApprovalService(deps(projectRoot, "main"));
      const outcome = await service.requestApproval(requestInput(workflowOperationId));
      await resumeOperation(projectRoot, workflowOperationId);
      await service.resolveDecision({
        requestId: outcome.request_id,
        decision: "approve",
        objectDigest: OBJECT_DIGEST,
        actor: "human_reviewer",
      });
      await expect(
        service.resolveDecision({
          requestId: outcome.request_id,
          decision: "reject",
          objectDigest: OBJECT_DIGEST,
          actor: "human_reviewer",
        }),
      ).rejects.toMatchObject({ name: "ApprovalError", kind: "approval_not_pending" });
    } finally {
      cleanupDirectories();
    }
  });

  it("never lets the proposing agent resolve its own request", async () => {
    const projectRoot = makeProjectRoot();
    try {
      const workflowOperationId = await bootOperation(projectRoot);
      const service = new ApprovalService(deps(projectRoot, "main"));
      const outcome = await service.requestApproval(requestInput(workflowOperationId));
      await expect(
        service.resolveDecision({
          requestId: outcome.request_id,
          decision: "approve",
          objectDigest: OBJECT_DIGEST,
          actor: "agent_planner",
        }),
      ).rejects.toMatchObject({ name: "ApprovalError", kind: "approval_self_approval" });
    } finally {
      cleanupDirectories();
    }
  });
});
