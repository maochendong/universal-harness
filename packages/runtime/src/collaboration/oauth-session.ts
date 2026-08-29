import { createHash, randomBytes } from "node:crypto";

import { collaborationFailure, type CollaborationFailure } from "./errors.js";

/**
 * In-memory OAuth authorization session state (spec §17.1). State and the
 * PKCE verifier are generated with `randomBytes`, every state is consumed
 * exactly once (a mismatched consume burns it), and sessions expire. Nothing
 * here is ever persisted or logged.
 */

export const OAUTH_SESSION_TTL_MS = 10 * 60 * 1000;

export interface OAuthSession {
  readonly state: string;
  readonly code_verifier: string;
  readonly redirect_uri: string;
  readonly expires_at: string;
}

export type ConsumeOAuthSessionResult =
  | { readonly status: "ok"; readonly session: OAuthSession }
  | { readonly status: "failed"; readonly failure: CollaborationFailure };

export interface OAuthSessionStore {
  begin(redirectUri: string): OAuthSession;
  consume(state: string, redirectUri: string): ConsumeOAuthSessionResult;
}

export interface OAuthSessionStoreOptions {
  readonly now?: () => string;
  readonly ttl_ms?: number;
}

/** RFC 7636 S256 code challenge: base64url(SHA-256(verifier)). */
export function oauthCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "utf8").digest("base64url");
}

function authenticationRequired(summary: string): ConsumeOAuthSessionResult {
  return { status: "failed", failure: collaborationFailure("authentication_required", summary) };
}

export function createOAuthSessionStore(options: OAuthSessionStoreOptions = {}): OAuthSessionStore {
  const now = options.now ?? (() => new Date().toISOString());
  const ttl = options.ttl_ms ?? OAUTH_SESSION_TTL_MS;
  const sessions = new Map<string, OAuthSession>();
  return {
    begin(redirectUri) {
      const session: OAuthSession = {
        state: randomBytes(32).toString("hex"),
        code_verifier: randomBytes(32).toString("base64url"),
        redirect_uri: redirectUri,
        expires_at: new Date(Date.parse(now()) + ttl).toISOString(),
      };
      sessions.set(session.state, session);
      return session;
    },
    consume(state, redirectUri) {
      const session = sessions.get(state);
      // Every consume attempt burns the state: replay, expiry and redirect
      // mismatch all leave nothing behind to retry with.
      sessions.delete(state);
      if (session === undefined) {
        return authenticationRequired("unknown or already consumed oauth state");
      }
      if (session.expires_at <= now()) {
        return authenticationRequired("oauth state expired");
      }
      if (session.redirect_uri !== redirectUri) {
        return authenticationRequired("oauth callback redirect uri mismatch");
      }
      return { status: "ok", session };
    },
  };
}
