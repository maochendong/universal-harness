import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "../../adapters/vcs-git/src/index.js";
import {
  GRAPH_DATABASE_RELATIVE_PATH,
  harnessRootFor,
  readCommittedOperations,
  resolveHarnessPath,
} from "../../packages/core/src/index.js";
import {
  startDashboardServer,
  type DashboardServer,
  type DashboardWriteApi,
} from "../../packages/dashboard/src/index.js";
import { checkGraphCache, rebuildGraphCache } from "../../packages/graph/src/index.js";
import { createNewProject } from "../../packages/runtime/src/index.js";

const roots: string[] = [];
const servers: DashboardServer[] = [];

// Windows CI rebuilds the cache and boots the server well past the global
// 20s timeout (observed 21-23s), so give this journey extra headroom there.
const CACHE_REBUILD_TIMEOUT = process.platform === "win32" ? 60_000 : 20_000;

async function project(): Promise<string> {
  const parent = mkdtempSync(join(tmpdir(), "harness-dashboard-recovery-"));
  roots.push(parent);
  const created = await createNewProject(
    { parentDirectory: parent, name: "dashboard-recovery", intent: "recover safe reads" },
    { vcs: createGitVcsAdapter() },
  );
  if (!created.ok) throw new Error(created.error.message);
  return created.value.projectRoot;
}

async function authenticate(server: DashboardServer): Promise<{
  readonly cookie: string;
  readonly csrf: string;
}> {
  const exchange = await fetch(server.bootstrapUrl, { redirect: "manual" });
  const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("session cookie missing");
  const session = await fetch(`${server.origin}/api/v1/session`, { headers: { cookie } });
  const body = (await session.json()) as { data: { csrf_token: string } };
  return { cookie, csrf: body.data.csrf_token };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Dashboard cache and Ledger recovery", () => {
  it.each(["missing", "corrupt"] as const)(
    "rebuilds a %s disposable SQLite cache before serving",
    async (mode) => {
      const projectRoot = await project();
      const databasePath = resolveHarnessPath(
        harnessRootFor(projectRoot),
        GRAPH_DATABASE_RELATIVE_PATH,
      );
      rebuildGraphCache({ projectRoot, databasePath }).database.close();
      if (mode === "missing") unlinkSync(databasePath);
      else writeFileSync(databasePath, "not a sqlite database", "utf8");

      const server = await startDashboardServer({ projectRoot });
      servers.push(server);
      const { cookie } = await authenticate(server);
      const nodes = await fetch(`${server.origin}/api/v1/graph/nodes?limit=1`, {
        headers: { cookie },
      });
      expect(nodes.status).toBe(200);
      expect(checkGraphCache(databasePath).status).toBe("ok");
    },
    CACHE_REBUILD_TIMEOUT,
  );

  it("serves stable 503s and disables writes when the authoritative Ledger is corrupt", async () => {
    const projectRoot = await project();
    const harnessRoot = harnessRootFor(projectRoot);
    const operation = readCommittedOperations(harnessRoot)[0];
    if (operation === undefined) throw new Error("fixture has no committed operation");
    writeFileSync(resolveHarnessPath(harnessRoot, operation.manifest.event_file), "corrupt\n");
    let writes = 0;
    const writeApi: DashboardWriteApi = {
      decideApproval: () => {
        writes += 1;
        return Promise.resolve({});
      },
      resumeWorkflow: () => Promise.resolve({}),
      resolveFindingGroup: () => Promise.resolve({}),
    };
    const server = await startDashboardServer({ projectRoot, writeApi });
    servers.push(server);
    const { cookie, csrf } = await authenticate(server);

    const read = await fetch(`${server.origin}/api/v1/project`, { headers: { cookie } });
    expect(read.status).toBe(503);
    await expect(read.json()).resolves.toMatchObject({ code: "ledger_corrupt", status: 503 });

    const write = await fetch(`${server.origin}/api/v1/approvals/approval_request_01/decision`, {
      method: "POST",
      headers: {
        cookie,
        origin: server.origin,
        "content-type": "application/json",
        "x-harness-csrf": csrf,
      },
      body: JSON.stringify({
        decision: "approve",
        expected_digest: "a".repeat(64),
        actor: "human:fault-test",
      }),
    });
    expect(write.status).toBe(503);
    await expect(write.json()).resolves.toMatchObject({ code: "write_operations_unavailable" });
    expect(writes).toBe(0);
  });

  it("returns a sanitized 503 if a healthy cache is corrupted while serving", async () => {
    const projectRoot = await project();
    const databasePath = resolveHarnessPath(
      harnessRootFor(projectRoot),
      GRAPH_DATABASE_RELATIVE_PATH,
    );
    rebuildGraphCache({ projectRoot, databasePath }).database.close();
    const server = await startDashboardServer({ projectRoot });
    servers.push(server);
    const { cookie } = await authenticate(server);
    writeFileSync(databasePath, "damaged after startup", "utf8");

    const response = await fetch(`${server.origin}/api/v1/graph/nodes`, {
      headers: { cookie },
    });
    expect(response.status).toBe(503);
    const body = JSON.stringify(await response.json());
    expect(body).toContain("graph_cache_unavailable");
    expect(body).not.toContain(projectRoot);
    expect(body).not.toContain("SQLITE");
  });
});
