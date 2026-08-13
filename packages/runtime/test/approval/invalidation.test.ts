import { describe, expect, it } from "vitest";

import {
  bindingDrift,
  buildApprovalRequest,
  proposedByOf,
  reissueRequestSpec,
  supersededRequestId,
  type ApprovalBindingSnapshot,
} from "../../src/index.js";

function makeRequest() {
  return buildApprovalRequest({
    requestId: "approval_request_t01",
    workflowOperationId: "workflow_t01",
    objectId: "requirement_baseline",
    objectType: "RequirementBaseline",
    objectDigest: "a".repeat(64),
    baselineDigest: "b".repeat(64),
    policyDigest: "c".repeat(64),
    impactPath: ["intent_t01"],
    risk: "high",
    reason: "approve the requirement baseline",
    allowedDecisions: ["approve", "reject", "defer"],
    createdAt: "2026-08-12T00:00:00.000Z",
    resumePhase: "capture",
    proposedBy: "agent:harness",
  });
}

function unchangedSnapshot(): ApprovalBindingSnapshot {
  return {
    objectDigest: "a".repeat(64),
    baselineDigest: "b".repeat(64),
    policyDigest: "c".repeat(64),
    impactPath: ["intent_t01"],
  };
}

describe("bindingDrift", () => {
  it("reports no drift when every binding item is unchanged", () => {
    expect(bindingDrift(makeRequest(), unchangedSnapshot())).toEqual([]);
  });

  it("names each changed binding item in a stable order", () => {
    const drifted = bindingDrift(makeRequest(), {
      objectDigest: "1".repeat(64),
      baselineDigest: "b".repeat(64),
      policyDigest: "2".repeat(64),
      impactPath: ["intent_t01", "requirement_t02"],
    });
    expect(drifted).toEqual(["object_digest", "policy_digest", "impact_path"]);
  });
});

describe("reissueRequestSpec", () => {
  it("re-issues with current digests and a supersedes link", () => {
    const request = makeRequest();
    const current: ApprovalBindingSnapshot = {
      ...unchangedSnapshot(),
      policyDigest: "d".repeat(64),
    };
    const spec = reissueRequestSpec(request, current, {
      requestId: "approval_request_t02",
      createdAt: "2026-08-12T01:00:00.000Z",
      proposedBy: proposedByOf(request) ?? "unknown",
    });
    const reissued = buildApprovalRequest(spec);

    expect(reissued.request_id).toBe("approval_request_t02");
    expect(reissued.object_id).toBe(request.object_id);
    expect(reissued.policy_digest).toBe("d".repeat(64));
    expect(reissued.risk).toBe("high");
    expect(supersededRequestId(reissued)).toBe("approval_request_t01");
    expect(proposedByOf(reissued)).toBe("agent:harness");
  });
});
