import { describe, expect, it } from "vitest";

import { validateSchema } from "@universal-harness-internal/core";

import {
  buildApprovalRequest,
  previewDigestMatches,
  proposedByOf,
  renderApprovalPreview,
  supersededRequestId,
  type ApprovalRequestSpec,
} from "../../src/index.js";

function makeSpec(overrides?: Partial<ApprovalRequestSpec>): ApprovalRequestSpec {
  return {
    requestId: "approval_request_t01",
    workflowOperationId: "workflow_t01",
    objectId: "requirement_baseline",
    objectType: "RequirementBaseline",
    objectDigest: "a".repeat(64),
    baselineDigest: "b".repeat(64),
    policyDigest: "c".repeat(64),
    impactPath: ["intent_t01", "requirement_t01"],
    risk: "medium",
    reason: "approve the requirement baseline",
    allowedDecisions: ["approve", "reject", "defer"],
    createdAt: "2026-08-12T00:00:00.000Z",
    resumePhase: "capture",
    proposedBy: "agent:harness",
    ...overrides,
  };
}

describe("buildApprovalRequest", () => {
  it("builds a schema-valid record bound to every digest", () => {
    const record = buildApprovalRequest(makeSpec());

    expect(validateSchema("runtime", record).valid).toBe(true);
    expect(record.object_digest).toBe("a".repeat(64));
    expect(record.impact_path).toEqual(["intent_t01", "requirement_t01"]);
    expect(proposedByOf(record)).toBe("agent:harness");
    expect(supersededRequestId(record)).toBeUndefined();
  });

  it("binds the preview rendering via preview_digest", () => {
    const record = buildApprovalRequest(makeSpec());

    expect(previewDigestMatches(record)).toBe(true);
    const tampered = { ...record, reason: "approve everything without review" };
    expect(previewDigestMatches(tampered)).toBe(false);
  });

  it("renders the preview deterministically from the same record", () => {
    const record = buildApprovalRequest(makeSpec());
    const preview = renderApprovalPreview(record);

    expect(preview).toContain("Approval Request: approval_request_t01");
    expect(preview).toContain("Object: RequirementBaseline requirement_baseline");
    expect(preview).toContain("Impact Path: intent_t01 -> requirement_t01");
    expect(preview).toContain("Allowed Decisions: approve|reject|defer");
    expect(renderApprovalPreview(buildApprovalRequest(makeSpec()))).toBe(preview);
    expect(preview).not.toContain(record.preview_digest);
  });

  it("records the superseded request id for re-issued requests", () => {
    const record = buildApprovalRequest(makeSpec({ supersedesRequestId: "approval_request_t00" }));
    expect(supersededRequestId(record)).toBe("approval_request_t00");
    expect(previewDigestMatches(record)).toBe(true);
  });

  it("rejects invalid specs instead of emitting an invalid record", () => {
    let caught: unknown;
    try {
      buildApprovalRequest(makeSpec({ objectDigest: "not-a-digest" }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      name: "ApprovalError",
      kind: "approval_request_invalid",
    });
  });
});

describe("buildApprovalRequest requester principal binding (protocol 1.2)", () => {
  const requesterPrincipal = {
    principal_id: "principal_alice",
    principal_snapshot_digest: "d".repeat(64),
  };

  it("binds the requester principal as first-class fields and emits protocol 1.2", () => {
    const record = buildApprovalRequest(makeSpec({ requesterPrincipal }));

    expect(record.requester_principal_id).toBe("principal_alice");
    expect(record.requester_principal_snapshot_digest).toBe("d".repeat(64));
    expect(record.protocol_version).toBe("1.2.0");
    expect(validateSchema("runtime", record).valid).toBe(true);
    expect(previewDigestMatches(record)).toBe(true);
    // The local proposed_by extension is kept for 1.0/1.1 local compatibility.
    expect(proposedByOf(record)).toBe("agent:harness");
  });

  it("omits the requester fields and keeps the local protocol version without a principal", () => {
    const record = buildApprovalRequest(makeSpec());

    expect(record.requester_principal_id).toBeUndefined();
    expect(record.requester_principal_snapshot_digest).toBeUndefined();
    expect(record.protocol_version).not.toBe("1.2.0");
    expect(previewDigestMatches(record)).toBe(true);
  });

  it("binds the requester fields into the preview digest", () => {
    const record = buildApprovalRequest(makeSpec({ requesterPrincipal }));

    const tampered = { ...record, requester_principal_id: "principal_mallory" };
    expect(previewDigestMatches(tampered)).toBe(false);
    // Two requests that differ only in the requester binding have different
    // preview digests.
    const other = buildApprovalRequest(
      makeSpec({
        requesterPrincipal: { ...requesterPrincipal, principal_id: "principal_mallory" },
      }),
    );
    expect(other.preview_digest).not.toBe(record.preview_digest);
  });
});
