import type {
  CollaborationConnectionRecord,
  CollaborationProvider,
  ControlRecord,
  LeaseRecord,
  PrincipalSnapshotRecord,
  RemoteApprovalDecisionRecord,
} from "@universal-harness-internal/core";
import { buildCollaborationRecord } from "@universal-harness-internal/core";

import type { ApprovalRequestRecord } from "../approval/request.js";
import {
  remoteDecisionIdFor,
  terminalRemoteDecision,
  validateRemoteApprovalDecision,
  type RemoteApprovalDecisionDraft,
} from "./approval.js";
import {
  COLLABORATION_CONTROL_REF,
  connectionIdFor,
  hasLiveLease,
  normalizeCoordinatorOrigin,
  semanticConnectionEqual,
  snapshotIdFor,
} from "./connection.js";
import { collaborationFailure, type CollaborationFailure } from "./errors.js";
import {
  leaseRevocationDraft,
  transitionLease,
  type LeaseCommand,
  type LeaseDraft,
} from "./lease.js";
import type {
  CollaborationCommand,
  CollaborationCoordinatorPort,
  CollaborationOutcome,
  CollaborationQuery,
  CollaborationSession,
  CollaborationView,
  ConnectCommand,
  ConnectedOutcome,
  ControlSnapshot,
  ControlSnapshotResult,
  CoordinatorProjectionPort,
  DisconnectCommand,
  DisconnectedOutcome,
  GitControlStorePort,
  PlatformIdentityPort,
  PrincipalSnapshotFacts,
  PublishOperationCandidateCommand,
  SubmitRemoteApprovalCommand,
} from "./port.js";

/**
 * Connection- and Lease-slice Coordinator: command routing, command_id
 * idempotency and fail-closed orchestration. Every command runs as
 * validate → load authoritative Git state → authorize → append via CAS →
 * update the SQLite projection. Git is authoritative; when the projection
 * update fails after a successful append, the outcome carries
 * `projection_rebuild_required` and the append is never blindly retried.
 *
 * Lease decisions come from the pure `transitionLease` state machine over the
 * per-resource chain read from the Control Ref; a lost Control Ref CAS loops
 * once through a fresh read and semantic re-decision, and a second loss
 * answers `lease_unavailable`. Remote approval submissions validate the
 * committed request, the approver's fresh PrincipalSnapshot and the
 * self-approval prohibition before the Control Ref CAS (design §13.1);
 * Integration commands are implemented by later tasks and answered with a
 * typed `coordinator_unavailable` failure.
 */
export interface CollaborationCoordinatorDependencies {
  readonly platform: PlatformIdentityPort;
  readonly controlStore: GitControlStorePort;
  readonly projection: CoordinatorProjectionPort;
  /** Protected Control Ref; fixed to `harness/control` by default (spec §10). */
  readonly control_ref?: string;
  /** Injectable clock (ISO 8601 UTC) for deterministic tests. */
  readonly now?: () => string;
  /**
   * Committed ApprovalRequest lookup backing `submit_remote_approval` (design
   * §13). The Coordinator validates and binds decisions against the exact
   * committed request; without this source the command fails closed with
   * `coordinator_unavailable`.
   */
  readonly readApprovalRequest?: (input: {
    readonly project_id: string;
    readonly request_id: string;
  }) => Promise<ApprovalRequestRecord | undefined>;
}

function connectionOutcome(
  record: CollaborationConnectionRecord,
  replayed: boolean,
): ConnectedOutcome | DisconnectedOutcome {
  return record.status === "active"
    ? { status: "connected", connection: record, replayed }
    : { status: "disconnected", connection: record, replayed };
}

/**
 * Read the authoritative Git state for one command. The projection is only a
 * locator hint for the project's target ref (the latest connection record
 * lives on the target ref's Ledger, which a real remote can only reach by
 * name); authority stays with the Git read, and a projection failure degrades
 * to no hint instead of failing the command.
 */
async function readProjectState(
  deps: CollaborationCoordinatorDependencies,
  controlRef: string,
  projectId: string,
  targetRefHint?: string,
): Promise<ControlSnapshotResult> {
  let targetRef = targetRefHint;
  if (targetRef === undefined) {
    try {
      const view = await deps.projection.query({
        kind: "connection_status",
        project_id: projectId,
      });
      if (view.kind === "connection_status") targetRef = view.connection?.target_ref;
    } catch {
      targetRef = undefined;
    }
  }
  return deps.controlStore.readControl({
    project_id: projectId,
    control_ref: controlRef,
    ...(targetRef === undefined ? {} : { target_ref: targetRef }),
  });
}

