import {
  buildCollaborationRecord,
  buildManifest,
  canonicalizeJson,
  edgeShardRelativePath,
  eventShardRelativePath,
  harnessRootFor,
  replayLedger,
  sha256Hex,
  shardMonthFor,
  type IntegrationRecord,
  type LedgerOperation,
} from "@universal-harness-internal/core";
import { beforeEach, describe, expect, it } from "vitest";

import { COLLABORATION_CONTROL_REF } from "../../src/collaboration/connection.js";
import type {
  AcceptIntegrationCommand,
  CollaborationOutcome,
  CollaborationSession,
  ConnectCommand,
  PlatformIdentityPort,
  PrepareIntegrationCommand,
  PrincipalSnapshotDraftResult,
} from "../../src/collaboration/index.js";
import { createCollaborationCoordinator } from "../../src/collaboration/index.js";
import { SqliteCoordinatorProjection } from "../../src/collaboration/sqlite-projection.js";
import {
  createIntegrationFakeStore,
  operationRefFor,
  TARGET_REF,
  type IntegrationFakeStore,
} from "./integration-fakes.js";

const digest = (letter: string): string => letter.repeat(64);
const POLICY_DIGEST = digest("1");

const T0 = "2026-08-29T00:00:00.000Z";
const T1 = "2026-08-29T00:01:00.000Z";
const T2 = "2026-08-29T00:02:00.000Z";
const AFTER_LEASE_EXPIRY = "2026-08-29T00:06:00.000Z";

let currentNow = T0;

const session = (principal_id: string): CollaborationSession => ({
  principal_id,
  client_instance_id: "instance_test",
});

function connectCommand(): ConnectCommand {
  return {
    kind: "connect",
    command_id: "command_connect_1",
    project_id: "project_demo",
    canonical_remote: "https://github.com/acme/demo.git",
    target_ref: TARGET_REF,
    coordinator_origin: "https://harness.example.com",
    policy_digest: POLICY_DIGEST,
  };
}

function prepareCommand(
  operationId: string,
  commandId = "command_prepare_1",
): PrepareIntegrationCommand {
  return {
    kind: "prepare_integration",
    command_id: commandId,
    project_id: "project_demo",
    operation_id: operationId,
  };
}

function acceptCommand(
  integrationId: string,
  expectedTargetCommit: string,
  commandId = "command_accept_1",
): AcceptIntegrationCommand {
  return {
    kind: "accept_integration",
    command_id: commandId,
    project_id: "project_demo",
    integration_id: integrationId,
    expected_target_commit: expectedTargetCommit,
  };
}

function createPlatform(permission: "maintain" | "write" = "maintain"): PlatformIdentityPort {
  return {
    discover(remote) {
      return Promise.resolve({
        status: "resolved" as const,
        identity: {
          provider: "github" as const,
          host: "github.com",
          repository_id: "acme/demo",
          canonical_remote: remote,
          canonical_remote_digest: digest("r"),
        },
      });
    },
    authenticate(input): Promise<PrincipalSnapshotDraftResult> {
      return Promise.resolve({
        status: "authenticated" as const,
        snapshot: {
          principal_id: input.principal_id,
          provider: input.provider,
          host: input.host,
          subject_id: "1234567",
          repository_id: input.repository_id,
          permission,
          observed_at: T0,
          expires_at: "2027-01-01T00:00:00.000Z",
          source_response_digest: digest("s"),
        },
      });
    },
    inspectControlRefProtection() {
      return Promise.resolve({ status: "protected" as const });
    },
  };
}

