import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test as base, type Page } from "@playwright/test";

import { createGitVcsAdapter } from "../../adapters/vcs-git/src/index.js";
import {
  buildCollaborationRecord,
  canonicalizeJson,
  type CollaborationConnectionRecord,
  type IntegrationRecord,
  type RemoteApprovalDecisionRecord,
} from "../../packages/core/src/index.js";
import {
  createDashboardCollaborationApi,
  startDashboardServer,
  type DashboardServer,
} from "../../packages/dashboard/src/index.js";
import type {
  CollaborationCommand,
  CollaborationCoordinatorPort,
  CollaborationQuery,
} from "../../packages/runtime/src/index.js";
import { createNewProject } from "../../packages/runtime/src/index.js";

/**
 * M3 Dashboard e2e (plan Task 8): the three approved views — Connection
 * Status, remote-aware Approval Inbox and Integration Conflict — run against
 * a fake Coordinator behind the shared port seam. The fake counts every
 * command and query so the tests prove §19.3 (a never-connected project
 * issues zero remote requests) and the retry-after-human-resolution flow.
 */

const digest = (fill: string): string => fill.repeat(64).slice(0, 64);
const commit = (fill: string): string => fill.repeat(40).slice(0, 40);

function connectionRecord(projectId: string): CollaborationConnectionRecord {
  return buildCollaborationRecord({
    record_kind: "collaboration_connection",
    connection_id: "connection_dashboard_e2e",
    project_id: projectId,
    revision: 1,
    status: "active",
    provider: "github",
    repository_id: "octo/dashboard-e2e",
    canonical_remote: "https://github.com/octo/dashboard-e2e.git",
    canonical_remote_digest: digest("a"),
    coordinator_origin: "https://coordinator.example.test",
    target_ref: "refs/heads/main",
    control_ref: "harness/control",
    policy_digest: digest("b"),
    actor_principal_id: "principal_reviewer",
    principal_snapshot_digest: digest("c"),
    command_id: "command_connect_e2e",
    effective_at: "2026-08-29T00:00:00.000Z",
  });
}

function remoteDecision(): RemoteApprovalDecisionRecord {
  return buildCollaborationRecord({
    record_kind: "remote_approval_decision",
    control_sequence: 7,
    previous_control_record_digest: digest("e"),
    remote_decision_id: "remote_decision_e2e",
    request_id: "approval_req_e2e",
    operation_id: "operation_e2e",
    object_id: "requirement_e2e",
    object_digest: digest("f"),
    policy_digest: digest("b"),
    decision: "approve",
    principal_snapshot_digest: digest("c"),
    required_permission: "maintain",
    decided_at: "2026-08-29T01:00:00.000Z",
    command_id: "command_remote_decision_e2e",
  });
}

function integrationConflict(): IntegrationRecord {
  return buildCollaborationRecord({
    record_kind: "integration",
    integration_id: "integration_e2e",
    operation_id: "operation_e2e",
    expected_target_commit: commit("1"),
    operation_commit: commit("2"),
    lease_fencing_token: 3,
    ledger_sequence_rewrites: [],
    evidence_digests: [],
    approval_decision_digests: [],
    command_id: "command_prepare_e2e",
  });
}

function seedConnection(projectRoot: string, record: CollaborationConnectionRecord): void {
  const directory = join(
    projectRoot,
    ".harness",
    "collaboration",
    "connections",
    record.connection_id,
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `rev-${String(record.revision).padStart(12, "0")}.json`),
    `${canonicalizeJson(record)}\n`,
    "utf8",
  );
}

interface FakeCoordinator {
  readonly port: CollaborationCoordinatorPort;
  readonly queries: string[];
  readonly commands: CollaborationCommand[];
  conflicts: IntegrationRecord[];
}

function fakeCoordinator(projectId: string): FakeCoordinator {
  const queries: string[] = [];
  const commands: CollaborationCommand[] = [];
  const fake: FakeCoordinator = {
    queries,
    commands,
    conflicts: [integrationConflict()],
    port: {
      query: (query: CollaborationQuery) => {
        queries.push(query.kind);
        if (query.kind === "connection_status") {
          return Promise.resolve({
            kind: "connection_status" as const,
            project_id: projectId,
            status: "active" as const,
            connection: connectionRecord(projectId),
          });
        }
        if (query.kind === "approval_inbox") {
          return Promise.resolve({
            kind: "approval_inbox" as const,
            project_id: projectId,
            decisions: [remoteDecision()],
          });
        }
        if (query.kind === "integration_conflicts") {
          return Promise.resolve({
            kind: "integration_conflicts" as const,
            project_id: projectId,
            conflicts: fake.conflicts,
          });
        }
        return Promise.reject(new Error(`unexpected query ${query.kind}`));
      },
      execute: (command: CollaborationCommand) => {
        commands.push(command);
        if (command.kind === "accept_integration") {
          const record = fake.conflicts.find(
            (entry) => entry.integration_id === command.integration_id,
          );
          if (record === undefined) return Promise.reject(new Error("unknown integration"));
          fake.conflicts = [];
          return Promise.resolve({
            status: "accepted" as const,
            integration_record: record,
            target_commit: commit("3"),
            replayed: false,
          });
        }
        return Promise.reject(new Error(`unexpected command ${command.kind}`));
      },
    },
  };
  return fake;
}

