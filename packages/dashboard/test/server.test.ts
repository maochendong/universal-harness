import { afterEach, describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";
import {
  GRAPH_DATABASE_RELATIVE_PATH,
  harnessRootFor,
  resolveHarnessPath,
} from "@universal-harness-internal/core";
import { rebuildGraphCache } from "@universal-harness-internal/graph";
import { createNewProject } from "@universal-harness-internal/runtime";

import { startDashboardServer, type DashboardServer } from "../src/index.js";

const servers: DashboardServer[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  const { rmSync } = await import("node:fs");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function managedProject(): Promise<string> {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const parent = mkdtempSync(join(tmpdir(), "harness-dashboard-"));
  roots.push(parent);
  const created = await createNewProject(
    { parentDirectory: parent, name: "dashboard-project", intent: "inspect the harness graph" },
    { vcs: createGitVcsAdapter() },
  );
  if (!created.ok) throw new Error(created.error.message);
  const databasePath = resolveHarnessPath(
    harnessRootFor(created.value.projectRoot),
    GRAPH_DATABASE_RELATIVE_PATH,
  );
  rebuildGraphCache({ projectRoot: created.value.projectRoot, databasePath }).database.close();
  return created.value.projectRoot;
}

function cookieOf(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (value === null) throw new Error("session cookie missing");
  return value.split(";", 1)[0] ?? "";
}

async function authenticated(server: DashboardServer): Promise<string> {
  const exchange = await fetch(server.bootstrapUrl, { redirect: "manual" });
  expect(exchange.status).toBe(303);
  expect(exchange.headers.get("location")).toBe("/");
  return cookieOf(exchange);
}

describe("Dashboard server", () => {
  it("binds to loopback on a random port and exposes paged read APIs", async () => {
    const projectRoot = await managedProject();
    const server = await startDashboardServer({ projectRoot });
    servers.push(server);

    expect(server.host).toBe("127.0.0.1");
    expect(server.port).toBeGreaterThan(0);
    const cookie = await authenticated(server);

    const project = await fetch(`${server.origin}/api/v1/project`, {
      headers: { cookie },
    });
    expect(project.status).toBe(200);
    await expect(project.json()).resolves.toMatchObject({
      data: { name: "dashboard-project", graph_cache: "ok" },
    });

    const nodes = await fetch(`${server.origin}/api/v1/graph/nodes?limit=1`, {
      headers: { cookie },
    });
    expect(nodes.status).toBe(200);
    const nodePage = (await nodes.json()) as {
      data: { items: { id: string }[]; next_cursor?: string };
    };
    expect(nodePage).toMatchObject({
      data: { items: [expect.objectContaining({ record_kind: "node" })] },
    });
    expect(nodePage.data.next_cursor).toEqual(expect.any(String));

    const iterationPage = (await (
      await fetch(`${server.origin}/api/v1/graph/nodes?type=Iteration`, {
        headers: { cookie },
      })
    ).json()) as { data: { items: { id: string }[] } };
    const iterationId = iterationPage.data.items[0]?.id;
    if (iterationId === undefined) throw new Error("bootstrap Iteration missing");
    const iteration = await fetch(`${server.origin}/api/v1/iterations/${iterationId}`, {
      headers: { cookie },
    });
    expect(iteration.status).toBe(200);
    await expect(iteration.json()).resolves.toMatchObject({
      data: {
        iteration: { id: iterationId, type: "Iteration" },
        graph: { rootId: iterationId },
        evaluations: [],
      },
    });

    const neighborhood = await fetch(
      `${server.origin}/api/v1/graph/neighborhood/${nodePage.data.items[0]?.id ?? "node_missing"}`,
      { headers: { cookie } },
    );
    expect(neighborhood.status).toBe(200);
    await expect(neighborhood.json()).resolves.toMatchObject({
      data: { rootId: nodePage.data.items[0]?.id },
    });

    const edges = await fetch(`${server.origin}/api/v1/graph/edges?limit=1`, {
      headers: { cookie },
    });
    expect(edges.status).toBe(200);
    const edgePage = (await edges.json()) as {
      data: { items: { source_id: string; target_id: string }[] };
    };
    expect(edgePage).toMatchObject({
      data: { items: [expect.objectContaining({ record_kind: "edge" })] },
    });
    const firstEdge = edgePage.data.items[0];
    if (firstEdge === undefined) throw new Error("bootstrap edge missing");
    const path = await fetch(
      `${server.origin}/api/v1/graph/path?from=${firstEdge.source_id}&to=${firstEdge.target_id}`,
      { headers: { cookie } },
    );
    expect(path.status).toBe(200);
    await expect(path.json()).resolves.toMatchObject({
      data: { edges: [expect.objectContaining({ source_id: firstEdge.source_id })] },
    });

    const evidence = await fetch(`${server.origin}/api/v1/evidence?limit=1`, {
      headers: { cookie },
    });
    expect(evidence.status).toBe(200);
    await expect(evidence.json()).resolves.toEqual({ data: { items: [] } });

    const findings = await fetch(`${server.origin}/api/v1/finding-groups`, {
      headers: { cookie },
    });
    expect(findings.status).toBe(200);
    await expect(findings.json()).resolves.toEqual({ data: { items: [] } });
  });

  it("returns typed problems for invalid limits, unknown nodes, and a damaged cache", async () => {
    const { writeFileSync } = await import("node:fs");
    const projectRoot = await managedProject();
    const server = await startDashboardServer({ projectRoot });
    servers.push(server);
    const cookie = await authenticated(server);

    const invalid = await fetch(`${server.origin}/api/v1/graph/nodes?limit=501`, {
      headers: { cookie },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("content-type")).toContain("application/problem+json");
    await expect(invalid.json()).resolves.toMatchObject({ code: "invalid_query", status: 400 });

    const missing = await fetch(`${server.origin}/api/v1/graph/neighborhood/node_missing`, {
      headers: { cookie },
    });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ code: "node_not_found" });

    const databasePath = resolveHarnessPath(
      harnessRootFor(projectRoot),
      GRAPH_DATABASE_RELATIVE_PATH,
    );
    writeFileSync(databasePath, "not sqlite", "utf8");
    const unavailable = await fetch(`${server.origin}/api/v1/graph/nodes`, {
      headers: { cookie },
    });
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toMatchObject({
      code: "graph_cache_unavailable",
      status: 503,
    });
  });
});
