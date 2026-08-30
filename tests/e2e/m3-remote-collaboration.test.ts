import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGitControlStoreAdapter } from "../../adapters/vcs-git/src/index.js";
import {
  buildManifest,
  canonicalizeJson,
  edgeShardRelativePath,
  eventShardRelativePath,
  harnessRootFor,
  LedgerRepository,
  replayLedger,
  sha256Hex,
  shardMonthFor,
  type LedgerOperation,
} from "../../packages/core/src/index.js";
import {
  ApprovalService,
  createCollaborationCoordinator,
  materializeRemoteApprovalDecision,
  resumeCollaborationCoordinator,
  resumeWorkflowOperation,
  SqliteCoordinatorProjection,
  WorkflowEngine,
  type ApprovalDependencies,
  type CollaborationCoordinatorDependencies,
  type CollaborationSession,
  type PlatformIdentityPort,
} from "../../packages/runtime/src/index.js";
import {
  BASELINE,
  cleanupDirectories,
  FIXED_NOW,
  makeDeps,
  makeProjectRoot,
  makeStartInput,
  phaseIds,
} from "../../packages/runtime/test/workflow/helpers.js";

/**
 * Plan M3 Task 9 step 2: the full double-Clone loop over a local bare remote
 * with the production Git control store, the production SQLite projection and
 * a deterministic fake platform identity Adapter (spec §21.3):
 *
 *   connect → two Operation Leases → parallel candidate work → fenced
 *   candidate publish → remote Approval → delayed materialization
 *   → integrate A → re-sequence B → integrate B → Target CAS → disconnect
 *   → rebuild SQLite from Git
 *
 * Both operations must stay reachable, the Target Ledger must replay
 * contiguously, stale fencing tokens must fail and no model or Agent
 * statement is ever used as Evidence — every fact asserted here is a Git or
 * typed-record fact.
 */

const OBSERVED_AT = "2026-08-29T00:00:00.000Z";
const DECIDED_AT = "2026-08-29T00:01:00.000Z";
const EXPIRES_AT = "2026-08-29T00:05:00.000Z";
const WELL_PAST_EXPIRY = "2026-08-29T00:30:00.000Z";
const T_A = "2026-08-29T00:02:00.000Z";
const T_B = "2026-08-29T00:03:00.000Z";
const PROJECT_ID = "project_demo";
const TARGET_REF = "refs/heads/main";

const digest = (letter: string): string => letter.repeat(64);
const POLICY_DIGEST = digest("c");

const alice: CollaborationSession = {
  principal_id: "principal_alice",
  client_instance_id: "instance_e2e_alice",
};
const bob: CollaborationSession = {
  principal_id: "principal_bob",
  client_instance_id: "instance_e2e_bob",
};

const platform: PlatformIdentityPort = {
  discover: (remote) =>
    Promise.resolve({
      status: "resolved" as const,
      identity: {
        provider: "github" as const,
        host: "github.com",
        repository_id: "acme/demo",
        canonical_remote: remote,
        canonical_remote_digest: digest("b"),
      },
    }),
  authenticate: (input) =>
    Promise.resolve({
      status: "authenticated" as const,
      snapshot: {
        principal_id: input.principal_id,
        provider: "github" as const,
        host: "github.com",
        subject_id: input.principal_id === "principal_bob" ? "7654321" : "1234567",
        repository_id: input.repository_id,
        permission: "maintain" as const,
        observed_at: OBSERVED_AT,
        expires_at: EXPIRES_AT,
        source_response_digest: digest("a"),
      },
    }),
  inspectControlRefProtection: () => Promise.resolve({ status: "protected" as const }),
};

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
  cleanupDirectories();
});

function tempDir(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  directories.push(directory);
  return directory;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "gc.auto=0", ...args], {
    cwd,
    encoding: "utf8",
  });
}

