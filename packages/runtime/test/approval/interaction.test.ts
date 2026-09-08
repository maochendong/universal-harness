import { describe, expect, it } from "vitest";

import {
  approvalRequiredOutcome,
  buildApprovalRequest,
  parseApprovalDecision,
  promptForApprovalDecision,
  promptForApprovalOutcome,
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

describe("promptForApprovalOutcome", () => {
  const request = buildApprovalRequest({
    requestId: "approval_request_t02",
    workflowOperationId: "workflow_t02",
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

  it("returns a decision outcome only for an explicit allowed decision", async () => {
    const prompter = (input: string): ApprovalPrompter => ({
      prompt: () => Promise.resolve(input),
    });
    await expect(promptForApprovalOutcome(request, prompter("approve"))).resolves.toEqual({
      kind: "decision",
      decision: "approve",
    });
    await expect(promptForApprovalOutcome(request, prompter(" Reject \n"))).resolves.toEqual({
      kind: "decision",
      decision: "reject",
    });
    // An explicit defer is a real decision, not an absence of one.
    await expect(promptForApprovalOutcome(request, prompter("defer"))).resolves.toEqual({
      kind: "decision",
      decision: "defer",
    });
  });

  it("returns no_decision eof when the prompter reports EOF/disconnect", async () => {
    const prompter: ApprovalPrompter = { prompt: () => Promise.resolve(null) };
    await expect(promptForApprovalOutcome(request, prompter)).resolves.toEqual({
      kind: "no_decision",
      reason: "eof",
    });
  });

  it("returns no_decision interrupted when the prompter throws (Ctrl-C)", async () => {
    const prompter: ApprovalPrompter = {
      prompt: () => Promise.reject(new Error("SIGINT")),
    };
    await expect(promptForApprovalOutcome(request, prompter)).resolves.toEqual({
      kind: "no_decision",
      reason: "interrupted",
    });
  });

  it("returns no_decision invalid_input for empty or unparseable input", async () => {
    for (const input of ["", "   ", "yes", "approve all"]) {
      const prompter: ApprovalPrompter = { prompt: () => Promise.resolve(input) };
      await expect(promptForApprovalOutcome(request, prompter)).resolves.toEqual({
        kind: "no_decision",
        reason: "invalid_input",
      });
    }
  });

  it("treats a decision the request does not allow as invalid input, never as defer", async () => {
    const restricted = buildApprovalRequest({
      requestId: "approval_request_t03",
      workflowOperationId: "workflow_t03",
      objectId: "requirement_baseline",
      objectType: "RequirementBaseline",
      objectDigest: "a".repeat(64),
      baselineDigest: "b".repeat(64),
      policyDigest: "c".repeat(64),
      impactPath: [],
      risk: "low",
      reason: "test",
      allowedDecisions: ["approve", "reject"],
      createdAt: "2026-08-12T00:00:00.000Z",
      resumePhase: "capture",
      proposedBy: "agent:harness",
    });
    const prompter: ApprovalPrompter = { prompt: () => Promise.resolve("defer") };
    await expect(promptForApprovalOutcome(restricted, prompter)).resolves.toEqual({
      kind: "no_decision",
      reason: "invalid_input",
    });
  });

  it("keeps promptForApprovalDecision as a compatible wrapper that collapses no_decision to defer", async () => {
    const eof: ApprovalPrompter = { prompt: () => Promise.resolve(null) };
    await expect(promptForApprovalDecision(request, eof)).resolves.toBe("defer");
    const explicitDefer: ApprovalPrompter = { prompt: () => Promise.resolve("defer") };
    await expect(promptForApprovalDecision(request, explicitDefer)).resolves.toBe("defer");
    const approving: ApprovalPrompter = { prompt: () => Promise.resolve("approve") };
    await expect(promptForApprovalDecision(request, approving)).resolves.toBe("approve");
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
