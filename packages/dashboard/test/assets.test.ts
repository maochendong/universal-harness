import { afterEach, describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";
import { createNewProject } from "@universal-harness-internal/runtime";

import { loadDashboardAsset, startDashboardServer, type DashboardServer } from "../src/index.js";

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
  const parent = mkdtempSync(join(tmpdir(), "harness-dashboard-assets-"));
  roots.push(parent);
  const created = await createNewProject(
    { parentDirectory: parent, name: "dashboard-assets", intent: "inspect the control plane" },
    { vcs: createGitVcsAdapter() },
  );
  if (!created.ok) throw new Error(created.error.message);
  return created.value.projectRoot;
}

describe("Dashboard assets", () => {
  it("ships a self-contained accessible shell with every M2 read view", () => {
    const html = loadDashboardAsset("dashboard.html").body.toString("utf8");
    const css = loadDashboardAsset("dashboard.css").body.toString("utf8");
    const javascript = loadDashboardAsset("dashboard.js").body.toString("utf8");

    expect(html).toContain('<a class="skip-link" href="#workspace">');
    expect(html).toContain('aria-label="Dashboard sections"');
    for (const view of ["overview", "graph", "impact", "iterations", "evidence", "findings"]) {
      expect(html).toContain(`data-panel="${view}"`);
    }
    expect(html).toContain('src="/assets/dashboard.js"');
    expect(html).toContain('href="/assets/dashboard.css"');
    expect(`${html}\n${css}\n${javascript}`).not.toMatch(/https?:\/\//u);
    expect(javascript).not.toMatch(/innerHTML|localStorage|sessionStorage|eval\s*\(/u);
    expect(javascript).toContain("/api/v1/graph/neighborhood/");
    expect(javascript).toContain("/api/v1/semantic-proposals");
    expect(html).toContain("Candidate edge proposals");
    expect(javascript).not.toContain("/api/v1/graph/nodes?limit=500");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toMatch(/@media\s*\(max-width:/u);
    expect(html).toContain('id="copy-status"');
    expect(html).toContain('role="status"');
    expect(javascript).toContain("navigator.clipboard.writeText");
    expect(javascript).toContain("复制完整摘要");
    // M3: the three approved remote-collaboration surfaces (plan Task 8).
    expect(html).toContain('id="connection-card"');
    expect(html).toContain('id="connection-state"');
    expect(html).toContain('id="remote-inbox"');
    expect(html).toContain('id="conflict-list"');
    expect(html).toContain("远程协调事实");
    expect(javascript).toContain("/api/v1/collaboration/connection");
    expect(javascript).toContain("/api/v1/collaboration/approvals");
    expect(javascript).toContain("/api/v1/collaboration/integrations/");
    expect(css).toContain(".projection-note");
    expect(css).toContain(".remote-fact-card");
    // M4: one Observatory-native Scheduler control surface, not a second app.
    expect(html).toContain('data-panel="scheduler"');
    expect(html).toContain('id="scheduler-waves"');
    expect(html).toContain('id="scheduler-agent-pool"');
    expect(html).toContain('id="scheduler-task-detail"');
    expect(html).toContain('id="scheduler-approvals"');
    expect(javascript).toContain("/api/v1/scheduler?operation_id=");
    expect(javascript).toContain("正在从 Ledger 重建");
    expect(javascript).toContain("疑似僵尸进程");
    expect(javascript).not.toMatch(
      /force_task_success|skip_gate|move_task_to_slot|force_release_lease|force_merge_candidate|ignore_baseline_drift/u,
    );
    expect(css).toContain(".scheduler-grid");
    expect(css).toContain(".source-provisional");
    for (const component of [".business-heading", ".business-badges", ".audit-details"]) {
      expect(css).toContain(component);
    }
  });

  it("serves authenticated local assets with strict types and cache policies", async () => {
    const server = await startDashboardServer({ projectRoot: await project() });
    servers.push(server);
    const exchange = await fetch(server.bootstrapUrl, { redirect: "manual" });
    const cookie = (exchange.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";

    const html = await fetch(`${server.origin}/`, { headers: { cookie } });
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(html.headers.get("cache-control")).toBe("no-store");
    expect(await html.text()).toContain("HARNESS / OBSERVATORY");

    const css = await fetch(`${server.origin}/assets/dashboard.css`, { headers: { cookie } });
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(css.headers.get("cache-control")).toBe("no-cache");

    const javascript = await fetch(`${server.origin}/assets/dashboard.js`, {
      headers: { cookie },
    });
    expect(javascript.status).toBe(200);
    expect(javascript.headers.get("content-type")).toContain("text/javascript");
    expect(javascript.headers.get("cache-control")).toBe("no-cache");
  });
});
