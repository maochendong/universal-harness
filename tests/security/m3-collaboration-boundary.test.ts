import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGitControlStoreAdapter } from "../../adapters/vcs-git/src/index.js";
import type {
  CollaborationConnectionRecord,
  ControlRecord,
  IntegrationRecord,
} from "../../packages/core/src/index.js";
import {
  buildApprovalRequest,
  createCollaborationCoordinator,
  createOAuthSessionStore,
  createPlatformIdentityRegistry,
  normalizeGitRemote,
  principalIdFor,
  RemoteDiscoveryError,
  type CollaborationQuery,
  type CollaborationRecord as ProjectionRecord,
  type CollaborationSession,
  type CollaborationView,
  type ControlSnapshotResult,
  type GitControlStorePort,
  type PlatformAdapterConfig,
  type PlatformFetch,
  type PlatformHttpRequest,
  type PlatformIdentityPort,
} from "../../packages/runtime/src/index.js";

/**
 * M3 collaboration security boundary (plan M3 Task 9 step 3): OAuth
 * state/PKCE and callback-origin checks, credential-bearing Remote rejection
 * without leaking the credential, shell-metacharacter confinement on the Git
 * path, token redaction across every persisted record and failure surface,
 * self-approval prohibition and fail-closed unprotected Control Refs.
 */

const NOW = "2026-08-29T00:00:00.000Z";
const LATER = "2026-08-29T00:05:00.000Z";
const EARLIER = "2026-08-28T23:55:00.000Z";
const REDIRECT = "https://harness.example.com/oauth/callback";
const PROJECT_ID = "project_demo";
const TARGET_REF = "refs/heads/main";
const TOKEN = "m3-boundary-secret-token-1a2b3c4d";

const digest = (letter: string): string => letter.repeat(64);

const alice: CollaborationSession = {
  principal_id: "principal_alice",
  client_instance_id: "instance_security",
};

/** The production registry derives the principal from the platform subject,
 * so coordinator sessions behind the real registry must use the derived id. */
const aliceRegistry: CollaborationSession = {
  principal_id: principalIdFor("github", "github.com", "1234567"),
  client_instance_id: "instance_security",
};

const GITHUB_CONFIG: PlatformAdapterConfig = {
  provider: "github",
  host: "github.com",
  api_base_url: "https://api.github.com",
  authorize_url: "https://github.com/login/oauth/authorize",
  token_url: "https://github.com/login/oauth/access_token",
  client_id: "client_github",
  redirect_uri: REDIRECT,
  coordinator_identity: "harness-coordinator",
};

const PROTECTED_PAYLOAD = {
  enforce_admins: { enabled: true },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
  restrictions: { users: [{ login: "harness-coordinator" }], teams: [], apps: [] },
};

const created: string[] = [];

function makeTempDir(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  created.push(directory);
  return directory;
}

afterEach(() => {
  while (created.length > 0) {
    const directory = created.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "gc.auto=0", ...args], {
    cwd,
    encoding: "utf8",
  });
}

// --- Minimal coordinator-side fakes (record-capturing) ------------------------

interface FakeControlStore {
  readonly port: GitControlStorePort;
  readonly controlRecords: ControlRecord[];
  readonly projectRecords: (CollaborationConnectionRecord | IntegrationRecord)[];
  connection?: CollaborationConnectionRecord;
}

function createFakeControlStore(): FakeControlStore {
  const controlRecords: ControlRecord[] = [];
  const projectRecords: (CollaborationConnectionRecord | IntegrationRecord)[] = [];
  const headOid = () =>
    controlRecords.length === 0 ? undefined : `oid_control_${String(controlRecords.length)}`;
  const store: FakeControlStore = {
    controlRecords,
    projectRecords,
    port: {
      readControl() {
        const head = headOid();
        const result: ControlSnapshotResult = {
          status: "ok",
          snapshot: {
            ...(head === undefined ? {} : { control_head_oid: head }),
            control_records: [...controlRecords],
            ...(store.connection === undefined ? {} : { latest_connection: store.connection }),
            target_head_oid: "0".repeat(40),
          },
        };
        return Promise.resolve(result);
      },
      appendControl(input) {
        if (input.expected_head_oid !== headOid()) {
          return Promise.resolve({
            status: "failed" as const,
            failure: {
              code: "control_ref_cas_failed" as const,
              summary: "stale expected head",
              retryable: true,
            },
          });
        }
        controlRecords.push(input.record);
        return Promise.resolve({ status: "appended" as const, head_oid: headOid() as string });
      },
      appendProjectRecord(input) {
        projectRecords.push(input.record);
        if (input.record.record_kind === "collaboration_connection") {
          store.connection = input.record;
        }
        return Promise.resolve({ status: "committed" as const, commit: "0".repeat(40) });
      },
      listOperationHeads: () => Promise.resolve({ status: "ok" as const, heads: [] }),
      compareAndSwapOperation: () =>
        Promise.reject(new Error("not used in the security boundary tests")),
      prepareCandidate: () => Promise.reject(new Error("not used in the security boundary tests")),
      readCandidate: () => Promise.resolve({ status: "missing" as const }),
      readIntegrationRecord: () => Promise.resolve({ status: "missing" as const }),
      listIntegrationRecords: () =>
        Promise.resolve({ status: "ok" as const, staged: [], accepted: [] }),
      compareAndSwapTarget: () =>
        Promise.reject(new Error("not used in the security boundary tests")),
    },
  };
  return store;
}

