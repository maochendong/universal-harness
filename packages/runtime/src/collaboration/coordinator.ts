import type { CollaborationConnectionRecord } from "@universal-harness-internal/core";
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
} from "./port.js";

/**
 * Connection-slice Coordinator: command routing, command_id idempotency and
 * fail-closed orchestration for connect/disconnect. Every command runs as
 * validate → load authoritative Git state → authorize → append via CAS →
 * update the SQLite projection. Git is authoritative; when the projection
 * update fails after a successful append, the outcome carries
 * `projection_rebuild_required` and the append is never blindly retried.
 *
 * Lease, Approval and Integration commands are implemented by later tasks;
 * this slice answers them with a typed `coordinator_unavailable` failure.
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

  async function applyProjection(
    records: readonly Parameters<CoordinatorProjectionPort["apply"]>[0][],
  ): Promise<boolean> {
    try {
      for (const record of records) {
        await deps.projection.apply(record);
      }
      return false;
    } catch {
      return true;
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
    const rebuildRequired = await applyProjection([snapshot, connection]);
    return {
      status: "connected",
      connection,
      replayed: false,
      ...(rebuildRequired ? { projection_rebuild_required: true } : {}),
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
      target_ref: "",
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
    if (latest.status === "disconnected") return connectionOutcome(latest, true);

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

    const rebuildRequired = await applyProjection([connection]);
    return {
      status: "disconnected",
      connection,
      replayed: false,
      ...(rebuildRequired ? { projection_rebuild_required: true } : {}),
    };
  }

  async function gatedRemoteCommand(command: CollaborationCommand): Promise<CollaborationOutcome> {
    const state = await deps.controlStore.readControl({
      project_id: command.project_id,
      control_ref: controlRef,
      target_ref: "",
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

  return {
    execute(command, session) {
      switch (command.kind) {
        case "connect":
          return connect(command, session);
        case "disconnect":
          return disconnect(command, session);
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