/** One fixture manifest plus every ledger byte it references. */
function ledgerOpFiles(input: {
  id: string;
  sequence: number;
  baseline: string;
  committedAt: string;
}): Record<string, string> {
  const month = shardMonthFor(input.committedAt);
  const manifest: LedgerOperation = buildManifest({
    ledger_operation_id: input.id,
    workflow_operation_id: `workflow_${input.id}`,
    attempt_id: `attempt_${input.id}`,
    baseline_commit: input.baseline,
    sequence: input.sequence,
    artifact_digests: [],
    edge_file: edgeShardRelativePath(month, input.id),
    event_file: eventShardRelativePath(month, input.id),
    edge_file_digest: sha256Hex(""),
    event_file_digest: sha256Hex(""),
    committed_at: input.committedAt,
  });
  return {
    [`.harness/ledger/operations/${input.id}.json`]: `${canonicalizeJson(manifest)}\n`,
    [`.harness/${manifest.edge_file}`]: "",
    [`.harness/${manifest.event_file}`]: "",
  };
}

function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split("/"));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}

/** A full clone of the remote for replica-side candidate work. */
function cloneRemote(remote: string): string {
  const parent = tempDir("harness-m3-e2e-clone-");
  const clone = join(parent, "clone");
  git(parent, "clone", remote, clone);
  git(clone, "config", "user.name", "Harness Test");
  git(clone, "config", "user.email", "harness-test@example.invalid");
  git(clone, "config", "commit.gpgsign", "false");
  return clone;
}

/**
 * Replica-side candidate work: commit `files` on top of `parentRef` in a fresh
 * clone and push the untrusted staging ref the Coordinator's publish fetches.
 */
function stageCandidate(
  remote: string,
  parentRef: string,
  operationId: string,
  files: Readonly<Record<string, string>>,
): string {
  const clone = cloneRemote(remote);
  git(clone, "checkout", "-b", `work-${operationId}`, parentRef);
  writeFiles(clone, files);
  git(clone, "add", "-A");
  git(clone, "commit", "-m", `candidate ${operationId}`);
  const head = git(clone, "rev-parse", "HEAD").trim();
  git(clone, "push", "origin", `HEAD:refs/heads/harness/candidate/${operationId}`);
  return head;
}

/** Seed the bare remote with a README and one committed LedgerOperation. */
function seedRemote(): { remote: string; baseline: string } {
  const remote = tempDir("harness-m3-e2e-remote-");
  git(remote, "init", "--bare", "-b", "main");
  const seed = tempDir("harness-m3-e2e-seed-");
  git(seed, "init", "-b", "main");
  git(seed, "config", "user.name", "Harness Test");
  git(seed, "config", "user.email", "harness-test@example.invalid");
  git(seed, "config", "commit.gpgsign", "false");
  writeFileSync(join(seed, "README.md"), "initial\n");
  writeFiles(
    seed,
    ledgerOpFiles({
      id: "operation_base_1",
      sequence: 1,
      baseline: digest("0"),
      committedAt: OBSERVED_AT,
    }),
  );
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "baseline ledger");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "origin", "main");
  return { remote, baseline: git(seed, "rev-parse", "HEAD").trim() };
}

interface Stack {
  readonly remote: string;
  readonly projectionPath: string;
  readonly projection: SqliteCoordinatorProjection;
  readonly deps: CollaborationCoordinatorDependencies;
  readonly coordinator: ReturnType<typeof createCollaborationCoordinator>;
  /** Advance the controllable clock (ISO 8601 UTC). */
  setNow(now: string): void;
}

function createStack(remote: string, projectionPath: string): Stack {
  const controlStore = createGitControlStoreAdapter({
    remote,
    mirror_root: join(tempDir("harness-m3-e2e-mirror-"), "mirror"),
  });
  const projection = new SqliteCoordinatorProjection(projectionPath);
  let currentTime = DECIDED_AT;
  const deps: CollaborationCoordinatorDependencies = {
    platform,
    controlStore,
    projection,
    now: () => currentTime,
  };
  return {
    remote,
    projectionPath,
    projection,
    deps,
    coordinator: createCollaborationCoordinator(deps),
    setNow(now: string) {
      currentTime = now;
    },
  };
}

