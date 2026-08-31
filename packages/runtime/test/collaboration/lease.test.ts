import type {
  CollaborationConnectionRecord,
  ControlRecord,
  IntegrationRecord,
  LeaseRecord,
} from "@universal-harness-internal/core";
import { buildCollaborationRecord } from "@universal-harness-internal/core";
import { describe, expect, it } from "vitest";

import { COLLABORATION_CONTROL_REF } from "../../src/collaboration/connection.js";
import { collaborationFailure } from "../../src/collaboration/errors.js";
import {
  OPERATION_LEASE_DURATION_MS,
  transitionLease,
  type LeaseDraft,
} from "../../src/collaboration/lease.js";
import type {
  AcquireLeaseCommand,
  AppendControlInput,
  AppendProjectRecordInput,
  CollaborationProjectionRecord,
  CollaborationQuery,
  CollaborationSession,
  CollaborationView,
  ControlSnapshotResult,
  CoordinatorProjectionPort,
  GitControlStorePort,
  OperationCasInput,
  OperationHead,
  PlatformIdentityPort,
  ProjectionRebuildInput,
  ReleaseLeaseCommand,
  RenewLeaseCommand,
} from "../../src/collaboration/port.js";
import {
  createCollaborationCoordinator,
  resumeCollaborationCoordinator,
  type CollaborationCoordinatorDependencies,
} from "../../src/collaboration/coordinator.js";

const digest = (letter: string): string => letter.repeat(64);

const NOW = "2026-08-29T00:00:00.000Z";
const EARLIER = "2026-08-28T23:55:00.000Z";
const WITHIN_LEASE = "2026-08-29T00:01:00.000Z";
const AFTER_EXPIRY = "2026-08-29T00:06:00.000Z";
const LEASE_EXPIRY = "2026-08-29T00:05:00.000Z";

const session = (principal_id: string): CollaborationSession => ({
  principal_id,
  client_instance_id: "instance_test",
});

function leaseFixture(overrides: Partial<LeaseRecord> = {}): LeaseRecord {
  return {
    protocol_version: "1.2.0",
    record_kind: "lease",
    control_sequence: 2,
    previous_control_record_digest: digest("p"),
    lease_record_id: "lease-record_01",
    lease_id: "lease_01",
    resource_kind: "operation",
    resource_id: "op_1",
    holder_principal_snapshot_digest: digest("s"),
    client_instance_id: "instance_test",
    fencing_token: 1,
    issued_at: NOW,
    expires_at: LEASE_EXPIRY,
    state: "granted",
    command_id: "command_acquire_1",
    record_digest: digest("l"),
    ...overrides,
  };
}

const acquire = (overrides: Partial<AcquireLeaseCommand> = {}): AcquireLeaseCommand => ({
  kind: "acquire_operation_lease",
  command_id: "command_acquire_1",
  project_id: "project_demo",
  operation_id: "op_1",
  ...overrides,
});

const renew = (overrides: Partial<RenewLeaseCommand> = {}): RenewLeaseCommand => ({
  kind: "renew_operation_lease",
  command_id: "command_renew_1",
  project_id: "project_demo",
  lease_id: "lease_01",
  ...overrides,
});

const release = (overrides: Partial<ReleaseLeaseCommand> = {}): ReleaseLeaseCommand => ({
  kind: "release_operation_lease",
  command_id: "command_release_1",
  project_id: "project_demo",
  lease_id: "lease_01",
  ...overrides,
});

/** Materialize a draft the way the Coordinator seals and appends it. */
function materialize(
  draft: LeaseDraft,
  control_sequence: number,
  previousDigest?: string,
): LeaseRecord {
  return buildCollaborationRecord({
    record_kind: "lease" as const,
    control_sequence,
    ...(previousDigest === undefined ? {} : { previous_control_record_digest: previousDigest }),
    ...draft,
    holder_principal_snapshot_digest: digest("s"),
    client_instance_id: "instance_test",
  });
}

