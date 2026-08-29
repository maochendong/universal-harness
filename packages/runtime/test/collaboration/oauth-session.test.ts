import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createOAuthSessionStore,
  OAUTH_SESSION_TTL_MS,
  oauthCodeChallenge,
} from "../../src/collaboration/oauth-session.js";

const REDIRECT = "https://harness.example.com/oauth/callback";
const NOW = "2026-08-29T00:00:00.000Z";

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

describe("oauthCodeChallenge", () => {
  it("matches the RFC 7636 appendix B test vector", () => {
    expect(oauthCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("is the base64url SHA-256 of the verifier", () => {
    const verifier = "fixture-verifier";
    expect(oauthCodeChallenge(verifier)).toBe(
      base64url(createHash("sha256").update(verifier, "utf8").digest()),
    );
  });
});

describe("OAuthSessionStore", () => {
  it("generates high-entropy state and verifier with an expiry", () => {
    const store = createOAuthSessionStore({ now: () => NOW });
    const first = store.begin(REDIRECT);
    const second = store.begin(REDIRECT);
    expect(first.state).toMatch(/^[0-9a-f]{64}$/);
    expect(first.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.redirect_uri).toBe(REDIRECT);
    expect(first.expires_at).toBe(new Date(Date.parse(NOW) + OAUTH_SESSION_TTL_MS).toISOString());
    expect(second.state).not.toBe(first.state);
    expect(second.code_verifier).not.toBe(first.code_verifier);
  });

  it("consumes a live state exactly once", () => {
    const store = createOAuthSessionStore({ now: () => NOW });
    const session = store.begin(REDIRECT);
    const consumed = store.consume(session.state, REDIRECT);
    expect(consumed).toEqual({ status: "ok", session });
    const replay = store.consume(session.state, REDIRECT);
    expect(replay.status).toBe("failed");
    if (replay.status === "failed") {
      expect(replay.failure.code).toBe("authentication_required");
    }
  });

  it("rejects unknown state", () => {
    const store = createOAuthSessionStore({ now: () => NOW });
    const outcome = store.consume("0".repeat(64), REDIRECT);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.failure.code).toBe("authentication_required");
    }
  });

  it("rejects expired state", () => {
    let now = NOW;
    const store = createOAuthSessionStore({ now: () => now });
    const session = store.begin(REDIRECT);
    now = new Date(Date.parse(NOW) + OAUTH_SESSION_TTL_MS).toISOString();
    const outcome = store.consume(session.state, REDIRECT);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.failure.code).toBe("authentication_required");
    }
  });

  it("requires the exact redirect URI and burns the state on mismatch", () => {
    const store = createOAuthSessionStore({ now: () => NOW });
    const session = store.begin(REDIRECT);
    const mismatched = store.consume(session.state, "https://evil.example.com/oauth/callback");
    expect(mismatched.status).toBe("failed");
    if (mismatched.status === "failed") {
      expect(mismatched.failure.code).toBe("authentication_required");
      expect(mismatched.failure.summary).not.toContain(session.code_verifier);
    }
    // The mismatched consume destroyed the state: it cannot be retried.
    expect(store.consume(session.state, REDIRECT).status).toBe("failed");
  });
});
