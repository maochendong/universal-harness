import { describe, expect, it } from "vitest";

import {
  CollaborationChainError,
  assertControlChain,
  buildCollaborationRecord,
} from "../../src/collaboration/records.js";
import { PROTOCOL_1_2_VERSION } from "../../src/protocol.js";
import {
  CollaborationConnectionRecordSchema,
  CONTROL_RECORD_KINDS,
  IntegrationRecordSchema,
  LeaseRecordSchema,
  PrincipalSnapshotRecordSchema,
  RemoteApprovalDecisionRecordSchema,
} from "../../src/schema/collaboration.js";
import { ApprovalRequestRecordSchema } from "../../src/schema/runtime.js";
import { compileSchemaValidator } from "../../src/schema/registry.js";
import {
  FIXED_NOW,
  collaborationConnectionDraft,
  digestOf,
  integrationDraft,
  leaseDraft,
  principalSnapshotDraft,
  remoteApprovalDecisionDraft,
} from "./fixtures.js";

function approvalRequestRecord() {
  return {
    protocol_version: "1.0.0",
    record_kind: "approval_request",
    request_id: "approval-request_01",
    workflow_operation_id: "workflow-op_01",
    object_id: "requirement_01",
    object_type: "Requirement",
    object_digest: digestOf("object"),
    baseline_digest: digestOf("baseline"),
    policy_digest: digestOf("policy"),
    preview_digest: digestOf("preview"),
    impact_path: [],
    risk: "medium",
    reason: "approve requirement baseline",
    allowed_decisions: ["approve", "reject", "defer"],
    created_at: FIXED_NOW,
    resume_phase: "requirements",
  };
}

describe("collaboration record schemas", () => {
  it("validate every builder-sealed Protocol 1.2 record", () => {
    const snapshot = buildCollaborationRecord(principalSnapshotDraft());
    const lease = buildCollaborationRecord(leaseDraft(snapshot.record_digest));
    const decision = buildCollaborationRecord(remoteApprovalDecisionDraft(lease.record_digest));

    const cases = [
      [
        CollaborationConnectionRecordSchema,
        buildCollaborationRecord(collaborationConnectionDraft()),
      ],
      [PrincipalSnapshotRecordSchema, snapshot],
      [LeaseRecordSchema, lease],
      [RemoteApprovalDecisionRecordSchema, decision],
      [IntegrationRecordSchema, buildCollaborationRecord(integrationDraft())],
    ] as const;
    for (const [schema, record] of cases) {
      expect(compileSchemaValidator(schema)(record), schema.properties.record_kind).toEqual({
        valid: true,
        errors: [],
      });
    }
  });

  it("marks exactly the three Control Ref record kinds", () => {
    expect(CONTROL_RECORD_KINDS).toEqual([
      "principal_snapshot",
      "lease",
      "remote_approval_decision",
    ]);
  });

  it("rejects values outside the frozen enums", () => {
    const validateConnection = compileSchemaValidator(CollaborationConnectionRecordSchema);
    const connection = buildCollaborationRecord(collaborationConnectionDraft());
    expect(validateConnection({ ...connection, provider: "bitbucket" })).toMatchObject({
      valid: false,
    });
    expect(validateConnection({ ...connection, status: "pending" })).toMatchObject({
      valid: false,
    });

    const validateSnapshot = compileSchemaValidator(PrincipalSnapshotRecordSchema);
    const snapshot = buildCollaborationRecord(principalSnapshotDraft());
    expect(validateSnapshot({ ...snapshot, permission: "owner" })).toMatchObject({
      valid: false,
    });

    const validateLease = compileSchemaValidator(LeaseRecordSchema);
    const lease = buildCollaborationRecord(leaseDraft(snapshot.record_digest));
    expect(validateLease({ ...lease, state: "held" })).toMatchObject({ valid: false });
    expect(validateLease({ ...lease, resource_kind: "file" })).toMatchObject({ valid: false });

    const validateDecision = compileSchemaValidator(RemoteApprovalDecisionRecordSchema);
    const decision = buildCollaborationRecord(remoteApprovalDecisionDraft(lease.record_digest));
    expect(validateDecision({ ...decision, decision: "abstain" })).toMatchObject({
      valid: false,
    });
    expect(validateDecision({ ...decision, required_permission: "read" })).toMatchObject({
      valid: false,
    });
  });

  it("rejects extra properties and malformed control fields", () => {
    const validateSnapshot = compileSchemaValidator(PrincipalSnapshotRecordSchema);
    const snapshot = buildCollaborationRecord(principalSnapshotDraft());
    expect(validateSnapshot({ ...snapshot, oauth_access_token: "secret" })).toMatchObject({
      valid: false,
    });
    expect(validateSnapshot({ ...snapshot, control_sequence: 0 })).toMatchObject({
      valid: false,
    });
    expect(
      validateSnapshot({ ...snapshot, previous_control_record_digest: "not-a-digest" }),
    ).toMatchObject({ valid: false });
  });
});

