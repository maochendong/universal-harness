import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  assertControlChain,
  canonicalizeJson,
  PROTOCOL_1_2_SCHEMA_REGISTRY,
  verifyRecordEnvelope,
  type CollaborationConnectionRecord,
  type ControlRecord,
  type IntegrationRecord,
  type LeaseRecord,
  type PrincipalSnapshotRecord,
  type RemoteApprovalDecisionRecord,
} from "@universal-harness-internal/core";

import { createGitRunner, type GitRunner, type GitRunnerOptions } from "./commands.js";

/**
 * Git Adapter for the M3 collaboration seams: the protected Control Ref, the
 * project Ledger connection records, Operation Branch heads and their
 * compare-and-swap. All commands run through the shared `GitRunner` — a fixed
 * executable plus an argument array via `execFile`, never a shell.
 *
 * The Adapter owns a private non-bare mirror clone (`mirror_root`) used as a
 * scratch worktree; the remote is the only authority. Reads verify
 * fast-forward ancestry (the fetch itself is non-forced, so a rewritten
 * history is rejected), Schema, canonical bytes, sequence and digest on every
 * call, failing closed with `control_ref_invalid`. Writes are fast-forward
 * pushes guarded by `--force-with-lease`; a lost lease maps to
 * `control_ref_cas_failed` / `operation_ref_drift` / `target_cas_failed` and
 * the caller re-reads and re-decides instead of blindly retrying.
 *
 * The result types below intentionally mirror the runtime's frozen
 * `GitControlStorePort` shapes. The workspace boundary forbids adapters from
 * depending on the runtime package (the runtime already test-depends on this
 * Adapter), so compatibility is structural: the Coordinator consumes this
 * object as a `GitControlStorePort` without any wrapper.
 */

export type GitControlStoreErrorCode =
  | "coordinator_unavailable"
  | "control_ref_cas_failed"
  | "control_ref_invalid"
  | "git_remote_unavailable"
  | "operation_ref_drift"
  | "target_cas_failed";

export interface GitControlStoreFailure {
  readonly code: GitControlStoreErrorCode;
  readonly summary: string;
  readonly retryable: boolean;
}

export interface ControlStoreReadInput {
  readonly project_id: string;
  readonly control_ref: string;
  /** Frozen target ref; required when the caller needs the latest connection. */
  readonly target_ref?: string;
}

export interface ControlStoreSnapshot {
  readonly control_head_oid?: string;
  readonly control_records: readonly ControlRecord[];
  readonly latest_connection?: CollaborationConnectionRecord;
}

export type ControlStoreReadResult =
  | { readonly status: "ok"; readonly snapshot: ControlStoreSnapshot }
  | { readonly status: "failed"; readonly failure: GitControlStoreFailure };

export interface ControlStoreAppendInput {
  readonly project_id: string;
  readonly control_ref: string;
  readonly expected_head_oid?: string;
  readonly record: ControlRecord;
}

export type ControlStoreAppendResult =
  | { readonly status: "appended"; readonly head_oid: string }
  | { readonly status: "failed"; readonly failure: GitControlStoreFailure };

export interface ProjectRecordAppendInput {
  readonly project_id: string;
  readonly target_ref: string;
  readonly record: CollaborationConnectionRecord | IntegrationRecord;
}

export type ProjectRecordAppendResult =
  | { readonly status: "committed"; readonly commit: string }
  | { readonly status: "failed"; readonly failure: GitControlStoreFailure };

export interface OperationHeadEntry {
  readonly operation_id: string;
  readonly head_oid: string;
}

export type OperationHeadListResult =
  | { readonly status: "ok"; readonly heads: readonly OperationHeadEntry[] }
  | { readonly status: "failed"; readonly failure: GitControlStoreFailure };

export interface OperationCasRequest {
  readonly project_id: string;
  readonly operation_id: string;
  readonly expected_head_oid?: string;
  readonly candidate_commit: string;
  /**
   * Carried for Interface parity with `GitControlStorePort`; fencing
   * authorization is the Coordinator's decision, made before this call.
   */
  readonly fencing_token: number;
}

