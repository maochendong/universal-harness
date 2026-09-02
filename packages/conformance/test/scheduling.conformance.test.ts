import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, it } from "vitest";

import type { AgentProviderManifest } from "@universal-harness-internal/plugin-sdk";

import { taskSemanticDigest } from "../../runtime/src/planning/task.js";
import { compileParallelWaves } from "../../runtime/src/planning/waves.js";
import { decideAction } from "../../runtime/src/policy/evaluator.js";
import {
  createInMemoryPolicyDecisionPort,
  createPolicyDecisionAdapter,
} from "../../runtime/src/scheduling/policy-adapters.js";
import {
  createInMemorySchedulerProjectionStore,
  createSqliteSchedulerProjectionStore,
} from "../../runtime/src/scheduling/sqlite-projection.js";
import {
  createInMemoryTaskDagPort,
  createWorkflowTaskDagAdapter,
} from "../../runtime/src/scheduling/task-dag-adapters.js";
import { createGitWorktreeWorkspacePort } from "../../runtime/src/tdd/git-workspace.js";
import { createInMemoryWorkspacePort } from "../../runtime/src/tdd/workspace.js";

import {
  assertConformance,
  agentControlProfileCases,
  bindTaskDagFixtureHooks,
  policyDecisionPortConformanceCases,
  runConformanceSuite,
  schedulerProjectionConformanceCases,
  taskDagPortConformanceCases,
  workspaceConformanceCases,
  type AgentFixtureFactory,
  type PolicyDecisionPortFactory,
  type SchedulerProjectionFactory,
  type SchedulerPolicyFixture,
  type TaskDagPortFactory,
  type WorkspaceFactory,
} from "../src/index.js";

/**
 * Plan Task 4 steps 1/3: the shared TaskDagPort and PolicyDecisionPort
 * conformance suites run against the production Workflow/Policy Adapters and
 * the InMemory Adapters alike. The scheduling ports are runtime-internal, so
 * the Adapters and the runtime-internal fixture hooks enter through relative
 * source imports here — the conformance sources themselves only ever see the
 * port types.
 */

bindTaskDagFixtureHooks({ taskSemanticDigest, compileParallelWaves });

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

const workflowTaskDagFactory: TaskDagPortFactory = {
  create: (fixture) =>
    createWorkflowTaskDagAdapter({
      // Narrow read functions only: the Adapter never sees a write capability.
      readPlan: (operationId) => (operationId === fixture.operation_id ? fixture.plan : undefined),
      readTaskNodes: (planId) => (planId === fixture.plan.id ? fixture.task_nodes : []),
      readEdgeRecords: (planId) => (planId === fixture.plan.id ? fixture.edges : []),
      readApprovedBaseline: (operationId) =>
        operationId === fixture.operation_id ? fixture.baseline_commit : undefined,
    }),
};

const inMemoryTaskDagFactory: TaskDagPortFactory = {
  create: (fixture) => createInMemoryTaskDagPort(fixture),
};

const productionPolicyFactory: PolicyDecisionPortFactory = {
  create: (fixture: SchedulerPolicyFixture) =>
    createPolicyDecisionAdapter({
      readLayers: () => fixture.layers,
      readGrant: (taskKey) =>
        fixture.grant !== undefined && taskKey === fixture.grant_task_digest
          ? fixture.grant
          : undefined,
    }),
};

const inMemoryPolicyFactory: PolicyDecisionPortFactory = {
  create: (fixture: SchedulerPolicyFixture) =>
    createInMemoryPolicyDecisionPort({
      resolve: (action, input) =>
        decideAction(
          fixture.layers,
          action,
          fixture.grant !== undefined && input.task_digest === fixture.grant_task_digest
            ? fixture.grant
            : undefined,
        ),
    }),
};

describe("TaskDagPort conformance", () => {
  it("passes the shared suite with the production Workflow Adapter", async () => {
    const report = await runConformanceSuite({
      plugin: "runtime-workflow-task-dag",
      kind: "agent",
      cases: taskDagPortConformanceCases(workflowTaskDagFactory),
    });
    assertConformance(report);
  });

  it("passes the shared suite with the InMemory Adapter", async () => {
    const report = await runConformanceSuite({
      plugin: "in-memory-task-dag",
      kind: "agent",
      cases: taskDagPortConformanceCases(inMemoryTaskDagFactory),
    });
    assertConformance(report);
  });
});

