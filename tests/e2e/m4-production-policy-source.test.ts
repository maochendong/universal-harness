import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { contentDigest } from "../../packages/core/src/index.js";
import {
  actionDigest,
  mergePolicyLayers,
  riskRank,
  type AdapterControlProfile,
  type PolicyFieldInput,
  type PolicyLayer,
  type PolicyLayerInput,
  type PolicyMergeOperator,
  type PolicyRisk,
} from "../../packages/runtime/src/index.js";
import {
  SCHEDULER_POLICY_ACTION_KINDS,
  type SchedulerPolicyActionKind,
} from "../../packages/runtime/src/policy/action.js";
import {
  taskSemanticDigest,
  type IterationBudget,
  type Protocol13TaskSpecification,
} from "../../packages/runtime/src/planning/task.js";
import type { ParallelWave } from "../../packages/runtime/src/planning/waves.js";
import { waveIntegrationPolicyInput } from "../../packages/runtime/src/scheduling/integration.js";
import {
  createPolicyDecisionAdapter,
  schedulerPolicyAction,
} from "../../packages/runtime/src/scheduling/policy-adapters.js";
import type {
  PolicyDecisionPort,
  SchedulerPolicyInput,
  TaskDagSnapshot,
} from "../../packages/runtime/src/scheduling/ports.js";
import {
  FIXED_NOW,
  cleanupDirectories,
  headOf,
} from "../../packages/runtime/test/bootstrap/helpers.js";

import { createM4E2eFixture, type M4E2eFixture } from "./m4-scheduler-fixture.js";

/**
 * M4 AC-10 readiness evidence: the three protocol 1.3 scheduler actions
 * (dispatch_task, retry_task, integrate_wave) are decided through the
 * production PolicyDecisionPort adapter -- createPolicyDecisionAdapter over
 * the deterministic evaluator, the same source the scheduler host wires by
 * default -- across all four decision outcomes, plus the approval drift
 * transitions. Nothing in this file stubs decision logic; only the layer
 * sets the adapter reads vary, exactly as real Installation/Pack/Project
 * policy layers would. Action bindings (operation id, plan digest, baseline
 * commit, task semantic digest) come from the committed artifacts of a real
 * Git-backed fixture project.
 */

const ITERATION_ID = "iteration_m4_release_e2e";
const APPROVAL_DIGEST = "a".repeat(64);
const STALE_POLICY_DIGEST = "0".repeat(64);

const ADAPTER_CONTROL_PROFILE: AdapterControlProfile = {
  control: "managed",
  trajectory_visibility: "full",
  usage_metering: true,
  side_effect_interception: true,
};
const ADAPTER_MANIFEST_DIGEST = contentDigest({
  manifest: "deterministic-managed-release-fixture",
});

function field(path: string, mergeOperator: PolicyMergeOperator, value: unknown): PolicyFieldInput {
  return { path, merge_operator: mergeOperator, value };
}

function layer(
  name: PolicyLayer,
  fields: readonly PolicyFieldInput[],
  revision = 1,
): PolicyLayerInput {
  return {
    layer: name,
    revision,
    digest: contentDigest({ layer: name, revision, fields }),
    fields,
  };
}

/** Merged Installation/Pack/Project layers that permit the execute phase. */
function permissiveLayers(): readonly PolicyLayerInput[] {
  return [
    layer("installation", [field("scheduler.max_concurrency", "hard_ceiling", 8)]),
    layer("pack", [field("phases.allow", "allow_intersection", ["plan", "execute"])]),
    layer("project", [field("scheduler.max_concurrency", "hard_ceiling", 4)]),
  ];
}

/** Effective policy whose phase allow set excludes the scheduler's execute phase. */
function denyingLayers(): readonly PolicyLayerInput[] {
  return [layer("project", [field("phases.allow", "allow_intersection", ["plan"])])];
}

/** Pack layer that requires an explicit approval for the given scheduler action. */
function approvalRequiringLayers(kind: SchedulerPolicyActionKind): readonly PolicyLayerInput[] {
  return [layer("pack", [field("approvals.required", "approval_union", [kind])])];
}

