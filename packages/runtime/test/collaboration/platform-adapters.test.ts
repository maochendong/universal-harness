import { describe, expect, it } from "vitest";

import type { OAuthSessionStore } from "../../src/collaboration/oauth-session.js";
import { createOAuthSessionStore } from "../../src/collaboration/oauth-session.js";
import {
  createPlatformIdentityRegistry,
  giteePermission,
  githubPermission,
  gitlabPermission,
  PERMISSION_SNAPSHOT_TTL_MS,
  PlatformAdapterError,
  principalIdFor,
  type PlatformAdapterConfig,
  type PlatformFetch,
  type PlatformHttpRequest,
} from "../../src/collaboration/platform-adapters.js";

const NOW = "2026-08-29T00:00:00.000Z";
const REDIRECT = "https://harness.example.com/oauth/callback";

const GITHUB_TOKEN = "gho_fixture_token";
const GITLAB_TOKEN = "glpat-fixture-token";
const GITEE_TOKEN = "gitee_fixture_token";

const GITHUB_CONFIG: PlatformAdapterConfig = {
  provider: "github",
  host: "github.com",
  api_base_url: "https://api.github.com",
  authorize_url: "https://github.com/login/oauth/authorize",
  token_url: "https://github.com/login/oauth/access_token",
  client_id: "client_github",
  redirect_uri: REDIRECT,
  scope: "read:user repo",
  coordinator_identity: "harness-coordinator",
};

const GITLAB_CONFIG: PlatformAdapterConfig = {
  provider: "gitlab",
  host: "gitlab.com",
  api_base_url: "https://gitlab.com/api/v4",
  authorize_url: "https://gitlab.com/oauth/authorize",
  token_url: "https://gitlab.com/oauth/token",
  client_id: "client_gitlab",
  redirect_uri: REDIRECT,
  scope: "read_user api",
  coordinator_identity: "9001",
};

const GITEE_CONFIG: PlatformAdapterConfig = {
  provider: "gitee",
  host: "gitee.com",
  api_base_url: "https://gitee.com/api/v5",
  authorize_url: "https://gitee.com/oauth/authorize",
  token_url: "https://gitee.com/oauth/token",
  client_id: "client_gitee",
  redirect_uri: REDIRECT,
  coordinator_identity: "harness-coordinator",
};

const CONTROL_REF = "refs/heads/harness/control";

function expectDenied(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PlatformAdapterError);
    expect((error as PlatformAdapterError).code).toBe("permission_denied");
    return;
  }
  expect.unreachable("expected a PlatformAdapterError with code permission_denied");
}

interface Route {
  readonly status?: number;
  readonly body?: unknown;
  readonly assert?: (request: PlatformHttpRequest) => void;
}

function fakeFetch(routes: Readonly<Record<string, Route>>): {
  readonly fetch: PlatformFetch;
  readonly requests: PlatformHttpRequest[];
} {
  const requests: PlatformHttpRequest[] = [];
  const fetch: PlatformFetch = (request) => {
    requests.push(request);
    const route = routes[`${request.method} ${request.url}`];
    if (!route) {
      throw new Error(`unexpected request ${request.method} ${request.url}`);
    }
    route.assert?.(request);
    return Promise.resolve({
      status: route.status ?? 200,
      body: route.body === undefined ? "" : JSON.stringify(route.body),
    });
  };
  return { fetch, requests };
}

function callbackAuthorize(codes: {
  readonly code?: string;
  readonly stateOverride?: string;
  readonly originOverride?: string;
}) {
  return (authorizeUrl: string): Promise<string> => {
    const url = new URL(authorizeUrl);
    const state = codes.stateOverride ?? url.searchParams.get("state") ?? "";
    const origin = codes.originOverride ?? REDIRECT;
    const code = codes.code ?? "code_1";
    return Promise.resolve(`${origin}?code=${code}&state=${state}`);
  };
}

function makeRegistry(options: {
  readonly routes: Readonly<Record<string, Route>>;
  readonly configs?: readonly PlatformAdapterConfig[];
  readonly authorize?: (url: string) => Promise<string>;
  readonly sessions?: OAuthSessionStore;
}) {
  const { fetch, requests } = fakeFetch(options.routes);
  const registry = createPlatformIdentityRegistry(options.configs ?? [GITHUB_CONFIG], {
    fetch,
    sessions: options.sessions ?? createOAuthSessionStore({ now: () => NOW }),
    authorize: options.authorize ?? callbackAuthorize({}),
    now: () => NOW,
  });
  return { registry, requests };
}

