import {
  buildCollaborationRecord,
  canonicalizeJson,
  contentDigest,
  type CollaborationConnectionRecord,
  type CollaborationPermission,
  type CollaborationProvider,
  type ControlRecord,
  type LeaseRecord,
  type PrincipalSnapshotRecord,
  type RemoteApprovalDecisionRecord,
} from "@universal-harness-internal/core";
import type {
  ControlRefProtectionRequest,
  CoordinatorProjectionPort,
  GitControlStorePort,
  PlatformIdentityPort,
} from "@universal-harness-internal/runtime";

import type { ConformanceCase } from "./runner.js";

/**
 * Shared M3 remote collaboration conformance cases (plan M3 Task 9 step 1,
 * spec §21.2). One case kit per internal Adapter seam — PlatformIdentityPort,
 * GitControlStorePort and CoordinatorProjectionPort — so the same executable
 * contract runs against every production and in-memory Adapter and the
 * Adapter↔port compatibility is locked by behavior, not by structural typing
 * alone. Cases assert observable results through the seam Interface only;
 * adapter-specific arrangement (staging refs, scripted platform payloads,
 * scratch commits) enters through the kit hooks. A case fails by throwing a
 * plain Error with a human-readable message.
 */

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  // Canonical comparison: adapters legitimately round-trip records through
  // canonical JSON, so object key order is not observable contract surface.
  const actualJson = canonicalizeJson(actual);
  const expectedJson = canonicalizeJson(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}

const HEX_DIGEST = /^[a-f0-9]{64}$/u;
/** OAuth-shaped secrets; fencing tokens and content digests are not secrets. */
const SECRET_FIELD = /access_token|refresh_token|bearer|secret|credential|password/iu;

const NOW = "2026-08-29T00:00:00.000Z";
const LATER = "2026-08-29T00:05:00.000Z";
const PROJECT_ID = "project_conformance";
const CONTROL_REF = "refs/heads/harness/control";
const TARGET_REF = "refs/heads/main";

const digest = (letter: string): string => letter.repeat(64);

// --- Shared control-record fixtures -------------------------------------------

export function conformanceConnectionFixture(
  overrides: Partial<CollaborationConnectionRecord> = {},
): CollaborationConnectionRecord {
  return buildCollaborationRecord({
    record_kind: "collaboration_connection" as const,
    connection_id: "connection_conformance",
    project_id: PROJECT_ID,
    revision: 1,
    status: "active" as const,
    provider: "github" as const,
    repository_id: "acme/demo",
    canonical_remote: "https://github.com/acme/demo",
    canonical_remote_digest: digest("b"),
    coordinator_origin: "https://harness.example.com",
    target_ref: TARGET_REF,
    control_ref: CONTROL_REF,
    policy_digest: digest("c"),
    actor_principal_id: "principal_alice",
    principal_snapshot_digest: digest("a"),
    command_id: "command_connect_1",
    effective_at: NOW,
    ...overrides,
  });
}

