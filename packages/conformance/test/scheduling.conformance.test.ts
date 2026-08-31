import { describe, it } from "vitest";

import { taskSemanticDigest } from "../../runtime/src/planning/task.js";
import { compileParallelWaves } from "../../runtime/src/planning/waves.js";
import { decideAction } from "../../runtime/src/policy/evaluator.js";
import {
  createInMemoryPolicyDecisionPort,
  createPolicyDecisionAdapter,
} from "../../runtime/src/scheduling/policy-adapters.js";
import {
  createInMemoryTaskDagPort,
  createWorkflowTaskDagAdapter,
} from "../../runtime/src/scheduling/task-dag-adapters.js";

import {
  assertConformance,
  bindTaskDagFixtureHooks,
  policyDecisionPortConformanceCases,
  runConformanceSuite,
  taskDagPortConformanceCases,
  type PolicyDecisionPortFactory,
  type SchedulerPolicyFixture,
  type TaskDagPortFactory,
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
