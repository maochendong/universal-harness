import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildCollaborationRecord } from "@universal-harness-internal/core";
import type {
  CollaborationConnectionRecord,
  ControlRecord,
  LeaseRecord,
  PrincipalSnapshotRecord,
} from "@universal-harness-internal/core";
import { afterEach, describe, expect, it } from "vitest";

import { createGitControlStoreAdapter, type GitControlStoreAdapter } from "../src/control-store.js";

import { cleanupDirectories, git, makeRepo, makeTempDir } from "./helpers.js";

afterEach(cleanupDirectories);

const COLLABORATION_CONTROL_REF = "refs/heads/harness/control";

const digest = (letter: string): string => letter.repeat(64);

const NOW = "2026-08-29T00:00:00.000Z";
const LATER = "2026-08-29T00:05:00.000Z";
const PROJECT_ID = "project_demo";

function principalSnapshot(
  control_sequence: number,
  previous_control_record_digest?: string,
): PrincipalSnapshotRecord {
  return buildCollaborationRecord({
    record_kind: "principal_snapshot" as const,
    control_sequence,
    ...(previous_control_record_digest === undefined ? {} : { previous_control_record_digest }),
    snapshot_id: `snapshot_${control_sequence}`,
    principal_id: "principal_alice",
    provider: "github" as const,
    host: "github.com",
    subject_id: "1234567",
    repository_id: "acme/demo",
    permission: "maintain" as const,
    observed_at: NOW,
    expires_at: LATER,
    source_response_digest: digest("a"),
  });
}

function leaseRecord(
  control_sequence: number,
  previous_control_record_digest: string,
  overrides: Partial<LeaseRecord> = {},
): LeaseRecord {
  return buildCollaborationRecord({
    record_kind: "lease" as const,
    control_sequence,
    previous_control_record_digest,
    lease_record_id: `lease-record_${control_sequence}`,
    lease_id: "lease_1",
    resource_kind: "operation" as const,
    resource_id: "op_1",
    holder_principal_snapshot_digest: digest("a"),
    client_instance_id: "instance_test",
    fencing_token: 1,
    issued_at: NOW,
    expires_at: LATER,
    state: "granted" as const,
    command_id: "command_lease_1",
    ...overrides,
  });
}

function connectionRecord(
  revision: number,
  status: "active" | "disconnected",
  supersedes?: string,
): CollaborationConnectionRecord {
  return buildCollaborationRecord({
    record_kind: "collaboration_connection" as const,
    connection_id: "connection_demo",
    project_id: PROJECT_ID,
    revision,
    status,
    provider: "github" as const,
    repository_id: "acme/demo",
    canonical_remote: "https://github.com/acme/demo.git",
    canonical_remote_digest: digest("b"),
    coordinator_origin: "https://harness.example.com",
    target_ref: "refs/heads/main",
    control_ref: COLLABORATION_CONTROL_REF,
    policy_digest: digest("c"),
    actor_principal_id: "principal_alice",
    principal_snapshot_digest: digest("a"),
    command_id: `command_connect_${revision}`,
    effective_at: NOW,
    ...(supersedes === undefined ? {} : { supersedes_digest: supersedes }),
  });
}

interface Harness {
  readonly remote: string;
  readonly store: GitControlStoreAdapter;
}

/** A bare remote seeded with a `main` branch, plus the adapter under test. */
function createHarness(): Harness {
  const remote = makeTempDir("harness-control-remote-");
  git(remote, "init", "--bare", "-b", "main");
  const seed = makeRepo();
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "origin", "main");
  const mirrorRoot = join(makeTempDir("harness-control-mirror-"), "mirror");
  const store = createGitControlStoreAdapter({ remote, mirror_root: mirrorRoot });
  return { remote, store };
}

/** A full clone of the remote for hostile or replica-side operations. */
function cloneRemote(remote: string): string {
  const parent = makeTempDir("harness-control-clone-");
  const clone = join(parent, "clone");
  git(parent, "clone", remote, clone);
  git(clone, "config", "user.name", "Harness Test");
  git(clone, "config", "user.email", "harness-test@example.invalid");
  git(clone, "config", "commit.gpgsign", "false");
  return clone;
}

async function appendTwoRecords(
  store: GitControlStoreAdapter,
): Promise<{ head: string; records: ControlRecord[] }> {
  const snapshot = principalSnapshot(1);
  const first = await store.appendControl({
    project_id: PROJECT_ID,
    control_ref: COLLABORATION_CONTROL_REF,
    record: snapshot,
  });
  expect(first).toMatchObject({ status: "appended" });
  if (first.status !== "appended") throw new Error("expected first append to succeed");

  const lease = leaseRecord(2, snapshot.record_digest);
  const second = await store.appendControl({
    project_id: PROJECT_ID,
    control_ref: COLLABORATION_CONTROL_REF,
    expected_head_oid: first.head_oid,
    record: lease,
  });
  expect(second).toMatchObject({ status: "appended" });
  if (second.status !== "appended") throw new Error("expected second append to succeed");
  return { head: second.head_oid, records: [snapshot, lease] };
}

