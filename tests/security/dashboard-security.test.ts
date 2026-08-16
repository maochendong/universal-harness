import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "../../adapters/vcs-git/src/index.js";
import {
  GRAPH_DATABASE_RELATIVE_PATH,
  harnessRootFor,
  resolveHarnessPath,
} from "../../packages/core/src/index.js";
import {
  DashboardSessionStore,
  startDashboardServer,
  type DashboardServer,
  type DashboardWriteApi,
} from "../../packages/dashboard/src/index.js";
import { rebuildGraphCache } from "../../packages/graph/src/index.js";
import { createNewProject } from "../../packages/runtime/src/index.js";

const roots: string[] = [];
const servers: DashboardServer[] = [];

async function managedProject(): Promise<string> {
  const parent = mkdtempSync(join(tmpdir(), "harness-dashboard-security-"));
  roots.push(parent);
  const created = await createNewProject(
    { parentDirectory: parent, name: "secure-dashboard", intent: "inspect safely" },
    { vcs: createGitVcsAdapter() },
  );
  if (!created.ok) throw new Error(created.error.message);
  rebuildGraphCache({
    projectRoot: created.value.projectRoot,
    databasePath: resolveHarnessPath(
      harnessRootFor(created.value.projectRoot),
      GRAPH_DATABASE_RELATIVE_PATH,
    ),
  }).database.close();
  return created.value.projectRoot;
}

function cookieOf(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (value === null) throw new Error("session cookie missing");
  return value.split(";", 1)[0] ?? "";
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Dashboard security boundary", () => {
  it("rejects non-loopback binding before opening a listener", async () => {
    await expect(
      startDashboardServer({ projectRoot: "/not/read", host: "0.0.0.0" }),
    ).rejects.toMatchObject({ status: 400, code: "non_loopback_host" });
  });

  it("uses a one-time bootstrap, strict session headers and no CORS", async () => {
    const server = await startDashboardServer({ projectRoot: await managedProject() });
    servers.push(server);
    const anonymous = await fetch(`${server.origin}/`, { redirect: "manual" });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("content-security-policy")).not.toContain("unsafe-eval");
    expect(anonymous.headers.get("x-frame-options")).toBe("DENY");
    expect(anonymous.headers.get("access-control-allow-origin")).toBeNull();

    const exchange = await fetch(server.bootstrapUrl, { redirect: "manual" });
    expect(exchange.status).toBe(303);
    expect(exchange.headers.get("location")).toBe("/");
    const setCookie = exchange.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(exchange.headers.get("location")).not.toContain("token");

    const replay = await fetch(server.bootstrapUrl, { redirect: "manual" });
    expect(replay.status).toBe(401);
    await expect(replay.json()).resolves.toMatchObject({ code: "invalid_bootstrap_token" });

    const cookie = cookieOf(exchange);
    const page = await fetch(`${server.origin}/`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects forged Origin, missing CSRF, XSS identifiers and oversized targets", async () => {
    let writes = 0;
    const writeApi: DashboardWriteApi = {
      decideApproval: () => {
        writes += 1;
        return Promise.resolve({ ok: true });
      },
      resumeWorkflow: () => Promise.resolve({ ok: true }),
      resolveFindingGroup: () => Promise.resolve({ ok: true }),
    };
    const server = await startDashboardServer({
      projectRoot: await managedProject(),
      writeApi,
    });
    servers.push(server);
    const exchange = await fetch(server.bootstrapUrl, { redirect: "manual" });
    const cookie = cookieOf(exchange);

    const forged = await fetch(`${server.origin}/api/v1/project`, {
      headers: { cookie, origin: "https://attacker.invalid" },
    });
    expect(forged.status).toBe(403);
    await expect(forged.json()).resolves.toMatchObject({ code: "origin_mismatch" });

    const missingCsrf = await fetch(
      `${server.origin}/api/v1/approvals/approval_request_01/decision`,
      {
        method: "POST",
        headers: { cookie, origin: server.origin, "content-type": "application/json" },
        body: JSON.stringify({
          decision: "approve",
          expected_digest: "a".repeat(64),
          actor: "human:security-test",
        }),
      },
    );
    expect(missingCsrf.status).toBe(403);
    await expect(missingCsrf.json()).resolves.toMatchObject({ code: "csrf_mismatch" });
    expect(writes).toBe(0);

    const xss = await fetch(
      `${server.origin}/api/v1/graph/neighborhood/${encodeURIComponent("<script>alert(1)</script>")}`,
      { headers: { cookie } },
    );
    expect(xss.status).toBe(400);
    const xssProblem = JSON.stringify(await xss.json());
    expect(xssProblem).not.toContain("<script>");

    const oversized = await fetch(`${server.origin}/api/v1/project?x=${"a".repeat(8_200)}`, {
      headers: { cookie },
    });
    expect(oversized.status).toBe(414);
    await expect(oversized.json()).resolves.toMatchObject({ code: "request_target_too_large" });
  });

  it("expires process-local sessions without accepting a stale cookie", () => {
    let now = 1_000;
    const store = new DashboardSessionStore({ now: () => now, ttlMs: 100 });
    const exchanged = store.exchange(store.bootstrapToken);
    const request = { headers: { cookie: exchanged.cookie } } as never;
    expect(store.authenticate(request).id).toBe(exchanged.session.id);
    now = 1_101;
    expect(() => store.authenticate(request)).toThrowError(/valid Dashboard session/u);
  });
});