describe("transitionLease grant", () => {
  it("grants a lease on an empty resource with fencing token 1", () => {
    const transition = transitionLease([], acquire(), NOW);
    expect(transition.kind).toBe("draft");
    if (transition.kind !== "draft") return;
    expect(transition.draft).toMatchObject({
      lease_id: expect.stringMatching(/^lease_[a-f0-9]{24}$/u),
      lease_record_id: expect.stringMatching(/^lease-record_[a-f0-9]{24}$/u),
      resource_kind: "operation",
      resource_id: "op_1",
      fencing_token: 1,
      issued_at: NOW,
      expires_at: new Date(Date.parse(NOW) + OPERATION_LEASE_DURATION_MS).toISOString(),
      state: "granted",
      command_id: "command_acquire_1",
    });
    expect(transition.draft.previous_lease_record_digest).toBeUndefined();
  });

  it("returns the existing record for a repeated acquire command id", () => {
    const granted = leaseFixture();
    const transition = transitionLease([granted], acquire(), WITHIN_LEASE);
    expect(transition).toMatchObject({ kind: "existing", record: granted, replayed: true });
  });

  it("rejects an acquire while another command holds a live lease", () => {
    const granted = leaseFixture({ command_id: "command_acquire_other" });
    const transition = transitionLease([granted], acquire(), WITHIN_LEASE);
    expect(transition).toMatchObject({
      kind: "rejected",
      failure: { code: "lease_unavailable", retryable: true },
    });
  });

  it("records expiry before granting on top of an expired lease", () => {
    const expired = leaseFixture();
    const first = transitionLease(
      [expired],
      acquire({ command_id: "command_acquire_2" }),
      AFTER_EXPIRY,
    );
    expect(first.kind).toBe("draft");
    if (first.kind !== "draft") return;
    expect(first.draft).toMatchObject({
      lease_id: "lease_01",
      fencing_token: 1,
      state: "expired",
      expires_at: LEASE_EXPIRY,
      previous_lease_record_digest: expired.record_digest,
    });

    // After the expiry record lands, the same acquire command produces the grant.
    const expiredRecord = materialize(first.draft, 3, expired.record_digest);
    const second = transitionLease(
      [expired, expiredRecord],
      acquire({ command_id: "command_acquire_2" }),
      AFTER_EXPIRY,
    );
    expect(second.kind).toBe("draft");
    if (second.kind !== "draft") return;
    expect(second.draft).toMatchObject({
      fencing_token: 2,
      state: "granted",
      previous_lease_record_digest: expiredRecord.record_digest,
    });
    expect(second.draft.lease_id).not.toBe("lease_01");
  });

  it("increases the fencing token strictly across successive grants", () => {
    const granted = leaseFixture();
    const released = leaseFixture({
      lease_record_id: "lease-record_02",
      state: "released",
      command_id: "command_release_1",
      previous_lease_record_digest: granted.record_digest,
      record_digest: digest("m"),
    });
    const transition = transitionLease(
      [granted, released],
      acquire({ command_id: "command_acquire_2" }),
      WITHIN_LEASE,
    );
    expect(transition.kind).toBe("draft");
    if (transition.kind !== "draft") return;
    expect(transition.draft.fencing_token).toBe(2);
    expect(transition.draft.previous_lease_record_digest).toBe(released.record_digest);
  });
});

describe("transitionLease renew", () => {
  it("renews a live lease keeping the fencing token", () => {
    const granted = leaseFixture();
    const transition = transitionLease([granted], renew(), WITHIN_LEASE);
    expect(transition.kind).toBe("draft");
    if (transition.kind !== "draft") return;
    expect(transition.draft).toMatchObject({
      lease_id: "lease_01",
      fencing_token: 1,
      state: "renewed",
      issued_at: WITHIN_LEASE,
      expires_at: new Date(Date.parse(WITHIN_LEASE) + OPERATION_LEASE_DURATION_MS).toISOString(),
      previous_lease_record_digest: granted.record_digest,
      command_id: "command_renew_1",
    });
  });

  it("appends nothing when the renewal would not extend the expiry", () => {
    const granted = leaseFixture();
    // now + duration lands before the recorded expiry: no real extension.
    const transition = transitionLease(
      [granted],
      renew({ command_id: "command_renew_2" }),
      EARLIER,
    );
    expect(transition).toMatchObject({ kind: "existing", record: granted, replayed: false });
  });

  it("returns the renewed record for a repeated renew command id", () => {
    const granted = leaseFixture();
    const renewed = leaseFixture({
      lease_record_id: "lease-record_02",
      state: "renewed",
      issued_at: WITHIN_LEASE,
      expires_at: new Date(Date.parse(WITHIN_LEASE) + OPERATION_LEASE_DURATION_MS).toISOString(),
      command_id: "command_renew_1",
      previous_lease_record_digest: granted.record_digest,
      record_digest: digest("m"),
    });
    const transition = transitionLease([granted, renewed], renew(), WITHIN_LEASE);
    expect(transition).toMatchObject({ kind: "existing", record: renewed, replayed: true });
  });

  it("permanently rejects a renew for an unknown lease", () => {
    const transition = transitionLease([], renew(), NOW);
    expect(transition).toMatchObject({
      kind: "rejected",
      failure: { code: "lease_fenced", retryable: false },
    });
  });

  it("permanently rejects a renew with an old fencing token after a re-grant", () => {
    const granted = leaseFixture();
    const expired = leaseFixture({
      lease_record_id: "lease-record_02",
      state: "expired",
      command_id: "command_acquire_2-expiry",
      previous_lease_record_digest: granted.record_digest,
      record_digest: digest("m"),
    });
    const regranted = leaseFixture({
      lease_record_id: "lease-record_03",
      lease_id: "lease_02",
      fencing_token: 2,
      command_id: "command_acquire_2",
      previous_lease_record_digest: expired.record_digest,
      record_digest: digest("n"),
    });
    const transition = transitionLease([granted, expired, regranted], renew(), AFTER_EXPIRY);
    expect(transition).toMatchObject({
      kind: "rejected",
      failure: { code: "lease_fenced", retryable: false },
    });
  });

  it("answers lease_expired when the current lease lapsed and was never re-granted", () => {
    const granted = leaseFixture();
    const transition = transitionLease([granted], renew(), AFTER_EXPIRY);
    expect(transition).toMatchObject({
      kind: "rejected",
      failure: { code: "lease_expired", retryable: true },
    });
  });

  it("permanently rejects a renew of a released lease", () => {
    const granted = leaseFixture();
    const released = leaseFixture({
      lease_record_id: "lease-record_02",
      state: "released",
      command_id: "command_release_1",
      previous_lease_record_digest: granted.record_digest,
      record_digest: digest("m"),
    });
    const transition = transitionLease([granted, released], renew(), WITHIN_LEASE);
    expect(transition).toMatchObject({
      kind: "rejected",
      failure: { code: "lease_fenced", retryable: false },
    });
  });
});

