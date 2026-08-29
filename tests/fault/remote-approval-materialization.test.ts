import { describe, expect, it } from "vitest";

import {
  buildCollaborationRecord,
  LedgerRepository,
  type CollaborationConnectionRecord,
  type ControlRecord,
  type IntegrationRecord,
  type PrincipalSnapshotRecord,
  type RemoteApprovalDecisionRecord,
} from "../../packages/core/src/index.js";
import {
  ApprovalService,
  WorkflowEngine,
  createCollaborationCoordinator,
  materializeRemoteApprovalDecision,
  remoteDecisionIdFor,
  resumeWorkflowOperation,
  type ApprovalDependencies,
  type ApprovalRequestRecord,
  type CollaborationCoordinatorDependencies,
  type CollaborationFailure,
  type CollaborationSession,
  type ControlSnapshotResult,
  type GitControlStorePort,
  type PlatformIdentityPort,
} from "../../packages/runtime/src/index.js";
import {
  BASELINE,
  FIXED_NOW,
  cleanupDirectories,
  makeDeps,
  makeProjectRoot,
  makeStartInput,
  phaseIds,
} from "../../packages/runtime/test/workflow/helpers.js";

/**
 * Remote approval crash and delayed-materialization fault injection (design
 * §13.1, §15.2; plan M3 Task 5 step 5). Failures are injected at the durable
 * boundaries of the vertical loop — Control Ref CAS before the response,
 * Control CAS success before the SQLite projection update, and the
 * ApprovalDecision ledger commit before the response — and every retry must
 * recover the same remote_decision_id / command_id / approval binding instead
 * of duplicating facts. A snapshot that has expired by the wall clock but was
 * valid at decided_at never forces a repeated human approval.
 */

const digest = (letter: string): string => letter.repeat(64);

const OBSERVED_AT = "2026-08-12T00:00:00.000Z";
const DECIDED_AT = "2026-08-12T00:01:00.000Z";
const EXPIRES_AT = "2026-08-12T00:05:00.000Z";
const WELL_PAST_EXPIRY = "2026-08-12T00:30:00.000Z";

const session = (principal_id: string): CollaborationSession => ({
  principal_id,
  client_instance_id: "instance_test",
});

function failure(code: CollaborationFailure["code"], summary: string, retryable = false) {
  return { code, summary, retryable };
}

// --- Coordinator-side fakes (control CAS and projection boundaries) ---------

interface FakeControlStore {
  readonly port: GitControlStorePort;
  readonly controlRecords: ControlRecord[];
  readonly calls: { appendControl: number };
  connection?: CollaborationConnectionRecord;
  failNextAppend: boolean;
}

function createFakeControlStore(): FakeControlStore {
  const controlRecords: ControlRecord[] = [];
  const calls = { appendControl: 0 };
  const headOid = () =>
    controlRecords.length === 0 ? undefined : `oid_control_${controlRecords.length}`;
  const store: FakeControlStore = {
    controlRecords,
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
      appendControl(input) {
        calls.appendControl += 1;
        if (store.failNextAppend) {
          store.failNextAppend = false;
          return Promise.resolve({
            status: "failed" as const,
            failure: failure("git_remote_unavailable", "simulated remote outage", true),
          });
        }
        if (input.expected_head_oid !== headOid()) {
          return Promise.resolve({
            status: "failed" as const,
            failure: failure("control_ref_cas_failed", "stale expected head", true),
          });
        }
        controlRecords.push(input.record);
        return Promise.resolve({ status: "appended" as const, head_oid: headOid() as string });
      },
      appendProjectRecord(input) {
        if (input.record.record_kind === "collaboration_connection") {
          store.connection = input.record;
        }
        return Promise.resolve({ status: "committed" as const, commit: "0".repeat(16) });
      },
      listOperationHeads() {
        return Promise.resolve({ status: "ok" as const, heads: [] });
      },
      compareAndSwapOperation() {
        throw new Error("not used in the approval fault tests");
      },
      prepareCandidate() {
        throw new Error("not used in the approval fault tests");
      },
      compareAndSwapTarget() {
        throw new Error("not used in the approval fault tests");
      },
      readCandidate() {
        throw new Error("not used in the approval fault tests");
      },
      readIntegrationRecord() {
        throw new Error("not used in the approval fault tests");
      },
    },
  };
  return store;
}

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
        permission: "maintain" as const,
        observed_at: OBSERVED_AT,
        expires_at: EXPIRES_AT,
        source_response_digest: digest("s"),
      },
    }),
  inspectControlRefProtection: () => Promise.resolve({ status: "protected" as const }),
};

