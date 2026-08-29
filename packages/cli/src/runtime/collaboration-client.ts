import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ulid, type CollaborationConnectionRecord } from "@universal-harness-internal/core";

/**
 * Local CLI client state for remote collaboration (plan M3 Task 7). The file
 * under `.harness/cache/` is a disposable locator cache, never an authority:
 * it remembers the active connection, this client's instance id and the lease
 * fencing tokens it holds so reconnects stay idempotent, while the
 * Coordinator re-verifies every command against the authoritative Git state.
 * `cache/` is already excluded by the managed .gitignore.
 */
export interface CollaborationClientLease {
  readonly lease_id: string;
  readonly fencing_token: number;
}

export interface CollaborationClientState {
  readonly version: 1;
  readonly client_instance_id: string;
  readonly connection?: CollaborationConnectionRecord;
  /**
   * Bearer credential the Coordinator issued at connect; it authenticates
   * this client's later commands and queries. This is a Coordinator session
   * credential only — the §17.1 "never persisted" rule covers the provider
   * access token, which never crosses the transport boundary. The cache file
   * is written with mode 0600 and stays under the gitignored `cache/`.
   */
  readonly session_credential?: string;
  readonly leases: Record<string, CollaborationClientLease>;
  readonly integrations: Record<string, { readonly expected_target_commit: string }>;
}

const STATE_FILE = "collaboration-client.json";

export function collaborationClientStatePath(projectRoot: string): string {
  return join(projectRoot, ".harness", "cache", STATE_FILE);
}

/** Canonical on-disk rendering of the client state (indented JSON + newline). */
export function serializeCollaborationClientState(state: CollaborationClientState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/** Missing or unreadable cache degrades to no state; the cache is disposable. */
export function readCollaborationClientState(
  projectRoot: string,
): CollaborationClientState | undefined {
  const path = collaborationClientStatePath(projectRoot);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CollaborationClientState>;
    if (parsed.version !== 1 || typeof parsed.client_instance_id !== "string") return undefined;
    return {
      version: 1,
      client_instance_id: parsed.client_instance_id,
      ...(parsed.connection === undefined ? {} : { connection: parsed.connection }),
      ...(parsed.session_credential === undefined
        ? {}
        : { session_credential: parsed.session_credential }),
      leases: parsed.leases ?? {},
      integrations: parsed.integrations ?? {},
    };
  } catch {
    return undefined;
  }
}

/**
 * Atomic write: a torn cache must never read back as a half-written record.
 * Mode 0600: the file carries the Coordinator session credential, so other
 * local users must not read it.
 */
export function writeCollaborationClientState(
  projectRoot: string,
  state: CollaborationClientState,
): void {
  const path = collaborationClientStatePath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.tmp-${process.pid}`;
  writeFileSync(staging, serializeCollaborationClientState(state), {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(staging, path);
}

/** Fresh in-memory state with a newly minted client instance id; not persisted. */
export function mintCollaborationClientState(): CollaborationClientState {
  return {
    version: 1,
    client_instance_id: `instance_${ulid()}`,
    leases: {},
    integrations: {},
  };
}

/** Read the state, minting and persisting this client's instance id once. */
export function collaborationClientState(projectRoot: string): CollaborationClientState {
  const existing = readCollaborationClientState(projectRoot);
  if (existing !== undefined) return existing;
  const fresh = mintCollaborationClientState();
  writeCollaborationClientState(projectRoot, fresh);
  return fresh;
}

/** The active connection locator, or undefined when this client is local-only. */
export function activeClientConnection(
  projectRoot: string,
): CollaborationConnectionRecord | undefined {
  const connection = readCollaborationClientState(projectRoot)?.connection;
  return connection?.status === "active" ? connection : undefined;
}