describe("transitionLease release", () => {
  it("releases a live lease keeping the fencing token and expiry fact", () => {
    const granted = leaseFixture();
    const transition = transitionLease([granted], release(), WITHIN_LEASE);
    expect(transition.kind).toBe("draft");
    if (transition.kind !== "draft") return;
    expect(transition.draft).toMatchObject({
      lease_id: "lease_01",
      fencing_token: 1,
      state: "released",
      issued_at: WITHIN_LEASE,
      expires_at: LEASE_EXPIRY,
      previous_lease_record_digest: granted.record_digest,
    });
  });

  it("returns the released record for a repeated release command id", () => {
    const released = leaseFixture({ state: "released", command_id: "command_release_1" });
    const transition = transitionLease([released], release(), WITHIN_LEASE);
    expect(transition).toMatchObject({ kind: "existing", record: released, replayed: true });
  });

  it("appends nothing when releasing an already released lease", () => {
    const released = leaseFixture({
      state: "released",
      command_id: "command_release_other",
    });
    const transition = transitionLease([released], release(), WITHIN_LEASE);
    expect(transition).toMatchObject({ kind: "existing", record: released, replayed: false });
  });

  it("records expiry instead of a release when the lease already lapsed", () => {
    const granted = leaseFixture();
    const transition = transitionLease([granted], release(), AFTER_EXPIRY);
    expect(transition.kind).toBe("draft");
    if (transition.kind !== "draft") return;
    expect(transition.draft).toMatchObject({
      lease_id: "lease_01",
      state: "expired",
      command_id: "command_release_1-expiry",
      previous_lease_record_digest: granted.record_digest,
    });
  });

  it("permanently rejects a release for an unknown lease", () => {
    const transition = transitionLease([], release(), NOW);
    expect(transition).toMatchObject({
      kind: "rejected",
      failure: { code: "lease_fenced", retryable: false },
    });
  });
});

// --- Coordinator wiring -----------------------------------------------------

function connectionFixture(): CollaborationConnectionRecord {
  return buildCollaborationRecord({
    record_kind: "collaboration_connection" as const,
    connection_id: "connection_demo",
    project_id: "project_demo",
    revision: 1,
    status: "active" as const,
    provider: "github" as const,
    repository_id: "acme/demo",
    canonical_remote: "https://github.com/acme/demo.git",
    canonical_remote_digest: digest("r"),
    coordinator_origin: "https://harness.example.com",
    target_ref: "refs/heads/main",
    control_ref: COLLABORATION_CONTROL_REF,
    policy_digest: digest("1"),
    actor_principal_id: "principal_alice",
    principal_snapshot_digest: digest("s"),
    command_id: "command_connect_1",
    effective_at: NOW,
  });
}

