import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  buildCollaborationRecord,
  buildManifest,
  canonicalizeJson,
  contentDigest,
  edgeShardRelativePath,
  eventShardRelativePath,
  harnessRootFor,
  replayLedger,
  sha256Hex,
  shardMonthFor,
  type EdgeRecord,
  type IntegrationRecord,
  type LedgerOperation,
  type NodeRecord,
} from "@universal-harness-internal/core";
import {
  freezeImpactSet,
  generateImpactSet,
  readImpactSetContent,
} from "@universal-harness-internal/graph";
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
import { hashWorktreeCode } from "../../src/snapshot/anchor.js";
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
  edges?: readonly EdgeRecord[];
  includeShards?: boolean;
}): { manifest: LedgerOperation; files: Record<string, string> } {
  const artifacts = input.artifacts ?? {};
  const edgeContent =
    input.edges === undefined || input.edges.length === 0
      ? ""
      : `${input.edges.map((edge) => JSON.stringify(edge)).join("\n")}\n`;
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
    edge_file_digest: sha256Hex(edgeContent),
    event_file_digest: sha256Hex(""),
    committed_at: input.committedAt,
  });
  const files: Record<string, string> = {
    [`.harness/ledger/operations/${input.id}.json`]: `${canonicalizeJson(manifest)}\n`,
  };
  if (input.includeShards !== false) {
    files[`.harness/${manifest.edge_file}`] = edgeContent;
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
  codeDigests?: readonly string[];
  artifactDigests?: readonly string[];
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
          artifact_digests: [...(input.artifactDigests ?? [])],
          code_digests: [...(input.codeDigests ?? [])],
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

/**
 * The code digest a worktree holding exactly `files` binds — the same
 * Git-listed digest the Coordinator recomputes on the candidate root.
 */
function codeDigestOf(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "harness-code-"));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split("/"));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  execFileSync("git", ["init", "-q", "-b", "code"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  return hashWorktreeCode(root);
}

/** An approval request artifact file (ledger-relative path -> content). */
function approvalRequestArtifact(input: {
  id: string;
  policyDigest?: string;
  objectId?: string;
  objectType?: string;
  objectDigest?: string;
  baselineDigest?: string;
  impactPath?: readonly string[];
}): Record<string, string> {
  const record = {
    protocol_version: "1.0.0",
    record_kind: "approval_request",
    request_id: input.id,
    workflow_operation_id: "workflow_approval_1",
    object_id: input.objectId ?? "object_policy_1",
    object_type: input.objectType ?? "policy",
    object_digest: input.objectDigest ?? digest("o"),
    baseline_digest: input.baselineDigest ?? digest("b"),
    policy_digest: input.policyDigest ?? POLICY_DIGEST,
    impact_path: [...(input.impactPath ?? ["policy"])],
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

// --- Graph-carrying fixtures for the candidate revalidation chain ----------

const ITERATION_TARGET = "iteration_a";
const ITERATION_DRIFT = "iteration_c";
const ITERATION_BRANCH = "iteration_b";

interface GraphNodeFixture {
  readonly path: string;
  readonly content: string;
  readonly node: NodeRecord;
}

function graphNodeFixture(input: {
  id: string;
  type: NodeRecord["type"];
  iterationId: string;
  revision?: number;
  status?: NodeRecord["status"];
  extensions?: Record<string, unknown>;
}): GraphNodeFixture {
  const record = {
    protocol_version: "1.0.0",
    record_kind: "node",
    id: input.id,
    type: input.type,
    revision: input.revision ?? 1,
    status: input.status ?? "accepted",
    source: "workflow",
    provenance: { iteration_id: input.iterationId, actor: "fixture", timestamp: T0 },
    confidence: 1,
    ...(input.extensions === undefined ? {} : { extensions: input.extensions }),
  };
  const node = { ...record, digest: contentDigest(record) } as unknown as NodeRecord;
  return {
    path: `artifacts/graph/${input.id}-r${String(node.revision)}.json`,
    content: `${canonicalizeJson(node)}\n`,
    node,
  };
}

function edgeFixture(input: {
  id: string;
  type: EdgeRecord["type"];
  sourceId: string;
  targetId: string;
  iterationId: string;
}): EdgeRecord {
  const record = {
    protocol_version: "1.0.0",
    record_kind: "edge",
    id: input.id,
    type: input.type,
    source_id: input.sourceId,
    target_id: input.targetId,
    status: "accepted",
    source: "workflow",
    provenance: { iteration_id: input.iterationId, actor: "fixture", timestamp: T0 },
    confidence: 1,
  };
  return { ...record, digest: contentDigest(record) } as unknown as EdgeRecord;
}

function impactSetFiles(proposed: NodeRecord, frozen: NodeRecord): Record<string, string> {
  return {
    [`artifacts/impact-sets/${proposed.id}/1.json`]: `${canonicalizeJson(proposed)}\n`,
    [`artifacts/impact-sets/${frozen.id}/2.json`]: `${canonicalizeJson(frozen)}\n`,
  };
}

/** A ledger-vouched requirement baseline document carrying `digest` internally. */
function baselineDocumentFile(baselineDigest: string): Record<string, string> {
  const document = {
    protocol_version: "1.0.0",
    record_kind: "requirement_baseline",
    digest: baselineDigest,
  };
  return {
    [`artifacts/requirement-baselines/${baselineDigest}.json`]: `${canonicalizeJson(document)}\n`,
  };
}

/** An ExecutionPlan node artifact pinning one frozen ImpactSet. */
function planNodeFixture(input: {
  id: string;
  impactSetId: string;
  impactSetDigest: string;
}): GraphNodeFixture {
  const planDigest = contentDigest({ plan_of: input.impactSetId });
  return graphNodeFixture({
    id: input.id,
    type: "ExecutionPlan",
    iterationId: ITERATION_BRANCH,
    extensions: {
      "harness.plan": {
        content_digest: planDigest,
        impact_set_id: input.impactSetId,
        impact_set_digest: input.impactSetDigest,
      },
    },
  });
}

const IMPACT_SEED = {
  id: "seed_requirement_1",
  nodeId: "requirement_1",
  kind: "content-change",
  iterationKind: "feature",
  reason: "fixture seed",
} as const;

/**
 * Fork with one Requirement on the target; the operation branch freezes an
 * ImpactSet over the fork graph, binds an approval request to its content
 * digest and pins the set in its ExecutionPlan. The target then advances with
 * a clean, ledger-only drift commit whose blast radius depends on `drift`:
 * "reachable" adds a Test plus a VERIFIES edge into the frozen set's seed,
 * "unrelated" adds an unconnected Test.
 */
function seedImpactBranches(
  store: IntegrationFakeStore,
  drift: "reachable" | "unrelated",
): {
  targetTip: string;
  operationId: string;
} {
  const requirement = graphNodeFixture({
    id: "requirement_1",
    type: "Requirement",
    iterationId: ITERATION_TARGET,
  });
  const fork = store.commitTree(
    [],
    makeManifest({
      id: "operation_a_1",
      sequence: 1,
      baseline: digest("a"),
      committedAt: T0,
      artifacts: { [requirement.path]: requirement.content },
    }).files,
  );

  const proposed = generateImpactSet([{ ...IMPACT_SEED }], [requirement.node], [], {
    iterationId: ITERATION_BRANCH,
    actor: "fixture",
    timestamp: T0,
  });
  const frozen = freezeImpactSet(proposed, digest("d"));
  const impactContent = readImpactSetContent(frozen);
  const plan = planNodeFixture({
    id: `plan_${contentDigest({ set: frozen.id }).slice(0, 16)}`,
    impactSetId: frozen.id,
    impactSetDigest: impactContent.content_digest,
  });
  const request = approvalRequestArtifact({
    id: "request_impact_1",
    objectId: frozen.id,
    objectType: "ImpactSet",
    objectDigest: impactContent.content_digest,
    baselineDigest: digest("b"),
    impactPath: [],
  });
  const operationTip = store.commitTree(
    [fork],
    makeManifest({
      id: "operation_b_1",
      sequence: 2,
      baseline: fork,
      committedAt: T2,
      artifacts: mergeFiles(
        impactSetFiles(proposed, frozen),
        baselineDocumentFile(digest("b")),
        { [plan.path]: plan.content },
        request,
      ),
    }).files,
  );
  store.moveRef(operationRefFor("operation_b"), operationTip);

  const driftNode = graphNodeFixture({
    id: "test_1",
    type: "Test",
    iterationId: ITERATION_DRIFT,
  });
  const driftEdges =
    drift === "reachable"
      ? [
          edgeFixture({
            id: "edge_verify_1",
            type: "VERIFIES",
            sourceId: "test_1",
            targetId: "requirement_1",
            iterationId: ITERATION_DRIFT,
          }),
        ]
      : [];
  const targetTip = store.commitTree(
    [fork],
    makeManifest({
      id: "operation_a_2",
      sequence: 2,
      baseline: fork,
      committedAt: T1,
      artifacts: { [driftNode.path]: driftNode.content },
      edges: driftEdges,
    }).files,
  );
  store.moveRef(TARGET_REF, targetTip);
  return { targetTip, operationId: "operation_b" };
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

  it("passes mandatory evidence whose code binding covers the candidate code", async () => {
    const store = createIntegrationFakeStore();
    const fork = store.commitTree(
      [],
      mergeFiles(
        makeManifest({ id: "operation_a_1", sequence: 1, baseline: digest("a"), committedAt: T0 })
          .files,
        { "src/a.txt": "A\n" },
      ),
    );
    store.moveRef(TARGET_REF, fork);
    // The target adds no code after the fork, so the candidate code equals
    // the code the evidence covered on the operation branch.
    const evidence = gateEvidenceArtifact({
      id: "evidence_fresh_1",
      mandatory: true,
      passed: true,
      codeDigests: [codeDigestOf({ "src/a.txt": "A\n" })],
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

    const outcome = await harness.coordinator.execute(
      prepareCommand("operation_b"),
      session("principal_alice"),
    );

    expect(outcome.status).toBe("prepared");
  });

  it("blocks mandatory gate evidence whose code binding predates the candidate code", async () => {
    const store = createIntegrationFakeStore();
    const fork = store.commitTree(
      [],
      mergeFiles(
        makeManifest({ id: "operation_a_1", sequence: 1, baseline: digest("a"), committedAt: T0 })
          .files,
        { "src/a.txt": "A\n" },
      ),
    );
    store.moveRef(TARGET_REF, fork);
    const evidence = gateEvidenceArtifact({
      id: "evidence_moved_1",
      mandatory: true,
      passed: true,
      codeDigests: [digest("c")],
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
    expect(outcome.failure.summary).toContain("code");
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

  it("rejects a candidate whose frozen impact set no longer covers the drifted target graph", async () => {
    const store = createIntegrationFakeStore();
    const { operationId } = seedImpactBranches(store, "reachable");
    const harness = createHarness(store);
    await connect(harness);

    const outcome = failed(
      await harness.coordinator.execute(prepareCommand(operationId), session("principal_alice")),
    );

    expect(outcome.failure.code).toBe("baseline_drift");
    expect(outcome.failure.summary).toContain("impact");
    expect(store.tip(TARGET_REF)).not.toBeUndefined();
  });

  it("prepares when target drift stays outside the frozen impact set's blast radius", async () => {
    const store = createIntegrationFakeStore();
    const { operationId } = seedImpactBranches(store, "unrelated");
    const harness = createHarness(store);
    await connect(harness);

    const outcome = await harness.coordinator.execute(
      prepareCommand(operationId),
      session("principal_alice"),
    );

    expect(outcome.status).toBe("prepared");
  });

  it("revalidates only the frozen impact set the current plan pins, never superseded ones", async () => {
    const store = createIntegrationFakeStore();
    // The branch froze a first impact set over the fork graph, then re-froze a
    // second set that already accounts for the target drift and pinned it in
    // the current plan; the stale first set must not fail the candidate.
    const requirement = graphNodeFixture({
      id: "requirement_1",
      type: "Requirement",
      iterationId: ITERATION_TARGET,
    });
    const fork = store.commitTree(
      [],
      makeManifest({
        id: "operation_a_1",
        sequence: 1,
        baseline: digest("a"),
        committedAt: T0,
        artifacts: { [requirement.path]: requirement.content },
      }).files,
    );
    const driftNode = graphNodeFixture({
      id: "test_1",
      type: "Test",
      iterationId: ITERATION_DRIFT,
    });
    const driftEdge = edgeFixture({
      id: "edge_verify_1",
      type: "VERIFIES",
      sourceId: "test_1",
      targetId: "requirement_1",
      iterationId: ITERATION_DRIFT,
    });
    const targetTip = store.commitTree(
      [fork],
      makeManifest({
        id: "operation_a_2",
        sequence: 2,
        baseline: fork,
        committedAt: T1,
        artifacts: { [driftNode.path]: driftNode.content },
        edges: [driftEdge],
      }).files,
    );
    store.moveRef(TARGET_REF, targetTip);

    const staleProposed = generateImpactSet([{ ...IMPACT_SEED }], [requirement.node], [], {
      iterationId: ITERATION_BRANCH,
      actor: "fixture",
      timestamp: T0,
    });
    const staleFrozen = freezeImpactSet(staleProposed, digest("d"));
    const firstTip = store.commitTree(
      [fork],
      makeManifest({
        id: "operation_b_1",
        sequence: 2,
        baseline: fork,
        committedAt: T2,
        artifacts: impactSetFiles(staleProposed, staleFrozen),
      }).files,
    );
    const currentProposed = generateImpactSet(
      [{ ...IMPACT_SEED }],
      [requirement.node, driftNode.node],
      [driftEdge],
      { iterationId: ITERATION_BRANCH, actor: "fixture", timestamp: T2 },
    );
    const currentFrozen = freezeImpactSet(currentProposed, digest("e"));
    const currentContent = readImpactSetContent(currentFrozen);
    const plan = planNodeFixture({
      id: `plan_${contentDigest({ set: currentFrozen.id }).slice(0, 16)}`,
      impactSetId: currentFrozen.id,
      impactSetDigest: currentContent.content_digest,
    });
    const request = approvalRequestArtifact({
      id: "request_impact_2",
      objectId: currentFrozen.id,
      objectType: "ImpactSet",
      objectDigest: currentContent.content_digest,
      baselineDigest: digest("b"),
      impactPath: [],
    });
    const operationTip = store.commitTree(
      [firstTip],
      makeManifest({
        id: "operation_b_2",
        sequence: 3,
        baseline: fork,
        committedAt: "2026-08-29T00:03:00.000Z",
        artifacts: mergeFiles(
          impactSetFiles(currentProposed, currentFrozen),
          baselineDocumentFile(digest("b")),
          { [plan.path]: plan.content },
          request,
        ),
      }).files,
    );
    store.moveRef(operationRefFor("operation_b"), operationTip);
    const harness = createHarness(store);
    await connect(harness);

    const outcome = await harness.coordinator.execute(
      prepareCommand("operation_b"),
      session("principal_alice"),
    );

    expect(outcome.status).toBe("prepared");
  });

  it("blocks mandatory gate evidence whose bound artifact is missing from the candidate tree", async () => {
    const store = createIntegrationFakeStore();
    const fork = store.commitTree(
      [],
      mergeFiles(
        makeManifest({ id: "operation_a_1", sequence: 1, baseline: digest("a"), committedAt: T0 })
          .files,
        { "src/a.txt": "A\n" },
      ),
    );
    store.moveRef(TARGET_REF, fork);
    const evidence = gateEvidenceArtifact({
      id: "evidence_orphan_1",
      mandatory: true,
      passed: true,
      codeDigests: [codeDigestOf({ "src/a.txt": "A\n" })],
      // The digest this evidence binds is not any artifact the candidate
      // ledger vouches for: the merge can never resurrect it.
      artifactDigests: [digest("7")],
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
    expect(outcome.failure.summary).toContain("artifact");
  });

  it("rejects an approval request whose bound object is missing from the candidate tree", async () => {
    const store = createIntegrationFakeStore();
    const fork = store.commitTree(
      [],
      makeManifest({ id: "operation_a_1", sequence: 1, baseline: digest("a"), committedAt: T0 })
        .files,
    );
    store.moveRef(TARGET_REF, fork);
    const request = approvalRequestArtifact({
      id: "request_orphan_1",
      objectDigest: digest("o"),
      baselineDigest: digest("b"),
    });
    const operationTip = store.commitTree(
      [fork],
      makeManifest({
        id: "operation_b_1",
        sequence: 2,
        baseline: fork,
        committedAt: T2,
        artifacts: mergeFiles(request, baselineDocumentFile(digest("b"))),
      }).files,
    );
    store.moveRef(operationRefFor("operation_b"), operationTip);
    const harness = createHarness(store);
    await connect(harness);

    const outcome = failed(
      await harness.coordinator.execute(prepareCommand("operation_b"), session("principal_alice")),
    );

    expect(outcome.failure.code).toBe("approval_binding_mismatch");
    expect(outcome.failure.summary).toContain("object_digest");
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

    // The accepted candidate's final transaction carries the deterministic
    // IntegrationAccepted event (design §20), verifiable by ledger replay of
    // the candidate bytes.
    const replay = replayLedger(harnessRootFor(store.lastCandidateRoot as string));
    const acceptedEvents = replay.events.filter(
      (event) => event.event_type === "IntegrationAccepted",
    );
    expect(acceptedEvents).toHaveLength(1);
    expect(acceptedEvents[0]).toMatchObject({
      protocol_version: "1.2.0",
      project_id: "project_demo",
      ledger_operation_id: expect.stringMatching(/^ledger-integration_/u),
      sequence: 1,
      timestamp: T2,
      payload: {
        integration_id: record.integration_id,
        operation_id: operationId,
        record_digest: record.record_digest,
      },
    });

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