describe("git control store control ref", () => {
  it("appends the first control record to an empty control ref and reads it back", async () => {
    const { store } = createHarness();
    const snapshot = principalSnapshot(1);

    const first = await store.appendControl({
      project_id: PROJECT_ID,
      control_ref: COLLABORATION_CONTROL_REF,
      record: snapshot,
    });
    expect(first).toMatchObject({ status: "appended" });

    const read = await store.readControl({
      project_id: PROJECT_ID,
      control_ref: COLLABORATION_CONTROL_REF,
    });
    expect(read.status).toBe("ok");
    if (read.status !== "ok") return;
    expect(read.snapshot.control_head_oid).toBeDefined();
    expect(read.snapshot.control_records).toEqual([snapshot]);
    expect(read.snapshot.latest_connection).toBeUndefined();
  });

  it("lets a stale expected head lose the compare-and-swap", async () => {
    const { store } = createHarness();
    const first = await store.appendControl({
      project_id: PROJECT_ID,
      control_ref: COLLABORATION_CONTROL_REF,
      record: principalSnapshot(1),
    });
    expect(first).toMatchObject({ status: "appended" });

    // A second writer that never re-read still believes the ref is unborn.
    const stale = await store.appendControl({
      project_id: PROJECT_ID,
      control_ref: COLLABORATION_CONTROL_REF,
      record: leaseRecord(1, digest("d"), { lease_record_id: "lease-record_stale" }),
    });
    expect(stale).toMatchObject({
      status: "failed",
      failure: { code: "control_ref_cas_failed" },
    });

    // The rejected append must not create remote or mirror side effects.
    const read = await store.readControl({
      project_id: PROJECT_ID,
      control_ref: COLLABORATION_CONTROL_REF,
    });
    expect(read.status).toBe("ok");
    if (read.status !== "ok") return;
    expect(read.snapshot.control_records).toHaveLength(1);
  });

  it("extends the chain only when the expected head matches", async () => {
    const { store } = createHarness();
    const { head, records } = await appendTwoRecords(store);

    const read = await store.readControl({
      project_id: PROJECT_ID,
      control_ref: COLLABORATION_CONTROL_REF,
    });
    expect(read.status).toBe("ok");
    if (read.status !== "ok") return;
    expect(read.snapshot.control_head_oid).toBe(head);
    expect(read.snapshot.control_records).toEqual(records);
    const [snapshot, lease] = read.snapshot.control_records;
    expect(lease?.control_sequence).toBe((snapshot?.control_sequence ?? 0) + 1);
    expect(lease?.previous_control_record_digest).toBe(snapshot?.record_digest);
  });

  it("rejects a record whose chain position does not continue the ref", async () => {
    const { store } = createHarness();
    const snapshot = principalSnapshot(1);
    const first = await store.appendControl({
      project_id: PROJECT_ID,
      control_ref: COLLABORATION_CONTROL_REF,
      record: snapshot,
    });
    expect(first).toMatchObject({ status: "appended" });
    if (first.status !== "appended") return;

    // Correct expected head, but the record claims sequence 1 again.
    const invalid = await store.appendControl({
      project_id: PROJECT_ID,
      control_ref: COLLABORATION_CONTROL_REF,
      expected_head_oid: first.head_oid,
      record: principalSnapshot(1),
    });
    expect(invalid).toMatchObject({
      status: "failed",
      failure: { code: "control_ref_invalid" },
    });
  });

  it("fails closed with control_ref_invalid when the remote history is rewritten", async () => {
    const { remote, store } = createHarness();
    await appendTwoRecords(store);
    // The mirror has observed the legitimate head.
    const before = await store.readControl({
      project_id: PROJECT_ID,
      control_ref: COLLABORATION_CONTROL_REF,
    });
    expect(before.status).toBe("ok");

    // A hostile clone force-pushes a rewritten control history.
    const clone = cloneRemote(remote);
    git(clone, "switch", "--orphan", "rewritten-control");
    git(clone, "clean", "-fdq");
    mkdirSync(join(clone, "records"), { recursive: true });
    const forged = principalSnapshot(1, undefined);
    writeFileSync(
      join(clone, "records", `000000000001-principal_snapshot-${forged.snapshot_id}.json`),
      `${JSON.stringify(forged)}\n`,
    );
    git(clone, "add", "records");
    git(clone, "commit", "-m", "rewrite control history");
    git(clone, "push", "--force", "origin", "HEAD:refs/heads/harness/control");

    const after = await store.readControl({
      project_id: PROJECT_ID,
      control_ref: COLLABORATION_CONTROL_REF,
    });
    expect(after).toMatchObject({
      status: "failed",
      failure: { code: "control_ref_invalid" },
    });
  });

  it("fails closed with control_ref_invalid on a tampered fast-forward record", async () => {
    const { remote, store } = createHarness();
    await appendTwoRecords(store);

    // A fast-forward commit whose record payload fails envelope verification.
    const clone = cloneRemote(remote);
    git(clone, "fetch", "origin");
    git(clone, "switch", "--detach", "origin/harness/control");
    const snapshot = principalSnapshot(3, digest("f"));
    const tampered = { ...snapshot, principal_id: "principal_mallory" };
    mkdirSync(join(clone, "records"), { recursive: true });
    writeFileSync(
      join(clone, "records", `000000000003-principal_snapshot-${snapshot.snapshot_id}.json`),
      `${JSON.stringify(tampered)}\n`,
    );
    git(clone, "add", "records");
    git(clone, "commit", "-m", "tampered record");
    git(clone, "push", "origin", "HEAD:refs/heads/harness/control");

    const read = await store.readControl({
      project_id: PROJECT_ID,
      control_ref: COLLABORATION_CONTROL_REF,
    });
    expect(read).toMatchObject({
      status: "failed",
      failure: { code: "control_ref_invalid" },
    });
  });

  it("reads an empty chain when the control ref does not exist yet", async () => {
    const { store } = createHarness();
    const read = await store.readControl({
      project_id: PROJECT_ID,
      control_ref: COLLABORATION_CONTROL_REF,
    });
    expect(read.status).toBe("ok");
    if (read.status !== "ok") return;
    expect(read.snapshot.control_head_oid).toBeUndefined();
    expect(read.snapshot.control_records).toEqual([]);
  });
});

