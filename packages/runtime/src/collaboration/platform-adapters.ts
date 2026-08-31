import { contentDigest } from "@universal-harness-internal/core";
import type {
  CollaborationPermission,
  CollaborationProvider,
} from "@universal-harness-internal/core";

import { collaborationFailure, type CollaborationFailure } from "./errors.js";
import { oauthCodeChallenge, type OAuthSessionStore } from "./oauth-session.js";
import type {
  ControlRefProtectionRequest,
  OAuthRequest,
  PlatformIdentityPort,
  PrincipalSnapshotDraftResult,
  ProtectionResult,
  RemoteIdentityResult,
} from "./port.js";
import {
  DEFAULT_PLATFORM_HOSTS,
  normalizeGitRemote,
  RemoteDiscoveryError,
} from "./remote-discovery.js";

/**
 * GitHub/GitLab/Gitee identity and Control Ref protection Adapters behind one
 * registry (spec §8, §9, §17.3). The host supplies client ids, OAuth/API
 * endpoints and the Coordinator credential identity; project files supply
 * none of them. Provider JSON parsing stays private: only redacted
 * `PrincipalSnapshotFacts` leave `authenticate`, and access tokens live only
 * in process memory inside this registry — they are never written to records,
 * logs or error text. Every unknown role, missing field or unprovable
 * protection rule fails closed.
 */

/** Permission snapshots are usable for at most five minutes (spec §9.2). */
export const PERMISSION_SNAPSHOT_TTL_MS = 5 * 60 * 1000;

/** Deterministic principal identity (spec §9.2): provider + canonical host +
 * platform-stable subject id. Display names, emails and usernames are never
 * stable identity inputs. This is the single derivation site — the platform
 * Adapters must not invent their own. */
export function principalIdFor(
  provider: CollaborationProvider,
  host: string,
  subject_id: string,
): string {
  return `principal_${contentDigest({ provider, host, subject_id }).slice(0, 24)}`;
}

/**
 * In-memory authenticated platform session. The access token exists only
 * here and only until the process exits; the registry never returns it.
 */
export interface AuthenticatedPlatformSession {
  readonly principal_id: string;
  readonly repository_id: string;
  readonly access_token: string;
  readonly token_expires_at?: string;
}

export class PlatformAdapterError extends Error {
  readonly code: CollaborationFailure["code"];

  constructor(code: CollaborationFailure["code"], summary: string) {
    super(summary);
    this.name = "PlatformAdapterError";
    this.code = code;
  }
}

// --- Injected transport ------------------------------------------------------

export interface PlatformHttpRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface PlatformHttpResponse {
  readonly status: number;
  readonly body: string;
}

/** Host-injected HTTPS transport (Task 7 wires `node:https` behind it). */
export type PlatformFetch = (request: PlatformHttpRequest) => Promise<PlatformHttpResponse>;

export interface PlatformAdapterConfig {
  readonly provider: CollaborationProvider;
  /** Canonical lowercase host this Adapter serves. */
  readonly host: string;
  readonly api_base_url: string;
  readonly authorize_url: string;
  readonly token_url: string;
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly scope?: string;
  /**
   * Platform identity of the Coordinator credential: the login (GitHub,
   * Gitee) or numeric user id (GitLab) that alone may write the Control Ref.
   */
  readonly coordinator_identity: string;
}

export interface PlatformIdentityRegistryDependencies {
  readonly fetch: PlatformFetch;
  readonly sessions: OAuthSessionStore;
  /** Drives the user through the authorize URL and resolves with the full
   * callback URL. Owned by the host (CLI/Dashboard); never by project files.
   * The provider name lets shared bridges route the pending authorization. */
  readonly authorize: (authorizeUrl: string, provider?: CollaborationProvider) => Promise<string>;
  readonly now?: () => string;
}

