import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createGitControlStoreAdapter } from "@universal-harness-internal/adapter-vcs-git";
import {
  buildManifest,
  canonicalizeJson,
  edgeShardRelativePath,
  eventShardRelativePath,
  sha256Hex,
  shardMonthFor,
  type LedgerOperation,
} from "@universal-harness-internal/core";
import { afterEach, describe, expect, it } from "vitest";

import { COLLABORATION_CONTROL_REF } from "../../src/collaboration/connection.js";
import {
  createCollaborationCoordinator,
  resumeCollaborationCoordinator,
  type CollaborationCoordinatorDependencies,
} from "../../src/collaboration/coordinator.js";
import type { CollaborationSession, PlatformIdentityPort } from "../../src/collaboration/port.js";
import { SqliteCoordinatorProjection } from "../../src/collaboration/sqlite-projection.js";

/**
 * Integration coverage for the Coordinator running against the real Git
 * control store Adapter: a bare remote, the Adapter's private mirror and the
 * real SQLite projection. Only the platform identity seam is faked. This is
 * where the read contract (latest connection located through the remembered
 * target ref) and the fencing/baseline hardening are proven end to end.
 */

const NOW = "2026-08-29T00:00:00.000Z";
const PROJECT_ID = "project_demo";
const TARGET_REF = "refs/heads/main";

const digest = (letter: string): string => letter.repeat(64);