/** One fixture manifest plus every ledger byte it references. */
function makeManifest(input: {
  id: string;
  sequence: number;
  baseline: string;
  committedAt: string;
  artifacts?: Readonly<Record<string, string>>;
  includeShards?: boolean;
}): { manifest: LedgerOperation; files: Record<string, string> } {
  const artifacts = input.artifacts ?? {};
  const month = shardMonthFor(input.committedAt);
  const manifest = buildManifest({
    ledger_operation_id: input.id,
    workflow_operation_id: `workflow_${input.id}`,
    attempt_id: `attempt_${input.id}`,
    baseline_commit: input.baseline,
    sequence: input.sequence,
    artifact_digests: Object.values(artifacts)
      .map((content) => sha256Hex(content))
      .sort(),
    edge_file: edgeShardRelativePath(month, input.id),
    event_file: eventShardRelativePath(month, input.id),
    edge_file_digest: sha256Hex(""),
    event_file_digest: sha256Hex(""),
    committed_at: input.committedAt,
  });
  const files: Record<string, string> = {
    [`.harness/ledger/operations/${input.id}.json`]: `${canonicalizeJson(manifest)}\n`,
  };
  if (input.includeShards !== false) {
    files[`.harness/${manifest.edge_file}`] = "";
    files[`.harness/${manifest.event_file}`] = "";
  }
  for (const [path, content] of Object.entries(artifacts)) {
    files[`.harness/${path}`] = content;
  }
  return { manifest, files };
}

function mergeFiles(...sets: readonly Record<string, string>[]): Record<string, string> {
  return Object.assign({}, ...sets);
}

/** A gate evidence artifact file (ledger-relative path -> content). */
function gateEvidenceArtifact(input: {
  id: string;
  mandatory: boolean;
  passed: boolean;
  provisional?: boolean;
  policyDigest?: string;
}): Record<string, string> {
  const record = {
    protocol_version: "1.0.0",
    record_kind: "evidence",
    evidence_id: input.id,
    evidence_type: "gate_result",
    subject_id: "subject_demo_1",
    digest: digest("e"),
    provisional: input.provisional ?? false,
    created_at: T0,
    extensions: {
      "harness.gate": {
        gate_id: "gate_unit_tests",
        layer: "test",
        mandatory: input.mandatory,
        passed: input.passed,
        exit_code: input.passed ? 0 : 1,
        summary: "gate ran",
        log_summary: "log",
        artifact_hashes: {},
        bindings: {
          artifact_digests: [],
          code_digests: [],
          gate_digest: digest("g"),
          evaluation_case_digests: [],
          policy_digest: input.policyDigest ?? POLICY_DIGEST,
        },
      },
    },
  };
  return {
    [`artifacts/evidence/${input.id}.json`]: `${canonicalizeJson(record)}\n`,
  };
}

/** An approval request artifact file (ledger-relative path -> content). */
function approvalRequestArtifact(input: {
  id: string;
  policyDigest?: string;
}): Record<string, string> {
  const record = {
    protocol_version: "1.0.0",
    record_kind: "approval_request",
    request_id: input.id,
    workflow_operation_id: "workflow_approval_1",
    object_id: "object_policy_1",
    object_type: "policy",
    object_digest: digest("o"),
    baseline_digest: digest("b"),
    policy_digest: input.policyDigest ?? POLICY_DIGEST,
    impact_path: ["policy"],
    risk: "high",
    reason: "remote approval fixture",
    allowed_decisions: ["approve", "reject"],
    created_at: T0,
    proposed_by: "principal_alice",
  };
  return {
    [`artifacts/approval-requests/${input.id}.json`]: `${canonicalizeJson(record)}\n`,
  };
}

interface Harness {
  readonly store: IntegrationFakeStore;
  readonly coordinator: ReturnType<typeof createCollaborationCoordinator>;
  readonly projection: SqliteCoordinatorProjection;
}

function createHarness(
  store: IntegrationFakeStore,
  platform: PlatformIdentityPort = createPlatform(),
): Harness {
  const projection = new SqliteCoordinatorProjection(":memory:");
  const coordinator = createCollaborationCoordinator({
    platform,
    controlStore: store.port,
    projection,
    now: () => currentNow,
  });
  return { store, coordinator, projection };
}

async function connect(harness: Harness): Promise<void> {
  const outcome = await harness.coordinator.execute(connectCommand(), session("principal_alice"));
  expect(outcome.status).toBe("connected");
}

/**
 * The shared fork fixture: `main` holds sequences 1..3, the operation branch
 * forked when `main` held 1..2 and adds its own manifest at sequence 3.
 */
