import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { createGitControlStoreAdapter } from "@universal-harness-internal/adapter-vcs-git";
import {
  DEFAULT_PROFILE_POLICY_DIGEST,
  readLatestProjectProfile,
  type CollaborationConnectionRecord,
} from "@universal-harness-internal/core";
import {
  ApprovalService,
  OrchestrationError,
  RemoteDiscoveryError,
  SqliteCoordinatorProjection,
  createCollaborationCoordinator,
  createCoordinatorOAuthBridge,
  createHttpCollaborationCoordinatorAdapter,
  createNodeHttpsFetch,
  createOAuthSessionStore,
  createPlatformIdentityRegistry,
  materializeRemoteApprovalDecision,
  normalizeGitRemote,
  resumeCollaborationCoordinator,
  startCollaborationCoordinatorServer,
  type CollaborationCoordinatorPort,
  type CollaborationCoordinatorServer,
  type CollaborationFailedOutcome,
  type CollaborationSession,
  type GitControlStorePort,
  type LeaseOutcome,
  type PlatformAdapterConfig,
} from "@universal-harness-internal/runtime";

import type { CliIo, CommandResult } from "../io.js";
import type {
  ApproveRequest,
  ConnectRequest,
  CoordinatorHostRequest,
  DisconnectRequest,
  IntegrateRequest,
  ProjectRequest,
  SyncRequest,
} from "../router.js";
import {
  activeClientConnection,
  collaborationClientState,
  mintCollaborationClientState,
  readCollaborationClientState,
  writeCollaborationClientState,
  type CollaborationClientState,
} from "./collaboration-client.js";

/**
 * Remote collaboration wiring for the orchestrated runtime service (plan M3
 * Task 7 steps 4-5). Every remote command goes through the injected (or
 * default HTTPS) Coordinator port; the local client cache is only a locator —
 * the Coordinator re-verifies each command against authoritative Git state.
 * Never-connected projects never reach this module (zero materialization).
 */
export interface CollaborationRuntimeSeams {
  /** Coordinator port for an origin; defaults to the HTTPS client adapter. */
  readonly portForOrigin?: (origin: string) => CollaborationCoordinatorPort;
  /** Control store used to materialize remote approvals; defaults to the Git adapter. */
  readonly controlStoreFor?: (
    projectRoot: string,
    connection: CollaborationConnectionRecord,
  ) => GitControlStorePort;
  /** Host composition for `harness coordinator`; defaults to the real TLS server. */
  readonly hostCoordinator?: (
    request: CoordinatorHostRequest,
  ) => Promise<CollaborationCoordinatorServer>;
}

export interface CollaborationRemoteContext {
  readonly projectRoot: string;
  readonly connection: CollaborationConnectionRecord;
  readonly port: CollaborationCoordinatorPort;
  readonly session: CollaborationSession;
  readonly state: CollaborationClientState;
}

export interface CliCollaborationRuntime {
  connect(request: ConnectRequest): Promise<CommandResult>;
  disconnect(request: DisconnectRequest): Promise<CommandResult>;
  sync(request: SyncRequest): Promise<CommandResult>;
  integrate(request: IntegrateRequest): Promise<CommandResult>;
  coordinator(request: CoordinatorHostRequest): Promise<CommandResult>;
  remoteSummary(request: ProjectRequest): Promise<Record<string, unknown> | undefined>;
  /** Remote approve routing; undefined when the project is not connected. */
  submitRemoteApproval(request: ApproveRequest): Promise<CommandResult | undefined>;
  /** Active remote context for the lease-gated iterate/resume flows. */
  remoteContext(projectRoot: string): CollaborationRemoteContext | undefined;
  acquireLease(
    context: CollaborationRemoteContext,
    operationId: string,
  ): Promise<LeaseOutcome | CollaborationFailedOutcome>;
  /** Renew a cached lease; fall back to a fresh acquire when renewal fails. */
  renewOrAcquireLease(
    context: CollaborationRemoteContext,
    operationId: string,
  ): Promise<LeaseOutcome | CollaborationFailedOutcome>;
  releaseLease(context: CollaborationRemoteContext, operationId: string): Promise<void>;
  /**
   * Push local candidate commits to the staging ref and publish them with the
   * caller's fencing token. A returned failed outcome says the publish went
   * wrong; undefined means HEAD never advanced or the publish succeeded.
   */
  publishCandidate(
    context: CollaborationRemoteContext,
    operationId: string,
    baselineBefore: string,
  ): Promise<CollaborationFailedOutcome | undefined>;
}