function faultRequest(): ApprovalRequestRecord {
  // A standalone canonical request record; the coordinator only validates
  // against it, it is never committed in these control-side cases.
  return {
    protocol_version: "1.2.0",
    record_kind: "approval_request",
    request_id: "approval_request_f01",
    workflow_operation_id: "workflow_op_f01",
    object_id: "requirement_baseline",
    object_type: "RequirementBaseline",
    object_digest: digest("a"),
    baseline_digest: digest("b"),
    policy_digest: digest("c"),
    preview_digest: digest("e"),
    impact_path: ["intent_f01"],
    risk: "medium",
    reason: "approve the requirement baseline",
    allowed_decisions: ["approve", "reject", "defer"],
    created_at: OBSERVED_AT,
    resume_phase: "capture",
    requester_principal_id: "principal_alice",
    requester_principal_snapshot_digest: digest("d"),
  } as ApprovalRequestRecord;
}

async function createConnectedCoordinator(projection: {
  apply(record: ControlRecord | CollaborationConnectionRecord | IntegrationRecord): Promise<void>;
  rebuild(): Promise<void>;
  query: CollaborationCoordinatorDependencies["projection"]["query"];
}) {
  const controlStore = createFakeControlStore();
  const deps: CollaborationCoordinatorDependencies = {
    platform,
    controlStore: controlStore.port,
    projection: {
      rebuild: () => projection.rebuild(),
      apply: (record) => projection.apply(record),
      query: projection.query,
    },
    now: () => DECIDED_AT,
    readApprovalRequest: (input) =>
      Promise.resolve(input.request_id === "approval_request_f01" ? faultRequest() : undefined),
  };
  const coordinator = createCollaborationCoordinator(deps);
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
  return { coordinator, controlStore };
}

function submitCommand(command_id: string) {
  return {
    kind: "submit_remote_approval" as const,
    command_id,
    project_id: "project_demo",
    request_id: "approval_request_f01",
    decision: "approve" as const,
  };
}

function lenientProjection(overrides: { failOnApply?: boolean } = {}) {
  return {
    rebuild: () => Promise.resolve(),
    apply: () =>
      overrides.failOnApply === true
        ? Promise.reject(new Error("sqlite write failed"))
        : Promise.resolve(),
    query: (query: { kind: string; project_id: string }) =>
      Promise.resolve({
        kind: query.kind,
        project_id: query.project_id,
        ...(query.kind === "connection_status" ? { status: "active" as const } : {}),
        ...(query.kind === "operations" ? { operations: [] } : {}),
        ...(query.kind === "approval_inbox" ? { decisions: [] } : {}),
        ...(query.kind === "integration_conflicts" ? { conflicts: [] } : {}),
      }) as never,
  };
}

describe("remote approval control-side crash recovery", () => {
  it("control CAS failure before the response: retry finds the same remote_decision_id", async () => {
    const { coordinator, controlStore } = await createConnectedCoordinator(lenientProjection());
    controlStore.failNextAppend = true;

    const crashed = await coordinator.execute(
      submitCommand("command_decision_f1"),
      session("principal_bob"),
    );
    expect(crashed).toMatchObject({
      status: "failed",
      failure: { code: "git_remote_unavailable" },
    });

    const retried = await coordinator.execute(
      submitCommand("command_decision_f1"),
      session("principal_bob"),
    );
    expect(retried.status).toBe("remote_approval");
    if (retried.status !== "remote_approval") throw new Error("expected remote_approval outcome");
    expect(retried.decision.remote_decision_id).toBe(
      remoteDecisionIdFor("command_decision_f1", "approval_request_f01"),
    );
    expect(retried.decision.command_id).toBe("command_decision_f1");
    expect(
      controlStore.controlRecords.filter(
        (record) => record.record_kind === "remote_approval_decision",
      ),
    ).toHaveLength(1);
  });

  it("control CAS success before the SQLite update: retry replays without duplicating", async () => {
    const { coordinator, controlStore } = await createConnectedCoordinator(
      lenientProjection({ failOnApply: true }),
    );

    const outcome = await coordinator.execute(
      submitCommand("command_decision_f2"),
      session("principal_bob"),
    );
    expect(outcome).toMatchObject({
      status: "remote_approval",
      projection_rebuild_required: true,
    });

    const retried = await coordinator.execute(
      submitCommand("command_decision_f2"),
      session("principal_bob"),
    );
    expect(retried).toMatchObject({ status: "remote_approval", replayed: true });
    if (outcome.status === "remote_approval" && retried.status === "remote_approval") {
      expect(retried.decision.record_digest).toBe(outcome.decision.record_digest);
    }
    // connect snapshot + approver snapshot + decision; the retry appended nothing.
    expect(controlStore.calls.appendControl).toBe(3);
  });
});

