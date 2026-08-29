import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildCollaborationRecord,
  buildManifest,
  canonicalizeJson,
  sha256Hex,
} from "@universal-harness-internal/core";
import type {
  CollaborationConnectionRecord,
  ControlRecord,
  IntegrationRecord,
  LeaseRecord,
  LedgerOperation,
  PrincipalSnapshotRecord,
} from "@universal-harness-internal/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  createGitControlStoreAdapter,
  type CandidateMergeView,
  type CandidatePlan,
  type GitControlStoreAdapter,
} from "../src/control-store.js";

import { cleanupDirectories, git, headOf, makeRepo, makeTempDir } from "./helpers.js";

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

/** Push a replica-side candidate commit to an untrusted holding branch. */
function pushCandidate(remote: string, base: string, file: string, stagingId?: string): string {
  const clone = cloneRemote(remote);
  git(clone, "switch", "--detach", base);
  writeFileSync(join(clone, file), `candidate ${file}\n`);
  git(clone, "add", file);
  git(clone, "commit", "-m", `candidate ${file}`);
  const candidate = git(clone, "rev-parse", "HEAD").trim();
  git(clone, "push", "origin", `HEAD:refs/heads/candidate/${file}`);
  if (stagingId !== undefined) {
    git(clone, "push", "origin", `HEAD:refs/heads/harness/candidate/${stagingId}`);
  }
  return candidate;
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

// Real-git integration tests: every case clones/fetches/pushes against a
// temporary remote, which exceeds the 5s default under full-suite parallel
// load (observed 4.5–11s per case). Follow the e2e precedent of a
// describe-level timeout.
describe("git control store control ref", { timeout: 30_000 }, () => {
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

describe("git control store project records", { timeout: 30_000 }, () => {
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

describe("git control store operation refs", { timeout: 30_000 }, () => {
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

    const candidate = pushCandidate(remote, operationBase, "candidate.txt", "op_1");
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

    const candidate = pushCandidate(remote, "main", "other.txt", "op_1");
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
    git(orphan, "push", "origin", "HEAD:refs/heads/harness/candidate/op_1");

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

describe("git control store read fallback and publish hardening", { timeout: 30_000 }, () => {
  it("falls back to the remembered target ref when readControl gets none", async () => {
    const { store } = createHarness();
    const active = connectionRecord(1, "active");
    const committed = await store.appendProjectRecord({
      project_id: PROJECT_ID,
      target_ref: "refs/heads/main",
      record: active,
    });
    expect(committed).toMatchObject({ status: "committed" });

    // No target_ref: the mirror-remembered config locates the Ledger record.
    const read = await store.readControl({
      project_id: PROJECT_ID,
      control_ref: COLLABORATION_CONTROL_REF,
    });
    expect(read.status).toBe("ok");
    if (read.status !== "ok") return;
    expect(read.snapshot.latest_connection).toEqual(active);
  });

  it("rejects malformed commit oids before they reach a git argument", async () => {
    const { store } = createHarness();
    const badCandidate = await store.compareAndSwapOperation({
      project_id: PROJECT_ID,
      operation_id: "op_1",
      candidate_commit: "not-an-oid",
      fencing_token: 1,
    });
    expect(badCandidate).toMatchObject({
      status: "failed",
      failure: { code: "coordinator_unavailable", retryable: false },
    });

    const badExpected = await store.compareAndSwapOperation({
      project_id: PROJECT_ID,
      operation_id: "op_1",
      expected_head_oid: "abc",
      candidate_commit: "0".repeat(40),
      fencing_token: 1,
    });
    expect(badExpected).toMatchObject({
      status: "failed",
      failure: { code: "coordinator_unavailable", retryable: false },
    });

    const badControlHead = await store.appendControl({
      project_id: PROJECT_ID,
      control_ref: COLLABORATION_CONTROL_REF,
      expected_head_oid: "zz",
      record: principalSnapshot(1),
    });
    expect(badControlHead).toMatchObject({
      status: "failed",
      failure: { code: "coordinator_unavailable", retryable: false },
    });
  });

  it("anchors the first publish to the connected target ref baseline", async () => {
    const { remote, store } = createHarness();
    // A project record write is what connects the target ref to the mirror.
    const committed = await store.appendProjectRecord({
      project_id: PROJECT_ID,
      target_ref: "refs/heads/main",
      record: connectionRecord(1, "active"),
    });
    expect(committed).toMatchObject({ status: "committed" });

    // The candidate descends from the post-connect target head.
    const candidate = pushCandidate(remote, "origin/main", "candidate.txt", "op_first");
    const swapped = await store.compareAndSwapOperation({
      project_id: PROJECT_ID,
      operation_id: "op_first",
      candidate_commit: candidate,
      fencing_token: 1,
    });
    expect(swapped).toMatchObject({ status: "swapped", head_oid: candidate });
    expect(git(remote, "rev-parse", "refs/heads/operation/op_first").trim()).toBe(candidate);
  });

  it("rejects a first publish that does not descend from the target baseline", async () => {
    const { remote, store } = createHarness();
    await store.appendProjectRecord({
      project_id: PROJECT_ID,
      target_ref: "refs/heads/main",
      record: connectionRecord(1, "active"),
    });

    const orphan = cloneRemote(remote);
    git(orphan, "switch", "--orphan", "unrelated");
    git(orphan, "clean", "-fdq");
    writeFileSync(join(orphan, "unrelated.txt"), "unrelated\n");
    git(orphan, "add", "unrelated.txt");
    git(orphan, "commit", "-m", "unrelated root");
    const unrelated = git(orphan, "rev-parse", "HEAD").trim();
    git(orphan, "push", "origin", "HEAD:refs/heads/candidate/unrelated");
    git(orphan, "push", "origin", "HEAD:refs/heads/harness/candidate/op_first");

    const result = await store.compareAndSwapOperation({
      project_id: PROJECT_ID,
      operation_id: "op_first",
      candidate_commit: unrelated,
      fencing_token: 1,
    });
    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "operation_ref_drift" },
    });
  });

  it("fails closed on a first publish when no target ref was ever connected", async () => {
    const { remote, store } = createHarness();
    const candidate = pushCandidate(remote, "main", "candidate.txt", "op_first");
    const result = await store.compareAndSwapOperation({
      project_id: PROJECT_ID,
      operation_id: "op_first",
      candidate_commit: candidate,
      fencing_token: 1,
    });
    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "coordinator_unavailable" },
    });
  });

  it("backstops fencing against the control ref lease chain", { timeout: 30_000 }, async () => {
    const { remote, store } = createHarness();
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

    await store.appendProjectRecord({
      project_id: PROJECT_ID,
      target_ref: "refs/heads/main",
      record: connectionRecord(1, "active"),
    });
    const candidate = pushCandidate(remote, "origin/main", "candidate.txt", "op_1");

    // A token the live lease tip does not hold is permanently fenced.
    const stale = await store.compareAndSwapOperation({
      project_id: PROJECT_ID,
      operation_id: "op_1",
      candidate_commit: candidate,
      fencing_token: 2,
    });
    expect(stale).toMatchObject({
      status: "failed",
      failure: { code: "lease_fenced", retryable: false },
    });

    // The live token publishes.
    const matched = await store.compareAndSwapOperation({
      project_id: PROJECT_ID,
      operation_id: "op_1",
      candidate_commit: candidate,
      fencing_token: 1,
    });
    expect(matched).toMatchObject({ status: "swapped", head_oid: candidate });
  });
});

// --- Integration candidate merge and Target CAS (plan M3 Task 6 step 3) ----

const STAGING_REF_PREFIX = "refs/heads/harness/candidate";

function integrationRecordRecord(
  integrationId: string,
  expectedTargetCommit: string,
  operationCommit: string,
): IntegrationRecord {
  return buildCollaborationRecord({
    record_kind: "integration" as const,
    integration_id: integrationId,
    operation_id: "op_1",
    expected_target_commit: expectedTargetCommit,
    operation_commit: operationCommit,
    lease_fencing_token: 1,
    ledger_sequence_rewrites: [],
    evidence_digests: [],
    approval_decision_digests: [],
    command_id: "command_prepare_1",
  });
}

/** The deterministic coordinator plan the tests inject into prepareCandidate. */
function fixedPlan(record: IntegrationRecord) {
  return (): CandidatePlan => ({
    status: "planned",
    record,
    writes: [
      {
        path: `.harness/artifacts/integrations/${record.integration_id}.json`,
        content: `${canonicalizeJson(record)}\n`,
      },
    ],
  });
}

/** A branch with one Ledger operation, its empty shards and one artifact. */
function commitLedgerOperation(root: string, operationId: string): LedgerOperation {
  const artifactContent = `note for ${operationId}\n`;
  const manifest = buildManifest({
    ledger_operation_id: operationId,
    workflow_operation_id: "workflow_op_01",
    attempt_id: "attempt_01",
    baseline_commit: headOf(root),
    sequence: 1,
    artifact_digests: [sha256Hex(artifactContent)],
    edge_file: `ledger/edges/2026-08/${operationId}.jsonl`,
    event_file: `events/2026-08/${operationId}.jsonl`,
    edge_file_digest: sha256Hex(""),
    event_file_digest: sha256Hex(""),
    committed_at: NOW,
  });
  mkdirSync(join(root, ".harness/ledger/operations"), { recursive: true });
  mkdirSync(join(root, ".harness/ledger/edges/2026-08"), { recursive: true });
  mkdirSync(join(root, ".harness/events/2026-08"), { recursive: true });
  mkdirSync(join(root, ".harness/artifacts/notes"), { recursive: true });
  writeFileSync(
    join(root, `.harness/ledger/operations/${operationId}.json`),
    `${canonicalizeJson(manifest)}\n`,
  );
  writeFileSync(join(root, `.harness/ledger/edges/2026-08/${operationId}.jsonl`), "");
  writeFileSync(join(root, `.harness/events/2026-08/${operationId}.jsonl`), "");
  writeFileSync(join(root, ".harness/artifacts/notes/note.txt"), artifactContent);
  git(root, "add", ".harness");
  git(root, "commit", "-m", `ledger operation ${operationId}`);
  return manifest;
}

/** Remote with `main` plus an `operation/op_1` branch carrying a Ledger op. */
function createOperationHarness() {
  const { remote, store } = createHarness();
  const clone = cloneRemote(remote);
  const targetHead = headOf(clone);
  const manifest = commitLedgerOperation(clone, "ledger_op_b1");
  writeFileSync(join(clone, "work.txt"), "candidate work\n");
  git(clone, "add", "work.txt");
  git(clone, "commit", "-m", "operation work");
  const operationHead = headOf(clone);
  git(clone, "push", "origin", "HEAD:refs/heads/operation/op_1");
  return { remote, store, targetHead, operationHead, manifest };
}

describe("git control store integration candidates", { timeout: 30_000 }, () => {
  it("builds a deterministic two-parent candidate and stages it without touching managed refs", async () => {
    const { remote, store, targetHead, operationHead, manifest } = createOperationHarness();
    const record = integrationRecordRecord("integration_test01", targetHead, operationHead);

    let observed: CandidateMergeView | undefined;
    const prepared = await store.prepareCandidate({
      project_id: PROJECT_ID,
      operation_id: "op_1",
      target_ref: "refs/heads/main",
      expected_target_commit: targetHead,
      operation_commit: operationHead,
      plan: (merge) => {
        observed = merge;
        return fixedPlan(record)();
      },
    });
    expect(prepared).toMatchObject({ status: "prepared", integration_id: "integration_test01" });
    if (prepared.status !== "prepared") throw new Error("expected a prepared candidate");

    // The coordinator's plan sees the parsed Ledger view of both branches.
    expect(observed?.target_operations).toEqual([]);
    expect(observed?.incoming_operations.map((op) => op.ledger_operation_id)).toEqual([
      "ledger_op_b1",
    ]);
    expect(observed?.incoming_operations[0]?.digest).toBe(manifest.digest);
    expect(observed?.incoming_artifacts).toEqual([
      {
        path: ".harness/artifacts/notes/note.txt",
        content: "note for ledger_op_b1\n",
        digest: sha256Hex("note for ledger_op_b1\n"),
      },
    ]);

    // Parent order is Target then Operation (design §14.3).
    const verify = cloneRemote(remote);
    const line = git(verify, "rev-list", "--parents", "-n", "1", prepared.candidate_commit).trim();
    expect(line.split(" ")).toEqual([prepared.candidate_commit, targetHead, operationHead]);
    git(verify, "checkout", "--detach", prepared.candidate_commit);
    expect(readFileSync(join(verify, "work.txt"), "utf8")).toBe("candidate work\n");
    expect(
      readFileSync(join(verify, ".harness/artifacts/integrations/integration_test01.json"), "utf8"),
    ).toBe(`${canonicalizeJson(record)}\n`);

    // Managed refs never moved; only the staging ref names the candidate.
    expect(git(remote, "rev-parse", "refs/heads/main").trim()).toBe(targetHead);
    expect(git(remote, "rev-parse", "refs/heads/operation/op_1").trim()).toBe(operationHead);
    expect(git(remote, "rev-parse", `${STAGING_REF_PREFIX}/integration_test01`).trim()).toBe(
      prepared.candidate_commit,
    );

    // Recomputing the same merge + plan yields the same tree (design §14.3).
    const recomputed = await store.prepareCandidate({
      project_id: PROJECT_ID,
      operation_id: "op_1",
      target_ref: "refs/heads/main",
      expected_target_commit: targetHead,
      operation_commit: operationHead,
      plan: fixedPlan(record),
    });
    expect(recomputed).toMatchObject({ status: "prepared", tree_oid: prepared.tree_oid });
  });

  it("returns integration_conflict on a text conflict and leaves every ref untouched", async () => {
    const { remote, store } = createHarness();
    const base = cloneRemote(remote);
    writeFileSync(join(base, "shared.txt"), "base\n");
    git(base, "add", "shared.txt");
    git(base, "commit", "-m", "shared base");
    git(base, "push", "origin", "main");
    const baseHead = headOf(base);

    writeFileSync(join(base, "shared.txt"), "target version\n");
    git(base, "commit", "-am", "target edit");
    git(base, "push", "origin", "main");
    const targetHead = headOf(base);

    const replica = cloneRemote(remote);
    git(replica, "checkout", "-b", "work", baseHead);
    writeFileSync(join(replica, "shared.txt"), "operation version\n");
    git(replica, "commit", "-am", "operation edit");
    const operationHead = headOf(replica);
    git(replica, "push", "origin", "HEAD:refs/heads/operation/op_1");

    const record = integrationRecordRecord("integration_conf01", targetHead, operationHead);
    const result = await store.prepareCandidate({
      project_id: PROJECT_ID,
      operation_id: "op_1",
      target_ref: "refs/heads/main",
      expected_target_commit: targetHead,
      operation_commit: operationHead,
      plan: fixedPlan(record),
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected a conflict failure");
    expect(result.failure.code).toBe("integration_conflict");
    expect(result.failure.summary).toContain("shared.txt");
    expect(() =>
      git(remote, "rev-parse", "--verify", `${STAGING_REF_PREFIX}/integration_conf01`),
    ).toThrow();
    expect(git(remote, "rev-parse", "refs/heads/main").trim()).toBe(targetHead);
  });

  it("rejects drifted frozen commits before merging", async () => {
    const { remote, store, targetHead, operationHead } = createOperationHarness();

    const movedTarget = await store.prepareCandidate({
      project_id: PROJECT_ID,
      operation_id: "op_1",
      target_ref: "refs/heads/main",
      expected_target_commit: operationHead,
      operation_commit: operationHead,
      plan: fixedPlan(integrationRecordRecord("integration_drift1", operationHead, operationHead)),
    });
    expect(movedTarget).toMatchObject({ status: "failed", failure: { code: "baseline_drift" } });

    const staleOperation = await store.prepareCandidate({
      project_id: PROJECT_ID,
      operation_id: "op_1",
      target_ref: "refs/heads/main",
      expected_target_commit: targetHead,
      operation_commit: targetHead,
      plan: fixedPlan(integrationRecordRecord("integration_drift2", targetHead, targetHead)),
    });
    expect(staleOperation).toMatchObject({
      status: "failed",
      failure: { code: "operation_ref_drift" },
    });
    expect(git(remote, "rev-parse", "refs/heads/main").trim()).toBe(targetHead);
  });

  it("rejects malformed commit oids before they reach a git argument", async () => {
    const { store } = createHarness();
    const result = await store.prepareCandidate({
      project_id: PROJECT_ID,
      operation_id: "op_1",
      target_ref: "refs/heads/main",
      expected_target_commit: "not-an-oid",
      operation_commit: "0".repeat(40),
      plan: fixedPlan(integrationRecordRecord("integration_bad01", "0".repeat(40), "0".repeat(40))),
    });
    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "coordinator_unavailable", retryable: false },
    });
    const cas = await store.compareAndSwapTarget({
      project_id: PROJECT_ID,
      target_ref: "refs/heads/main",
      expected_commit: "abc",
      new_commit: "0".repeat(40),
    });
    expect(cas).toMatchObject({
      status: "failed",
      failure: { code: "coordinator_unavailable", retryable: false },
    });
  });
});