function snapshotFixture(): ControlRecord {
  return buildCollaborationRecord({
    record_kind: "principal_snapshot" as const,
    control_sequence: 1,
    snapshot_id: "snapshot_1",
    principal_id: "principal_alice",
    provider: "github" as const,
    host: "github.com",
    subject_id: "1234567",
    repository_id: "acme/demo",
    permission: "maintain" as const,
    observed_at: NOW,
    expires_at: LEASE_EXPIRY,
    source_response_digest: digest("s"),
  });
}

interface FakeStore {
  readonly port: GitControlStorePort;
  readonly controlRecords: ControlRecord[];
  readonly calls: { readControl: number; appendControl: number; compareAndSwapOperation: number };
  readonly casCalls: OperationCasInput[];
  casFailuresRemaining: number;
  operationHeads: OperationHead[];
  publishDrift: boolean;
}

function createFakeStore(seed: {
  controlRecords?: ControlRecord[];
  connection?: CollaborationConnectionRecord;
  casFailures?: number;
  operationHeads?: OperationHead[];
}): FakeStore {
  const controlRecords: ControlRecord[] = [...(seed.controlRecords ?? [])];
  const projectRecords: (CollaborationConnectionRecord | IntegrationRecord)[] = [
    ...(seed.connection === undefined ? [] : [seed.connection]),
  ];
  const headOid = () =>
    controlRecords.length === 0 ? undefined : `oid_control_${controlRecords.length}`;
  const store: FakeStore = {
    controlRecords,
    calls: { readControl: 0, appendControl: 0, compareAndSwapOperation: 0 },
    casCalls: [],
    casFailuresRemaining: seed.casFailures ?? 0,
    operationHeads: [...(seed.operationHeads ?? [])],
    publishDrift: false,
    port: {
      readControl() {
        store.calls.readControl += 1;
        const head = headOid();
        const latest = [...projectRecords]
          .reverse()
          .find(
            (record): record is CollaborationConnectionRecord =>
              record.record_kind === "collaboration_connection",
          );
        const snapshot: ControlSnapshotResult = {
          status: "ok",
          snapshot: {
            ...(head === undefined ? {} : { control_head_oid: head }),
            control_records: [...controlRecords],
            ...(latest === undefined ? {} : { latest_connection: latest }),
          },
        };
        return Promise.resolve(snapshot);
      },
      appendControl(input: AppendControlInput) {
        store.calls.appendControl += 1;
        if (store.casFailuresRemaining > 0) {
          store.casFailuresRemaining -= 1;
          return Promise.resolve({
            status: "failed" as const,
            failure: collaborationFailure("control_ref_cas_failed", "lost the race", true),
          });
        }
        if (input.expected_head_oid !== headOid()) {
          return Promise.resolve({
            status: "failed" as const,
            failure: collaborationFailure("control_ref_invalid", "stale expected head"),
          });
        }
        controlRecords.push(input.record);
        return Promise.resolve({ status: "appended" as const, head_oid: headOid() as string });
      },
      appendProjectRecord(input: AppendProjectRecordInput) {
        projectRecords.push(input.record);
        return Promise.resolve({ status: "committed" as const, commit: "0".repeat(40) });
      },
      listOperationHeads() {
        return Promise.resolve({ status: "ok" as const, heads: [...store.operationHeads] });
      },
      compareAndSwapOperation(input: OperationCasInput) {
        store.calls.compareAndSwapOperation += 1;
        store.casCalls.push(input);
        if (store.publishDrift) {
          return Promise.resolve({
            status: "failed" as const,
            failure: collaborationFailure("operation_ref_drift", "operation head moved", true),
          });
        }
        store.operationHeads = [
          ...store.operationHeads.filter((head) => head.operation_id !== input.operation_id),
          { operation_id: input.operation_id, head_oid: input.candidate_commit },
        ];
        return Promise.resolve({ status: "swapped" as const, head_oid: input.candidate_commit });
      },
      prepareCandidate() {
        return Promise.resolve({
          status: "failed" as const,
          failure: collaborationFailure("coordinator_unavailable", "not implemented in slice"),
        });
      },
      compareAndSwapTarget() {
        return Promise.resolve({
          status: "failed" as const,
          failure: collaborationFailure("coordinator_unavailable", "not implemented in slice"),
        });
      },
      readCandidate() {
        return Promise.resolve({
          status: "failed" as const,
          failure: collaborationFailure("coordinator_unavailable", "not implemented in slice"),
        });
      },
      readIntegrationRecord() {
        return Promise.resolve({
          status: "failed" as const,
          failure: collaborationFailure("coordinator_unavailable", "not implemented in slice"),
        });
      },
      listIntegrationRecords() {
        return Promise.resolve({ status: "ok" as const, staged: [], accepted: [] });
      },
    },
  };
  return store;
}

