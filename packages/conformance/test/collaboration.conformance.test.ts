import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGitControlStoreAdapter } from "@universal-harness-internal/adapter-vcs-git";
import {
  assertControlChain,
  type CollaborationConnectionRecord,
  type CollaborationPermission,
  type CollaborationProvider,
  type CollaborationRecord,
  type ControlRecord,
  type IntegrationRecord,
  type RemoteApprovalDecisionRecord,
} from "@universal-harness-internal/core";
import {
  createOAuthSessionStore,
  createPlatformIdentityRegistry,
  SqliteCoordinatorProjection,
  type CollaborationView,
  type PlatformAdapterConfig,
  type PlatformFetch,
  type PlatformHttpRequest,
} from "@universal-harness-internal/runtime";
import { afterEach, describe, it } from "vitest";

import {
  assertConformance,
  coordinatorProjectionConformanceCases,
  gitControlStoreConformanceCases,
  platformIdentityConformanceCases,
  runConformanceSuite,
  type CoordinatorProjectionKit,
  type GitControlStoreKit,
  type PlatformIdentityFactory,
  type PlatformScript,
} from "../src/index.js";

/**
 * Plan M3 Task 9 step 1: the shared collaboration conformance suites run
 * against every Adapter behind the three internal seams — the production
 * GitHub/GitLab/Gitee identity registry (scripted HTTPS), the production Git
 * control store plus an in-memory counterpart, and the SQLite projection plus
 * an in-memory counterpart. This is where the Adapter↔port compatibility is
 * locked formally.
 */

const NOW = "2026-08-29T00:00:00.000Z";
const REDIRECT = "https://harness.example.com/oauth/callback";
const CONTROL_REF = "refs/heads/harness/control";
const REPOSITORY_ID = "acme/demo";

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
});

function tempDir(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  directories.push(directory);
  return directory;
}

// --- PlatformIdentityPort: production registry per provider -------------------

interface ProviderSetup {
  readonly config: PlatformAdapterConfig;
  readonly remote: string;
  readonly ssh_remote: string;
  readonly supported_permissions: readonly CollaborationPermission[];
  readonly routes: (script: PlatformScript) => Record<string, { status?: number; body?: unknown }>;
}

const GITHUB_PERMISSION_FLAGS: Record<CollaborationPermission, Record<string, boolean>> = {
  admin: { admin: true, maintain: false, push: false, triage: false, pull: false },
  maintain: { admin: false, maintain: true, push: false, triage: false, pull: false },
  write: { admin: false, maintain: false, push: true, triage: false, pull: false },
  read: { admin: false, maintain: false, push: false, triage: false, pull: true },
};

const GITLAB_ACCESS_LEVELS: Record<CollaborationPermission, number> = {
  read: 20,
  write: 30,
  maintain: 40,
  admin: 50,
};

function githubRoutes(script: PlatformScript): Record<string, { status?: number; body?: unknown }> {
  const repository =
    script.malformed_permission === true
      ? {}
      : { permissions: GITHUB_PERMISSION_FLAGS[script.permission] };
  const protection = {
    enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    restrictions: {
      users: [
        {
          login: script.protection === "foreign_identity" ? "someone-else" : "harness-coordinator",
        },
      ],
      teams: script.protection === "role_based" ? [{ slug: "core" }] : [],
      apps: [],
    },
  };
  return {
    "POST https://github.com/login/oauth/access_token": {
      body: { access_token: script.token ?? "conformance-token", expires_in: 3600 },
    },
    "GET https://api.github.com/user": { body: { id: Number(script.subject_id) } },
    "GET https://api.github.com/repos/acme/demo": { body: repository },
    "GET https://api.github.com/repos/acme/demo/branches/harness%2Fcontrol/protection":
      script.protection === "absent" ? { status: 404, body: {} } : { body: protection },
  };
}

function gitlabRoutes(script: PlatformScript): Record<string, { status?: number; body?: unknown }> {
  const repository =
    script.malformed_permission === true
      ? { permissions: { project_access: { access_level: 99 } } }
      : {
          permissions: {
            project_access: { access_level: GITLAB_ACCESS_LEVELS[script.permission] },
          },
        };
  const userId =
    script.protection === "foreign_identity"
      ? 1234
      : script.protection === "role_based"
        ? null
        : 9001;
  const protection = {
    allow_force_push: false,
    push_access_levels: [{ user_id: userId, access_level: 40 }],
  };
  return {
    "POST https://gitlab.com/oauth/token": {
      body: { access_token: script.token ?? "conformance-token", expires_in: 3600 },
    },
    "GET https://gitlab.com/api/v4/user": { body: { id: Number(script.subject_id) } },
    "GET https://gitlab.com/api/v4/projects/acme%2Fdemo": { body: repository },
    "GET https://gitlab.com/api/v4/projects/acme%2Fdemo/protected_branches/harness%2Fcontrol":
      script.protection === "absent" ? { status: 404, body: {} } : { body: protection },
  };
}