describe("pure permission mappings", () => {
  it("normalizes GitHub repository permissions", () => {
    expect(
      githubPermission({ permissions: { admin: false, maintain: true, push: true, pull: true } }),
    ).toBe("maintain");
    expect(
      githubPermission({ permissions: { admin: true, maintain: true, push: true, pull: true } }),
    ).toBe("admin");
    expect(
      githubPermission({ permissions: { admin: false, maintain: false, push: true, pull: true } }),
    ).toBe("write");
    expect(
      githubPermission({
        permissions: { admin: false, maintain: false, push: false, triage: true, pull: true },
      }),
    ).toBe("read");
    expect(
      githubPermission({ permissions: { admin: false, maintain: false, push: false, pull: true } }),
    ).toBe("read");
  });

  it("fails closed on missing or all-false GitHub permissions", () => {
    expectDenied(() => githubPermission({}));
    expectDenied(() =>
      githubPermission({
        permissions: { admin: false, maintain: false, push: false, pull: false },
      }),
    );
    expectDenied(() => githubPermission({ permissions: { admin: "yes" } }));
    expect(() => githubPermission({})).toThrowError(PlatformAdapterError);
  });

  it("normalizes GitLab access levels", () => {
    expect(gitlabPermission({ permissions: { project_access: { access_level: 30 } } })).toBe(
      "write",
    );
    expect(gitlabPermission({ permissions: { project_access: { access_level: 40 } } })).toBe(
      "maintain",
    );
    expect(gitlabPermission({ permissions: { project_access: { access_level: 50 } } })).toBe(
      "admin",
    );
    expect(gitlabPermission({ permissions: { project_access: { access_level: 20 } } })).toBe(
      "read",
    );
    expect(gitlabPermission({ permissions: { project_access: { access_level: 10 } } })).toBe(
      "read",
    );
    expect(
      gitlabPermission({
        permissions: {
          project_access: { access_level: 20 },
          group_access: { access_level: 40 },
        },
      }),
    ).toBe("maintain");
    expect(
      gitlabPermission({
        permissions: { project_access: null, group_access: { access_level: 30 } },
      }),
    ).toBe("write");
  });

  it("fails closed on unknown or missing GitLab access levels", () => {
    expectDenied(() => gitlabPermission({ permissions: { project_access: { access_level: 15 } } }));
    expectDenied(() =>
      gitlabPermission({ permissions: { project_access: null, group_access: null } }),
    );
    expectDenied(() => gitlabPermission({}));
  });

  it("normalizes Gitee repository permissions", () => {
    expect(giteePermission({ permission: "admin" })).toBe("admin");
    expect(giteePermission({ permission: "write" })).toBe("write");
    expect(giteePermission({ permission: "read" })).toBe("read");
  });

  it("fails closed on unknown or missing Gitee permissions", () => {
    expectDenied(() => giteePermission({ permission: "unknown" }));
    expectDenied(() => giteePermission({}));
  });
});

describe("principalIdFor", () => {
  it("derives a deterministic id from provider, canonical host and subject id", () => {
    const id = principalIdFor("github", "github.com", "4242");
    expect(id).toMatch(/^principal_[0-9a-f]{24}$/);
    expect(principalIdFor("github", "github.com", "4242")).toBe(id);
    expect(principalIdFor("gitlab", "github.com", "4242")).not.toBe(id);
    expect(principalIdFor("github", "gitlab.com", "4242")).not.toBe(id);
    expect(principalIdFor("github", "github.com", "8484")).not.toBe(id);
  });

  it("does not treat usernames or display names as stable identity", () => {
    // A rename changes the login but not the platform subject id, so the
    // principal stays; two users sharing a login on different hosts diverge.
    expect(principalIdFor("github", "github.com", "4242")).toBe(
      principalIdFor("github", "github.com", "4242"),
    );
    expect(principalIdFor("github", "github.com", "alice")).not.toBe(
      principalIdFor("gitee", "gitee.com", "alice"),
    );
  });
});

