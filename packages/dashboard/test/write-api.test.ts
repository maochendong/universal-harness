import { afterEach, describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";
import { createNewProject } from "@universal-harness-internal/runtime";

import {
  DashboardWriteError,
  startDashboardServer,
  type DashboardServer,
  type DashboardWriteApi,
} from "../src/index.js";

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
  const parent = mkdtempSync(join(tmpdir(), "harness-dashboard-write-"));
  roots.push(parent);
  const created = await createNewProject(
    { parentDirectory: parent, name: "dashboard-write", intent: "test controlled writes" },
    { vcs: createGitVcsAdapter() },
  );
  if (!created.ok) throw new Error(created.error.message);
  return created.value.projectRoot;
}

async function session(server: DashboardServer): Promise<{ cookie: string; csrf: string }> {
  const exchange = await fetch(server.bootstrapUrl, { redirect: "manual" });
  const cookie = (exchange.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
  const response = await fetch(`${server.origin}/api/v1/session`, { headers: { cookie } });
  const body = (await response.json()) as { data: { csrf_token: string } };
  return { cookie, csrf: body.data.csrf_token };
}

function headers(
  server: DashboardServer,
  auth: { cookie: string; csrf: string },
): Record<string, string> {
  return {
    cookie: auth.cookie,
    origin: server.origin,
    "content-type": "application/json",
    "x-harness-csrf": auth.csrf,
  };
}

describe("Dashboard write API", () => {
  it("requires same-origin CSRF and forwards an exact digest and actor to the approval service", async () => {
    const calls: unknown[] = [];
    const writeApi: DashboardWriteApi = {
      decideApproval: (input) => {
        calls.push(input);
        return Promise.resolve({ request_id: input.requestId, decision: input.decision });
      },
      resumeWorkflow: () => Promise.resolve({ status: "resumed" }),
      resolveFindingGroup: () => Promise.resolve({ status: "resolved" }),
    };
    const server = await startDashboardServer({ projectRoot: await project(), writeApi });
    servers.push(server);
    const auth = await session(server);
    const body = JSON.stringify({
      decision: "approve",
      expected_digest: "a".repeat(64),
      actor: "human:web-reviewer",
    });

    const missingCsrf = await fetch(`${server.origin}/api/v1/approvals/approval_01/decision`, {
      method: "POST",
      headers: { ...headers(server, auth), "x-harness-csrf": "" },
      body,
    });
    expect(missingCsrf.status).toBe(403);

    const missingOrigin = await fetch(`${server.origin}/api/v1/approvals/approval_01/decision`, {
      method: "POST",
      headers: {
        cookie: auth.cookie,
        "content-type": "application/json",
        "x-harness-csrf": auth.csrf,
      },
      body,
    });
    expect(missingOrigin.status).toBe(403);

    const accepted = await fetch(`${server.origin}/api/v1/approvals/approval_01/decision`, {
      method: "POST",
      headers: headers(server, auth),
      body,
    });
    expect(accepted.status).toBe(200);
    expect(calls).toEqual([
      {
        requestId: "approval_01",
        decision: "approve",
        expectedDigest: "a".repeat(64),
        actor: "human:web-reviewer",
      },
    ]);
  });

  it("returns 409 on digest drift and never retries the mutation", async () => {
    let calls = 0;
    const writeApi: DashboardWriteApi = {
      decideApproval: () => {
        calls += 1;
        return Promise.reject(
          new DashboardWriteError("conflict", "approval binding changed; refresh first"),
        );
      },
      resumeWorkflow: () => Promise.resolve({ status: "resumed" }),
      resolveFindingGroup: () => Promise.resolve({ status: "resolved" }),
    };
    const server = await startDashboardServer({ projectRoot: await project(), writeApi });
    servers.push(server);
    const auth = await session(server);

    const response = await fetch(`${server.origin}/api/v1/approvals/approval_01/decision`, {
      method: "POST",
      headers: headers(server, auth),
      body: JSON.stringify({
        decision: "reject",
        expected_digest: "b".repeat(64),
        actor: "human:web-reviewer",
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "write_conflict" });
    expect(calls).toBe(1);
  });

  it("routes resume and finding-group actions through the restricted service port", async () => {
    const calls: unknown[] = [];
    const writeApi: DashboardWriteApi = {
      decideApproval: () => Promise.resolve({ status: "decided" }),
      resumeWorkflow: (input) => {
        calls.push(["resume", input]);
        return Promise.resolve({ status: "resumed" });
      },
      resolveFindingGroup: (input) => {
        calls.push(["finding", input]);
        return Promise.resolve({ status: "resolved" });
      },
    };
    const server = await startDashboardServer({ projectRoot: await project(), writeApi });
    servers.push(server);
    const auth = await session(server);

    const resume = await fetch(`${server.origin}/api/v1/workflows/workflow_01/resume`, {
      method: "POST",
      headers: headers(server, auth),
      body: JSON.stringify({ expected_digest: "c".repeat(64), actor: "human:operator" }),
    });
    expect(resume.status).toBe(200);
    const finding = await fetch(`${server.origin}/api/v1/finding-groups/group_01/resolve`, {
      method: "POST",
      headers: headers(server, auth),
      body: JSON.stringify({
        action: "supersede",
        expected_digest: "d".repeat(64),
        actor: "human:operator",
      }),
    });
    expect(finding.status).toBe(200);
    expect(calls).toEqual([
      [
        "resume",
        {
          workflowOperationId: "workflow_01",
          expectedDigest: "c".repeat(64),
          actor: "human:operator",
        },
      ],
      [
        "finding",
        {
          groupId: "group_01",
          action: "supersede",
          expectedDigest: "d".repeat(64),
          actor: "human:operator",
        },
      ],
    ]);
  });
});