/** Two layers declaring conflicting merge operators for one field: a policy defect. */
function conflictedLayers(): readonly PolicyLayerInput[] {
  return [
    layer("installation", [field("scheduler.max_concurrency", "hard_ceiling", 4)]),
    layer("project", [field("scheduler.max_concurrency", "project_default", 4)]),
  ];
}

/** The production PolicyDecisionPort adapter over the deterministic evaluator. */
function productionPolicyPort(layers: readonly PolicyLayerInput[]): PolicyDecisionPort {
  const port = createPolicyDecisionAdapter({
    readLayers: () => layers,
    readGrant: () => undefined,
  });
  // Pin the production adapter identity: the InMemory conformance adapter
  // ("in-memory-policy-decision") must never satisfy this suite.
  expect(port.name).toBe("workflow-policy-decision");
  return port;
}

interface ProductionFacts {
  readonly operation_id: string;
  readonly plan_digest: string;
  readonly baseline_commit: string;
  /** task_api semantic digest, recomputed from its committed specification. */
  readonly task_digest: string;
  /** task_api bindings for the dispatch/retry inputs. */
  readonly risk: Protocol13TaskSpecification["risk"];
  readonly capabilities: readonly string[];
  readonly tools: readonly string[];
  readonly write_paths: readonly string[];
  /** Canonical DAG view of the approved plan, as a TaskDagPort read returns it. */
  readonly dag: TaskDagSnapshot;
  /** Wave 0 of the approved plan: [task_api, task_ui]. */
  readonly waveZero: ParallelWave;
}

/** Read one committed Task node's specification from the Ledger artifact store. */
function readTaskSpec(fixture: M4E2eFixture, taskId: string): Protocol13TaskSpecification {
  // The "harness.plan" extension carries the specification plus the semantic
  // digest the plan compiler recorded.
  const node = JSON.parse(
    readFileSync(
      join(fixture.projectRoot, ".harness", "artifacts", "tasks", `${taskId}.json`),
      "utf8",
    ),
  ) as { readonly type?: unknown; readonly extensions?: unknown };
  if (node.type !== "Task" || typeof node.extensions !== "object" || node.extensions === null) {
    throw new Error(`${taskId} artifact is not a Task node record`);
  }
  const spec = (node.extensions as Record<string, unknown>)["harness.plan"] as
    Protocol13TaskSpecification | undefined;
  if (spec === undefined || spec.id !== taskId) {
    throw new Error(`${taskId} artifact carries no matching harness.plan specification`);
  }
  return spec;
}

function readProductionFacts(fixture: M4E2eFixture): ProductionFacts {
  const tasks = ["task_api", "task_ui", "task_contract", "task_release"].map((taskId) =>
    readTaskSpec(fixture, taskId),
  );
  const taskApi = tasks[0] as Protocol13TaskSpecification;
  const taskDigest = taskSemanticDigest(taskApi);
  const recorded = (taskApi as unknown as Record<string, unknown>).semantic_digest;
  if (recorded !== taskDigest) {
    throw new Error("task_api artifact semantic digest drifted from its specification");
  }

  const plansDirectory = join(fixture.projectRoot, ".harness", "artifacts", "plans");
  const planNames = readdirSync(plansDirectory).filter((name) => name.endsWith(".json"));
  if (planNames.length !== 1) {
    throw new Error(`expected exactly one committed plan artifact, found ${planNames.length}`);
  }
  const planNode = JSON.parse(
    readFileSync(join(plansDirectory, planNames[0] as string), "utf8"),
  ) as { readonly id?: unknown; readonly type?: unknown; readonly extensions?: unknown };
  if (
    planNode.type !== "ExecutionPlan" ||
    typeof planNode.id !== "string" ||
    typeof planNode.extensions !== "object" ||
    planNode.extensions === null
  ) {
    throw new Error("plan artifact is not an ExecutionPlan node record");
  }
  const content = (planNode.extensions as Record<string, unknown>)["harness.plan"] as
    | {
        readonly content_digest?: unknown;
        readonly parallel_waves?: unknown;
        readonly iteration_budget?: unknown;
      }
    | undefined;
  if (content === undefined || content.content_digest !== fixture.planDigest) {
    throw new Error("plan artifact content digest drifted from the fixture plan digest");
  }
  const parallelWaves = content.parallel_waves as readonly ParallelWave[];
  const waveZero = parallelWaves[0];
  if (waveZero === undefined || waveZero.wave_index !== 0) {
    throw new Error("approved plan carries no wave 0");
  }

  const baselineCommit = headOf(fixture.projectRoot);
  const dag: TaskDagSnapshot = {
    operation_id: fixture.operationId,
    iteration_id: ITERATION_ID,
    plan_id: planNode.id,
    plan_digest: fixture.planDigest,
    baseline_commit: baselineCommit,
    tasks,
    parallel_waves: parallelWaves,
    iteration_budget: content.iteration_budget as IterationBudget,
  };
  return {
    operation_id: fixture.operationId,
    plan_digest: fixture.planDigest,
    baseline_commit: baselineCommit,
    task_digest: taskDigest,
    risk: taskApi.risk,
    capabilities: taskApi.capabilities,
    tools: taskApi.tools,
    write_paths: taskApi.write_paths,
    dag,
    waveZero,
  };
}