export type OperationCasOutcome =
  | { readonly status: "swapped"; readonly head_oid: string }
  | { readonly status: "failed"; readonly failure: GitControlStoreFailure };

export interface CandidatePrepareRequest {
  readonly project_id: string;
  readonly operation_id: string;
  readonly target_ref: string;
}

export type CandidatePrepareOutcome =
  | { readonly status: "prepared"; readonly merge_commit: string }
  | { readonly status: "failed"; readonly failure: GitControlStoreFailure };

export interface TargetCasRequest {
  readonly project_id: string;
  readonly target_ref: string;
  readonly expected_commit: string;
  readonly new_commit: string;
}

export type TargetCasOutcome =
  | { readonly status: "swapped"; readonly commit: string }
  | { readonly status: "failed"; readonly failure: GitControlStoreFailure };

export interface GitControlStoreAdapter {
  readControl(input: ControlStoreReadInput): Promise<ControlStoreReadResult>;
  appendControl(input: ControlStoreAppendInput): Promise<ControlStoreAppendResult>;
  appendProjectRecord(input: ProjectRecordAppendInput): Promise<ProjectRecordAppendResult>;
  listOperationHeads(input: { readonly project_id: string }): Promise<OperationHeadListResult>;
  compareAndSwapOperation(input: OperationCasRequest): Promise<OperationCasOutcome>;
  prepareCandidate(input: CandidatePrepareRequest): Promise<CandidatePrepareOutcome>;
  compareAndSwapTarget(input: TargetCasRequest): Promise<TargetCasOutcome>;
}

export interface GitControlStoreAdapterOptions extends GitRunnerOptions {
  /** Credential-free canonical remote (HTTPS URL or local path). */
  readonly remote: string;
  /** Adapter-managed mirror clone directory; created on first use. */
  readonly mirror_root: string;
}

/** Mirror-local ref tracking the observed Control Ref tip. */
const MIRROR_CONTROL_REF = "refs/harness/control";
/** Mirror-local ref tracking the observed Target Ref tip. */
const MIRROR_TARGET_REF = "refs/harness/target";
/** Mirror-local namespace for observed remote heads (untrusted input). */
const MIRROR_HEADS_PREFIX = "refs/harness/head";
/** Scratch branch used to build the very first Control Ref commit. */
const ROOT_WORK_BRANCH = "refs/heads/harness-control-work";

const RECORD_FILE_PATTERN =
  /^records\/([0-9]{12})-(principal_snapshot|lease|remote_approval_decision)-([A-Za-z0-9_-]+)\.json$/u;
const REF_COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const REMOTE_REF_MISSING = /couldn't find remote ref|could not find remote ref/u;
const PUSH_REJECTED = /\[rejected\]|stale info|failed to push some refs/u;
const FETCH_NON_FAST_FORWARD = /non-fast-forward|\[rejected\]/u;

const CONTROL_SCHEMA_KEYS = {
  principal_snapshot: "principal-snapshot",
  lease: "lease",
  remote_approval_decision: "remote-approval-decision",
} as const;

type ControlSchemaKey = (typeof CONTROL_SCHEMA_KEYS)[keyof typeof CONTROL_SCHEMA_KEYS];

/** The record_kind literal widens to string in the envelope type; map explicitly. */
function controlSchemaKey(kind: string): ControlSchemaKey | undefined {
  switch (kind) {
    case "principal_snapshot":
      return CONTROL_SCHEMA_KEYS.principal_snapshot;
    case "lease":
      return CONTROL_SCHEMA_KEYS.lease;
    case "remote_approval_decision":
      return CONTROL_SCHEMA_KEYS.remote_approval_decision;
    default:
      return undefined;
  }
}

function failure(
  code: GitControlStoreErrorCode,
  summary: string,
  retryable = false,
): GitControlStoreFailure {
  return { code, summary, retryable };
}

function controlRecordId(record: ControlRecord): string {
  if (record.record_kind === "principal_snapshot") {
    return (record as PrincipalSnapshotRecord).snapshot_id;
  }
  if (record.record_kind === "lease") {
    return (record as LeaseRecord).lease_record_id;
  }
  return (record as RemoteApprovalDecisionRecord).remote_decision_id;
}

