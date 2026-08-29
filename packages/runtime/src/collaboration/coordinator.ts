import type {
  CollaborationConnectionRecord,
  ControlRecord,
  LeaseRecord,
} from "@universal-harness-internal/core";
import { buildCollaborationRecord } from "@universal-harness-internal/core";

import {
  COLLABORATION_CONTROL_REF,
  connectionIdFor,
  hasLiveLease,
  normalizeCoordinatorOrigin,
  semanticConnectionEqual,
  snapshotIdFor,
} from "./connection.js";
import { collaborationFailure } from "./errors.js";
import { transitionLease, type LeaseCommand, type LeaseDraft } from "./lease.js";
import type {
  CollaborationCommand,
  CollaborationCoordinatorPort,
  CollaborationOutcome,
  CollaborationQuery,
  CollaborationSession,
  CollaborationView,
  ConnectCommand,
  ConnectedOutcome,
  CoordinatorProjectionPort,
  DisconnectCommand,
  DisconnectedOutcome,
  GitControlStorePort,
  PlatformIdentityPort,
  PublishOperationCandidateCommand,
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
 * answers `lease_unavailable`. Approval and Integration commands are
 * implemented by later tasks; this slice answers them with a typed
 * `coordinator_unavailable` failure.
 */
export interface CollaborationCoordinatorDependencies {
  readonly platform: PlatformIdentityPort;
  readonly controlStore: GitControlStorePort;
  readonly projection: CoordinatorProjectionPort;
  /** Protected Control Ref; fixed to `harness/control` by default (spec §10). */
  readonly control_ref?: string;
  /** Injectable clock (ISO 8601 UTC) for deterministic tests. */
  readonly now?: () => string;
}

function connectionOutcome(
  record: CollaborationConnectionRecord,
  replayed: boolean,
): ConnectedOutcome | DisconnectedOutcome {
  return record.status === "active"
    ? { status: "connected", connection: record, replayed }
    : { status: "disconnected", connection: record, replayed };
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
    const authentication = await deps.platform.authenticate({
      provider: identity.identity.provider,
      host: identity.identity.host,
      repository_id: identity.identity.repository_id,
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
        failure: collaborationFailure(
          "permission_snapshot_stale",
          "platform permission snapshot expired before the connection record could be written",
          true,
        ),
      };
    }

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
    const controlRecords = state.snapshot.control_records;
    const previousControl = controlRecords[controlRecords.length - 1];
    const snapshot = buildCollaborationRecord({
      record_kind: "principal_snapshot" as const,
      control_sequence: controlRecords.length + 1,
      ...(previousControl === undefined
        ? {}
        : { previous_control_record_digest: previousControl.record_digest }),
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
    const state = await deps.controlStore.readControl({
      project_id: command.project_id,
      control_ref: controlRef,
    });
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

  async function gatedRemoteCommand(command: CollaborationCommand): Promise<CollaborationOutcome> {
    const state = await deps.controlStore.readControl({
      project_id: command.project_id,
      control_ref: controlRef,
    });
    if (state.status === "failed") return { status: "failed", failure: state.failure };
    if (state.snapshot.latest_connection?.status !== "active") {
      return {
        status: "failed",
        failure: collaborationFailure(
          "coordinator_unavailable",
          `project is not connected; remote command '${command.kind}' is blocked`,
        ),
      };
    }
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

  /** The holder snapshot digest for new Lease records: latest snapshot on the ref. */
  function latestSnapshotDigest(records: readonly ControlRecord[]): string | undefined {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index] as ControlRecord;
      if (record.record_kind === "principal_snapshot") return record.record_digest;
    }
    return undefined;
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
      const state = await deps.controlStore.readControl({
        project_id: command.project_id,
        control_ref: controlRef,
      });
      if (state.status === "failed") return { status: "failed", failure: state.failure };
      if (state.snapshot.latest_connection?.status !== "active") {
        return {
          status: "failed",
          failure: collaborationFailure(
            "coordinator_unavailable",
            `project is not connected; remote command '${command.kind}' is blocked`,
          ),
        };
      }
      const records = state.snapshot.control_records;
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

      let headOid = state.snapshot.control_head_oid;
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
    const state = await deps.controlStore.readControl({
      project_id: command.project_id,
      control_ref: controlRef,
    });
    if (state.status === "failed") return { status: "failed", failure: state.failure };
    if (state.snapshot.latest_connection?.status !== "active") {
      return {
        status: "failed",
        failure: collaborationFailure(
          "coordinator_unavailable",
          `project is not connected; remote command '${command.kind}' is blocked`,
        ),
      };
    }

    // Validate the resource id and fencing token through the Lease projection:
    // only the holder of the current, live Lease may publish.
    const history = leaseRecordsOf(state.snapshot.control_records, command.operation_id);
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