function giteeRoutes(script: PlatformScript): Record<string, { status?: number; body?: unknown }> {
  const repository =
    script.malformed_permission === true
      ? { permission: "owner" }
      : { permission: script.permission };
  const pusher =
    script.protection === "foreign_identity"
      ? "someone-else"
      : script.protection === "role_based"
        ? "administrators"
        : "harness-coordinator";
  return {
    "POST https://gitee.com/oauth/token": {
      body: { access_token: script.token ?? "conformance-token", expires_in: 3600 },
    },
    "GET https://gitee.com/api/v5/user": { body: { id: Number(script.subject_id) } },
    "GET https://gitee.com/api/v5/repos/acme/demo": { body: repository },
    "GET https://gitee.com/api/v5/repos/acme/demo/branches/harness%2Fcontrol":
      script.protection === "absent" ? { status: 404, body: {} } : { body: { protected: true } },
    "GET https://gitee.com/api/v5/repos/acme/demo/branches/harness%2Fcontrol/protection": {
      body: { pusher },
    },
  };
}

const PROVIDERS: Record<CollaborationProvider, ProviderSetup> = {
  github: {
    config: {
      provider: "github",
      host: "github.com",
      api_base_url: "https://api.github.com",
      authorize_url: "https://github.com/login/oauth/authorize",
      token_url: "https://github.com/login/oauth/access_token",
      client_id: "client_github",
      redirect_uri: REDIRECT,
      coordinator_identity: "harness-coordinator",
    },
    remote: "https://github.com/acme/demo.git",
    ssh_remote: "git@github.com:acme/demo.git",
    supported_permissions: ["read", "write", "maintain", "admin"],
    routes: githubRoutes,
  },
  gitlab: {
    config: {
      provider: "gitlab",
      host: "gitlab.com",
      api_base_url: "https://gitlab.com/api/v4",
      authorize_url: "https://gitlab.com/oauth/authorize",
      token_url: "https://gitlab.com/oauth/token",
      client_id: "client_gitlab",
      redirect_uri: REDIRECT,
      coordinator_identity: "9001",
    },
    remote: "https://gitlab.com/acme/demo.git",
    ssh_remote: "git@gitlab.com:acme/demo.git",
    supported_permissions: ["read", "write", "maintain", "admin"],
    routes: gitlabRoutes,
  },
  gitee: {
    config: {
      provider: "gitee",
      host: "gitee.com",
      api_base_url: "https://gitee.com/api/v5",
      authorize_url: "https://gitee.com/oauth/authorize",
      token_url: "https://gitee.com/oauth/token",
      client_id: "client_gitee",
      redirect_uri: REDIRECT,
      coordinator_identity: "harness-coordinator",
    },
    remote: "https://gitee.com/acme/demo.git",
    ssh_remote: "git@gitee.com:acme/demo.git",
    supported_permissions: ["read", "write", "admin"],
    routes: giteeRoutes,
  },
};

function platformFactory(provider: CollaborationProvider): PlatformIdentityFactory {
  const setup = PROVIDERS[provider];
  return (script) => {
    const routes = setup.routes(script);
    const requests: PlatformHttpRequest[] = [];
    const fetch: PlatformFetch = (request) => {
      requests.push(request);
      const route = routes[`${request.method} ${request.url}`];
      if (route === undefined) {
        throw new Error(`unexpected request ${request.method} ${request.url}`);
      }
      return Promise.resolve({
        status: route.status ?? 200,
        body: route.body === undefined ? "" : JSON.stringify(route.body),
      });
    };
    const port = createPlatformIdentityRegistry([setup.config], {
      fetch,
      sessions: createOAuthSessionStore({ now: () => NOW }),
      authorize: (authorizeUrl) => {
        const state = new URL(authorizeUrl).searchParams.get("state") ?? "";
        return Promise.resolve(`${REDIRECT}?code=code_1&state=${state}`);
      },
      now: () => NOW,
    });
    return {
      port,
      provider,
      host: setup.config.host,
      repository_id: REPOSITORY_ID,
      remote: setup.remote,
      ssh_remote: setup.ssh_remote,
      coordinator_identity: setup.config.coordinator_identity,
      control_ref: CONTROL_REF,
      supported_permissions: setup.supported_permissions,
    };
  };
}