interface FakeProjection {
  readonly port: CoordinatorProjectionPort;
  readonly applied: CollaborationProjectionRecord[];
  readonly rebuilds: ProjectionRebuildInput[];
  failOnApply: boolean;
  failOnRebuild: boolean;
}

function createFakeProjection(): FakeProjection {
  const applied: CollaborationProjectionRecord[] = [];
  const rebuilds: ProjectionRebuildInput[] = [];
  const fake: FakeProjection = {
    applied,
    rebuilds,
    failOnApply: false,
    failOnRebuild: false,
    port: {
      rebuild(input: ProjectionRebuildInput) {
        if (fake.failOnRebuild) return Promise.reject(new Error("sqlite rebuild failed"));
        rebuilds.push(input);
        return Promise.resolve();
      },
      apply(record) {
        if (fake.failOnApply) return Promise.reject(new Error("sqlite write failed"));
        applied.push(record);
        return Promise.resolve();
      },
      query(query: CollaborationQuery): Promise<CollaborationView> {
        if (query.kind === "connection_status") {
          return Promise.resolve({
            kind: "connection_status",
            project_id: query.project_id,
            status: "active",
          });
        }
        if (query.kind === "operations") {
          return Promise.resolve({
            kind: "operations",
            project_id: query.project_id,
            operations: [],
          });
        }
        if (query.kind === "approval_inbox") {
          return Promise.resolve({
            kind: "approval_inbox",
            project_id: query.project_id,
            decisions: [],
          });
        }
        return Promise.resolve({
          kind: "integration_conflicts",
          project_id: query.project_id,
          conflicts: [],
        });
      },
    },
  };
  return fake;
}

const fakePlatform: PlatformIdentityPort = {
  discover: () => Promise.reject(new Error("not used by lease commands")),
  authenticate: () => Promise.reject(new Error("not used by lease commands")),
  inspectControlRefProtection: () => Promise.reject(new Error("not used by lease commands")),
};

function createHarness(
  seed: Parameters<typeof createFakeStore>[0] = {},
  clock: () => string = () => NOW,
) {
  const store = createFakeStore(seed);
  const projection = createFakeProjection();
  const coordinator = createCollaborationCoordinator({
    platform: fakePlatform,
    controlStore: store.port,
    projection: projection.port,
    now: clock,
  });
  return { coordinator, store, projection };
}