// --- Local-kernel materialization over the real ApprovalService -------------

function approvalDeps(
  projectRoot: string,
  tag: string,
  overrides?: Partial<ApprovalDependencies>,
): ApprovalDependencies {
  return {
    projectRoot,
    readBaseline: () => BASELINE,
    now: () => FIXED_NOW,
    newId: phaseIds(tag),
    ...overrides,
  };
}

/** Control chain carrying the approver snapshot and the terminal decision. */
function decisionChain(request: ApprovalRequestRecord): {
  snapshot: PrincipalSnapshotRecord;
  decision: RemoteApprovalDecisionRecord;
} {
  const snapshot = buildCollaborationRecord({
    record_kind: "principal_snapshot" as const,
    control_sequence: 1,
    snapshot_id: "snapshot_fault01",
    principal_id: "principal_bob",
    provider: "github" as const,
    host: "github.com",
    subject_id: "1234567",
    repository_id: "acme/demo",
    permission: "maintain" as const,
    observed_at: OBSERVED_AT,
    expires_at: EXPIRES_AT,
    source_response_digest: digest("s"),
  });
  const decision = buildCollaborationRecord({
    record_kind: "remote_approval_decision" as const,
    control_sequence: 2,
    previous_control_record_digest: snapshot.record_digest,
    remote_decision_id: remoteDecisionIdFor("command_decision_fault", request.request_id),
    request_id: request.request_id,
    operation_id: request.workflow_operation_id,
    object_id: request.object_id,
    object_digest: request.object_digest,
    policy_digest: request.policy_digest,
    decision: "approve" as const,
    principal_snapshot_digest: snapshot.record_digest,
    required_permission: "maintain" as const,
    decided_at: DECIDED_AT,
    command_id: "command_decision_fault",
  });
  return { snapshot, decision };
}

function chainStore(records: readonly ControlRecord[]): GitControlStorePort {
  const chain = [...records];
  return {
    readControl: () =>
      Promise.resolve({
        status: "ok" as const,
        snapshot: { control_records: [...chain] },
      }),
    appendControl: (input) => {
      chain.push(input.record);
      return Promise.resolve({ status: "appended" as const, head_oid: "oid" });
    },
    appendProjectRecord: () =>
      Promise.resolve({ status: "committed" as const, commit: "0".repeat(16) }),
    listOperationHeads: () => Promise.resolve({ status: "ok" as const, heads: [] }),
    compareAndSwapOperation: () => Promise.reject(new Error("unused")),
    prepareCandidate: () => Promise.reject(new Error("unused")),
    compareAndSwapTarget: () => Promise.reject(new Error("unused")),
    readCandidate: () => Promise.reject(new Error("unused")),
    readIntegrationRecord: () => Promise.reject(new Error("unused")),
  };
}

async function bootRemoteRequest(projectRoot: string, tag: string) {
  const engine = new WorkflowEngine(makeDeps(projectRoot, { newId: phaseIds(`op${tag}`) }));
  const started = await engine.startOperation(makeStartInput());
  const workflowOperationId = started.operation.workflow_operation_id;
  await engine.advance(workflowOperationId, "awaiting_approval");
  // Distinct mint tag: the materializing services mint their own sequences
  // and must never collide with the request commit's ledger operation id.
  const service = new ApprovalService(approvalDeps(projectRoot, `bt${tag}`));
  const outcome = await service.requestApproval({
    workflowOperationId,
    objectId: "requirement_baseline",
    objectType: "RequirementBaseline",
    objectDigest: digest("a"),
    baselineDigest: digest("b"),
    policyDigest: digest("c"),
    impactPath: ["intent_f01"],
    risk: "medium",
    reason: "approve the requirement baseline",
    resumePhase: "capture",
    proposedBy: "agent:harness",
    requesterPrincipal: {
      principal_id: "principal_alice",
      principal_snapshot_digest: digest("d"),
    },
  });
  await resumeWorkflowOperation(
    makeDeps(projectRoot, { newId: phaseIds(`re${tag}`) }),
    workflowOperationId,
  );
  const request = service.getRequest(workflowOperationId, outcome.request_id);
  if (request === undefined) throw new Error("expected committed request");
  return { workflowOperationId, request };
}

