import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  assertControlChain,
  canonicalizeJson,
  PROTOCOL_1_2_SCHEMA_REGISTRY,
  sha256Hex,
  validateSchema,
  verifyManifestDigest,
  verifyRecordEnvelope,
  type CollaborationConnectionRecord,
  type ControlRecord,
  type IntegrationRecord,
  type LeaseRecord,
  type LedgerOperation,
  type PrincipalSnapshotRecord,
  type RemoteApprovalDecisionRecord,
} from "@universal-harness-internal/core";

import {
  createGitRunner,
  type GitOutcome,
  type GitRunner,
  type GitRunnerOptions,
} from "./commands.js";

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
  | "baseline_drift"
  | "coordinator_unavailable"
  | "control_ref_cas_failed"
  | "control_ref_invalid"
  | "git_remote_unavailable"
  | "integration_conflict"
  | "ledger_resequence_failed"
  | "lease_fenced"
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
  /**
   * Frozen target ref used to locate the Ledger's latest connection record;
   * when omitted, the mirror-remembered target ref (`harness.target-ref`
   * config) is used, and a cold mirror reports no connection.
   */
  readonly target_ref?: string;
}

export interface ControlStoreSnapshot {
  readonly control_head_oid?: string;
  readonly control_records: readonly ControlRecord[];
  readonly latest_connection?: CollaborationConnectionRecord;
  /** Head of the connected target ref as fetched during this read. */
  readonly target_head_oid?: string;
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
  /**
   * Candidate commit the caller staged at
   * `refs/heads/harness/candidate/<operation_id>` (the CLI's publish pushes
   * exactly this ref). The Adapter fetches the staging ref by name — never a
   * bare OID, which GitHub/GitLab refuse without allowAnySHA1InWant — and
   * fails with `operation_ref_drift` when the ref is missing or names a
   * different commit.
   */
  readonly candidate_commit: string;
  /**
   * The caller's fencing token. Fencing authorization is the Coordinator's
   * decision, made before this call; the Adapter re-checks the token against
   * the Control Ref lease chain as a backstop and answers `lease_fenced`.
   */
  readonly fencing_token: number;
}

export type OperationCasOutcome =
  | { readonly status: "swapped"; readonly head_oid: string }
  | { readonly status: "failed"; readonly failure: GitControlStoreFailure };

/** One file the candidate plan writes into the merge tree (repo-relative POSIX path). */
export interface CandidateFileWrite {
  readonly path: string;
  readonly content: string;
}

/** An artifact file of an incoming LedgerOperation, digest-matched from the merge tree. */
export interface CandidateArtifact {
  /** Repo-relative POSIX path (under `.harness/artifacts/`). */
  readonly path: string;
  readonly content: string;
  readonly digest: string;
}

/**
 * The Ledger view the Coordinator's deterministic plan decides over: every
 * Target manifest, every incoming Operation Branch manifest and the artifact
 * bytes those incoming manifests bind. All of it is parsed from fetched Git
 * trees; nothing comes from the replica.
 */
export interface CandidateMergeView {
  readonly target_operations: readonly LedgerOperation[];
  readonly incoming_operations: readonly LedgerOperation[];
  readonly incoming_artifacts: readonly CandidateArtifact[];
}

export type CandidatePlan =
  | {
      readonly status: "planned";
      readonly record: IntegrationRecord;
      readonly writes: readonly CandidateFileWrite[];
    }
  | { readonly status: "failed"; readonly failure: GitControlStoreFailure };

export interface CandidatePrepareRequest {
  readonly project_id: string;
  readonly operation_id: string;
  readonly target_ref: string;
  /** Frozen Target head the candidate must build on (design §14.1). */
  readonly expected_target_commit: string;
  /** Frozen Operation Branch head; the candidate's second parent. */
  readonly operation_commit: string;
  /**
   * The Coordinator's pure, deterministic resequencing and record planner.
   * Called exactly once with the merged Ledger view; a failed plan aborts the
   * merge and leaves every remote ref untouched.
   */
  readonly plan: (merge: CandidateMergeView) => CandidatePlan;
}

export type CandidatePrepareOutcome =
  | {
      readonly status: "prepared";
      readonly candidate_commit: string;
      readonly tree_oid: string;
      readonly integration_id: string;
      /**
       * Scratch checkout of the candidate tree, owned by the Adapter and kept
       * read-only for the caller; invalidated by the next prepareCandidate
       * call. Used to re-run the existing tree-based validators.
       */
      readonly candidate_root: string;
    }
  | { readonly status: "failed"; readonly failure: GitControlStoreFailure };

export interface CandidateReadRequest {
  readonly project_id: string;
  readonly integration_id: string;
}

export type CandidateReadOutcome =
  | {
      readonly status: "found";
      readonly candidate_commit: string;
      readonly tree_oid: string;
      readonly record: IntegrationRecord;
    }
  | { readonly status: "missing" }
  | { readonly status: "failed"; readonly failure: GitControlStoreFailure };

export interface IntegrationRecordReadRequest {
  readonly project_id: string;
  readonly target_ref: string;
  readonly integration_id: string;
}

export type IntegrationRecordReadOutcome =
  | { readonly status: "found"; readonly commit: string; readonly record: IntegrationRecord }
  | { readonly status: "missing" }
  | { readonly status: "failed"; readonly failure: GitControlStoreFailure };

export interface IntegrationRecordListRequest {
  readonly project_id: string;
  /**
   * Target ref whose tree carries the accepted records; omitted on a cold
   * start with no connection, in which case `accepted` is empty.
   */
  readonly target_ref?: string;
}

/**
 * Every IntegrationRecord recoverable from Git: `staged` are the prepared
 * records on the candidate staging refs (operation-candidate refs share the
 * namespace but carry no record file and are skipped), `accepted` are the
 * records that landed on the Target tree. The Coordinator merges them
 * staged-first so an accepted record overwrites its stale staged twin.
 */
export type IntegrationRecordListOutcome =
  | {
      readonly status: "ok";
      readonly staged: readonly IntegrationRecord[];
      readonly accepted: readonly IntegrationRecord[];
    }
  | { readonly status: "failed"; readonly failure: GitControlStoreFailure };

