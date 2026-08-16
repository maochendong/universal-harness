import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { DashboardProblem } from "./problem.js";

const SESSION_COOKIE = "harness_session";
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface DashboardSession {
  readonly id: string;
  readonly csrfToken: string;
  readonly expiresAt: string;
}

export interface SessionExchange {
  readonly session: DashboardSession;
  readonly cookie: string;
}

function secret(): string {
  return randomBytes(32).toString("hex");
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookiesOf(request: IncomingMessage): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name !== "" && value !== "") result.set(name, value);
  }
  return result;
}

/** In-memory, process-local browser sessions for the loopback Dashboard. */
export class DashboardSessionStore {
  readonly bootstrapToken = secret();
  private bootstrapConsumed = false;
  private readonly sessions = new Map<string, DashboardSession>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(options: { readonly now?: () => number; readonly ttlMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  }

  exchange(token: string): SessionExchange {
    if (this.bootstrapConsumed || !sameSecret(token, this.bootstrapToken)) {
      throw new DashboardProblem(
        401,
        "invalid_bootstrap_token",
        "Unauthorized",
        "the Dashboard bootstrap token is invalid or has already been consumed",
      );
    }
    this.bootstrapConsumed = true;
    const expires = this.now() + this.ttlMs;
    const session: DashboardSession = {
      id: secret(),
      csrfToken: secret(),
      expiresAt: new Date(expires).toISOString(),
    };
    this.sessions.set(session.id, session);
    return {
      session,
      cookie: `${SESSION_COOKIE}=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${String(Math.floor(this.ttlMs / 1000))}`,
    };
  }

  authenticate(request: IncomingMessage): DashboardSession {
    const id = cookiesOf(request).get(SESSION_COOKIE);
    const session = id === undefined ? undefined : this.sessions.get(id);
    if (session === undefined || Date.parse(session.expiresAt) <= this.now()) {
      if (id !== undefined) this.sessions.delete(id);
      throw new DashboardProblem(
        401,
        "authentication_required",
        "Unauthorized",
        "a valid Dashboard session is required",
      );
    }
    return session;
  }

  clear(): void {
    this.sessions.clear();
  }
}
