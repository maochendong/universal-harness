import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test as base, type Page } from "@playwright/test";

import { createGitVcsAdapter } from "../../adapters/vcs-git/src/index.js";
import {
  GRAPH_DATABASE_RELATIVE_PATH,
  LedgerRepository,
  PROTOCOL_VERSION,
  canonicalizeJson,
  contentDigest,
  harnessRootFor,
  resolveHarnessPath,
  type NodeRecord,
} from "../../packages/core/src/index.js";
import { startDashboardServer, type DashboardServer } from "../../packages/dashboard/src/index.js";
import { rebuildGraphCache } from "../../packages/graph/src/index.js";
import { createNewProject } from "../../packages/runtime/src/index.js";

interface DashboardFixture {
  readonly page: Page;
  readonly server: DashboardServer;
}

function sealNode(content: Omit<NodeRecord, "digest">): NodeRecord {
  return { ...content, digest: contentDigest(content) };
}

async function seedBusinessReadModels(input: {
  readonly projectRoot: string;
  readonly iterationId: string;
  readonly repositoryId: string;
  readonly repositoryNodeId: string;
  readonly workflowOperationId: string;
  readonly baselineCommit: string;
}): Promise<void> {
  const timestamp = "2026-08-17T00:00:00.000Z";
  const provenance = {
    iteration_id: input.iterationId,
    actor: "dashboard-e2e",
    timestamp,
  };
  const evidence = sealNode({
    protocol_version: PROTOCOL_VERSION,
    record_kind: "node",
    id: "evidence_dashboard_e2e",
    type: "Evidence",
    revision: 1,
    status: "accepted",
    source: "gate",
    provenance,
    confidence: 1,
    extensions: {
      "harness.gate": {
        gate_id: "gate_login",
        summary: "登录验证门禁通过。",
        passed: true,
        freshness: "fresh",
        provisional: false,
      },
    },
  });
  const finding = sealNode({
    protocol_version: PROTOCOL_VERSION,
    record_kind: "node",
    id: "finding_dashboard_e2e",
    type: "Finding",
    revision: 1,
    status: "proposed",
    source: "audit",
    provenance,
    confidence: 1,
    extensions: {
      "harness.finding": {
        rule: "missing_verification",
        scope_prefix: `project/${input.repositoryId}/verification`,
        severity: "blocker",
        actionability: "human_review",
        subject_ids: [input.repositoryNodeId],
        subject_digests: [],
      },
    },
  });
  await new LedgerRepository({
    projectRoot: input.projectRoot,
    readBaseline: () => input.baselineCommit,
    now: () => timestamp,
  }).commit({
    ledger_operation_id: "ledger_dashboard_e2e_read_models",
    workflow_operation_id: input.workflowOperationId,
    attempt_id: "attempt_dashboard_e2e_read_models",
    expected_baseline: input.baselineCommit,
    artifacts: [evidence, finding].map((node) => ({
      path: `artifacts/dashboard-e2e/${node.id}.json`,
      content: `${canonicalizeJson(node)}\n`,
    })),
  });
  const proposalDirectory = resolveHarnessPath(
    harnessRootFor(input.projectRoot),
    "artifacts/edge-proposals",
  );
  mkdirSync(proposalDirectory, { recursive: true });
  writeFileSync(
    resolveHarnessPath(proposalDirectory, "edge_dashboard_e2e_proposal.json"),
    `${JSON.stringify({
      edge: {
        id: "edge_dashboard_e2e_proposal",
        source_id: input.repositoryNodeId,
        target_id: input.iterationId,
      },
      preview_digest: "f".repeat(64),
      suggestion: {
        score: { millionths: 875_000 },
        reason: "代码仓库与当前迭代共享 Dashboard 展示契约。",
      },
    })}\n`,
    "utf8",
  );
}