function createFakeProjection(): {
  readonly applied: ProjectionRecord[];
  readonly port: {
    rebuild: () => Promise<void>;
    apply: (record: ProjectionRecord) => Promise<void>;
    query: (query: CollaborationQuery) => Promise<CollaborationView>;
  };
} {
  const applied: ProjectionRecord[] = [];
  return {
    applied,
    port: {
      rebuild: () => Promise.resolve(),
      apply: (record) => {
        applied.push(record);
        return Promise.resolve();
      },
      query: (query) =>
        Promise.resolve({
          kind: query.kind,
          project_id: query.project_id,
          ...(query.kind === "connection_status" ? { status: "active" as const } : {}),
          ...(query.kind === "operations" ? { operations: [] } : {}),
          ...(query.kind === "approval_inbox" ? { decisions: [] } : {}),
          ...(query.kind === "integration_conflicts" ? { conflicts: [] } : {}),
        }) as Promise<CollaborationView>,
    },
  };
}

interface RegistryHarness {
  readonly registry: PlatformIdentityPort;
  readonly requests: PlatformHttpRequest[];
  readonly authorizeUrls: string[];
}

/** The production GitHub Adapter behind a scripted HTTPS transport. */
function createRegistryHarness(options: {
  readonly authorize?: (url: string) => Promise<string>;
  readonly repository?: unknown;
  readonly protection?: unknown;
  readonly protectionStatus?: number;
}): RegistryHarness {
  const requests: PlatformHttpRequest[] = [];
  const authorizeUrls: string[] = [];
  const routes: Record<string, { status?: number; body?: unknown }> = {
    "POST https://github.com/login/oauth/access_token": {
      body: { access_token: TOKEN, expires_in: 3600 },
    },
    "GET https://api.github.com/user": { body: { id: 1234567 } },
    "GET https://api.github.com/repos/acme/demo": {
      body: options.repository ?? {
        permissions: { admin: true, maintain: false, push: false, triage: false, pull: false },
      },
    },
    // Both GitHub protection proof forms require provably read-only deploy keys.
    "GET https://api.github.com/repos/acme/demo/keys?per_page=100": { body: [] },
    "GET https://api.github.com/repos/acme/demo/branches/harness%2Fcontrol/protection": {
      ...(options.protectionStatus === undefined ? {} : { status: options.protectionStatus }),
      body: options.protection ?? PROTECTED_PAYLOAD,
    },
  };
  const fetch: PlatformFetch = (request) => {
    requests.push(request);
    const route = routes[`${request.method} ${request.url}`];
    if (route === undefined) throw new Error(`unexpected request ${request.method} ${request.url}`);
    return Promise.resolve({
      status: route.status ?? 200,
      body: route.body === undefined ? "" : JSON.stringify(route.body),
    });
  };
  const registry = createPlatformIdentityRegistry([GITHUB_CONFIG], {
    fetch,
    sessions: createOAuthSessionStore({ now: () => NOW }),
    authorize:
      options.authorize ??
      ((url) => {
        authorizeUrls.push(url);
        const state = new URL(url).searchParams.get("state") ?? "";
        return Promise.resolve(`${REDIRECT}?code=code_1&state=${state}`);
      }),
    now: () => NOW,
  });
  return { registry, requests, authorizeUrls };
}

const OAUTH_INPUT = {
  provider: "github" as const,
  host: "github.com",
  repository_id: "acme/demo",
  principal_id: "principal_alice",
};

const CONNECT_COMMAND = {
  kind: "connect" as const,
  command_id: "command_connect_sec",
  project_id: PROJECT_ID,
  canonical_remote: "https://github.com/acme/demo",
  target_ref: TARGET_REF,
  coordinator_origin: "https://harness.example.com",
  policy_digest: digest("c"),
};

