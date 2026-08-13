import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
  validateSchema,
  type FeedbackRecord,
} from "@universal-harness-internal/core";
import type {
  ApprovalDecisionRecord,
  ApprovalRequestRecord,
} from "@universal-harness-internal/runtime";

import type { FeedbackError } from "../../src/feedback/finding.js";
import { buildImprovementCandidate } from "../../src/feedback/improvement.js";
import { promoteImprovementCandidate } from "../../src/feedback/promotion.js";

import { FIXED_TIMESTAMP, TIMESTAMP_CLOCK, makeNode } from "./fixtures.js";

/**
 * Promotion (design 9.1 and principle 8, plan Task 21, completion rule 18):
 * a candidate stays proposed until an approval bound to its exact digest
 * approves it; the promoter may never be the proposer; promotion creates a
 * normal accepted ledger revision of the target node.
 */
function candidate(): FeedbackRecord {
  return buildImprovementCandidate({
    id: "improvement_repeat-case",
    iterationId: "iteration_01",
    summary: "add a repeat-detection evaluation case",
    content: {
      target_kind: "evaluation",
      target_layer: "eval",
      failure_class: "repeat-tool-call",
      expected_behavior: "the run terminates with a typed repeat detection",
      reproduction: ["run the repeat scenario"],
      verification_method: "re-run the repeat evaluation case",
      approved_secret_references: [],
    },
    clock: TIMESTAMP_CLOCK,
  });
}

function requestFor(target: FeedbackRecord, proposedBy = "agent-1"): ApprovalRequestRecord {
  return {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "approval_request",
    request_id: "approvalreq_promote-repeat",
    workflow_operation_id: "wfop_01",
    object_id: target.id,
    object_type: "ImprovementCandidate",
    object_digest: target.digest,
    baseline_digest: "0".repeat(64),
    policy_digest: "f".repeat(64),
    preview_digest: "1".repeat(64),
    impact_path: [],
    risk: "medium",
    reason: "promote the repeat-detection evaluation case",
    allowed_decisions: ["approve", "reject", "defer"],
    created_at: FIXED_TIMESTAMP,
    resume_phase: "verification",
    extensions: { "harness.approval": { proposed_by: proposedBy } },
  };
}

function decisionFor(
  request: ApprovalRequestRecord,
  decision: "approve" | "reject" | "defer",
  actor = "human-1",
): ApprovalDecisionRecord {
  return {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "approval_decision",
    approval_id: "approval_repeat",
    request_id: request.request_id,
    actor,
    decision,
    object_digest: request.object_digest,
    decided_at: FIXED_TIMESTAMP,
  };
}

function promote(overrides?: {
  decision?: "approve" | "reject" | "defer";
  actor?: string;
  targetType?: "EvaluationCase" | "Policy";
  mutateDigest?: boolean;
}) {
  const target = candidate();
  const request = requestFor(target);
  const decided = decisionFor(request, overrides?.decision ?? "approve", overrides?.actor);
  const decision =
    overrides?.mutateDigest === true ? { ...decided, object_digest: "9".repeat(64) } : decided;
  return promoteImprovementCandidate({
    candidate: target,
    request,
    decision,
    target: makeNode("evaluationcase_repeat", overrides?.targetType ?? "EvaluationCase"),
    actor: "workflow-engine",
    timestamp: FIXED_TIMESTAMP,
  });
}

describe("promoteImprovementCandidate", () => {
  it("promotes on approval and revises the target as a normal ledger revision", () => {
    const outcome = promote();
    expect(outcome.candidate.status).toBe("accepted");
    expect(validateSchema("feedback", outcome.candidate).valid).toBe(true);
    expect(outcome.revision.revision).toBe(2);
    expect(outcome.revision.status).toBe("accepted");
    expect(validateSchema("node", outcome.revision).valid).toBe(true);
    expect(outcome.revision.provenance.actor).toBe("workflow-engine");
  });

  it("keeps the candidate proposed when the decision is not an approval", () => {
    for (const decision of ["reject", "defer"] as const) {
      expect(() => promote({ decision })).toThrowError(
        expect.objectContaining({ kind: "unapproved_promotion" }) as FeedbackError,
      );
    }
  });

  it("rejects approvals that do not bind the current candidate digest", () => {
    expect(() => promote({ mutateDigest: true })).toThrowError(
      expect.objectContaining({ kind: "promotion_binding_mismatch" }) as FeedbackError,
    );
  });

  it("forbids self-promotion by the proposer", () => {
    expect(() => promote({ actor: "agent-1" })).toThrowError(
      expect.objectContaining({ kind: "self_promotion" }) as FeedbackError,
    );
  });

  it("rejects targets outside the candidate's owning layer", () => {
    expect(() => promote({ targetType: "Policy" })).toThrowError(
      expect.objectContaining({ kind: "promotion_binding_mismatch" }) as FeedbackError,
    );
  });

  it("refuses to promote a candidate that is not proposed", () => {
    const promoted = promote().candidate;
    expect(() =>
      promoteImprovementCandidate({
        candidate: promoted,
        request: requestFor(promoted),
        decision: decisionFor(requestFor(promoted), "approve"),
        target: makeNode("evaluationcase_repeat", "EvaluationCase"),
        actor: "workflow-engine",
        timestamp: FIXED_TIMESTAMP,
      }),
    ).toThrowError(
      expect.objectContaining({ kind: "invalid_feedback_transition" }) as FeedbackError,
    );
  });
});
