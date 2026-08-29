import type {
  CollaborationConnectionRecord,
  ControlRecord,
  IntegrationRecord,
} from "@universal-harness-internal/core";
import { describe, expect, it } from "vitest";

import { buildApprovalRequest, type ApprovalRequestRecord } from "../../src/approval/request.js";
import {
  validateRemoteApprovalDecision,
  type RemoteApprovalDecisionDraft,
} from "../../src/collaboration/approval.js";
import {
  createCollaborationCoordinator,
  type CollaborationCoordinatorDependencies,
} from "../../src/collaboration/coordinator.js";
import { collaborationFailure } from "../../src/collaboration/errors.js";
import type {
  AppendControlInput,
  CollaborationProjectionRecord,
  CollaborationSession,
  CollaborationView,
  CollaborationQuery,
  ControlSnapshotResult,
  GitControlStorePort,
  PlatformIdentityPort,
  SubmitRemoteApprovalCommand,
} from "../../src/collaboration/port.js";

const digest = (letter: string): string => letter.repeat(64);

const NOW = "2026-08-29T00:00:00.000Z";
const LATER = "2026-08-29T00:05:00.000Z";
const EARLIER = "2026-08-28T23:55:00.000Z";

const session = (principal_id: string): CollaborationSession => ({
  principal_id,
  client_instance_id: "instance_test",
});

/** Committed remote-bound request the fake request source resolves. */
function remoteRequest(overrides: { readonly legacy?: boolean } = {}): ApprovalRequestRecord {
  return buildApprovalRequest({
    requestId: "approval_request_r01",
    workflowOperationId: "workflow_op_r01",
    objectId: "requirement_baseline",
    objectType: "RequirementBaseline",
    objectDigest: digest("a"),
    baselineDigest: digest("b"),
    policyDigest: digest("c"),
    impactPath: ["intent_r01", "requirement_r01"],
    risk: "medium",
    reason: "approve the requirement baseline",
    allowedDecisions: ["approve", "reject", "defer"],
    createdAt: EARLIER,
    resumePhase: "capture",
    proposedBy: "agent:harness",
    ...(overrides.legacy === true
      ? {}
      : {
          requesterPrincipal: {
            principal_id: "principal_alice",
            principal_snapshot_digest: digest("d"),
          },
        }),
  });
}

function decisionDraft(
  overrides: Partial<RemoteApprovalDecisionDraft> = {},
): RemoteApprovalDecisionDraft {
  const request = remoteRequest();
  return {
    request_id: request.request_id,
    operation_id: request.workflow_operation_id,
    object_id: request.object_id,
    object_digest: request.object_digest,
    policy_digest: request.policy_digest,
    decision: "approve",
    required_permission: "maintain",
    decided_at: NOW,
    ...overrides,
  };
}

const approverSnapshot = (overrides: Record<string, unknown> = {}) => ({
  principal_id: "principal_bob",
  permission: "maintain" as const,
  observed_at: EARLIER,
  expires_at: LATER,
  ...overrides,
});

