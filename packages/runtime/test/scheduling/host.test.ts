import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";
import {
  canonicalizeJson,
  compileCapabilityPlan,
  contentDigest,
  createProfileDecisionRecord,
  createProjectProfileRecord,
  harnessRootFor,
  type CapabilityPlanRecord,
  type TaskLeaseRecord,
} from "@universal-harness-internal/core";
import type {
  AgentAdapter,
  AgentProviderManifest,
  AgentRunResult,
} from "@universal-harness-internal/plugin-sdk";

import {
  ApprovalService,
  createLedgerSchedulerAuthority,
  createNewProject,
  createProjectSchedulerHost,
  operationRefFor,
  type ProjectSchedulerHost,
} from "../../src/index.js";
import { commitArtifacts } from "../../src/orchestration/kernel-coordinator.js";
import { driverLockDirectoryName } from "../../src/scheduling/driver-lock.js";
import {
  generateKernelExecutionPlan,
  readExecutionPlanContent,
} from "../../src/planning/execution-plan.js";
import { actionDigest } from "../../src/policy/action.js";
import { buildDecision } from "../../src/policy/decision.js";
import { mergePolicyLayers } from "../../src/policy/evaluator.js";
import {
  WorkflowEngine,
  ledgerRepositoryFor,
  type WorkflowDependencies,
} from "../../src/workflow/operation.js";
import { FIXED_NOW, cleanupDirectories, headOf, makeTempDir } from "../bootstrap/helpers.js";
import { proveM4FaultInvariants } from "../../../../tests/fault/support/m4-fault-invariants.js";
import { PLAN_CONSTRAINTS, approvedImpactSet, entryPath } from "../planning/fixtures.js";
import { makeStartInput } from "../workflow/helpers.js";

/**
 * Project Scheduler Host composition (M4 plan Task 12 blocker): the host
 * factory assembles every internal scheduling component around a real project
 * and exposes only the ParallelExecutionBinding, the Scheduler Read Model and
 * the Driver Lock acquisition. These tests drive a real two-task/two-wave
 * operation end to end: real Ledger authority, real git worktrees and wave
 * integration, the real default gate suite — only the policy resolver and the
 * agent slot factory are substituted.
 */
afterEach(cleanupDirectories);

const ITERATION_ID = "iteration_host1";
const REQUIREMENT_DIGEST = "a".repeat(64);
const POLICY_DIGEST = "b".repeat(64);

const BUDGETS = {
  task_ceiling: { steps: 100, tokens: 100_000, duration_ms: 600_000 },
  iteration_ceiling: { steps: 1_000, tokens: 1_000_000, duration_ms: 3_600_000 },
  iteration: { steps: 50, tokens: 50_000, duration_ms: 1_200_000 },
} as const;

const FAKE_MANIFEST: AgentProviderManifest = {
  provider: "fake",
  control: "managed",
  trajectory_visibility: "full",
  usage_metering: true,
  side_effect_interception: true,
  resume_semantics: "explicit",
};

function stubResult(): AgentRunResult {
  return {
    outcome: "handoff",
    termination_reason: "completion",
    completion_claimed: true,
    summary: "done",
    state_proposal: null,
    dropped_proposal_fields: [],
    change_summary: { files_changed: 1, insertions: 1, deletions: 0, paths: [] },
    tool_activity: { total_calls: 0, governed_calls: 0, by_tool: {} },
    usage: {
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      duration_ms: 1,
      metering: "unmetered",
    },
    evidence: [],
    undeclared_writes: [],
  };
}

function crashResult(): AgentRunResult {
  return {
    ...stubResult(),
    outcome: "failed",
    termination_reason: "adapter_failure",
    completion_claimed: false,
    usage: {
      input_tokens: 60,
      output_tokens: 40,
      total_tokens: 100,
      duration_ms: 5,
      metering: "provider_reported",
    },
    budget_observations: [
      {
        dimension: "steps",
        availability: "measured",
        used: 2,
        limit: 10,
        enforcement: "harness",
      },
      {
        dimension: "tokens",
        availability: "measured",
        used: 100,
        limit: 1_000,
        enforcement: "harness",
      },
    ],
  };
}