describe("buildCollaborationRecord", () => {
  it("pins protocol 1.2.0 and seals the envelope deterministically", () => {
    const first = buildCollaborationRecord(collaborationConnectionDraft());
    const second = buildCollaborationRecord(collaborationConnectionDraft());
    expect(first.protocol_version).toBe(PROTOCOL_1_2_VERSION);
    expect(first.record_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(second.record_digest).toBe(first.record_digest);

    const changed = buildCollaborationRecord({
      ...collaborationConnectionDraft(),
      revision: 2,
      status: "disconnected",
    });
    expect(changed.record_digest).not.toBe(first.record_digest);
  });

  it("never accepts a caller-filled protocol version or record digest", () => {
    const honest = buildCollaborationRecord(principalSnapshotDraft());
    const forged = buildCollaborationRecord({
      ...principalSnapshotDraft(),
      protocol_version: "1.1.0",
      record_digest: "0".repeat(64),
    } as unknown as ReturnType<typeof principalSnapshotDraft>);
    expect(forged.protocol_version).toBe(PROTOCOL_1_2_VERSION);
    expect(forged.record_digest).toBe(honest.record_digest);
    expect(forged.record_digest).not.toBe("0".repeat(64));
  });
});

describe("assertControlChain", () => {
  function validChain() {
    const snapshot = buildCollaborationRecord(principalSnapshotDraft());
    const lease = buildCollaborationRecord(leaseDraft(snapshot.record_digest));
    const decision = buildCollaborationRecord(remoteApprovalDecisionDraft(lease.record_digest));
    return [snapshot, lease, decision] as const;
  }

  it("accepts a chain whose first record has no previous digest and later records link exactly", () => {
    expect(() => assertControlChain(validChain())).not.toThrow();
    expect(() => assertControlChain(validChain().slice(0, 1))).not.toThrow();
  });

  it("rejects an empty chain, a first record with a previous digest, gaps and wrong links", () => {
    expect(() => assertControlChain([])).toThrow(CollaborationChainError);

    const [snapshot, lease, decision] = validChain();
    expect(() =>
      assertControlChain([
        buildCollaborationRecord({
          ...principalSnapshotDraft(),
          previous_control_record_digest: digestOf("genesis"),
        }),
      ]),
    ).toThrow(CollaborationChainError);

    expect(() => assertControlChain([snapshot, decision])).toThrow(CollaborationChainError);

    const forgedLink = buildCollaborationRecord({
      ...remoteApprovalDecisionDraft(lease.record_digest),
      previous_control_record_digest: digestOf("wrong"),
    });
    expect(() => assertControlChain([snapshot, lease, forgedLink])).toThrow(
      CollaborationChainError,
    );

    const sequenceGap = buildCollaborationRecord({
      ...leaseDraft(snapshot.record_digest),
      control_sequence: 3,
    });
    expect(() => assertControlChain([snapshot, sequenceGap])).toThrow(CollaborationChainError);
  });
});

describe("approval request requester principal binding", () => {
  const validate = compileSchemaValidator(ApprovalRequestRecordSchema);

  it("keeps requests without principal binding valid for local flows", () => {
    expect(validate(approvalRequestRecord())).toEqual({ valid: true, errors: [] });
  });

  it("accepts a request carrying both requester principal fields", () => {
    expect(
      validate({
        ...approvalRequestRecord(),
        requester_principal_id: "principal_alice",
        requester_principal_snapshot_digest: digestOf("snapshot"),
      }),
    ).toEqual({ valid: true, errors: [] });
  });

  it("rejects a request carrying only one of the two fields", () => {
    expect(
      validate({ ...approvalRequestRecord(), requester_principal_id: "principal_alice" }),
    ).toMatchObject({ valid: false });
    expect(
      validate({
        ...approvalRequestRecord(),
        requester_principal_snapshot_digest: digestOf("snapshot"),
      }),
    ).toMatchObject({ valid: false });
  });
});
