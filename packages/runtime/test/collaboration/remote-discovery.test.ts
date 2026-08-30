import { describe, expect, it } from "vitest";

import {
  createPlatformIdentityRegistry,
  type PlatformAdapterConfig,
  type PlatformFetch,
} from "../../src/collaboration/platform-adapters.js";
import {
  normalizeGitRemote,
  RemoteDiscoveryError,
} from "../../src/collaboration/remote-discovery.js";

const GITHUB_CONFIG: PlatformAdapterConfig = {
  provider: "github",
  host: "github.com",
  api_base_url: "https://api.github.com",
  authorize_url: "https://github.com/login/oauth/authorize",
  token_url: "https://github.com/login/oauth/access_token",
  client_id: "client_github",
  redirect_uri: "https://harness.example.com/oauth/callback",
  coordinator_identity: "harness-coordinator",
};

const unreachableFetch: PlatformFetch = () => {
  throw new Error("discover must not perform network I/O");
};

function expectThrownCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RemoteDiscoveryError);
    expect((error as RemoteDiscoveryError).code).toBe(code);
    return;
  }
  expect.unreachable(`expected a RemoteDiscoveryError with code ${code}`);
}

function discoverRegistry() {
  return createPlatformIdentityRegistry([GITHUB_CONFIG], {
    fetch: unreachableFetch,
    sessions: {
      begin: () => {
        throw new Error("not used by discover");
      },
      consume: () => {
        throw new Error("not used by discover");
      },
    },
    authorize: () => Promise.reject(new Error("not used by discover")),
  });
}

describe("normalizeGitRemote", () => {
  it("normalizes an SCP-style GitHub SSH remote", () => {
    expect(normalizeGitRemote("git@github.com:Acme/Demo.git")).toEqual({
      provider: "github",
      host: "github.com",
      repository_path: "Acme/Demo",
      canonical_remote: "ssh://github.com/Acme/Demo",
    });
  });

  it("normalizes an HTTPS remote and keeps it credential-free", () => {
    expect(normalizeGitRemote("https://github.com/acme/demo.git")).toEqual({
      provider: "github",
      host: "github.com",
      repository_path: "acme/demo",
      canonical_remote: "https://github.com/acme/demo",
    });
  });

  it("gives equivalent remote spellings the same canonical form", () => {
    const variants = [
      "git@github.com:Acme/Demo.git",
      "git@github.com:Acme/Demo",
      "ssh://git@github.com/Acme/Demo.git",
      "ssh://git@github.com/Acme/Demo",
      "ssh://git@github.com/Acme/Demo/",
    ];
    const canonical = variants.map((remote) => normalizeGitRemote(remote).canonical_remote);
    for (const value of canonical) {
      expect(value).toBe("ssh://github.com/Acme/Demo");
    }
    expect(normalizeGitRemote("https://github.com/acme/demo.git/").canonical_remote).toBe(
      "https://github.com/acme/demo",
    );
  });

  it("strips SSH userinfo so different deploy users share one canonical remote", () => {
    const variants = [
      "git@github.com:Acme/Demo.git",
      "deploy@github.com:Acme/Demo.git",
      "ssh://git@github.com/Acme/Demo.git",
      "ssh://deploy@github.com/Acme/Demo.git",
    ];
    const canonical = variants.map((remote) => normalizeGitRemote(remote).canonical_remote);
    for (const value of canonical) {
      // The canonical remote never carries userinfo (plan Global Constraint 23).
      expect(value).toBe("ssh://github.com/Acme/Demo");
      expect(value).not.toContain("@");
    }
  });

  it("rejects HTTPS remotes carrying credentials", () => {
    expectThrownCode(
      () => normalizeGitRemote("https://token@github.com/acme/demo.git"),
      "remote_contains_credentials",
    );
    expectThrownCode(
      () => normalizeGitRemote("https://user:pass@github.com/acme/demo.git"),
      "remote_contains_credentials",
    );
    expect(() => normalizeGitRemote("https://token@github.com/acme/demo.git")).toThrowError(
      RemoteDiscoveryError,
    );
  });

  it("keeps GitLab subgroup segments in the repository path", () => {
    expect(normalizeGitRemote("git@gitlab.com:Acme/Team/Demo.git")).toEqual({
      provider: "gitlab",
      host: "gitlab.com",
      repository_path: "Acme/Team/Demo",
      canonical_remote: "ssh://gitlab.com/Acme/Team/Demo",
    });
  });

  it("normalizes a Gitee owner/repo remote without a .git suffix", () => {
    expect(normalizeGitRemote("https://gitee.com/acme/demo")).toEqual({
      provider: "gitee",
      host: "gitee.com",
      repository_path: "acme/demo",
      canonical_remote: "https://gitee.com/acme/demo",
    });
  });

  it("lowercases mixed-case hosts for provider selection", () => {
    expect(normalizeGitRemote("git@GitHub.COM:Acme/Demo.git")).toEqual({
      provider: "github",
      host: "github.com",
      repository_path: "Acme/Demo",
      canonical_remote: "ssh://github.com/Acme/Demo",
    });
    expect(normalizeGitRemote("https://GITLAB.com/acme/demo.git").host).toBe("gitlab.com");
  });

  it("rejects unsupported hosts", () => {
    expectThrownCode(
      () => normalizeGitRemote("git@example.com:acme/demo.git"),
      "unsupported_remote",
    );
  });

  it("supports configured self-hosted hosts", () => {
    expect(
      normalizeGitRemote("git@gitlab.acme.internal:team/demo.git", {
        "gitlab.acme.internal": "gitlab",
      }),
    ).toEqual({
      provider: "gitlab",
      host: "gitlab.acme.internal",
      repository_path: "team/demo",
      canonical_remote: "ssh://gitlab.acme.internal/team/demo",
    });
  });

  it("rejects ambiguous or malformed remotes", () => {
    for (const remote of [
      "https://github.com/demo.git",
      "https://github.com/",
      "git@github.com:",
      "not a remote at all",
      "https://github.com/acme//demo.git",
      "https://github.com/acme/demo.git?token=1",
      "https://github.com/acme/demo.git#frag",
    ]) {
      expectThrownCode(() => normalizeGitRemote(remote), "invalid_remote");
    }
  });
});