describe("git control store project records", () => {
  it("commits connection records to the target ref and reads the latest revision", async () => {
    const { store } = createHarness();
    const active = connectionRecord(1, "active");
    const committed = await store.appendProjectRecord({
      project_id: PROJECT_ID,
      target_ref: "refs/heads/main",
      record: active,
    });
    expect(committed).toMatchObject({ status: "committed" });

    const firstRead = await store.readControl({
      project_id: PROJECT_ID,
      control_ref: COLLABORATION_CONTROL_REF,
      target_ref: "refs/heads/main",
    });
    expect(firstRead.status).toBe("ok");
    if (firstRead.status !== "ok") return;
    expect(firstRead.snapshot.latest_connection).toEqual(active);

    const disconnected = connectionRecord(2, "disconnected", active.record_digest);
    const recommitted = await store.appendProjectRecord({
      project_id: PROJECT_ID,
      target_ref: "refs/heads/main",
      record: disconnected,
    });
    expect(recommitted).toMatchObject({ status: "committed" });

    const secondRead = await store.readControl({
      project_id: PROJECT_ID,
      control_ref: COLLABORATION_CONTROL_REF,
      target_ref: "refs/heads/main",
    });
    expect(secondRead.status).toBe("ok");
    if (secondRead.status !== "ok") return;
    expect(secondRead.snapshot.latest_connection).toEqual(disconnected);
  });

  it("keeps the user's target branch content untouched when appending project records", async () => {
    const { remote, store } = createHarness();
    const committed = await store.appendProjectRecord({
      project_id: PROJECT_ID,
      target_ref: "refs/heads/main",
      record: connectionRecord(1, "active"),
    });
    expect(committed).toMatchObject({ status: "committed" });

    const clone = cloneRemote(remote);
    expect(git(clone, "show", "main:README.md")).toBe("initial\n");
  });
});

