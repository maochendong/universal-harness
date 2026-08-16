import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test as base, type Page } from "@playwright/test";

import { createGitVcsAdapter } from "../../adapters/vcs-git/src/index.js";
import {
  GRAPH_DATABASE_RELATIVE_PATH,
  harnessRootFor,
  resolveHarnessPath,
} from "../../packages/core/src/index.js";
import { startDashboardServer, type DashboardServer } from "../../packages/dashboard/src/index.js";
import { rebuildGraphCache } from "../../packages/graph/src/index.js";
import { createNewProject } from "../../packages/runtime/src/index.js";

interface DashboardFixture {
  readonly page: Page;
  readonly server: DashboardServer;
}

const test = base.extend<{ dashboard: DashboardFixture }>({
  dashboard: async ({ page }, use) => {
    const parent = mkdtempSync(join(tmpdir(), "harness-dashboard-e2e-"));
    const created = await createNewProject(
      { parentDirectory: parent, name: "dashboard-e2e", intent: "observe a managed project" },
      { vcs: createGitVcsAdapter() },
    );
    if (!created.ok) throw new Error(created.error.message);
    const databasePath = resolveHarnessPath(
      harnessRootFor(created.value.projectRoot),
      GRAPH_DATABASE_RELATIVE_PATH,
    );
    rebuildGraphCache({ projectRoot: created.value.projectRoot, databasePath }).database.close();
    const server = await startDashboardServer({ projectRoot: created.value.projectRoot });
    await page.goto(server.bootstrapUrl);
    await expect(page).toHaveURL(server.origin + "/");
    try {
      await use({ page, server });
    } finally {
      await server.close();
      rmSync(parent, { recursive: true, force: true });
    }
  },
});

test.describe("Dashboard read-only journey", () => {
  test("loads the project and expands graph data only on demand", async ({
    dashboard,
  }, testInfo) => {
    const { page } = dashboard;
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    await expect(page.getByRole("heading", { level: 1 })).toContainText("dashboard-e2e");
    await expect(page.getByText(/Authoritative status loaded/u)).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Dashboard sections" })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("observatory-overview.png"),
      fullPage: true,
      animations: "disabled",
    });

    const graphRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/v1/graph/")) graphRequests.push(request.url());
    });
    await page.getByRole("link", { name: /Graph/u }).click();
    await expect(page.getByRole("heading", { name: "Artifact graph" })).toBeVisible();
    const firstNode = page
      .getByRole("button")
      .filter({ hasText: /Project|Repository/u })
      .first();
    await expect(firstNode).toBeVisible();
    expect(graphRequests.some((url) => url.includes("limit=24"))).toBe(true);
    expect(graphRequests.some((url) => url.includes("limit=500"))).toBe(false);

    const neighborhoodResponse = page.waitForResponse((response) =>
      response.url().includes("/api/v1/graph/neighborhood/"),
    );
    await firstNode.click();
    await expect(neighborhoodResponse).resolves.toBeTruthy();
    await expect(page.getByText(/Neighborhood loaded/u)).toBeVisible();
    expect(consoleErrors).toEqual([]);
  });

  test("exposes iteration, evidence, findings, and explicit empty states", async ({
    dashboard,
  }) => {
    const { page } = dashboard;

    await page.getByRole("link", { name: /Iterations/u }).click();
    await expect(page.getByRole("heading", { name: "Iteration ledger" })).toBeVisible();
    const iteration = page
      .getByRole("button")
      .filter({ hasText: /iteration_/u })
      .first();
    await expect(iteration).toBeVisible();
    await iteration.click();
    await expect(page.getByText("ITERATION DOSSIER")).toBeVisible();

    await page.getByRole("link", { name: /Evidence/u }).click();
    await expect(page.getByText("No Evidence nodes match this filter.")).toBeVisible();

    await page.getByRole("link", { name: /Findings/u }).click();
    await expect(page.getByText("No Finding groups are open.")).toBeVisible();

    await page.getByRole("link", { name: /Impact/u }).click();
    await expect(page.getByLabel("FROM / SEED")).toBeVisible();
    await expect(page.getByLabel("TO / TARGET")).toBeVisible();
  });

  test("supports keyboard focus, reduced motion, and a narrow-screen list layout", async ({
    dashboard,
  }) => {
    const { page } = dashboard;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();

    await page.keyboard.press("Tab");
    const skipLink = page.getByRole("link", { name: "Skip to workspace" });
    await expect(skipLink).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();

    const navigation = page.getByRole("navigation", { name: "Dashboard sections" });
    await expect(navigation).toBeVisible();
    await page.getByRole("link", { name: /Graph/u }).click();
    await expect(page.getByRole("heading", { name: "Artifact graph" })).toBeVisible();
    const columns = await page
      .locator(".graph-layout")
      .evaluate((element) => getComputedStyle(element).gridTemplateColumns);
    expect(columns.trim().split(/\s+/u)).toHaveLength(1);
    const duration = await page
      .locator('[data-panel="graph"]')
      .evaluate((element) => getComputedStyle(element).animationDuration);
    expect(Number.parseFloat(duration)).toBeLessThanOrEqual(0.001);
  });

  test("renders a typed API failure as a visible error state", async ({ dashboard }) => {
    const { page } = dashboard;
    await page.route("**/api/v1/graph/nodes*", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/problem+json",
        json: {
          type: "about:blank",
          title: "Service Unavailable",
          status: 503,
          detail: "the graph cache is unavailable",
          code: "graph_cache_unavailable",
        },
      }),
    );
    await page.getByRole("link", { name: /Graph/u }).click();
    await expect(page.getByText("the graph cache is unavailable")).toBeVisible();
    await expect(page.getByText("the graph cache is unavailable")).toHaveAttribute(
      "data-tone",
      "error",
    );
  });
});