export interface TargetCasRequest {
  readonly project_id: string;
  readonly target_ref: string;
  readonly expected_commit: string;
  readonly new_commit: string;
  /**
   * Integration whose candidate staging ref is cleaned up best-effort after
   * a successful swap. Optional so non-integration callers stay valid.
   */
  readonly integration_id?: string;
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
  readCandidate(input: CandidateReadRequest): Promise<CandidateReadOutcome>;
  readIntegrationRecord(input: IntegrationRecordReadRequest): Promise<IntegrationRecordReadOutcome>;
  listIntegrationRecords(
    input: IntegrationRecordListRequest,
  ): Promise<IntegrationRecordListOutcome>;
  compareAndSwapTarget(input: TargetCasRequest): Promise<TargetCasOutcome>;
}

export interface GitControlStoreAdapterOptions extends GitRunnerOptions {
  /** Credential-free canonical remote (HTTPS URL or local path). */
  readonly remote: string;
  /** Adapter-managed mirror clone directory; created on first use. */
  readonly mirror_root: string;
  /**
   * Protected Control Ref whose lease chain backstops Operation Ref fencing;
   * fixed to `refs/heads/harness/control` by default (spec §10).
   */
  readonly control_ref?: string;
}

/** Mirror-local ref tracking the observed Control Ref tip. */
const MIRROR_CONTROL_REF = "refs/harness/control";
/** Mirror-local ref tracking the observed Target Ref tip. */
const MIRROR_TARGET_REF = "refs/harness/target";
/** Mirror-local namespace for observed remote heads (untrusted input). */
const MIRROR_HEADS_PREFIX = "refs/harness/head";
/** Scratch branch used to build the very first Control Ref commit. */
const ROOT_WORK_BRANCH = "refs/heads/harness-control-work";
/** Protected Control Ref when the caller does not pin one (spec §10). */
const DEFAULT_CONTROL_REF = "refs/heads/harness/control";
/** Mirror config key remembering the target ref of the connected project. */
const TARGET_REF_CONFIG_KEY = "harness.target-ref";
/**
 * Remote staging namespace for prepared integration candidates. Candidates
 * are untrusted until the Target CAS accepts them; staging never touches a
 * managed ref (Target, Operation or Control).
 */
const CANDIDATE_STAGING_PREFIX = "refs/heads/harness/candidate";
/** Mirror-local namespace tracking the observed staging refs. */
const MIRROR_CANDIDATE_PREFIX = "refs/harness/candidate";

const RECORD_FILE_PATTERN =
  /^records\/([0-9]{12})-(principal_snapshot|lease|remote_approval_decision)-([A-Za-z0-9_-]+)\.json$/u;
const REF_COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
/** Full lowercase SHA-1 hex; anything else never reaches a git argument. */
const COMMIT_OID_PATTERN = /^[0-9a-f]{40}$/u;
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

/** Map a failed git invocation to a retryable remote-unavailability failure. */
function remoteFailure(operation: string, stderr?: string): GitControlStoreFailure {
  const excerpt = stderr?.split("\n", 1)[0]?.slice(0, 200);
  return failure(
    "git_remote_unavailable",
    `git ${operation} against the remote failed${excerpt === undefined || excerpt.length === 0 ? "" : `: ${excerpt}`}`,
    true,
  );
}

/**
 * Map a push outcome: success yields undefined, a rejected push yields the
 * caller's compare-and-swap failure, anything else is a remote failure.
 */
function mapPushOutcome(
  pushed: GitOutcome,
  casCode: GitControlStoreErrorCode,
  casSummary: string,
): GitControlStoreFailure | undefined {
  if (pushed.ok) return undefined;
  const text = `${pushed.error.message}\n${pushed.error.stderr ?? ""}`;
  if (PUSH_REJECTED.test(text)) return failure(casCode, casSummary, true);
  return remoteFailure("push", pushed.error.stderr);
}