describe("coordinator lease commands", () => {
  it("acquires a lease on a connected project and projects the record", async () => {
    const { coordinator, store, projection } = createHarness({
      controlRecords: [snapshotFixture()],
      connection: connectionFixture(),
    });
    const outcome = await coordinator.execute(acquire(), session("principal_alice"));

    expect(outcome).toMatchObject({
      status: "lease",
      replayed: false,
      lease: { state: "granted", fencing_token: 1, resource_id: "op_1" },
    });
    if (outcome.status !== "lease") throw new Error("expected lease outcome");
    expect(store.controlRecords).toHaveLength(2);
    expect(store.controlRecords[1]).toEqual(outcome.lease);
    expect(projection.applied).toEqual([outcome.lease]);
  });

  it("blocks lease commands while the project is not connected", async () => {
    const { coordinator, store } = createHarness({ controlRecords: [snapshotFixture()] });
    const outcome = await coordinator.execute(acquire(), session("principal_alice"));

    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "coordinator_unavailable" },
    });
    expect(store.calls.appendControl).toBe(0);
  });

  it("replays a repeated acquire without appending a second record", async () => {
    const { coordinator, store, projection } = createHarness({
      controlRecords: [snapshotFixture()],
      connection: connectionFixture(),
    });
    const first = await coordinator.execute(acquire(), session("principal_alice"));
    const second = await coordinator.execute(acquire(), session("principal_alice"));

    expect(first).toMatchObject({ status: "lease", replayed: false });
    expect(second).toMatchObject({ status: "lease", replayed: true });
    if (first.status !== "lease" || second.status !== "lease") return;
    expect(second.lease).toEqual(first.lease);
    expect(store.controlRecords).toHaveLength(2);
    expect(projection.applied).toHaveLength(1);
  });

  it("rejects a second acquire while the lease is live", async () => {
    const granted = materialize(
      (() => {
        const transition = transitionLease([], acquire({ command_id: "command_acquire_9" }), NOW);
        if (transition.kind !== "draft") throw new Error("expected draft");
        return transition.draft;
      })(),
      2,
      digest("s"),
    );
    const { coordinator } = createHarness({
      controlRecords: [snapshotFixture(), granted],
      connection: connectionFixture(),
    });
    const outcome = await coordinator.execute(acquire(), session("principal_alice"));
    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "lease_unavailable", retryable: true },
    });
  });

  it("renews a live lease keeping the fencing token", async () => {
    const granted = materialize(
      (() => {
        const transition = transitionLease([], acquire(), NOW);
        if (transition.kind !== "draft") throw new Error("expected draft");
        return transition.draft;
      })(),
      2,
      digest("s"),
    );
    const { coordinator, store } = createHarness(
      { controlRecords: [snapshotFixture(), granted], connection: connectionFixture() },
      () => WITHIN_LEASE,
    );
    const outcome = await coordinator.execute(
      renew({ lease_id: granted.lease_id }),
      session("principal_alice"),
    );

    expect(outcome).toMatchObject({
      status: "lease",
      replayed: false,
      lease: { state: "renewed", fencing_token: 1, lease_id: granted.lease_id },
    });
    expect(store.controlRecords).toHaveLength(3);
  });

  it("permanently rejects an old fencing token after a re-grant", async () => {
    // lease_01 granted, expired, then lease_02 granted with fencing token 2.
    const history: ControlRecord[] = [
      snapshotFixture(),
      leaseFixture({ control_sequence: 2, record_digest: digest("a") }),
      leaseFixture({
        control_sequence: 3,
        lease_record_id: "lease-record_02",
        state: "expired",
        command_id: "command_acquire_2-expiry",
        previous_lease_record_digest: digest("a"),
        record_digest: digest("b"),
      }),
      leaseFixture({
        control_sequence: 4,
        lease_record_id: "lease-record_03",
        lease_id: "lease_02",
        fencing_token: 2,
        command_id: "command_acquire_2",
        previous_lease_record_digest: digest("b"),
        record_digest: digest("c"),
      }),
    ];
    const { coordinator, store } = createHarness(
      { controlRecords: history, connection: connectionFixture() },
      () => AFTER_EXPIRY,
    );
    const outcome = await coordinator.execute(renew(), session("principal_alice"));

    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "lease_fenced", retryable: false },
    });
    expect(store.calls.appendControl).toBe(0);
  });

  it("re-reads and re-decides once after a CAS loss", async () => {
    const { coordinator, store } = createHarness({
      controlRecords: [snapshotFixture()],
      connection: connectionFixture(),
      casFailures: 1,
    });
    const outcome = await coordinator.execute(acquire(), session("principal_alice"));

    expect(outcome).toMatchObject({ status: "lease", lease: { state: "granted" } });
    expect(store.calls.readControl).toBe(2);
    expect(store.calls.appendControl).toBe(2);
  });

  it("answers lease_unavailable after losing the CAS race twice", async () => {
    const { coordinator, store } = createHarness({
      controlRecords: [snapshotFixture()],
      connection: connectionFixture(),
      casFailures: 2,
    });
    const outcome = await coordinator.execute(acquire(), session("principal_alice"));

    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "lease_unavailable", retryable: true },
    });
    expect(store.calls.readControl).toBe(2);
    expect(store.calls.appendControl).toBe(2);
  });

  it("keeps Git authoritative when the projection update fails", async () => {
    const { coordinator, store, projection } = createHarness({
      controlRecords: [snapshotFixture()],
      connection: connectionFixture(),
    });
    projection.failOnApply = true;
    const outcome = await coordinator.execute(acquire(), session("principal_alice"));

    expect(outcome).toMatchObject({
      status: "lease",
      replayed: false,
      projection_rebuild_required: true,
    });
    expect(store.controlRecords).toHaveLength(2);
  });

  it("releases a live lease", async () => {
    const granted = materialize(
      (() => {
        const transition = transitionLease([], acquire(), NOW);
        if (transition.kind !== "draft") throw new Error("expected draft");
        return transition.draft;
      })(),
      2,
      digest("s"),
    );
    const { coordinator } = createHarness(
      { controlRecords: [snapshotFixture(), granted], connection: connectionFixture() },
      () => WITHIN_LEASE,
    );
    const outcome = await coordinator.execute(
      release({ lease_id: granted.lease_id }),
      session("principal_alice"),
    );
    expect(outcome).toMatchObject({
      status: "lease",
      replayed: false,
      lease: { state: "released", lease_id: granted.lease_id, fencing_token: 1 },
    });
  });
});