interface DashboardFixture {
  readonly page: Page;
  readonly server: DashboardServer;
  readonly fake: FakeCoordinator;
  readonly factoryCalls: string[];
}

const test = base.extend<{ dashboard: DashboardFixture; connected: boolean }>({
  connected: [true, { option: true }],
  dashboard: async ({ page, connected }, use) => {
    const parent = mkdtempSync(join(tmpdir(), "harness-dashboard-m3-e2e-"));
    const created = await createNewProject(
      { parentDirectory: parent, name: "dashboard-m3-e2e", intent: "observe remote collaboration" },
      { vcs: createGitVcsAdapter() },
    );
    if (!created.ok) throw new Error(created.error.message);
    const projectRoot = created.value.projectRoot;
    const projectId = `project_${created.value.projectRoot.split("/").pop() ?? "e2e"}`;
    const connection = connectionRecord(projectId);
    if (connected) seedConnection(projectRoot, connection);
    const fake = fakeCoordinator(projectId);
    const factoryCalls: string[] = [];
    const server = await startDashboardServer({
      projectRoot,
      collaborationApi: createDashboardCollaborationApi({
        projectRoot,
        portForOrigin: (origin) => {
          factoryCalls.push(origin);
          return fake.port;
        },
      }),
    });
    await page.goto(server.bootstrapUrl);
    await expect(page).toHaveURL(server.origin + "/");
    try {
      await use({ page, server, fake, factoryCalls });
    } finally {
      await server.close();
      rmSync(parent, { recursive: true, force: true });
    }
  },
});

test.describe("Dashboard M3 remote collaboration views", () => {
  test("shows connection status, remote inbox and conflict retry against a fake coordinator", async ({
    dashboard,
  }) => {
    const { page, fake } = dashboard;

    // Connection Status on the Overview: Ledger fact plus observed projection.
    await expect(page.locator("#connection-state")).toHaveText("REMOTE");
    await expect(page.locator("#connection-copy")).toContainText(
      "https://coordinator.example.test",
    );
    const observed = page.locator("#connection-observed");
    await expect(observed).toBeVisible();
    await expect(observed).toContainText("远程协调事实");
    await expect(observed).toContainText("本地投影（observed_at");
    expect(fake.queries).toContain("connection_status");

    // Remote-aware Approval Inbox: the authoritative local queue keeps its
    // treatment; remote decisions are labelled 远程协调事实 with observed_at.
    await page.getByRole("link", { name: /Approvals/u }).click();
    await expect(page.getByRole("heading", { name: "Pending approvals" })).toBeVisible();
    await expect(page.locator("#approval-queue")).toContainText("当前没有待审批请求");
    await expect(page.getByRole("heading", { name: "远程审批收件箱" })).toBeVisible();
    const inboxCard = page.locator("#remote-inbox .remote-fact-card");
    await expect(inboxCard).toHaveCount(1);
    await expect(inboxCard).toContainText("远程协调事实");
    await expect(inboxCard).toContainText("approve · approval_req_e2e");
    await expect(page.locator("#remote-inbox-observed")).toContainText("本地投影（observed_at");

    // Integration Conflict panel with retry-after-human-resolution.
    await expect(page.getByRole("heading", { name: "Integration conflicts" })).toBeVisible();
    const conflictCard = page.locator("#conflict-list .remote-fact-card");
    await expect(conflictCard).toHaveCount(1);
    await expect(conflictCard).toContainText("integration_e2e");
    await conflictCard.getByRole("button", { name: "RESOLVE MANUALLY THEN RETRY" }).click();
    await expect(page.getByText(/accepted · target now at/u)).toBeVisible();
    expect(
      fake.commands.some(
        (command) =>
          command.kind === "accept_integration" &&
          command.integration_id === "integration_e2e" &&
          command.expected_target_commit === commit("1"),
      ),
    ).toBe(true);
    await expect(page.locator("#conflict-list")).toContainText(
      "没有待人工解决的 Integration 冲突。",
    );
  });
});

test.describe("Dashboard M3 disconnected project", () => {
  test.use({ connected: false });

  test("a never-connected project stays local-only and issues zero remote requests", async ({
    dashboard,
  }) => {
    const { page, fake, factoryCalls } = dashboard;

    const collaborationRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/v1/collaboration/")) {
        collaborationRequests.push(request.url());
      }
    });

    await expect(page.locator("#connection-state")).toHaveText("LOCAL");
    await expect(page.locator("#connection-observed")).toBeHidden();

    await page.getByRole("link", { name: /Approvals/u }).click();
    await expect(page.getByRole("heading", { name: "Pending approvals" })).toBeVisible();
    await expect(page.locator("#approval-queue")).toContainText("当前没有待审批请求");
    await expect(page.getByRole("heading", { name: "远程审批收件箱" })).toBeHidden();
    await expect(page.getByRole("heading", { name: "Integration conflicts" })).toBeHidden();

    // Only the local connection probe ran; the coordinator seam stayed cold.
    expect(collaborationRequests.filter((url) => !url.includes("connection"))).toEqual([]);
    expect(fake.queries).toEqual([]);
    expect(factoryCalls).toEqual([]);
  });
});