// --- Pure role mappings (explicit, fail-closed; spec §9.1) --------------------

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function permissionRank(permission: CollaborationPermission): number {
  switch (permission) {
    case "read":
      return 1;
    case "write":
      return 2;
    case "maintain":
      return 3;
    case "admin":
      return 4;
  }
}

function permissionDenied(summary: string): PlatformAdapterError {
  return new PlatformAdapterError("permission_denied", summary);
}

/** GitHub repository `permissions` block: admin/maintain/push/triage/pull. */
export function githubPermission(repository: unknown): CollaborationPermission {
  const permissions = asObject(asObject(repository)?.permissions);
  if (permissions === undefined) {
    throw permissionDenied("github repository response carries no permissions block");
  }
  const flags: readonly (readonly [string, CollaborationPermission])[] = [
    ["admin", "admin"],
    ["maintain", "maintain"],
    ["push", "write"],
    ["triage", "read"],
    ["pull", "read"],
  ];
  for (const [flag, permission] of flags) {
    const value = permissions[flag];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      throw permissionDenied(`github permission flag ${flag} is not a boolean`);
    }
    if (value) return permission;
  }
  throw permissionDenied("github reported no usable repository permission");
}

const GITLAB_ACCESS_LEVELS: Readonly<Record<number, CollaborationPermission>> = {
  10: "read", // guest
  20: "read", // reporter
  30: "write", // developer
  40: "maintain",
  50: "admin", // owner
};

/** GitLab `permissions` block: project_access/group_access access levels. */
export function gitlabPermission(project: unknown): CollaborationPermission {
  const permissions = asObject(asObject(project)?.permissions);
  if (permissions === undefined) {
    throw permissionDenied("gitlab project response carries no permissions block");
  }
  const accesses = [permissions.project_access, permissions.group_access]
    .map(asObject)
    .filter((access) => access !== undefined);
  if (accesses.length === 0) {
    throw permissionDenied("gitlab reported neither project nor group access");
  }
  let best: CollaborationPermission | undefined;
  for (const access of accesses) {
    const level = access.access_level;
    const permission = typeof level === "number" ? GITLAB_ACCESS_LEVELS[level] : undefined;
    if (permission === undefined) {
      throw permissionDenied(`gitlab access level ${String(level)} is unknown`);
    }
    if (best === undefined || permissionRank(permission) > permissionRank(best)) {
      best = permission;
    }
  }
  if (best === undefined) {
    throw permissionDenied("gitlab reported no usable access level");
  }
  return best;
}

/** Gitee repository `permission` field: admin/write/read. Real API v5
 * responses instead report an object of booleans
 * (`{pull, push, admin}`); accept both shapes, mapping to the strongest
 * proven capability. Anything else fails closed. */
export function giteePermission(repository: unknown): CollaborationPermission {
  const permission = asObject(repository)?.permission;
  if (permission === "admin" || permission === "write" || permission === "read") {
    return permission;
  }
  const flags = asObject(permission);
  if (flags !== undefined) {
    if (flags.admin === true) return "admin";
    if (flags.push === true) return "write";
    if (flags.pull === true) return "read";
  }
  throw permissionDenied(`gitee repository permission ${String(permission)} is unknown`);
}

// --- Registry -----------------------------------------------------------------

interface ApiGetOutcome {
  readonly ok: boolean;
  readonly httpStatus?: number | undefined;
  readonly json?: JsonObject | undefined;
  readonly raw?: string | undefined;
}