async function connectAlice(stack: Stack): Promise<void> {
  const connected = await stack.coordinator.execute(
    {
      kind: "connect",
      command_id: "command_connect_1",
      project_id: PROJECT_ID,
      canonical_remote: "https://github.com/acme/demo",
      target_ref: TARGET_REF,
      coordinator_origin: "https://harness.example.com",
      policy_digest: POLICY_DIGEST,
    },
    alice,
  );
  expect(connected).toMatchObject({ status: "connected", replayed: false });
}

async function acquireLease(
  stack: Stack,
  commandId: string,
  operationId: string,
): Promise<{ lease_id: string; fencing_token: number }> {
  const outcome = await stack.coordinator.execute(
    {
      kind: "acquire_operation_lease",
      command_id: commandId,
      project_id: PROJECT_ID,
      operation_id: operationId,
    },
    alice,
  );
  expect(outcome).toMatchObject({ status: "lease", lease: { state: "granted" } });
  if (outcome.status !== "lease") throw new Error("expected lease outcome");
  return { lease_id: outcome.lease.lease_id, fencing_token: outcome.lease.fencing_token };
}

async function publish(
  stack: Stack,
  commandId: string,
  operationId: string,
  candidate: string,
  fencingToken: number,
) {
  return stack.coordinator.execute(
    {
      kind: "publish_operation_candidate",
      command_id: commandId,
      project_id: PROJECT_ID,
      operation_id: operationId,
      candidate_commit: candidate,
      fencing_token: fencingToken,
    },
    alice,
  );
}

function approvalDeps(projectRoot: string, tag: string, now: () => string): ApprovalDependencies {
  return {
    projectRoot,
    readBaseline: () => BASELINE,
    now,
    newId: phaseIds(tag),
  };
}

/**
 * Boot a local Replica project whose workflow pauses on a real committed
 * ApprovalRequest carried by the local Ledger (the Local Kernel side of the
 * remote approval loop).
 */
