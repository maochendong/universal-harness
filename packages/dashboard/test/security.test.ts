import { afterEach, describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";
import { createNewProject } from "@universal-harness-internal/runtime";

import { startDashboardServer, type DashboardServer } from "../src/index.js";

const servers: DashboardServer[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  const { rmSync } = await import("node:fs");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function project(): Promise<string> {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const parent = mkdtempSync(join(tmpdir(), "harness-dashboard-security-"));
  roots.push(parent);
  const created = await createNewProject(
    { parentDirectory: parent, name: "dashboard-security", intent: "secure local inspection" },
    { vcs: createGitVcsAdapter() },
  );
  if (!created.ok) throw new Error(created.error.message);
  return created.value.projectRoot;
}

describe("Dashboard security", () => {
  it("rejects non-loopback binds", async () => {
    await expect(
      startDashboardServer({ projectRoot: await project(), host: "0.0.0.0" }),
    ).rejects.toMatchObject({ code: "non_loopback_host" });
  });

  it("exchanges the URL token once, binds CSRF to the session, and sets defensive headers", async () => {
    const server = await startDashboardServer({ projectRoot: await project() });
    servers.push(server);

    const exchange = await fetch(server.bootstrapUrl, { redirect: "manual" });
    expect(exchange.status).toBe(303);
    expect(exchange.headers.get("location")).toBe("/");
    const setCookie = exchange.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    const cookie = setCookie.split(";", 1)[0] ?? "";

    const replay = await fetch(server.bootstrapUrl, { redirect: "manual" });
    expect(replay.status).toBe(401);

    const session = await fetch(`${server.origin}/api/v1/session`, { headers: { cookie } });
    expect(session.status).toBe(200);
    expect(session.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(session.headers.get("x-content-type-options")).toBe("nosniff");
    expect(session.headers.get("x-frame-options")).toBe("DENY");
    expect(session.headers.get("access-control-allow-origin")).toBeNull();
    const first = (await session.json()) as { data: { csrf_token: string } };
    expect(first.data.csrf_token).toMatch(/^[a-f0-9]{64}$/u);

    const other = await fetch(`${server.origin}/api/v1/session`);
    expect(other.status).toBe(401);
    await expect(other.json()).resolves.toMatchObject({ code: "authentication_required" });
  });

  it("rejects traversal, encoded separators, XSS identifiers, and cross-origin requests", async () => {
    const server = await startDashboardServer({ projectRoot: await project() });
    servers.push(server);
    const exchange = await fetch(server.bootstrapUrl, { redirect: "manual" });
    const cookie = (exchange.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";

    for (const path of [
      "/api/v1/graph/neighborhood/%2e%2e%2fsecret",
      "/api/v1/graph/neighborhood/%3Cscript%3E",
      "/api/v1/graph/path?from=node_ok&to=..%2Fsecret",
    ]) {
      const response = await fetch(`${server.origin}${path}`, { headers: { cookie } });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: "invalid_identifier" });
    }

    const xssQuery = await fetch(`${server.origin}/api/v1/graph/nodes?type=%3Cscript%3E`, {
      headers: { cookie },
    });
    expect(xssQuery.status).toBe(400);
    await expect(xssQuery.json()).resolves.toMatchObject({ code: "invalid_query" });

    const xssCursor = await fetch(`${server.origin}/api/v1/graph/nodes?cursor=%3Cscript%3E`, {
      headers: { cookie },
    });
    expect(xssCursor.status).toBe(400);
    await expect(xssCursor.json()).resolves.toMatchObject({ code: "invalid_identifier" });

    const crossOrigin = await fetch(`${server.origin}/api/v1/project`, {
      headers: { cookie, origin: "https://evil.example" },
    });
    expect(crossOrigin.status).toBe(403);
    await expect(crossOrigin.json()).resolves.toMatchObject({ code: "origin_mismatch" });
  });
});