describe("GitHub adapter", () => {
  const githubRoutes = {
    "POST https://github.com/login/oauth/access_token": {
      body: { access_token: GITHUB_TOKEN, token_type: "bearer", expires_in: 28_800 },
      assert: (request: PlatformHttpRequest) => {
        expect(request.body).toContain("code_verifier=");
        expect(request.body).toContain("code=code_1");
        expect(request.body).toContain(`client_id=${GITHUB_CONFIG.client_id}`);
      },
    },
    "GET https://api.github.com/user": {
      body: { id: 4242, login: "alice", email: "alice@example.com" },
      assert: (request: PlatformHttpRequest) => {
        expect(request.headers.authorization).toBe(`Bearer ${GITHUB_TOKEN}`);
      },
    },
    "GET https://api.github.com/repos/Acme/Demo": {
      body: {
        id: 777,
        permissions: { admin: false, maintain: true, push: true, triage: true, pull: true },
      },
    },
  } satisfies Record<string, Route>;

  it("authenticates and returns redacted PrincipalSnapshot facts", async () => {
    const authorizeUrls: string[] = [];
    const { registry } = makeRegistry({
      routes: githubRoutes,
      authorize: (url) => {
        authorizeUrls.push(url);
        return callbackAuthorize({})(url);
      },
    });
    const principalId = principalIdFor("github", "github.com", "4242");
    const result = await registry.authenticate({
      provider: "github",
      host: "github.com",
      repository_id: "Acme/Demo",
      principal_id: principalId,
    });
    expect(result.status).toBe("authenticated");
    if (result.status !== "authenticated") throw new Error("expected authenticated");
    expect(result.snapshot).toEqual({
      principal_id: principalId,
      provider: "github",
      host: "github.com",
      subject_id: "4242",
      repository_id: "Acme/Demo",
      permission: "maintain",
      observed_at: NOW,
      expires_at: new Date(Date.parse(NOW) + PERMISSION_SNAPSHOT_TTL_MS).toISOString(),
      source_response_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // Data minimization: no email, login or token leaves the adapter.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(GITHUB_TOKEN);
    expect(serialized).not.toContain("alice@example.com");
    expect(serialized).not.toContain("alice");
    // PKCE S256 parameters went out on the authorize URL.
    const authorizeUrl = new URL(authorizeUrls[0]);
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorizeUrl.searchParams.get("client_id")).toBe(GITHUB_CONFIG.client_id);
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(authorizeUrl.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reuses a live token and re-pulls facts instead of re-running OAuth", async () => {
    let authorizeCalls = 0;
    const { registry, requests } = makeRegistry({
      routes: githubRoutes,
      authorize: (url) => {
        authorizeCalls += 1;
        return callbackAuthorize({})(url);
      },
    });
    const principalId = principalIdFor("github", "github.com", "4242");
    const input = {
      provider: "github" as const,
      host: "github.com",
      repository_id: "Acme/Demo",
      principal_id: principalId,
    };
    const first = await registry.authenticate(input);
    expect(first.status).toBe("authenticated");
    expect(authorizeCalls).toBe(1);
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "POST https://github.com/login/oauth/access_token",
      "GET https://api.github.com/user",
      "GET https://api.github.com/repos/Acme/Demo",
    ]);

    // The second authenticate (same repository, live token) skips the browser
    // dance and the code exchange but still re-observes user and permission.
    const second = await registry.authenticate(input);
    expect(second.status).toBe("authenticated");
    if (second.status !== "authenticated") throw new Error("expected authenticated");
    expect(second.snapshot).toEqual(first.status === "authenticated" ? first.snapshot : undefined);
    expect(authorizeCalls).toBe(1);
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "POST https://github.com/login/oauth/access_token",
      "GET https://api.github.com/user",
      "GET https://api.github.com/repos/Acme/Demo",
      "GET https://api.github.com/user",
      "GET https://api.github.com/repos/Acme/Demo",
    ]);
  });

  it("rejects a callback from a foreign origin", async () => {
    const { registry } = makeRegistry({
      routes: githubRoutes,
      authorize: callbackAuthorize({ originOverride: "https://evil.example.com/oauth/callback" }),
    });
    const result = await registry.authenticate({
      provider: "github",
      host: "github.com",
      repository_id: "Acme/Demo",
      principal_id: "principal_any",
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("authentication_required");
    }
  });

  it("rejects a callback whose state was never issued", async () => {
    const { registry } = makeRegistry({
      routes: githubRoutes,
      authorize: callbackAuthorize({ stateOverride: "f".repeat(64) }),
    });
    const result = await registry.authenticate({
      provider: "github",
      host: "github.com",
      repository_id: "Acme/Demo",
      principal_id: "principal_any",
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("authentication_required");
    }
  });

  it("fails closed when the stable subject id is missing", async () => {
    const { registry } = makeRegistry({
      routes: {
        ...githubRoutes,
        "GET https://api.github.com/user": { body: { login: "alice" } },
      },
    });
    const result = await registry.authenticate({
      provider: "github",
      host: "github.com",
      repository_id: "Acme/Demo",
      principal_id: "principal_any",
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("authentication_required");
    }
  });

  it("fails closed when the permission block is missing or unknown", async () => {
    for (const repository of [{ id: 777 }, { id: 777, permissions: { admin: false } }]) {
      const { registry } = makeRegistry({
        routes: {
          ...githubRoutes,
          "GET https://api.github.com/repos/Acme/Demo": { body: repository },
        },
      });
      const result = await registry.authenticate({
        provider: "github",
        host: "github.com",
        repository_id: "Acme/Demo",
        principal_id: "principal_any",
      });
      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.failure.code).toBe("permission_denied");
      }
    }
  });

  it("redacts transport errors and never leaks the token", async () => {
    const leakyFetch: PlatformFetch = (request) => {
      if (request.url.includes("access_token")) {
        return Promise.resolve({
          status: 400,
          body: JSON.stringify({ error: "bad_verification_code", secret: "bad_code_secret" }),
        });
      }
      throw new Error(`transport broke while holding ${GITHUB_TOKEN}`);
    };
    const registry = createPlatformIdentityRegistry([GITHUB_CONFIG], {
      fetch: leakyFetch,
      sessions: createOAuthSessionStore({ now: () => NOW }),
      authorize: callbackAuthorize({}),
      now: () => NOW,
    });
    const exchange = await registry.authenticate({
      provider: "github",
      host: "github.com",
      repository_id: "Acme/Demo",
      principal_id: "principal_any",
    });
    expect(exchange.status).toBe("failed");
    if (exchange.status === "failed") {
      expect(exchange.failure.code).toBe("authentication_required");
      expect(exchange.failure.summary).not.toContain("bad_code_secret");
    }
  });
});

