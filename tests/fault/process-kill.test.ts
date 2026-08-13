import { describe, expect, it } from "vitest";

import {
  DURABLE_BOUNDARIES,
  LedgerRepository,
  harnessRootFor,
  type DurableBoundary,
} from "../../packages/core/src/index.js";
import {
  ApprovalError,
  ApprovalService,
  WorkflowEngine,
  WorkflowError,
  readApprovalDecisions,
  readApprovalRequests,
  resumeWorkflowOperation,
  type ApprovalDependencies,
} from "../../packages/runtime/src/index.js";
import {
  BASELINE,
  FIXED_NOW,
  cleanupDirectories,
  makeProjectRoot,
  makeStartInput,
  phaseIds,
} from "../../packages/runtime/test/workflow/helpers.js";
import { SimulatedProcessKill, createFaultInjector } from "../helpers/fault-injection.js";

/**
 * Process-kill fault injection for the approval durable operations (plan
 * Task 27 step 2). Every durable boundary of the approval-request commit and
 * the approval-decision commit is killed and retried: a kill never exposes a
 * partially accepted request or decision, and retrying the same logical
 * attempt never duplicates requests, decisions or events.
 */
function approvalDeps(
  projectRoot: string,
  tag: string,
  boundary?: DurableBoundary,
): ApprovalDependencies {
  return {
    projectRoot,
    readBaseline: () => BASELINE,
    now: () => FIXED_NOW,
    newId: phaseIds(tag),
    ...(boundary === undefined
      ? {}
      : { hooks: createFaultInjector({ boundary, kind: "process-kill" }).hooks }),
  };
}

async function bootOperation(projectRoot: string): Promise<string> {
  const engine = new WorkflowEngine({
    projectRoot,
    readBaseline: () => BASELINE,
    now: () => FIXED_NOW,
    newId: phaseIds("boot"),
  });
  const started = await engine.startOperation(makeStartInput());
  return started.operation.workflow_operation_id;
}

const BASELINE_DIGEST = "a".repeat(64);

function requestInput(workflowOperationId: string) {
  return {
    workflowOperationId,
    objectId: "plan_01",
    objectType: "ExecutionPlan",
    objectDigest: "c".repeat(64),
    baselineDigest: BASELINE_DIGEST,
    policyDigest: "b".repeat(64),
    impactPath: ["edge_impact01"],
    risk: "high" as const,
    reason: "plan requires human approval",
    resumePhase: "planned",
    proposedBy: "agent_planner",
  };
}

function committedOperations(projectRoot: string) {
  return new LedgerRepository({ projectRoot, readBaseline: () => BASELINE }).operations();
}

function committedRequests(projectRoot: string, workflowOperationId: string) {
  return readApprovalRequests(
    harnessRootFor(projectRoot),
    committedOperations(projectRoot),
    workflowOperationId,
  );
}

function committedDecisions(projectRoot: string, workflowOperationId: string) {
  return readApprovalDecisions(
    harnessRootFor(projectRoot),
    committedOperations(projectRoot),
    workflowOperationId,
  );
}

describe("approval request commit process-kill", () => {
  for (const boundary of DURABLE_BOUNDARIES) {
    it(`commits the request exactly once when killed at ${boundary}`, async () => {
      const projectRoot = makeProjectRoot();
      try {
        const workflowOperationId = await bootOperation(projectRoot);

        const crashed = new ApprovalService(approvalDeps(projectRoot, "req", boundary));
        await expect(
          crashed.requestApproval(requestInput(workflowOperationId)),
        ).rejects.toBeInstanceOf(SimulatedProcessKill);

        // Retrying the same logical attempt mints identical ids: a
        // pre-commit kill commits cleanly; a post-commit kill surfaces a
        // typed conflict because the attempt already landed. Never a
        // duplicate.
        const retried = new ApprovalService(approvalDeps(projectRoot, "req"));
        try {
          const outcome = await retried.requestApproval(requestInput(workflowOperationId));
          expect(outcome.workflow_operation_id).toBe(workflowOperationId);
        } catch (error) {
          expect(error).toBeInstanceOf(WorkflowError);
        }

        const requests = committedRequests(projectRoot, workflowOperationId);
        expect(requests).toHaveLength(1);
        expect(retried.pendingRequests(workflowOperationId)).toHaveLength(1);
      } finally {
        cleanupDirectories();
      }
    });
  }
});

describe("approval decision commit process-kill", () => {
  for (const boundary of DURABLE_BOUNDARIES) {
    it(`commits the decision exactly once when killed at ${boundary}`, async () => {
      const projectRoot = makeProjectRoot();
      try {
        const workflowOperationId = await bootOperation(projectRoot);
        const requested = new ApprovalService(approvalDeps(projectRoot, "req"));
        const outcome = await requested.requestApproval(requestInput(workflowOperationId));
        const requestId = outcome.request_id;

        // A paused operation cannot accept the decision checkpoint; reopen
        // it first, exactly like the production approval flow does.
        await resumeWorkflowOperation(approvalDeps(projectRoot, "resume"), workflowOperationId);

        const crashed = new ApprovalService(approvalDeps(projectRoot, "dec", boundary));
        await expect(
          crashed.resolveDecision({
            requestId,
            decision: "approve",
            objectDigest: "c".repeat(64),
            actor: "human_reviewer",
          }),
        ).rejects.toBeInstanceOf(SimulatedProcessKill);

        // Retry: a pre-commit kill resolves cleanly; a post-commit kill is a
        // typed refusal because the request is already terminally decided.
        const retried = new ApprovalService(approvalDeps(projectRoot, "dec"));
        try {
          const record = await retried.resolveDecision({
            requestId,
            decision: "approve",
            objectDigest: "c".repeat(64),
            actor: "human_reviewer",
          });
          expect(record.decision).toBe("approve");
        } catch (error) {
          expect(error).toBeInstanceOf(ApprovalError);
        }

        // Exactly one decision landed; the request is terminally decided.
        expect(committedDecisions(projectRoot, workflowOperationId)).toHaveLength(1);
        expect(retried.pendingRequests(workflowOperationId)).toHaveLength(0);
        await expect(
          retried.resolveDecision({
            requestId,
            decision: "approve",
            objectDigest: "c".repeat(64),
            actor: "human_reviewer",
          }),
        ).rejects.toBeInstanceOf(ApprovalError);
      } finally {
        cleanupDirectories();
      }
    });
  }
});