describe("git control store operation refs", () => {
  /** Push a replica-side candidate commit to an untrusted holding branch. */
  function pushCandidate(remote: string, base: string, file: string): string {
    const clone = cloneRemote(remote);
    git(clone, "switch", "--detach", base);
    writeFileSync(join(clone, file), `candidate ${file}\n`);
    git(clone, "add", file);
    git(clone, "commit", "-m", `candidate ${file}`);
    const candidate = git(clone, "rev-parse", "HEAD").trim();
    git(clone, "push", "origin", `HEAD:refs/heads/candidate/${file}`);
    return candidate;
  }

  it("lists remote operation heads", async () => {
    const { remote, store } = createHarness();
    const clone = cloneRemote(remote);
    git(clone, "switch", "-c", "operation/op_1");
    writeFileSync(join(clone, "work.txt"), "work\n");
    git(clone, "add", "work.txt");
    git(clone, "commit", "-m", "operation work");
    const head = git(clone, "rev-parse", "HEAD").trim();
    git(clone, "push", "origin", "operation/op_1");

    const heads = await store.listOperationHeads({ project_id: PROJECT_ID });
    expect(heads).toMatchObject({
      status: "ok",
      heads: [{ operation_id: "op_1", head_oid: head }],
    });
  });

  it("publishes a candidate only against the current operation head", async () => {
    const { remote, store } = createHarness();
    const clone = cloneRemote(remote);
    git(clone, "switch", "-c", "operation/op_1");
    writeFileSync(join(clone, "base.txt"), "base\n");
    git(clone, "add", "base.txt");
    git(clone, "commit", "-m", "operation base");
    const operationBase = git(clone, "rev-parse", "HEAD").trim();
    git(clone, "push", "origin", "operation/op_1");

    const candidate = pushCandidate(remote, operationBase, "candidate.txt");
    const swapped = await store.compareAndSwapOperation({
      project_id: PROJECT_ID,
      operation_id: "op_1",
      expected_head_oid: operationBase,
      candidate_commit: candidate,
      fencing_token: 1,
    });
    expect(swapped).toMatchObject({ status: "swapped", head_oid: candidate });
    expect(git(remote, "rev-parse", "refs/heads/operation/op_1").trim()).toBe(candidate);

    // A stale expected head loses and the candidate object survives remotely.
    const stale = await store.compareAndSwapOperation({
      project_id: PROJECT_ID,
      operation_id: "op_1",
      expected_head_oid: operationBase,
      candidate_commit: candidate,
      fencing_token: 1,
    });
    expect(stale).toMatchObject({
      status: "failed",
      failure: { code: "operation_ref_drift" },
    });
    expect(git(remote, "cat-file", "-e", `${candidate}^{commit}`)).toBe("");
    expect(git(remote, "rev-parse", "refs/heads/operation/op_1").trim()).toBe(candidate);
  });

  it("refuses to create an operation ref that already exists", async () => {
    const { remote, store } = createHarness();
    const clone = cloneRemote(remote);
    git(clone, "switch", "-c", "operation/op_1");
    writeFileSync(join(clone, "base.txt"), "base\n");
    git(clone, "add", "base.txt");
    git(clone, "commit", "-m", "operation base");
    git(clone, "push", "origin", "operation/op_1");

    const candidate = pushCandidate(remote, "main", "other.txt");
    const created = await store.compareAndSwapOperation({
      project_id: PROJECT_ID,
      operation_id: "op_1",
      candidate_commit: candidate,
      fencing_token: 2,
    });
    expect(created).toMatchObject({
      status: "failed",
      failure: { code: "operation_ref_drift" },
    });
  });

  it("rejects a candidate that does not descend from the expected head", async () => {
    const { remote, store } = createHarness();
    const clone = cloneRemote(remote);
    git(clone, "switch", "-c", "operation/op_1");
    writeFileSync(join(clone, "base.txt"), "base\n");
    git(clone, "add", "base.txt");
    git(clone, "commit", "-m", "operation base");
    const operationBase = git(clone, "rev-parse", "HEAD").trim();
    git(clone, "push", "origin", "operation/op_1");

    // An unrelated root commit cannot be a managed candidate for op_1.
    const orphan = cloneRemote(remote);
    git(orphan, "switch", "--orphan", "unrelated");
    git(orphan, "clean", "-fdq");
    writeFileSync(join(orphan, "unrelated.txt"), "unrelated\n");
    git(orphan, "add", "unrelated.txt");
    git(orphan, "commit", "-m", "unrelated root");
    const unrelated = git(orphan, "rev-parse", "HEAD").trim();
    git(orphan, "push", "origin", "HEAD:refs/heads/candidate/unrelated");

    const result = await store.compareAndSwapOperation({
      project_id: PROJECT_ID,
      operation_id: "op_1",
      expected_head_oid: operationBase,
      candidate_commit: unrelated,
      fencing_token: 1,
    });
    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "operation_ref_drift" },
    });
    expect(git(remote, "rev-parse", "refs/heads/operation/op_1").trim()).toBe(operationBase);
  });

  it("rejects a candidate commit the remote cannot provide", async () => {
    const { store } = createHarness();
    const result = await store.compareAndSwapOperation({
      project_id: PROJECT_ID,
      operation_id: "op_1",
      candidate_commit: "0".repeat(40),
      fencing_token: 1,
    });
    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "operation_ref_drift" },
    });
  });
});