export interface CliCollaborationRuntimeDependencies {
  readonly io: CliIo;
  readonly now: () => string;
  readonly newId: (kind: string) => string;
  readonly projectIdFor: (projectRoot: string) => string;
  /** Current Git baseline (HEAD) of the project worktree. */
  readonly readBaseline: (projectRoot: string) => string;
  readonly seams?: CollaborationRuntimeSeams;
}

/** Candidate staging ref namespace, mirrored by the Coordinator's integration prepare. */
const CANDIDATE_STAGING_PREFIX = "refs/heads/harness/candidate";

function failedOutcome(
  command: string,
  failure: { readonly code: string; readonly summary: string; readonly retryable: boolean },
): CommandResult {
  return {
    command,
    status: "failed",
    message: failure.summary,
    data: { kind: failure.code, retryable: failure.retryable },
  };
}

function notConnected(command: string): CommandResult {
  return {
    command,
    status: "failed",
    message:
      "no active collaboration connection; run harness connect --coordinator <https://host:port> first",
    data: { kind: "not_connected" },
  };
}

/** The port's execute returns the full union; a mismatched outcome fails closed. */
function unexpectedOutcome(command: string, expected: string): CommandResult {
  return failedOutcome(command, {
    code: "coordinator_unavailable",
    summary: `coordinator returned an unexpected outcome (expected ${expected})`,
    retryable: true,
  });
}

function git(projectRoot: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: projectRoot, encoding: "utf8" }).trim();
}

// --- Coordinator host configuration ------------------------------------------

interface CoordinatorProviderConfig {
  readonly provider: "github" | "gitlab" | "gitee";
  readonly host: string;
  readonly api_base_url: string;
  readonly authorize_url: string;
  readonly token_url: string;
  readonly client_id: string;
  readonly scope?: string;
  readonly coordinator_identity: string;
  /** Name of the host-injected Git credential variable; never a value. */
  readonly credential_env?: string;
}

interface CoordinatorConfig {
  readonly version: 1;
  readonly remote: string;
  readonly project_id: string;
  readonly state_dir: string;
  readonly providers: readonly CoordinatorProviderConfig[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(container: Record<string, unknown>, field: string, where: string): string {
  const value = container[field];
  if (typeof value !== "string" || value === "") {
    throw new OrchestrationError("configuration", `${where} requires a non-empty ${field}`);
  }
  return value;
}

/** Parse and validate the host-owned provider config; secret fields stay names. */
export function readCoordinatorConfig(configPath: string): CoordinatorConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  } catch {
    throw new OrchestrationError(
      "configuration",
      `coordinator config at ${configPath} is not readable JSON`,
    );
  }
  if (!isRecord(raw) || raw["version"] !== 1) {
    throw new OrchestrationError("configuration", "coordinator config must carry version 1");
  }
  const remote = requireString(raw, "remote", "coordinator config");
  const projectId = requireString(raw, "project_id", "coordinator config");
  const stateDir = requireString(raw, "state_dir", "coordinator config");
  if (!isAbsolute(stateDir)) {
    throw new OrchestrationError(
      "configuration",
      "coordinator config state_dir must be an absolute host path",
    );
  }
  const providers = raw["providers"];
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new OrchestrationError(
      "configuration",
      "coordinator config requires a non-empty providers array",
    );
  }
  const parsed: CoordinatorProviderConfig[] = providers.map((entry, index) => {
    const where = `provider config ${String(index)}`;
    if (!isRecord(entry)) {
      throw new OrchestrationError("configuration", `${where} must be an object`);
    }
    const provider = entry["provider"];
    if (provider !== "github" && provider !== "gitlab" && provider !== "gitee") {
      throw new OrchestrationError(
        "configuration",
        `${where} provider must be github, gitlab or gitee`,
      );
    }
    const credentialEnv = entry["credential_env"];
    if (credentialEnv !== undefined && typeof credentialEnv !== "string") {
      throw new OrchestrationError(
        "configuration",
        `${where} credential_env must name an environment variable`,
      );
    }
    const scope = entry["scope"];
    return {
      provider,
      host: requireString(entry, "host", where),
      api_base_url: requireString(entry, "api_base_url", where),
      authorize_url: requireString(entry, "authorize_url", where),
      token_url: requireString(entry, "token_url", where),
      client_id: requireString(entry, "client_id", where),
      coordinator_identity: requireString(entry, "coordinator_identity", where),
      ...(typeof scope === "string" ? { scope } : {}),
      ...(typeof credentialEnv === "string" ? { credential_env: credentialEnv } : {}),
    };
  });
  return { version: 1, remote, project_id: projectId, state_dir: stateDir, providers: parsed };
}