/** The holder snapshot digest for new Lease records: latest snapshot on the ref. */
function latestSnapshotDigest(records: readonly ControlRecord[]): string | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index] as ControlRecord;
    if (record.record_kind === "principal_snapshot") return record.record_digest;
  }
  return undefined;
}

export function createCollaborationCoordinator(
  deps: CollaborationCoordinatorDependencies,
): CollaborationCoordinatorPort {
  const controlRef = deps.control_ref ?? COLLABORATION_CONTROL_REF;
  const now = deps.now ?? (() => new Date().toISOString());

  /**
   * Best-effort projection update after the authoritative Git append. Git
   * stays authoritative: a projection failure is reported as
   * `rebuild_required` and the append is never blindly retried.
   */
  async function applyProjection(
    records: readonly Parameters<CoordinatorProjectionPort["apply"]>[0][],
  ): Promise<{ rebuild_required: boolean }> {
    try {
      for (const record of records) {
        await deps.projection.apply(record);
      }
      return { rebuild_required: false };
    } catch {
      return { rebuild_required: true };
    }
  }

  /**
   * OAuth the session principal against one remote target and require a
   * fresh, session-owned permission snapshot (fail closed). Shared by connect
   * and submit_remote_approval; `staleSummary` names the record whose write
   * the snapshot would outlive.
   */
  async function authenticateFreshSnapshot(
    target: {
      readonly provider: CollaborationProvider;
      readonly host: string;
      readonly repository_id: string;
    },
    session: CollaborationSession,
    staleSummary: string,
  ): Promise<
    | { readonly status: "authenticated"; readonly facts: PrincipalSnapshotFacts }
    | { readonly status: "failed"; readonly failure: CollaborationFailure }
  > {
    const authentication = await deps.platform.authenticate({
      provider: target.provider,
      host: target.host,
      repository_id: target.repository_id,
      principal_id: session.principal_id,
    });
    if (authentication.status === "failed") {
      return { status: "failed", failure: authentication.failure };
    }
    const facts = authentication.snapshot;
    if (facts.principal_id !== session.principal_id) {
      return {
        status: "failed",
        failure: collaborationFailure(
          "permission_denied",
          `authenticated principal ${facts.principal_id} does not own session principal ${session.principal_id}`,
        ),
      };
    }
    if (facts.expires_at <= now()) {
      return {
        status: "failed",
        failure: collaborationFailure("permission_snapshot_stale", staleSummary, true),
      };
    }
    return { status: "authenticated", facts };
  }

  /** Seal fresh snapshot facts into a PrincipalSnapshot record chained on the ref tail. */
  function sealSnapshotRecord(
    facts: PrincipalSnapshotFacts,
    chain: readonly ControlRecord[],
  ): PrincipalSnapshotRecord {
    const previous = chain[chain.length - 1];
    return buildCollaborationRecord({
      record_kind: "principal_snapshot" as const,
      control_sequence: chain.length + 1,
      ...(previous === undefined ? {} : { previous_control_record_digest: previous.record_digest }),
      snapshot_id: snapshotIdFor(facts.principal_id, facts.repository_id, facts.observed_at),
      principal_id: facts.principal_id,
      provider: facts.provider,
      host: facts.host,
      subject_id: facts.subject_id,
      repository_id: facts.repository_id,
      permission: facts.permission,
      observed_at: facts.observed_at,
      expires_at: facts.expires_at,
      source_response_digest: facts.source_response_digest,
    });
  }

  /**
   * Load the authoritative Git state and require an active connection; shared
   * by every remote command except connect (which reads by the command's own
   * target ref) and disconnect (which answers a disconnected project with a
   * no-op outcome instead of a failure).
   */
  async function requireActiveConnection(
    projectId: string,
    commandKind: CollaborationCommand["kind"],
  ): Promise<
    | { readonly status: "ok"; readonly snapshot: ControlSnapshot }
    | { readonly status: "failed"; readonly failure: CollaborationFailure }
  > {
    const state = await readProjectState(deps, controlRef, projectId);
    if (state.status === "failed") return { status: "failed", failure: state.failure };
    if (state.snapshot.latest_connection?.status !== "active") {
      return {
        status: "failed",
        failure: collaborationFailure(
          "coordinator_unavailable",
          `project is not connected; remote command '${commandKind}' is blocked`,
        ),
      };
    }
    return { status: "ok", snapshot: state.snapshot };
  }

  async function connect(
    command: ConnectCommand,
    session: CollaborationSession,
  ): Promise<CollaborationOutcome> {
    // 1. Validate the command.
    const origin = normalizeCoordinatorOrigin(command.coordinator_origin);
    if (origin.status === "failed") return { status: "failed", failure: origin.failure };

    // 2. Resolve the credential-free remote identity (fails closed on
    //    unsupported or ambiguous remotes).
    const identity = await deps.platform.discover(command.canonical_remote);
    if (identity.status === "failed") return { status: "failed", failure: identity.failure };

    // 3. Load authoritative Git state.
    const state = await deps.controlStore.readControl({
      project_id: command.project_id,
      control_ref: controlRef,
      target_ref: command.target_ref,
    });
    if (state.status === "failed") return { status: "failed", failure: state.failure };
    const latest = state.snapshot.latest_connection;

    // 4. Idempotency: a repeated command_id or a semantically identical
    //    reconnect returns the existing revision without new facts.
    if (latest?.command_id === command.command_id) return connectionOutcome(latest, true);
    if (
      latest?.status === "active" &&
      semanticConnectionEqual(latest, {
        canonical_remote: identity.identity.canonical_remote,
        coordinator_origin: origin.origin,
        target_ref: command.target_ref,
        policy_digest: command.policy_digest,
        principal_id: session.principal_id,
      })
    ) {
      return connectionOutcome(latest, true);
    }
    if (latest?.status === "active") {
      return {
        status: "failed",
        failure: collaborationFailure(
          "remote_identity_drift",
          "an active connection with different semantics exists; disconnect before reconnecting",
        ),
      };
    }

    // 5. Authorize: OAuth the session principal and require a fresh,
    //    session-owned permission snapshot.
    const auth = await authenticateFreshSnapshot(
      identity.identity,
      session,
      "platform permission snapshot expired before the connection record could be written",
    );
    if (auth.status === "failed") return { status: "failed", failure: auth.failure };
    const facts = auth.facts;

    // 6. Fail closed unless the platform proves Control Ref protection.
    const protection = await deps.platform.inspectControlRefProtection({
      provider: identity.identity.provider,
      host: identity.identity.host,
      repository_id: identity.identity.repository_id,
      control_ref: controlRef,
    });
    if (protection.status === "unprotected") {
      return { status: "failed", failure: protection.failure };
    }

    // 7. Append the PrincipalSnapshot to the Control Ref via CAS.
    const snapshot = sealSnapshotRecord(facts, state.snapshot.control_records);
    const appended = await deps.controlStore.appendControl({
      project_id: command.project_id,
      control_ref: controlRef,
      ...(state.snapshot.control_head_oid === undefined
        ? {}
        : { expected_head_oid: state.snapshot.control_head_oid }),
      record: snapshot,
    });
    if (appended.status === "failed") return { status: "failed", failure: appended.failure };

    // 8. Append the active CollaborationConnectionRecord to the project.
    const connection = buildCollaborationRecord({
      record_kind: "collaboration_connection" as const,
      connection_id: connectionIdFor(command.project_id, identity.identity.repository_id),
      project_id: command.project_id,
      revision: (latest?.revision ?? 0) + 1,
      status: "active" as const,
      provider: identity.identity.provider,
      repository_id: identity.identity.repository_id,
      canonical_remote: identity.identity.canonical_remote,
      canonical_remote_digest: identity.identity.canonical_remote_digest,
      coordinator_origin: origin.origin,
      target_ref: command.target_ref,
      control_ref: controlRef,
      policy_digest: command.policy_digest,
      actor_principal_id: facts.principal_id,
      principal_snapshot_digest: snapshot.record_digest,
      command_id: command.command_id,
      effective_at: now(),
      ...(latest === undefined ? {} : { supersedes_digest: latest.record_digest }),
    });
    const committed = await deps.controlStore.appendProjectRecord({
      project_id: command.project_id,
      target_ref: command.target_ref,
      record: connection,
    });
    if (committed.status === "failed") return { status: "failed", failure: committed.failure };

    // 9. Update the rebuildable projection; Git stays authoritative on failure.
    const projection = await applyProjection([snapshot, connection]);
    return {
      status: "connected",
      connection,
      replayed: false,
      ...(projection.rebuild_required ? { projection_rebuild_required: true } : {}),
    };
  }

  async function disconnect(
    command: DisconnectCommand,
    session: CollaborationSession,
  ): Promise<CollaborationOutcome> {
    // 1. Load authoritative Git state.
    const state = await readProjectState(deps, controlRef, command.project_id);
    if (state.status === "failed") return { status: "failed", failure: state.failure };
    const latest = state.snapshot.latest_connection;

    // 2. Idempotency and enablement rules (spec §7, §19.2).
    if (latest === undefined) {
      return {
        status: "failed",
        failure: collaborationFailure(
          "coordinator_unavailable",
          "project is not connected; there is no connection to disconnect",
        ),
      };
    }
    if (latest.command_id === command.command_id) return connectionOutcome(latest, true);
    if (latest.status === "disconnected") {
      // No-op, not an idempotent replay: the project is already disconnected,
      // so report the current state without appending a new fact.
      return connectionOutcome(latest, false);
    }

    // 3. Refuse while a live Lease exists; the caller waits or releases first.
    if (hasLiveLease(state.snapshot.control_records, now())) {
      return {
        status: "failed",
        failure: collaborationFailure(
          "lease_unavailable",
          "a live lease still exists; release it or wait for it to expire before disconnecting",
          true,
        ),
      };
    }

    // 4. Append the disconnected revision; history is never rewritten.
    const connection = buildCollaborationRecord({
      record_kind: "collaboration_connection" as const,
      connection_id: latest.connection_id,
      project_id: latest.project_id,
      revision: latest.revision + 1,
      status: "disconnected" as const,
      provider: latest.provider,
      repository_id: latest.repository_id,
      canonical_remote: latest.canonical_remote,
      canonical_remote_digest: latest.canonical_remote_digest,
      coordinator_origin: latest.coordinator_origin,
      target_ref: latest.target_ref,
      control_ref: latest.control_ref,
      policy_digest: latest.policy_digest,
      actor_principal_id: session.principal_id,
      principal_snapshot_digest: latest.principal_snapshot_digest,
      command_id: command.command_id,
      effective_at: now(),
      supersedes_digest: latest.record_digest,
    });
    const committed = await deps.controlStore.appendProjectRecord({
      project_id: command.project_id,
      target_ref: latest.target_ref,
      record: connection,
    });
    if (committed.status === "failed") return { status: "failed", failure: committed.failure };

    const projection = await applyProjection([connection]);
    return {
      status: "disconnected",
      connection,
      replayed: false,
      ...(projection.rebuild_required ? { projection_rebuild_required: true } : {}),
    };
  }

  // --- Remote approval slice -------------------------------------------------

  /** The latest PrincipalSnapshot on the chain, if any. */
  function latestSnapshot(records: readonly ControlRecord[]): PrincipalSnapshotRecord | undefined {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index] as ControlRecord;
      if (record.record_kind === "principal_snapshot") return record as PrincipalSnapshotRecord;
    }
    return undefined;
  }

  /**
   * Validate → authorize → CAS-append the approver's PrincipalSnapshot and the
   * RemoteApprovalDecision (design §13, §13.1). The first legal non-`defer`
   * decision that wins the Control Ref CAS is terminal; later competitors get
   * the existing decision and `defer` never terminates the request. A lost
   * CAS re-reads and re-decides once, mirroring the lease slice.
   */
  async function submitRemoteApproval(
    command: SubmitRemoteApprovalCommand,
    session: CollaborationSession,
  ): Promise<CollaborationOutcome> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const active = await requireActiveConnection(command.project_id, command.kind);
      if (active.status === "failed") return { status: "failed", failure: active.failure };
      const connection = active.snapshot.latest_connection as CollaborationConnectionRecord;
      const records = active.snapshot.control_records;

      // Idempotency and first-terminal-wins over the authoritative chain.
      const replayed = records.find(
        (record): record is RemoteApprovalDecisionRecord =>
          record.record_kind === "remote_approval_decision" &&
          (record as RemoteApprovalDecisionRecord).request_id === command.request_id &&
          (record as RemoteApprovalDecisionRecord).command_id === command.command_id,
      );
      if (replayed !== undefined) {
        return { status: "remote_approval", decision: replayed, replayed: true };
      }
      const terminal = terminalRemoteDecision(records, command.request_id);
      if (terminal !== undefined) {
        return { status: "remote_approval", decision: terminal, replayed: false };
      }

      // Resolve the committed request this decision binds.
      if (deps.readApprovalRequest === undefined) {
        return {
          status: "failed",
          failure: collaborationFailure(
            "coordinator_unavailable",
            "the coordinator has no approval request source; submit_remote_approval is not served",
            true,
          ),
        };
      }
      const request = await deps.readApprovalRequest({
        project_id: command.project_id,
        request_id: command.request_id,
      });
      if (request === undefined) {
        return {
          status: "failed",
          failure: collaborationFailure(
            "approval_binding_mismatch",
            `unknown approval request ${command.request_id}; only a committed request can be remotely approved`,
          ),
        };
      }

      // Authorize: OAuth the session principal and require a fresh snapshot.
      const hostSnapshot = latestSnapshot(records);
      if (hostSnapshot === undefined) {
        return {
          status: "failed",
          failure: collaborationFailure(
            "control_ref_invalid",
            "the active connection has no principal snapshot on the control ref",
          ),
        };
      }
      const auth = await authenticateFreshSnapshot(
        {
          provider: connection.provider,
          host: hostSnapshot.host,
          repository_id: connection.repository_id,
        },
        session,
        "platform permission snapshot expired before the decision could be written",
      );
      if (auth.status === "failed") return { status: "failed", failure: auth.failure };
      const facts = auth.facts;

      // Validate the draft against the committed request and the snapshot.
      const draft: RemoteApprovalDecisionDraft = {
        request_id: request.request_id,
        operation_id: request.workflow_operation_id,
        object_id: request.object_id,
        object_digest: request.object_digest,
        policy_digest: request.policy_digest,
        decision: command.decision,
        // Spec §9.1 default: maintain or admin may take a terminal remote
        // decision; a Project Policy downgrade is bound by its own digest.
        required_permission: "maintain",
        decided_at: now(),
      };
      const validation = validateRemoteApprovalDecision({
        request,
        snapshot: facts,
        decision: draft,
      });
      if (validation.status === "blocked") {
        return { status: "failed", failure: validation.failure };
      }

      // Append the approver's snapshot (reusing an identical one already on
      // the chain, which a retry after a lost response observes) and then the
      // decision, chaining each CAS on the previous head.
      let headOid = active.snapshot.control_head_oid;
      let chain: ControlRecord[] = [...records];
      const appendedRecords: ControlRecord[] = [];
      let casLost = false;

      const snapshotId = snapshotIdFor(facts.principal_id, facts.repository_id, facts.observed_at);
      let snapshot = chain.find(
        (record): record is PrincipalSnapshotRecord =>
          record.record_kind === "principal_snapshot" &&
          (record as PrincipalSnapshotRecord).snapshot_id === snapshotId,
      );
      if (snapshot === undefined) {
        const sealed = sealSnapshotRecord(facts, chain);
        const appended = await deps.controlStore.appendControl({
          project_id: command.project_id,
          control_ref: controlRef,
          ...(headOid === undefined ? {} : { expected_head_oid: headOid }),
          record: sealed,
        });
        if (appended.status === "failed") {
          if (appended.failure.code === "control_ref_cas_failed") continue;
          return { status: "failed", failure: appended.failure };
        }
        headOid = appended.head_oid;
        chain = [...chain, sealed];
        appendedRecords.push(sealed);
        snapshot = sealed;
      }

      const previous = chain[chain.length - 1];
      const decision = buildCollaborationRecord({
        record_kind: "remote_approval_decision" as const,
        control_sequence: chain.length + 1,
        ...(previous === undefined
          ? {}
          : { previous_control_record_digest: previous.record_digest }),
        remote_decision_id: remoteDecisionIdFor(command.command_id, command.request_id),
        ...draft,
        principal_snapshot_digest: snapshot.record_digest,
        command_id: command.command_id,
      });
      const appended = await deps.controlStore.appendControl({
        project_id: command.project_id,
        control_ref: controlRef,
        ...(headOid === undefined ? {} : { expected_head_oid: headOid }),
        record: decision,
      });
      if (appended.status === "failed") {
        if (appended.failure.code === "control_ref_cas_failed") {
          casLost = true;
        } else {
          return { status: "failed", failure: appended.failure };
        }
      }
      if (casLost) continue;
      if (appended.status !== "appended") {
        return {
          status: "failed",
          failure: collaborationFailure(
            "coordinator_unavailable",
            "remote approval append ended in an unexpected state",
          ),
        };
      }
      appendedRecords.push(decision);

      const projection = await applyProjection(appendedRecords);
      return {
        status: "remote_approval",
        decision,
        replayed: false,
        ...(projection.rebuild_required ? { projection_rebuild_required: true } : {}),
      };
    }
    return {
      status: "failed",
      failure: collaborationFailure(
        "control_ref_cas_failed",
        "control ref compare-and-swap was lost twice; re-read and retry the approval command",
        true,
      ),
    };
  }

  async function gatedRemoteCommand(command: CollaborationCommand): Promise<CollaborationOutcome> {
    const active = await requireActiveConnection(command.project_id, command.kind);
    if (active.status === "failed") return { status: "failed", failure: active.failure };
    return {
      status: "failed",
      failure: collaborationFailure(
        "coordinator_unavailable",
        `command '${command.kind}' is not served by the connection-only coordinator slice`,
        true,
      ),
    };
  }

  // --- Lease slice -----------------------------------------------------------

  function leaseRecordsOf(records: readonly ControlRecord[], resourceId: string): LeaseRecord[] {
    return records.filter(
      (record): record is LeaseRecord =>
        record.record_kind === "lease" &&
        (record as LeaseRecord).resource_kind === "operation" &&
        (record as LeaseRecord).resource_id === resourceId,
    );
  }

  /** The per-resource chain a lease command decides over. */
  function leaseHistoryFor(
    records: readonly ControlRecord[],
    command: LeaseCommand,
  ): readonly LeaseRecord[] {
    if (command.kind === "acquire_operation_lease") {
      return leaseRecordsOf(records, command.operation_id);
    }
    const addressed = records.find(
      (record): record is LeaseRecord =>
        record.record_kind === "lease" && (record as LeaseRecord).lease_id === command.lease_id,
    );
    if (addressed === undefined) return [];
    return leaseRecordsOf(records, addressed.resource_id);
  }

  function sealLeaseDraft(
    draft: LeaseDraft,
    chain: readonly ControlRecord[],
    holderDigest: string,
    session: CollaborationSession,
  ): LeaseRecord {
    const previous = chain[chain.length - 1];
    return buildCollaborationRecord({
      record_kind: "lease" as const,
      control_sequence: chain.length + 1,
      ...(previous === undefined ? {} : { previous_control_record_digest: previous.record_digest }),
      ...draft,
      holder_principal_snapshot_digest: holderDigest,
      client_instance_id: session.client_instance_id,
    });
  }

  async function leaseCommand(
    command: LeaseCommand,
    session: CollaborationSession,
  ): Promise<CollaborationOutcome> {
    // A lost Control Ref CAS loops once through a fresh read and a semantic
    // re-decision; a second loss answers lease_unavailable (plan Task 3).
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const active = await requireActiveConnection(command.project_id, command.kind);
      if (active.status === "failed") return { status: "failed", failure: active.failure };
      const records = active.snapshot.control_records;
      const holderDigest = latestSnapshotDigest(records);
      if (holderDigest === undefined) {
        return {
          status: "failed",
          failure: collaborationFailure(
            "control_ref_invalid",
            "the active connection has no principal snapshot on the control ref",
          ),
        };
      }

      let headOid = active.snapshot.control_head_oid;
      let chain: ControlRecord[] = [...records];
      const appendedRecords: LeaseRecord[] = [];
      let transition = transitionLease(leaseHistoryFor(records, command), command, now());
      let casLost = false;
      while (transition.kind === "draft") {
        const record = sealLeaseDraft(transition.draft, chain, holderDigest, session);
        const appended = await deps.controlStore.appendControl({
          project_id: command.project_id,
          control_ref: controlRef,
          ...(headOid === undefined ? {} : { expected_head_oid: headOid }),
          record,
        });
        if (appended.status === "failed") {
          if (appended.failure.code === "control_ref_cas_failed") {
            casLost = true;
            break;
          }
          return { status: "failed", failure: appended.failure };
        }
        headOid = appended.head_oid;
        chain = [...chain, record];
        appendedRecords.push(record);
        transition = transitionLease(leaseHistoryFor(chain, command), command, now());
      }
      if (casLost) continue;

      if (transition.kind === "rejected") {
        return { status: "failed", failure: transition.failure };
      }
      if (transition.kind !== "existing") {
        // Unreachable: the loop above only exits on existing/rejected.
        return {
          status: "failed",
          failure: collaborationFailure(
            "coordinator_unavailable",
            "lease transition ended in an unexpected draft state",
          ),
        };
      }
      const lease = transition.record;
      if (appendedRecords.length === 0) {
        return { status: "lease", lease, replayed: transition.replayed };
      }
      const projection = await applyProjection(appendedRecords);
      return {
        status: "lease",
        lease,
        replayed: false,
        ...(projection.rebuild_required ? { projection_rebuild_required: true } : {}),
      };
    }
    return {
      status: "failed",
      failure: collaborationFailure(
        "lease_unavailable",
        "control ref compare-and-swap was lost twice; re-read and retry the lease command",
        true,
      ),
    };
  }

  async function publishOperationCandidate(
    command: PublishOperationCandidateCommand,
  ): Promise<CollaborationOutcome> {
    const active = await requireActiveConnection(command.project_id, command.kind);
    if (active.status === "failed") return { status: "failed", failure: active.failure };

    // Validate the resource id and fencing token against the authoritative
    // Lease chain: only the holder of the current, live Lease may publish.
    const history = leaseRecordsOf(active.snapshot.control_records, command.operation_id);
    const tip = history[history.length - 1];
    if (tip === undefined) {
      return {
        status: "failed",
        failure: collaborationFailure(
          "lease_unavailable",
          `operation ${command.operation_id} has no lease; acquire one before publishing`,
          true,
        ),
      };
    }
    if (tip.state === "released" || tip.state === "revoked") {
      return {
        status: "failed",
        failure: collaborationFailure(
          "lease_fenced",
          `lease ${tip.lease_id} is ${tip.state}; its fencing token is permanently retired`,
        ),
      };
    }
    if (tip.state === "expired" || tip.expires_at <= now()) {
      return {
        status: "failed",
        failure: collaborationFailure(
          "lease_expired",
          `lease ${tip.lease_id} expired at ${tip.expires_at}; the candidate stays local, re-acquire the lease`,
          true,
        ),
      };
    }
    if (command.fencing_token !== tip.fencing_token) {
      return {
        status: "failed",
        failure: collaborationFailure(
          "lease_fenced",
          `fencing token ${command.fencing_token} is stale; the live lease holds token ${tip.fencing_token}`,
        ),
      };
    }

    const heads = await deps.controlStore.listOperationHeads({ project_id: command.project_id });
    if (heads.status === "failed") return { status: "failed", failure: heads.failure };
    const head = heads.heads.find((entry) => entry.operation_id === command.operation_id);

    // Idempotent replay: the candidate is already the Operation Ref head.
    if (head?.head_oid === command.candidate_commit) {
      return {
        status: "published",
        operation_id: command.operation_id,
        head_oid: command.candidate_commit,
        replayed: true,
      };
    }

    // The store verifies the candidate commit exists and descends from the
    // Operation baseline before CAS; a drifted ref answers operation_ref_drift
    // and the local candidate is preserved for a re-publish.
    const cas = await deps.controlStore.compareAndSwapOperation({
      project_id: command.project_id,
      operation_id: command.operation_id,
      ...(head === undefined ? {} : { expected_head_oid: head.head_oid }),
      candidate_commit: command.candidate_commit,
      fencing_token: tip.fencing_token,
    });
    if (cas.status === "failed") return { status: "failed", failure: cas.failure };
    return {
      status: "published",
      operation_id: command.operation_id,
      head_oid: cas.head_oid,
      replayed: false,
    };
  }

  return {
    execute(command, session) {
      switch (command.kind) {
        case "connect":
          return connect(command, session);
        case "disconnect":
          return disconnect(command, session);
        case "acquire_operation_lease":
        case "renew_operation_lease":
        case "release_operation_lease":
          return leaseCommand(command, session);
        case "publish_operation_candidate":
          return publishOperationCandidate(command);
        case "submit_remote_approval":
          return submitRemoteApproval(command, session);
        default:
          return gatedRemoteCommand(command);
      }
    },
    query(query: CollaborationQuery): Promise<CollaborationView> {
      // The session is part of the frozen Interface; authorization for reads
      // arrives with the transport tasks. Views come from the projection.
      return deps.projection.query(query);
    },
  };
}

