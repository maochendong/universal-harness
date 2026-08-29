import type { CollaborationProvider } from "@universal-harness-internal/core";

/**
 * Pure Git Remote normalization (spec §8). A Remote only enters the
 * collaboration flow in canonical, credential-free form: the SCP-style SSH
 * shorthand becomes an explicit `ssh://` URL, hosts are lowercased for
 * provider selection, and any userinfo on an HTTP(S) remote, query, fragment
 * or ambiguous repository path fails closed. No I/O lives here.
 */

export const REMOTE_DISCOVERY_ERROR_CODES = [
  "remote_contains_credentials",
  "unsupported_remote",
  "invalid_remote",
] as const;
export type RemoteDiscoveryErrorCode = (typeof REMOTE_DISCOVERY_ERROR_CODES)[number];

export class RemoteDiscoveryError extends Error {
  readonly code: RemoteDiscoveryErrorCode;

  constructor(code: RemoteDiscoveryErrorCode, summary: string) {
    super(summary);
    this.name = "RemoteDiscoveryError";
    this.code = code;
  }
}

/** Well-known SaaS hosts; self-hosted hosts come from Adapter configuration. */
export const DEFAULT_PLATFORM_HOSTS: Readonly<Record<string, CollaborationProvider>> = {
  "github.com": "github",
  "gitlab.com": "gitlab",
  "gitee.com": "gitee",
};

export interface NormalizedGitRemote {
  readonly provider: CollaborationProvider;
  readonly host: string;
  readonly repository_path: string;
  readonly canonical_remote: string;
}

const SCP_LIKE_REMOTE = /^([^@/:]+)@([^:/]+):(.+)$/;

function normalizeRepositoryPath(rawPath: string): string {
  let path = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;
  while (path.endsWith("/")) path = path.slice(0, -1);
  if (path.endsWith(".git")) path = path.slice(0, -".git".length);
  if (path === "") {
    throw new RemoteDiscoveryError("invalid_remote", "remote carries no repository path");
  }
  const segments = path.split("/");
  if (segments.length < 2 || segments.some((segment) => segment === "")) {
    throw new RemoteDiscoveryError(
      "invalid_remote",
      "remote repository path must be <owner>/<repo> without empty segments",
    );
  }
  return path;
}

function providerForHost(
  host: string,
  hosts: Readonly<Record<string, CollaborationProvider>>,
): CollaborationProvider {
  const provider = hosts[host];
  if (provider === undefined) {
    throw new RemoteDiscoveryError(
      "unsupported_remote",
      `no platform adapter is configured for host ${host}`,
    );
  }
  return provider;
}

/**
 * Normalize an SSH (SCP-like or `ssh://`) or HTTPS Git Remote. The returned
 * `repository_path` keeps the platform's casing while `host` is canonical
 * lowercase; `canonical_remote` is rebuilt from the normalized parts (no
 * `.git` suffix, no trailing slash), so equivalent spellings of one Remote
 * share the same canonical form and digest.
 */
export function normalizeGitRemote(
  remote: string,
  hosts: Readonly<Record<string, CollaborationProvider>> = DEFAULT_PLATFORM_HOSTS,
): NormalizedGitRemote {
  const scp = SCP_LIKE_REMOTE.exec(remote);
  if (scp) {
    const [, user, rawHost, path] = scp;
    if (user === undefined || rawHost === undefined || path === undefined || path === "") {
      throw new RemoteDiscoveryError(
        "invalid_remote",
        "remote is not a complete SCP-style SSH remote",
      );
    }
    const host = rawHost.toLowerCase();
    const provider = providerForHost(host, hosts);
    const repositoryPath = normalizeRepositoryPath(path);
    return {
      provider,
      host,
      repository_path: repositoryPath,
      canonical_remote: `ssh://${user}@${host}/${repositoryPath}`,
    };
  }

  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    throw new RemoteDiscoveryError("invalid_remote", "remote is neither SCP-style SSH nor a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "ssh:") {
    throw new RemoteDiscoveryError(
      "invalid_remote",
      `remote protocol ${url.protocol} is not https or ssh`,
    );
  }
  if (url.protocol === "https:" && (url.username !== "" || url.password !== "")) {
    throw new RemoteDiscoveryError(
      "remote_contains_credentials",
      "HTTPS remote carries userinfo; credentials must come from the host secret mechanism",
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new RemoteDiscoveryError("invalid_remote", "remote must not carry query or fragment");
  }
  const host = url.hostname.toLowerCase();
  const provider = providerForHost(host, hosts);
  const repositoryPath = normalizeRepositoryPath(url.pathname);
  const userinfo = url.protocol === "ssh:" && url.username !== "" ? `${url.username}@` : "";
  const port = url.port === "" ? "" : `:${url.port}`;
  return {
    provider,
    host,
    repository_path: repositoryPath,
    canonical_remote: `${url.protocol}//${userinfo}${host}${port}/${repositoryPath}`,
  };
}
