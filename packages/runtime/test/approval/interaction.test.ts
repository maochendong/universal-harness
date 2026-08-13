import { describe, expect, it } from "vitest";

import {
  approvalRequiredOutcome,
  buildApprovalRequest,
  parseApprovalDecision,
  promptForApprovalDecision,
  type ApprovalPrompter,
} from "../../src/index.js";

const ALLOWED = ["approve", "reject", "defer"] as const;

describe("parseApprovalDecision", () => {
  it("accepts only explicit decisions", () => {
    expect(parseApprovalDecision("approve", ALLOWED)).toBe("approve");
    expect(parseApprovalDecision("  Reject \n", ALLOWED)).toBe("reject");
    expect(parseApprovalDecision("defer", ALLOWED)).toBe("defer");
  });

  it("maps EOF, empty and unparseable input to defer", () => {
    expect(parseApprovalDecision(null, ALLOWED)).toBe("defer");
    expect(parseApprovalDecision(undefined, ALLOWED)).toBe("defer");
    expect(parseApprovalDecision("", ALLOWED)).toBe("defer");
    expect(parseApprovalDecision("yes", ALLOWED)).toBe("defer");
    expect(parseApprovalDecision("approve all", ALLOWED)).toBe("defer");
  });

  it("never infers a decision the request does not allow", () => {
    expect(parseApprovalDecision("approve", ["reject", "defer"])).toBe("defer");
    expect(parseApprovalDecision("reject", ["approve", "defer"])).toBe("defer");
  });
});

describe("promptForApprovalDecision", () => {
  const request = buildApprovalRequest({
    requestId: "approval_request_t01",
    workflowOperationId: "workflow_t01",
    objectId: "requirement_baseline",
    objectType: "RequirementBaseline",
    objectDigest: "a".repeat(64),
    baselineDigest: "b".repeat(64),
    policyDigest: "c".repeat(64),
    impactPath: [],
    risk: "low",
    reason: "test",
    allowedDecisions: [...ALLOWED],
    createdAt: "2026-08-12T00:00:00.000Z",
    resumePhase: "capture",
    proposedBy: "agent:harness",
  });

  it("returns the explicit decision from the prompter", async () => {
    const seen: string[] = [];
    const prompter: ApprovalPrompter = {
      prompt: (preview) => {
        seen.push(preview);
        return Promise.resolve("approve");
      },
    };
    await expect(promptForApprovalDecision(request, prompter)).resolves.toBe("approve");
    expect(seen[0]).toContain("Approval Request: approval_request_t01");
  });

  it("treats a prompter failure (Ctrl-C) as defer", async () => {
    const prompter: ApprovalPrompter = {
      prompt: () => Promise.reject(new Error("SIGINT")),
    };
    await expect(promptForApprovalDecision(request, prompter)).resolves.toBe("defer");
  });

  it("treats EOF (null input) as defer", async () => {
    const prompter: ApprovalPrompter = { prompt: () => Promise.resolve(null) };
    await expect(promptForApprovalDecision(request, prompter)).resolves.toBe("defer");
  });
});

describe("approvalRequiredOutcome", () => {
  it("is structured, stable and carries the resume command", () => {
    const request = buildApprovalRequest({
      requestId: "approval_request_t01",
      workflowOperationId: "workflow_t01",
      objectId: "requirement_baseline",
      objectType: "RequirementBaseline",
      objectDigest: "a".repeat(64),
      baselineDigest: "b".repeat(64),
      policyDigest: "c".repeat(64),
      impactPath: [],
      risk: "low",
      reason: "test",
      allowedDecisions: [...ALLOWED],
      createdAt: "2026-08-12T00:00:00.000Z",
      resumePhase: "capture",
      proposedBy: "agent:harness",
    });
    const outcome = approvalRequiredOutcome(request);

    expect(outcome).toEqual({
      status: "approval_required",
      error_category: "approval_required",
      request_id: "approval_request_t01",
      object_id: "requirement_baseline",
      object_type: "RequirementBaseline",
      object_digest: "a".repeat(64),
      workflow_operation_id: "workflow_t01",
      resume_phase: "capture",
      resume_command: "harness resume workflow_t01",
      allowed_decisions: ["approve", "reject", "defer"],
    });
  });
});