/** Schema and envelope checks shared by every record validator. */
function recordShapeValid(record: object, schemaKey: string): boolean {
  return (
    PROTOCOL_1_2_SCHEMA_REGISTRY.validate(schemaKey, record).valid &&
    verifyRecordEnvelope(record as unknown as Record<string, unknown>)
  );
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
  const controlRef = options.control_ref ?? DEFAULT_CONTROL_REF;
  let mirrorReady = false;

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
   * Remember the connected project's target ref in the mirror's config, so
   * later reads without an explicit target ref (the common command path) can
   * still locate the Ledger connection record. Best-effort: a config write
   * failure never blocks the authoritative operation it follows.
   */
  async function rememberTargetRef(targetRef: string): Promise<void> {
    const current = await rememberedTargetRef();
    if (current === targetRef) return;
    await run("rememberTargetRef", mirror, ["config", TARGET_REF_CONFIG_KEY, targetRef]);
  }

  /** The remembered target ref, or undefined on a cold mirror. */
  async function rememberedTargetRef(): Promise<string | undefined> {
    const read = await run("rememberedTargetRef", mirror, [
      "config",
      "--get",
      TARGET_REF_CONFIG_KEY,
    ]);
    if (!read.ok) return undefined;
    const value = read.value.stdout.trim();
    return value.length === 0 ? undefined : value;
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
    if (!recordShapeValid(record, schemaKey)) return undefined;
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
    return recordShapeValid(record, key);
  }

  /** Latest connection revision on the target ref, or undefined when absent. */
  async function readLatestConnection(targetRef: string): Promise<
    | {
        readonly head?: string;
        readonly connection?: CollaborationConnectionRecord;
      }
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
    await rememberTargetRef(targetRef);
    const head = await run("readControl", mirror, ["rev-parse", "--verify", MIRROR_TARGET_REF]);
    if (!head.ok) return { failure: remoteFailure("rev-parse", head.error.stderr) };
    const headOid = head.value.stdout.trim();
    const listed = await run("readControl", mirror, [
      "ls-tree",
      "-r",
      "--name-only",
      headOid,
      "--",
      ".harness/collaboration/connections",
    ]);
    if (!listed.ok) return { failure: remoteFailure("ls-tree", listed.error.stderr) };
    const paths = listed.value.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .sort();
    if (paths.length === 0) return { head: headOid };

    const checkedOut = await run("readControl", mirror, [
      "checkout",
      "--force",
      "--detach",
      headOid,
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
        !recordShapeValid(record, "collaboration-connection") ||
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
    return { head: headOid, ...(latest === undefined ? {} : { connection: latest }) };
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
    let targetHeadOid: string | undefined;
    // Without an explicit target ref, fall back to the one the mirror
    // remembered from earlier writes; a cold mirror simply reports no
    // connection (fail-closed until a connect names the target).
    const targetRef = input.target_ref ?? (await rememberedTargetRef());
    if (targetRef !== undefined) {
      const connection = await readLatestConnection(targetRef);
      if ("failure" in connection) return { status: "failed", failure: connection.failure };
      latestConnection = connection.connection;
      targetHeadOid = connection.head;
    }

    return {
      status: "ok",
      snapshot: {
        ...(fetched.head === undefined ? {} : { control_head_oid: fetched.head }),
        control_records: records,
        ...(latestConnection === undefined ? {} : { latest_connection: latestConnection }),
        ...(targetHeadOid === undefined ? {} : { target_head_oid: targetHeadOid }),
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
    if (
      input.expected_head_oid !== undefined &&
      !COMMIT_OID_PATTERN.test(input.expected_head_oid)
    ) {
      return {
        status: "failed",
        failure: failure(
          "coordinator_unavailable",
          `expected head is not a full commit oid: ${input.expected_head_oid}`,
        ),
      };
    }
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
    if (schemaKey === undefined || !recordShapeValid(record, schemaKey)) {
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
    const pushFailure = mapPushOutcome(
      pushed,
      "control_ref_cas_failed",
      "control ref push lost the compare-and-swap; re-read and re-decide",
    );
    if (pushFailure !== undefined) return { status: "failed", failure: pushFailure };
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
    await rememberTargetRef(input.target_ref);
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
    const pushFailure = mapPushOutcome(
      pushed,
      "target_cas_failed",
      "target ref moved while committing the project record; re-read the target",
    );
    if (pushFailure !== undefined) return { status: "failed", failure: pushFailure };
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
    if (!COMMIT_OID_PATTERN.test(input.candidate_commit)) {
      return {
        status: "failed",
        failure: failure(
          "coordinator_unavailable",
          `candidate commit is not a full commit oid: ${input.candidate_commit}`,
        ),
      };
    }
    if (
      input.expected_head_oid !== undefined &&
      !COMMIT_OID_PATTERN.test(input.expected_head_oid)
    ) {
      return {
        status: "failed",
        failure: failure(
          "coordinator_unavailable",
          `expected head is not a full commit oid: ${input.expected_head_oid}`,
        ),
      };
    }
    const prepared = await ensureMirror();
    if (prepared !== undefined) return { status: "failed", failure: prepared };
    const fetched = await fetchRemoteHeads();
    if (fetched !== undefined) return { status: "failed", failure: fetched };

    // The candidate must be reachable through its staging ref; fetching a
    // bare OID only works when the server enables allowAnySHA1InWant, which
    // GitHub/GitLab refuse. Fetch by ref name and require the staging ref to
    // name exactly the published commit.
    const stagingRef = `${CANDIDATE_STAGING_PREFIX}/${input.operation_id}`;
    const mirrorStagingRef = `${MIRROR_CANDIDATE_PREFIX}/${input.operation_id}`;
    const fetchedStaging = await run("compareAndSwapOperation", mirror, [
      "fetch",
      "--no-tags",
      remote,
      `+${stagingRef}:${mirrorStagingRef}`,
    ]);
    if (!fetchedStaging.ok) {
      const text = `${fetchedStaging.error.message}\n${fetchedStaging.error.stderr ?? ""}`;
      if (REMOTE_REF_MISSING.test(text)) {
        return drift(
          `candidate staging ref ${stagingRef} is not available from the remote; re-publish it`,
        );
      }
      return {
        status: "failed",
        failure: remoteFailure("fetch", fetchedStaging.error.stderr),
      };
    }
    const stagedHead = await run("compareAndSwapOperation", mirror, [
      "rev-parse",
      "--verify",
      mirrorStagingRef,
    ]);
    if (!stagedHead.ok) {
      return {
        status: "failed",
        failure: remoteFailure("rev-parse", stagedHead.error.stderr),
      };
    }
    if (stagedHead.value.stdout.trim() !== input.candidate_commit) {
      return drift("candidate staging ref head does not name the published commit; re-publish it");
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

    if (currentOid !== undefined) {
      // A managed candidate must descend from the head it replaces.
      const ancestry = await run("compareAndSwapOperation", mirror, [
        "merge-base",
        "--is-ancestor",
        currentOid,
        input.candidate_commit,
      ]);
      if (!ancestry.ok) {
        return drift("candidate commit does not descend from the operation head");
      }
    } else {
      // First publish: no operation ref exists yet, so the candidate must
      // descend from the connected target ref's head (the operation
      // baseline). A mirror that never saw a connect fails closed.
      const targetRef = await rememberedTargetRef();
      if (targetRef === undefined) {
        return {
          status: "failed",
          failure: failure(
            "coordinator_unavailable",
            "first publish has no operation baseline; connect the project first",
          ),
        };
      }
      const fetchedTarget = await run("compareAndSwapOperation", mirror, [
        "fetch",
        "--no-tags",
        remote,
        `+${targetRef}:${MIRROR_TARGET_REF}`,
      ]);
      if (!fetchedTarget.ok) {
        const text = `${fetchedTarget.error.message}\n${fetchedTarget.error.stderr ?? ""}`;
        if (REMOTE_REF_MISSING.test(text)) {
          return {
            status: "failed",
            failure: failure(
              "coordinator_unavailable",
              `target ref ${targetRef} does not exist on the remote; reconnect the project`,
            ),
          };
        }
        return { status: "failed", failure: remoteFailure("fetch", fetchedTarget.error.stderr) };
      }
      const baseline = await run("compareAndSwapOperation", mirror, [
        "rev-parse",
        "--verify",
        MIRROR_TARGET_REF,
      ]);
      if (!baseline.ok) {
        return { status: "failed", failure: remoteFailure("rev-parse", baseline.error.stderr) };
      }
      const ancestry = await run("compareAndSwapOperation", mirror, [
        "merge-base",
        "--is-ancestor",
        baseline.value.stdout.trim(),
        input.candidate_commit,
      ]);
      if (!ancestry.ok) {
        return drift("candidate commit does not descend from the target ref baseline");
      }
    }

    // Fencing backstop: when the Control Ref carries a lease chain for this
    // operation, its tip must be live (granted/renewed) and hold the
    // presented token. The Coordinator remains the fencing authority; a
    // control ref without a lease chain for this operation skips the check.
    const control = await fetchControlRef(controlRef);
    if ("failure" in control) return { status: "failed", failure: control.failure };
    if (control.head !== undefined) {
      const chain = await readControlChain(control.head);
      if ("failure" in chain) return { status: "failed", failure: chain.failure };
      const leases = chain.records.filter(
        (record): record is LeaseRecord =>
          record.record_kind === "lease" &&
          (record as LeaseRecord).resource_kind === "operation" &&
          (record as LeaseRecord).resource_id === input.operation_id,
      );
      const tip = leases[leases.length - 1];
      if (
        tip !== undefined &&
        (tip.fencing_token !== input.fencing_token ||
          (tip.state !== "granted" && tip.state !== "renewed"))
      ) {
        return {
          status: "failed",
          failure: failure(
            "lease_fenced",
            `operation ${input.operation_id} is held by lease ${tip.lease_id} with fencing token ${tip.fencing_token} in state ${tip.state}; token ${input.fencing_token} may not publish`,
          ),
        };
      }
    }

    const operationRef = `refs/heads/operation/${input.operation_id}`;
    const pushed = await run("compareAndSwapOperation", mirror, [
      "push",
      remote,
      `${input.candidate_commit}:${operationRef}`,
      `--force-with-lease=${operationRef}:${input.expected_head_oid ?? ""}`,
    ]);
    const pushFailure = mapPushOutcome(
      pushed,
      "operation_ref_drift",
      "operation ref push lost the compare-and-swap; re-read and re-publish",
    );
    if (pushFailure !== undefined) return { status: "failed", failure: pushFailure };
    await run("compareAndSwapOperation", mirror, [
      "update-ref",
      operationMirrorRef(input.operation_id),
      input.candidate_commit,
    ]);
    return { status: "swapped", head_oid: input.candidate_commit };
  }

  // --- Integration candidates (design §14, plan M3 Task 6 step 3) -----------

  /**
   * Scratch worktree where the candidate merge is built and validated. It is
   * a per-mirror singleton: correctness relies on the design §3 single
   * Coordinator executing integration commands serially per project;
   * cross-project concurrency against one mirror is out of M3 scope.
   */
  function candidateWorktree(): string {
    return join(dirname(mirror), "candidate-worktree");
  }

  function integrationRecordPath(integrationId: string): string {
    return `.harness/artifacts/integrations/${integrationId}.json`;
  }

  /** Repo-relative write paths stay inside `.harness` and never traverse. */
  function candidateWritePathValid(path: string): boolean {
    return (
      /^\.harness\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(path) &&
      !path.includes("//") &&
      !path.split("/").some((segment) => segment === "." || segment === "..")
    );
  }

  /** Parse and fully validate one ledger manifest fetched from a commit. */
  async function readManifestAt(
    operation: string,
    commit: string,
    path: string,
  ): Promise<
    { readonly manifest: LedgerOperation } | { readonly failure: GitControlStoreFailure }
  > {
    const shown = await run(operation, mirror, ["show", `${commit}:${path}`]);
    if (!shown.ok) {
      return {
        failure: failure(
          "ledger_resequence_failed",
          `cannot read ledger manifest ${path} from ${commit}`,
        ),
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(shown.value.stdout);
    } catch {
      return {
        failure: failure("ledger_resequence_failed", `ledger manifest ${path} is not JSON`),
      };
    }
    if (!validateSchema("ledger-operation", parsed).valid) {
      return {
        failure: failure(
          "ledger_resequence_failed",
          `ledger manifest ${path} failed schema validation`,
        ),
      };
    }
    const manifest = parsed as LedgerOperation;
    if (!verifyManifestDigest(manifest)) {
      return {
        failure: failure(
          "ledger_resequence_failed",
          `ledger manifest ${path} has a digest that does not recompute`,
        ),
      };
    }
    return { manifest };
  }

  /** Every ledger manifest committed in one commit's `.harness` tree. */
  async function readManifestSet(
    operation: string,
    commit: string,
  ): Promise<
    { readonly manifests: LedgerOperation[] } | { readonly failure: GitControlStoreFailure }
  > {
    const listed = await run(operation, mirror, [
      "ls-tree",
      "-r",
      "--name-only",
      commit,
      "--",
      ".harness/ledger/operations",
    ]);
    if (!listed.ok) return { failure: remoteFailure("ls-tree", listed.error.stderr) };
    const paths = listed.value.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .sort();
    const manifests: LedgerOperation[] = [];
    for (const path of paths) {
      const read = await readManifestAt(operation, commit, path);
      if ("failure" in read) return { failure: read.failure };
      manifests.push(read.manifest);
    }
    return { manifests };
  }

  /** Remove and recreate the scratch worktree detached at `commit`. */
  async function resetCandidateWorktree(
    commit: string,
  ): Promise<GitControlStoreFailure | undefined> {
    const scratch = candidateWorktree();
    await run("prepareCandidate", mirror, ["worktree", "remove", "--force", scratch]);
    const added = await run("prepareCandidate", mirror, [
      "worktree",
      "add",
      "--detach",
      scratch,
      commit,
    ]);
    if (!added.ok) return remoteFailure("worktree add", added.error.stderr);
    return undefined;
  }

  /** Best-effort scratch cleanup on failure paths; never masks the failure. */
  async function discardCandidateWorktree(): Promise<void> {
    const scratch = candidateWorktree();
    await run("prepareCandidate", scratch, ["merge", "--abort"]);
    await run("prepareCandidate", mirror, ["worktree", "remove", "--force", scratch]);
  }

  async function prepareCandidate(
    input: CandidatePrepareRequest,
  ): Promise<CandidatePrepareOutcome> {
    if (!REF_COMPONENT_PATTERN.test(input.operation_id)) {
      return {
        status: "failed",
        failure: failure(
          "coordinator_unavailable",
          `operation id is not a valid ref component: ${input.operation_id}`,
        ),
      };
    }
    for (const [label, oid] of [
      ["expected target commit", input.expected_target_commit],
      ["operation commit", input.operation_commit],
    ] as const) {
      if (!COMMIT_OID_PATTERN.test(oid)) {
        return {
          status: "failed",
          failure: failure("coordinator_unavailable", `${label} is not a full commit oid: ${oid}`),
        };
      }
    }
    const prepared = await ensureMirror();
    if (prepared !== undefined) return { status: "failed", failure: prepared };

    // Fetch both frozen heads and prove they still match the command's pins.
    const fetchedTarget = await run("prepareCandidate", mirror, [
      "fetch",
      "--no-tags",
      remote,
      `+${input.target_ref}:${MIRROR_TARGET_REF}`,
    ]);
    if (!fetchedTarget.ok) {
      return { status: "failed", failure: remoteFailure("fetch", fetchedTarget.error.stderr) };
    }
    const targetHead = await run("prepareCandidate", mirror, [
      "rev-parse",
      "--verify",
      MIRROR_TARGET_REF,
    ]);
    if (!targetHead.ok) {
      return { status: "failed", failure: remoteFailure("rev-parse", targetHead.error.stderr) };
    }
    if (targetHead.value.stdout.trim() !== input.expected_target_commit) {
      return {
        status: "failed",
        failure: failure(
          "baseline_drift",
          "target head moved since the command froze it; re-read and re-prepare",
          true,
        ),
      };
    }
    const operationRef = `refs/heads/operation/${input.operation_id}`;
    const fetchedOperation = await run("prepareCandidate", mirror, [
      "fetch",
      "--no-tags",
      remote,
      `+${operationRef}:${operationMirrorRef(input.operation_id)}`,
    ]);
    if (!fetchedOperation.ok) {
      const text = `${fetchedOperation.error.message}\n${fetchedOperation.error.stderr ?? ""}`;
      if (REMOTE_REF_MISSING.test(text)) {
        return {
          status: "failed",
          failure: failure(
            "operation_ref_drift",
            `operation branch ${operationRef} is not published on the remote`,
          ),
        };
      }
      return { status: "failed", failure: remoteFailure("fetch", fetchedOperation.error.stderr) };
    }
    const operationHead = await run("prepareCandidate", mirror, [
      "rev-parse",
      "--verify",
      operationMirrorRef(input.operation_id),
    ]);
    if (!operationHead.ok) {
      return { status: "failed", failure: remoteFailure("rev-parse", operationHead.error.stderr) };
    }
    if (operationHead.value.stdout.trim() !== input.operation_commit) {
      return {
        status: "failed",
        failure: failure(
          "operation_ref_drift",
          "operation head moved since the command froze it; re-read and re-prepare",
          true,
        ),
      };
    }

    const base = await run("prepareCandidate", mirror, [
      "merge-base",
      input.expected_target_commit,
      input.operation_commit,
    ]);
    if (!base.ok) {
      return {
        status: "failed",
        failure: failure(
          "integration_conflict",
          "target and operation branch share no merge base; resolve the histories manually",
        ),
      };
    }
    const contained = await run("prepareCandidate", mirror, [
      "merge-base",
      "--is-ancestor",
      input.operation_commit,
      input.expected_target_commit,
    ]);
    if (contained.ok) {
      return {
        status: "failed",
        failure: failure(
          "coordinator_unavailable",
          "operation branch is already contained in the target; there is nothing to integrate",
        ),
      };
    }

    // Three-way merge in the scratch worktree, never committed automatically.
    const worktree = await resetCandidateWorktree(input.expected_target_commit);
    if (worktree !== undefined) return { status: "failed", failure: worktree };
    const scratch = candidateWorktree();
    const merged = await run("prepareCandidate", scratch, [
      "merge",
      "--no-commit",
      "--no-ff",
      input.operation_commit,
    ]);
    if (!merged.ok) {
      const unmerged = await run("prepareCandidate", scratch, ["ls-files", "-u"]);
      const conflicted = unmerged.ok
        ? [
            ...new Set(
              unmerged.value.stdout
                .split("\n")
                .map((line) => line.split("\t")[1]?.trim() ?? "")
                .filter((path) => path.length > 0),
            ),
          ].sort()
        : [];
      await discardCandidateWorktree();
      if (conflicted.length > 0) {
        return {
          status: "failed",
          failure: failure(
            "integration_conflict",
            `text conflict in: ${conflicted.join(", ")}; resolve it on the operation branch and re-prepare`,
          ),
        };
      }
      return {
        status: "failed",
        failure: remoteFailure("merge", merged.error.stderr),
      };
    }

    // The coordinator's deterministic plan decides over the parsed Ledger view.
    const targetOperations = await readManifestSet(
      "prepareCandidate",
      input.expected_target_commit,
    );
    if ("failure" in targetOperations) {
      await discardCandidateWorktree();
      return { status: "failed", failure: targetOperations.failure };
    }
    const incomingOperations = await readManifestSet("prepareCandidate", input.operation_commit);
    if ("failure" in incomingOperations) {
      await discardCandidateWorktree();
      return { status: "failed", failure: incomingOperations.failure };
    }
    const incomingDigests = new Set(
      incomingOperations.manifests.flatMap((manifest) => manifest.artifact_digests),
    );
    const incomingArtifacts: CandidateArtifact[] = [];
    const artifactsRoot = join(scratch, ".harness", "artifacts");
    const walk = (directory: string, relativePrefix: string): void => {
      if (!existsSync(directory)) return;
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
        left.name < right.name ? -1 : 1,
      )) {
        const relative =
          relativePrefix.length === 0 ? entry.name : `${relativePrefix}/${entry.name}`;
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(absolute, relative);
        } else if (entry.isFile()) {
          const content = readFileSync(absolute, "utf8");
          const digest = sha256Hex(content);
          if (incomingDigests.has(digest)) {
            incomingArtifacts.push({ path: `.harness/artifacts/${relative}`, content, digest });
          }
        }
      }
    };
    walk(artifactsRoot, "");

    const plan = input.plan({
      target_operations: targetOperations.manifests,
      incoming_operations: incomingOperations.manifests,
      incoming_artifacts: incomingArtifacts,
    });
    if (plan.status === "failed") {
      await discardCandidateWorktree();
      return { status: "failed", failure: plan.failure };
    }
    for (const write of plan.writes) {
      if (!candidateWritePathValid(write.path)) {
        await discardCandidateWorktree();
        return {
          status: "failed",
          failure: failure(
            "ledger_resequence_failed",
            `candidate plan wrote an illegal path: ${JSON.stringify(write.path)}`,
          ),
        };
      }
    }

    // Apply the plan's deterministic writes on top of the clean merge and
    // create the two-parent candidate (Target first, Operation second).
    for (const write of plan.writes) {
      const absolute = join(scratch, ...write.path.split("/"));
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, write.content);
    }
    const staged = await run("prepareCandidate", scratch, [
      "add",
      "--",
      ...plan.writes.map((write) => write.path),
    ]);
    if (!staged.ok) {
      await discardCandidateWorktree();
      return { status: "failed", failure: remoteFailure("add", staged.error.stderr) };
    }
    const committed = await run("prepareCandidate", scratch, [
      "-c",
      "user.name=harness-coordinator",
      "-c",
      "user.email=harness-coordinator@harness.invalid",
      "commit",
      "--no-verify",
      "-m",
      `integration: ${plan.record.integration_id}`,
    ]);
    if (!committed.ok) {
      await discardCandidateWorktree();
      return { status: "failed", failure: remoteFailure("commit", committed.error.stderr) };
    }
    const candidate = await run("prepareCandidate", scratch, ["rev-parse", "HEAD"]);
    if (!candidate.ok) {
      await discardCandidateWorktree();
      return { status: "failed", failure: remoteFailure("rev-parse", candidate.error.stderr) };
    }
    const candidateCommit = candidate.value.stdout.trim();

    // The candidate identity rule (design §14.3): exactly the two expected
    // parents in order, Target then Operation.
    const parents = await run("prepareCandidate", scratch, [
      "rev-list",
      "--parents",
      "-n",
      "1",
      "HEAD",
    ]);
    const tokens = parents.ok ? parents.value.stdout.trim().split(" ") : [];
    if (
      tokens.length !== 3 ||
      tokens[1] !== input.expected_target_commit ||
      tokens[2] !== input.operation_commit
    ) {
      await discardCandidateWorktree();
      return {
        status: "failed",
        failure: failure(
          "coordinator_unavailable",
          "candidate commit does not have exactly the expected target and operation parents",
        ),
      };
    }
    const tree = await run("prepareCandidate", scratch, ["rev-parse", "HEAD^{tree}"]);
    if (!tree.ok) {
      await discardCandidateWorktree();
      return { status: "failed", failure: remoteFailure("rev-parse", tree.error.stderr) };
    }

    // Stage the candidate on the remote so a restarted coordinator and the
    // replicas can fetch and verify it. The staging ref is scoped to the
    // content-derived integration id; no managed ref is ever updated here.
    const stagingRef = `${CANDIDATE_STAGING_PREFIX}/${plan.record.integration_id}`;
    const mirrorStagingRef = `${MIRROR_CANDIDATE_PREFIX}/${plan.record.integration_id}`;
    const fetchedStaging = await run("prepareCandidate", mirror, [
      "fetch",
      "--no-tags",
      remote,
      `+${stagingRef}:${mirrorStagingRef}`,
    ]);
    let previousStaging = "";
    if (fetchedStaging.ok) {
      const current = await run("prepareCandidate", mirror, [
        "rev-parse",
        "--verify",
        "--quiet",
        mirrorStagingRef,
      ]);
      if (current.ok) previousStaging = current.value.stdout.trim();
    } else {
      const text = `${fetchedStaging.error.message}\n${fetchedStaging.error.stderr ?? ""}`;
      if (!REMOTE_REF_MISSING.test(text)) {
        await discardCandidateWorktree();
        return {
          status: "failed",
          failure: remoteFailure("fetch", fetchedStaging.error.stderr),
        };
      }
    }
    const pushed = await run("prepareCandidate", mirror, [
      "push",
      remote,
      `${candidateCommit}:${stagingRef}`,
      `--force-with-lease=${stagingRef}:${previousStaging}`,
    ]);
    const pushFailure = mapPushOutcome(
      pushed,
      "coordinator_unavailable",
      "candidate staging push lost the compare-and-swap; retry the prepare",
    );
    if (pushFailure !== undefined) {
      await discardCandidateWorktree();
      return { status: "failed", failure: pushFailure };
    }
    await run("prepareCandidate", mirror, ["update-ref", mirrorStagingRef, candidateCommit]);

    return {
      status: "prepared",
      candidate_commit: candidateCommit,
      tree_oid: tree.value.stdout.trim(),
      integration_id: plan.record.integration_id,
      candidate_root: scratch,
    };
  }

  /** Read and validate the IntegrationRecord file inside one commit's tree. */
  async function readRecordAt(
    operation: string,
    commit: string,
    integrationId: string,
    invalidCode: GitControlStoreErrorCode,
  ): Promise<
    { readonly record: IntegrationRecord } | { readonly failure: GitControlStoreFailure }
  > {
    const path = integrationRecordPath(integrationId);
    const shown = await run(operation, mirror, ["show", `${commit}:${path}`]);
    if (!shown.ok) {
      return {
        failure: failure(invalidCode, `commit ${commit} carries no readable record at ${path}`),
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(shown.value.stdout);
    } catch {
      return { failure: failure(invalidCode, `integration record at ${path} is not JSON`) };
    }
    const record = parsed as IntegrationRecord;
    if (
      record.record_kind !== "integration" ||
      record.integration_id !== integrationId ||
      !recordShapeValid(record, "integration") ||
      shown.value.stdout !== canonicalFileContent(record)
    ) {
      return {
        failure: failure(
          invalidCode,
          `integration record at ${path} failed schema, digest or canonical-form checks`,
        ),
      };
    }
    return { record };
  }

  async function readCandidate(input: CandidateReadRequest): Promise<CandidateReadOutcome> {
    if (!REF_COMPONENT_PATTERN.test(input.integration_id)) {
      return {
        status: "failed",
        failure: failure(
          "coordinator_unavailable",
          `integration id is not a valid ref component: ${input.integration_id}`,
        ),
      };
    }
    const prepared = await ensureMirror();
    if (prepared !== undefined) return { status: "failed", failure: prepared };

    const stagingRef = `${CANDIDATE_STAGING_PREFIX}/${input.integration_id}`;
    const mirrorStagingRef = `${MIRROR_CANDIDATE_PREFIX}/${input.integration_id}`;
    const fetched = await run("readCandidate", mirror, [
      "fetch",
      "--no-tags",
      remote,
      `+${stagingRef}:${mirrorStagingRef}`,
    ]);
    if (!fetched.ok) {
      const text = `${fetched.error.message}\n${fetched.error.stderr ?? ""}`;
      if (REMOTE_REF_MISSING.test(text)) return { status: "missing" };
      return { status: "failed", failure: remoteFailure("fetch", fetched.error.stderr) };
    }
    const head = await run("readCandidate", mirror, ["rev-parse", "--verify", mirrorStagingRef]);
    if (!head.ok)
      return { status: "failed", failure: remoteFailure("rev-parse", head.error.stderr) };
    const candidateCommit = head.value.stdout.trim();
    const tree = await run("readCandidate", mirror, ["rev-parse", `${candidateCommit}^{tree}`]);
    if (!tree.ok)
      return { status: "failed", failure: remoteFailure("rev-parse", tree.error.stderr) };

    // The staging ref is untrusted candidate data: the record must validate
    // before it may feed an accept decision.
    const record = await readRecordAt(
      "readCandidate",
      candidateCommit,
      input.integration_id,
      "ledger_resequence_failed",
    );
    if ("failure" in record) return { status: "failed", failure: record.failure };
    return {
      status: "found",
      candidate_commit: candidateCommit,
      tree_oid: tree.value.stdout.trim(),
      record: record.record,
    };
  }

  async function readIntegrationRecord(
    input: IntegrationRecordReadRequest,
  ): Promise<IntegrationRecordReadOutcome> {
    const prepared = await ensureMirror();
    if (prepared !== undefined) return { status: "failed", failure: prepared };

    const fetched = await run("readIntegrationRecord", mirror, [
      "fetch",
      "--no-tags",
      remote,
      `+${input.target_ref}:${MIRROR_TARGET_REF}`,
    ]);
    if (!fetched.ok) {
      return { status: "failed", failure: remoteFailure("fetch", fetched.error.stderr) };
    }
    const head = await run("readIntegrationRecord", mirror, [
      "rev-parse",
      "--verify",
      MIRROR_TARGET_REF,
    ]);
    if (!head.ok) {
      return { status: "failed", failure: remoteFailure("rev-parse", head.error.stderr) };
    }
    const commit = head.value.stdout.trim();

    // Records are append-only and never deleted, so the head tree carries the
    // accepted record when the integration ever landed (design §14.4).
    const path = integrationRecordPath(input.integration_id);
    const present = await run("readIntegrationRecord", mirror, [
      "cat-file",
      "-e",
      `${commit}:${path}`,
    ]);
    if (!present.ok) return { status: "missing" };
    // Target history is authoritative: an unreadable record there is damage.
    const record = await readRecordAt(
      "readIntegrationRecord",
      commit,
      input.integration_id,
      "control_ref_invalid",
    );
    if ("failure" in record) return { status: "failed", failure: record.failure };
    return { status: "found", commit, record: record.record };
  }

  /**
   * Enumerate the IntegrationRecords the Coordinator needs for a
   * deterministic projection rebuild (design §12): staged records are read
   * from the candidate staging refs, accepted records from the Target tree.
   * Both namespaces are re-fetched on every call, so a rebuilt projection is
   * a pure function of the current remote state.
   */
  async function listIntegrationRecords(
    input: IntegrationRecordListRequest,
  ): Promise<IntegrationRecordListOutcome> {
    const prepared = await ensureMirror();
    if (prepared !== undefined) return { status: "failed", failure: prepared };

    // Fetch the whole staging namespace with prune so vanished remote
    // staging refs disappear locally. A wildcard refspec matching nothing on
    // the remote exits 0 — an empty namespace is not an error.
    const fetched = await run("listIntegrationRecords", mirror, [
      "fetch",
      "--no-tags",
      "--prune",
      remote,
      `+${CANDIDATE_STAGING_PREFIX}/*:${MIRROR_CANDIDATE_PREFIX}/*`,
    ]);
    if (!fetched.ok) {
      return { status: "failed", failure: remoteFailure("fetch", fetched.error.stderr) };
    }
    const listed = await run("listIntegrationRecords", mirror, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      `${MIRROR_CANDIDATE_PREFIX}/`,
    ]);
    if (!listed.ok) {
      return { status: "failed", failure: remoteFailure("for-each-ref", listed.error.stderr) };
    }

    const staged: IntegrationRecord[] = [];
    for (const line of listed.value.stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const [ref, oid] = trimmed.split(" ");
      const integrationId = ref?.slice(`${MIRROR_CANDIDATE_PREFIX}/`.length);
      // The staging namespace also holds operation-candidate refs pushed by
      // the CLI publish flow; anything without a well-formed integration id
      // or without the record file is not a staged integration.
      if (
        integrationId === undefined ||
        !REF_COMPONENT_PATTERN.test(integrationId) ||
        oid === undefined
      ) {
        continue;
      }
      const present = await run("listIntegrationRecords", mirror, [
        "cat-file",
        "-e",
        `${oid}:${integrationRecordPath(integrationId)}`,
      ]);
      if (!present.ok) continue;
      const record = await readRecordAt(
        "listIntegrationRecords",
        oid,
        integrationId,
        "control_ref_invalid",
      );
      if ("failure" in record) return { status: "failed", failure: record.failure };
      staged.push(record.record);
    }

    const accepted: IntegrationRecord[] = [];
    if (input.target_ref !== undefined) {
      const fetchedTarget = await run("listIntegrationRecords", mirror, [
        "fetch",
        "--no-tags",
        remote,
        `+${input.target_ref}:${MIRROR_TARGET_REF}`,
      ]);
      if (!fetchedTarget.ok) {
        return { status: "failed", failure: remoteFailure("fetch", fetchedTarget.error.stderr) };
      }
      const head = await run("listIntegrationRecords", mirror, [
        "rev-parse",
        "--verify",
        MIRROR_TARGET_REF,
      ]);
      if (!head.ok) {
        return { status: "failed", failure: remoteFailure("rev-parse", head.error.stderr) };
      }
      const commit = head.value.stdout.trim();
      // Records are append-only, so the head tree carries every accepted
      // record (design §14.4); a missing directory is an empty listing.
      const listedAccepted = await run("listIntegrationRecords", mirror, [
        "ls-tree",
        "--name-only",
        commit,
        "--",
        ".harness/artifacts/integrations/",
      ]);
      if (!listedAccepted.ok) {
        return { status: "failed", failure: remoteFailure("ls-tree", listedAccepted.error.stderr) };
      }
      for (const line of listedAccepted.value.stdout.split("\n")) {
        const path = line.trim();
        if (path.length === 0) continue;
        // The Target history is authoritative: an unexpected file there is
        // damage and fails closed instead of being skipped.
        const match = /^\.harness\/artifacts\/integrations\/([^/]+)\.json$/u.exec(path);
        if (match === null || !REF_COMPONENT_PATTERN.test(match[1] as string)) {
          return {
            status: "failed",
            failure: failure("control_ref_invalid", `unexpected integration file: ${path}`),
          };
        }
        const record = await readRecordAt(
          "listIntegrationRecords",
          commit,
          match[1] as string,
          "control_ref_invalid",
        );
        if ("failure" in record) return { status: "failed", failure: record.failure };
        accepted.push(record.record);
      }
    }

    return { status: "ok", staged, accepted };
  }

  async function compareAndSwapTarget(input: TargetCasRequest): Promise<TargetCasOutcome> {
    for (const [label, oid] of [
      ["expected commit", input.expected_commit],
      ["new commit", input.new_commit],
    ] as const) {
      if (!COMMIT_OID_PATTERN.test(oid)) {
        return {
          status: "failed",
          failure: failure("coordinator_unavailable", `${label} is not a full commit oid: ${oid}`),
        };
      }
    }
    const prepared = await ensureMirror();
    if (prepared !== undefined) return { status: "failed", failure: prepared };

    const fetched = await run("compareAndSwapTarget", mirror, [
      "fetch",
      "--no-tags",
      remote,
      `+${input.target_ref}:${MIRROR_TARGET_REF}`,
    ]);
    if (!fetched.ok) {
      return { status: "failed", failure: remoteFailure("fetch", fetched.error.stderr) };
    }
    const head = await run("compareAndSwapTarget", mirror, [
      "rev-parse",
      "--verify",
      MIRROR_TARGET_REF,
    ]);
    if (!head.ok)
      return { status: "failed", failure: remoteFailure("rev-parse", head.error.stderr) };
    if (head.value.stdout.trim() !== input.expected_commit) {
      return {
        status: "failed",
        failure: failure(
          "target_cas_failed",
          "target head moved since the command froze it; re-read the target",
          true,
        ),
      };
    }

    const exists = await run("compareAndSwapTarget", mirror, [
      "cat-file",
      "-e",
      `${input.new_commit}^{commit}`,
    ]);
    if (!exists.ok) {
      return {
        status: "failed",
        failure: failure(
          "coordinator_unavailable",
          "candidate commit is not available in the coordinator mirror; re-run prepare",
        ),
      };
    }
    // The CAS only ever fast-forwards the target onto the verified candidate.
    const ancestry = await run("compareAndSwapTarget", mirror, [
      "merge-base",
      "--is-ancestor",
      input.expected_commit,
      input.new_commit,
    ]);
    if (!ancestry.ok) {
      return {
        status: "failed",
        failure: failure(
          "target_cas_failed",
          "candidate commit does not descend from the expected target commit",
        ),
      };
    }

    const pushed = await run("compareAndSwapTarget", mirror, [
      "push",
      remote,
      `${input.new_commit}:${input.target_ref}`,
      `--force-with-lease=${input.target_ref}:${input.expected_commit}`,
    ]);
    const pushFailure = mapPushOutcome(
      pushed,
      "target_cas_failed",
      "target ref push lost the compare-and-swap; re-read the target, never replay an old accept",
    );
    if (pushFailure !== undefined) return { status: "failed", failure: pushFailure };
    await run("compareAndSwapTarget", mirror, ["update-ref", MIRROR_TARGET_REF, input.new_commit]);
    // The accepted candidate is now reachable from the target history, so its
    // staging ref has served its purpose. Cleanup is best-effort: a failure
    // must not turn a landed swap into a reported failure.
    if (input.integration_id !== undefined && REF_COMPONENT_PATTERN.test(input.integration_id)) {
      const stagingRef = `${CANDIDATE_STAGING_PREFIX}/${input.integration_id}`;
      await run("compareAndSwapTarget", mirror, ["push", remote, `:${stagingRef}`]);
      await run("compareAndSwapTarget", mirror, [
        "update-ref",
        "-d",
        `${MIRROR_CANDIDATE_PREFIX}/${input.integration_id}`,
      ]);
    }
    return { status: "swapped", commit: input.new_commit };
  }

  return {
    readControl,
    appendControl,
    appendProjectRecord,
    listOperationHeads: () => listOperationHeads(),
    compareAndSwapOperation,
    prepareCandidate,
    readCandidate,
    readIntegrationRecord,
    listIntegrationRecords,
    compareAndSwapTarget,
  };
}