describe("validateRemoteApprovalDecision", () => {
  it("accepts a decision bound to the exact request with sufficient permission", () => {
    const result = validateRemoteApprovalDecision({
      request: remoteRequest(),
      snapshot: approverSnapshot(),
      decision: decisionDraft(),
    });
    expect(result).toEqual({ status: "valid" });
  });

  it("blocks a legacy request without first-class requester principal binding", () => {
    const result = validateRemoteApprovalDecision({
      request: remoteRequest({ legacy: true }),
      snapshot: approverSnapshot(),
      decision: decisionDraft(),
    });
    expect(result).toMatchObject({
      status: "blocked",
      failure: { code: "approval_binding_mismatch" },
    });
  });

  it("blocks the requester principal from approving its own request", () => {
    const result = validateRemoteApprovalDecision({
      request: remoteRequest(),
      snapshot: approverSnapshot({ principal_id: "principal_alice" }),
      decision: decisionDraft(),
    });
    expect(result).toMatchObject({
      status: "blocked",
      failure: { code: "approval_self_approval" },
    });
  });

  it("requires the snapshot to be valid at decided_at", () => {
    // Snapshot expired before the decision was made.
    expect(
      validateRemoteApprovalDecision({
        request: remoteRequest(),
        snapshot: approverSnapshot({ expires_at: NOW }),
        decision: decisionDraft(),
      }),
    ).toMatchObject({ status: "blocked", failure: { code: "permission_snapshot_stale" } });
    // Decision made before the snapshot was observed.
    expect(
      validateRemoteApprovalDecision({
        request: remoteRequest(),
        snapshot: approverSnapshot({ observed_at: LATER }),
        decision: decisionDraft(),
      }),
    ).toMatchObject({ status: "blocked", failure: { code: "permission_snapshot_stale" } });
    // Validity is judged at decided_at only; the wall clock never enters the
    // decision (design §13.1).
    expect(
      validateRemoteApprovalDecision({
        request: remoteRequest(),
        snapshot: approverSnapshot(),
        decision: decisionDraft(),
      }),
    ).toEqual({ status: "valid" });
  });

  it("blocks any request binding drift as approval_binding_mismatch", () => {
    for (const decision of [
      decisionDraft({ request_id: "approval_request_other" }),
      decisionDraft({ operation_id: "workflow_op_other" }),
      decisionDraft({ object_id: "other_object" }),
      decisionDraft({ object_digest: digest("9") }),
      decisionDraft({ policy_digest: digest("8") }),
    ]) {
      expect(
        validateRemoteApprovalDecision({
          request: remoteRequest(),
          snapshot: approverSnapshot(),
          decision,
        }),
      ).toMatchObject({ status: "blocked", failure: { code: "approval_binding_mismatch" } });
    }
  });

  it("enforces the required permission rank", () => {
    expect(
      validateRemoteApprovalDecision({
        request: remoteRequest(),
        snapshot: approverSnapshot({ permission: "write" }),
        decision: decisionDraft(),
      }),
    ).toMatchObject({ status: "blocked", failure: { code: "permission_denied" } });
    expect(
      validateRemoteApprovalDecision({
        request: remoteRequest(),
        snapshot: approverSnapshot({ permission: "write" }),
        decision: decisionDraft({ required_permission: "write" }),
      }),
    ).toEqual({ status: "valid" });
    expect(
      validateRemoteApprovalDecision({
        request: remoteRequest(),
        snapshot: approverSnapshot({ permission: "maintain" }),
        decision: decisionDraft({ required_permission: "admin" }),
      }),
    ).toMatchObject({ status: "blocked", failure: { code: "permission_denied" } });
  });
});

// --- Coordinator submit_remote_approval -------------------------------------

interface FakeControlStore {
  readonly port: GitControlStorePort;
  readonly controlRecords: ControlRecord[];
  readonly projectRecords: (CollaborationConnectionRecord | IntegrationRecord)[];
  readonly calls: { appendControl: number };
  connection?: CollaborationConnectionRecord;
  failNextAppend: boolean;
}

