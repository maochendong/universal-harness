import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  canonicalizeJson,
  compileCapabilityPlan,
  contentDigest,
  createProfileDecisionRecord,
  createProjectProfileRecord,
  type CapabilityPlanRecord,
  type ModelProviderConfig,
} from "../../packages/core/src/index.js";
import { createTestPromptContractRegistry } from "../../packages/core/test/prompt/helpers.js";
import type {
  AgentAdapter,
  AgentProviderManifest,
  AgentRunResult,
} from "../../packages/plugin-sdk/src/index.js";

import { createGitVcsAdapter } from "../../adapters/vcs-git/src/index.js";

import {
  createLedgerSchedulerAuthority,
  createDefaultGateSuite,
  createNewProject,
  createProjectSchedulerHost,
  type ProjectSchedulerHost,
} from "../../packages/runtime/src/index.js";
import { commitArtifacts } from "../../packages/runtime/src/orchestration/kernel-coordinator.js";
import {
  generateKernelExecutionPlan,
  readExecutionPlanContent,
} from "../../packages/runtime/src/planning/execution-plan.js";
import { actionDigest } from "../../packages/runtime/src/policy/action.js";
import { buildDecision } from "../../packages/runtime/src/policy/decision.js";
import { mergePolicyLayers } from "../../packages/runtime/src/policy/evaluator.js";
import { operationRefFor } from "../../packages/runtime/src/scheduling/integration.js";
import {
  WorkflowEngine,
  type WorkflowDependencies,
} from "../../packages/runtime/src/workflow/operation.js";
import { FIXED_NOW, headOf, makeTempDir } from "../../packages/runtime/test/bootstrap/helpers.js";
import {
  PLAN_CONSTRAINTS,
  approvedImpactSet,
  entryPath,
} from "../../packages/runtime/test/planning/fixtures.js";
import { makeStartInput } from "../../packages/runtime/test/workflow/helpers.js";

const ITERATION_ID = "iteration_m4_release_e2e";
const REQUIREMENT_DIGEST = "a".repeat(64);
const POLICY_DIGEST = "b".repeat(64);

const MANIFEST: AgentProviderManifest = {
  provider: "deterministic-managed-release-fixture",
  control: "managed",
  trajectory_visibility: "full",
  usage_metering: true,
  side_effect_interception: true,
  resume_semantics: "explicit",
};

function providerConfig(slotId: string, purpose?: string): ModelProviderConfig {
  return {
    slot_id: slotId as ModelProviderConfig["slot_id"],
    ...(purpose === undefined ? {} : { purpose: purpose as never }),
    provider_identity: "provider_release_fixture",
    config_digest: "e".repeat(64),
    prompt_version: `${slotId}.v1`,
    schema_version: `${slotId}-result.v1`,
    budget_profile: "operation-standard",
  };
}

const MODEL_PROVIDERS: readonly ModelProviderConfig[] = [
  providerConfig("impact_advisory"),
  providerConfig("design_review"),
  providerConfig("plan_proposal"),
  providerConfig("feedback_analysis"),
  providerConfig("grounded_synthesis", "context_enrichment"),
  providerConfig("grounded_synthesis", "iteration_narrative"),
];