// --- GitControlStorePort: production git adapter ------------------------------

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "gc.auto=0", ...args], {
    cwd,
    encoding: "utf8",
  });
}

async function realGitKit(): Promise<GitControlStoreKit> {
  const remote = tempDir("harness-conf-git-remote-");
  git(remote, "init", "--bare", "-b", "main");
  const scratch = tempDir("harness-conf-git-scratch-");
  git(scratch, "init", "-b", "main");
  git(scratch, "config", "user.name", "Harness Conformance");
  git(scratch, "config", "user.email", "harness-conformance@example.invalid");
  git(scratch, "config", "commit.gpgsign", "false");
  git(scratch, "remote", "add", "origin", remote);
  let counter = 0;
  const port = createGitControlStoreAdapter({
    remote,
    mirror_root: join(tempDir("harness-conf-git-mirror-"), "mirror"),
  });
  return {
    port,
    commit(content, parents = []) {
      counter += 1;
      if (parents.length > 0) {
        // Parent commits may live only on the remote (for example the
        // connection record commit the adapter made in its mirror); fetch the
        // refs so the scratch repository can unpack their trees.
        git(scratch, "fetch", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*");
        git(scratch, "read-tree", parents[0] as string);
      } else {
        git(scratch, "read-tree", "--empty");
      }
      const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: scratch,
        input: content,
        encoding: "utf8",
      }).trim();
      git(
        scratch,
        "update-index",
        "--add",
        "--cacheinfo",
        `100644,${blob},content-${String(counter)}.txt`,
      );
      const tree = git(scratch, "write-tree").trim();
      const parentArgs = parents.flatMap((parent) => ["-p", parent]);
      return git(scratch, "commit-tree", tree, ...parentArgs, "-m", content).trim();
    },
    moveRef(ref, oid) {
      git(scratch, "push", "--force", "origin", `${oid}:${ref}`);
      return Promise.resolve();
    },
    tip(ref) {
      try {
        const out = execFileSync(
          "git",
          ["--git-dir", remote, "rev-parse", "--verify", "--quiet", ref],
          { encoding: "utf8" },
        ).trim();
        return Promise.resolve(out === "" ? undefined : out);
      } catch {
        return Promise.resolve(undefined);
      }
    },
    stageCandidate(operationId, commitOid) {
      git(
        scratch,
        "push",
        "--force",
        "origin",
        `${commitOid}:refs/heads/harness/candidate/${operationId}`,
      );
      return Promise.resolve();
    },
    cleanup() {
      // Temp directories are reaped by the shared afterEach.
    },
  };
}

// --- GitControlStorePort: in-memory counterpart --------------------------------

interface MemCommit {
  readonly parents: readonly string[];
}