export function conformanceSnapshotRecord(
  sequence: number,
  previous?: string,
): PrincipalSnapshotRecord {
  return buildCollaborationRecord({
    record_kind: "principal_snapshot" as const,
    control_sequence: sequence,
    ...(previous === undefined ? {} : { previous_control_record_digest: previous }),
    snapshot_id: `snapshot_${String(sequence)}`,
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

export function conformanceLeaseRecord(
  sequence: number,
  previous: string,
  overrides: Partial<LeaseRecord> = {},
): LeaseRecord {
  return buildCollaborationRecord({
    record_kind: "lease" as const,
    control_sequence: sequence,
    previous_control_record_digest: previous,
    lease_record_id: `lease-record_${String(sequence)}`,
    lease_id: "lease_01",
    resource_kind: "operation" as const,
    resource_id: "op_conformance",
    holder_principal_snapshot_digest: digest("a"),
    client_instance_id: "instance_conformance",
    fencing_token: 1,
    issued_at: NOW,
    expires_at: LATER,
    state: "granted" as const,
    command_id: `command_lease_${String(sequence)}`,
    ...overrides,
  });
}

export function conformanceApprovalRecord(
  sequence: number,
  previous: string,
  overrides: Partial<RemoteApprovalDecisionRecord> = {},
): RemoteApprovalDecisionRecord {
  return buildCollaborationRecord({
    record_kind: "remote_approval_decision" as const,
    control_sequence: sequence,
    previous_control_record_digest: previous,
    remote_decision_id: `remote-decision_${String(sequence)}`,
    request_id: `request_${String(sequence)}`,
    operation_id: "op_conformance",
    object_id: `snapshot_${String(sequence)}`,
    object_digest: digest("b"),
    policy_digest: digest("c"),
    decision: "approve" as const,
    principal_snapshot_digest: digest("a"),
    required_permission: "maintain" as const,
    decided_at: NOW,
    command_id: `command_decision_${String(sequence)}`,
    ...overrides,
  });
}

// --- PlatformIdentityPort -----------------------------------------------------

/**
 * Semantic description of the platform responses an Adapter under test must
 * see. The factory translates each intent into provider-specific JSON
 * payloads; the cases never name a provider field.
 */
export interface PlatformScript {
  /** Semantic permission the repository payload must report. */
  readonly permission: CollaborationPermission;
  /** Platform-stable subject id the user endpoint must report. */
  readonly subject_id: string;
  /** Access token the OAuth exchange returns; used to prove redaction. */
  readonly token?: string;
  /** Control Ref protection fact the platform payloads must prove. */
  readonly protection: "coordinator_only" | "foreign_identity" | "role_based" | "absent";
  /** The repository permission payload is unknown or malformed when true. */
  readonly malformed_permission?: boolean;
}

export interface PlatformIdentityKit {
  readonly port: PlatformIdentityPort;
  readonly provider: CollaborationProvider;
  readonly host: string;
  readonly repository_id: string;
  /** Canonical HTTPS remote the Adapter must recognize without manual binding. */
  readonly remote: string;
  /** SCP-style SSH spelling of the same repository. */
  readonly ssh_remote: string;
  /** Coordinator identity the exclusive protection rule must name. */
  readonly coordinator_identity: string;
  /** Control Ref whose protection is inspected. */
  readonly control_ref: string;
  /** Permission ranks this provider's role model can express. */
  readonly supported_permissions: readonly CollaborationPermission[];
}

export type PlatformIdentityFactory = (script: PlatformScript) => PlatformIdentityKit;

const OAUTH_REQUEST = (kit: PlatformIdentityKit) => ({
  provider: kit.provider,
  host: kit.host,
  repository_id: kit.repository_id,
  principal_id: "principal_caller",
});

const PROTECTION_REQUEST = (kit: PlatformIdentityKit): ControlRefProtectionRequest => ({
  provider: kit.provider,
  host: kit.host,
  repository_id: kit.repository_id,
  control_ref: kit.control_ref,
});

/**
 * Platform identity contract (spec §8/§9/§17.3): stable subject and
 * repository identity, exact role mapping, token redaction and enforceable
 * Coordinator-only Control Ref protection. An Adapter that cannot prove
 * exclusive protection must answer `control_ref_unprotected`, never
 * "protected".
 */
export function platformIdentityConformanceCases(
  factory: PlatformIdentityFactory,
): ConformanceCase[] {
  // Every provider expresses "admin"; provider-specific ranks are covered by
  // the role-mapping case via supported_permissions.
  const base: PlatformScript = {
    permission: "admin",
    subject_id: "1234567",
    protection: "coordinator_only",
  };
  return [
    {
      name: "discovers a stable provider/repository identity without manual binding",
      async run() {
        const kit = factory(base);
        const first = await kit.port.discover(kit.remote);
        assert(first.status === "resolved", "discover must resolve the approved HTTPS remote");
        if (first.status !== "resolved") return;
        assertEqual(first.identity.provider, kit.provider, "provider must be auto-detected");
        assertEqual(first.identity.host, kit.host, "host must be canonical");
        assertEqual(
          first.identity.repository_id,
          kit.repository_id,
          "repository id must be stable",
        );
        const second = await kit.port.discover(kit.remote);
        assert(second.status === "resolved", "discover must be repeatable");
        if (second.status !== "resolved") return;
        assertDeepEqual(second.identity, first.identity, "discover must be deterministic");
        const ssh = await kit.port.discover(kit.ssh_remote);
        assert(ssh.status === "resolved", "the SCP-style SSH spelling must resolve");
        if (ssh.status !== "resolved") return;
        assertEqual(
          ssh.identity.repository_id,
          first.identity.repository_id,
          "both remote spellings must name the same repository",
        );
        assertEqual(
          ssh.identity.canonical_remote_digest,
          contentDigest(ssh.identity.canonical_remote),
          "the SSH spelling must digest its own canonical form",
        );
        const canonical = first.identity.canonical_remote;
        assert(!canonical.includes("@"), "the canonical remote must not carry userinfo");
        assert(!/[?#]/u.test(canonical), "the canonical remote must not carry query/fragment");
        assertEqual(
          first.identity.canonical_remote_digest,
          contentDigest(canonical),
          "the remote digest must bind the canonical form",
        );
      },
    },
    {
      name: "maps every expressible platform role to the exact permission",
      async run() {
        const probe = factory(base);
        for (const permission of probe.supported_permissions) {
          const kit = factory({ ...base, permission });
          const outcome = await kit.port.authenticate(OAUTH_REQUEST(kit));
          assert(
            outcome.status === "authenticated",
            `authenticate must succeed for the ${permission} payload`,
          );
          if (outcome.status !== "authenticated") continue;
          assertEqual(
            outcome.snapshot.permission,
            permission,
            `the ${permission} payload must map exactly`,
          );
          assertEqual(
            outcome.snapshot.subject_id,
            base.subject_id,
            "the subject id must come from the user payload",
          );
        }
      },
    },
    {
      name: "derives a deterministic principal from the stable subject id",
      async run() {
        const first = factory(base);
        const second = factory(base);
        const third = factory({ ...base, subject_id: "7654321" });
        const one = await first.port.authenticate(OAUTH_REQUEST(first));
        const two = await second.port.authenticate(OAUTH_REQUEST(second));
        const other = await third.port.authenticate(OAUTH_REQUEST(third));
        assert(one.status === "authenticated" && two.status === "authenticated", "auth must work");
        if (one.status !== "authenticated" || two.status !== "authenticated") return;
        assertEqual(
          two.snapshot.principal_id,
          one.snapshot.principal_id,
          "the same subject must produce the same principal",
        );
        assert(other.status === "authenticated", "auth must work for another subject");
        if (other.status !== "authenticated") return;
        assert(
          other.snapshot.principal_id !== one.snapshot.principal_id,
          "a different subject must produce a different principal",
        );
        assert(
          /^principal_[a-f0-9]{24}$/u.test(one.snapshot.principal_id),
          "the principal id must carry the deterministic digest form",
        );
      },
    },
    {
      name: "never lets the access token leave the Adapter",
      async run() {
        const token = "conformance-secret-token-9f8e7d6c";
        const kit = factory({ ...base, token });
        const authenticated = await kit.port.authenticate(OAUTH_REQUEST(kit));
        assert(authenticated.status === "authenticated", "authenticate must succeed");
        if (authenticated.status !== "authenticated") return;
        assert(
          !JSON.stringify(authenticated.snapshot).includes(token),
          "the principal snapshot must not contain the access token",
        );
        // Failure text is a log/evidence surface too: a denied permission
        // payload must not echo the token either.
        const denied = factory({ ...base, token, malformed_permission: true });
        const failed = await denied.port.authenticate(OAUTH_REQUEST(denied));
        assert(failed.status === "failed", "a malformed permission payload must fail");
        if (failed.status !== "failed") return;
        assert(
          !JSON.stringify(failed.failure).includes(token),
          "failure text must not contain the access token",
        );
        assert(
          HEX_DIGEST.test(authenticated.snapshot.source_response_digest),
          "the raw platform response must be reduced to a digest",
        );
      },
    },
    {
      name: "fails closed on an unknown or missing role mapping",
      async run() {
        const kit = factory({ ...base, malformed_permission: true });
        const outcome = await kit.port.authenticate(OAUTH_REQUEST(kit));
        assert(outcome.status === "failed", "an unmappable role must fail closed");
        if (outcome.status !== "failed") return;
        assertEqual(
          outcome.failure.code,
          "permission_denied",
          "an unknown role must be a permission denial",
        );
      },
    },
    {
      name: "accepts coordinator-exclusive control ref protection",
      async run() {
        const kit = factory(base);
        const authenticated = await kit.port.authenticate(OAUTH_REQUEST(kit));
        assert(authenticated.status === "authenticated", "authenticate must succeed first");
        const protection = await kit.port.inspectControlRefProtection(PROTECTION_REQUEST(kit));
        assert(
          protection.status === "protected",
          `coordinator-only protection must pass: ${JSON.stringify(protection)}`,
        );
      },
    },
    {
      name: "fails closed when protection is absent, role-based or foreign",
      async run() {
        for (const variant of ["absent", "role_based", "foreign_identity"] as const) {
          const kit = factory({ ...base, protection: variant });
          const authenticated = await kit.port.authenticate(OAUTH_REQUEST(kit));
          assert(authenticated.status === "authenticated", "authenticate must succeed first");
          const protection = await kit.port.inspectControlRefProtection(PROTECTION_REQUEST(kit));
          assert(protection.status === "unprotected", `${variant} protection must not be accepted`);
          if (protection.status !== "unprotected") continue;
          assertEqual(
            protection.failure.code,
            "control_ref_unprotected",
            `${variant} protection must fail closed with the typed code`,
          );
        }
      },
    },
    {
      name: "refuses protection inspection without an authenticated session",
      async run() {
        const kit = factory(base);
        const protection = await kit.port.inspectControlRefProtection(PROTECTION_REQUEST(kit));
        assert(
          protection.status === "unprotected",
          "protection must not be provable without a session",
        );
        if (protection.status !== "unprotected") return;
        assertEqual(
          protection.failure.code,
          "authentication_required",
          "a missing session must be an authentication failure",
        );
      },
    },
  ];
}

// --- GitControlStorePort ------------------------------------------------------

/**
 * Adapter-specific Git arrangement hooks. The cases only ever assert through
 * `port`; these hooks stage the refs and commits a real remote would carry.
 */
export interface GitControlStoreKit {
  readonly port: GitControlStorePort;
  /** Create a commit carrying unique content on top of `parents`; returns its OID. */
  commit(content: string, parents?: readonly string[]): Promise<string>;
  /** Point (creating or moving) a ref at a commit. */
  moveRef(ref: string, oid: string): Promise<void>;
  /** Current OID named by a ref, if any. */
  tip(ref: string): Promise<string | undefined>;
  /** Stage a candidate commit at the publish staging ref for an operation. */
  stageCandidate(operationId: string, commit: string): Promise<void>;
  /** Release scratch resources. */
  cleanup(): Promise<void> | void;
}

export type GitControlStoreFactory = () => Promise<GitControlStoreKit> | GitControlStoreKit;

const operationRef = (operationId: string): string => `refs/heads/operation/${operationId}`;

/**
 * Git control store contract (spec §10/§11/§14.4): append-only Control Ref
 * ordering, stale-OID CAS losses that never move a ref, no blind retry of a
 * failed append and an exact Target compare-and-swap.
 */
export function gitControlStoreConformanceCases(
  factory: GitControlStoreFactory,
): ConformanceCase[] {
  return [
    {
      name: "appends control records in order and reads back a verified chain",
      async run() {
        const kit = await factory();
        try {
          const empty = await kit.port.readControl({
            project_id: PROJECT_ID,
            control_ref: CONTROL_REF,
          });
          assert(empty.status === "ok", "an empty control ref must read cleanly");
          if (empty.status !== "ok") return;
          assertEqual(empty.snapshot.control_records.length, 0, "no records before any append");

          const snapshot = conformanceSnapshotRecord(1);
          const first = await kit.port.appendControl({
            project_id: PROJECT_ID,
            control_ref: CONTROL_REF,
            record: snapshot,
          });
          assert(first.status === "appended", `first append must land: ${JSON.stringify(first)}`);
          if (first.status !== "appended") return;

          const lease = conformanceLeaseRecord(2, snapshot.record_digest);
          const second = await kit.port.appendControl({
            project_id: PROJECT_ID,
            control_ref: CONTROL_REF,
            expected_head_oid: first.head_oid,
            record: lease,
          });
          assert(
            second.status === "appended",
            `chained append must land: ${JSON.stringify(second)}`,
          );

          const read = await kit.port.readControl({
            project_id: PROJECT_ID,
            control_ref: CONTROL_REF,
          });
          assert(read.status === "ok", "read after appends must succeed");
          if (read.status !== "ok") return;
          assertDeepEqual(
            read.snapshot.control_records,
            [snapshot, lease],
            "the chain must read back in append order",
          );
          assertEqual(
            read.snapshot.control_head_oid,
            second.status === "appended" ? second.head_oid : undefined,
            "the head must name the latest append",
          );
        } finally {
          await kit.cleanup();
        }
      },
    },
    {
      name: "loses a stale expected head and never applies the failed append",
      async run() {
        const kit = await factory();
        try {
          const snapshot = conformanceSnapshotRecord(1);
          const appended = await kit.port.appendControl({
            project_id: PROJECT_ID,
            control_ref: CONTROL_REF,
            record: snapshot,
          });
          assert(appended.status === "appended", "the seed append must land");
          if (appended.status !== "appended") return;

          const stale = await kit.port.appendControl({
            project_id: PROJECT_ID,
            control_ref: CONTROL_REF,
            expected_head_oid: "f".repeat(40),
            record: conformanceLeaseRecord(2, snapshot.record_digest),
          });
          assert(stale.status === "failed", "a stale expected head must lose the CAS");
          if (stale.status !== "failed") return;
          assertEqual(
            stale.failure.code,
            "control_ref_cas_failed",
            "the loss must be typed, never silent",
          );

          // No blind retry: the failed append left nothing behind, and a
          // caller that re-reads and re-decides appends cleanly.
          const reread = await kit.port.readControl({
            project_id: PROJECT_ID,
            control_ref: CONTROL_REF,
          });
          assert(reread.status === "ok", "read after the lost CAS must succeed");
          if (reread.status !== "ok") return;
          assertEqual(
            reread.snapshot.control_records.length,
            1,
            "the failed append must not have applied",
          );
          const freshHead = reread.snapshot.control_head_oid;
          const retried = await kit.port.appendControl({
            project_id: PROJECT_ID,
            control_ref: CONTROL_REF,
            ...(freshHead === undefined ? {} : { expected_head_oid: freshHead }),
            record: conformanceLeaseRecord(2, snapshot.record_digest),
          });
          assert(
            retried.status === "appended",
            "a re-decided append with the fresh head must land",
          );
        } finally {
          await kit.cleanup();
        }
      },
    },
    {
      name: "operation ref CAS loses a stale head without moving the ref",
      async run() {
        const kit = await factory();
        try {
          // The first publish must descend from the connected target head: the
          // connection record commit anchors the operation baseline.
          const baseline = await kit.commit("operation baseline");
          await kit.moveRef(TARGET_REF, baseline);
          const connected = await kit.port.appendProjectRecord({
            project_id: PROJECT_ID,
            target_ref: TARGET_REF,
            record: conformanceConnectionFixture(),
          });
          assert(
            connected.status === "committed",
            `the connection record must commit: ${JSON.stringify(connected)}`,
          );
          if (connected.status !== "committed") return;

          const first = await kit.commit("candidate one", [connected.commit]);
          await kit.stageCandidate("op_conformance", first);
          const swapped = await kit.port.compareAndSwapOperation({
            project_id: PROJECT_ID,
            operation_id: "op_conformance",
            candidate_commit: first,
            fencing_token: 1,
          });
          assert(swapped.status === "swapped", `first CAS must swap: ${JSON.stringify(swapped)}`);
          assertEqual(await kit.tip(operationRef("op_conformance")), first, "the ref names head 1");

          const second = await kit.commit("candidate two", [first]);
          await kit.stageCandidate("op_conformance", second);
          const stale = await kit.port.compareAndSwapOperation({
            project_id: PROJECT_ID,
            operation_id: "op_conformance",
            expected_head_oid: "0".repeat(40),
            candidate_commit: second,
            fencing_token: 2,
          });
          assert(stale.status === "failed", "a stale expected OID must lose the operation CAS");
          assertEqual(
            await kit.tip(operationRef("op_conformance")),
            first,
            "the lost CAS must not move the operation ref",
          );

          const fresh = await kit.port.compareAndSwapOperation({
            project_id: PROJECT_ID,
            operation_id: "op_conformance",
            expected_head_oid: first,
            candidate_commit: second,
            fencing_token: 2,
          });
          assert(fresh.status === "swapped", "a CAS with the current head must swap");
          assertEqual(
            await kit.tip(operationRef("op_conformance")),
            second,
            "the ref advances exactly once",
          );
          const heads = await kit.port.listOperationHeads({ project_id: PROJECT_ID });
          assert(heads.status === "ok", "operation heads must list");
          if (heads.status !== "ok") return;
          assertDeepEqual(
            heads.heads,
            [{ operation_id: "op_conformance", head_oid: second }],
            "the operation head listing must reflect the final swap",
          );
        } finally {
          await kit.cleanup();
        }
      },
    },
    {
      name: "target CAS requires the exact expected commit and ancestry",
      async run() {
        const kit = await factory();
        try {
          const baseline = await kit.commit("target base");
          await kit.moveRef(TARGET_REF, baseline);
          const connected = await kit.port.appendProjectRecord({
            project_id: PROJECT_ID,
            target_ref: TARGET_REF,
            record: conformanceConnectionFixture(),
          });
          assert(
            connected.status === "committed",
            `the connection record must commit: ${JSON.stringify(connected)}`,
          );
          if (connected.status !== "committed") return;

          // Deliver the candidate the way a prepared integration would reach
          // the store: staged and published as an operation head.
          const child = await kit.commit("target child", [connected.commit]);
          await kit.stageCandidate("op_seed", child);
          const published = await kit.port.compareAndSwapOperation({
            project_id: PROJECT_ID,
            operation_id: "op_seed",
            candidate_commit: child,
            fencing_token: 1,
          });
          assert(
            published.status === "swapped",
            `the candidate publish must succeed: ${JSON.stringify(published)}`,
          );

          const wrong = await kit.port.compareAndSwapTarget({
            project_id: PROJECT_ID,
            target_ref: TARGET_REF,
            expected_commit: "0".repeat(40),
            new_commit: child,
          });
          assert(wrong.status === "failed", "a wrong expected commit must lose the target CAS");
          if (wrong.status !== "failed") return;
          assertEqual(
            wrong.failure.code,
            "target_cas_failed",
            "the loss must be typed as a target CAS failure",
          );
          assertEqual(
            await kit.tip(TARGET_REF),
            connected.commit,
            "the lost CAS must not move the target",
          );

          const swapped = await kit.port.compareAndSwapTarget({
            project_id: PROJECT_ID,
            target_ref: TARGET_REF,
            expected_commit: connected.commit,
            new_commit: child,
          });
          assert(
            swapped.status === "swapped",
            `the exact CAS must swap: ${JSON.stringify(swapped)}`,
          );
          assertEqual(await kit.tip(TARGET_REF), child, "the target names the new commit");

          // A candidate that does not descend from the expected commit loses,
          // even when it is reachable in the store.
          const orphan = await kit.commit("orphan without ancestry");
          await kit.stageCandidate("op_orphan", orphan);
          const orphanPublish = await kit.port.compareAndSwapOperation({
            project_id: PROJECT_ID,
            operation_id: "op_orphan",
            candidate_commit: orphan,
            fencing_token: 1,
          });
          assert(
            orphanPublish.status === "failed",
            "an orphan candidate must not publish as an operation head",
          );
          const nonDescendant = await kit.port.compareAndSwapTarget({
            project_id: PROJECT_ID,
            target_ref: TARGET_REF,
            expected_commit: child,
            new_commit: orphan,
          });
          assert(
            nonDescendant.status === "failed",
            "a non-descendant candidate must lose the target CAS",
          );
          assertEqual(
            await kit.tip(TARGET_REF),
            child,
            "the rejected CAS must not move the target",
          );
        } finally {
          await kit.cleanup();
        }
      },
    },
  ];
}

// --- CoordinatorProjectionPort --------------------------------------------------

export interface CoordinatorProjectionKit {
  readonly port: CoordinatorProjectionPort;
  /**
   * Optional schema/field listing used by the no-secret-material case
   * (SQLite: table columns). Adapters without a field schema omit it; the
   * serialized views are always scanned.
   */
  schemaFields?(): Promise<readonly string[]> | readonly string[];
  /** Release resources (close the database, drop temp files). */
  cleanup(): Promise<void> | void;
}

export type ProjectionFactory = () => Promise<CoordinatorProjectionKit> | CoordinatorProjectionKit;

interface ProjectionFixtures {
  readonly connection: CollaborationConnectionRecord;
  readonly records: readonly ControlRecord[];
}

function projectionFixtures(): ProjectionFixtures {
  const snapshot = conformanceSnapshotRecord(1);
  const lease = conformanceLeaseRecord(2, snapshot.record_digest);
  const approval = conformanceApprovalRecord(3, lease.record_digest);
  return {
    connection: conformanceConnectionFixture(),
    records: [snapshot, lease, approval],
  };
}

const QUERIES = [
  { kind: "connection_status", project_id: PROJECT_ID },
  { kind: "operations", project_id: PROJECT_ID },
  { kind: "approval_inbox", project_id: PROJECT_ID },
  { kind: "integration_conflicts", project_id: PROJECT_ID },
] as const;

async function allViews(port: CoordinatorProjectionPort) {
  const views = [];
  for (const query of QUERIES) {
    views.push(await port.query(query));
  }
  return views;
}

/**
 * Projection contract (spec §12): the projection is deletable and rebuildable
 * with identical results, incremental apply matches a full rebuild, and no
 * secret material is ever persisted.
 */
export function coordinatorProjectionConformanceCases(
  factory: ProjectionFactory,
): ConformanceCase[] {
  return [
    {
      name: "serves not_connected before any rebuild",
      async run() {
        const kit = await factory();
        try {
          const view = await kit.port.query({
            kind: "connection_status",
            project_id: PROJECT_ID,
          });
          assertDeepEqual(
            view,
            { kind: "connection_status", project_id: PROJECT_ID, status: "not_connected" },
            "a fresh projection must report not_connected",
          );
        } finally {
          await kit.cleanup();
        }
      },
    },
    {
      name: "delete/rebuild equivalence: identical Git facts yield identical views",
      async run() {
        const fixtures = projectionFixtures();
        const first = await factory();
        const second = await factory();
        try {
          const input = {
            project_id: PROJECT_ID,
            latest_connection: fixtures.connection,
            control_records: fixtures.records,
          };
          await first.port.rebuild(input);
          await second.port.rebuild(input);
          assertDeepEqual(
            await allViews(second.port),
            await allViews(first.port),
            "two rebuilds from the same Git facts must serve identical views",
          );
          // Rebuilding over existing state is a delete+rebuild, not an append.
          await first.port.rebuild(input);
          assertDeepEqual(
            await allViews(first.port),
            await allViews(second.port),
            "a repeated rebuild must not duplicate or drift",
          );
        } finally {
          await first.cleanup();
          await second.cleanup();
        }
      },
    },
    {
      name: "incremental apply matches a full rebuild",
      async run() {
        const fixtures = projectionFixtures();
        const whole = await factory();
        const incremental = await factory();
        try {
          await whole.port.rebuild({
            project_id: PROJECT_ID,
            latest_connection: fixtures.connection,
            control_records: fixtures.records,
          });
          const [snapshot, ...rest] = fixtures.records;
          await incremental.port.rebuild({
            project_id: PROJECT_ID,
            latest_connection: fixtures.connection,
            control_records: [snapshot as ControlRecord],
          });
          for (const record of rest) {
            await incremental.port.apply(record);
          }
          assertDeepEqual(
            await allViews(incremental.port),
            await allViews(whole.port),
            "rebuild-then-apply must serve the same views as one rebuild",
          );
        } finally {
          await whole.cleanup();
          await incremental.cleanup();
        }
      },
    },
    {
      name: "persists no token, secret or credential material",
      async run() {
        const fixtures = projectionFixtures();
        const kit = await factory();
        try {
          await kit.port.rebuild({
            project_id: PROJECT_ID,
            latest_connection: fixtures.connection,
            control_records: fixtures.records,
          });
          const views = await allViews(kit.port);
          const serialized = JSON.stringify(views);
          assert(
            !SECRET_FIELD.test(serialized),
            "no serialized projection view may carry token/secret/credential fields",
          );
          if (kit.schemaFields !== undefined) {
            const fields = await kit.schemaFields();
            for (const field of fields) {
              assert(
                !SECRET_FIELD.test(field),
                `projection schema field "${field}" must not be secret-shaped`,
              );
            }
          }
        } finally {
          await kit.cleanup();
        }
      },
    },
  ];
}