describe("remote approval materialization fault injection", () => {
  it("approval decision commit crash before the response: retry materializes the same decision", async () => {
    const projectRoot = makeProjectRoot();
    try {
      const { request } = await bootRemoteRequest(projectRoot, "c1");
      const { snapshot, decision } = decisionChain(request);
      const controlStore = chainStore([snapshot, decision]);

      // Crash inside the ledger commit, after staging but before publish.
      const crashing = new ApprovalService(
        approvalDeps(projectRoot, "apc1", {
          hooks: {
            atBoundary: (boundary) => {
              if (boundary === "staging.prepared") throw new Error("simulated crash");
            },
          },
        }),
      );
      await expect(
        materializeRemoteApprovalDecision({
          service: crashing,
          controlStore,
          project_id: "project_demo",
          request_id: request.request_id,
        }),
      ).rejects.toThrow("simulated crash");

      // Retry with a fresh service over the same deterministic ids: the retry
      // reproduces the byte-identical commit and materializes exactly once.
      const recovered = new ApprovalService(approvalDeps(projectRoot, "apc1"));
      const materialized = await materializeRemoteApprovalDecision({
        service: recovered,
        controlStore,
        project_id: "project_demo",
        request_id: request.request_id,
      });
      expect(materialized.status).toBe("materialized");
      if (materialized.status !== "materialized") throw new Error("expected materialized");
      expect(materialized.replayed).toBe(false);
      expect(materialized.decision.decided_at).toBe(DECIDED_AT);

      // A third attempt after a lost response replays the same decision.
      const replayed = await materializeRemoteApprovalDecision({
        service: recovered,
        controlStore,
        project_id: "project_demo",
        request_id: request.request_id,
      });
      expect(replayed.status).toBe("materialized");
      if (replayed.status !== "materialized") throw new Error("expected materialized");
      expect(replayed.replayed).toBe(true);
      expect(replayed.decision.approval_id).toBe(materialized.decision.approval_id);

      const replay = new LedgerRepository({ projectRoot, readBaseline: () => BASELINE }).replay();
      expect(
        replay.events.filter((event) => event.event_type === "RemoteApprovalMaterialized"),
      ).toHaveLength(1);
    } finally {
      cleanupDirectories();
    }
  });

  it("materializes long after snapshot expiry without a repeated human approval", async () => {
    const projectRoot = makeProjectRoot();
    try {
      const { workflowOperationId, request } = await bootRemoteRequest(projectRoot, "d1");
      const { snapshot, decision } = decisionChain(request);
      const controlStore = chainStore([snapshot, decision]);

      // The wall clock is far beyond the five-minute snapshot validity; the
      // snapshot was valid at decided_at and the domain bindings are
      // unchanged, so materialization must proceed on the existing evidence.
      const service = new ApprovalService(
        approvalDeps(projectRoot, "apd1", { now: () => WELL_PAST_EXPIRY }),
      );
      const materialized = await materializeRemoteApprovalDecision({
        service,
        controlStore,
        project_id: "project_demo",
        request_id: request.request_id,
      });
      expect(materialized.status).toBe("materialized");
      if (materialized.status !== "materialized") throw new Error("expected materialized");
      expect(materialized.decision.decided_at).toBe(DECIDED_AT);
      expect(service.pendingRequests(workflowOperationId)).toEqual([]);

      // No second human approval: the retry replays, and no new request was
      // re-issued.
      const again = await materializeRemoteApprovalDecision({
        service,
        controlStore,
        project_id: "project_demo",
        request_id: request.request_id,
      });
      expect(again.status).toBe("materialized");
      if (again.status !== "materialized") throw new Error("expected materialized");
      expect(again.replayed).toBe(true);
      expect(service.pendingRequests(workflowOperationId)).toEqual([]);
    } finally {
      cleanupDirectories();
    }
  });
});