function createInMemoryGitKit(): GitControlStoreKit {
  const commits = new Map<string, MemCommit>();
  const refs = new Map<string, string>();
  const controlRecords: ControlRecord[] = [];
  const projectRecords: (CollaborationConnectionRecord | IntegrationRecord)[] = [];
  let rememberedTargetRef: string | undefined;
  let counter = 0;
  const nextOid = (): string => {
    counter += 1;
    return counter.toString(16).padStart(40, "0");
  };
  const controlHead = (): string | undefined =>
    controlRecords.length === 0 ? undefined : `oid_control_${String(controlRecords.length)}`;
  const ancestorsOf = (oid: string): Set<string> => {
    const seen = new Set<string>();
    const queue = [oid];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      const commit = commits.get(current);
      if (commit !== undefined) queue.push(...commit.parents);
    }
    return seen;
  };
  const fail = (
    code:
      | "control_ref_cas_failed"
      | "control_ref_invalid"
      | "operation_ref_drift"
      | "target_cas_failed"
      | "coordinator_unavailable"
      | "git_remote_unavailable",
    summary: string,
    retryable = false,
  ) => ({ status: "failed" as const, failure: { code, summary, retryable } });
  const unused = () =>
    Promise.resolve(fail("coordinator_unavailable", "not exercised by the conformance kit"));
  return {
    port: {
      readControl(input) {
        const latest = [...projectRecords]
          .reverse()
          .find(
            (record): record is CollaborationConnectionRecord =>
              record.record_kind === "collaboration_connection",
          );
        const head = controlHead();
        const targetHead = input.target_ref === undefined ? undefined : refs.get(input.target_ref);
        return Promise.resolve({
          status: "ok" as const,
          snapshot: {
            ...(head === undefined ? {} : { control_head_oid: head }),
            control_records: [...controlRecords],
            ...(latest === undefined ? {} : { latest_connection: latest }),
            ...(targetHead === undefined ? {} : { target_head_oid: targetHead }),
          },
        });
      },
      appendControl(input) {
        if (input.expected_head_oid !== controlHead()) {
          return Promise.resolve(
            fail("control_ref_cas_failed", "stale expected control head", true),
          );
        }
        try {
          assertControlChain([...controlRecords, input.record]);
        } catch {
          return Promise.resolve(fail("control_ref_invalid", "record does not continue the chain"));
        }
        controlRecords.push(input.record);
        return Promise.resolve({ status: "appended" as const, head_oid: controlHead() as string });
      },
      appendProjectRecord(input) {
        const head = refs.get(input.target_ref);
        if (head === undefined) {
          return Promise.resolve(
            fail("git_remote_unavailable", `target ref ${input.target_ref} does not exist`),
          );
        }
        const commitOid = nextOid();
        commits.set(commitOid, { parents: [head] });
        refs.set(input.target_ref, commitOid);
        rememberedTargetRef = input.target_ref;
        projectRecords.push(input.record);
        return Promise.resolve({ status: "committed" as const, commit: commitOid });
      },
      listOperationHeads() {
        const heads: { operation_id: string; head_oid: string }[] = [];
        for (const [ref, oid] of [...refs.entries()].sort()) {
          if (ref.startsWith("refs/heads/operation/")) {
            heads.push({ operation_id: ref.slice("refs/heads/operation/".length), head_oid: oid });
          }
        }
        return Promise.resolve({ status: "ok" as const, heads });
      },
      compareAndSwapOperation(input) {
        const staged = refs.get(`refs/heads/harness/candidate/${input.operation_id}`);
        if (staged !== input.candidate_commit) {
          return Promise.resolve(
            fail("operation_ref_drift", "candidate staging ref does not name the published commit"),
          );
        }
        const ref = `refs/heads/operation/${input.operation_id}`;
        const current = refs.get(ref);
        if (input.expected_head_oid !== current) {
          return Promise.resolve(
            fail("operation_ref_drift", "operation head moved since the authoritative read", true),
          );
        }
        if (current !== undefined) {
          if (!ancestorsOf(input.candidate_commit).has(current)) {
            return Promise.resolve(
              fail(
                "operation_ref_drift",
                "candidate commit does not descend from the operation head",
              ),
            );
          }
        } else {
          if (rememberedTargetRef === undefined) {
            return Promise.resolve(
              fail("coordinator_unavailable", "first publish has no operation baseline"),
            );
          }
          const baseline = refs.get(rememberedTargetRef);
          if (baseline === undefined || !ancestorsOf(input.candidate_commit).has(baseline)) {
            return Promise.resolve(
              fail("operation_ref_drift", "candidate commit does not descend from the baseline"),
            );
          }
        }
        refs.set(ref, input.candidate_commit);
        return Promise.resolve({ status: "swapped" as const, head_oid: input.candidate_commit });
      },
      prepareCandidate: unused,
      readCandidate: () => Promise.resolve({ status: "missing" as const }),
      readIntegrationRecord: () => Promise.resolve({ status: "missing" as const }),
      compareAndSwapTarget(input) {
        const head = refs.get(input.target_ref);
        if (head !== input.expected_commit) {
          return Promise.resolve(
            fail("target_cas_failed", "target head moved since the command froze it", true),
          );
        }
        if (!commits.has(input.new_commit)) {
          return Promise.resolve(
            fail("coordinator_unavailable", "candidate commit is not available"),
          );
        }
        if (!ancestorsOf(input.new_commit).has(input.expected_commit)) {
          return Promise.resolve(
            fail(
              "target_cas_failed",
              "candidate commit does not descend from the expected target commit",
            ),
          );
        }
        refs.set(input.target_ref, input.new_commit);
        return Promise.resolve({ status: "swapped" as const, commit: input.new_commit });
      },
    },
    commit(content, parents = []) {
      const oid = nextOid();
      commits.set(oid, { parents: [...parents] });
      return Promise.resolve(oid);
    },
    moveRef(ref, oid) {
      refs.set(ref, oid);
      return Promise.resolve();
    },
    tip(ref) {
      return Promise.resolve(refs.get(ref));
    },
    stageCandidate(operationId, commitOid) {
      refs.set(`refs/heads/harness/candidate/${operationId}`, commitOid);
      return Promise.resolve();
    },
    cleanup() {
      // Nothing to release.
    },
  };
}