/**
 * Build one SchedulerPolicyInput the way production forms it: dispatch/retry
 * inputs mirror the scheduler's dispatch path (scheduler.ts), and
 * integrate_wave inputs come from the production waveIntegrationPolicyInput
 * constructor (integration.ts), which unions the whole wave's capabilities,
 * tools, write paths and exclusive resources and takes the highest task risk.
 */
function schedulerInput(
  facts: ProductionFacts,
  kind: SchedulerPolicyActionKind,
  layers: readonly PolicyLayerInput[],
  overrides?: Partial<SchedulerPolicyInput>,
): SchedulerPolicyInput {
  const effectivePolicyDigest = mergePolicyLayers(layers).effective.digest;
  const base: SchedulerPolicyInput =
    kind === "integrate_wave"
      ? waveIntegrationPolicyInput({
          dag: facts.dag,
          wave: facts.waveZero,
          base_commit: facts.baseline_commit,
          leases: [],
          adapter_manifest_digest: ADAPTER_MANIFEST_DIGEST,
          adapter_control_profile: ADAPTER_CONTROL_PROFILE,
          effective_policy_digest: effectivePolicyDigest,
          now: FIXED_NOW,
        })
      : {
          action: kind,
          operation_id: facts.operation_id,
          iteration_id: ITERATION_ID,
          plan_digest: facts.plan_digest,
          task_digest: facts.task_digest,
          wave_index: 0,
          baseline_commit: facts.baseline_commit,
          risk: facts.risk,
          capabilities: facts.capabilities,
          tools: facts.tools,
          write_paths: facts.write_paths,
          exclusive_resources: [],
          task_remaining_budget: { steps: 10, tokens: 1_000, duration_ms: 300_000 },
          iteration_remaining_budget: { steps: 100, tokens: 100_000, duration_ms: 1_200_000 },
          adapter_manifest_digest: ADAPTER_MANIFEST_DIGEST,
          adapter_control_profile: ADAPTER_CONTROL_PROFILE,
          ...(kind === "retry_task" ? { retry_kind: "executor_retry" as const } : {}),
          effective_policy_digest: effectivePolicyDigest,
        };
  return { ...base, ...overrides };
}