function createFakeControlStore(): FakeControlStore {
  const controlRecords: ControlRecord[] = [];
  const projectRecords: (CollaborationConnectionRecord | IntegrationRecord)[] = [];
  const calls = { appendControl: 0 };
  const headOid = () =>
    controlRecords.length === 0 ? undefined : `oid_control_${controlRecords.length}`;
  const store: FakeControlStore = {
    controlRecords,
    projectRecords,
    calls,
    failNextAppend: false,
    port: {
      readControl() {
        const head = headOid();
        const snapshot: ControlSnapshotResult = {
          status: "ok",
          snapshot: {
            ...(head === undefined ? {} : { control_head_oid: head }),
            control_records: [...controlRecords],
            ...(store.connection === undefined ? {} : { latest_connection: store.connection }),
          },
        };
        return Promise.resolve(snapshot);
      },
      appendControl(input: AppendControlInput) {
        calls.appendControl += 1;
        if (store.failNextAppend) {
          store.failNextAppend = false;
          return Promise.resolve({
            status: "failed" as const,
            failure: collaborationFailure(
              "git_remote_unavailable",
              "simulated remote outage",
              true,
            ),
          });
        }
        if (input.expected_head_oid !== headOid()) {
          return Promise.resolve({
            status: "failed" as const,
            failure: collaborationFailure("control_ref_cas_failed", "stale expected head", true),
          });
        }
        controlRecords.push(input.record);
        return Promise.resolve({ status: "appended" as const, head_oid: headOid() as string });
      },
      appendProjectRecord(input) {
        projectRecords.push(input.record);
        if (input.record.record_kind === "collaboration_connection") {
          store.connection = input.record;
        }
        return Promise.resolve({
          status: "committed" as const,
          commit: String(projectRecords.length).padStart(16, "0"),
        });
      },
      listOperationHeads() {
        return Promise.resolve({ status: "ok" as const, heads: [] });
      },
      compareAndSwapOperation() {
        throw new Error("not used in the approval slice tests");
      },
      prepareCandidate() {
        throw new Error("not used in the approval slice tests");
      },
      compareAndSwapTarget() {
        throw new Error("not used in the approval slice tests");
      },
      readCandidate() {
        throw new Error("not used in the approval slice tests");
      },
      readIntegrationRecord() {
        throw new Error("not used in the approval slice tests");
      },
    },
  };
  return store;
}

// The connected-project fixture is seeded by a real connect against fakes.
interface Harness {
  readonly coordinator: ReturnType<typeof createCollaborationCoordinator>;
  readonly controlStore: FakeControlStore;
  readonly projection: { readonly applied: CollaborationProjectionRecord[]; failOnApply: boolean };
  readonly requests: Map<string, ApprovalRequestRecord>;
}

async function createConnectedHarness(
  overrides: {
    readonly permission?: "read" | "write" | "maintain" | "admin";
    /** Permission snapshot expiry applied only after connect succeeds. */
    readonly expiresAtAfterConnect?: string;
    readonly withRequestSource?: boolean;
  } = {},
): Promise<Harness> {
  const requests = new Map<string, ApprovalRequestRecord>();
  requests.set("approval_request_r01", remoteRequest());
  const controlStore = createFakeControlStore();
  const applied: CollaborationProjectionRecord[] = [];
  const projection = {
    applied,
    failOnApply: false,
  };
  let expiresAt = LATER;
  const platform: PlatformIdentityPort = {
    discover: (remote) =>
      Promise.resolve({
        status: "resolved" as const,
        identity: {
          provider: "github" as const,
          host: "github.com",
          repository_id: "acme/demo",
          canonical_remote: remote,
          canonical_remote_digest: digest("r"),
        },
      }),
    authenticate: (input) =>
      Promise.resolve({
        status: "authenticated" as const,
        snapshot: {
          principal_id: input.principal_id,
          provider: input.provider,
          host: input.host,
          subject_id: "1234567",
          repository_id: input.repository_id,
          permission: overrides.permission ?? "maintain",
          observed_at: EARLIER,
          expires_at: expiresAt,
          source_response_digest: digest("s"),
        },
      }),
    inspectControlRefProtection: () => Promise.resolve({ status: "protected" as const }),
  };
  const deps: CollaborationCoordinatorDependencies = {
    platform,
    controlStore: controlStore.port,
    projection: {
      rebuild: () => Promise.resolve(),
      apply: (record: CollaborationProjectionRecord) => {
        if (projection.failOnApply) return Promise.reject(new Error("sqlite write failed"));
        applied.push(record);
        return Promise.resolve();
      },
      query: (query: CollaborationQuery): Promise<CollaborationView> =>
        Promise.resolve({
          kind: query.kind,
          project_id: query.project_id,
          ...(query.kind === "connection_status" ? { status: "active" as const } : {}),
          ...(query.kind === "operations" ? { operations: [] } : {}),
          ...(query.kind === "approval_inbox" ? { decisions: [] } : {}),
          ...(query.kind === "integration_conflicts" ? { conflicts: [] } : {}),
        } as CollaborationView),
    },
    now: () => NOW,
    ...(overrides.withRequestSource === false
      ? {}
      : {
          readApprovalRequest: (input: {
            readonly project_id: string;
            readonly request_id: string;
          }) => Promise.resolve(requests.get(input.request_id)),
        }),
  };
  const coordinator = createCollaborationCoordinator(deps);

  // Connect through the real flow so the Control Ref carries a snapshot and
  // the project carries an active connection.
  const connected = await coordinator.execute(
    {
      kind: "connect",
      command_id: "command_connect_1",
      project_id: "project_demo",
      canonical_remote: "https://github.com/acme/demo.git",
      target_ref: "refs/heads/main",
      coordinator_origin: "https://harness.example.com",
      policy_digest: digest("1"),
    },
    session("principal_alice"),
  );
  if (connected.status !== "connected") throw new Error("expected connected outcome");
  if (overrides.expiresAtAfterConnect !== undefined) expiresAt = overrides.expiresAtAfterConnect;
  return { coordinator, controlStore, projection, requests };
}