describe("oauth state, PKCE and callback origin", () => {
  it("binds the exchange to a single-use state and an S256 PKCE verifier", async () => {
    const harness = createRegistryHarness({});
    const outcome = await harness.registry.authenticate(OAUTH_INPUT);
    expect(outcome.status).toBe("authenticated");

    expect(harness.authorizeUrls).toHaveLength(1);
    const authorizeUrl = new URL(harness.authorizeUrls[0] as string);
    const challenge = authorizeUrl.searchParams.get("code_challenge");
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]+$/u);

    const exchange = harness.requests.find((request) => request.url === GITHUB_CONFIG.token_url);
    expect(exchange).toBeDefined();
    const body = new URLSearchParams(exchange?.body ?? "");
    const verifier = body.get("code_verifier");
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/u);
    // The verifier never appears in the authorize request; only its digest does.
    expect(harness.authorizeUrls[0]).not.toContain(verifier as string);
    expect(challenge).not.toBe(verifier);
  });

  it("rejects a callback whose state does not match the pending session", async () => {
    const harness = createRegistryHarness({
      authorize: (url) => {
        void url;
        return Promise.resolve(`${REDIRECT}?code=code_1&state=forged-state`);
      },
    });
    const outcome = await harness.registry.authenticate(OAUTH_INPUT);
    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "authentication_required" },
    });
    // No token was exchanged: the forged state dies before the token endpoint.
    expect(harness.requests.some((request) => request.url === GITHUB_CONFIG.token_url)).toBe(false);
  });

  it("rejects a callback from a foreign origin", async () => {
    const harness = createRegistryHarness({
      authorize: (url) => {
        const state = new URL(url).searchParams.get("state") ?? "";
        return Promise.resolve(
          `https://evil.example.com/oauth/callback?code=code_1&state=${state}`,
        );
      },
    });
    const outcome = await harness.registry.authenticate(OAUTH_INPUT);
    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "authentication_required" },
    });
    expect(harness.requests.some((request) => request.url === GITHUB_CONFIG.token_url)).toBe(false);
  });
});

describe("credential-bearing remotes", () => {
  it("rejects HTTPS remotes with userinfo before any I/O, without echoing the credential", () => {
    const credentialed = "https://ci-user:ghp_supersecret@github.com/acme/demo.git";
    let error: unknown;
    try {
      normalizeGitRemote(credentialed);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RemoteDiscoveryError);
    expect((error as RemoteDiscoveryError).code).toBe("remote_contains_credentials");
    // The credential itself never enters the error text (a log surface).
    expect(String((error as Error).message)).not.toContain("ghp_supersecret");
    expect(String((error as Error).message)).not.toContain("ci-user");
  });

  it("fails connect closed on a credential-bearing remote and appends nothing", async () => {
    const harness = createRegistryHarness({});
    const controlStore = createFakeControlStore();
    const projection = createFakeProjection();
    const coordinator = createCollaborationCoordinator({
      platform: harness.registry,
      controlStore: controlStore.port,
      projection: projection.port,
      now: () => NOW,
    });
    const outcome = await coordinator.execute(
      {
        ...CONNECT_COMMAND,
        canonical_remote: "https://ci-user:ghp_supersecret@github.com/acme/demo.git",
      },
      alice,
    );
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(JSON.stringify(outcome.failure)).not.toContain("ghp_supersecret");
    expect(controlStore.controlRecords).toHaveLength(0);
    expect(controlStore.projectRecords).toHaveLength(0);
    expect(projection.applied).toHaveLength(0);
  });
});

describe("git path command-injection confinement", () => {
  it("passes shell metacharacters in ref arguments literally to git, never to a shell", async () => {
    const marker = join(makeTempDir("harness-m3-injection-"), "pwned.txt");
    const remote = makeTempDir("harness-m3-injection-remote-");
    git(remote, "init", "--bare", "-b", "main");
    const seed = makeTempDir("harness-m3-injection-seed-");
    git(seed, "init", "-b", "main");
    git(seed, "config", "user.name", "Harness Test");
    git(seed, "config", "user.email", "harness-test@example.invalid");
    writeFileSync(join(seed, "README.md"), "initial\n");
    git(seed, "add", "README.md");
    git(seed, "commit", "-m", "initial");
    git(seed, "remote", "add", "origin", remote);
    git(seed, "push", "origin", "main");

    const adapter = createGitControlStoreAdapter({
      remote,
      mirror_root: join(makeTempDir("harness-m3-injection-mirror-"), "mirror"),
    });
    const payload = `op_1$(touch ${marker});\`touch ${marker}\``;
    const outcome = await adapter.compareAndSwapOperation({
      project_id: PROJECT_ID,
      operation_id: payload,
      candidate_commit: "0".repeat(40),
      fencing_token: 1,
    });
    // The payload reached git as one literal argument and failed as a typed
    // outcome; no shell ever interpreted it.
    expect(outcome.status).toBe("failed");
    expect(existsSync(marker)).toBe(false);
  }, 60_000);
});