describe("M4 AC-10: scheduler actions decided by the production policy source", () => {
  let fixture: M4E2eFixture;
  let facts: ProductionFacts;

  beforeAll(async () => {
    fixture = await createM4E2eFixture({ profileId: "governed" });
    facts = readProductionFacts(fixture);
  }, 120_000);

  afterAll(() => {
    cleanupDirectories();
  });

  it("binds real fixture facts: committed plan, baseline and task semantic digest", () => {
    expect(facts.operation_id).toBe(fixture.operationId);
    expect(facts.operation_id.length).toBeGreaterThan(0);
    expect(facts.plan_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(facts.baseline_commit).toMatch(/^[a-f0-9]{40}$/u);
    expect(facts.task_digest).toMatch(/^[a-f0-9]{64}$/u);
    // Wave 0 pairs task_api with task_ui, so the production integrate_wave
    // input unions both tasks' bindings instead of one task's.
    expect(facts.waveZero.task_ids).toEqual(["task_api", "task_ui"]);
    expect(facts.dag.tasks.map((task) => task.id).sort()).toEqual([
      "task_api",
      "task_contract",
      "task_release",
      "task_ui",
    ]);

    // The production integrate_wave constructor unions the wave's bindings:
    // both wave-0 write scopes appear, not just task_api's.
    const integrateInput = schedulerInput(facts, "integrate_wave", []);
    expect(integrateInput.task_digest).toBeUndefined();
    expect(integrateInput.write_paths).toEqual(["src/task_api", "src/task_ui"]);
    const waveTasks = facts.dag.tasks.filter((task) => facts.waveZero.task_ids.includes(task.id));
    const highestRisk = waveTasks.reduce(
      (highest, task) => (riskRank(task.risk) > riskRank(highest) ? task.risk : highest),
      "low" as PolicyRisk,
    );
    expect(integrateInput.risk).toBe(highestRisk);
  });

  it.each(SCHEDULER_POLICY_ACTION_KINDS)(
    "allows %s under a merged multi-layer effective policy",
    async (kind) => {
      const layers = permissiveLayers();
      const input = schedulerInput(facts, kind, layers);
      const decision = await productionPolicyPort(layers).decide(input);

      expect(decision.outcome).toBe("allow");
      expect(decision.reasons.join("\n")).toContain("allowed");
      // The decision binds the exact production-normalized action and the
      // exact field-wise merged effective policy it was decided under.
      expect(decision.action_digest).toBe(actionDigest(schedulerPolicyAction(input)));
      expect(decision.effective_policy_digest).toBe(mergePolicyLayers(layers).effective.digest);
      expect(decision.digest).toMatch(/^[a-f0-9]{64}$/u);
      // Field-wise merge evidence: the concurrency ceiling took the minimum.
      const concurrency = decision.field_traces.find(
        (trace) => trace.path === "scheduler.max_concurrency",
      );
      expect(concurrency?.value).toBe(4);
      expect(concurrency?.sources.map((source) => source.layer)).toEqual([
        "installation",
        "project",
      ]);
    },
  );

  it.each(SCHEDULER_POLICY_ACTION_KINDS)(
    "denies %s outside the effective phase allow set, and no approval overrides the deny",
    async (kind) => {
      const layers = denyingLayers();
      const decision = await productionPolicyPort(layers).decide(
        schedulerInput(facts, kind, layers),
      );
      expect(decision.outcome).toBe("deny");
      expect(decision.reasons.join("\n")).toContain("denied");
      expect(decision.reasons.join("\n")).toContain('phase "execute"');

      const withApproval = await productionPolicyPort(layers).decide(
        schedulerInput(facts, kind, layers, { approval_digest: APPROVAL_DIGEST }),
      );
      expect(withApproval.outcome).toBe("deny");
      expect(withApproval.approval_digest).toBeUndefined();
    },
  );

  it.each(SCHEDULER_POLICY_ACTION_KINDS)(
    "requires approval for %s when the pack layer declares it",
    async (kind) => {
      const layers = approvalRequiringLayers(kind);
      const decision = await productionPolicyPort(layers).decide(
        schedulerInput(facts, kind, layers),
      );
      expect(decision.outcome).toBe("requires_approval");
      expect(decision.approval_digest).toBeUndefined();
      expect(decision.reasons.join("\n")).toContain("requires-approval");
    },
  );

  it.each(SCHEDULER_POLICY_ACTION_KINDS)(
    "blocks %s on a policy merge conflict, and no approval overrides the block",
    async (kind) => {
      const layers = conflictedLayers();
      const decision = await productionPolicyPort(layers).decide(
        schedulerInput(facts, kind, layers),
      );
      expect(decision.outcome).toBe("block");
      expect(decision.reasons.join("\n")).toContain("conflicting merge operators");
      expect(decision.reasons.join("\n")).toContain("blocked");

      const withApproval = await productionPolicyPort(layers).decide(
        schedulerInput(facts, kind, layers, { approval_digest: APPROVAL_DIGEST }),
      );
      expect(withApproval.outcome).toBe("block");
      expect(withApproval.approval_digest).toBeUndefined();
    },
  );

  it.each(SCHEDULER_POLICY_ACTION_KINDS)(
    "drifts %s from requires_approval to allow exactly when a control-plane approval binds",
    async (kind) => {
      const layers = approvalRequiringLayers(kind);
      const port = productionPolicyPort(layers);
      const input = schedulerInput(facts, kind, layers);

      // Pending: no approval recorded yet.
      const pending = await port.decide(input);
      expect(pending.outcome).toBe("requires_approval");

      // Approved: the control-plane approval digest bound to this exact
      // action satisfies the rule and the decision drifts to allow.
      const approved = await port.decide(
        schedulerInput(facts, kind, layers, { approval_digest: APPROVAL_DIGEST }),
      );
      expect(approved.outcome).toBe("allow");
      expect(approved.approval_digest).toBe(APPROVAL_DIGEST);
      expect(approved.action_digest).not.toBe(pending.action_digest);

      // Rejected: with no approval carried, the same action stays
      // requires_approval -- rejection never degrades into a silent allow.
      const rejected = await port.decide(input);
      expect(rejected.outcome).toBe("requires_approval");
      expect(rejected.digest).toBe(pending.digest);
    },
  );

  it.each(SCHEDULER_POLICY_ACTION_KINDS)(
    "does not let the approval of %s follow a drifted action binding",
    async (kind) => {
      const layers = approvalRequiringLayers(kind);
      const port = productionPolicyPort(layers);
      const input = schedulerInput(facts, kind, layers);

      // Any binding drift (here: a superseded plan) forms a different action
      // digest, so the drifted request carries no approval and stays
      // requires_approval. Note the actual non-transfer guarantee is enforced
      // by the control plane: the host only attaches an approval digest whose
      // recorded object_digest matches the exact unapproved action (host.ts
      // approvalDigestFor). This test does not submit APPROVAL_DIGEST with the
      // drifted input -- at the evaluator level any carried digest satisfies
      // the rule -- it only pins that drift produces a distinct, unapproved
      // action.
      const drifted = schedulerInput(facts, kind, layers, { plan_digest: "f".repeat(64) });
      expect(actionDigest(schedulerPolicyAction(drifted))).not.toBe(
        actionDigest(schedulerPolicyAction(input)),
      );
      const decision = await port.decide(drifted);
      expect(decision.outcome).toBe("requires_approval");
      expect(decision.approval_digest).toBeUndefined();
    },
  );

  it.each(SCHEDULER_POLICY_ACTION_KINDS)(
    "blocks an approved %s request pinned to a stale effective policy digest",
    async (kind) => {
      const layers = approvalRequiringLayers(kind);
      const decision = await productionPolicyPort(layers).decide(
        schedulerInput(facts, kind, layers, {
          approval_digest: APPROVAL_DIGEST,
          effective_policy_digest: STALE_POLICY_DIGEST,
        }),
      );
      // Policy drift after the request was formed blocks outright: the
      // approval bound the drifted policy, so it covers nothing here.
      expect(decision.outcome).toBe("block");
      expect(decision.approval_digest).toBeUndefined();
      expect(decision.reasons.join("\n")).toContain(STALE_POLICY_DIGEST);
      expect(decision.reasons.join("\n")).toContain(mergePolicyLayers(layers).effective.digest);
      expect(decision.effective_policy_digest).toBe(mergePolicyLayers(layers).effective.digest);
    },
  );
});