describe("PolicyDecisionPort conformance", () => {
  it("passes the shared suite with the production Policy Adapter", async () => {
    const report = await runConformanceSuite({
      plugin: "runtime-policy-decision",
      kind: "agent",
      cases: policyDecisionPortConformanceCases(productionPolicyFactory),
    });
    assertConformance(report);
  });

  it("passes the shared suite with the InMemory Adapter", async () => {
    const report = await runConformanceSuite({
      plugin: "in-memory-policy-decision",
      kind: "agent",
      cases: policyDecisionPortConformanceCases(inMemoryPolicyFactory),
    });
    assertConformance(report);
  });
});

const inMemoryWorkspaceFactory: WorkspaceFactory = () => ({
  port: createInMemoryWorkspacePort({ "README.md": "baseline\n" }, { baseline_commit: "mem-base" }),
  baseline_commit: "mem-base",
});

const gitWorkspaceFactory: WorkspaceFactory = () => {
  const repositoryRoot = temporaryRoot("harness-workspace-conformance-");
  execFileSync("git", ["init", "-q"], { cwd: repositoryRoot });
  execFileSync("git", ["config", "user.name", "Harness Conformance"], {
    cwd: repositoryRoot,
  });
  execFileSync("git", ["config", "user.email", "conformance@harness.invalid"], {
    cwd: repositoryRoot,
  });
  writeFileSync(join(repositoryRoot, "README.md"), "baseline\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repositoryRoot });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: repositoryRoot });
  const baseline = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const workspaceRoot = temporaryRoot("harness-workspace-conformance-slots-");
  const port = createGitWorktreeWorkspacePort({ repositoryRoot, workspaceRoot });
  return { port, baseline_commit: baseline };
};

const inMemoryProjectionFactory: SchedulerProjectionFactory = () => ({
  store: createInMemorySchedulerProjectionStore(),
});

const sqliteProjectionFactory: SchedulerProjectionFactory = () => {
  const root = temporaryRoot("harness-projection-conformance-");
  const store = createSqliteSchedulerProjectionStore({ path: join(root, "scheduler.sqlite") });
  return { store, cleanup: () => store.close() };
};

const manifestByControl: Record<"managed" | "delegated" | "manual", AgentProviderManifest> = {
  managed: {
    provider: "managed-conformance",
    control: "managed",
    trajectory_visibility: "full",
    usage_metering: true,
    side_effect_interception: true,
    resume_semantics: "explicit",
  },
  delegated: {
    provider: "delegated-conformance",
    control: "delegated",
    trajectory_visibility: "summarized",
    usage_metering: true,
    side_effect_interception: true,
    resume_semantics: "explicit",
  },
  manual: {
    provider: "manual-conformance",
    control: "manual",
    trajectory_visibility: "external-only",
    usage_metering: false,
    side_effect_interception: false,
    resume_semantics: "none",
  },
};

const agentFixtureFactory: AgentFixtureFactory = {
  create: (control) => ({ manifest: manifestByControl[control] }),
};

describe("IsolatedWorkspacePort conformance", () => {
  it("passes the shared suite with the InMemory workspace", async () => {
    assertConformance(
      await runConformanceSuite({
        plugin: "in-memory-isolated-workspace",
        kind: "agent",
        cases: workspaceConformanceCases(inMemoryWorkspaceFactory),
      }),
    );
  });

  it("passes the shared suite with the real Git worktree workspace", async () => {
    assertConformance(
      await runConformanceSuite({
        plugin: "git-worktree-isolated-workspace",
        kind: "agent",
        cases: workspaceConformanceCases(gitWorkspaceFactory),
      }),
    );
  });
});

describe("SchedulerProjectionStore conformance", () => {
  it("passes the shared suite with the InMemory projection", async () => {
    assertConformance(
      await runConformanceSuite({
        plugin: "in-memory-scheduler-projection",
        kind: "agent",
        cases: schedulerProjectionConformanceCases(inMemoryProjectionFactory),
      }),
    );
  });

  it("passes the shared suite with the SQLite projection", async () => {
    assertConformance(
      await runConformanceSuite({
        plugin: "sqlite-scheduler-projection",
        kind: "agent",
        cases: schedulerProjectionConformanceCases(sqliteProjectionFactory),
      }),
    );
  });
});

describe("Agent control profile conformance", () => {
  it("classifies managed, delegated and manual fixtures through one suite", async () => {
    assertConformance(
      await runConformanceSuite({
        plugin: "agent-control-profiles",
        kind: "agent",
        cases: agentControlProfileCases(agentFixtureFactory),
      }),
    );
  });
});
