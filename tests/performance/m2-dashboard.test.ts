import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  GRAPH_DATABASE_RELATIVE_PATH,
  createProjectManifest,
  harnessRootFor,
  resolveHarnessPath,
  serializeProjectManifest,
} from "../../packages/core/src/index.js";
import { startDashboardServer, type DashboardServer } from "../../packages/dashboard/src/index.js";
import { rebuildGraphCache } from "../../packages/graph/src/index.js";

import {
  buildSyntheticLedger,
  loadM2Dataset,
  recordBaseline,
  summarizeSamples,
} from "./helpers.js";

const PROJECT_RESPONSE_THRESHOLD_MS = 2_000;
const QUERY_P95_THRESHOLD_MS = 200;
const EVENT_P95_THRESHOLD_MS = 500;
const roots: string[] = [];
const servers: DashboardServer[] = [];

function fixture(): { readonly root: string; readonly dataset: ReturnType<typeof loadM2Dataset> } {
  const root = mkdtempSync(join(tmpdir(), "harness-m2-dashboard-perf-"));
  roots.push(root);
  const dataset = loadM2Dataset();
  const harnessRoot = harnessRootFor(root);
  mkdirSync(harnessRoot, { recursive: true });
  writeFileSync(
    resolveHarnessPath(harnessRoot, "manifest.yaml"),
    serializeProjectManifest(
      createProjectManifest({
        name: "m2-performance",
        repositoryId: "repository_m2-performance",
        now: () => "2026-08-16T00:00:00.000Z",
      }),
    ),
  );
  buildSyntheticLedger(root, dataset, dataset.events);
  rebuildGraphCache({
    projectRoot: root,
    databasePath: resolveHarnessPath(harnessRoot, GRAPH_DATABASE_RELATIVE_PATH),
  }).database.close();
  return { root, dataset };
}

async function session(server: DashboardServer): Promise<string> {
  const exchanged = await fetch(server.bootstrapUrl, { redirect: "manual" });
  const cookie = exchanged.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("Dashboard session cookie missing");
  return cookie;
}

afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 300_000);

describe("M2 Dashboard performance fixture", { timeout: 300_000 }, () => {
  it("serves the exact 10k/30k/20k/1k fixture within the release thresholds", async () => {
    const { root, dataset } = fixture();
    expect(dataset.nodes).toHaveLength(10_000);
    expect(dataset.edges).toHaveLength(30_000);
    expect(dataset.events).toHaveLength(20_000);
    expect(dataset.findings).toHaveLength(1_000);

    const server = await startDashboardServer({ projectRoot: root });
    servers.push(server);
    const cookie = await session(server);
    const projectStarted = performance.now();
    const projectResponse = await fetch(`${server.origin}/api/v1/project`, {
      headers: { cookie },
    });
    await projectResponse.arrayBuffer();
    const projectElapsed = performance.now() - projectStarted;
    expect(projectResponse.status).toBe(200);
    expect(projectElapsed).toBeLessThan(PROJECT_RESPONSE_THRESHOLD_MS);

    const requests = [
      "/api/v1/graph/nodes?limit=100",
      "/api/v1/graph/edges?limit=100",
      "/api/v1/graph/neighborhood/requirement_r00000?depth=2&direction=both",
    ];
    const views: Record<string, ReturnType<typeof summarizeSamples>> = {};
    for (const path of requests) {
      const samples: number[] = [];
      for (let run = 0; run < 10; run += 1) {
        const started = performance.now();
        const response = await fetch(`${server.origin}${path}`, { headers: { cookie } });
        await response.arrayBuffer();
        expect(response.status).toBe(200);
        samples.push(performance.now() - started);
      }
      const summary = summarizeSamples(samples);
      expect(summary.p95_ms, `${path} p95 exceeded the Dashboard threshold`).toBeLessThan(
        QUERY_P95_THRESHOLD_MS,
      );
      views[path] = summary;
    }

    const eventSamples: number[] = [];
    for (let run = 0; run < 5; run += 1) {
      const abort = new AbortController();
      const started = performance.now();
      const response = await fetch(`${server.origin}/events`, {
        headers: { cookie },
        signal: abort.signal,
      });
      const reader = response.body?.getReader();
      const first = await reader?.read();
      eventSamples.push(performance.now() - started);
      expect(response.status).toBe(200);
      expect(new TextDecoder().decode(first?.value)).toContain("event:");
      abort.abort();
      await reader?.cancel().catch(() => undefined);
    }
    const eventTiming = summarizeSamples(eventSamples);
    expect(eventTiming.p95_ms).toBeLessThan(EVENT_P95_THRESHOLD_MS);

    recordBaseline("m2-dashboard", {
      metric: "m2_dashboard",
      operation_scale: { nodes: 10_000, edges: 30_000, events: 20_000, findings: 1_000 },
      first_project_response_ms: projectElapsed,
      views,
      event_stream: eventTiming,
    });
  });
});