function seedForkedBranches(store: IntegrationFakeStore): {
  forkPoint: string;
  targetTip: string;
  operationTip: string;
  operationId: string;
} {
  const fork = store.commitTree(
    [],
    mergeFiles(
      makeManifest({ id: "operation_a_1", sequence: 1, baseline: digest("a"), committedAt: T0 })
        .files,
      makeManifest({ id: "operation_a_2", sequence: 2, baseline: digest("a"), committedAt: T0 })
        .files,
    ),
  );
  const targetTip = store.commitTree(
    [fork],
    makeManifest({ id: "operation_a_3", sequence: 3, baseline: fork, committedAt: T1 }).files,
  );
  store.moveRef(TARGET_REF, targetTip);
  const operationTip = store.commitTree(
    [fork],
    makeManifest({ id: "operation_b_1", sequence: 3, baseline: fork, committedAt: T2 }).files,
  );
  store.moveRef(operationRefFor("operation_b"), operationTip);
  return { forkPoint: fork, targetTip, operationTip, operationId: "operation_b" };
}

function prepared(outcome: CollaborationOutcome) {
  expect(outcome.status).toBe("prepared");
  if (outcome.status !== "prepared") throw new Error("unreachable");
  return outcome;
}

function failed(outcome: CollaborationOutcome) {
  expect(outcome.status).toBe("failed");
  if (outcome.status !== "failed") throw new Error("unreachable");
  return outcome;
}

