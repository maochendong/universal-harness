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
  harnessRootFor,
  replayLedger,
  sha256Hex,
  shardMonthFor,
  type LedgerOperation,
} from "../../packages/core/src/index.js";
import {
  createCollaborationCoordinator,
  SqliteCoordinatorProjection,
  type CollaborationSession,
  type PlatformIdentityPort,
} from "../../packages/runtime/src/index.js";

/**
 * Plan Task 6 Step 1: two Operation Branches forked from the same Target both
 * carry a new LedgerOperation at the same sequence. Integrating A keeps the
 * accepted history strictly linear; preparing B resequences its manifest
 * inside the candidate only (old sequence 2 becomes 4, after A's integration
 * transaction), and the staged candidate replays as a fully linear ledger
 * when cloned and checked out from the remote.
 */

const NOW = "2026-08-29T00:00:00.000Z";
const T_A = "2026-08-29T00:01:00.000Z";
const T_B = "2026-08-29T00:02:00.000Z";
const PROJECT_ID = "project_demo";
const TARGET_REF = "refs/heads/main";

const digest = (letter: string): string => letter.repeat(64);
const POLICY_DIGEST = digest("c");

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

function cloneRemote(remote: string): string {
  const parent = tempDir("harness-m3-fork-clone-");
  const clone = join(parent, "clone");
  git(parent, "clone", remote, clone);
  git(clone, "config", "user.name", "Harness Test");
  git(clone, "config", "user.email", "harness-test@example.invalid");
  git(clone, "config", "commit.gpgsign", "false");
  return clone;
}

/** Commit `files` on top of `parentRef` in a fresh clone and push the branch. */
function pushOperationBranch(
  remote: string,
  parentOid: string,
  operationId: string,
  files: Readonly<Record<string, string>>,
): string {
  const clone = cloneRemote(remote);
  git(clone, "checkout", "-b", `work-${operationId}`, parentOid);
  writeFiles(clone, files);
  git(clone, "add", "-A");
  git(clone, "commit", "-m", `operation ${operationId}`);
  const head = git(clone, "rev-parse", "HEAD").trim();
  git(clone, "push", "origin", `HEAD:refs/heads/operation/${operationId}`);
  return head;
}

describe("m3 ledger sequence fork over real git", () => {
  it(
    "integrates branch A, then resequences branch B's forked sequence inside the candidate only",
    { timeout: 120_000 },
    async () => {
      // Baseline: one committed LedgerOperation at sequence 1.
      const remote = tempDir("harness-m3-fork-remote-");
      git(remote, "init", "--bare", "-b", "main");
      const seed = tempDir("harness-m3-fork-seed-");
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

      const controlStore = createGitControlStoreAdapter({
        remote,
        mirror_root: join(tempDir("harness-m3-fork-mirror-"), "mirror"),
      });
      const projection = new SqliteCoordinatorProjection(":memory:");
      const coordinator = createCollaborationCoordinator({
        platform,
        controlStore,
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
          policy_digest: POLICY_DIGEST,
        },
        session,
      );
      expect(connected).toMatchObject({ status: "connected" });

      // Both operation branches fork from the same Target: the connection
      // record commit the coordinator appended to main during connect.
      const forkPoint = git(remote, "rev-parse", "main").trim();
      pushOperationBranch(
        remote,
        forkPoint,
        "op_a",
        ledgerOpFiles({ id: "operation_a_2", sequence: 2, baseline, committedAt: T_A }),
      );
      pushOperationBranch(
        remote,
        forkPoint,
        "op_b",
        ledgerOpFiles({ id: "operation_b_2", sequence: 2, baseline, committedAt: T_B }),
      );

      // Integrate A: no fork yet, so A's manifest keeps sequence 2 and the
      // integration transaction lands at 3.
      const prepareA = await coordinator.execute(
        {
          kind: "prepare_integration",
          command_id: "command_prepare_a",
          project_id: PROJECT_ID,
          operation_id: "op_a",
        },
        session,
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
        session,
      );
      expect(acceptA).toMatchObject({ status: "accepted", replayed: false });
      const integratedA = git(remote, "rev-parse", "main").trim();

      // Prepare B: its manifest forked A's at sequence 2 and is resequenced
      // to 4 inside the candidate; the Target never sees sequence 2 twice.
      const prepareB = await coordinator.execute(
        {
          kind: "prepare_integration",
          command_id: "command_prepare_b",
          project_id: PROJECT_ID,
          operation_id: "op_b",
        },
        session,
      );
      expect(prepareB.status).toBe("prepared");
      if (prepareB.status !== "prepared") throw new Error("unreachable");
      expect(prepareB.integration_record.expected_target_commit).toBe(integratedA);
      expect(prepareB.integration_record.ledger_sequence_rewrites).toMatchObject([
        { ledger_operation_id: "operation_b_2", old_sequence: 2, new_sequence: 4 },
      ]);

      // The staged candidate is fetchable from the remote and replays as a
      // fully linear ledger: base, A, A's integration record, resequenced B,
      // then B's integration record.
      const candidateRoot = join(tempDir("harness-m3-fork-checkout-"), "candidate");
      git(dirname(candidateRoot), "clone", remote, candidateRoot);
      git(candidateRoot, "checkout", "--detach", prepareB.candidate_commit);
      const sequences = replayLedger(harnessRootFor(candidateRoot)).operations.map(
        (operation) => operation.manifest.sequence,
      );
      expect(sequences).toEqual([1, 2, 3, 4, 5]);

      // The operation branch bytes are untouched: B's branch still carries
      // its original manifest at sequence 2.
      const branchRoot = join(tempDir("harness-m3-fork-branch-"), "branch");
      git(dirname(branchRoot), "clone", remote, branchRoot);
      git(branchRoot, "checkout", "--detach", "origin/operation/op_b");
      const branchSequences = replayLedger(harnessRootFor(branchRoot)).operations.map(
        (operation) => operation.manifest.sequence,
      );
      expect(branchSequences).toEqual([1, 2]);

      // Accept B: the Target fast-forwards onto the candidate.
      const acceptB = await coordinator.execute(
        {
          kind: "accept_integration",
          command_id: "command_accept_b",
          project_id: PROJECT_ID,
          integration_id: prepareB.integration_record.integration_id,
          expected_target_commit: prepareB.integration_record.expected_target_commit,
        },
        session,
      );
      expect(acceptB).toMatchObject({ status: "accepted", replayed: false });
      if (acceptB.status !== "accepted") throw new Error("unreachable");
      expect(git(remote, "rev-parse", "main").trim()).toBe(acceptB.target_commit);

      // Exactly two integration merge commits reached the Target.
      const merges = git(remote, "log", "--merges", "--format=%H", "main")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0);
      expect(merges).toHaveLength(2);

      projection.close();
    },
  );
});
