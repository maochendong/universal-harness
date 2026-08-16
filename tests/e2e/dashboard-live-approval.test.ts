import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test as base, type Page } from "@playwright/test";

import { createGitVcsAdapter } from "../../adapters/vcs-git/src/index.js";
import {
  GRAPH_DATABASE_RELATIVE_PATH,
  contentDigest,
  harnessRootFor,
  readCommittedOperations,
  resolveHarnessPath,
} from "../../packages/core/src/index.js";
import {
  DashboardWriteError,
  startDashboardServer,
  type DashboardServer,
  type DashboardWriteApi,
} from "../../packages/dashboard/src/index.js";
import { rebuildGraphCache } from "../../packages/graph/src/index.js";
import {
  createGenericInterpreter,
  createNewProject,
  readApprovalDecisions,
  readCurrentOperation,
  resolveApproval,
  resumeIteration,
  runIteration,
  type OrchestratorDependencies,
} from "../../packages/runtime/src/index.js";

interface LiveDashboardFixture {
  readonly page: Page;
  readonly server: DashboardServer;
  readonly projectRoot: string;
  readonly workflowOperationId: string;
  readonly firstRequestId: string;
}

function head(projectRoot: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
}

const test = base.extend<{ dashboard: LiveDashboardFixture }>({
  dashboard: async ({ page }, use) => {
    const parent = mkdtempSync(join(tmpdir(), "harness-dashboard-live-e2e-"));
    const vcs = createGitVcsAdapter();
    const created = await createNewProject(
      { parentDirectory: parent, name: "dashboard-live", intent: "govern a live iteration" },
      { vcs },
    );
    if (!created.ok) throw new Error(created.error.message);
    const projectRoot = created.value.projectRoot;
    const deps: OrchestratorDependencies = {
      projectRoot,
      readBaseline: () => head(projectRoot),
      vcs,
      interpret: createGenericInterpreter(),
    };
    const started = await runIteration(deps, {
      intent: "add a digest-bound live approval flow",
      intentShape: "pack-converted",
    });
    if (started.status !== "approval_required") {
      throw new Error(`expected first approval, got ${started.status}`);
    }
    const writeApi: DashboardWriteApi = {
      decideApproval: async (input) => {
        try {
          const resolved = await resolveApproval(deps, {
            requestId: input.requestId,
            decision: input.decision,
            actor: input.actor,
            expectedObjectDigest: input.expectedDigest,
          });
          const operation = readCurrentOperation(
            { projectRoot, readBaseline: deps.readBaseline },
            resolved.workflowOperationId,
          );
          return {
            request_id: resolved.requestId,
            decision: resolved.decision,
            approval_digest: resolved.approvalDigest,
            workflow_operation_id: resolved.workflowOperationId,
            workflow_digest: operation === undefined ? undefined : contentDigest(operation),
            expected_digest: input.expectedDigest,
            actor: input.actor,
          };
        } catch {
          throw new DashboardWriteError("conflict", "approval changed; refresh first");
        }
      },
      resumeWorkflow: async (input) => {
        const operation = readCurrentOperation(
          { projectRoot, readBaseline: deps.readBaseline },
          input.workflowOperationId,
        );
        if (operation === undefined) throw new DashboardWriteError("not_found", "workflow missing");
        if (contentDigest(operation) !== input.expectedDigest) {
          throw new DashboardWriteError("conflict", "workflow changed; refresh first");
        }
        const outcome = await resumeIteration(deps, input.workflowOperationId, undefined);
        return { status: outcome.status, actor: input.actor };
      },
      resolveFindingGroup: () =>
        Promise.reject(new DashboardWriteError("unavailable", "no finding fixture")),
    };
    const databasePath = resolveHarnessPath(
      harnessRootFor(projectRoot),
      GRAPH_DATABASE_RELATIVE_PATH,
    );
    rebuildGraphCache({ projectRoot, databasePath }).database.close();
    const server = await startDashboardServer({ projectRoot, writeApi });
    await page.goto(server.bootstrapUrl);
    await expect(page).toHaveURL(server.origin + "/");
    try {
      await use({
        page,
        server,
        projectRoot,
        workflowOperationId: started.required.workflow_operation_id,
        firstRequestId: started.required.request_id,
      });
    } finally {
      await server.close();
      rmSync(parent, { recursive: true, force: true });
    }
  },
});

test.describe("Dashboard live approval journey", () => {
  test("replaces live signals, commits a digest-bound actor decision, and resumes", async ({
    dashboard,
  }) => {
    const { page, projectRoot, workflowOperationId, firstRequestId } = dashboard;
    await page.getByRole("link", { name: /Live/u }).click();
    await expect(page.getByRole("heading", { name: "Operation stream" })).toBeVisible();
    await expect(page.getByText(firstRequestId, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "APPROVE" })).toBeVisible();
    await expect(page.getByRole("button", { name: "REJECT" })).toBeVisible();
    await expect(page.getByRole("button", { name: "DEFER" })).toBeVisible();

    await page.getByLabel("DECISION ACTOR").fill("human:web-e2e");
    await page.getByRole("button", { name: "APPROVE" }).click();
    await expect(page.getByText("DECISION RECORDED")).toBeVisible();
    await expect(page.getByRole("button", { name: "RESUME WORKFLOW" })).toBeVisible();

    const decisions = readApprovalDecisions(
      harnessRootFor(projectRoot),
      readCommittedOperations(harnessRootFor(projectRoot)),
      workflowOperationId,
    );
    expect(decisions).toEqual([
      expect.objectContaining({
        request_id: firstRequestId,
        actor: "human:web-e2e",
        decision: "approve",
      }),
    ]);

    await page.getByRole("button", { name: "RESUME WORKFLOW" }).click();
    await expect(
      page.locator(".approval-card").getByRole("heading", { name: "ImpactSet" }),
    ).toBeVisible();
    await expect(
      page
        .locator(".approval-card")
        .getByText(/approval_request_/u)
        .first(),
    ).toBeVisible();
  });
});
