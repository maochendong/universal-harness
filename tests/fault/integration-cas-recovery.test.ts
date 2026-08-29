import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGitControlStoreAdapter } from "../../adapters/vcs-git/src/index.js";
import {
  buildManifest,
  canonicalizeJson,
  edgeShardRelativePath,
  eventShardRelativePath,
  sha256Hex,
  shardMonthFor,
  type LedgerOperation,
} from "../../packages/core/src/index.js";
import {
  collaborationFailure,
  createCollaborationCoordinator,
  SqliteCoordinatorProjection,
  type CollaborationSession,
  type GitControlStorePort,
  type PlatformIdentityPort,
} from "../../packages/runtime/src/index.js";

/**
 * Integration accept crash recovery against the real Git control store
 * Adapter (design §14.4; plan M3 Task 6 Step 7): the Target compare-and-swap
 * lands but its response is lost, and the coordinator's immediate recovery
 * read fails too, so the accept reports a retryable `git_remote_unavailable`.
 * The retried accept must recover the accepted fact from the Target history —
 * never produce a second merge commit.
 */

const NOW = "2026-08-29T00:00:00.000Z";
const T_B = "2026-08-29T00:02:00.000Z";
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

/**
 * Delegating GitControlStorePort with two one-shot faults: the next Target
 * CAS executes for real but reports a lost response, and the immediately
 * following integration-record read (the coordinator's in-call recovery
 * probe) reports the same outage.
 */
function createLossyControlStore(inner: GitControlStorePort): {
  readonly port: GitControlStorePort;
  loseNextTargetCas: boolean;
} {
  const state = { loseNextTargetCas: false, failNextRecordRead: false };
  return {
    get loseNextTargetCas() {
      return state.loseNextTargetCas;
    },
    set loseNextTargetCas(value: boolean) {
      state.loseNextTargetCas = value;
    },
    port: {
      readControl: (input) => inner.readControl(input),
      appendControl: (input) => inner.appendControl(input),
      appendProjectRecord: (input) => inner.appendProjectRecord(input),
      listOperationHeads: (input) => inner.listOperationHeads(input),
      compareAndSwapOperation: (input) => inner.compareAndSwapOperation(input),
      prepareCandidate: (input) => inner.prepareCandidate(input),
      readCandidate: (input) => inner.readCandidate(input),
      async readIntegrationRecord(input) {
        if (state.failNextRecordRead) {
          state.failNextRecordRead = false;
          return {
            status: "failed" as const,
            failure: collaborationFailure(
              "git_remote_unavailable",
              "simulated outage reading the target history",
              true,
            ),
          };
        }
        return inner.readIntegrationRecord(input);
      },
      async compareAndSwapTarget(input) {
        const outcome = await inner.compareAndSwapTarget(input);
        if (outcome.status === "swapped" && state.loseNextTargetCas) {
          state.loseNextTargetCas = false;
          state.failNextRecordRead = true;
          return {
            status: "failed" as const,
            failure: collaborationFailure(
              "git_remote_unavailable",
              "the target compare-and-swap response was lost",
              true,
            ),
          };
        }
        return outcome;
      },
    },
  };
}

describe("integration accept crash recovery over real git", () => {
  it(
    "recovers a landed Target CAS with a lost response on retry, without a second merge",
    { timeout: 120_000 },
    async () => {
      const remote = tempDir("harness-cas-fault-remote-");
      git(remote, "init", "--bare", "-b", "main");
      const seed = tempDir("harness-cas-fault-seed-");
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
          committedAt: NOW,
        }),
      );
      git(seed, "add", "-A");
      git(seed, "commit", "-m", "baseline ledger");
      git(seed, "remote", "add", "origin", remote);
      git(seed, "push", "origin", "main");
      const baseline = git(seed, "rev-parse", "HEAD").trim();

      const adapter = createGitControlStoreAdapter({
        remote,
        mirror_root: join(tempDir("harness-cas-fault-mirror-"), "mirror"),
      });
      const lossy = createLossyControlStore(adapter);
      const projection = new SqliteCoordinatorProjection(":memory:");
      const coordinator = createCollaborationCoordinator({
        platform,
        controlStore: lossy.port,
        projection,
        now: () => NOW,
      });

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
      expect(connected).toMatchObject({ status: "connected" });

      // Publish the operation branch on the remote.
      const cloneParent = tempDir("harness-cas-fault-clone-");
      const clone = join(cloneParent, "clone");
      git(cloneParent, "clone", remote, clone);
      git(clone, "config", "user.name", "Harness Test");
      git(clone, "config", "user.email", "harness-test@example.invalid");
      git(clone, "config", "commit.gpgsign", "false");
      writeFiles(
        clone,
        ledgerOpFiles({ id: "operation_b_2", sequence: 2, baseline, committedAt: T_B }),
      );
      git(clone, "add", "-A");
      git(clone, "commit", "-m", "operation op_b");
      git(clone, "push", "origin", "HEAD:refs/heads/operation/op_b");

      const prepared = await coordinator.execute(
        {
          kind: "prepare_integration",
          command_id: "command_prepare_1",
          project_id: PROJECT_ID,
          operation_id: "op_b",
        },
        session,
      );
      expect(prepared.status).toBe("prepared");
      if (prepared.status !== "prepared") throw new Error("unreachable");
      const record = prepared.integration_record;

      // The CAS lands but the response and the immediate recovery read fail.
      lossy.loseNextTargetCas = true;
      const lost = await coordinator.execute(
        {
          kind: "accept_integration",
          command_id: "command_accept_1",
          project_id: PROJECT_ID,
          integration_id: record.integration_id,
          expected_target_commit: record.expected_target_commit,
        },
        session,
      );
      expect(lost).toMatchObject({
        status: "failed",
        failure: { code: "git_remote_unavailable", retryable: true },
      });
      // The swap really landed despite the reported failure.
      expect(git(remote, "rev-parse", "main").trim()).toBe(prepared.candidate_commit);

      // The retry recovers the accepted fact from the Target history and
      // never produces a second merge commit.
      const recovered = await coordinator.execute(
        {
          kind: "accept_integration",
          command_id: "command_accept_1",
          project_id: PROJECT_ID,
          integration_id: record.integration_id,
          expected_target_commit: record.expected_target_commit,
        },
        session,
      );
      expect(recovered).toMatchObject({ status: "accepted", replayed: true });
      if (recovered.status !== "accepted") throw new Error("unreachable");
      expect(recovered.integration_record.record_digest).toBe(record.record_digest);
      expect(git(remote, "rev-parse", "main").trim()).toBe(prepared.candidate_commit);
      const merges = git(remote, "log", "--merges", "--format=%H", "main")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0);
      expect(merges).toHaveLength(1);

      projection.close();
    },
  );
});