describe("coordinator publish operation candidate", () => {
  const CANDIDATE = "b".repeat(40);
  const OPERATION_BASE = "a".repeat(40);

  function liveLeaseHarness(clock: () => string = () => WITHIN_LEASE) {
    const granted = materialize(
      (() => {
        const transition = transitionLease([], acquire(), NOW);
        if (transition.kind !== "draft") throw new Error("expected draft");
        return transition.draft;
      })(),
      2,
      digest("s"),
    );
    return createHarness(
      {
        controlRecords: [snapshotFixture(), granted],
        connection: connectionFixture(),
        operationHeads: [{ operation_id: "op_1", head_oid: OPERATION_BASE }],
      },
      clock,
    );
  }

  const publish = (command_id = "command_publish_1", fencing_token = 1) => ({
    kind: "publish_operation_candidate" as const,
    command_id,
    project_id: "project_demo",
    operation_id: "op_1",
    candidate_commit: CANDIDATE,
    fencing_token,
  });

  it("publishes with the current fencing token and expected head", async () => {
    const { coordinator, store } = liveLeaseHarness();
    const outcome = await coordinator.execute(publish(), session("principal_alice"));

    expect(outcome).toMatchObject({
      status: "published",
      replayed: false,
      operation_id: "op_1",
      head_oid: CANDIDATE,
    });
    expect(store.casCalls).toHaveLength(1);
    expect(store.casCalls[0]).toMatchObject({
      operation_id: "op_1",
      expected_head_oid: OPERATION_BASE,
      candidate_commit: CANDIDATE,
      fencing_token: 1,
    });
  });

  it("replays a publish when the head already matches the candidate", async () => {
    const { coordinator, store } = liveLeaseHarness();
    await coordinator.execute(publish(), session("principal_alice"));
    const replay = await coordinator.execute(publish(), session("principal_alice"));

    expect(replay).toMatchObject({ status: "published", replayed: true, head_oid: CANDIDATE });
    expect(store.calls.compareAndSwapOperation).toBe(1);
  });

  it("refuses to publish without a lease", async () => {
    const { coordinator, store } = createHarness({
      controlRecords: [snapshotFixture()],
      connection: connectionFixture(),
    });
    const outcome = await coordinator.execute(publish(), session("principal_alice"));

    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "lease_unavailable" },
    });
    expect(store.calls.compareAndSwapOperation).toBe(0);
  });

  it("refuses to publish with an expired lease", async () => {
    const { coordinator, store } = liveLeaseHarness(() => AFTER_EXPIRY);
    const outcome = await coordinator.execute(publish(), session("principal_alice"));

    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "lease_expired", retryable: true },
    });
    expect(store.calls.compareAndSwapOperation).toBe(0);
  });

  it("permanently refuses to publish after the lease was released", async () => {
    const granted = materialize(
      (() => {
        const transition = transitionLease([], acquire(), NOW);
        if (transition.kind !== "draft") throw new Error("expected draft");
        return transition.draft;
      })(),
      2,
      digest("s"),
    );
    const released = leaseFixture({
      control_sequence: 3,
      lease_id: granted.lease_id,
      state: "released",
      previous_lease_record_digest: granted.record_digest,
      record_digest: digest("m"),
    });
    const { coordinator, store } = createHarness(
      {
        controlRecords: [snapshotFixture(), granted, released],
        connection: connectionFixture(),
      },
      () => WITHIN_LEASE,
    );
    const outcome = await coordinator.execute(publish(), session("principal_alice"));

    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "lease_fenced", retryable: false },
    });
    expect(store.calls.compareAndSwapOperation).toBe(0);
  });

  it("permanently refuses to publish with a stale fencing token", async () => {
    const { coordinator, store } = liveLeaseHarness();
    const outcome = await coordinator.execute(
      publish("command_publish_stale", 0),
      session("principal_alice"),
    );

    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "lease_fenced", retryable: false },
    });
    expect(store.calls.compareAndSwapOperation).toBe(0);
  });

  it("surfaces operation_ref_drift from the store without losing the candidate", async () => {
    const { coordinator, store } = liveLeaseHarness();
    store.publishDrift = true;
    const outcome = await coordinator.execute(publish(), session("principal_alice"));

    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "operation_ref_drift", retryable: true },
    });
    expect(store.calls.compareAndSwapOperation).toBe(1);
  });
});

// --- Coordinator startup/recovery (spec §10.1) -------------------------------