describe("integration commands", () => {
  beforeEach(() => {
    currentNow = T0;
  });

  it("prepares a deterministic candidate and resequences the forked incoming manifest", async () => {
    const store = createIntegrationFakeStore();
    const { targetTip, operationTip, operationId } = seedForkedBranches(store);
    const harness = createHarness(store);
    await connect(harness);

    const outcome = prepared(
      await harness.coordinator.execute(prepareCommand(operationId), session("principal_alice")),
    );

    expect(outcome.replayed).toBe(false);
    expect(outcome.integration_record.operation_id).toBe(operationId);
    expect(outcome.integration_record.expected_target_commit).toBe(targetTip);
    expect(outcome.integration_record.operation_commit).toBe(operationTip);
    expect(outcome.integration_record.lease_fencing_token).toBe(1);
    expect(outcome.integration_record.ledger_sequence_rewrites).toHaveLength(1);
    expect(outcome.integration_record.ledger_sequence_rewrites[0]).toMatchObject({
      ledger_operation_id: "operation_b_1",
      old_sequence: 3,
      new_sequence: 4,
    });
    // The integration lease is on the control chain.
    expect(
      store.controlRecords.filter(
        (record) => record.record_kind === "lease" && record.resource_kind === "integration",
      ),
    ).toHaveLength(1);
    // The candidate tree replays a fully linear ledger: target 1..3,
    // resequenced incoming 4, integration record transaction 5.
    const candidateRoot = store.lastCandidateRoot as string;
    const replay = replayLedger(harnessRootFor(candidateRoot));
    expect(replay.operations.map((operation) => operation.manifest.sequence)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    // The projection carries the record for the conflicts view.
    const view = await harness.coordinator.query(
      { kind: "integration_conflicts", project_id: "project_demo" },
      session("principal_alice"),
    );
    expect(view.kind).toBe("integration_conflicts");
    if (view.kind !== "integration_conflicts") throw new Error("unreachable");
    expect(view.conflicts.map((record) => record.integration_id)).toContain(
      outcome.integration_record.integration_id,
    );
  });

  it("replays a repeated prepare from the staged candidate without new facts", async () => {
    const store = createIntegrationFakeStore();
    const { operationId } = seedForkedBranches(store);
    const harness = createHarness(store);
    await connect(harness);
    const first = prepared(
      await harness.coordinator.execute(prepareCommand(operationId), session("principal_alice")),
    );
    const controlCount = store.controlRecords.length;

    const second = prepared(
      await harness.coordinator.execute(prepareCommand(operationId), session("principal_alice")),
    );

    expect(second.replayed).toBe(true);
    expect(second.integration_record.record_digest).toBe(first.integration_record.record_digest);
    expect(second.candidate_commit).toBe(first.candidate_commit);
    expect(store.controlRecords.length).toBe(controlCount);
  });

  it("maps a text conflict to integration_conflict and stages nothing", async () => {
    const store = createIntegrationFakeStore();
    const fork = store.commitTree(
      [],
      makeManifest({ id: "operation_a_1", sequence: 1, baseline: digest("a"), committedAt: T0 })
        .files,
    );
    const targetTip = store.commitTree([fork], { "docs/spec.md": "target wording\n" });
    store.moveRef(TARGET_REF, targetTip);
    const operationTip = store.commitTree([fork], {
      "docs/spec.md": "operation wording\n",
      ...makeManifest({ id: "operation_b_1", sequence: 2, baseline: fork, committedAt: T2 }).files,
    });
    store.moveRef(operationRefFor("operation_b"), operationTip);
    const harness = createHarness(store);
    await connect(harness);

    const outcome = failed(
      await harness.coordinator.execute(prepareCommand("operation_b"), session("principal_alice")),
    );

    expect(outcome.failure.code).toBe("integration_conflict");
    expect(outcome.failure.summary).toContain("docs/spec.md");
    expect(store.tip(TARGET_REF)).toBe(targetTip);
  });

  it("surfaces a reused manifest id with different bytes as a text conflict", async () => {
    // The same ledger_operation_id lives at the same manifest path, so
    // divergent bytes conflict textually before resequencing ever runs; the
    // same id / different digest rejection inside resequenceCandidateLedger
    // is covered by ledger-resequence.test.ts at the pure-function seam.
    const store = createIntegrationFakeStore();
    const fork = store.commitTree(
      [],
      makeManifest({ id: "operation_a_1", sequence: 1, baseline: digest("a"), committedAt: T0 })
        .files,
    );
    const targetTip = store.commitTree(
      [fork],
      makeManifest({ id: "operation_x_1", sequence: 2, baseline: fork, committedAt: T1 }).files,
    );
    store.moveRef(TARGET_REF, targetTip);
    const operationTip = store.commitTree(
      [fork],
      makeManifest({
        id: "operation_x_1",
        sequence: 2,
        baseline: fork,
        committedAt: T2,
        artifacts: { "artifacts/notes/x.txt": "different content\n" },
      }).files,
    );
    store.moveRef(operationRefFor("operation_b"), operationTip);
    const harness = createHarness(store);
    await connect(harness);

    const outcome = failed(
      await harness.coordinator.execute(prepareCommand("operation_b"), session("principal_alice")),
    );

    expect(outcome.failure.code).toBe("integration_conflict");
    expect(outcome.failure.summary).toContain("operation_x_1");
  });

  it("fails closed when the candidate tree misses a shard its manifest references", async () => {
    const store = createIntegrationFakeStore();
    const fork = store.commitTree(
      [],
      makeManifest({ id: "operation_a_1", sequence: 1, baseline: digest("a"), committedAt: T0 })
        .files,
    );
    store.moveRef(TARGET_REF, fork);
    const operationTip = store.commitTree(
      [fork],
      makeManifest({
        id: "operation_b_1",
        sequence: 2,
        baseline: fork,
        committedAt: T2,
        includeShards: false,
      }).files,
    );
    store.moveRef(operationRefFor("operation_b"), operationTip);
    const harness = createHarness(store);
    await connect(harness);

    const outcome = failed(
      await harness.coordinator.execute(prepareCommand("operation_b"), session("principal_alice")),
    );

    expect(outcome.failure.code).toBe("ledger_resequence_failed");
  });

  it("rejects an operation branch that adds no new ledger operations", async () => {
    const store = createIntegrationFakeStore();
    const fork = store.commitTree(
      [],
      makeManifest({ id: "operation_a_1", sequence: 1, baseline: digest("a"), committedAt: T0 })
        .files,
    );
    store.moveRef(TARGET_REF, fork);
    const operationTip = store.commitTree([fork], { "docs/notes.md": "only docs\n" });
    store.moveRef(operationRefFor("operation_b"), operationTip);
    const harness = createHarness(store);
    await connect(harness);

    const outcome = failed(
      await harness.coordinator.execute(prepareCommand("operation_b"), session("principal_alice")),
    );

    expect(outcome.failure.code).toBe("ledger_resequence_failed");
  });

  it("blocks a failed mandatory gate carried by the incoming branch", async () => {
    const store = createIntegrationFakeStore();
    const fork = store.commitTree(
      [],
      makeManifest({ id: "operation_a_1", sequence: 1, baseline: digest("a"), committedAt: T0 })
        .files,
    );
    store.moveRef(TARGET_REF, fork);
    const evidence = gateEvidenceArtifact({
      id: "evidence_failed_1",
      mandatory: true,
      passed: false,
    });
    const operationTip = store.commitTree(
      [fork],
      makeManifest({
        id: "operation_b_1",
        sequence: 2,
        baseline: fork,
        committedAt: T2,
        artifacts: evidence,
      }).files,
    );
    store.moveRef(operationRefFor("operation_b"), operationTip);
    const harness = createHarness(store);
    await connect(harness);

    const outcome = failed(
      await harness.coordinator.execute(prepareCommand("operation_b"), session("principal_alice")),
    );

    expect(outcome.failure.code).toBe("integration_gate_failed");
  });

  it("blocks mandatory gate evidence bound to a superseded policy digest", async () => {
    const store = createIntegrationFakeStore();
    const fork = store.commitTree(
      [],
      makeManifest({ id: "operation_a_1", sequence: 1, baseline: digest("a"), committedAt: T0 })
        .files,
    );
    store.moveRef(TARGET_REF, fork);
    const evidence = gateEvidenceArtifact({
      id: "evidence_stale_1",
      mandatory: true,
      passed: true,
      policyDigest: digest("9"),
    });
    const operationTip = store.commitTree(
      [fork],
      makeManifest({
        id: "operation_b_1",
        sequence: 2,
        baseline: fork,
        committedAt: T2,
        artifacts: evidence,
      }).files,
    );
    store.moveRef(operationRefFor("operation_b"), operationTip);
    const harness = createHarness(store);
    await connect(harness);

    const outcome = failed(
      await harness.coordinator.execute(prepareCommand("operation_b"), session("principal_alice")),
    );

    expect(outcome.failure.code).toBe("integration_gate_failed");
  });

  it("rejects an approval request whose policy binding drifted", async () => {
    const store = createIntegrationFakeStore();
    const fork = store.commitTree(
      [],
      makeManifest({ id: "operation_a_1", sequence: 1, baseline: digest("a"), committedAt: T0 })
        .files,
    );
    store.moveRef(TARGET_REF, fork);
    const request = approvalRequestArtifact({ id: "request_drifted_1", policyDigest: digest("9") });
    const operationTip = store.commitTree(
      [fork],
      makeManifest({
        id: "operation_b_1",
        sequence: 2,
        baseline: fork,
        committedAt: T2,
        artifacts: request,
      }).files,
    );
    store.moveRef(operationRefFor("operation_b"), operationTip);
    const harness = createHarness(store);
    await connect(harness);

    const outcome = failed(
      await harness.coordinator.execute(prepareCommand("operation_b"), session("principal_alice")),
    );

    expect(outcome.failure.code).toBe("approval_binding_mismatch");
  });

  it("denies prepare when the actor's platform permission dropped below maintain", async () => {
    const store = createIntegrationFakeStore();
    const { operationId } = seedForkedBranches(store);
    const harness = createHarness(store);
    await connect(harness);
    const demoted = createCollaborationCoordinator({
      platform: createPlatform("write"),
      controlStore: store.port,
      projection: harness.projection,
      now: () => currentNow,
    });

    const outcome = failed(
      await demoted.execute(prepareCommand(operationId), session("principal_alice")),
    );

    expect(outcome.failure.code).toBe("permission_denied");
  });

  it("accepts a prepared candidate, fast-forwards the target and replays a repeated accept", async () => {
    const store = createIntegrationFakeStore();
    const { targetTip, operationId } = seedForkedBranches(store);
    const harness = createHarness(store);
    await connect(harness);
    const prepare = prepared(
      await harness.coordinator.execute(prepareCommand(operationId), session("principal_alice")),
    );
    const record = prepare.integration_record;

    const accepted = await harness.coordinator.execute(
      acceptCommand(record.integration_id, targetTip),
      session("principal_alice"),
    );

    expect(accepted.status).toBe("accepted");
    if (accepted.status !== "accepted") throw new Error("unreachable");
    expect(accepted.replayed).toBe(false);
    expect(accepted.target_commit).toBe(prepare.candidate_commit);
    expect(store.tip(TARGET_REF)).toBe(prepare.candidate_commit);
    // The Integration Lease is released best-effort after the CAS landed.
    const leases = store.controlRecords.filter(
      (entry) => entry.record_kind === "lease" && entry.resource_kind === "integration",
    );
    expect(leases[leases.length - 1]?.state).toBe("released");
    // The accepted record is part of the target history.
    const read = await store.port.readIntegrationRecord({
      project_id: "project_demo",
      target_ref: TARGET_REF,
      integration_id: record.integration_id,
    });
    expect(read.status).toBe("found");

    const replayed = await harness.coordinator.execute(
      acceptCommand(record.integration_id, targetTip),
      session("principal_alice"),
    );
    expect(replayed.status).toBe("accepted");
    if (replayed.status !== "accepted") throw new Error("unreachable");
    expect(replayed.replayed).toBe(true);
  });

  it("recovers an accepted integration whose CAS response was lost", async () => {
    const store = createIntegrationFakeStore();
    const { targetTip, operationId } = seedForkedBranches(store);
    const harness = createHarness(store);
    await connect(harness);
    const prepare = prepared(
      await harness.coordinator.execute(prepareCommand(operationId), session("principal_alice")),
    );
    const record = prepare.integration_record;
    // The swap lands but the response is lost; the coordinator's recovery
    // read of the Target history heals the same call (never a blind retry).
    store.loseNextCasResponse = true;

    const recovered = await harness.coordinator.execute(
      acceptCommand(record.integration_id, targetTip),
      session("principal_alice"),
    );
    expect(recovered.status).toBe("accepted");
    if (recovered.status !== "accepted") throw new Error("unreachable");
    expect(recovered.replayed).toBe(true);
    expect(recovered.target_commit).toBe(prepare.candidate_commit);
    expect(store.tip(TARGET_REF)).toBe(prepare.candidate_commit);

    // A later retry observes the same accepted fact without new merges.
    const replayed = await harness.coordinator.execute(
      acceptCommand(record.integration_id, targetTip),
      session("principal_alice"),
    );
    expect(replayed.status).toBe("accepted");
    if (replayed.status !== "accepted") throw new Error("unreachable");
    expect(replayed.replayed).toBe(true);
    expect(store.tip(TARGET_REF)).toBe(prepare.candidate_commit);
  });

  it("rejects accept with baseline_drift when the command freezes a different target", async () => {
    const store = createIntegrationFakeStore();
    const { operationId } = seedForkedBranches(store);
    const harness = createHarness(store);
    await connect(harness);
    const prepare = prepared(
      await harness.coordinator.execute(prepareCommand(operationId), session("principal_alice")),
    );

    const outcome = failed(
      await harness.coordinator.execute(
        acceptCommand(prepare.integration_record.integration_id, digest("f").slice(0, 40)),
        session("principal_alice"),
      ),
    );

    expect(outcome.failure.code).toBe("baseline_drift");
  });

  it("fails accept with target_cas_failed when the target moved after prepare", async () => {
    const store = createIntegrationFakeStore();
    const { targetTip, operationId } = seedForkedBranches(store);
    const harness = createHarness(store);
    await connect(harness);
    const prepare = prepared(
      await harness.coordinator.execute(prepareCommand(operationId), session("principal_alice")),
    );
    const moved = store.commitTree([targetTip], { "docs/other.md": "someone else\n" });
    store.moveRef(TARGET_REF, moved);

    const outcome = failed(
      await harness.coordinator.execute(
        acceptCommand(prepare.integration_record.integration_id, targetTip),
        session("principal_alice"),
      ),
    );

    expect(outcome.failure.code).toBe("target_cas_failed");
    expect(store.tip(TARGET_REF)).toBe(moved);
  });

  it("rejects accept when the integration lease expired", async () => {
    const store = createIntegrationFakeStore();
    const { targetTip, operationId } = seedForkedBranches(store);
    const harness = createHarness(store);
    await connect(harness);
    const prepare = prepared(
      await harness.coordinator.execute(prepareCommand(operationId), session("principal_alice")),
    );
    currentNow = AFTER_LEASE_EXPIRY;

    const outcome = failed(
      await harness.coordinator.execute(
        acceptCommand(prepare.integration_record.integration_id, targetTip),
        session("principal_alice"),
      ),
    );

    expect(outcome.failure.code).toBe("lease_expired");
    expect(store.tip(TARGET_REF)).toBe(targetTip);
  });

  it("fences accept when a newer lease holds the integration resource", async () => {
    const store = createIntegrationFakeStore();
    const { targetTip, operationId } = seedForkedBranches(store);
    const harness = createHarness(store);
    await connect(harness);
    const prepare = prepared(
      await harness.coordinator.execute(prepareCommand(operationId), session("principal_alice")),
    );
    // A competitor won the integration resource with fencing token 2.
    const snapshot = store.controlRecords.find(
      (record) => record.record_kind === "principal_snapshot",
    );
    const previous = store.controlRecords[store.controlRecords.length - 1];
    if (snapshot === undefined || previous === undefined) throw new Error("fixture broken");
    const forged = buildCollaborationRecord({
      record_kind: "lease" as const,
      control_sequence: store.controlRecords.length + 1,
      previous_control_record_digest: previous.record_digest,
      lease_record_id: "lease-record_competitor_1",
      lease_id: "lease_competitor_1",
      resource_kind: "integration" as const,
      resource_id: "project_demo",
      fencing_token: 2,
      issued_at: currentNow,
      expires_at: "2027-01-01T00:00:00.000Z",
      state: "granted" as const,
      command_id: "command_competitor_1",
      holder_principal_snapshot_digest: snapshot.record_digest,
      client_instance_id: "instance_competitor",
    });
    await store.port.appendControl({
      project_id: "project_demo",
      control_ref: COLLABORATION_CONTROL_REF,
      expected_head_oid: `oid_control_${store.controlRecords.length}`,
      record: forged,
    });

    const outcome = failed(
      await harness.coordinator.execute(
        acceptCommand(prepare.integration_record.integration_id, targetTip),
        session("principal_alice"),
      ),
    );

    expect(outcome.failure.code).toBe("lease_fenced");
    expect(store.tip(TARGET_REF)).toBe(targetTip);
  });

  it("rejects accept of a staged candidate whose record was tampered with", async () => {
    const store = createIntegrationFakeStore();
    const { targetTip, operationId } = seedForkedBranches(store);
    const harness = createHarness(store);
    await connect(harness);
    const prepare = prepared(
      await harness.coordinator.execute(prepareCommand(operationId), session("principal_alice")),
    );
    const record = prepare.integration_record;
    // A forged record with a valid envelope but an emptied rewrite map: the
    // deterministic recomputation at accept must not reproduce it.
    const forged: IntegrationRecord = buildCollaborationRecord({
      record_kind: "integration" as const,
      integration_id: record.integration_id,
      operation_id: record.operation_id,
      expected_target_commit: record.expected_target_commit,
      operation_commit: record.operation_commit,
      lease_fencing_token: record.lease_fencing_token,
      ledger_sequence_rewrites: [],
      evidence_digests: [...record.evidence_digests],
      approval_decision_digests: [...record.approval_decision_digests],
      command_id: record.command_id,
    });
    store.replaceStagingRecord(record.integration_id, forged);

    const outcome = failed(
      await harness.coordinator.execute(
        acceptCommand(record.integration_id, targetTip),
        session("principal_alice"),
      ),
    );

    expect(outcome.failure.code).toBe("ledger_resequence_failed");
    expect(store.tip(TARGET_REF)).toBe(targetTip);
  });

  it("requires a staged candidate before accept", async () => {
    const store = createIntegrationFakeStore();
    seedForkedBranches(store);
    const harness = createHarness(store);
    await connect(harness);

    const outcome = failed(
      await harness.coordinator.execute(
        acceptCommand("integration_neverprepared", digest("f").slice(0, 40)),
        session("principal_alice"),
      ),
    );

    expect(outcome.failure.code).toBe("coordinator_unavailable");
  });
});