async function bootRemoteRequest(projectRoot: string) {
  const engine = new WorkflowEngine(makeDeps(projectRoot, { newId: phaseIds("e2eop") }));
  const started = await engine.startOperation(makeStartInput());
  const workflowOperationId = started.operation.workflow_operation_id;
  await engine.advance(workflowOperationId, "awaiting_approval");
  const service = new ApprovalService(approvalDeps(projectRoot, "e2ebt", () => FIXED_NOW));
  const outcome = await service.requestApproval({
    workflowOperationId,
    objectId: "requirement_baseline",
    objectType: "RequirementBaseline",
    objectDigest: digest("a"),
    baselineDigest: digest("b"),
    policyDigest: POLICY_DIGEST,
    impactPath: ["intent_e2e"],
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
    makeDeps(projectRoot, { newId: phaseIds("e2ere") }),
    workflowOperationId,
  );
  const request = service.getRequest(workflowOperationId, outcome.request_id);
  if (request === undefined) throw new Error("expected committed request");
  return { workflowOperationId, request };
}

describe("m3 remote collaboration double-clone loop", () => {
  it(
    "runs connect, parallel leases, fenced publish, remote approval, re-sequenced integration, disconnect and rebuild over real git",
    { timeout: 240_000 },
    async () => {
      // Replica-local project with a committed ApprovalRequest (Local Kernel).
      const projectRoot = makeProjectRoot();
      const { request } = await bootRemoteRequest(projectRoot);

      const { remote, baseline } = seedRemote();
      const projectionPath = join(tempDir("harness-m3-e2e-db-"), "coordinator.sqlite");
      const stack = createStack(remote, projectionPath);
      const depsWithRequests: CollaborationCoordinatorDependencies = {
        ...stack.deps,
        readApprovalRequest: (input) =>
          Promise.resolve(input.request_id === request.request_id ? request : undefined),
      };
      const coordinator = createCollaborationCoordinator(depsWithRequests);
      const requestedStack = { ...stack, coordinator };

      // connect: the connection record lands on the Target Ledger.
      await connectAlice(requestedStack);

      // Two replicas hold leases for different operations in parallel.
      const leaseA = await acquireLease(requestedStack, "command_lease_a", "op_a");
      const leaseB = await acquireLease(requestedStack, "command_lease_b", "op_b");
      expect(leaseA.fencing_token).toBe(1);
      expect(leaseB.fencing_token).toBe(1);

      // Parallel candidate work: both branches fork the same Target at
      // Ledger sequence 2.
      const forkPoint = git(remote, "rev-parse", "main").trim();
      const candidateA = stageCandidate(
        remote,
        forkPoint,
        "op_a",
        ledgerOpFiles({ id: "operation_a_2", sequence: 2, baseline, committedAt: T_A }),
      );
      const candidateB = stageCandidate(
        remote,
        forkPoint,
        "op_b",
        ledgerOpFiles({ id: "operation_b_2", sequence: 2, baseline, committedAt: T_B }),
      );

      // A stale fencing token is fenced before any Operation Ref CAS.
      const fenced = await publish(
        requestedStack,
        "command_publish_fenced",
        "op_a",
        candidateA,
        99,
      );
      expect(fenced).toMatchObject({
        status: "failed",
        failure: { code: "lease_fenced", retryable: false },
      });
      expect(() => git(remote, "rev-parse", "--verify", "refs/heads/operation/op_a")).toThrow();

      // The live tokens publish both candidates.
      const publishedA = await publish(
        requestedStack,
        "command_publish_a",
        "op_a",
        candidateA,
        leaseA.fencing_token,
      );
      expect(publishedA).toMatchObject({ status: "published", head_oid: candidateA });
      const publishedB = await publish(
        requestedStack,
        "command_publish_b",
        "op_b",
        candidateB,
        leaseB.fencing_token,
      );
      expect(publishedB).toMatchObject({ status: "published", head_oid: candidateB });

      // Remote approval: an authorized non-requester approves; the decision
      // lands on the protected Control Ref and shows in the inbox.
      const approval = await coordinator.execute(
        {
          kind: "submit_remote_approval",
          command_id: "command_decision_e2e",
          project_id: PROJECT_ID,
          request_id: request.request_id,
          decision: "approve",
        },
        bob,
      );
      expect(approval).toMatchObject({ status: "remote_approval", replayed: false });
      const inbox = await coordinator.query(
        { kind: "approval_inbox", project_id: PROJECT_ID },
        alice,
      );
      expect(inbox).toMatchObject({
        kind: "approval_inbox",
        decisions: [{ request_id: request.request_id, decision: "approve" }],
      });

      // Delayed materialization: the wall clock is far beyond the snapshot
      // validity, but the snapshot was valid at decided_at and the bindings
      // are unchanged, so no repeated human approval is needed.
      const materializing = new ApprovalService(
        approvalDeps(projectRoot, "e2emat", () => WELL_PAST_EXPIRY),
      );
      const controlStore = stack.deps.controlStore;
      const materialized = await materializeRemoteApprovalDecision({
        service: materializing,
        controlStore,
        project_id: PROJECT_ID,
        request_id: request.request_id,
        target_ref: TARGET_REF,
      });
      expect(materialized).toMatchObject({ status: "materialized", replayed: false });
      if (materialized.status !== "materialized") throw new Error("expected materialized");
      expect(materialized.decision.decided_at).toBe(DECIDED_AT);
      const replayedMaterialization = await materializeRemoteApprovalDecision({
        service: materializing,
        controlStore,
        project_id: PROJECT_ID,
        request_id: request.request_id,
        target_ref: TARGET_REF,
      });
      expect(replayedMaterialization).toMatchObject({ status: "materialized", replayed: true });
      const localReplay = new LedgerRepository({
        projectRoot,
        readBaseline: () => BASELINE,
      }).replay();
      expect(
        localReplay.events.filter((event) => event.event_type === "RemoteApprovalMaterialized"),
      ).toHaveLength(1);

      // Integrate A: no fork yet, so the manifest keeps sequence 2.
      const prepareA = await coordinator.execute(
        {
          kind: "prepare_integration",
          command_id: "command_prepare_a",
          project_id: PROJECT_ID,
          operation_id: "op_a",
        },
        alice,
      );
      expect(prepareA.status).toBe("prepared");
      if (prepareA.status !== "prepared") throw new Error("unreachable");
      expect(prepareA.integration_record.ledger_sequence_rewrites).toEqual([]);
      const acceptA = await coordinator.execute(
        {
          kind: "accept_integration",
          command_id: "command_accept_a",
          project_id: PROJECT_ID,
          integration_id: prepareA.integration_record.integration_id,
          expected_target_commit: prepareA.integration_record.expected_target_commit,
        },
        alice,
      );
      expect(acceptA).toMatchObject({ status: "accepted", replayed: false });
      const integratedA = git(remote, "rev-parse", "main").trim();

      // Re-sequence B: its forked sequence 2 becomes 4 inside the candidate.
      const prepareB = await coordinator.execute(
        {
          kind: "prepare_integration",
          command_id: "command_prepare_b",
          project_id: PROJECT_ID,
          operation_id: "op_b",
        },
        alice,
      );
      expect(prepareB.status).toBe("prepared");
      if (prepareB.status !== "prepared") throw new Error("unreachable");
      expect(prepareB.integration_record.expected_target_commit).toBe(integratedA);
      expect(prepareB.integration_record.ledger_sequence_rewrites).toMatchObject([
        { ledger_operation_id: "operation_b_2", old_sequence: 2, new_sequence: 4 },
      ]);
      const acceptB = await coordinator.execute(
        {
          kind: "accept_integration",
          command_id: "command_accept_b",
          project_id: PROJECT_ID,
          integration_id: prepareB.integration_record.integration_id,
          expected_target_commit: prepareB.integration_record.expected_target_commit,
        },
        alice,
      );
      expect(acceptB).toMatchObject({ status: "accepted", replayed: false });

      // The accepted Target replays as a contiguous linear Ledger.
      const acceptedRoot = join(tempDir("harness-m3-e2e-accepted-"), "accepted");
      git(dirname(acceptedRoot), "clone", remote, acceptedRoot);
      const sequences = replayLedger(harnessRootFor(acceptedRoot)).operations.map(
        (operation) => operation.manifest.sequence,
      );
      expect(sequences).toEqual([1, 2, 3, 4, 5]);

      // Fencing: after release + re-acquire, the old token is dead.
      const releaseA = await coordinator.execute(
        {
          kind: "release_operation_lease",
          command_id: "command_release_a",
          project_id: PROJECT_ID,
          lease_id: leaseA.lease_id,
        },
        alice,
      );
      expect(releaseA).toMatchObject({ status: "lease", lease: { state: "released" } });
      const leaseA2 = await acquireLease(requestedStack, "command_lease_a2", "op_a");
      expect(leaseA2.fencing_token).toBe(2);
      const candidateA2 = stageCandidate(remote, "origin/operation/op_a", "op_a", {
        "followup.txt": "followup work\n",
      });
      const stalePublish = await publish(
        requestedStack,
        "command_publish_stale",
        "op_a",
        candidateA2,
        leaseA.fencing_token,
      );
      expect(stalePublish).toMatchObject({
        status: "failed",
        failure: { code: "lease_fenced", retryable: false },
      });
      const freshPublish = await publish(
        requestedStack,
        "command_publish_a2",
        "op_a",
        candidateA2,
        leaseA2.fencing_token,
      );
      expect(freshPublish).toMatchObject({ status: "published", head_oid: candidateA2 });

      // Release every lease, then disconnect.
      const releaseA2 = await coordinator.execute(
        {
          kind: "release_operation_lease",
          command_id: "command_release_a2",
          project_id: PROJECT_ID,
          lease_id: leaseA2.lease_id,
        },
        alice,
      );
      expect(releaseA2).toMatchObject({ status: "lease", lease: { state: "released" } });
      const releaseB = await coordinator.execute(
        {
          kind: "release_operation_lease",
          command_id: "command_release_b",
          project_id: PROJECT_ID,
          lease_id: leaseB.lease_id,
        },
        alice,
      );
      expect(releaseB).toMatchObject({ status: "lease", lease: { state: "released" } });
      // Every Lease is released; the controllable clock then advances past
      // their validity so no granted record is still live (disconnect refuses
      // while any unexpired granted record exists, released or not).
      requestedStack.setNow(WELL_PAST_EXPIRY);
      const disconnected = await coordinator.execute(
        { kind: "disconnect", command_id: "command_disconnect", project_id: PROJECT_ID },
        alice,
      );
      expect(disconnected).toMatchObject({ status: "disconnected" });

      // After disconnect no new Lease is issued, and the Control Ref history
      // plus candidate Operation Branches are retained.
      const lateLease = await coordinator.execute(
        {
          kind: "acquire_operation_lease",
          command_id: "command_lease_late",
          project_id: PROJECT_ID,
          operation_id: "op_c",
        },
        alice,
      );
      expect(lateLease.status).toBe("failed");
      expect(git(remote, "rev-parse", "refs/heads/operation/op_a").trim()).toBe(candidateA2);
      expect(git(remote, "rev-parse", "refs/heads/operation/op_b").trim()).toBe(candidateB);

      const beforeRebuild = await controlStore.readControl({
        project_id: PROJECT_ID,
        control_ref: "refs/heads/harness/control",
      });
      expect(beforeRebuild.status).toBe("ok");
      if (beforeRebuild.status !== "ok") throw new Error("unreachable");
      const recordCount = beforeRebuild.snapshot.control_records.length;
      expect(recordCount).toBeGreaterThan(0);

      // Rebuild SQLite from Git: the projection is disposable. Capture the
      // pre-delete views, delete the database and resume with a fresh one.
      const connectionBeforeDelete = await stack.projection.query({
        kind: "connection_status",
        project_id: PROJECT_ID,
      });
      const inboxBeforeDelete = await stack.projection.query({
        kind: "approval_inbox",
        project_id: PROJECT_ID,
      });
      stack.projection.close();
      rmSync(projectionPath);
      const rebuiltProjection = new SqliteCoordinatorProjection(projectionPath);
      const resumed = await resumeCollaborationCoordinator(
        { ...depsWithRequests, projection: rebuiltProjection },
        PROJECT_ID,
      );
      expect(resumed).toEqual({ status: "ready" });

      // Connection and approval views survive the rebuild byte-identically;
      // no old Lease is resurrected.
      expect(
        await rebuiltProjection.query({ kind: "connection_status", project_id: PROJECT_ID }),
      ).toEqual(connectionBeforeDelete);
      expect(
        await rebuiltProjection.query({ kind: "approval_inbox", project_id: PROJECT_ID }),
      ).toEqual(inboxBeforeDelete);
      const afterRebuild = await controlStore.readControl({
        project_id: PROJECT_ID,
        control_ref: "refs/heads/harness/control",
      });
      expect(afterRebuild.status).toBe("ok");
      if (afterRebuild.status !== "ok") throw new Error("unreachable");
      expect(afterRebuild.snapshot.control_records).toHaveLength(recordCount);
      // No old Lease is resurrected: folding the append-only chain per
      // resource, every Lease's latest record is terminal (released here).
      const leaseTips = new Map<string, string>();
      for (const record of afterRebuild.snapshot.control_records) {
        if (record.record_kind === "lease") {
          leaseTips.set(record.resource_id, record.state);
        }
      }
      expect([...leaseTips.values()].every((state) => state === "released")).toBe(true);

      // The accepted Integrations never depended on SQLite: both are still
      // readable from the authoritative Target history.
      if (acceptB.status !== "accepted") throw new Error("unreachable");
      const integrationB = await controlStore.readIntegrationRecord({
        project_id: PROJECT_ID,
        target_ref: TARGET_REF,
        integration_id: acceptB.integration_record.integration_id,
      });
      expect(integrationB.status).toBe("found");

      // The from-Git rebuild itself is deterministic: a second delete/rebuild
      // cycle produces the identical projection digest.
      const digestAfterRebuild = rebuiltProjection.projectionDigest();
      rebuiltProjection.close();
      rmSync(projectionPath);
      const rebuiltAgain = new SqliteCoordinatorProjection(projectionPath);
      const resumedAgain = await resumeCollaborationCoordinator(
        { ...depsWithRequests, projection: rebuiltAgain },
        PROJECT_ID,
      );
      expect(resumedAgain).toEqual({ status: "ready" });
      expect(rebuiltAgain.projectionDigest()).toBe(digestAfterRebuild);
      rebuiltAgain.close();
    },
  );

  it(
    "offline replicas keep working locally but cannot touch managed state",
    { timeout: 120_000 },
    async () => {
      const { remote } = seedRemote();
      const projectionPath = join(tempDir("harness-m3-e2e-offline-db-"), "coordinator.sqlite");
      const stack = createStack(remote, projectionPath);
      await connectAlice(stack);
      const lease = await acquireLease(stack, "command_lease_offline", "op_offline");
      const clone = cloneRemote(remote);

      // The network drops: the remote is unreachable.
      const hidden = `${remote}.offline`;
      renameSync(remote, hidden);

      // Managed writes fail closed and retryable; nothing changes.
      const leaseDuringOutage = await stack.coordinator.execute(
        {
          kind: "acquire_operation_lease",
          command_id: "command_lease_outage",
          project_id: PROJECT_ID,
          operation_id: "op_other",
        },
        alice,
      );
      expect(leaseDuringOutage.status).toBe("failed");
      if (leaseDuringOutage.status !== "failed") throw new Error("unreachable");
      expect(leaseDuringOutage.failure.retryable).toBe(true);

      const syncDuringOutage = await stack.coordinator.execute(
        { kind: "sync_now", command_id: "command_sync_outage", project_id: PROJECT_ID },
        alice,
      );
      expect(syncDuringOutage.status).toBe("failed");

      // Local preparation continues unaffected: the replica commits locally.
      writeFileSync(join(clone, "offline.txt"), "prepared while offline\n");
      git(clone, "add", "offline.txt");
      git(clone, "commit", "-m", "offline candidate work");
      const localHead = git(clone, "rev-parse", "HEAD").trim();
      expect(localHead).toMatch(/^[0-9a-f]{40}$/u);

      // The network returns: sync rebuilds the projection and the held Lease
      // still gates publish (fencing token 1 remains the live one).
      renameSync(hidden, remote);
      const synced = await stack.coordinator.execute(
        { kind: "sync_now", command_id: "command_sync_restored", project_id: PROJECT_ID },
        alice,
      );
      expect(synced).toMatchObject({ status: "synced", project_id: PROJECT_ID });
      expect(() =>
        git(remote, "rev-parse", "--verify", "refs/heads/operation/op_offline"),
      ).toThrow();

      git(clone, "push", "origin", "HEAD:refs/heads/harness/candidate/op_offline");
      const published = await publish(
        stack,
        "command_publish_offline",
        "op_offline",
        localHead,
        lease.fencing_token,
      );
      expect(published).toMatchObject({ status: "published", head_oid: localHead });

      stack.projection.close();
    },
  );
});
