import { afterEach, describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "../../adapters/vcs-git/src/index.js";

import {
  PROTOCOL_1_2_VERSION,
  LedgerRepository,
  appendProjectProfileRecord,
  assertProtocolReaderCanProject,
  buildOperationDag,
  compileCapabilityPlan,
  createProfileDecisionRecord,
  createProjectProfileRecord,
  type CapabilityPlanCompilationRequest,
  type CapabilityPlanRecord,
} from "../../packages/core/src/index.js";
import type { AgentRunResult, AgentTaskEnvelope } from "../../packages/plugin-sdk/src/index.js";
import {
  createLedgerSchedulerAuthority,
  createNewProject,
  resolveApproval,
  resumeIteration,
  runIteration,
  type OrchestrationOutcome,
  type OrchestratorDependencies,
  type PlanTasksPort,
  type TaskSpecification,
} from "../../packages/runtime/src/index.js";
import { projectIdFor } from "../../packages/runtime/src/bootstrap/staging.js";
import { capabilityPlanActivatesParallel } from "../../packages/runtime/src/orchestration/scheduler-runtime.js";
import {
  FIXED_NOW,
  cleanupDirectories,
  headOf,
  makeTempDir,
  sequentialIds,
} from "../../packages/runtime/test/bootstrap/helpers.js";
import {
  CAPTURE_POLICY_DIGEST,
  completingCaptureSeam,
} from "../../packages/runtime/test/orchestration/coordinated-capture-fixture.js";

const DIGEST = "a".repeat(64);
const NOW = "2026-09-02T00:00:00.000Z";
const INTENT = "ship four independently governed slices";
const SCHEDULER_EVENTS = new Set([
  "TaskLeaseGranted",
  "TaskDispatched",
  "TaskIntegrationQueued",
  "TaskCandidateValidated",
  "TaskRetryScheduled",
  "WaveGateCompleted",
  "WaveIntegrated",
  "SchedulerRecovered",
]);

afterEach(cleanupDirectories);

function liteCapabilityPlan() {
  const projectProfile = createProjectProfileRecord({
    project_id: "project_m4_compat",
    revision: 1,
    profile_id: "lite",
    policy_digest: DIGEST,
    actor: "human:compat",
    effective_from: NOW,
  });
  return compileCapabilityPlan({
    operation_id: "operation_m4_compat",
    stage: "final",
    protocol_version: "1.3.0",
    project_profile: projectProfile,
    profile_decision: createProfileDecisionRecord({
      decision_kind: "project_profile_change",
      project_id: "project_m4_compat",
      actor: "human:compat",
      idempotency_key: "profile-decision:m4-compat",
      current_profile_id: "lite",
      decided_profile_id: "lite",
      policy_digest: DIGEST,
      decided_at: NOW,
    }),
    requirement_digest: "b".repeat(64),
    risk_digest: "c".repeat(64),
    policy_digest: DIGEST,
    baseline_digest: "d".repeat(64),
    providers: ["isolated_workspace_provider", "structured_gate_provider"],
    model_providers: [],
  });
}

function taskResult(envelope: AgentTaskEnvelope): AgentRunResult {
  return {
    outcome: "handoff",
    termination_reason: "completion",
    completion_claimed: true,
    summary: `completed ${envelope.task_id}`,
    state_proposal: null,
    dropped_proposal_fields: [],
    change_summary: { files_changed: 0, insertions: 0, deletions: 0, paths: [] },
    tool_activity: { total_calls: 0, governed_calls: 0, by_tool: {} },
    usage: {
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      duration_ms: 0,
      metering: "unmetered",
    },
    evidence: [
      {
        kind: "attestation",
        locator: `fixture://${envelope.task_id}`,
        digest: "e".repeat(64),
      },
    ],
    undeclared_writes: [],
  };
}

function fourTaskPlan(): PlanTasksPort {
  return ({ requirements, impactPaths, acceptedTestIds, gateIds }) => {
    const requirementId = requirements[0]?.id ?? "requirement_none";
    const specification = (id: string, dependencies: readonly string[]): TaskSpecification => ({
      id,
      objective: id,
      impact_paths: impactPaths.map((path) => [...path]),
      expected_outputs: [requirementId],
      capabilities: [],
      tools: [],
      dependencies: [...dependencies],
      risk: "low",
      budget: { steps: 10, tokens: 1_000 },
      acceptance: [{ description: `${id} completes`, verification: "required gates pass" }],
      assertions: [
        {
          assertion_id: `assertion_${id}`,
          test_ids: [...acceptedTestIds],
          required_gate_ids: [...gateIds],
          evidence_requirements: ["gate_evidence"],
        },
      ],
      required_gates: [...gateIds],
    });
    return [
      specification("task_api", []),
      specification("task_ui", []),
      specification("task_contract", ["task_api", "task_ui"]),
      specification("task_release", ["task_contract"]),
    ];
  };
}

interface SequentialRun {
  readonly projectRoot: string;
  readonly operationId: string;
  readonly outcome: OrchestrationOutcome;
  readonly calls: readonly string[];
  readonly parallelCalls: number;
  readonly requestedProtocolVersions: readonly string[];
  readonly compiledPlans: readonly CapabilityPlanRecord[];
  readonly deps: OrchestratorDependencies;
}

async function runSequentialFixture(mode: "lite" | "protocol12"): Promise<SequentialRun> {
  const newId = sequentialIds();
  const name = `m4-sequential-${mode}`;
  const created = await createNewProject(
    { parentDirectory: makeTempDir("harness-m4-sequential-"), name, intent: INTENT },
    { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId },
  );
  if (!created.ok) throw new Error(created.error.message);
  const projectRoot = created.value.projectRoot;
  appendProjectProfileRecord(
    projectRoot,
    createProjectProfileRecord({
      project_id: projectIdFor(name),
      revision: 1,
      profile_id: "lite",
      policy_digest: CAPTURE_POLICY_DIGEST,
      actor: "human:m4-sequential",
      effective_from: FIXED_NOW,
    }),
  );

  const calls: string[] = [];
  let parallelCalls = 0;
  const requestedProtocolVersions: string[] = [];
  const compiledPlans: CapabilityPlanRecord[] = [];
  const deps: OrchestratorDependencies = {
    projectRoot,
    readBaseline: () => headOf(projectRoot),
    now: () => FIXED_NOW,
    newId,
    vcs: createGitVcsAdapter(),
    capture: completingCaptureSeam(projectRoot),
    planTasks: fourTaskPlan(),
    execution: {
      kind: "workflow",
      name: "m4-sequential-fixture",
      deterministic: true,
      execute: (envelope) => {
        calls.push(envelope.task_id);
        return Promise.resolve(taskResult(envelope));
      },
    },
    // This binding is deliberately present: routing, not missing
    // configuration, must keep old plans away from the M4 scheduler.
    parallelExecution: {
      port: {
        run: () => {
          parallelCalls += 1;
          throw new Error("sequential compatibility invoked the M4 scheduler");
        },
      },
      driverLock: () => {
        throw new Error("sequential compatibility requested a Driver Lock");
      },
    },
    ...(mode === "protocol12"
      ? {
          capabilityPlanCompiler: (request: CapabilityPlanCompilationRequest) => {
            requestedProtocolVersions.push(PROTOCOL_1_2_VERSION);
            const profile = createProjectProfileRecord({
              project_id: projectIdFor(name),
              revision: 1,
              profile_id: "lite",
              policy_digest: CAPTURE_POLICY_DIGEST,
              actor: "human:m4-sequential",
              effective_from: FIXED_NOW,
            });
            const compiled = compileCapabilityPlan({
              operation_id: request.operation_id,
              stage: "final",
              protocol_version: PROTOCOL_1_2_VERSION,
              project_profile: profile,
              profile_decision: createProfileDecisionRecord({
                decision_kind: "project_profile_change",
                project_id: projectIdFor(name),
                actor: "human:m4-sequential",
                idempotency_key: `profile-decision:${request.operation_id}`,
                current_profile_id: "lite",
                decided_profile_id: "lite",
                policy_digest: CAPTURE_POLICY_DIGEST,
                decided_at: FIXED_NOW,
              }),
              requirement_digest: request.requirement_digest,
              risk_digest: request.risk_digest,
              policy_digest: request.policy_digest,
              baseline_digest: request.baseline_digest,
            });
            compiledPlans.push(compiled);
            return compiled;
          },
        }
      : {}),
  };

  let outcome = await runIteration(deps, {
    intent: INTENT,
    iterationId: created.value.iterationId,
  });
  const operationId =
    outcome.status === "approval_required"
      ? outcome.required.workflow_operation_id
      : (() => {
          throw new Error(`expected capture approval, got ${outcome.status}`);
        })();
  while (outcome.status === "approval_required") {
    await resolveApproval(deps, {
      requestId: outcome.required.request_id,
      decision: "approve",
      actor: "human:m4-sequential",
    });
    outcome = await resumeIteration(deps, operationId, undefined);
  }
  return {
    projectRoot,
    operationId,
    outcome,
    calls,
    parallelCalls,
    requestedProtocolVersions,
    compiledPlans,
    deps,
  };
}

async function expectNoM4Authority(run: SequentialRun): Promise<void> {
  expect(run.outcome.status).toBe("completed");
  expect(run.calls).toEqual(["task_api", "task_ui", "task_contract", "task_release"]);
  expect(run.parallelCalls).toBe(0);
  const facts = await createLedgerSchedulerAuthority({ deps: run.deps }).readFacts(run.operationId);
  expect(facts.leases).toEqual([]);
  expect(facts.wave_integrations).toEqual([]);
  expect(facts.candidate_patches ?? []).toEqual([]);
  expect(facts.approvals.filter((approval) => approval.object_type === "scheduler_action")).toEqual(
    [],
  );
  expect(
    facts.gate_evidence.filter(
      (evidence) => evidence.extensions?.["harness.scheduling"] !== undefined,
    ),
  ).toEqual([]);
  const events = new LedgerRepository({
    projectRoot: run.projectRoot,
    readBaseline: () => headOf(run.projectRoot),
  })
    .replay()
    .events.filter((event) => event.workflow_operation_id === run.operationId);
  expect(events.filter((event) => SCHEDULER_EVENTS.has(event.event_type))).toEqual([]);
}

describe("M4 sequential compatibility", () => {
  it("keeps Lite on the legacy execute path without M4 authority or events", () => {
    const plan = liteCapabilityPlan();
    expect(plan.protocol_version).toBe("1.1.0");
    expect(capabilityPlanActivatesParallel(plan)).toBe(false);
    expect(
      plan.capabilities.some((entry) => entry.capability_id === "parallel_task_execution"),
    ).toBe(false);
    const execute = plan.operation_dag.nodes.find((node) => node.node_id === "execute");
    expect(execute?.subgraph).toBeUndefined();
    expect(execute?.produces).not.toContain("wave_integration");
    expect(JSON.stringify(plan)).not.toMatch(
      /TaskLeaseGranted|WaveIntegrated|task_lease|wave_integration/u,
    );
  });

  it("keeps a Protocol 1.2 operation DAG byte-compatible and sequential", () => {
    const dag = buildOperationDag(new Set(), PROTOCOL_1_2_VERSION);
    const execute = dag.find((node) => node.node_id === "execute");
    expect(execute?.subgraph).toBeUndefined();
    expect(dag.flatMap((node) => [...node.consumes, ...node.produces])).not.toContain(
      "wave_integration",
    );
    expect(() =>
      assertProtocolReaderCanProject({
        readerVersion: PROTOCOL_1_2_VERSION,
        recordVersion: PROTOCOL_1_2_VERSION,
        authoritative: true,
      }),
    ).not.toThrow();
  });

  it("runs the four-task Lite fixture through execute, verify and snapshot without M4 authority", async () => {
    const run = await runSequentialFixture("lite");
    await expectNoM4Authority(run);
    expect(run.requestedProtocolVersions).toEqual([]);
    expect(run.compiledPlans).toEqual([]);
  }, 60_000);

  it("runs the same four-task Protocol 1.2 fixture sequentially without M4 authority", async () => {
    const run = await runSequentialFixture("protocol12");
    await expectNoM4Authority(run);
    expect(run.requestedProtocolVersions).toEqual([PROTOCOL_1_2_VERSION]);
    expect(run.compiledPlans).toHaveLength(1);
    expect(run.compiledPlans[0]?.protocol_version).toBe("1.1.0");
    expect(capabilityPlanActivatesParallel(run.compiledPlans[0] as CapabilityPlanRecord)).toBe(
      false,
    );
    expect(
      run.compiledPlans[0]?.operation_dag.nodes.find((node) => node.node_id === "execute")
        ?.subgraph,
    ).toBeUndefined();
  }, 60_000);
});