const test = base.extend<{ dashboard: DashboardFixture }>({
  dashboard: async ({ page }, use) => {
    const parent = mkdtempSync(join(tmpdir(), "harness-dashboard-e2e-"));
    const created = await createNewProject(
      { parentDirectory: parent, name: "dashboard-e2e", intent: "observe a managed project" },
      { vcs: createGitVcsAdapter() },
    );
    if (!created.ok) throw new Error(created.error.message);
    await seedBusinessReadModels({
      projectRoot: created.value.projectRoot,
      iterationId: created.value.iterationId,
      repositoryId: created.value.repositoryId,
      repositoryNodeId: created.value.repositoryNodeId,
      workflowOperationId: created.value.workflowOperationId,
      baselineCommit: created.value.headCommit,
    });
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
    await expect(page.getByText("派生自", { exact: true })).toBeVisible();
    expect(consoleErrors).toEqual([]);
  });

  test("presents iteration, evidence, findings, and impact in business language", async ({
    dashboard,
  }) => {
    const { page } = dashboard;

    await page.getByRole("link", { name: /Iterations/u }).click();
    await expect(page.getByRole("heading", { name: "Iteration ledger" })).toBeVisible();
    const iteration = page.getByRole("button").filter({ hasText: /迭代/u }).first();
    await expect(iteration).toBeVisible();
    await iteration.click();
    await expect(page.getByText("ITERATION DOSSIER")).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: /迭代/u })).toBeVisible();
    await expect(page.getByText(/审计信息 ·/u)).toBeVisible();

    await page.getByRole("link", { name: /Evidence/u }).click();
    const evidenceRegion = page.getByRole("region", { name: "Evidence register" });
    await expect(evidenceRegion.getByText("登录验证门禁通过。", { exact: true })).toBeVisible();
    await expect(evidenceRegion.getByText("已通过", { exact: true })).toBeVisible();
    await expect(evidenceRegion.getByText(/审计信息 ·/u)).toBeVisible();

    await page.getByRole("link", { name: /Findings/u }).click();
    const findingRegion = page.getByRole("region", { name: "Finding groups" });
    await expect(
      findingRegion.getByRole("heading", { level: 3, name: "缺少验证证据" }),
    ).toBeVisible();
    await expect(findingRegion.getByText("人工复核", { exact: true })).toBeVisible();
    await expect(findingRegion.getByText(/审计信息 ·/u)).toBeVisible();

    await page.getByRole("link", { name: /Impact/u }).click();
    await expect(page.getByLabel("FROM / SEED")).toBeVisible();
    await expect(page.getByLabel("TO / TARGET")).toBeVisible();
    const edge = await page.evaluate(async () => {
      const response = await fetch("/api/v1/graph/edges?limit=1");
      const payload = (await response.json()) as {
        data: { items: { source_id: string; target_id: string }[] };
      };
      return payload.data.items[0];
    });
    if (edge === undefined) throw new Error("Impact edge fixture missing");
    await page.getByLabel("FROM / SEED").fill(edge.source_id);
    await page.getByLabel("TO / TARGET").fill(edge.target_id);
    await page.getByRole("button", { name: "TRACE PATH" }).click();
    const impactRegion = page.getByRole("region", { name: "Impact trace" });
    await expect(impactRegion.getByText("派生自", { exact: true })).toBeVisible();
    await expect(impactRegion.getByText("候选影响关系", { exact: true })).toBeVisible();
    await expect(impactRegion.getByText("待批准", { exact: true })).toBeVisible();
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
    const firstNode = page
      .getByRole("button")
      .filter({ hasText: /Project|Repository/u })
      .first();
    await firstNode.click();
    await expect(page.getByText(/Neighborhood loaded/u)).toBeVisible();
    const neighborColumns = await page
      .locator(".neighbor-list")
      .evaluate((element) => getComputedStyle(element).gridTemplateColumns);
    expect(neighborColumns.trim().split(/\s+/u)).toHaveLength(1);
    const graphOverflow = await page
      .locator('[data-panel="graph"]')
      .evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(graphOverflow).toBe(false);
  });

  test("copies a full digest by keyboard and reports the manual fallback", async ({
    dashboard,
  }) => {
    const { page, server } = dashboard;
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: server.origin,
    });
    await page.getByRole("link", { name: /Graph/u }).click();
    const firstNode = page
      .getByRole("button")
      .filter({ hasText: /Project|Repository/u })
      .first();
    await firstNode.click();
    await expect(page.getByText(/Neighborhood loaded/u)).toBeVisible();
    const inspector = page.locator("#graph-inspector");
    await inspector.getByText(/审计信息 ·/u).click();
    const digest = await inspector.locator(".digest-full").textContent();
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    const copy = inspector.getByRole("button", { name: /复制.+完整摘要/u });
    await copy.focus();
    await expect(copy).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#copy-status")).toContainText("已复制");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(digest);

    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    });
    await copy.click();
    await expect(page.locator("#copy-status")).toContainText("无法自动复制");
    await expect(inspector.locator(".digest-full")).toBeVisible();
    await expect(inspector.locator(".digest-full")).toHaveAttribute("tabindex", "0");
  });

  test("falls back to technical graph fields when an older server omits presentations", async ({
    dashboard,
  }) => {
    const { page } = dashboard;
    let firstRecord: { id: string; type: string } | undefined;
    await page.route("**/api/v1/graph/nodes*", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        data: {
          items: { id: string; type: string }[];
          presentations?: Record<string, unknown>;
        };
      };
      firstRecord = body.data.items[0];
      delete body.data.presentations;
      await route.fulfill({ response, json: body });
    });

    // The heading renders before the intercepted nodes fetch resolves under
    // CI load; wait for the response so firstRecord is actually populated.
    const nodesResponse = page.waitForResponse("**/api/v1/graph/nodes*");
    await page.getByRole("link", { name: /Graph/u }).click();
    await nodesResponse;
    await expect(page.getByRole("heading", { name: "Artifact graph" })).toBeVisible();
    expect(firstRecord).toBeDefined();
    const fallbackCard = page
      .getByRole("button")
      .filter({ hasText: firstRecord?.id ?? "missing-record" })
      .first();
    await expect(fallbackCard).toContainText(firstRecord?.type ?? "Unknown");
    await expect(fallbackCard).toContainText(firstRecord?.id ?? "missing-record");
    await expect(page.locator('[data-state="graph"][data-tone="error"]')).toHaveCount(0);
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
