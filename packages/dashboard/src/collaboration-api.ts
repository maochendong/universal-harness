import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  PROTOCOL_1_2_SCHEMA_REGISTRY,
  canonicalizeJson,
  harnessRootFor,
  ulid,
  verifyRecordEnvelope,
  type CollaborationConnectionRecord,
  type IntegrationRecord,
  type RemoteApprovalDecisionRecord,
} from "@universal-harness-internal/core";
import {
  HttpCollaborationCoordinatorError,
  createHttpCollaborationCoordinatorAdapter,
  type CollaborationCoordinatorPort,
  type CollaborationFailedOutcome,
  type CollaborationSession,
  type RemoteApprovalDecision,
} from "@universal-harness-internal/runtime";

import { DashboardProblem } from "./problem.js";

/**
 * The single Dashboard collaboration Adapter (plan M3 Task 8). It loads the
 * connection status locally from the project Ledger
 * (`.harness/collaboration/connections/*`, the Git-committed authoritative
 * fact) and forwards every remote query/command through the shared
 * `CollaborationCoordinatorPort` HTTPS Adapter. No OAuth, permission,
 * Approval or recovery logic lives here; the SQLite projection is only ever
 * reported with its observation time, never treated as accepted project truth
 * (design §18.2/§20). A project without an active Ledger connection makes
 * zero remote requests (§19.3).
 */

/** Connection status read from the local project Ledger; the Git-authoritative fact. */
export interface DashboardCollaborationConnectionView {
  readonly authority: "project_ledger";
  readonly status: "active" | "disconnected" | "not_connected";
  readonly connection?: CollaborationConnectionRecord;
  /** Present only for an active connection; the coordinator's observed projection. */
  readonly remote?: DashboardRemoteConnectionObservation;
}

export interface DashboardRemoteConnectionObservation {
  readonly authority: "control_ref";
  readonly projection_observed_at: string;
  readonly status: "active" | "disconnected" | "not_connected" | "unreachable";
  /** True when the remote projection lags the Ledger's connection revision. */
  readonly stale?: boolean;
}

export interface DashboardRemoteApprovalInbox {
  readonly authority: "control_ref";
  readonly projection_observed_at: string;
  readonly decisions: readonly RemoteApprovalDecisionRecord[];
}

export interface DashboardIntegrationConflictList {
  readonly authority: "control_ref";
  readonly projection_observed_at: string;
  readonly conflicts: readonly IntegrationRecord[];
}

export interface DashboardCollaborationApi {
  connection(): Promise<DashboardCollaborationConnectionView>;
  remoteApprovals(): Promise<DashboardRemoteApprovalInbox>;
  integrationConflicts(): Promise<DashboardIntegrationConflictList>;
  submitRemoteApproval(input: {
    readonly requestId: string;
    readonly decision: RemoteApprovalDecision;
  }): Promise<unknown>;
  retryIntegration(input: { readonly integrationId: string }): Promise<unknown>;
}

export interface DashboardCollaborationApiOptions {
  readonly projectRoot: string;
  /**
   * Coordinator port seam; defaults to the HTTPS transport Adapter. The
   * session credential the CLI's connect persisted in the disposable client
   * cache is handed over so CLI and Dashboard share the §17.1 session.
   */
  readonly portForOrigin?: (
    origin: string,
    session: { readonly session_credential?: string },
  ) => CollaborationCoordinatorPort;
  readonly now?: () => string;
  readonly newCommandId?: () => string;
}

const CONNECTION_FILE = /^rev-([0-9]{12})\.json$/u;

/** Credential-shaped keys never leave this Adapter, whatever the wire carries. */
/** Exact credential-shaped key names never leave this Adapter, whatever the wire carries. */
const SENSITIVE_KEYS = new Set([
  "access_token",
  "refresh_token",
  "id_token",
  "session_credential",
  "client_secret",
  "secret",
  "authorization",
]);

function redactValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => redactValue(item)) as T;
  if (typeof value === "object" && value !== null) {
    const redacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (!SENSITIVE_KEYS.has(key.toLowerCase())) redacted[key] = redactValue(entry);
    }
    return redacted as T;
  }
  return value;
}