function controlRecordFileName(record: ControlRecord): string {
  const sequence = String(record.control_sequence).padStart(12, "0");
  return `records/${sequence}-${record.record_kind}-${controlRecordId(record)}.json`;
}

function canonicalFileContent(record: object): string {
  return `${canonicalizeJson(record)}\n`;
}

export function createGitControlStoreAdapter(
  options: GitControlStoreAdapterOptions,
): GitControlStoreAdapter {
  const run: GitRunner = createGitRunner(options);
  const remote = options.remote;
  const mirror = options.mirror_root;
  let mirrorReady = false;

  function remoteFailure(operation: string, stderr?: string): GitControlStoreFailure {
    const excerpt = stderr?.split("\n", 1)[0]?.slice(0, 200);
    return failure(
      "git_remote_unavailable",
      `git ${operation} against the remote failed${excerpt === undefined || excerpt.length === 0 ? "" : `: ${excerpt}`}`,
      true,
    );
  }

  /** Lazily clone the mirror and pin a deterministic commit identity. */
  async function ensureMirror(): Promise<GitControlStoreFailure | undefined> {
    if (mirrorReady) return undefined;
    if (!existsSync(join(mirror, ".git"))) {
      mkdirSync(dirname(mirror), { recursive: true });
      const cloned = await run("ensureMirror", dirname(mirror), [
        "clone",
        "--quiet",
        "--no-tags",
        remote,
        mirror,
      ]);
      if (!cloned.ok) return remoteFailure("clone", cloned.error.stderr);
      for (const [key, value] of [
        ["user.name", "harness-coordinator"],
        ["user.email", "harness-coordinator@harness.invalid"],
        ["commit.gpgsign", "false"],
      ] as const) {
        const configured = await run("ensureMirror", mirror, ["config", key, value]);
        if (!configured.ok) return remoteFailure("config", configured.error.stderr);
      }
    }
    mirrorReady = true;
    return undefined;
  }

  /**
   * Fetch the Control Ref without force: a non-fast-forward remote movement
   * fails the fetch, which is the fast-forward ancestry check required on
   * every read (spec §17.3). A missing ref is an empty chain, not an error.
   */
  async function fetchControlRef(
    controlRef: string,
  ): Promise<{ readonly head?: string } | { readonly failure: GitControlStoreFailure }> {
    const fetched = await run("fetchControlRef", mirror, [
      "fetch",
      "--no-tags",
      remote,
      `${controlRef}:${MIRROR_CONTROL_REF}`,
    ]);
    if (!fetched.ok) {
      const text = `${fetched.error.message}\n${fetched.error.stderr ?? ""}`;
      if (REMOTE_REF_MISSING.test(text)) return {};
      if (FETCH_NON_FAST_FORWARD.test(text)) {
        return {
          failure: failure(
            "control_ref_invalid",
            "control ref history moved non-fast-forward; manual repair is required",
          ),
        };
      }
      return { failure: remoteFailure("fetch", fetched.error.stderr) };
    }
    const head = await run("fetchControlRef", mirror, [
      "rev-parse",
      "--verify",
      MIRROR_CONTROL_REF,
    ]);
    if (!head.ok) return { failure: remoteFailure("rev-parse", head.error.stderr) };
    return { head: head.value.stdout.trim() };
  }

  /** Parse and fully validate one canonical record file; undefined rejects. */
  function parseControlRecord(
    path: string,
    content: string,
    expectedSequence: number,
  ): ControlRecord | undefined {
    const match = RECORD_FILE_PATTERN.exec(path);
    if (match === null) return undefined;
    const [, sequenceText, kind, recordId] = match;
    if (Number(sequenceText) !== expectedSequence) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return undefined;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as ControlRecord;
    if (record.record_kind !== kind) return undefined;
    if (controlRecordId(record) !== recordId) return undefined;
    if (record.control_sequence !== expectedSequence) return undefined;
    const schemaKey = controlSchemaKey(kind);
    if (schemaKey === undefined) return undefined;
    if (!PROTOCOL_1_2_SCHEMA_REGISTRY.validate(schemaKey, record).valid) {
      return undefined;
    }
    if (!verifyRecordEnvelope(record as unknown as Record<string, unknown>)) return undefined;
    if (content !== canonicalFileContent(record)) return undefined;
    return record;
  }

  /**
   * Read and validate the complete chain at `head`. Every record file must be
   * canonical, schema-valid, envelope-verified and linked by exact previous
   * digest; anything else fails closed with `control_ref_invalid`.
   */
  async function readControlChain(
    head: string,
  ): Promise<{ readonly records: ControlRecord[] } | { readonly failure: GitControlStoreFailure }> {
    const invalid = (summary: string) => ({ failure: failure("control_ref_invalid", summary) });
    const listed = await run("readControl", mirror, ["ls-tree", "-r", "--name-only", head]);
    if (!listed.ok) return { failure: remoteFailure("ls-tree", listed.error.stderr) };
    const paths = listed.value.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .sort();
    for (const path of paths) {
      if (!RECORD_FILE_PATTERN.test(path)) {
        return invalid(`control ref tree contains a non-record file: ${path}`);
      }
    }
    const checkedOut = await run("readControl", mirror, ["checkout", "--force", "--detach", head]);
    if (!checkedOut.ok) return { failure: remoteFailure("checkout", checkedOut.error.stderr) };

    const records: ControlRecord[] = [];
    for (const [index, path] of paths.entries()) {
      const content = readFileSync(join(mirror, ...path.split("/")), "utf8");
      const record = parseControlRecord(path, content, index + 1);
      if (record === undefined) {
        return invalid(`control record ${path} failed schema, digest or canonical-form checks`);
      }
      records.push(record);
    }
    try {
      if (records.length > 0) assertControlChain(records);
    } catch (error) {
      return invalid(error instanceof Error ? error.message : "control record chain is invalid");
    }
    return { records };
  }

  function projectRecordPath(record: CollaborationConnectionRecord | IntegrationRecord): string {
    if (record.record_kind === "collaboration_connection") {
      const connection = record as CollaborationConnectionRecord;
      const revision = String(connection.revision).padStart(12, "0");
      return `.harness/collaboration/connections/${connection.connection_id}/rev-${revision}.json`;
    }
    const integration = record as IntegrationRecord;
    return `.harness/artifacts/integrations/${integration.integration_id}.json`;
  }

  /** Validate a Ledger-bound record before it is committed to the target. */
  function projectRecordValid(record: CollaborationConnectionRecord | IntegrationRecord): boolean {
    const key =
      record.record_kind === "collaboration_connection"
        ? "collaboration-connection"
        : "integration";
    return (
      PROTOCOL_1_2_SCHEMA_REGISTRY.validate(key, record).valid &&
      verifyRecordEnvelope(record as unknown as Record<string, unknown>)
    );
  }

  /** Latest connection revision on the target ref, or undefined when absent. */
  async function readLatestConnection(
    targetRef: string,
  ): Promise<
    | { readonly connection?: CollaborationConnectionRecord }
    | { readonly failure: GitControlStoreFailure }
  > {
    const fetched = await run("readControl", mirror, [
      "fetch",
      "--no-tags",
      remote,
      `+${targetRef}:${MIRROR_TARGET_REF}`,
    ]);
    if (!fetched.ok) {
      const text = `${fetched.error.message}\n${fetched.error.stderr ?? ""}`;
      if (REMOTE_REF_MISSING.test(text)) return {};
      return { failure: remoteFailure("fetch", fetched.error.stderr) };
    }
    const head = await run("readControl", mirror, ["rev-parse", "--verify", MIRROR_TARGET_REF]);
    if (!head.ok) return { failure: remoteFailure("rev-parse", head.error.stderr) };
    const listed = await run("readControl", mirror, [
      "ls-tree",
      "-r",
      "--name-only",
      head.value.stdout.trim(),
      "--",
      ".harness/collaboration/connections",
    ]);
    if (!listed.ok) return { failure: remoteFailure("ls-tree", listed.error.stderr) };
    const paths = listed.value.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .sort();
    if (paths.length === 0) return {};

    const checkedOut = await run("readControl", mirror, [
      "checkout",
      "--force",
      "--detach",
      head.value.stdout.trim(),
    ]);
    if (!checkedOut.ok) return { failure: remoteFailure("checkout", checkedOut.error.stderr) };

    let latest: CollaborationConnectionRecord | undefined;
    for (const path of paths) {
      const match = /^\.harness\/collaboration\/connections\/([^/]+)\/rev-([0-9]{12})\.json$/u.exec(
        path,
      );
      if (match === null) {
        return { failure: failure("control_ref_invalid", `unexpected connection file: ${path}`) };
      }
      const content = readFileSync(join(mirror, ...path.split("/")), "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        return { failure: failure("control_ref_invalid", `connection file is not JSON: ${path}`) };
      }
      const record = parsed as CollaborationConnectionRecord;
      if (
        record.record_kind !== "collaboration_connection" ||
        record.connection_id !== match[1] ||
        Number(match[2]) !== (record as CollaborationConnectionRecord).revision ||
        !PROTOCOL_1_2_SCHEMA_REGISTRY.validate("collaboration-connection", record).valid ||
        !verifyRecordEnvelope(record as unknown as Record<string, unknown>) ||
        content !== canonicalFileContent(record)
      ) {
        return {
          failure: failure(
            "control_ref_invalid",
            `connection record ${path} failed schema, digest or canonical-form checks`,
          ),
        };
      }
      if (latest === undefined || record.revision > latest.revision) latest = record;
    }
    return latest === undefined ? {} : { connection: latest };
  }

  async function readControl(input: ControlStoreReadInput): Promise<ControlStoreReadResult> {
    const prepared = await ensureMirror();
    if (prepared !== undefined) return { status: "failed", failure: prepared };

    const fetched = await fetchControlRef(input.control_ref);
    if ("failure" in fetched) return { status: "failed", failure: fetched.failure };

    let records: ControlRecord[] = [];
    if (fetched.head !== undefined) {
      const chain = await readControlChain(fetched.head);
      if ("failure" in chain) return { status: "failed", failure: chain.failure };
      records = chain.records;
    }

    let latestConnection: CollaborationConnectionRecord | undefined;
    if (input.target_ref !== undefined) {
      const connection = await readLatestConnection(input.target_ref);
      if ("failure" in connection) return { status: "failed", failure: connection.failure };
      latestConnection = connection.connection;
    }

    return {
      status: "ok",
      snapshot: {
        ...(fetched.head === undefined ? {} : { control_head_oid: fetched.head }),
        control_records: records,
        ...(latestConnection === undefined ? {} : { latest_connection: latestConnection }),
      },
    };
  }

  /**
   * Point the scratch worktree at `head`, or at an unborn root branch when
   * the Control Ref does not exist yet. The mirror is Adapter-managed, so
   * discarding leftover state from a previously failed push is safe.
   */
  async function prepareWorktree(
    head: string | undefined,
  ): Promise<GitControlStoreFailure | undefined> {
    if (head !== undefined) {
      const checkedOut = await run("prepareWorktree", mirror, [
        "checkout",
        "--force",
        "--detach",
        head,
      ]);
      if (!checkedOut.ok) return remoteFailure("checkout", checkedOut.error.stderr);
      return undefined;
    }
    // Unborn-HEAD dance: move HEAD to a scratch name, drop any leftover root
    // branch from a previously lost race, then re-point HEAD at the work name.
    for (const args of [
      ["symbolic-ref", "HEAD", "refs/heads/harness-control-scratch"],
      ["update-ref", "-d", ROOT_WORK_BRANCH],
      ["symbolic-ref", "HEAD", ROOT_WORK_BRANCH],
      ["read-tree", "--empty"],
      ["clean", "-fdq"],
    ] as const) {
      const result = await run("prepareWorktree", mirror, args);
      if (!result.ok) return remoteFailure(args[0] ?? "prepareWorktree", result.error.stderr);
    }
    return undefined;
  }

  /** Commit the currently staged worktree state and return the commit OID. */
  async function commitWorktree(
    operation: string,
    path: string,
    message: string,
  ): Promise<{ readonly commit: string } | { readonly failure: GitControlStoreFailure }> {
    const staged = await run(operation, mirror, ["add", "--", path]);
    if (!staged.ok) return { failure: remoteFailure("add", staged.error.stderr) };
    const committed = await run(operation, mirror, [
      "commit",
      "--no-verify",
      "-m",
      message,
      "--",
      path,
    ]);
    if (!committed.ok) return { failure: remoteFailure("commit", committed.error.stderr) };
    const head = await run(operation, mirror, ["rev-parse", "HEAD"]);
    if (!head.ok) return { failure: remoteFailure("rev-parse", head.error.stderr) };
    return { commit: head.value.stdout.trim() };
  }

  async function appendControl(input: ControlStoreAppendInput): Promise<ControlStoreAppendResult> {
    const prepared = await ensureMirror();
    if (prepared !== undefined) return { status: "failed", failure: prepared };

    const fetched = await fetchControlRef(input.control_ref);
    if ("failure" in fetched) return { status: "failed", failure: fetched.failure };

    // CAS pre-check: the ref must still be where the caller's read observed it.
    if (input.expected_head_oid !== fetched.head) {
      return {
        status: "failed",
        failure: failure(
          "control_ref_cas_failed",
          "control ref head moved since the authoritative read; re-read and re-decide",
          true,
        ),
      };
    }

    let records: ControlRecord[] = [];
    if (fetched.head !== undefined) {
      const chain = await readControlChain(fetched.head);
      if ("failure" in chain) return { status: "failed", failure: chain.failure };
      records = chain.records;
    }

    // Validate the incoming record and its chain position before writing.
    const record = input.record;
    const schemaKey = controlSchemaKey(record.record_kind);
    if (
      schemaKey === undefined ||
      !PROTOCOL_1_2_SCHEMA_REGISTRY.validate(schemaKey, record).valid ||
      !verifyRecordEnvelope(record as unknown as Record<string, unknown>)
    ) {
      return {
        status: "failed",
        failure: failure(
          "control_ref_invalid",
          "record to append failed schema or envelope verification",
        ),
      };
    }
    try {
      assertControlChain([...records, record]);
    } catch (error) {
      return {
        status: "failed",
        failure: failure(
          "control_ref_invalid",
          error instanceof Error ? error.message : "record does not continue the control chain",
        ),
      };
    }

    const worktree = await prepareWorktree(fetched.head);
    if (worktree !== undefined) return { status: "failed", failure: worktree };

    const path = controlRecordFileName(record);
    mkdirSync(join(mirror, "records"), { recursive: true });
    writeFileSync(join(mirror, ...path.split("/")), canonicalFileContent(record));
    const committed = await commitWorktree(
      "appendControl",
      path,
      `control: ${record.record_kind} #${record.control_sequence}`,
    );
    if ("failure" in committed) return { status: "failed", failure: committed.failure };
    const candidateOid = committed.commit;

    // Control Ref updates are fast-forward only (spec §10).
    if (fetched.head !== undefined) {
      const ancestry = await run("appendControl", mirror, [
        "merge-base",
        "--is-ancestor",
        fetched.head,
        candidateOid,
      ]);
      if (!ancestry.ok) {
        return {
          status: "failed",
          failure: failure(
            "control_ref_invalid",
            "candidate commit does not descend from the expected control head",
          ),
        };
      }
    }

    const pushed = await run("appendControl", mirror, [
      "push",
      remote,
      `${candidateOid}:${input.control_ref}`,
      `--force-with-lease=${input.control_ref}:${input.expected_head_oid ?? ""}`,
    ]);
    if (!pushed.ok) {
      const text = `${pushed.error.message}\n${pushed.error.stderr ?? ""}`;
      if (PUSH_REJECTED.test(text)) {
        return {
          status: "failed",
          failure: failure(
            "control_ref_cas_failed",
            "control ref push lost the compare-and-swap; re-read and re-decide",
            true,
          ),
        };
      }
      return { status: "failed", failure: remoteFailure("push", pushed.error.stderr) };
    }
    await run("appendControl", mirror, ["update-ref", MIRROR_CONTROL_REF, candidateOid]);
    return { status: "appended", head_oid: candidateOid };
  }

  async function appendProjectRecord(
    input: ProjectRecordAppendInput,
  ): Promise<ProjectRecordAppendResult> {
    const prepared = await ensureMirror();
    if (prepared !== undefined) return { status: "failed", failure: prepared };
    if (!projectRecordValid(input.record)) {
      return {
        status: "failed",
        failure: failure(
          "control_ref_invalid",
          "project record failed schema or envelope verification",
        ),
      };
    }

    const fetched = await run("appendProjectRecord", mirror, [
      "fetch",
      "--no-tags",
      remote,
      `+${input.target_ref}:${MIRROR_TARGET_REF}`,
    ]);
    if (!fetched.ok) {
      const text = `${fetched.error.message}\n${fetched.error.stderr ?? ""}`;
      if (REMOTE_REF_MISSING.test(text)) {
        return {
          status: "failed",
          failure: failure(
            "git_remote_unavailable",
            `target ref ${input.target_ref} does not exist on the remote`,
          ),
        };
      }
      return { status: "failed", failure: remoteFailure("fetch", fetched.error.stderr) };
    }
    const head = await run("appendProjectRecord", mirror, [
      "rev-parse",
      "--verify",
      MIRROR_TARGET_REF,
    ]);
    if (!head.ok)
      return { status: "failed", failure: remoteFailure("rev-parse", head.error.stderr) };
    const base = head.value.stdout.trim();

    const worktree = await prepareWorktree(base);
    if (worktree !== undefined) return { status: "failed", failure: worktree };

    const path = projectRecordPath(input.record);
    mkdirSync(join(mirror, ...path.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(mirror, ...path.split("/")), canonicalFileContent(input.record));
    const committed = await commitWorktree(
      "appendProjectRecord",
      path,
      `collaboration: ${input.record.record_kind}`,
    );
    if ("failure" in committed) return { status: "failed", failure: committed.failure };

    const pushed = await run("appendProjectRecord", mirror, [
      "push",
      remote,
      `${committed.commit}:${input.target_ref}`,
      `--force-with-lease=${input.target_ref}:${base}`,
    ]);
    if (!pushed.ok) {
      const text = `${pushed.error.message}\n${pushed.error.stderr ?? ""}`;
      if (PUSH_REJECTED.test(text)) {
        return {
          status: "failed",
          failure: failure(
            "target_cas_failed",
            "target ref moved while committing the project record; re-read the target",
            true,
          ),
        };
      }
      return { status: "failed", failure: remoteFailure("push", pushed.error.stderr) };
    }
    await run("appendProjectRecord", mirror, ["update-ref", MIRROR_TARGET_REF, committed.commit]);
    return { status: "committed", commit: committed.commit };
  }

  /** Fetch every remote head into the untrusted observation namespace. */
  async function fetchRemoteHeads(): Promise<GitControlStoreFailure | undefined> {
    const fetched = await run("fetchRemoteHeads", mirror, [
      "fetch",
      "--no-tags",
      remote,
      `+refs/heads/*:${MIRROR_HEADS_PREFIX}/*`,
    ]);
    if (!fetched.ok) return remoteFailure("fetch", fetched.error.stderr);
    return undefined;
  }

  function operationMirrorRef(operationId: string): string {
    return `${MIRROR_HEADS_PREFIX}/operation/${operationId}`;
  }

  async function listOperationHeads(): Promise<OperationHeadListResult> {
    const prepared = await ensureMirror();
    if (prepared !== undefined) return { status: "failed", failure: prepared };
    const fetched = await fetchRemoteHeads();
    if (fetched !== undefined) return { status: "failed", failure: fetched };
    const listed = await run("listOperationHeads", mirror, [
      "for-each-ref",
      "--format=%(refname)%09%(objectname)",
      `${MIRROR_HEADS_PREFIX}/operation/`,
    ]);
    if (!listed.ok)
      return { status: "failed", failure: remoteFailure("for-each-ref", listed.error.stderr) };
    const prefix = `${MIRROR_HEADS_PREFIX}/operation/`;
    const heads: OperationHeadEntry[] = [];
    for (const line of listed.value.stdout.split("\n")) {
      if (line.trim().length === 0) continue;
      const [ref, oid] = line.split("\t");
      if (ref === undefined || oid === undefined || !ref.startsWith(prefix)) continue;
      heads.push({ operation_id: ref.slice(prefix.length), head_oid: oid.trim() });
    }
    return { status: "ok", heads };
  }

  async function compareAndSwapOperation(input: OperationCasRequest): Promise<OperationCasOutcome> {
    const drift = (summary: string): OperationCasOutcome => ({
      status: "failed",
      failure: failure("operation_ref_drift", summary, true),
    });
    if (!REF_COMPONENT_PATTERN.test(input.operation_id)) {
      return {
        status: "failed",
        failure: failure(
          "coordinator_unavailable",
          `operation id is not a valid ref component: ${input.operation_id}`,
        ),
      };
    }
    const prepared = await ensureMirror();
    if (prepared !== undefined) return { status: "failed", failure: prepared };
    const fetched = await fetchRemoteHeads();
    if (fetched !== undefined) return { status: "failed", failure: fetched };

    // The candidate must be fetchable from the remote; a purely local commit
    // cannot be verified and stays the replica's untrusted input.
    const exists = await run("compareAndSwapOperation", mirror, [
      "cat-file",
      "-e",
      `${input.candidate_commit}^{commit}`,
    ]);
    if (!exists.ok) {
      await run("compareAndSwapOperation", mirror, [
        "fetch",
        "--no-tags",
        remote,
        input.candidate_commit,
      ]);
      const retried = await run("compareAndSwapOperation", mirror, [
        "cat-file",
        "-e",
        `${input.candidate_commit}^{commit}`,
      ]);
      if (!retried.ok) {
        return drift("candidate commit is not available from the remote; re-publish it");
      }
    }

    const current = await run("compareAndSwapOperation", mirror, [
      "rev-parse",
      "--verify",
      "--quiet",
      operationMirrorRef(input.operation_id),
    ]);
    const currentOid = current.ok ? current.value.stdout.trim() : undefined;
    if (input.expected_head_oid !== currentOid) {
      return drift("operation head moved since the authoritative read; re-read and re-publish");
    }

    // A managed candidate must descend from the head it replaces.
    if (currentOid !== undefined) {
      const ancestry = await run("compareAndSwapOperation", mirror, [
        "merge-base",
        "--is-ancestor",
        currentOid,
        input.candidate_commit,
      ]);
      if (!ancestry.ok) {
        return drift("candidate commit does not descend from the operation head");
      }
    }

    const operationRef = `refs/heads/operation/${input.operation_id}`;
    const pushed = await run("compareAndSwapOperation", mirror, [
      "push",
      remote,
      `${input.candidate_commit}:${operationRef}`,
      `--force-with-lease=${operationRef}:${input.expected_head_oid ?? ""}`,
    ]);
    if (!pushed.ok) {
      const text = `${pushed.error.message}\n${pushed.error.stderr ?? ""}`;
      if (PUSH_REJECTED.test(text)) {
        return drift("operation ref push lost the compare-and-swap; re-read and re-publish");
      }
      return { status: "failed", failure: remoteFailure("push", pushed.error.stderr) };
    }
    await run("compareAndSwapOperation", mirror, [
      "update-ref",
      operationMirrorRef(input.operation_id),
      input.candidate_commit,
    ]);
    return { status: "swapped", head_oid: input.candidate_commit };
  }

  function prepareCandidate(): Promise<CandidatePrepareOutcome> {
    return Promise.resolve({
      status: "failed",
      failure: failure(
        "coordinator_unavailable",
        "candidate merge is implemented by the integration task",
        true,
      ),
    });
  }

  function compareAndSwapTarget(): Promise<TargetCasOutcome> {
    return Promise.resolve({
      status: "failed",
      failure: failure(
        "coordinator_unavailable",
        "target compare-and-swap is implemented by the integration task",
        true,
      ),
    });
  }

  return {
    readControl,
    appendControl,
    appendProjectRecord,
    listOperationHeads: () => listOperationHeads(),
    compareAndSwapOperation,
    prepareCandidate,
    compareAndSwapTarget,
  };
}