describe("token redaction across records and failures", () => {
  it("connect persists no OAuth token in records, outcomes or projection rows", async () => {
    const harness = createRegistryHarness({});
    const controlStore = createFakeControlStore();
    const projection = createFakeProjection();
    const coordinator = createCollaborationCoordinator({
      platform: harness.registry,
      controlStore: controlStore.port,
      projection: projection.port,
      now: () => NOW,
    });
    const outcome = await coordinator.execute(CONNECT_COMMAND, aliceRegistry);
    expect(outcome).toMatchObject({ status: "connected" });

    const persisted = JSON.stringify({
      outcome,
      control: controlStore.controlRecords,
      project: controlStore.projectRecords,
      projection: projection.applied,
    });
    expect(persisted).not.toContain(TOKEN);
    // The platform response entered the chain only as a digest.
    const snapshot = controlStore.controlRecords.find(
      (record) => record.record_kind === "principal_snapshot",
    );
    expect(snapshot).toMatchObject({
      source_response_digest: expect.stringMatching(/^[a-f0-9]{64}$/u) as unknown as string,
    });
  });

  it("failure text never carries the token either", async () => {
    const harness = createRegistryHarness({ repository: { permissions: {} } });
    const outcome = await harness.registry.authenticate(OAUTH_INPUT);
    // permissions block without any true flag → permission_denied
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(JSON.stringify(outcome.failure)).not.toContain(TOKEN);
  });
});

describe("approval and protection boundaries", () => {
  function approvalPlatform(): PlatformIdentityPort {
    return {
      discover: (remote) =>
        Promise.resolve({
          status: "resolved" as const,
          identity: {
            provider: "github" as const,
            host: "github.com",
            repository_id: "acme/demo",
            canonical_remote: remote,
            canonical_remote_digest: digest("b"),
          },
        }),
      authenticate: (input) =>
        Promise.resolve({
          status: "authenticated" as const,
          snapshot: {
            principal_id: input.principal_id,
            provider: "github" as const,
            host: "github.com",
            subject_id: "1234567",
            repository_id: input.repository_id,
            permission: "maintain" as const,
            observed_at: NOW,
            expires_at: LATER,
            source_response_digest: digest("a"),
          },
        }),
      inspectControlRefProtection: () => Promise.resolve({ status: "protected" as const }),
    };
  }

  it("blocks the requester principal from approving its own request", async () => {
    const request = buildApprovalRequest({
      requestId: "approval_request_sec",
      workflowOperationId: "workflow_op_sec",
      objectId: "requirement_baseline",
      objectType: "RequirementBaseline",
      objectDigest: digest("a"),
      baselineDigest: digest("b"),
      policyDigest: digest("c"),
      impactPath: ["intent_sec"],
      risk: "medium",
      reason: "approve the requirement baseline",
      allowedDecisions: ["approve", "reject", "defer"],
      createdAt: EARLIER,
      resumePhase: "capture",
      proposedBy: "agent:harness",
      requesterPrincipal: {
        principal_id: "principal_alice",
        principal_snapshot_digest: digest("d"),
      },
    });
    const controlStore = createFakeControlStore();
    const coordinator = createCollaborationCoordinator({
      platform: approvalPlatform(),
      controlStore: controlStore.port,
      projection: createFakeProjection().port,
      now: () => NOW,
      readApprovalRequest: (input) =>
        Promise.resolve(input.request_id === request.request_id ? request : undefined),
    });
    const connected = await coordinator.execute(CONNECT_COMMAND, alice);
    expect(connected.status).toBe("connected");

    const outcome = await coordinator.execute(
      {
        kind: "submit_remote_approval",
        command_id: "command_decision_sec",
        project_id: PROJECT_ID,
        request_id: request.request_id,
        decision: "approve",
      },
      alice,
    );
    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "approval_self_approval", retryable: false },
    });
    expect(
      controlStore.controlRecords.filter(
        (record) => record.record_kind === "remote_approval_decision",
      ),
    ).toHaveLength(0);
  });

  it("fails connect closed when the control ref protection is not provable", async () => {
    const harness = createRegistryHarness({ protectionStatus: 404, protection: {} });
    const controlStore = createFakeControlStore();
    const projection = createFakeProjection();
    const coordinator = createCollaborationCoordinator({
      platform: harness.registry,
      controlStore: controlStore.port,
      projection: projection.port,
      now: () => NOW,
    });
    const outcome = await coordinator.execute(CONNECT_COMMAND, aliceRegistry);
    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "control_ref_unprotected" },
    });
    // Nothing was appended anywhere: the project never enters collaboration
    // mode without a provably protected Control Ref.
    expect(controlStore.controlRecords).toHaveLength(0);
    expect(controlStore.projectRecords).toHaveLength(0);
    expect(projection.applied).toHaveLength(0);
  });
});