function invalidLedger(detail: string): DashboardProblem {
  return new DashboardProblem(
    503,
    "collaboration_ledger_invalid",
    "Service Unavailable",
    `the local collaboration Ledger records failed validation: ${detail}`,
  );
}

/** Raw fs failures inside the managed tree are fail-closed ledger errors, never bare 500s. */
function listDirectory(path: string, where: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    throw invalidLedger(`${where} is not a readable connection directory`);
  }
}

function readConnectionFile(path: string, where: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw invalidLedger(`connection record ${where} is not a readable file`);
  }
}

/**
 * Current connection record in the local project Ledger, or undefined when
 * the project never connected. Every file under the managed connections
 * directory must parse, match its path and pass schema, envelope and
 * canonical-form checks; anything else fails closed (the Git authority must
 * not be guessed). Reconnecting to a different repository mints a new
 * `connection_id` whose revision restarts at 1, so the latest revision is
 * taken per connection id first; the current connection is the single active
 * one among those, otherwise the most recent by `effective_at` (ties break on
 * the connection id for determinism).
 */
export function readLocalConnection(
  projectRoot: string,
): CollaborationConnectionRecord | undefined {
  const root = join(harnessRootFor(projectRoot), "collaboration", "connections");
  if (!existsSync(root)) return undefined;
  const latestByConnection = new Map<string, CollaborationConnectionRecord>();
  for (const connectionId of listDirectory(root, "connections/")) {
    const directory = join(root, connectionId);
    for (const name of listDirectory(directory, `connections/${connectionId}`)) {
      const match = CONNECTION_FILE.exec(name);
      if (match === null) throw invalidLedger(`unexpected connection file ${name}`);
      const content = readConnectionFile(join(directory, name), `${connectionId}/${name}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(content) as unknown;
      } catch {
        throw invalidLedger(`connection record ${connectionId}/${name} is not JSON`);
      }
      const record = parsed as CollaborationConnectionRecord;
      if (
        record.record_kind !== "collaboration_connection" ||
        record.connection_id !== connectionId ||
        record.revision !== Number(match[1]) ||
        !PROTOCOL_1_2_SCHEMA_REGISTRY.validate("collaboration-connection", record).valid ||
        !verifyRecordEnvelope(record as unknown as Record<string, unknown>) ||
        content !== `${canonicalizeJson(record)}\n`
      ) {
        throw invalidLedger(
          `connection record ${connectionId}/${name} failed schema, digest or canonical-form checks`,
        );
      }
      const previous = latestByConnection.get(connectionId);
      if (previous === undefined || record.revision > previous.revision) {
        latestByConnection.set(connectionId, record);
      }
    }
  }
  const candidates = [...latestByConnection.values()];
  const active = candidates.filter((record) => record.status === "active");
  if (active.length === 1) return active[0];
  const pool = active.length > 1 ? active : candidates;
  return pool
    .slice()
    .sort(
      (left, right) =>
        right.effective_at.localeCompare(left.effective_at) ||
        right.connection_id.localeCompare(left.connection_id),
    )[0];
}

interface ClientSessionLocator {
  readonly client_instance_id: string;
  readonly session_credential?: string;
}

/**
 * Read-only view of the CLI-owned disposable client cache
 * (`.harness/cache/collaboration-client.json`): it carries this host's client
 * instance id and the Coordinator bearer session credential issued at
 * connect. Missing or unreadable cache degrades to an anonymous session; the
 * Coordinator then answers `authentication_required` (fail-closed). The
 * Dashboard never writes this file.
 */
function readClientSessionLocator(projectRoot: string): ClientSessionLocator | undefined {
  const path = join(harnessRootFor(projectRoot), "cache", "collaboration-client.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      version?: unknown;
      client_instance_id?: unknown;
      session_credential?: unknown;
    };
    if (parsed.version !== 1 || typeof parsed.client_instance_id !== "string") return undefined;
    return {
      client_instance_id: parsed.client_instance_id,
      ...(typeof parsed.session_credential === "string"
        ? { session_credential: parsed.session_credential }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function notConnected(): DashboardProblem {
  return new DashboardProblem(
    404,
    "collaboration_not_connected",
    "Not Found",
    "this project has no active remote collaboration connection in its Ledger",
  );
}

/** Transport failures collapse onto the typed code; wire text never leaks. */
function coordinatorProblem(error: unknown): never {
  if (error instanceof DashboardProblem) throw error;
  if (error instanceof HttpCollaborationCoordinatorError) {
    throw new DashboardProblem(
      503,
      error.code,
      "Service Unavailable",
      `the coordinator could not serve the request (${error.code})`,
    );
  }
  throw error;
}

function failedOutcomeProblem(outcome: CollaborationFailedOutcome): never {
  throw new DashboardProblem(
    outcome.failure.retryable ? 503 : 409,
    outcome.failure.code,
    outcome.failure.retryable ? "Service Unavailable" : "Conflict",
    outcome.failure.summary,
  );
}

function unexpectedView(view: { readonly kind: string }, expected: string): never {
  throw new DashboardProblem(
    503,
    "coordinator_unavailable",
    "Service Unavailable",
    `the coordinator answered ${view.kind} where ${expected} was expected`,
  );
}

/** Node-level network failure codes the HTTPS Adapter may surface unwrapped. */
const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
]);

/**
 * Only transport-level failures may degrade the connection view to
 * `unreachable`; protocol violations and programming errors must propagate.
 */
function isTransportFailure(error: unknown): boolean {
  if (error instanceof HttpCollaborationCoordinatorError) return true;
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === "string" && NETWORK_ERROR_CODES.has(code);
}

export function createDashboardCollaborationApi(
  options: DashboardCollaborationApiOptions,
): DashboardCollaborationApi {
  const now = options.now ?? (() => new Date().toISOString());
  const newCommandId = options.newCommandId ?? (() => `command_${ulid()}`);
  const portForOrigin =
    options.portForOrigin ??
    ((origin: string, session: { readonly session_credential?: string }) =>
      createHttpCollaborationCoordinatorAdapter({
        origin,
        ...(session.session_credential === undefined
          ? {}
          : { session_credential: session.session_credential }),
      }));

  function activeConnection(): CollaborationConnectionRecord | undefined {
    const connection = readLocalConnection(options.projectRoot);
    return connection?.status === "active" ? connection : undefined;
  }

  function requireActive(): CollaborationConnectionRecord {
    const connection = activeConnection();
    if (connection === undefined) throw notConnected();
    return connection;
  }

  function remote(connection: CollaborationConnectionRecord): {
    readonly port: CollaborationCoordinatorPort;
    readonly session: CollaborationSession;
  } {
    const locator = readClientSessionLocator(options.projectRoot);
    return {
      port: portForOrigin(connection.coordinator_origin, {
        ...(locator?.session_credential === undefined
          ? {}
          : { session_credential: locator.session_credential }),
      }),
      session: {
        principal_id: connection.actor_principal_id,
        client_instance_id: locator?.client_instance_id ?? "instance_dashboard",
      },
    };
  }

  return {
    async connection() {
      const local = readLocalConnection(options.projectRoot);
      if (local === undefined) {
        return { authority: "project_ledger" as const, status: "not_connected" as const };
      }
      const base = {
        authority: "project_ledger" as const,
        status: local.status,
        connection: local,
      };
      // §19.3: only an active Ledger connection justifies a remote request.
      if (local.status !== "active") return base;
      try {
        const { port, session } = remote(local);
        const view = redactValue(
          await port.query({ kind: "connection_status", project_id: local.project_id }, session),
        );
        if (view.kind !== "connection_status") unexpectedView(view, "connection_status");
        const stale = view.connection !== undefined && view.connection.revision < local.revision;
        return {
          ...base,
          remote: {
            authority: "control_ref" as const,
            projection_observed_at: now(),
            status: view.status,
            ...(stale ? { stale: true as const } : {}),
          },
        };
      } catch (error) {
        // Only a transport failure degrades to unreachable; the Ledger fact
        // stays authoritative and served either way.
        if (!isTransportFailure(error)) throw error;
        return {
          ...base,
          remote: {
            authority: "control_ref" as const,
            projection_observed_at: now(),
            status: "unreachable" as const,
          },
        };
      }
    },

    async remoteApprovals() {
      const connection = requireActive();
      try {
        const { port, session } = remote(connection);
        const view = redactValue(
          await port.query({ kind: "approval_inbox", project_id: connection.project_id }, session),
        );
        if (view.kind !== "approval_inbox") unexpectedView(view, "approval_inbox");
        return {
          authority: "control_ref" as const,
          projection_observed_at: now(),
          decisions: view.decisions,
        };
      } catch (error) {
        coordinatorProblem(error);
      }
    },

    async integrationConflicts() {
      const connection = requireActive();
      try {
        const { port, session } = remote(connection);
        const view = redactValue(
          await port.query(
            { kind: "integration_conflicts", project_id: connection.project_id },
            session,
          ),
        );
        if (view.kind !== "integration_conflicts") {
          unexpectedView(view, "integration_conflicts");
        }
        return {
          authority: "control_ref" as const,
          projection_observed_at: now(),
          conflicts: view.conflicts,
        };
      } catch (error) {
        coordinatorProblem(error);
      }
    },

    async submitRemoteApproval(input) {
      const connection = requireActive();
      try {
        const { port, session } = remote(connection);
        const outcome = await port.execute(
          {
            kind: "submit_remote_approval",
            command_id: newCommandId(),
            project_id: connection.project_id,
            request_id: input.requestId,
            decision: input.decision,
          },
          session,
        );
        if (outcome.status === "failed") failedOutcomeProblem(outcome);
        if (outcome.status !== "remote_approval") {
          throw new DashboardProblem(
            503,
            "coordinator_unavailable",
            "Service Unavailable",
            `the coordinator answered ${outcome.status} where remote_approval was expected`,
          );
        }
        return {
          authority: "control_ref",
          projection_observed_at: now(),
          decision: redactValue(outcome.decision),
          replayed: outcome.replayed,
          ...(outcome.projection_rebuild_required === true
            ? { projection_rebuild_required: true }
            : {}),
        };
      } catch (error) {
        coordinatorProblem(error);
      }
    },

    async retryIntegration(input) {
      const connection = requireActive();
      try {
        const { port, session } = remote(connection);
        // The expected Target commit binds the retry to the prepared record
        // the conflicts projection knows (same rule as the CLI accept flow).
        const view = redactValue(
          await port.query(
            { kind: "integration_conflicts", project_id: connection.project_id },
            session,
          ),
        );
        if (view.kind !== "integration_conflicts") {
          unexpectedView(view, "integration_conflicts");
        }
        const prepared = view.conflicts.find(
          (record) => record.integration_id === input.integrationId,
        );
        if (prepared === undefined) {
          throw new DashboardProblem(
            404,
            "integration_not_found",
            "Not Found",
            `no prepared integration ${input.integrationId} is known to the coordinator`,
          );
        }
        const outcome = await port.execute(
          {
            kind: "accept_integration",
            command_id: newCommandId(),
            project_id: connection.project_id,
            integration_id: input.integrationId,
            expected_target_commit: prepared.expected_target_commit,
          },
          session,
        );
        if (outcome.status === "failed") failedOutcomeProblem(outcome);
        if (outcome.status !== "accepted") {
          throw new DashboardProblem(
            503,
            "coordinator_unavailable",
            "Service Unavailable",
            `the coordinator answered ${outcome.status} where accepted was expected`,
          );
        }
        return {
          authority: "control_ref",
          projection_observed_at: now(),
          integration_id: outcome.integration_record.integration_id,
          target_commit: outcome.target_commit,
          replayed: outcome.replayed,
          ...(outcome.projection_rebuild_required === true
            ? { projection_rebuild_required: true }
            : {}),
        };
      } catch (error) {
        coordinatorProblem(error);
      }
    },
  };
}

/** Stub used when the Dashboard startup could not materialize project state. */
export function unavailableDashboardCollaborationApi(
  problem: DashboardProblem,
): DashboardCollaborationApi {
  const reject = (): Promise<never> => Promise.reject(problem);
  return {
    connection: reject,
    remoteApprovals: reject,
    integrationConflicts: reject,
    submitRemoteApproval: reject,
    retryIntegration: reject,
  };
}