function encodePathSegments(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function controlRefBranch(controlRef: string): string | undefined {
  const prefix = "refs/heads/";
  return controlRef.startsWith(prefix) ? controlRef.slice(prefix.length) : undefined;
}

export function createPlatformIdentityRegistry(
  configs: readonly PlatformAdapterConfig[],
  deps: PlatformIdentityRegistryDependencies,
): PlatformIdentityPort {
  const now = deps.now ?? (() => new Date().toISOString());
  const byHost = new Map<string, PlatformAdapterConfig>();
  const knownHosts: Record<string, CollaborationProvider> = { ...DEFAULT_PLATFORM_HOSTS };
  for (const config of configs) {
    const host = config.host.toLowerCase();
    if (byHost.has(host)) {
      throw new PlatformAdapterError(
        "unsupported_remote",
        `duplicate platform adapter configuration for host ${host}`,
      );
    }
    byHost.set(host, { ...config, host });
    knownHosts[host] = config.provider;
  }
  // Access tokens, keyed by provider/host/repository; process memory only.
  const sessions = new Map<string, AuthenticatedPlatformSession>();

  const remoteDiscoveryFailed = (failure: CollaborationFailure): RemoteIdentityResult => ({
    status: "failed",
    failure,
  });
  const authenticationFailed = (failure: CollaborationFailure): PrincipalSnapshotDraftResult => ({
    status: "failed",
    failure,
  });

  /** Exact per-repository session lookup: a token minted for repository A is
   * never used to inspect repository B, even on the same host. */
  function tokenFor(config: PlatformAdapterConfig, repositoryId: string): string | undefined {
    const key = `${config.provider}@${config.host}:${repositoryId}`;
    const session = sessions.get(key);
    if (session === undefined) return undefined;
    if (session.token_expires_at !== undefined && session.token_expires_at <= now()) {
      sessions.delete(key);
      return undefined;
    }
    return session.access_token;
  }

  async function discover(remote: string): Promise<RemoteIdentityResult> {
    try {
      const normalized = normalizeGitRemote(remote, knownHosts);
      const config = byHost.get(normalized.host);
      if (config === undefined) {
        return remoteDiscoveryFailed(
          collaborationFailure(
            "unsupported_remote",
            `no platform adapter is configured for host ${normalized.host}`,
          ),
        );
      }
      return {
        status: "resolved",
        identity: {
          provider: config.provider,
          host: config.host,
          repository_id: normalized.repository_path,
          canonical_remote: normalized.canonical_remote,
          canonical_remote_digest: contentDigest(normalized.canonical_remote),
        },
      };
    } catch (error) {
      if (error instanceof RemoteDiscoveryError) {
        return remoteDiscoveryFailed(collaborationFailure("unsupported_remote", error.message));
      }
      throw error;
    }
  }

  function parseCallback(
    rawCallback: string,
    config: PlatformAdapterConfig,
  ):
    { readonly code: string; readonly state: string } | { readonly failure: CollaborationFailure } {
    const authenticationFailed = (summary: string) => ({
      failure: collaborationFailure("authentication_required", summary),
    });
    let callback: URL;
    let expected: URL;
    try {
      callback = new URL(rawCallback);
      expected = new URL(config.redirect_uri);
    } catch {
      return authenticationFailed("oauth callback is not a URL");
    }
    if (callback.origin !== expected.origin || callback.pathname !== expected.pathname) {
      return authenticationFailed("oauth callback origin or path does not match the redirect uri");
    }
    if (callback.searchParams.get("error") !== null) {
      return authenticationFailed("oauth callback carries an authorization error");
    }
    const code = callback.searchParams.get("code");
    const state = callback.searchParams.get("state");
    if (code === null || code === "" || state === null || state === "") {
      return authenticationFailed("oauth callback is missing code or state");
    }
    return { code, state };
  }

  async function exchangeCode(
    config: PlatformAdapterConfig,
    code: string,
    codeVerifier: string,
  ): Promise<{ readonly access_token: string; readonly token_expires_at?: string } | undefined> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirect_uri,
      client_id: config.client_id,
      code_verifier: codeVerifier,
    }).toString();
    let response: PlatformHttpResponse;
    try {
      response = await deps.fetch({
        method: "POST",
        url: config.token_url,
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      });
    } catch {
      return undefined;
    }
    if (response.status < 200 || response.status >= 300) return undefined;
    let json: JsonObject | undefined;
    try {
      json = asObject(JSON.parse(response.body));
    } catch {
      return undefined;
    }
    const token = json?.access_token;
    if (typeof token !== "string" || token === "") return undefined;
    const expiresIn = json?.expires_in;
    if (typeof expiresIn !== "number") return { access_token: token };
    return {
      access_token: token,
      token_expires_at: new Date(Date.parse(now()) + expiresIn * 1000).toISOString(),
    };
  }

  function subjectIdOf(user: JsonObject | undefined): string | undefined {
    const id = user?.id;
    return typeof id === "number" && Number.isInteger(id) ? String(id) : undefined;
  }

  function permissionRequestPath(config: PlatformAdapterConfig, repositoryId: string): string {
    switch (config.provider) {
      case "github":
        return `/repos/${encodePathSegments(repositoryId)}`;
      case "gitlab":
        return `/projects/${encodeURIComponent(repositoryId)}`;
      case "gitee":
        return `/repos/${encodePathSegments(repositoryId)}`;
    }
  }

  function permissionOf(
    config: PlatformAdapterConfig,
    repository: unknown,
  ): CollaborationPermission {
    switch (config.provider) {
      case "github":
        return githubPermission(repository);
      case "gitlab":
        return gitlabPermission(repository);
      case "gitee":
        return giteePermission(repository);
    }
  }

  /** Shared tail of `authenticate`: with a bearer token in hand, re-pull the
   * user and repository permission facts and build a fresh snapshot. */
  async function snapshotWithToken(
    config: PlatformAdapterConfig,
    input: OAuthRequest,
    accessToken: string,
  ): Promise<PrincipalSnapshotDraftResult> {
    const user = await apiGetWithToken(config, accessToken, "/user");
    const subjectId = subjectIdOf(user.json);
    if (!user.ok || subjectId === undefined) {
      return authenticationFailed(
        collaborationFailure(
          "authentication_required",
          `${config.provider} did not report a stable subject id`,
        ),
      );
    }

    const repository = await apiGetWithToken(
      config,
      accessToken,
      permissionRequestPath(config, input.repository_id),
    );
    let permission: CollaborationPermission;
    try {
      if (!repository.ok) {
        throw permissionDenied(
          `${config.provider} repository permission request failed (status ${repository.httpStatus ?? "unknown"})`,
        );
      }
      permission = permissionOf(config, repository.json);
    } catch (error) {
      if (error instanceof PlatformAdapterError) {
        return authenticationFailed(collaborationFailure(error.code, error.message));
      }
      throw error;
    }

    const observedAt = now();
    return {
      status: "authenticated",
      snapshot: {
        principal_id: principalIdFor(config.provider, config.host, subjectId),
        provider: config.provider,
        host: config.host,
        subject_id: subjectId,
        repository_id: input.repository_id,
        permission,
        observed_at: observedAt,
        expires_at: new Date(Date.parse(observedAt) + PERMISSION_SNAPSHOT_TTL_MS).toISOString(),
        source_response_digest: contentDigest({
          user: user.raw ?? "",
          repository: repository.raw ?? "",
        }),
      },
    };
  }

  async function authenticate(input: OAuthRequest): Promise<PrincipalSnapshotDraftResult> {
    const config = byHost.get(input.host);
    if (config === undefined || config.provider !== input.provider) {
      return authenticationFailed(
        collaborationFailure(
          "unsupported_remote",
          `no adapter for ${input.provider}@${input.host}`,
        ),
      );
    }

    // Token-reuse short-circuit (design section 17.1: the CLI and the
    // Dashboard share one OAuth session). A live token skips the browser
    // dance and the code exchange; the user and permission facts are still
    // re-pulled so every snapshot is freshly observed.
    const liveToken = tokenFor(config, input.repository_id);
    if (liveToken !== undefined) {
      return snapshotWithToken(config, input, liveToken);
    }

    const oauthSession = deps.sessions.begin(config.redirect_uri);
    const authorizeUrl = new URL(config.authorize_url);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", config.client_id);
    authorizeUrl.searchParams.set("redirect_uri", config.redirect_uri);
    authorizeUrl.searchParams.set("state", oauthSession.state);
    authorizeUrl.searchParams.set("code_challenge", oauthCodeChallenge(oauthSession.code_verifier));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    if (config.scope !== undefined) authorizeUrl.searchParams.set("scope", config.scope);

    let rawCallback: string;
    try {
      rawCallback = await deps.authorize(authorizeUrl.toString(), config.provider);
    } catch {
      return authenticationFailed(
        collaborationFailure("authentication_required", "oauth authorization did not complete"),
      );
    }
    const callback = parseCallback(rawCallback, config);
    if ("failure" in callback) {
      return authenticationFailed(callback.failure);
    }
    const consumed = deps.sessions.consume(callback.state, config.redirect_uri);
    if (consumed.status === "failed") {
      return authenticationFailed(consumed.failure);
    }

    const token = await exchangeCode(config, callback.code, consumed.session.code_verifier);
    if (token === undefined) {
      return authenticationFailed(
        collaborationFailure("authentication_required", "oauth code exchange failed"),
      );
    }

    const drafted = await snapshotWithToken(config, input, token.access_token);
    if (drafted.status === "authenticated") {
      const authenticated: AuthenticatedPlatformSession =
        token.token_expires_at === undefined
          ? {
              principal_id: drafted.snapshot.principal_id,
              repository_id: input.repository_id,
              access_token: token.access_token,
            }
          : {
              principal_id: drafted.snapshot.principal_id,
              repository_id: input.repository_id,
              access_token: token.access_token,
              token_expires_at: token.token_expires_at,
            };
      sessions.set(`${config.provider}@${config.host}:${input.repository_id}`, authenticated);
    }
    return drafted;
  }

  async function apiGetWithToken(
    config: PlatformAdapterConfig,
    token: string,
    path: string,
  ): Promise<ApiGetOutcome> {
    let response: PlatformHttpResponse;
    try {
      response = await deps.fetch({
        method: "GET",
        url: `${config.api_base_url}${path}`,
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
    } catch {
      return { ok: false };
    }
    let json: JsonObject | undefined;
    try {
      json = asObject(JSON.parse(response.body));
    } catch {
      json = undefined;
    }
    return {
      ok: response.status >= 200 && response.status < 300,
      httpStatus: response.status,
      json,
      raw: response.body,
    };
  }

  function unprotected(summary: string): ProtectionResult {
    return {
      status: "unprotected",
      failure: collaborationFailure("control_ref_unprotected", summary),
    };
  }

  /** GitHub flags shared by both proof forms: admins enforced, force-push
   * and deletion disabled. */
  function githubProtectionFlagsReason(protection: JsonObject): string {
    const enforceAdmins = asObject(protection.enforce_admins);
    if (enforceAdmins?.enabled !== true) return "admins can bypass the protection rules";
    const allowForcePushes = asObject(protection.allow_force_pushes);
    if (allowForcePushes?.enabled !== false) return "force push is not proven disabled";
    const allowDeletions = asObject(protection.allow_deletions);
    if (allowDeletions?.enabled !== false) return "branch deletion is not proven disabled";
    return "";
  }

  /** GitHub organization proof: push restrictions limited to the
   * Coordinator identity. */
  function githubRestrictionsReason(restrictions: JsonObject, coordinator: string): string {
    const users = Array.isArray(restrictions.users) ? restrictions.users : [];
    const logins = users.map((user) => asObject(user)?.login);
    if (logins.length !== 1 || logins[0] !== coordinator) {
      return "push restrictions are not exclusive to the coordinator identity";
    }
    const teams = Array.isArray(restrictions.teams) ? restrictions.teams : [];
    const apps = Array.isArray(restrictions.apps) ? restrictions.apps : [];
    if (teams.length !== 0 || apps.length !== 0) {
      return "push restrictions include teams or apps beyond the coordinator identity";
    }
    return "";
  }

  /** A write-capable deploy key bypasses both the organization restrictions
   * proof and the personal-repository ownership proof, so every deploy key
   * must be provably read-only. Anything unprovable fails closed. */
  async function githubWriteDeployKeyReason(
    config: PlatformAdapterConfig,
    token: string,
    repository: string,
  ): Promise<string> {
    const outcome = await apiGetWithToken(config, token, `/repos/${repository}/keys?per_page=100`);
    let keys: unknown;
    try {
      keys = JSON.parse(outcome.raw ?? "");
    } catch {
      keys = undefined;
    }
    if (!outcome.ok || !Array.isArray(keys) || keys.length >= 100) {
      return "deploy keys are not provably read-only";
    }
    const writable = keys.filter((key) => asObject(key)?.read_only !== true);
    if (writable.length > 0) {
      return "a deploy key that is not read-only bypasses the control ref protection";
    }
    return "";
  }

  /** GitHub personal-repository proof. Personal repositories cannot carry
   * push restrictions at all (the API rejects them as organization-only), so
   * the equivalent proof of "only the Coordinator can write" is ownership:
   * the repository owner is the Coordinator identity and the collaborator
   * list names nobody else. Anything unprovable fails closed. */
  async function githubPersonalRepositoryReason(
    config: PlatformAdapterConfig,
    token: string,
    repository: string,
    coordinator: string,
  ): Promise<string> {
    const repoOutcome = await apiGetWithToken(config, token, `/repos/${repository}`);
    const owner = asObject(repoOutcome.json?.owner)?.login;
    if (!repoOutcome.ok || owner !== coordinator) {
      return "repository owner is not provably the coordinator identity";
    }
    const collabOutcome = await apiGetWithToken(
      config,
      token,
      `/repos/${repository}/collaborators?per_page=100`,
    );
    let collaborators: unknown;
    try {
      collaborators = JSON.parse(collabOutcome.raw ?? "");
    } catch {
      collaborators = undefined;
    }
    if (!collabOutcome.ok || !Array.isArray(collaborators)) {
      return "collaborator list is not provable";
    }
    // per_page caps the page at 100 entries; a full page may hide further
    // collaborators, so fail closed instead of trusting a truncated list.
    if (collaborators.length >= 100) {
      return "collaborator list is not provable";
    }
    const others = collaborators.filter((entry) => asObject(entry)?.login !== coordinator);
    if (others.length > 0) {
      return "collaborators beyond the coordinator identity may push";
    }
    return "";
  }

  /** GitLab proof: exactly one user-bound push access level naming the
   * Coordinator identity, force push disabled. Role-based levels name a
   * class of writers, never a single identity, so they fail closed. */
  function gitlabProtectionReason(protection: JsonObject | undefined, coordinator: string): string {
    if (protection === undefined) return "no protected branch payload";
    if (protection.allow_force_push !== false) return "force push is not proven disabled";
    const levels = Array.isArray(protection.push_access_levels)
      ? protection.push_access_levels.map(asObject)
      : [];
    if (levels.length !== 1 || levels[0] === undefined) {
      return "push access is not a single exclusive rule";
    }
    const level = levels[0];
    if (level.user_id === null || level.user_id === undefined) {
      return "push access is role-based, not bound to the coordinator identity";
    }
    if (String(level.user_id) !== coordinator) {
      return "push access is bound to a different identity than the coordinator";
    }
    if (level.group_id !== null && level.group_id !== undefined) {
      return "push access includes a group beyond the coordinator identity";
    }
    return "";
  }

  /** Gitee proof: the branch reports `protected` (the platform blocks force
   * push and deletion on protected branches) and the protection rule's
   * `pusher` names exactly the Coordinator identity. A role keyword such as
   * "administrators" names a class of writers and fails closed. */
  function giteeProtectionReason(
    branch: JsonObject | undefined,
    protection: JsonObject | undefined,
    coordinator: string,
  ): string {
    if (branch?.protected !== true) return "branch is not reported protected";
    if (protection === undefined) return "no protection rule payload";
    if (protection.pusher !== coordinator) {
      return "protection pusher is not exclusively the coordinator identity";
    }
    return "";
  }

  async function inspectControlRefProtection(
    input: ControlRefProtectionRequest,
  ): Promise<ProtectionResult> {
    const config = byHost.get(input.host);
    if (config === undefined || config.provider !== input.provider) {
      return unprotected(`no adapter for ${input.provider}@${input.host}`);
    }
    const token = tokenFor(config, input.repository_id);
    if (token === undefined) {
      return {
        status: "unprotected",
        failure: collaborationFailure(
          "authentication_required",
          "control ref protection inspection requires an authenticated session",
        ),
      };
    }
    const branch = controlRefBranch(input.control_ref);
    if (branch === undefined) {
      return unprotected("control ref is not a branch ref");
    }
    const repository = encodePathSegments(input.repository_id);

    switch (config.provider) {
      case "github": {
        const outcome = await apiGetWithToken(
          config,
          token,
          `/repos/${repository}/branches/${encodeURIComponent(branch)}/protection`,
        );
        if (!outcome.ok) {
          return unprotected(
            `github returned no usable protection rule (status ${outcome.httpStatus ?? "unknown"})`,
          );
        }
        // Two proof forms: organization repositories carry exclusive push
        // restrictions; personal repositories cannot (the API rejects them),
        // so they prove ownership instead -- owner is the Coordinator and no
        // other collaborator exists. Both forms first require the shared
        // protection flags and provably read-only deploy keys.
        if (outcome.json === undefined) return unprotected("no branch protection payload");
        const flagsReason = githubProtectionFlagsReason(outcome.json);
        if (flagsReason !== "") return unprotected(flagsReason);
        const deployKeyReason = await githubWriteDeployKeyReason(config, token, repository);
        if (deployKeyReason !== "") return unprotected(deployKeyReason);
        const restrictions = asObject(outcome.json.restrictions);
        if (restrictions !== undefined) {
          const restrictionsReason = githubRestrictionsReason(
            restrictions,
            config.coordinator_identity,
          );
          return restrictionsReason === ""
            ? { status: "protected" }
            : unprotected(restrictionsReason);
        }
        const personalReason = await githubPersonalRepositoryReason(
          config,
          token,
          repository,
          config.coordinator_identity,
        );
        return personalReason === "" ? { status: "protected" } : unprotected(personalReason);
      }
      case "gitlab": {
        const outcome = await apiGetWithToken(
          config,
          token,
          `/projects/${encodeURIComponent(input.repository_id)}/protected_branches/${encodeURIComponent(branch)}`,
        );
        if (!outcome.ok) {
          return unprotected(
            `gitlab returned no usable protected branch rule (status ${outcome.httpStatus ?? "unknown"})`,
          );
        }
        const reason = gitlabProtectionReason(outcome.json, config.coordinator_identity);
        return reason === "" ? { status: "protected" } : unprotected(reason);
      }
      case "gitee": {
        const branchOutcome = await apiGetWithToken(
          config,
          token,
          `/repos/${repository}/branches/${encodeURIComponent(branch)}`,
        );
        const protectionOutcome = branchOutcome.ok
          ? await apiGetWithToken(
              config,
              token,
              `/repos/${repository}/branches/${encodeURIComponent(branch)}/protection`,
            )
          : { ok: false as const };
        if (!branchOutcome.ok || !protectionOutcome.ok) {
          return unprotected("gitee returned no usable branch protection surface");
        }
        const reason = giteeProtectionReason(
          branchOutcome.json,
          protectionOutcome.json,
          config.coordinator_identity,
        );
        return reason === "" ? { status: "protected" } : unprotected(reason);
      }
    }
  }

  return { discover, authenticate, inspectControlRefProtection };
}