/** Sequential mint; workflow and ledger ids stay deterministic per test. */
function sequentialIds(): (kind: string) => string {
  const counters = new Map<string, number>();
  return (kind) => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${kind}_h${String(next).padStart(3, "0")}`;
  };
}

function readGitRef(root: string, ref: string): string | undefined {
  try {
    const value = execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

interface DrivenProject {
  readonly projectRoot: string;
  readonly deps: WorkflowDependencies;
  readonly host: ProjectSchedulerHost;
  readonly operationId: string;
  readonly attemptId: string;
  readonly capabilityPlan: CapabilityPlanRecord;
  readonly planContentDigest: string;
  readonly lockDirectory: string;
  readonly projectionStorePath?: string;
  readonly createHost: (overrides?: {
    readonly adapterManifestDigest?: string;
  }) => ProjectSchedulerHost;
  readonly runStarted: Promise<void>;
}

/**
 * A real adopted-style project carrying: one workflow operation, an accepted
 * Protocol 1.3 CapabilityPlan that activates parallel_task_execution, and an
 * accepted Protocol 1.3 ExecutionPlan with task_api → task_web on two waves —
 * every record committed through the production write path.
 */
async function makeDrivenProject(
  options: {
    readonly sqliteProjection?: boolean;
    readonly abortableRun?: boolean;
    readonly ignoreAbort?: boolean;
    readonly crashFirstRun?: boolean;
    readonly approvalActions?: readonly ("dispatch_task" | "retry_task" | "integrate_wave")[];
  } = {},
): Promise<DrivenProject> {
  // One shared mint across bootstrap and setup: the Ledger rejects two events
  // with the same id and different content, so separate counters collide.
  const newId = sequentialIds();
  const created = await createNewProject(
    {
      parentDirectory: makeTempDir("harness-host-"),
      name: "host-demo",
      intent: "add the first capability",
    },
    { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId },
  );
  if (!created.ok) throw new Error(created.error.message);
  const projectRoot = created.value.projectRoot;
  const baseline = headOf(projectRoot);
  // The host mints ledger/event ids through its own namespace: sharing the
  // setup sequence would collide identical id strings with different content.
  const hostIds = sequentialIds();
  const hostNewId = (kind: string): string => `host_${hostIds(kind)}`;
  let adapterRunCount = 0;
  let markRunStarted: (() => void) | undefined;
  const runStarted = new Promise<void>((resolve) => {
    markRunStarted = resolve;
  });
  const deps: WorkflowDependencies = {
    projectRoot,
    readBaseline: () => headOf(projectRoot),
    now: () => FIXED_NOW,
    newId,
  };

  const engine = new WorkflowEngine(deps);
  const started = await engine.startOperation(
    makeStartInput({
      iterationId: ITERATION_ID,
      baselineCommit: baseline,
      requirementBaselineDigest: REQUIREMENT_DIGEST,
      policyDigest: POLICY_DIGEST,
    }),
  );
  const operationId = started.operation.workflow_operation_id;
  const attemptId = started.operation.attempt_id;

  const capabilityPlan = compileCapabilityPlan({
    operation_id: operationId,
    stage: "final",
    protocol_version: "1.3.0",
    project_profile: createProjectProfileRecord({
      project_id: "project_host-demo",
      revision: 1,
      profile_id: "lite",
      policy_digest: POLICY_DIGEST,
      actor: "human:test",
      effective_from: FIXED_NOW,
    }),
    profile_decision: createProfileDecisionRecord({
      decision_kind: "project_profile_change",
      project_id: "project_host-demo",
      actor: "human:test",
      idempotency_key: `profile-decision:host:${operationId}`,
      current_profile_id: "lite",
      decided_profile_id: "lite",
      policy_digest: POLICY_DIGEST,
      decided_at: FIXED_NOW,
    }),
    requirement_digest: REQUIREMENT_DIGEST,
    risk_digest: contentDigest({ risk: "host-test" }),
    policy_digest: POLICY_DIGEST,
    baseline_digest: contentDigest({ baseline }),
    policy: { required_capabilities: ["parallel_task_execution"] },
    providers: ["isolated_workspace_provider", "structured_gate_provider"],
  }) as CapabilityPlanRecord;
  await commitArtifacts(deps, operationId, attemptId, [
    {
      path: `artifacts/capability-plans/${capabilityPlan.capability_plan_id}/${String(capabilityPlan.revision)}.json`,
      content: `${canonicalizeJson(capabilityPlan)}\n`,
    },
  ]);

  // A real Protocol 1.3 plan from the production kernel compiler; the plan
  // node enters accepted exactly as its approval would leave it.
  const { impactSet } = approvedImpactSet();
  const records = generateKernelExecutionPlan(
    impactSet,
    {
      executionKind: "workflow",
      intentShape: "structured",
      hasExistingGraph: true,
      deterministicWork: true,
      shared: {
        goal: "ship the demo feature",
        requirement_baseline_digest: REQUIREMENT_DIGEST,
        policy_digest: POLICY_DIGEST,
        baseline_commit: baseline,
        capability_plan_digest: capabilityPlan.record_digest,
      },
      constraints: {
        ...PLAN_CONSTRAINTS,
        knownGates: [...PLAN_CONSTRAINTS.knownGates, "gate_ledger_integrity"],
        repository_root: projectRoot,
      },
      protocol: "protocol13",
      budgets: BUDGETS,
      proposal: [
        {
          id: "task_api",
          objective: "build the api slice",
          impact_paths: [entryPath(impactSet, "requirement_01"), entryPath(impactSet, "test_01")],
          expected_outputs: ["requirement_01", "test_01"],
          capabilities: ["fs.read", "fs.write"],
          tools: ["tool:fs"],
          dependencies: [],
          risk: "low",
          budget: { steps: 10, tokens: 1_000, duration_ms: 300_000 },
          write_paths: ["src/task_api"],
          exclusive_resources: [],
          acceptance: [{ description: "api works", verification: "unit test" }],
          required_gates: ["gate_ledger_integrity"],
        },
        {
          id: "task_web",
          objective: "build the web slice",
          impact_paths: [
            entryPath(impactSet, "decision_01"),
            entryPath(impactSet, "component_01"),
            entryPath(impactSet, "code_01"),
          ],
          expected_outputs: ["decision_01", "component_01", "code_01"],
          capabilities: ["fs.read", "fs.write"],
          tools: ["tool:fs"],
          dependencies: ["task_api"],
          risk: "low",
          budget: { steps: 10, tokens: 1_000, duration_ms: 300_000 },
          write_paths: ["src/task_web"],
          exclusive_resources: [],
          acceptance: [{ description: "web works", verification: "unit test" }],
          required_gates: ["gate_ledger_integrity"],
        },
      ],
    },
    { iterationId: ITERATION_ID, actor: "host-test", timestamp: FIXED_NOW },
  );
  const planContentDigest = readExecutionPlanContent(records.plan, {
    tasks: records.tasks,
    edges: records.edges,
  }).content_digest;
  const acceptedPlanDraft = Object.fromEntries(
    Object.entries(records.plan).filter(([key]) => key !== "digest"),
  ) as Record<string, unknown>;
  acceptedPlanDraft.status = "accepted";
  const acceptedPlan = {
    ...acceptedPlanDraft,
    digest: contentDigest(acceptedPlanDraft),
  } as unknown as typeof records.plan;
  await commitArtifacts(
    deps,
    operationId,
    attemptId,
    [
      {
        path: `artifacts/plans/${acceptedPlan.id}.json`,
        content: `${canonicalizeJson(acceptedPlan)}\n`,
      },
      ...records.tasks.map((task) => ({
        path: `artifacts/tasks/${task.id}.json`,
        content: `${canonicalizeJson(task)}\n`,
      })),
    ],
    records.edges,
  );

  const lockDirectory = join(
    harnessRootFor(projectRoot),
    "locks",
    driverLockDirectoryName(operationId),
  );
  const projectionStorePath = options.sqliteProjection
    ? join(harnessRootFor(projectRoot), "scheduler-projection-real.sqlite")
    : undefined;
  const hostOptions = {
    projectRoot,
    readBaseline: () => headOf(projectRoot),
    agentSlotFactory: {
      adapter_manifest_digest: contentDigest({ adapter: "fake-slot-adapter" }),
      manifest: FAKE_MANIFEST,
      create: ({ worktree_root }): AgentAdapter => ({
        name: "fake-slot-adapter",
        manifest: FAKE_MANIFEST,
        run: (envelope, runOptions) => {
          adapterRunCount += 1;
          // The Driver Lock must be held while any task executes.
          expect(existsSync(lockDirectory)).toBe(true);
          const writeScope = envelope.proposed_write_paths[0];
          if (writeScope === undefined) throw new Error("envelope carries no write scope");
          const directory = join(worktree_root, writeScope);
          mkdirSync(directory, { recursive: true });
          writeFileSync(
            join(directory, "outcome.ts"),
            `export const task = ${JSON.stringify(envelope.task_id)};\n`,
          );
          markRunStarted?.();
          if (options.crashFirstRun && adapterRunCount === 1) {
            return Promise.resolve(crashResult());
          }
          if (options.abortableRun || (options.ignoreAbort && adapterRunCount === 1)) {
            return new Promise<AgentRunResult>((resolve) => {
              runOptions.signal?.addEventListener(
                "abort",
                () =>
                  resolve(
                    options.ignoreAbort
                      ? stubResult()
                      : {
                          ...stubResult(),
                          outcome: "partial",
                          termination_reason: "user_cancellation",
                          completion_claimed: false,
                          summary: "cancelled cooperatively",
                        },
                  ),
                { once: true },
              );
            });
          }
          return Promise.resolve(stubResult());
        },
      }),
    },
    adapterCapabilities: ["fs.read", "fs.write"],
    maxConcurrency: 2,
    policyResolver: (action) => {
      const requiresApproval = options.approvalActions?.includes(
        action.kind as "dispatch_task" | "retry_task" | "integrate_wave",
      );
      return buildDecision({
        outcome:
          requiresApproval && action.approval_digest === undefined ? "requires_approval" : "allow",
        reasons: requiresApproval ? ["release policy requires approval"] : [],
        action_digest: actionDigest(action),
        effective: mergePolicyLayers([]).effective,
        ...(action.approval_digest === undefined
          ? {}
          : { approval_digest: action.approval_digest }),
      });
    },
    projectionStorePath: projectionStorePath ?? ":memory:",
    now: () => FIXED_NOW,
    newId: hostNewId,
  } as const;
  const createHost = (
    overrides: { readonly adapterManifestDigest?: string } = {},
  ): ProjectSchedulerHost =>
    createProjectSchedulerHost({
      ...hostOptions,
      agentSlotFactory: {
        ...hostOptions.agentSlotFactory,
        adapter_manifest_digest:
          overrides.adapterManifestDigest ?? hostOptions.agentSlotFactory.adapter_manifest_digest,
      },
    });
  const host = createHost();
  return {
    projectRoot,
    deps,
    host,
    operationId,
    attemptId,
    capabilityPlan,
    planContentDigest,
    lockDirectory,
    ...(projectionStorePath === undefined ? {} : { projectionStorePath }),
    createHost,
    runStarted,
  };
}

describe("createProjectSchedulerHost", () => {
  it.each([
    { action: "dispatch_task" as const, crashFirstRun: false },
    { action: "retry_task" as const, crashFirstRun: true },
    { action: "integrate_wave" as const, crashFirstRun: false },
  ])(
    "resumes a digest-bound $action after its committed workflow approval",
    async (scenario) => {
      const fixture = await makeDrivenProject({
        approvalActions: [scenario.action],
        crashFirstRun: scenario.crashFirstRun,
      });
      const input = {
        operation_id: fixture.operationId,
        iteration_id: ITERATION_ID,
        capability_plan_digest: fixture.capabilityPlan.record_digest,
        expected_plan_digest: fixture.planContentDigest,
      } as const;
      const first = await fixture.host.parallelExecution.port.run({
        ...input,
        driver_lock: fixture.host.parallelExecution.driverLock(),
      });
      expect(first.status).toBe("paused");
      const before = await createLedgerSchedulerAuthority({ deps: fixture.deps }).readFacts(
        fixture.operationId,
      );
      if (scenario.action === "dispatch_task") {
        expect(before.leases).toEqual([]);
        expect(before.runs).toEqual([]);
      }

      const approvals = new ApprovalService(fixture.deps);
      let resumed = first;
      for (let approved = 0; approved < 4 && resumed.status === "paused"; approved += 1) {
        const request = approvals.nextPendingRequest(fixture.operationId);
        expect(request?.object_type).toBe("scheduler_action");
        if (request === undefined) throw new Error("scheduler approval request missing");
        await approvals.resolveDecision({
          requestId: request.request_id,
          decision: "approve",
          objectDigest: request.object_digest,
          actor: "human:reviewer",
        });
        resumed = await fixture.host.parallelExecution.port.run({
          ...input,
          driver_lock: fixture.host.parallelExecution.driverLock(),
        });
      }
      expect(resumed.status).toBe("completed");
      const after = await createLedgerSchedulerAuthority({ deps: fixture.deps }).readFacts(
        fixture.operationId,
      );
      expect(
        after.leases.filter((lease) => lease.state === "granted").length,
      ).toBeGreaterThanOrEqual(2);
      expect(
        after.runs.filter((run) => run.record_kind === "run_terminated").length,
      ).toBeGreaterThanOrEqual(2);
      if (scenario.action === "retry_task") {
        expect(after.leases.some((lease) => lease.retry_kind === "executor_retry")).toBe(true);
      }
    },
    90_000,
  );

  it("keeps a stale adapter-bound approval from advancing Lease, Run or operation ref", async () => {
    const fixture = await makeDrivenProject({ approvalActions: ["dispatch_task"] });
    const input = {
      operation_id: fixture.operationId,
      iteration_id: ITERATION_ID,
      capability_plan_digest: fixture.capabilityPlan.record_digest,
      expected_plan_digest: fixture.planContentDigest,
    } as const;
    const first = await fixture.host.parallelExecution.port.run({
      ...input,
      driver_lock: fixture.host.parallelExecution.driverLock(),
    });
    expect(first.status).toBe("paused");
    const approvals = new ApprovalService(fixture.deps);
    const request = approvals.nextPendingRequest(fixture.operationId);
    if (request === undefined) throw new Error("scheduler approval request missing");
    await approvals.resolveDecision({
      requestId: request.request_id,
      decision: "approve",
      objectDigest: request.object_digest,
      actor: "human:reviewer",
    });
    const authority = createLedgerSchedulerAuthority({ deps: fixture.deps });
    const before = await authority.readFacts(fixture.operationId);
    const beforeRef = readGitRef(fixture.projectRoot, operationRefFor(fixture.operationId));

    const driftedHost = fixture.createHost({
      adapterManifestDigest: contentDigest({ drift: true }),
    });
    const drifted = await driftedHost.parallelExecution.port.run({
      ...input,
      driver_lock: driftedHost.parallelExecution.driverLock(),
    });

    expect(drifted.status).toBe("paused");
    const after = await authority.readFacts(fixture.operationId);
    expect(after.leases).toEqual(before.leases);
    expect(after.runs).toEqual(before.runs);
    expect(readGitRef(fixture.projectRoot, operationRefFor(fixture.operationId))).toBe(beforeRef);
    const replacement = approvals.nextPendingRequest(fixture.operationId);
    expect(replacement?.object_digest).not.toBe(request.object_digest);
  }, 60_000);

  it("recovers Ledger candidates before a fresh production host resumes", async () => {
    const fixture = await makeDrivenProject({ approvalActions: ["integrate_wave"] });
    const input = {
      operation_id: fixture.operationId,
      iteration_id: ITERATION_ID,
      capability_plan_digest: fixture.capabilityPlan.record_digest,
      expected_plan_digest: fixture.planContentDigest,
    } as const;
    const first = await fixture.host.parallelExecution.port.run({
      ...input,
      driver_lock: fixture.host.parallelExecution.driverLock(),
    });
    expect(first.status).toBe("paused");
    const validationsBefore = ledgerRepositoryFor(fixture.deps)
      .replay()
      .events.filter(
        (event) =>
          event.event_type === "TaskCandidateValidated" && event.payload["task_id"] === "task_api",
      ).length;
    expect(validationsBefore).toBeGreaterThan(0);

    const approvals = new ApprovalService(fixture.deps);
    const request = approvals.nextPendingRequest(fixture.operationId);
    if (request === undefined) throw new Error("wave integration approval request missing");
    await approvals.resolveDecision({
      requestId: request.request_id,
      decision: "approve",
      objectDigest: request.object_digest,
      actor: "human:reviewer",
    });

    const restartedHost = fixture.createHost();
    await restartedHost.parallelExecution.port.run({
      ...input,
      driver_lock: restartedHost.parallelExecution.driverLock(),
    });

    const replay = ledgerRepositoryFor(fixture.deps).replay();
    const validationsAfter = replay.events.filter(
      (event) =>
        event.event_type === "TaskCandidateValidated" && event.payload["task_id"] === "task_api",
    ).length;
    expect(validationsAfter).toBeGreaterThan(validationsBefore);
    const facts = await createLedgerSchedulerAuthority({ deps: fixture.deps }).readFacts(
      fixture.operationId,
    );
    expect(facts.wave_integrations.some((wave) => wave.wave_index === 0)).toBe(true);
  }, 90_000);

  it("drives a real two-task/two-wave operation to completion", async () => {
    const fixture = await makeDrivenProject();
    const outcome = await fixture.host.parallelExecution.port.run({
      operation_id: fixture.operationId,
      iteration_id: ITERATION_ID,
      capability_plan_digest: fixture.capabilityPlan.record_digest,
      expected_plan_digest: fixture.planContentDigest,
      driver_lock: fixture.host.parallelExecution.driverLock(),
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.operation_id).toBe(fixture.operationId);
    expect(outcome.wave_integration_digests).toHaveLength(2);

    // The read model reflects the integrated waves, byte-stable across reads.
    const model = await fixture.host.readSchedulerModel(fixture.operationId);
    expect(model.capability_status).toBe("active");
    expect(model.plan?.waves).toHaveLength(2);
    expect(model.tasks.map((task) => [task.task_id, task.status])).toEqual([
      ["task_api", "integrated"],
      ["task_web", "integrated"],
    ]);
    const reread = await fixture.host.readSchedulerModel(fixture.operationId);
    expect(reread).toEqual(model);
  }, 60_000);

  it("releases the driver lock after the drive finishes", async () => {
    const fixture = await makeDrivenProject();
    await fixture.host.parallelExecution.port.run({
      operation_id: fixture.operationId,
      iteration_id: ITERATION_ID,
      capability_plan_digest: fixture.capabilityPlan.record_digest,
      expected_plan_digest: fixture.planContentDigest,
      driver_lock: fixture.host.parallelExecution.driverLock(),
    });

    expect(existsSync(fixture.lockDirectory)).toBe(false);
    const reacquired = await fixture.host.acquireDriverLock(fixture.operationId);
    expect(existsSync(fixture.lockDirectory)).toBe(true);
    await reacquired.release();
    expect(existsSync(fixture.lockDirectory)).toBe(false);
  }, 60_000);

  it("cooperatively cancels a live run and reconciles its Lease and Run before returning", async () => {
    const fixture = await makeDrivenProject({ abortableRun: true });
    const drive = fixture.host.parallelExecution.port.run({
      operation_id: fixture.operationId,
      iteration_id: ITERATION_ID,
      capability_plan_digest: fixture.capabilityPlan.record_digest,
      expected_plan_digest: fixture.planContentDigest,
      driver_lock: fixture.host.parallelExecution.driverLock(),
    });
    await fixture.runStarted;

    const active = await fixture.host.readSchedulerModel(fixture.operationId);
    expect(active.slots.some((slot) => slot.state === "running")).toBe(true);

    const cancelled = await fixture.host.cancelOperation(
      fixture.operationId,
      "human requested cancellation",
    );
    expect(cancelled.status).toBe("cancelled");
    await expect(drive).resolves.toMatchObject({ status: "cancelled" });

    const facts = await createLedgerSchedulerAuthority({ deps: fixture.deps }).readFacts(
      fixture.operationId,
    );
    expect(facts.leases.at(-1)?.state).toBe("revoked");
    expect(facts.runs.at(-1)).toMatchObject({
      record_kind: "run_terminated",
      termination_reason: "user_cancellation",
    });
    expect(cancelled.read_model.projection.tasks[0]?.status).toBe("cancelled");
    expect(existsSync(fixture.lockDirectory)).toBe(false);
  }, 60_000);

  it("returns unconfirmed and preserves normal completion when the live Adapter ignores abort", async () => {
    const fixture = await makeDrivenProject({ ignoreAbort: true });
    const drive = fixture.host.parallelExecution.port.run({
      operation_id: fixture.operationId,
      iteration_id: ITERATION_ID,
      capability_plan_digest: fixture.capabilityPlan.record_digest,
      expected_plan_digest: fixture.planContentDigest,
      driver_lock: fixture.host.parallelExecution.driverLock(),
    });
    await fixture.runStarted;

    const cancellation = await fixture.host.cancelOperation(
      fixture.operationId,
      "human requested cancellation",
    );
    expect(cancellation.status).toBe("unconfirmed");
    await drive;

    const facts = await createLedgerSchedulerAuthority({ deps: fixture.deps }).readFacts(
      fixture.operationId,
    );
    expect(facts.leases.at(-1)?.state).toBe("released");
    expect(facts.runs.at(-1)).toMatchObject({
      record_kind: "run_terminated",
      termination_reason: "completion",
    });
    expect(
      facts.runs.some(
        (run) =>
          run.record_kind === "run_terminated" && run.termination_reason === "user_cancellation",
      ),
    ).toBe(false);
  }, 60_000);

  it("reports inactive_by_profile when the operation has no parallel capability", async () => {
    const fixture = await makeDrivenProject();
    const engine = new WorkflowEngine(fixture.deps);
    const other = await engine.startOperation(
      makeStartInput({
        iterationId: "iteration_host2",
        baselineCommit: headOf(fixture.projectRoot),
      }),
    );

    const model = await fixture.host.readSchedulerModel(other.operation.workflow_operation_id);
    expect(model.capability_status).toBe("inactive_by_profile");
    expect(model.plan).toBeNull();
    expect(model.tasks).toEqual([]);
  }, 60_000);

  it("rebuilds from Ledger authority after the real SQLite live projection is deleted", async () => {
    const fixture = await makeDrivenProject({ sqliteProjection: true });
    await fixture.host.parallelExecution.port.run({
      operation_id: fixture.operationId,
      iteration_id: ITERATION_ID,
      capability_plan_digest: fixture.capabilityPlan.record_digest,
      expected_plan_digest: fixture.planContentDigest,
      driver_lock: fixture.host.parallelExecution.driverLock(),
    });
    const observed = await fixture.host.readSchedulerModel(fixture.operationId);
    expect(observed.operation.live_state).toBe("observed");
    if (fixture.projectionStorePath === undefined) throw new Error("SQLite path missing");

    // Authority state before the projection loss: real Ledger facts and the
    // real operation ref.
    const authorityBefore = await createLedgerSchedulerAuthority({
      deps: fixture.deps,
    }).readFacts(fixture.operationId);
    const refBefore = readGitRef(fixture.projectRoot, operationRefFor(fixture.operationId));

    rmSync(fixture.projectionStorePath, { force: true });

    const recovered = await fixture.createHost().readSchedulerModel(fixture.operationId);
    const authorityAfter = await createLedgerSchedulerAuthority({
      deps: fixture.deps,
    }).readFacts(fixture.operationId);
    const refAfter = readGitRef(fixture.projectRoot, operationRefFor(fixture.operationId));

    const leaseBudgetView = (facts: { readonly leases: readonly TaskLeaseRecord[] }) =>
      facts.leases.map((record) => [
        record.lease_id,
        record.state,
        record.reserved_budget,
        record.consumed_budget,
      ]);

    await proveM4FaultInvariants({
      no_duplicate_process_acceptance: () => {
        // No process was resurrected by the rebuild: no live slots, and the
        // authority holds byte-identical run records.
        expect(recovered.slots).toEqual([]);
        expect(canonicalizeJson(authorityAfter.runs)).toBe(canonicalizeJson(authorityBefore.runs));
      },
      no_duplicate_integration: () => {
        // The rebuild duplicated no integration: the WaveIntegration records
        // are byte-identical before and after the projection loss.
        expect(canonicalizeJson(authorityAfter.wave_integrations)).toBe(
          canonicalizeJson(authorityBefore.wave_integrations),
        );
      },
      no_stale_fencing_acceptance: () => {
        // The fencing-token chain rebuilt byte-identically from Ledger
        // authority; no stale token regressed into currency.
        expect(canonicalizeJson(authorityAfter.leases)).toBe(
          canonicalizeJson(authorityBefore.leases),
        );
      },
      no_incorrect_budget_return: () => {
        // Budget-relevant Lease fields are exactly what the Ledger held before
        // the loss: the rebuild neither returned nor charged anything twice.
        expect(leaseBudgetView(authorityAfter)).toEqual(leaseBudgetView(authorityBefore));
      },
      no_ref_ledger_split: () => {
        // The real operation ref and the Ledger still agree: the ref did not
        // move and the integration record set is unchanged.
        expect(refBefore).toBeDefined();
        expect(refAfter).toBe(refBefore);
        expect(canonicalizeJson(authorityAfter.wave_integrations)).toBe(
          canonicalizeJson(authorityBefore.wave_integrations),
        );
      },
      no_false_success: () => {
        // Deleting live SQLite preserves the exact authority-derived Task
        // statuses, and the rebuilt projection honestly reports "rebuilding".
        expect(recovered.operation.live_state).toBe("rebuilding");
        expect(recovered.tasks.map((task) => [task.task_id, task.status])).toEqual(
          observed.tasks.map((task) => [task.task_id, task.status]),
        );
      },
    });
  }, 60_000);
});