describe("resumeCollaborationCoordinator", () => {
  function resumeHarness(
    seed: Parameters<typeof createFakeStore>[0] = {},
    clock: () => string = () => WITHIN_LEASE,
  ) {
    const store = createFakeStore(seed);
    const projection = createFakeProjection();
    const deps: CollaborationCoordinatorDependencies = {
      platform: fakePlatform,
      controlStore: store.port,
      projection: projection.port,
      now: clock,
    };
    return { store, projection, deps };
  }

  function liveLease(): LeaseRecord {
    return materialize(
      (() => {
        const transition = transitionLease([], acquire(), NOW);
        if (transition.kind !== "draft") throw new Error("expected draft");
        return transition.draft;
      })(),
      2,
      digest("s"),
    );
  }

  it("revokes live leases and rebuilds the projection from Git", async () => {
    const granted = liveLease();
    const { store, projection, deps } = resumeHarness({
      controlRecords: [snapshotFixture(), granted],
      connection: connectionFixture(),
    });

    const startup = await resumeCollaborationCoordinator(deps, "project_demo");

    expect(startup).toEqual({ status: "ready" });
    expect(store.controlRecords).toHaveLength(3);
    expect(store.controlRecords[2]).toMatchObject({
      record_kind: "lease",
      state: "revoked",
      lease_id: granted.lease_id,
      fencing_token: 1,
      resource_id: "op_1",
      expires_at: granted.expires_at,
    });
    expect(projection.rebuilds).toHaveLength(1);
    expect(projection.rebuilds[0]?.control_records).toEqual(store.controlRecords);
    expect(projection.rebuilds[0]?.latest_connection).toBeDefined();
  });

  it("blocks startup when the authoritative Git state cannot be read", async () => {
    const { store, projection, deps } = resumeHarness({});
    const failingStore: GitControlStorePort = {
      ...store.port,
      readControl: () =>
        Promise.resolve({
          status: "failed" as const,
          failure: collaborationFailure("git_remote_unavailable", "remote offline", true),
        }),
    };

    const startup = await resumeCollaborationCoordinator(
      { ...deps, controlStore: failingStore },
      "project_demo",
    );

    expect(startup).toMatchObject({
      status: "blocked",
      failure: { code: "git_remote_unavailable" },
    });
    expect(projection.rebuilds).toHaveLength(0);
  });

  it("blocks startup when the projection rebuild fails", async () => {
    const { projection, deps } = resumeHarness({
      controlRecords: [snapshotFixture()],
      connection: connectionFixture(),
    });
    projection.failOnRebuild = true;

    const startup = await resumeCollaborationCoordinator(deps, "project_demo");

    expect(startup).toMatchObject({
      status: "blocked",
      failure: { code: "projection_rebuild_required", retryable: true },
    });
  });

  it("revokes live integration leases as well as operation leases", async () => {
    const grantedOperation = liveLease();
    const grantedIntegration = materialize(
      {
        lease_record_id: "lease-record_integration",
        lease_id: "lease_integration",
        resource_kind: "integration",
        resource_id: "project_demo",
        fencing_token: 1,
        issued_at: NOW,
        expires_at: LEASE_EXPIRY,
        state: "granted",
        command_id: "command_prepare_1",
      },
      3,
      grantedOperation.record_digest,
    );
    const { store, deps } = resumeHarness({
      controlRecords: [snapshotFixture(), grantedOperation, grantedIntegration],
      connection: connectionFixture(),
    });

    const startup = await resumeCollaborationCoordinator(deps, "project_demo");

    expect(startup).toEqual({ status: "ready" });
    expect(store.controlRecords).toHaveLength(5);
    expect(store.controlRecords[3]).toMatchObject({
      record_kind: "lease",
      state: "revoked",
      resource_kind: "operation",
      resource_id: "op_1",
      lease_id: grantedOperation.lease_id,
      fencing_token: 1,
    });
    expect(store.controlRecords[4]).toMatchObject({
      record_kind: "lease",
      state: "revoked",
      resource_kind: "integration",
      resource_id: "project_demo",
      lease_id: "lease_integration",
      fencing_token: 1,
    });
  });

  it("appends nothing on a repeated resume and leaves expired leases untouched", async () => {
    const granted = liveLease();
    const { store, projection, deps } = resumeHarness({
      controlRecords: [snapshotFixture(), granted],
      connection: connectionFixture(),
    });

    const first = await resumeCollaborationCoordinator(deps, "project_demo");
    const second = await resumeCollaborationCoordinator(deps, "project_demo");

    expect(first).toEqual({ status: "ready" });
    expect(second).toEqual({ status: "ready" });
    // The revoked tip is not live, so the second resume appends nothing.
    expect(store.controlRecords).toHaveLength(3);
    expect(projection.rebuilds).toHaveLength(2);

    // An already-expired lease lapses by wall clock; no record is appended.
    const expiredHarness = resumeHarness(
      { controlRecords: [snapshotFixture(), granted], connection: connectionFixture() },
      () => AFTER_EXPIRY,
    );
    const expired = await resumeCollaborationCoordinator(expiredHarness.deps, "project_demo");
    expect(expired).toEqual({ status: "ready" });
    expect(expiredHarness.store.controlRecords).toHaveLength(2);
  });
});