function ids(namespace: string): (kind: string) => string {
  const counters = new Map<string, number>();
  return (kind) => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${namespace}_${kind}_${String(next).padStart(3, "0")}`;
  };
}

function successResult(taskId: string, durationMs: number): AgentRunResult {
  return {
    outcome: "handoff",
    termination_reason: "completion",
    completion_claimed: true,
    summary: `completed ${taskId}`,
    state_proposal: null,
    dropped_proposal_fields: [],
    change_summary: {
      files_changed: 1,
      insertions: 1,
      deletions: 0,
      paths: [`src/${taskId}/outcome.ts`],
    },
    tool_activity: { total_calls: 0, governed_calls: 0, by_tool: {} },
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      duration_ms: durationMs,
      metering: "provider_reported",
    },
    budget_observations: [
      { dimension: "steps", availability: "measured", used: 1, limit: 10, enforcement: "harness" },
      {
        dimension: "tokens",
        availability: "measured",
        used: 15,
        limit: 1_000,
        enforcement: "harness",
      },
    ],
    evidence: [],
    undeclared_writes: [],
  };
}

interface Barrier {
  readonly wait: () => Promise<void>;
}

function twoPartyBarrier(): Barrier {
  let arrivals = 0;
  let release: (() => void) | undefined;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    async wait() {
      arrivals += 1;
      if (arrivals === 2) release?.();
      await open;
    },
  };
}

export interface TaskInterval {
  readonly task_id: string;
  readonly run_id: string;
  readonly slot_id: string;
  readonly start_ms: number;
  readonly end_ms: number;
}

export interface M4E2eFixture {
  readonly projectRoot: string;
  readonly operationId: string;
  readonly capabilityPlan: CapabilityPlanRecord;
  readonly planDigest: string;
  readonly host: ProjectSchedulerHost;
  readonly deps: WorkflowDependencies;
  readonly intervals: TaskInterval[];
  readonly operationRef: string;
  readonly gateWorkspaceRoots: readonly string[];
}

/**
 * Production composition over a real Git repository. Only the external Agent
 * boundary is deterministic; worktrees, Ledger, Gates, candidate commits,
 * wave CAS, Scheduler host and read model are real.
 */
export async function createM4E2eFixture(): Promise<M4E2eFixture> {
  const setupIds = ids("setup");
  const created = await createNewProject(
    {
      parentDirectory: makeTempDir("harness-m4-release-e2e-"),
      name: "m4-release-project",
      intent: "ship four independently governed slices",
    },
    { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId: setupIds },
  );
  if (!created.ok) throw new Error(created.error.message);
  const projectRoot = created.value.projectRoot;
  const baseline = headOf(projectRoot);
  const deps: WorkflowDependencies = {
    projectRoot,
    readBaseline: () => headOf(projectRoot),
    now: () => FIXED_NOW,
    newId: setupIds,
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
      project_id: "project_m4-release",
      revision: 1,
      profile_id: "governed",
      policy_digest: POLICY_DIGEST,
      actor: "human:release-e2e",
      effective_from: FIXED_NOW,
    }),
    profile_decision: createProfileDecisionRecord({
      decision_kind: "project_profile_change",
      project_id: "project_m4-release",
      actor: "human:release-e2e",
      idempotency_key: `profile-decision:${operationId}`,
      current_profile_id: "governed",
      decided_profile_id: "governed",
      policy_digest: POLICY_DIGEST,
      decided_at: FIXED_NOW,
    }),
    requirement_digest: REQUIREMENT_DIGEST,
    risk_digest: contentDigest({ risk: "release-e2e" }),
    policy_digest: POLICY_DIGEST,
    baseline_digest: contentDigest({ baseline }),
    policy: { required_capabilities: ["parallel_task_execution"] },
    providers: ["isolated_workspace_provider", "structured_gate_provider"],
    model_providers: MODEL_PROVIDERS,
    prompt_contract_resolver: createTestPromptContractRegistry(),
  }) as CapabilityPlanRecord;
  await commitArtifacts(deps, operationId, attemptId, [
    {
      path: `artifacts/capability-plans/${capabilityPlan.capability_plan_id}/${String(capabilityPlan.revision)}.json`,
      content: `${canonicalizeJson(capabilityPlan)}\n`,
    },
  ]);

  const { impactSet } = approvedImpactSet();
  const common = {
    capabilities: ["fs.read", "fs.write"],
    tools: ["tool:fs"],
    risk: "low" as const,
    budget: { steps: 10, tokens: 1_000, duration_ms: 300_000 },
    exclusive_resources: [] as readonly string[],
    acceptance: [{ description: "release fixture output exists", verification: "real gate" }],
    required_gates: ["gate_ledger_integrity"],
  };
  const { plan, tasks, edges } = generateKernelExecutionPlan(
    impactSet,
    {
      executionKind: "workflow",
      intentShape: "structured",
      hasExistingGraph: true,
      deterministicWork: true,
      shared: {
        goal: "prove local multi-agent scheduling",
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
      budgets: {
        task_ceiling: { steps: 100, tokens: 100_000, duration_ms: 600_000 },
        iteration_ceiling: { steps: 1_000, tokens: 1_000_000, duration_ms: 3_600_000 },
        iteration: { steps: 100, tokens: 100_000, duration_ms: 1_200_000 },
      },
      proposal: [
        {
          ...common,
          id: "task_api",
          objective: "implement the API slice",
          impact_paths: [entryPath(impactSet, "requirement_01"), entryPath(impactSet, "test_01")],
          expected_outputs: ["requirement_01", "test_01"],
          dependencies: [],
          write_paths: ["src/task_api"],
        },
        {
          ...common,
          id: "task_ui",
          objective: "implement the UI slice",
          impact_paths: [entryPath(impactSet, "decision_01")],
          expected_outputs: ["decision_01"],
          dependencies: [],
          write_paths: ["src/task_ui"],
        },
        {
          ...common,
          id: "task_contract",
          objective: "integrate API and UI contracts",
          impact_paths: [entryPath(impactSet, "component_01")],
          expected_outputs: ["component_01"],
          dependencies: ["task_api", "task_ui"],
          write_paths: ["src/task_contract"],
        },
        {
          ...common,
          id: "task_release",
          objective: "assemble the release slice",
          impact_paths: [entryPath(impactSet, "code_01")],
          expected_outputs: ["code_01"],
          dependencies: ["task_contract"],
          write_paths: ["src/task_release"],
        },
      ],
    },
    { iterationId: ITERATION_ID, actor: "release-e2e", timestamp: FIXED_NOW },
  );
  const planDigest = readExecutionPlanContent(plan, { tasks, edges }).content_digest;
  const acceptedDraft = Object.fromEntries(
    Object.entries(plan).filter(([key]) => key !== "digest"),
  ) as Record<string, unknown>;
  acceptedDraft.status = "accepted";
  const acceptedPlan = {
    ...acceptedDraft,
    digest: contentDigest(acceptedDraft),
  } as unknown as typeof plan;
  await commitArtifacts(
    deps,
    operationId,
    attemptId,
    [
      {
        path: `artifacts/plans/${acceptedPlan.id}.json`,
        content: `${canonicalizeJson(acceptedPlan)}\n`,
      },
      ...tasks.map((task) => ({
        path: `artifacts/tasks/${task.id}.json`,
        content: `${canonicalizeJson(task)}\n`,
      })),
    ],
    edges,
  );

  const barrier = twoPartyBarrier();
  const intervals: TaskInterval[] = [];
  const gateWorkspaceRoots: string[] = [];
  const hostIds = ids("host");
  const host = createProjectSchedulerHost({
    projectRoot,
    readBaseline: () => headOf(projectRoot),
    agentSlotFactory: {
      adapter_manifest_digest: contentDigest({ manifest: MANIFEST }),
      manifest: MANIFEST,
      create: ({ slot_id, worktree_root }): AgentAdapter => ({
        name: "deterministic-managed-release-fixture",
        manifest: MANIFEST,
        async run(envelope) {
          const start = Date.now();
          const scope = envelope.proposed_write_paths[0];
          if (scope === undefined) throw new Error("task has no declared write scope");
          const directory = join(worktree_root, scope);
          mkdirSync(directory, { recursive: true });
          if (envelope.task_id === "task_api" || envelope.task_id === "task_ui") {
            await barrier.wait();
          }
          if (envelope.task_id === "task_contract") {
            readFileSync(join(worktree_root, "src/task_api/outcome.ts"), "utf8");
            readFileSync(join(worktree_root, "src/task_ui/outcome.ts"), "utf8");
          }
          if (envelope.task_id === "task_release") {
            readFileSync(join(worktree_root, "src/task_contract/outcome.ts"), "utf8");
          }
          writeFileSync(
            join(directory, "outcome.ts"),
            `export const task = ${JSON.stringify(envelope.task_id)};\n`,
            "utf8",
          );
          const end = Date.now();
          intervals.push({
            task_id: envelope.task_id,
            run_id: envelope.digest,
            slot_id,
            start_ms: start,
            end_ms: end,
          });
          return successResult(envelope.task_id, Math.max(1, end - start));
        },
      }),
    },
    adapterCapabilities: ["fs.read", "fs.write"],
    maxConcurrency: 2,
    policyResolver: (action) =>
      buildDecision({
        outcome: "allow",
        reasons: [],
        action_digest: actionDigest(action),
        effective: mergePolicyLayers([]).effective,
      }),
    projectionStorePath: ":memory:",
    gateSuiteForWorkspace: (workspaceRoot) => {
      gateWorkspaceRoots.push(workspaceRoot);
      return createDefaultGateSuite(workspaceRoot);
    },
    now: () => FIXED_NOW,
    newId: hostIds,
  });
  return {
    projectRoot,
    operationId,
    capabilityPlan,
    planDigest,
    host,
    deps,
    intervals,
    operationRef: operationRefFor(operationId),
    gateWorkspaceRoots,
  };
}

export function readRefFile(projectRoot: string, ref: string, path: string): string {
  return execFileSync("git", ["show", `${ref}:${path}`], {
    cwd: projectRoot,
    encoding: "utf8",
  });
}

export { createLedgerSchedulerAuthority };