const session: CollaborationSession = {
  principal_id: "principal_alice",
  client_instance_id: "instance_test",
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
        subject_id: "1234567",
        repository_id: input.repository_id,
        permission: "maintain" as const,
        observed_at: NOW,
        expires_at: "2027-01-01T00:00:00.000Z",
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

/** A full clone of the remote for replica-side operations. */
function cloneRemote(remote: string): string {
  const parent = tempDir("harness-coordinator-clone-");
  const clone = join(parent, "clone");
  git(parent, "clone", remote, clone);
  git(clone, "config", "user.name", "Harness Test");
  git(clone, "config", "user.email", "harness-test@example.invalid");
  git(clone, "config", "commit.gpgsign", "false");
  return clone;
}

/**
 * Commit a candidate on top of the remote's main and stage it the way the
 * CLI does: the commit is pushed to the untrusted staging ref
 * `refs/heads/harness/candidate/<operationId>` that publish fetches by name.
 */
function pushCandidate(remote: string, file: string, operationId = "op_1"): string {
  const clone = cloneRemote(remote);
  writeFileSync(join(clone, file), `candidate ${file}\n`);
  git(clone, "add", file);
  git(clone, "commit", "-m", `candidate ${file}`);
  const candidate = git(clone, "rev-parse", "HEAD").trim();
  git(clone, "push", "origin", `HEAD:refs/heads/harness/candidate/${operationId}`);
  return candidate;
}

/** One fixture LedgerOperation manifest plus every ledger byte it references. */
function ledgerOpFiles(input: {
  id: string;
  sequence: number;
  baseline: string;
}): Record<string, string> {
  const month = shardMonthFor(NOW);
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
    committed_at: NOW,
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

/**
 * Commit `files` on top of `parentRef` in a fresh clone and push the
 * untrusted staging ref the Coordinator's publish fetches.
 */
function stageLedgerCandidate(
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

function createStack(projectionPath = ":memory:") {
  const remote = tempDir("harness-coordinator-remote-");
  git(remote, "init", "--bare", "-b", "main");
  const seed = tempDir("harness-coordinator-seed-");
  git(seed, "init", "-b", "main");
  git(seed, "config", "user.name", "Harness Test");
  git(seed, "config", "user.email", "harness-test@example.invalid");
  git(seed, "config", "commit.gpgsign", "false");
  writeFileSync(join(seed, "README.md"), "initial\n");
  git(seed, "add", "README.md");
  git(seed, "commit", "-m", "initial commit");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "origin", "main");

  const controlStore = createGitControlStoreAdapter({
    remote,
    mirror_root: join(tempDir("harness-coordinator-mirror-"), "mirror"),
  });
  const projection = new SqliteCoordinatorProjection(projectionPath);
  const deps: CollaborationCoordinatorDependencies = {
    platform,
    controlStore,
    projection,
    now: () => NOW,
  };
  return {
    remote,
    controlStore,
    projection,
    deps,
    coordinator: createCollaborationCoordinator(deps),
  };
}

async function connectAndAcquire(coordinator: ReturnType<typeof createCollaborationCoordinator>) {
  const connected = await coordinator.execute(
    {
      kind: "connect",
      command_id: "command_connect_1",
      project_id: PROJECT_ID,
      canonical_remote: "https://github.com/acme/demo.git",
      target_ref: TARGET_REF,
      coordinator_origin: "https://harness.example.com",
      policy_digest: digest("c"),
    },
    session,
  );
  expect(connected).toMatchObject({ status: "connected", replayed: false });

  const acquired = await coordinator.execute(
    {
      kind: "acquire_operation_lease",
      command_id: "command_acquire_1",
      project_id: PROJECT_ID,
      operation_id: "op_1",
    },
    session,
  );
  expect(acquired).toMatchObject({
    status: "lease",
    lease: { state: "granted", fencing_token: 1, resource_id: "op_1" },
  });
  if (acquired.status !== "lease") throw new Error("expected lease outcome");
  return acquired.lease;
}

describe("coordinator against the real git control store", () => {
  it(
    "connects, leases and publishes end to end, resolving the connection without a target ref",
    { timeout: 60_000 },
    async () => {
      const { remote, controlStore, projection, coordinator } = createStack();
      const lease = await connectAndAcquire(coordinator);

      // The read contract fix: reads without an explicit target ref resolve
      // the latest connection through the mirror-remembered target ref.
      const read = await controlStore.readControl({
        project_id: PROJECT_ID,
        control_ref: COLLABORATION_CONTROL_REF,
      });
      expect(read.status).toBe("ok");
      if (read.status !== "ok") return;
      expect(read.snapshot.latest_connection).toMatchObject({
        status: "active",
        target_ref: TARGET_REF,
      });
      expect(read.snapshot.control_records).toHaveLength(2);

      // A cold mirror that never saw a connect fails closed: no connection.
      const cold = createGitControlStoreAdapter({
        remote,
        mirror_root: join(tempDir("harness-coordinator-cold-"), "mirror"),
      });
      const coldRead = await cold.readControl({
        project_id: PROJECT_ID,
        control_ref: COLLABORATION_CONTROL_REF,
      });
      expect(coldRead.status).toBe("ok");
      if (coldRead.status !== "ok") return;
      expect(coldRead.snapshot.latest_connection).toBeUndefined();

      // The projection hint path serves the same connection view.
      const view = await coordinator.query(
        { kind: "connection_status", project_id: PROJECT_ID },
        session,
      );
      expect(view).toMatchObject({ kind: "connection_status", status: "active" });

      // A stale fencing token is fenced before any operation ref CAS.
      const candidate = pushCandidate(remote, "work.txt");
      const stale = await coordinator.execute(
        {
          kind: "publish_operation_candidate",
          command_id: "command_publish_stale",
          project_id: PROJECT_ID,
          operation_id: "op_1",
          candidate_commit: candidate,
          fencing_token: lease.fencing_token + 1,
        },
        session,
      );
      expect(stale).toMatchObject({
        status: "failed",
        failure: { code: "lease_fenced", retryable: false },
      });
      expect(() => git(remote, "rev-parse", "--verify", "refs/heads/operation/op_1")).toThrow();

      // The live token publishes the first head, anchored to the target
      // baseline the connect remembered.
      const published = await coordinator.execute(
        {
          kind: "publish_operation_candidate",
          command_id: "command_publish_1",
          project_id: PROJECT_ID,
          operation_id: "op_1",
          candidate_commit: candidate,
          fencing_token: lease.fencing_token,
        },
        session,
      );
      expect(published).toMatchObject({
        status: "published",
        operation_id: "op_1",
        head_oid: candidate,
        replayed: false,
      });
      expect(git(remote, "rev-parse", "refs/heads/operation/op_1").trim()).toBe(candidate);

      projection.close();
    },
  );

  it(
    "startup resume revokes the live lease and fences its token",
    { timeout: 60_000 },
    async () => {
      const { remote, controlStore, projection, deps, coordinator } = createStack();
      const lease = await connectAndAcquire(coordinator);

      const startup = await resumeCollaborationCoordinator(deps, PROJECT_ID);
      expect(startup).toEqual({ status: "ready" });

      // The revocation is authoritative on the remote Control Ref.
      const read = await controlStore.readControl({
        project_id: PROJECT_ID,
        control_ref: COLLABORATION_CONTROL_REF,
      });
      expect(read.status).toBe("ok");
      if (read.status !== "ok") return;
      const leases = read.snapshot.control_records.filter(
        (record) => record.record_kind === "lease",
      );
      expect(leases).toHaveLength(2);
      expect(leases[1]).toMatchObject({
        state: "revoked",
        lease_id: lease.lease_id,
        fencing_token: 1,
      });

      // The revoked token no longer publishes.
      const candidate = pushCandidate(remote, "revoked.txt");
      const fenced = await coordinator.execute(
        {
          kind: "publish_operation_candidate",
          command_id: "command_publish_revoked",
          project_id: PROJECT_ID,
          operation_id: "op_1",
          candidate_commit: candidate,
          fencing_token: lease.fencing_token,
        },
        session,
      );
      expect(fenced).toMatchObject({
        status: "failed",
        failure: { code: "lease_fenced", retryable: false },
      });
      expect(() => git(remote, "rev-parse", "--verify", "refs/heads/operation/op_1")).toThrow();

      // A repeated resume is a no-op beyond the rebuild.
      const again = await resumeCollaborationCoordinator(deps, PROJECT_ID);
      expect(again).toEqual({ status: "ready" });
      const reread = await controlStore.readControl({
        project_id: PROJECT_ID,
        control_ref: COLLABORATION_CONTROL_REF,
      });
      expect(reread.status).toBe("ok");
      if (reread.status !== "ok") return;
      expect(
        reread.snapshot.control_records.filter((record) => record.record_kind === "lease"),
      ).toHaveLength(2);

      projection.close();
    },
  );

  it(
    "restores the accepted integration records on a delete/rebuild so the projection digest does not drift",
    { timeout: 60_000 },
    async () => {
      const projectionPath = join(tempDir("harness-coordinator-db-"), "coordinator.sqlite");
      const { remote, projection, deps, coordinator } = createStack(projectionPath);
      const lease = await connectAndAcquire(coordinator);

      // Seed the target Ledger, then publish an operation branch carrying the
      // next Ledger operation.
      const baselineSeed = git(remote, "rev-parse", "main").trim();
      const seeding = cloneRemote(remote);
      writeFiles(
        seeding,
        ledgerOpFiles({ id: "operation_base_1", sequence: 1, baseline: baselineSeed }),
      );
      git(seeding, "add", "-A");
      git(seeding, "commit", "-m", "baseline ledger");
      git(seeding, "push", "origin", "main");
      const forkPoint = git(remote, "rev-parse", "main").trim();
      const candidate = stageLedgerCandidate(
        remote,
        forkPoint,
        "op_1",
        ledgerOpFiles({ id: "operation_1_2", sequence: 2, baseline: baselineSeed }),
      );
      const published = await coordinator.execute(
        {
          kind: "publish_operation_candidate",
          command_id: "command_publish_1",
          project_id: PROJECT_ID,
          operation_id: "op_1",
          candidate_commit: candidate,
          fencing_token: lease.fencing_token,
        },
        session,
      );
      expect(published).toMatchObject({ status: "published", head_oid: candidate });

      // Release the operation lease so the resume below has nothing to revoke
      // and the rebuilt chain is byte-identical to the live one.
      const released = await coordinator.execute(
        {
          kind: "release_operation_lease",
          command_id: "command_release_1",
          project_id: PROJECT_ID,
          lease_id: lease.lease_id,
        },
        session,
      );
      expect(released).toMatchObject({ status: "lease", lease: { state: "released" } });

      const prepared = await coordinator.execute(
        {
          kind: "prepare_integration",
          command_id: "command_prepare_1",
          project_id: PROJECT_ID,
          operation_id: "op_1",
        },
        session,
      );
      expect(prepared.status).toBe("prepared");
      if (prepared.status !== "prepared") throw new Error("unreachable");
      const accepted = await coordinator.execute(
        {
          kind: "accept_integration",
          command_id: "command_accept_1",
          project_id: PROJECT_ID,
          integration_id: prepared.integration_record.integration_id,
          expected_target_commit: prepared.integration_record.expected_target_commit,
        },
        session,
      );
      expect(accepted).toMatchObject({ status: "accepted", replayed: false });
      if (accepted.status !== "accepted") throw new Error("unreachable");

      const digestBeforeDelete = projection.projectionDigest();
      const conflictsBeforeDelete = await projection.query({
        kind: "integration_conflicts",
        project_id: PROJECT_ID,
      });
      expect(conflictsBeforeDelete).toMatchObject({
        conflicts: [{ integration_id: accepted.integration_record.integration_id }],
      });

      // Delete the projection and resume into a fresh one: the Integration
      // Records must be recovered from Git (the accepted record lives on the
      // Target tree), or the digest drifts — the dogfood regression.
      projection.close();
      rmSync(projectionPath);
      const rebuiltProjection = new SqliteCoordinatorProjection(projectionPath);
      const resumed = await resumeCollaborationCoordinator(
        { ...deps, projection: rebuiltProjection },
        PROJECT_ID,
      );
      expect(resumed).toEqual({ status: "ready" });
      expect(rebuiltProjection.projectionDigest()).toBe(digestBeforeDelete);
      expect(
        await rebuiltProjection.query({ kind: "integration_conflicts", project_id: PROJECT_ID }),
      ).toEqual(conflictsBeforeDelete);
      rebuiltProjection.close();
    },
  );
});