/** Result of the Coordinator startup/recovery routine (spec §10.1). */
export type CoordinatorStartup =
  | { readonly status: "ready" }
  | { readonly status: "blocked"; readonly failure: CollaborationFailure };

/**
 * Coordinator startup/recovery routine (spec §10.1): re-read the
 * authoritative Git state, revoke every lease that is still live on the wall
 * clock (a coordinator restart must never inherit a lease whose holder may be
 * gone), then rebuild the disposable projection from Git. Already-expired
 * leases are left untouched — the wall clock has already retired them and
 * `transitionLease` never revives them. Each revocation rides the same CAS
 * policy as lease commands: a lost race re-reads and re-judges once, a second
 * loss blocks startup with `lease_unavailable`. Any failure blocks startup
 * with a typed failure instead of serving stale state.
 */
export async function resumeCollaborationCoordinator(
  deps: CollaborationCoordinatorDependencies,
  projectId: string,
  hint?: { readonly target_ref?: string },
): Promise<CoordinatorStartup> {
  const controlRef = deps.control_ref ?? COLLABORATION_CONTROL_REF;
  const now = deps.now ?? (() => new Date().toISOString());
  const read = () => readProjectState(deps, controlRef, projectId, hint?.target_ref);

  // 1. Load the authoritative Git state; the projection hint only locates it.
  const initial = await read();
  if (initial.status === "failed") return { status: "blocked", failure: initial.failure };
  let snapshot = initial.snapshot;

  // 2. Revoke every lease still live on the wall clock, resource by resource.
  const resourceIds = new Set<string>();
  for (const record of snapshot.control_records) {
    if (record.record_kind === "lease" && (record as LeaseRecord).resource_kind === "operation") {
      resourceIds.add((record as LeaseRecord).resource_id);
    }
  }
  for (const resourceId of resourceIds) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) {
        const fresh = await read();
        if (fresh.status === "failed") return { status: "blocked", failure: fresh.failure };
        snapshot = fresh.snapshot;
      }
      const history = snapshot.control_records.filter(
        (record): record is LeaseRecord =>
          record.record_kind === "lease" &&
          (record as LeaseRecord).resource_kind === "operation" &&
          (record as LeaseRecord).resource_id === resourceId,
      );
      const tip = history[history.length - 1];
      const live =
        tip !== undefined &&
        (tip.state === "granted" || tip.state === "renewed") &&
        tip.expires_at > now();
      if (!live) break;
      const holderDigest = latestSnapshotDigest(snapshot.control_records);
      if (holderDigest === undefined) {
        return {
          status: "blocked",
          failure: collaborationFailure(
            "control_ref_invalid",
            "cannot revoke a live lease: the control ref has no principal snapshot",
          ),
        };
      }
      const chain = snapshot.control_records;
      const previous = chain[chain.length - 1];
      const record = buildCollaborationRecord({
        record_kind: "lease" as const,
        control_sequence: chain.length + 1,
        ...(previous === undefined
          ? {}
          : { previous_control_record_digest: previous.record_digest }),
        ...leaseRevocationDraft(tip, now()),
        holder_principal_snapshot_digest: holderDigest,
        client_instance_id: tip.client_instance_id,
      });
      const appended = await deps.controlStore.appendControl({
        project_id: projectId,
        control_ref: controlRef,
        ...(snapshot.control_head_oid === undefined
          ? {}
          : { expected_head_oid: snapshot.control_head_oid }),
        record,
      });
      if (appended.status === "failed") {
        if (appended.failure.code === "control_ref_cas_failed" && attempt === 0) continue;
        return {
          status: "blocked",
          failure:
            appended.failure.code === "control_ref_cas_failed"
              ? collaborationFailure(
                  "lease_unavailable",
                  "control ref compare-and-swap was lost twice during startup revocation; retry the resume",
                  true,
                )
              : appended.failure,
        };
      }
      snapshot = {
        control_head_oid: appended.head_oid,
        control_records: [...chain, record],
        ...(snapshot.latest_connection === undefined
          ? {}
          : { latest_connection: snapshot.latest_connection }),
      };
      break;
    }
  }

  // 3. Rebuild the disposable projection from the authoritative state.
  try {
    await deps.projection.rebuild({
      project_id: projectId,
      ...(snapshot.latest_connection === undefined
        ? {}
        : { latest_connection: snapshot.latest_connection }),
      control_records: snapshot.control_records,
    });
  } catch (error) {
    return {
      status: "blocked",
      failure: collaborationFailure(
        "projection_rebuild_required",
        `coordinator projection rebuild failed at startup: ${error instanceof Error ? error.message : "unknown error"}`,
        true,
      ),
    };
  }
  return { status: "ready" };
}