describe("registry discover", () => {
  it("resolves a credential-free remote into a RemoteIdentity with a digest", async () => {
    const registry = discoverRegistry();
    const result = await registry.discover("git@github.com:Acme/Demo.git");
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.identity.provider).toBe("github");
      expect(result.identity.host).toBe("github.com");
      expect(result.identity.repository_id).toBe("Acme/Demo");
      expect(result.identity.canonical_remote).toBe("ssh://github.com/Acme/Demo");
      expect(result.identity.canonical_remote_digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("distinguishes a drifted remote identity by repository and digest", async () => {
    const registry = discoverRegistry();
    const original = await registry.discover("git@github.com:Acme/Demo.git");
    const driftedRepo = await registry.discover("git@github.com:Acme/Other.git");
    const driftedTransport = await registry.discover("https://github.com/Acme/Demo.git");
    if (
      original.status !== "resolved" ||
      driftedRepo.status !== "resolved" ||
      driftedTransport.status !== "resolved"
    ) {
      throw new Error("expected all discoveries to resolve");
    }
    expect(driftedRepo.identity.repository_id).not.toBe(original.identity.repository_id);
    expect(driftedRepo.identity.canonical_remote_digest).not.toBe(
      original.identity.canonical_remote_digest,
    );
    // A transport-only drift keeps the repository identity but moves the digest.
    expect(driftedTransport.identity.repository_id).toBe(original.identity.repository_id);
    expect(driftedTransport.identity.canonical_remote_digest).not.toBe(
      original.identity.canonical_remote_digest,
    );
  });

  it("gives SSH user variants the same identity and digest", async () => {
    const registry = discoverRegistry();
    const scp = await registry.discover("git@github.com:Acme/Demo.git");
    const otherUser = await registry.discover("ssh://deploy@github.com/Acme/Demo.git");
    if (scp.status !== "resolved" || otherUser.status !== "resolved") {
      throw new Error("expected both discoveries to resolve");
    }
    // Userinfo never enters the authoritative identity (plan Global Constraint 23).
    expect(otherUser.identity.canonical_remote).toBe("ssh://github.com/Acme/Demo");
    expect(otherUser.identity.canonical_remote_digest).toBe(scp.identity.canonical_remote_digest);
  });

  it("fails closed on unsupported hosts and credential-bearing remotes", async () => {
    const registry = discoverRegistry();
    const unsupported = await registry.discover("git@example.com:acme/demo.git");
    expect(unsupported).toEqual({
      status: "failed",
      failure: expect.objectContaining({ code: "unsupported_remote" }),
    });
    const credentialed = await registry.discover("https://token@github.com/acme/demo.git");
    expect(credentialed.status).toBe("failed");
    if (credentialed.status === "failed") {
      expect(credentialed.failure.code).toBe("unsupported_remote");
      expect(credentialed.failure.summary).not.toContain("token@");
    }
  });
});