describe("GitLab adapter", () => {
  const gitlabRoutes = {
    "POST https://gitlab.com/oauth/token": {
      body: { access_token: GITLAB_TOKEN, token_type: "Bearer", expires_in: 7200 },
    },
    "GET https://gitlab.com/api/v4/user": { body: { id: 231, username: "alice" } },
    "GET https://gitlab.com/api/v4/projects/acme%2Fteam%2Fdemo": {
      body: {
        id: 555,
        permissions: { project_access: { access_level: 30 }, group_access: null },
      },
    },
  } satisfies Record<string, Route>;

  it("authenticates with subgroup repository paths", async () => {
    const { registry } = makeRegistry({ routes: gitlabRoutes, configs: [GITLAB_CONFIG] });
    const result = await registry.authenticate({
      provider: "gitlab",
      host: "gitlab.com",
      repository_id: "acme/team/demo",
      principal_id: "principal_any",
    });
    expect(result.status).toBe("authenticated");
    if (result.status !== "authenticated") throw new Error("expected authenticated");
    expect(result.snapshot.subject_id).toBe("231");
    expect(result.snapshot.permission).toBe("write");
    expect(result.snapshot.principal_id).toBe(principalIdFor("gitlab", "gitlab.com", "231"));
    expect(JSON.stringify(result)).not.toContain(GITLAB_TOKEN);
  });

  it("fails closed on an unknown access level", async () => {
    const { registry } = makeRegistry({
      routes: {
        ...gitlabRoutes,
        "GET https://gitlab.com/api/v4/projects/acme%2Fteam%2Fdemo": {
          body: { id: 555, permissions: { project_access: { access_level: 15 } } },
        },
      },
      configs: [GITLAB_CONFIG],
    });
    const result = await registry.authenticate({
      provider: "gitlab",
      host: "gitlab.com",
      repository_id: "acme/team/demo",
      principal_id: "principal_any",
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("permission_denied");
    }
  });
});

describe("Gitee adapter", () => {
  const giteeRoutes = {
    "POST https://gitee.com/oauth/token": {
      body: { access_token: GITEE_TOKEN, token_type: "bearer", expires_in: 86_400 },
    },
    "GET https://gitee.com/api/v5/user": { body: { id: 888, login: "alice" } },
    "GET https://gitee.com/api/v5/repos/acme/demo": {
      body: { id: 321, permission: "admin" },
    },
  } satisfies Record<string, Route>;

  it("authenticates with an explicit permission role", async () => {
    const { registry } = makeRegistry({ routes: giteeRoutes, configs: [GITEE_CONFIG] });
    const result = await registry.authenticate({
      provider: "gitee",
      host: "gitee.com",
      repository_id: "acme/demo",
      principal_id: "principal_any",
    });
    expect(result.status).toBe("authenticated");
    if (result.status !== "authenticated") throw new Error("expected authenticated");
    expect(result.snapshot.subject_id).toBe("888");
    expect(result.snapshot.permission).toBe("admin");
    expect(result.snapshot.principal_id).toBe(principalIdFor("gitee", "gitee.com", "888"));
    expect(JSON.stringify(result)).not.toContain(GITEE_TOKEN);
  });

  it("fails closed when the permission field is missing", async () => {
    const { registry } = makeRegistry({
      routes: {
        ...giteeRoutes,
        "GET https://gitee.com/api/v5/repos/acme/demo": { body: { id: 321 } },
      },
      configs: [GITEE_CONFIG],
    });
    const result = await registry.authenticate({
      provider: "gitee",
      host: "gitee.com",
      repository_id: "acme/demo",
      principal_id: "principal_any",
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("permission_denied");
    }
  });
});

describe("inspectControlRefProtection", () => {
  const githubAuthenticateRoutes = {
    "POST https://github.com/login/oauth/access_token": {
      body: { access_token: GITHUB_TOKEN, token_type: "bearer" },
    },
    "GET https://api.github.com/user": { body: { id: 4242, login: "alice" } },
    "GET https://api.github.com/repos/Acme/Demo": {
      body: { id: 777, permissions: { admin: true, maintain: true, push: true, pull: true } },
    },
  } satisfies Record<string, Route>;

  const githubProtectedBranch = {
    enforce_admins: { enabled: true },
    restrictions: {
      users: [{ login: "harness-coordinator" }],
      teams: [],
      apps: [],
    },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
  };

  function githubRegistry(protectionRoute: Route) {
    return makeRegistry({
      routes: {
        ...githubAuthenticateRoutes,
        "GET https://api.github.com/repos/Acme/Demo/branches/harness%2Fcontrol/protection":
          protectionRoute,
      },
    });
  }

  async function authenticateGithub(registry: ReturnType<typeof makeRegistry>["registry"]) {
    const result = await registry.authenticate({
      provider: "github",
      host: "github.com",
      repository_id: "Acme/Demo",
      principal_id: "principal_any",
    });
    expect(result.status).toBe("authenticated");
  }

  it("returns protected only when GitHub proves exclusive coordinator writes", async () => {
    const { registry, requests } = githubRegistry({ body: githubProtectedBranch });
    await authenticateGithub(registry);
    const result = await registry.inspectControlRefProtection({
      provider: "github",
      host: "github.com",
      repository_id: "Acme/Demo",
      control_ref: CONTROL_REF,
    });
    expect(result).toEqual({ status: "protected" });
    const protectionRequest = requests.find((request) => request.url.includes("protection"));
    expect(protectionRequest?.headers.authorization).toBe(`Bearer ${GITHUB_TOKEN}`);
  });

  it("fails closed when GitHub protection is absent or incomplete", async () => {
    const variants: Record<string, Route> = {
      not_protected: { status: 404, body: { message: "Branch not protected" } },
      no_restrictions: {
        body: { ...githubProtectedBranch, restrictions: undefined },
      },
      extra_writer: {
        body: {
          ...githubProtectedBranch,
          restrictions: {
            users: [{ login: "harness-coordinator" }, { login: "bob" }],
            teams: [],
            apps: [],
          },
        },
      },
      force_push_allowed: {
        body: { ...githubProtectedBranch, allow_force_pushes: { enabled: true } },
      },
      deletion_allowed: {
        body: { ...githubProtectedBranch, allow_deletions: { enabled: true } },
      },
      admins_bypass: {
        body: { ...githubProtectedBranch, enforce_admins: { enabled: false } },
      },
    };
    for (const [name, route] of Object.entries(variants)) {
      const { registry } = githubRegistry(route);
      await authenticateGithub(registry);
      const result = await registry.inspectControlRefProtection({
        provider: "github",
        host: "github.com",
        repository_id: "Acme/Demo",
        control_ref: CONTROL_REF,
      });
      expect(result.status, name).toBe("unprotected");
      if (result.status === "unprotected") {
        expect(result.failure.code, name).toBe("control_ref_unprotected");
        expect(result.failure.summary, name).not.toContain(GITHUB_TOKEN);
      }
    }
  });

  it("requires an in-memory authenticated session", async () => {
    const { registry } = githubRegistry({ body: githubProtectedBranch });
    const result = await registry.inspectControlRefProtection({
      provider: "github",
      host: "github.com",
      repository_id: "Acme/Demo",
      control_ref: CONTROL_REF,
    });
    expect(result.status).toBe("unprotected");
    if (result.status === "unprotected") {
      expect(result.failure.code).toBe("authentication_required");
    }
  });

  it("never reuses another repository's session token", async () => {
    const { registry, requests } = githubRegistry({ body: githubProtectedBranch });
    await authenticateGithub(registry);
    const result = await registry.inspectControlRefProtection({
      provider: "github",
      host: "github.com",
      repository_id: "Acme/Other",
      control_ref: CONTROL_REF,
    });
    // The Acme/Demo token must not authorise an Acme/Other inspection.
    expect(result.status).toBe("unprotected");
    if (result.status === "unprotected") {
      expect(result.failure.code).toBe("authentication_required");
    }
    expect(
      requests.filter((request) => request.url.includes("Acme/Other")),
      "no request for the foreign repository may be issued",
    ).toEqual([]);
  });

  const gitlabAuthenticateRoutes = {
    "POST https://gitlab.com/oauth/token": {
      body: { access_token: GITLAB_TOKEN, token_type: "Bearer" },
    },
    "GET https://gitlab.com/api/v4/user": { body: { id: 231 } },
    "GET https://gitlab.com/api/v4/projects/acme%2Fteam%2Fdemo": {
      body: { id: 555, permissions: { project_access: { access_level: 40 } } },
    },
  } satisfies Record<string, Route>;

  const gitlabProtectedBranch = {
    name: "harness/control",
    allow_force_push: false,
    push_access_levels: [{ id: 12, access_level: 40, user_id: 9001, group_id: null }],
    merge_access_levels: [{ id: 13, access_level: 40, user_id: null, group_id: null }],
    unprotect_access_levels: [{ id: 14, access_level: 40, user_id: null, group_id: null }],
  };

  function gitlabRegistry(protectionRoute: Route) {
    return makeRegistry({
      routes: {
        ...gitlabAuthenticateRoutes,
        "GET https://gitlab.com/api/v4/projects/acme%2Fteam%2Fdemo/protected_branches/harness%2Fcontrol":
          protectionRoute,
      },
      configs: [GITLAB_CONFIG],
    });
  }

  it("returns protected for a GitLab user-exclusive push rule", async () => {
    const { registry } = gitlabRegistry({ body: gitlabProtectedBranch });
    const auth = await registry.authenticate({
      provider: "gitlab",
      host: "gitlab.com",
      repository_id: "acme/team/demo",
      principal_id: "principal_any",
    });
    expect(auth.status).toBe("authenticated");
    const result = await registry.inspectControlRefProtection({
      provider: "gitlab",
      host: "gitlab.com",
      repository_id: "acme/team/demo",
      control_ref: CONTROL_REF,
    });
    expect(result).toEqual({ status: "protected" });
  });

  it("fails closed when GitLab cannot prove exclusive writer rules", async () => {
    const variants: Record<string, Route> = {
      not_protected: { status: 404, body: { message: "Not found" } },
      role_based_push: {
        body: {
          ...gitlabProtectedBranch,
          push_access_levels: [{ id: 12, access_level: 40, user_id: null, group_id: null }],
        },
      },
      extra_developer_push: {
        body: {
          ...gitlabProtectedBranch,
          push_access_levels: [
            { id: 12, access_level: 40, user_id: 9001, group_id: null },
            { id: 15, access_level: 30, user_id: null, group_id: null },
          ],
        },
      },
      force_push_allowed: { body: { ...gitlabProtectedBranch, allow_force_push: true } },
      missing_force_push_field: {
        body: {
          name: "harness/control",
          push_access_levels: gitlabProtectedBranch.push_access_levels,
        },
      },
    };
    for (const [name, route] of Object.entries(variants)) {
      const { registry } = gitlabRegistry(route);
      const auth = await registry.authenticate({
        provider: "gitlab",
        host: "gitlab.com",
        repository_id: "acme/team/demo",
        principal_id: "principal_any",
      });
      expect(auth.status, name).toBe("authenticated");
      const result = await registry.inspectControlRefProtection({
        provider: "gitlab",
        host: "gitlab.com",
        repository_id: "acme/team/demo",
        control_ref: CONTROL_REF,
      });
      expect(result.status, name).toBe("unprotected");
      if (result.status === "unprotected") {
        expect(result.failure.code, name).toBe("control_ref_unprotected");
      }
    }
  });

  const giteeAuthenticateRoutes = {
    "POST https://gitee.com/oauth/token": {
      body: { access_token: GITEE_TOKEN, token_type: "bearer" },
    },
    "GET https://gitee.com/api/v5/user": { body: { id: 888 } },
    "GET https://gitee.com/api/v5/repos/acme/demo": { body: { id: 321, permission: "admin" } },
  } satisfies Record<string, Route>;

  function giteeRegistry(extraRoutes: Record<string, Route>) {
    return makeRegistry({
      routes: { ...giteeAuthenticateRoutes, ...extraRoutes },
      configs: [GITEE_CONFIG],
    });
  }

  it("returns protected for a Gitee protected branch with an exclusive pusher", async () => {
    const { registry } = giteeRegistry({
      "GET https://gitee.com/api/v5/repos/acme/demo/branches/harness%2Fcontrol": {
        body: { name: "harness/control", protected: true },
      },
      "GET https://gitee.com/api/v5/repos/acme/demo/branches/harness%2Fcontrol/protection": {
        body: {
          wildcard: "harness/control",
          pusher: "harness-coordinator",
          merger: "harness-coordinator",
        },
      },
    });
    const auth = await registry.authenticate({
      provider: "gitee",
      host: "gitee.com",
      repository_id: "acme/demo",
      principal_id: "principal_any",
    });
    expect(auth.status).toBe("authenticated");
    const result = await registry.inspectControlRefProtection({
      provider: "gitee",
      host: "gitee.com",
      repository_id: "acme/demo",
      control_ref: CONTROL_REF,
    });
    expect(result).toEqual({ status: "protected" });
  });

  it("fails closed when Gitee protection is absent, shared or not exclusive", async () => {
    const variants: Record<string, Record<string, Route>> = {
      branch_unprotected: {
        "GET https://gitee.com/api/v5/repos/acme/demo/branches/harness%2Fcontrol": {
          body: { name: "harness/control", protected: false },
        },
        "GET https://gitee.com/api/v5/repos/acme/demo/branches/harness%2Fcontrol/protection": {
          body: { wildcard: "harness/control", pusher: "harness-coordinator" },
        },
      },
      shared_pusher_role: {
        "GET https://gitee.com/api/v5/repos/acme/demo/branches/harness%2Fcontrol": {
          body: { name: "harness/control", protected: true },
        },
        "GET https://gitee.com/api/v5/repos/acme/demo/branches/harness%2Fcontrol/protection": {
          body: { wildcard: "harness/control", pusher: "administrators" },
        },
      },
      protection_missing: {
        "GET https://gitee.com/api/v5/repos/acme/demo/branches/harness%2Fcontrol": {
          body: { name: "harness/control", protected: true },
        },
        "GET https://gitee.com/api/v5/repos/acme/demo/branches/harness%2Fcontrol/protection": {
          status: 404,
          body: { message: "Not Found" },
        },
      },
    };
    for (const [name, routes] of Object.entries(variants)) {
      const { registry } = giteeRegistry(routes);
      const auth = await registry.authenticate({
        provider: "gitee",
        host: "gitee.com",
        repository_id: "acme/demo",
        principal_id: "principal_any",
      });
      expect(auth.status, name).toBe("authenticated");
      const result = await registry.inspectControlRefProtection({
        provider: "gitee",
        host: "gitee.com",
        repository_id: "acme/demo",
        control_ref: CONTROL_REF,
      });
      expect(result.status, name).toBe("unprotected");
      if (result.status === "unprotected") {
        expect(result.failure.code, name).toBe("control_ref_unprotected");
        expect(result.failure.summary, name).not.toContain(GITEE_TOKEN);
      }
    }
  });
});