export function createCliCollaborationRuntime(
  deps: CliCollaborationRuntimeDependencies,
): CliCollaborationRuntime {
  const portFor = (
    origin: string,
    options: {
      readonly credential?: string;
      readonly onCredential?: (credential: string) => void;
    } = {},
  ): CollaborationCoordinatorPort =>
    deps.seams?.portForOrigin?.(origin) ??
    createHttpCollaborationCoordinatorAdapter({
      origin,
      // The deferred OAuth driver (plan step 2): surface the coordinator-local
      // authorization URL on stderr; the browser flow completes out of band
      // and the adapter polls the flow-bound connection-status query.
      authorize: (authorizationUrl) => {
        deps.io.writeStderr(`open this URL to authorize the coordinator:\n${authorizationUrl}\n`);
        return Promise.resolve();
      },
      ...(options.credential === undefined ? {} : { session_credential: options.credential }),
      ...(options.onCredential === undefined
        ? {}
        : { on_session_credential: options.onCredential }),
    });

  const controlStoreFor = (
    projectRoot: string,
    connection: CollaborationConnectionRecord,
  ): GitControlStorePort =>
    deps.seams?.controlStoreFor?.(projectRoot, connection) ??
    createGitControlStoreAdapter({
      remote: connection.canonical_remote,
      mirror_root: join(projectRoot, ".harness", "cache", "coordinator-mirror"),
    });

  function remoteContext(projectRoot: string): CollaborationRemoteContext | undefined {
    const connection = activeClientConnection(projectRoot);
    if (connection === undefined) return undefined;
    const state = collaborationClientState(projectRoot);
    return {
      projectRoot,
      connection,
      port: portFor(connection.coordinator_origin, {
        ...(state.session_credential === undefined ? {} : { credential: state.session_credential }),
      }),
      session: {
        principal_id: connection.actor_principal_id,
        client_instance_id: state.client_instance_id,
      },
      state,
    };
  }

  function persistState(
    context: CollaborationRemoteContext,
    state: CollaborationClientState,
  ): void {
    writeCollaborationClientState(context.projectRoot, state);
  }

  async function acquireLease(
    context: CollaborationRemoteContext,
    operationId: string,
  ): Promise<LeaseOutcome | CollaborationFailedOutcome> {
    const outcome = await context.port.execute(
      {
        kind: "acquire_operation_lease",
        command_id: deps.newId("command"),
        project_id: context.connection.project_id,
        operation_id: operationId,
      },
      context.session,
    );
    if (outcome.status === "failed") return outcome;
    if (outcome.status !== "lease") {
      return {
        status: "failed",
        failure: {
          code: "coordinator_unavailable",
          summary: "coordinator returned an unexpected outcome (expected lease)",
          retryable: true,
        },
      };
    }
    persistState(context, {
      ...context.state,
      leases: {
        ...context.state.leases,
        [operationId]: {
          lease_id: outcome.lease.lease_id,
          fencing_token: outcome.lease.fencing_token,
        },
      },
    });
    return outcome;
  }

  async function renewOrAcquireLease(
    context: CollaborationRemoteContext,
    operationId: string,
  ): Promise<LeaseOutcome | CollaborationFailedOutcome> {
    const cached = context.state.leases[operationId];
    if (cached !== undefined) {
      const renewed = await context.port.execute(
        {
          kind: "renew_operation_lease",
          command_id: deps.newId("command"),
          project_id: context.connection.project_id,
          lease_id: cached.lease_id,
        },
        context.session,
      );
      if (renewed.status === "lease") {
        persistState(context, {
          ...context.state,
          leases: {
            ...context.state.leases,
            [operationId]: {
              lease_id: renewed.lease.lease_id,
              fencing_token: renewed.lease.fencing_token,
            },
          },
        });
        return renewed;
      }
    }
    return acquireLease(context, operationId);
  }

  async function releaseLease(
    context: CollaborationRemoteContext,
    operationId: string,
  ): Promise<void> {
    // Re-read: an acquire earlier in the same process already rewrote the cache.
    const fresh = readCollaborationClientState(context.projectRoot) ?? context.state;
    const cached = fresh.leases[operationId];
    if (cached === undefined) return;
    await context.port.execute(
      {
        kind: "release_operation_lease",
        command_id: deps.newId("command"),
        project_id: context.connection.project_id,
        lease_id: cached.lease_id,
      },
      context.session,
    );
    const leases = { ...fresh.leases };
    delete leases[operationId];
    persistState(context, { ...fresh, leases });
  }

  async function publishCandidate(
    context: CollaborationRemoteContext,
    operationId: string,
    baselineBefore: string,
  ): Promise<CollaborationFailedOutcome | undefined> {
    const head = deps.readBaseline(context.projectRoot);
    if (head === baselineBefore) return undefined;
    const fresh = readCollaborationClientState(context.projectRoot) ?? context.state;
    const cached = fresh.leases[operationId];
    try {
      git(context.projectRoot, [
        "push",
        context.connection.canonical_remote,
        `HEAD:${CANDIDATE_STAGING_PREFIX}/${operationId}`,
      ]);
    } catch {
      return {
        status: "failed",
        failure: {
          code: "git_remote_unavailable",
          summary: "pushing the candidate staging ref to the remote failed",
          retryable: true,
        },
      };
    }
    const outcome = await context.port.execute(
      {
        kind: "publish_operation_candidate",
        command_id: deps.newId("command"),
        project_id: context.connection.project_id,
        operation_id: operationId,
        candidate_commit: head,
        fencing_token: cached?.fencing_token ?? 0,
      },
      context.session,
    );
    return outcome.status === "failed" ? outcome : undefined;
  }

  return {
    remoteContext,
    acquireLease,
    renewOrAcquireLease,
    releaseLease,
    publishCandidate,

    async connect(request: ConnectRequest): Promise<CommandResult> {
      const projectRoot = request.projectRoot;
      const projectId = deps.projectIdFor(projectRoot);
      let remoteUrl: string;
      try {
        remoteUrl = git(projectRoot, ["remote", "get-url", "origin"]);
      } catch {
        return failedOutcome("connect", {
          code: "git_remote_unavailable",
          summary: "no approved origin Git remote found in this project",
          retryable: false,
        });
      }
      let branch: string;
      try {
        branch = git(projectRoot, ["symbolic-ref", "--short", "HEAD"]);
      } catch {
        return failedOutcome("connect", {
          code: "git_remote_unavailable",
          summary: "HEAD is detached; connect requires a checked-out branch",
          retryable: false,
        });
      }
      let canonicalRemote: string;
      try {
        canonicalRemote = normalizeGitRemote(remoteUrl).canonical_remote;
      } catch (error) {
        if (error instanceof RemoteDiscoveryError) {
          return failedOutcome("connect", {
            code: error.code,
            summary: error.message,
            retryable: false,
          });
        }
        throw error;
      }
      const policyDigest =
        readLatestProjectProfile(projectRoot, projectId)?.policy_digest ??
        DEFAULT_PROFILE_POLICY_DIGEST;
      // Minted in memory and only persisted once the connection succeeds; a
      // failed connect leaves no client state behind.
      const state = readCollaborationClientState(projectRoot) ?? mintCollaborationClientState();
      // The connect response (or its deferred OAuth poll) issues the bearer
      // credential this client presents on every later command and query.
      let issuedCredential: string | undefined;
      const port = portFor(request.coordinatorOrigin, {
        onCredential: (credential) => {
          issuedCredential = credential;
        },
      });
      // The CLI cannot know its principal before OAuth; the empty principal
      // asks the transport to bind the authenticated one.
      const outcome = await port.execute(
        {
          kind: "connect",
          command_id: deps.newId("command"),
          project_id: projectId,
          canonical_remote: canonicalRemote,
          target_ref: `refs/heads/${branch}`,
          coordinator_origin: request.coordinatorOrigin,
          policy_digest: policyDigest,
        },
        { principal_id: "", client_instance_id: state.client_instance_id },
      );
      if (outcome.status === "failed") return failedOutcome("connect", outcome.failure);
      if (outcome.status !== "connected") return unexpectedOutcome("connect", "connected");
      writeCollaborationClientState(projectRoot, {
        ...state,
        connection: outcome.connection,
        ...(issuedCredential === undefined ? {} : { session_credential: issuedCredential }),
      });
      return {
        command: "connect",
        status: "ok",
        message: `connected to ${outcome.connection.coordinator_origin} as ${outcome.connection.actor_principal_id}`,
        data: {
          connection_id: outcome.connection.connection_id,
          coordinator_origin: outcome.connection.coordinator_origin,
          canonical_remote: outcome.connection.canonical_remote,
          target_ref: outcome.connection.target_ref,
          actor_principal_id: outcome.connection.actor_principal_id,
          replayed: outcome.replayed,
        },
      };
    },

    async disconnect(request: DisconnectRequest): Promise<CommandResult> {
      const context = remoteContext(request.projectRoot);
      if (context === undefined) return notConnected("disconnect");
      const outcome = await context.port.execute(
        {
          kind: "disconnect",
          command_id: deps.newId("command"),
          project_id: context.connection.project_id,
        },
        context.session,
      );
      if (outcome.status === "failed") return failedOutcome("disconnect", outcome.failure);
      if (outcome.status !== "disconnected") return unexpectedOutcome("disconnect", "disconnected");
      // The connection locator is dropped; the Control Ref history stays
      // authoritative on the remote (design section 19.2).
      writeCollaborationClientState(context.projectRoot, {
        version: 1,
        client_instance_id: context.state.client_instance_id,
        leases: {},
        integrations: {},
      });
      return {
        command: "disconnect",
        status: "ok",
        message: `disconnected from ${outcome.connection.coordinator_origin}`,
        data: {
          connection_id: outcome.connection.connection_id,
          replayed: outcome.replayed,
        },
      };
    },

    async sync(request: SyncRequest): Promise<CommandResult> {
      const context = remoteContext(request.projectRoot);
      if (context === undefined) return notConnected("sync");
      const projectId = context.connection.project_id;
      const synced = await context.port.execute(
        { kind: "sync_now", command_id: deps.newId("command"), project_id: projectId },
        context.session,
      );
      if (synced.status === "failed") return failedOutcome("sync", synced.failure);
      const inbox = await context.port.query(
        { kind: "approval_inbox", project_id: projectId },
        context.session,
      );
      if (inbox.kind !== "approval_inbox") {
        return failedOutcome("sync", {
          code: "coordinator_unavailable",
          summary: "coordinator answered an unexpected view for the approval inbox",
          retryable: true,
        });
      }
      const failures: { readonly request_id: string; readonly kind: string }[] = [];
      let materialized = 0;
      if (inbox.decisions.length > 0) {
        const service = new ApprovalService({
          projectRoot: context.projectRoot,
          readBaseline: () => deps.readBaseline(context.projectRoot),
        });
        const controlStore = controlStoreFor(context.projectRoot, context.connection);
        for (const decision of inbox.decisions) {
          const result = await materializeRemoteApprovalDecision({
            service,
            controlStore,
            project_id: projectId,
            request_id: decision.request_id,
            target_ref: context.connection.target_ref,
          });
          // Per-decision isolation: one bad decision never fails the sync.
          if (result.status === "materialized") materialized += 1;
          if (result.status === "failed") {
            failures.push({ request_id: decision.request_id, kind: result.failure.code });
          }
        }
      }
      return {
        command: "sync",
        status: "ok",
        message: `synced ${projectId}: ${String(inbox.decisions.length)} remote approval decision(s), ${String(materialized)} materialized`,
        data: {
          project_id: projectId,
          inbox_decisions: inbox.decisions.length,
          materialized,
          failures: failures.map((failure) => ({ ...failure })),
        },
      };
    },

    async integrate(request: IntegrateRequest): Promise<CommandResult> {
      const context = remoteContext(request.projectRoot);
      if (context === undefined) return notConnected("integrate");
      const projectId = context.connection.project_id;
      if (request.action === "prepare") {
        const outcome = await context.port.execute(
          {
            kind: "prepare_integration",
            command_id: deps.newId("command"),
            project_id: projectId,
            operation_id: request.targetId,
          },
          context.session,
        );
        if (outcome.status === "failed") return failedOutcome("integrate", outcome.failure);
        if (outcome.status !== "prepared") return unexpectedOutcome("integrate", "prepared");
        persistState(context, {
          ...context.state,
          integrations: {
            ...context.state.integrations,
            [outcome.integration_record.integration_id]: {
              expected_target_commit: outcome.integration_record.expected_target_commit,
            },
          },
        });
        return {
          command: "integrate",
          status: "ok",
          message: `integration ${outcome.integration_record.integration_id} prepared at candidate ${outcome.candidate_commit.slice(0, 12)}; accept with: harness integrate accept ${outcome.integration_record.integration_id}`,
          data: {
            integration_id: outcome.integration_record.integration_id,
            candidate_commit: outcome.candidate_commit,
            replayed: outcome.replayed,
          },
        };
      }
      // accept: the expected target commit binds this accept to the prepared
      // record; the locator cache or the conflicts projection supplies it.
      let expectedTargetCommit =
        context.state.integrations[request.targetId]?.expected_target_commit;
      if (expectedTargetCommit === undefined) {
        const conflicts = await context.port.query(
          { kind: "integration_conflicts", project_id: projectId },
          context.session,
        );
        if (conflicts.kind === "integration_conflicts") {
          expectedTargetCommit = conflicts.conflicts.find(
            (record) => record.integration_id === request.targetId,
          )?.expected_target_commit;
        }
      }
      if (expectedTargetCommit === undefined) {
        return failedOutcome("integrate", {
          code: "integration_not_found",
          summary: `no prepared integration ${request.targetId} known to this client; run harness integrate prepare first`,
          retryable: false,
        });
      }
      const outcome = await context.port.execute(
        {
          kind: "accept_integration",
          command_id: deps.newId("command"),
          project_id: projectId,
          integration_id: request.targetId,
          expected_target_commit: expectedTargetCommit,
        },
        context.session,
      );
      if (outcome.status === "failed") return failedOutcome("integrate", outcome.failure);
      if (outcome.status !== "accepted") return unexpectedOutcome("integrate", "accepted");
      const integrations = { ...context.state.integrations };
      delete integrations[request.targetId];
      persistState(context, { ...context.state, integrations });
      return {
        command: "integrate",
        status: "ok",
        message: `integration ${outcome.integration_record.integration_id} accepted; target now at ${outcome.target_commit.slice(0, 12)}`,
        data: {
          integration_id: outcome.integration_record.integration_id,
          target_commit: outcome.target_commit,
          replayed: outcome.replayed,
        },
      };
    },

    async submitRemoteApproval(request: ApproveRequest): Promise<CommandResult | undefined> {
      const context = remoteContext(request.projectRoot);
      if (context === undefined) return undefined;
      const outcome = await context.port.execute(
        {
          kind: "submit_remote_approval",
          command_id: deps.newId("command"),
          project_id: context.connection.project_id,
          request_id: request.requestId,
          decision: request.decision,
        },
        context.session,
      );
      if (outcome.status === "failed") return failedOutcome("approve", outcome.failure);
      if (outcome.status !== "remote_approval") {
        return unexpectedOutcome("approve", "remote_approval");
      }
      return {
        command: "approve",
        status: "ok",
        message: `approval request ${outcome.decision.request_id} submitted remotely as ${outcome.decision.decision}`,
        data: {
          request_id: outcome.decision.request_id,
          decision: outcome.decision.decision,
          remote_decision_id: outcome.decision.remote_decision_id,
          replayed: outcome.replayed,
        },
      };
    },

    async remoteSummary(request: ProjectRequest): Promise<Record<string, unknown> | undefined> {
      const connection = activeClientConnection(request.projectRoot);
      if (connection === undefined) return undefined;
      const state = collaborationClientState(request.projectRoot);
      const port = portFor(connection.coordinator_origin, {
        ...(state.session_credential === undefined ? {} : { credential: state.session_credential }),
      });
      const session = {
        principal_id: connection.actor_principal_id,
        client_instance_id: state.client_instance_id,
      };
      try {
        const view = await port.query(
          { kind: "connection_status", project_id: connection.project_id },
          session,
        );
        return {
          coordinator_origin: connection.coordinator_origin,
          project_id: connection.project_id,
          connection_status: view.kind === "connection_status" ? view.status : "unknown",
        };
      } catch {
        return {
          coordinator_origin: connection.coordinator_origin,
          project_id: connection.project_id,
          connection_status: "unreachable",
        };
      }
    },

    async coordinator(request: CoordinatorHostRequest): Promise<CommandResult> {
      const hostCoordinator = deps.seams?.hostCoordinator ?? defaultHostCoordinator;
      const server = await hostCoordinator(request);
      const shutdown = (): void => {
        void server.close().then(
          () => {
            process.exitCode = 0;
          },
          () => {
            process.exitCode = 1;
          },
        );
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      return {
        command: "coordinator",
        status: "ok",
        message: `Coordinator listening at ${server.origin}`,
        data: { host: server.host, port: server.port, origin: server.origin },
      };
    },
  };
}

/**
 * Default host composition (plan step 3): host-owned TLS material, the shared
 * OAuth session store and bridge, the platform registry, the Git control
 * store and the SQLite projection behind one Coordinator; startup recovery
 * runs before the server answers.
 */
async function defaultHostCoordinator(
  request: CoordinatorHostRequest,
): Promise<CollaborationCoordinatorServer> {
  const host = request.host ?? "127.0.0.1";
  const origin = `https://${host}:${String(request.port)}`;
  const config = readCoordinatorConfig(request.configPath);
  for (const provider of config.providers) {
    if (
      provider.credential_env !== undefined &&
      process.env[provider.credential_env] === undefined
    ) {
      throw new OrchestrationError(
        "configuration",
        `credential environment variable ${provider.credential_env} is not set on this host`,
      );
    }
  }
  let cert: string;
  let key: string;
  try {
    cert = readFileSync(request.tlsCert, "utf8");
    key = readFileSync(request.tlsKey, "utf8");
  } catch {
    throw new OrchestrationError(
      "configuration",
      "coordinator TLS certificate or key material is not readable",
    );
  }
  const sessions = createOAuthSessionStore();
  const bridge = createCoordinatorOAuthBridge();
  const providerConfigs: PlatformAdapterConfig[] = config.providers.map((provider) => ({
    provider: provider.provider,
    host: provider.host,
    api_base_url: provider.api_base_url,
    authorize_url: provider.authorize_url,
    token_url: provider.token_url,
    client_id: provider.client_id,
    redirect_uri: `${origin}/oauth/${provider.provider}/callback`,
    coordinator_identity: provider.coordinator_identity,
    ...(provider.scope === undefined ? {} : { scope: provider.scope }),
  }));
  const platform = createPlatformIdentityRegistry(providerConfigs, {
    fetch: createNodeHttpsFetch(),
    sessions,
    authorize: (authorizeUrl, providerName) => bridge.authorize(authorizeUrl, providerName),
  });
  const controlStore = createGitControlStoreAdapter({
    remote: config.remote,
    mirror_root: join(config.state_dir, "mirror"),
  });
  const projection = new SqliteCoordinatorProjection(join(config.state_dir, "coordinator.sqlite"));
  const coordinatorDeps = { platform, controlStore, projection };
  const coordinator = createCollaborationCoordinator(coordinatorDeps);
  const startup = await resumeCollaborationCoordinator(coordinatorDeps, config.project_id);
  if (startup.status === "blocked") {
    throw new OrchestrationError(
      "configuration",
      `coordinator startup is blocked: ${startup.failure.summary}`,
    );
  }
  return startCollaborationCoordinatorServer({
    coordinator,
    tls: { cert, key },
    host,
    port: request.port,
    bridge,
    platform,
  });
}