// --- CoordinatorProjectionPort: SQLite and in-memory ---------------------------

function sqliteProjectionKit(): CoordinatorProjectionKit {
  const projection = new SqliteCoordinatorProjection(":memory:");
  return {
    port: projection,
    schemaFields() {
      const database = projection.unsafeDatabase();
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String((row as { name: unknown }).name))
        .filter((name) => /^[a-z_]+$/u.test(name));
      return tables.flatMap((table) =>
        database
          .prepare(`SELECT name FROM pragma_table_info('${table}')`)
          .all()
          .map((row) => `${table}.${String((row as { name: unknown }).name)}`),
      );
    },
    cleanup() {
      projection.close();
    },
  };
}

function inMemoryProjectionKit(): CoordinatorProjectionKit {
  let connection: CollaborationConnectionRecord | undefined;
  let decisions: RemoteApprovalDecisionRecord[] = [];
  let integrations: IntegrationRecord[] = [];
  const applyRecord = (record: CollaborationRecord): void => {
    if (record.record_kind === "collaboration_connection") {
      connection = record;
    } else if (record.record_kind === "integration") {
      integrations = [
        ...integrations.filter((item) => item.integration_id !== record.integration_id),
        record,
      ];
    } else if (record.record_kind === "remote_approval_decision") {
      decisions = [
        ...decisions.filter((item) => item.remote_decision_id !== record.remote_decision_id),
        record,
      ];
    }
  };
  return {
    port: {
      rebuild(input) {
        if (input.control_records.length > 0) {
          assertControlChain([...input.control_records]);
        }
        connection = input.latest_connection;
        decisions = [];
        integrations = [];
        for (const record of input.control_records) applyRecord(record);
        return Promise.resolve();
      },
      apply(record) {
        applyRecord(record);
        return Promise.resolve();
      },
      query(query): Promise<CollaborationView> {
        switch (query.kind) {
          case "connection_status":
            if (connection === undefined || connection.project_id !== query.project_id) {
              return Promise.resolve({
                kind: "connection_status",
                project_id: query.project_id,
                status: "not_connected",
              });
            }
            return Promise.resolve({
              kind: "connection_status",
              project_id: query.project_id,
              status: connection.status,
              connection,
            });
          case "operations":
            return Promise.resolve({
              kind: "operations",
              project_id: query.project_id,
              operations: [],
            });
          case "approval_inbox":
            return Promise.resolve({
              kind: "approval_inbox",
              project_id: query.project_id,
              decisions: [...decisions],
            });
          case "integration_conflicts":
            return Promise.resolve({
              kind: "integration_conflicts",
              project_id: query.project_id,
              conflicts: [...integrations],
            });
        }
      },
    },
    cleanup() {
      // Nothing to release.
    },
  };
}

// --- Suites ---------------------------------------------------------------------

describe("m3 collaboration conformance", () => {
  for (const provider of ["github", "gitlab", "gitee"] as const) {
    it(`platform identity: production ${provider} adapter satisfies the shared contract`, async () => {
      const report = await runConformanceSuite({
        plugin: `runtime-platform-${provider}`,
        kind: "vcs",
        cases: platformIdentityConformanceCases(platformFactory(provider)),
      });
      assertConformance(report);
    });
  }

  it("git control store: production git adapter satisfies the shared contract", async () => {
    const report = await runConformanceSuite({
      plugin: "adapter-vcs-git-control-store",
      kind: "vcs",
      cases: gitControlStoreConformanceCases(realGitKit),
    });
    assertConformance(report);
  }, 120_000);

  it("git control store: in-memory adapter satisfies the shared contract", async () => {
    const report = await runConformanceSuite({
      plugin: "in-memory-git-control-store",
      kind: "vcs",
      cases: gitControlStoreConformanceCases(() => createInMemoryGitKit()),
    });
    assertConformance(report);
  });

  it("coordinator projection: SQLite adapter satisfies the shared contract", async () => {
    const report = await runConformanceSuite({
      plugin: "runtime-sqlite-coordinator-projection",
      kind: "projection",
      cases: coordinatorProjectionConformanceCases(() => sqliteProjectionKit()),
    });
    assertConformance(report);
  });

  it("coordinator projection: in-memory adapter satisfies the shared contract", async () => {
    const report = await runConformanceSuite({
      plugin: "in-memory-coordinator-projection",
      kind: "projection",
      cases: coordinatorProjectionConformanceCases(() => inMemoryProjectionKit()),
    });
    assertConformance(report);
  });
});