describe("git control store candidate reads and target cas", { timeout: 30_000 }, () => {
  it("reads a staged candidate back, swaps the target fast-forward and finds the accepted record", async () => {
    const { remote, store, targetHead, operationHead } = createOperationHarness();
    const record = integrationRecordRecord("integration_accept1", targetHead, operationHead);

    const missing = await store.readCandidate({
      project_id: PROJECT_ID,
      integration_id: "integration_accept1",
    });
    expect(missing).toEqual({ status: "missing" });

    const prepared = await store.prepareCandidate({
      project_id: PROJECT_ID,
      operation_id: "op_1",
      target_ref: "refs/heads/main",
      expected_target_commit: targetHead,
      operation_commit: operationHead,
      plan: fixedPlan(record),
    });
    if (prepared.status !== "prepared") throw new Error("expected a prepared candidate");

    const found = await store.readCandidate({
      project_id: PROJECT_ID,
      integration_id: "integration_accept1",
    });
    expect(found).toMatchObject({
      status: "found",
      candidate_commit: prepared.candidate_commit,
      tree_oid: prepared.tree_oid,
    });
    if (found.status !== "found") throw new Error("expected the staged candidate");
    expect(found.record).toEqual(record);

    // Not accepted yet: the record is absent from the target history.
    const notYet = await store.readIntegrationRecord({
      project_id: PROJECT_ID,
      target_ref: "refs/heads/main",
      integration_id: "integration_accept1",
    });
    expect(notYet).toEqual({ status: "missing" });

    const swapped = await store.compareAndSwapTarget({
      project_id: PROJECT_ID,
      target_ref: "refs/heads/main",
      expected_commit: targetHead,
      new_commit: prepared.candidate_commit,
      integration_id: "integration_accept1",
    });
    expect(swapped).toEqual({ status: "swapped", commit: prepared.candidate_commit });
    expect(git(remote, "rev-parse", "refs/heads/main").trim()).toBe(prepared.candidate_commit);
    // The staging ref is cleaned up once the candidate lands on the target.
    expect(git(remote, "for-each-ref", "--format=%(refname)", STAGING_REF_PREFIX).trim()).toBe("");

    const accepted = await store.readIntegrationRecord({
      project_id: PROJECT_ID,
      target_ref: "refs/heads/main",
      integration_id: "integration_accept1",
    });
    expect(accepted).toMatchObject({ status: "found", commit: prepared.candidate_commit });
    if (accepted.status !== "found") throw new Error("expected the accepted record");
    expect(accepted.record).toEqual(record);

    // A stale expected commit loses the CAS and the target stays put.
    const stale = await store.compareAndSwapTarget({
      project_id: PROJECT_ID,
      target_ref: "refs/heads/main",
      expected_commit: targetHead,
      new_commit: prepared.candidate_commit,
    });
    expect(stale).toMatchObject({ status: "failed", failure: { code: "target_cas_failed" } });
    expect(git(remote, "rev-parse", "refs/heads/main").trim()).toBe(prepared.candidate_commit);
  });

  it("refuses a non-fast-forward target swap", async () => {
    const { remote, store, targetHead } = createOperationHarness();
    const orphan = cloneRemote(remote);
    git(orphan, "switch", "--orphan", "unrelated");
    git(orphan, "clean", "-fdq");
    writeFileSync(join(orphan, "unrelated.txt"), "unrelated\n");
    git(orphan, "add", "unrelated.txt");
    git(orphan, "commit", "-m", "unrelated root");
    const unrelated = headOf(orphan);
    git(orphan, "push", "origin", "HEAD:refs/heads/candidate/unrelated");

    const result = await store.compareAndSwapTarget({
      project_id: PROJECT_ID,
      target_ref: "refs/heads/main",
      expected_commit: targetHead,
      new_commit: unrelated,
    });
    expect(result).toMatchObject({ status: "failed", failure: { code: "target_cas_failed" } });
    expect(git(remote, "rev-parse", "refs/heads/main").trim()).toBe(targetHead);
  });
});