function submitCommand(
  overrides: Partial<SubmitRemoteApprovalCommand> = {},
): SubmitRemoteApprovalCommand {
  return {
    kind: "submit_remote_approval",
    command_id: "command_decision_1",
    project_id: "project_demo",
    request_id: "approval_request_r01",
    decision: "approve",
    ...overrides,
  };
}

describe("collaboration coordinator submit_remote_approval", () => {
  it("validates, appends the snapshot and decision, and projects both", async () => {
    const { coordinator, controlStore, projection } = await createConnectedHarness();
    const projectedBefore = projection.applied.length;

    const outcome = await coordinator.execute(submitCommand(), session("principal_bob"));

    expect(outcome.status).toBe("remote_approval");
    if (outcome.status !== "remote_approval") throw new Error("expected remote_approval outcome");
    expect(outcome.replayed).toBe(false);
    expect(outcome.decision).toMatchObject({
      protocol_version: "1.2.0",
      record_kind: "remote_approval_decision",
      request_id: "approval_request_r01",
      operation_id: "workflow_op_r01",
      object_id: "requirement_baseline",
      object_digest: digest("a"),
      policy_digest: digest("c"),
      decision: "approve",
      required_permission: "maintain",
      decided_at: NOW,
      command_id: "command_decision_1",
    });
    // connect snapshot, approver snapshot, decision
    expect(controlStore.controlRecords.map((record) => record.record_kind)).toEqual([
      "principal_snapshot",
      "principal_snapshot",
      "remote_approval_decision",
    ]);
    const approverSnapshotRecord = controlStore.controlRecords[1];
    expect(approverSnapshotRecord).toMatchObject({
      record_kind: "principal_snapshot",
      principal_id: "principal_bob",
      permission: "maintain",
    });
    expect(outcome.decision.principal_snapshot_digest).toBe(approverSnapshotRecord?.record_digest);
    expect(projection.applied.length - projectedBefore).toBe(2);
  });

  it("replays a repeated command_id without new records", async () => {
    const { coordinator, controlStore } = await createConnectedHarness();
    const first = await coordinator.execute(submitCommand(), session("principal_bob"));
    const second = await coordinator.execute(submitCommand(), session("principal_bob"));

    expect(second).toMatchObject({ status: "remote_approval", replayed: true });
    if (first.status === "remote_approval" && second.status === "remote_approval") {
      expect(second.decision.record_digest).toBe(first.decision.record_digest);
    }
    // connect (1 snapshot) + submit (1 snapshot + 1 decision) only.
    expect(controlStore.calls.appendControl).toBe(3);
  });

  it("first terminal decision wins: a competitor gets the existing decision", async () => {
    const { coordinator, controlStore } = await createConnectedHarness();
    const first = await coordinator.execute(submitCommand(), session("principal_bob"));
    const second = await coordinator.execute(
      submitCommand({ command_id: "command_decision_2", decision: "reject" }),
      session("principal_carol"),
    );

    expect(second.status).toBe("remote_approval");
    if (first.status !== "remote_approval" || second.status !== "remote_approval") {
      throw new Error("expected remote_approval outcomes");
    }
    expect(second.decision.decision).toBe("approve");
    expect(second.decision.command_id).toBe("command_decision_1");
    expect(second.decision.record_digest).toBe(first.decision.record_digest);
    // The competitor caused no new Control Ref records.
    expect(controlStore.calls.appendControl).toBe(3);
  });

  it("defer does not terminate the request", async () => {
    const { coordinator, controlStore } = await createConnectedHarness();
    const deferred = await coordinator.execute(
      submitCommand({ decision: "defer" }),
      session("principal_bob"),
    );
    expect(deferred.status).toBe("remote_approval");
    const decided = await coordinator.execute(
      submitCommand({ command_id: "command_decision_2", decision: "approve" }),
      session("principal_carol"),
    );

    expect(decided.status).toBe("remote_approval");
    if (decided.status !== "remote_approval") throw new Error("expected remote_approval outcome");
    expect(decided.replayed).toBe(false);
    expect(decided.decision.decision).toBe("approve");
    expect(decided.decision.command_id).toBe("command_decision_2");
    expect(controlStore.controlRecords.map((record) => record.record_kind)).toEqual([
      "principal_snapshot",
      "principal_snapshot",
      "remote_approval_decision",
      "principal_snapshot",
      "remote_approval_decision",
    ]);
  });

  it("blocks the requester principal from approving its own request", async () => {
    const { coordinator, controlStore } = await createConnectedHarness();

    const outcome = await coordinator.execute(submitCommand(), session("principal_alice"));

    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "approval_self_approval" },
    });
    // Only the connect snapshot exists; nothing was appended.
    expect(controlStore.calls.appendControl).toBe(1);
  });

  it("blocks a legacy request without requester principal binding", async () => {
    const { coordinator, controlStore, requests } = await createConnectedHarness();
    requests.set("approval_request_r01", remoteRequest({ legacy: true }));

    const outcome = await coordinator.execute(submitCommand(), session("principal_bob"));

    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "approval_binding_mismatch" },
    });
    expect(controlStore.calls.appendControl).toBe(1);
  });

  it("blocks an unknown request", async () => {
    const { coordinator, controlStore } = await createConnectedHarness();

    const outcome = await coordinator.execute(
      submitCommand({ request_id: "approval_request_unknown" }),
      session("principal_bob"),
    );

    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "approval_binding_mismatch" },
    });
    expect(controlStore.calls.appendControl).toBe(1);
  });

  it("blocks an expired permission snapshot", async () => {
    const { coordinator, controlStore } = await createConnectedHarness({
      expiresAtAfterConnect: EARLIER,
    });

    const outcome = await coordinator.execute(submitCommand(), session("principal_bob"));

    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "permission_snapshot_stale" },
    });
    expect(controlStore.calls.appendControl).toBe(1);
  });

  it("blocks a principal below the required permission", async () => {
    const { coordinator, controlStore } = await createConnectedHarness({ permission: "write" });

    const outcome = await coordinator.execute(submitCommand(), session("principal_bob"));

    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "permission_denied" },
    });
    expect(controlStore.calls.appendControl).toBe(1);
  });

  it("fails closed when the approval request source is not wired", async () => {
    const { coordinator } = await createConnectedHarness({ withRequestSource: false });

    const outcome = await coordinator.execute(submitCommand(), session("principal_bob"));

    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "coordinator_unavailable" },
    });
  });

  it("recovers a lost response: retry with the same command_id finds the same decision", async () => {
    const { coordinator, controlStore } = await createConnectedHarness();
    controlStore.failNextAppend = true;

    const failed = await coordinator.execute(submitCommand(), session("principal_bob"));
    expect(failed).toMatchObject({
      status: "failed",
      failure: { code: "git_remote_unavailable" },
    });

    const retried = await coordinator.execute(submitCommand(), session("principal_bob"));
    expect(retried.status).toBe("remote_approval");
    if (retried.status !== "remote_approval") throw new Error("expected remote_approval outcome");
    expect(retried.decision.remote_decision_id).toMatch(/^remote-decision_[a-f0-9]{24}$/);
    expect(retried.decision.command_id).toBe("command_decision_1");
    expect(
      controlStore.controlRecords.filter(
        (record) => record.record_kind === "remote_approval_decision",
      ),
    ).toHaveLength(1);
  });
});
