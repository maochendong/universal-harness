import {
  PROTOCOL_VERSION,
  canonicalizeJson,
  contentDigest,
  type EdgeRecord,
  type NodeRecord,
} from "@universal-harness-internal/core";
import {
  PLAN_EXTENSION_KEY,
  issueGrant,
  mergePolicyLayers,
  type IsolatedWorkspacePort,
  type CapabilityGrant,
  type ExecutionPlanContent,
  type ImpactCoverageAssessment,
  type PolicyFieldInput,
  type PolicyLayer,
  type PolicyLayerInput,
  type PolicyMergeOperator,
} from "@universal-harness-internal/runtime";
import {
  assessUnattendedEligibility,
  type AgentControlLevel,
  type AgentProviderManifest,
} from "@universal-harness-internal/plugin-sdk";

import type { Protocol13TaskSpecification } from "../../runtime/src/planning/task.js";
import type { ParallelWave } from "../../runtime/src/planning/waves.js";
import type {
  PolicyDecisionPort,
  SchedulerLiveSnapshot,
  SchedulerProjectionStore,
  SchedulerPolicyInput,
  TaskDagPort,
} from "../../runtime/src/scheduling/ports.js";
import type { ConformanceCase } from "./runner.js";

/**
 * Shared M4 scheduling port conformance cases (plan Task 4 steps 1/3, spec
 * §5.1/§5.2/§11). One case kit per internal port — TaskDagPort and
 * PolicyDecisionPort — so the production Workflow/Policy Adapters and the
 * InMemory Adapters prove the same executable contract. The port interfaces
 * stay runtime-internal, so their types are imported here type-only from the
 * runtime sources; every value these cases need (digests, policy merging,
 * grant issuance) comes from the public barrels. Cases assert observable
 * results through the port interface only; adapter-specific arrangement
 * (narrow readers, deterministic resolvers) enters through the factories.
 *
 * The fixture builder cannot call the runtime-internal semantic-digest and
 * wave-compiler functions without leaking runtime sources into this package's
 * compiled output, so the test injects them as hooks — the fixture then binds
 * exactly the values the production guards will recompute.
 */

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const actualJson = canonicalizeJson(actual);
  const expectedJson = canonicalizeJson(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}

async function assertRejects(
  run: () => Promise<unknown>,
  pattern: RegExp,
  message: string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (pattern.test(text)) return;
    throw new Error(`${message}: rejected with an unexpected error: ${text}`, { cause: error });
  }
  throw new Error(`${message}: expected a rejection matching ${String(pattern)}`);
}

const NOW = "2026-08-31T00:00:00.000Z";
const HEX_DIGEST = /^[a-f0-9]{64}$/u;
const digest = (letter: string): string => letter.repeat(64);

export const SCHEDULING_CONFORMANCE_BASELINE = "0123456789abcdef0123456789abcdef01234567";
export const SCHEDULING_CONFORMANCE_OPERATION = "operation_scheduling_conformance";
const ITERATION_ID = "iteration_scheduling_conformance";

// --- Approved Task DAG fixture -------------------------------------------------

/**
 * Runtime-internal pure functions the fixture needs to bind the exact values
 * the production guards recompute: the per-task semantic digest and the
 * deterministic wave compilation.
 */
export interface TaskDagFixtureHooks {
  readonly taskSemanticDigest: (task: Protocol13TaskSpecification) => string;
  readonly compileParallelWaves: (
    tasks: readonly Protocol13TaskSpecification[],
  ) => readonly ParallelWave[];
}

/** Immutable arrangement one TaskDagPort Adapter serves reads from. */
export interface ApprovedTaskDagFixture {
  readonly operation_id: string;
  /** The approved baseline commit the Workflow Engine currently binds. */
  readonly baseline_commit: string;
  /** The approved (status accepted) ExecutionPlan node. */
  readonly plan: NodeRecord;
  /** The plan's Task node projection. */
  readonly task_nodes: readonly NodeRecord[];
  /** The plan's exact CONTAINS + DEPENDS_ON edge projection. */
  readonly edges: readonly EdgeRecord[];
}

export interface TaskDagPortFactory {
  create(fixture: ApprovedTaskDagFixture): TaskDagPort;
}

export interface ApprovedTaskDagFixtureOptions {
  /** Node status the plan carries; `accepted` is the approved state. */
  readonly planStatus?: NodeRecord["status"];
  /** `legacy` strips every protocol 1.3 authority field from plan and tasks. */
  readonly protocol?: "legacy" | "protocol13";
  /** Baseline commit the current approved baseline reader reports. */
  readonly currentBaseline?: string;
  /** Baseline commit bound into the plan shared context. */
  readonly planBaseline?: string;
  /** Persisted waves override; used to inject projection drift. */
  readonly persistedWaves?: readonly ParallelWave[];
  /** Task node extension rewrite; used to inject semantic digest drift. */
  readonly taskExtension?: (
    task: Protocol13TaskSpecification,
    extension: Record<string, unknown>,
  ) => Record<string, unknown>;
  /** Edge list rewrite; used to inject missing/extra/reversed edges. */
  readonly edgeProjection?: (edges: readonly EdgeRecord[]) => readonly EdgeRecord[];
}

function conformanceTasks(): readonly Protocol13TaskSpecification[] {
  const budget = { steps: 10, tokens: 20_000, duration_ms: 600_000 };
  const base = {
    impact_paths: [],
    capabilities: ["edit-source"],
    tools: ["apply_patch"],
    risk: "medium" as const,
    budget,
    exclusive_resources: [],
    acceptance: [{ description: "unit tests pass", verification: "unit-tests" }],
    required_gates: ["unit-tests"],
  };
  return [
    {
      ...base,
      id: "task_alpha",
      objective: "Implement the alpha module",
      expected_outputs: ["node_alpha"],
      dependencies: [],
      write_paths: ["src/alpha"],
    },
    {
      ...base,
      id: "task_beta",
      objective: "Implement the beta module",
      expected_outputs: ["node_beta"],
      dependencies: [],
      write_paths: ["src/beta"],
    },
    {
      ...base,
      id: "task_gamma",
      objective: "Integrate alpha and beta into the gamma module",
      expected_outputs: ["node_gamma"],
      dependencies: ["task_alpha", "task_beta"],
      write_paths: ["src/gamma"],
    },
  ];
}

function nodeRecord(
  id: string,
  type: "ExecutionPlan" | "Task",
  extensions: Record<string, unknown>,
  status: NodeRecord["status"],
): NodeRecord {
  const record = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "node",
    id,
    type,
    revision: 1,
    status,
    source: "workflow",
    provenance: { iteration_id: ITERATION_ID, actor: "conformance", timestamp: NOW },
    confidence: 1,
    extensions: { [PLAN_EXTENSION_KEY]: extensions },
  };
  return { ...record, digest: contentDigest(record) } as unknown as NodeRecord;
}

function edgeRecord(
  type: "CONTAINS" | "DEPENDS_ON",
  sourceId: string,
  targetId: string,
): EdgeRecord {
  const record = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "edge",
    id: `edge_${contentDigest({ type, source: sourceId, target: targetId }).slice(0, 16)}`,
    type,
    source_id: sourceId,
    target_id: targetId,
    status: "accepted",
    source: "workflow",
    provenance: { iteration_id: ITERATION_ID, actor: "conformance", timestamp: NOW },
    confidence: 1,
  };
  return { ...record, digest: contentDigest(record) } as unknown as EdgeRecord;
}

/**
 * Build a consistent approved Task DAG fixture: a protocol 1.3 ExecutionPlan
 * whose persisted waves, Task node semantic digests and CONTAINS/DEPENDS_ON
 * projection all bind the same Task list. Options inject exactly one drift at
 * a time so every rejection case isolates a single invariant.
 */
export function buildApprovedTaskDagFixture(
  hooks: TaskDagFixtureHooks,
  options: ApprovedTaskDagFixtureOptions = {},
): ApprovedTaskDagFixture {
  const protocol = options.protocol ?? "protocol13";
  const planBaseline = options.planBaseline ?? SCHEDULING_CONFORMANCE_BASELINE;
  const tasks = conformanceTasks();
  const impactCoverage: ImpactCoverageAssessment = {
    execution_kind: "agent",
    entries: [],
    status: "complete",
    covered_layers: [],
    missing_layers: [],
    forecast_paths: [],
    diagnostics: [],
    risk: "low",
    digest: digest("i"),
  };
  const sharedContext =
    protocol === "protocol13"
      ? {
          goal: "conformance scheduling goal",
          requirement_baseline_digest: digest("r"),
          policy_digest: digest("p"),
          baseline_commit: planBaseline,
          capability_plan_digest: digest("c"),
        }
      : {
          goal: "conformance scheduling goal",
          requirement_baseline_digest: digest("r"),
          policy_digest: digest("p"),
        };
  const planTasks =
    protocol === "protocol13"
      ? tasks
      : // Legacy plans never carry protocol 1.3 resource claims or duration bounds.
        tasks.map((task) => ({
          id: task.id,
          objective: task.objective,
          impact_paths: task.impact_paths,
          expected_outputs: task.expected_outputs,
          capabilities: task.capabilities,
          tools: task.tools,
          dependencies: task.dependencies,
          risk: task.risk,
          budget: { steps: task.budget.steps, tokens: task.budget.tokens },
          acceptance: task.acceptance,
          required_gates: task.required_gates,
        }));
  const base: Record<string, unknown> = {
    execution_kind: "agent",
    impact_coverage: impactCoverage,
    mode: protocol === "protocol13" ? "dag" : "single-loop",
    mode_reason: "conformance fixture",
    restricted: false,
    impact_set_id: "impact_scheduling_conformance",
    impact_set_digest: digest("s"),
    shared_context: sharedContext,
    tasks: planTasks,
  };
  if (protocol === "protocol13") {
    base.iteration_budget = { steps: 40, tokens: 80_000, duration_ms: 3_600_000 };
    base.parallel_waves = options.persistedWaves ?? hooks.compileParallelWaves(tasks);
  }
  const content = { ...base, content_digest: contentDigest(base) };
  const planId = `plan_${(content.content_digest as string).slice(0, 16)}`;
  const plan = nodeRecord(planId, "ExecutionPlan", content, options.planStatus ?? "accepted");
  const taskNodes = tasks.map((task) => {
    const extension =
      protocol === "protocol13"
        ? { ...task, semantic_digest: hooks.taskSemanticDigest(task) }
        : (planTasks.find((candidate) => candidate.id === task.id) as Record<string, unknown>);
    const rewritten = options.taskExtension?.(task, { ...extension });
    return nodeRecord(task.id, "Task", rewritten ?? extension, "accepted");
  });
  const edges: EdgeRecord[] = [
    ...tasks.map((task) => edgeRecord("CONTAINS", planId, task.id)),
    ...tasks.flatMap((task) =>
      task.dependencies.map((dependency) => edgeRecord("DEPENDS_ON", task.id, dependency)),
    ),
  ];
  return {
    operation_id: SCHEDULING_CONFORMANCE_OPERATION,
    baseline_commit: options.currentBaseline ?? SCHEDULING_CONFORMANCE_BASELINE,
    plan,
    task_nodes: taskNodes,
    edges: options.edgeProjection?.(edges) ?? edges,
  };
}

/** Read the plan content back the way any caller can: through the node extension. */
export function fixturePlanContent(fixture: ApprovedTaskDagFixture): ExecutionPlanContent {
  const content = fixture.plan.extensions?.[PLAN_EXTENSION_KEY];
  assert(
    typeof content === "object" && content !== null,
    "fixture plan must carry harness.plan content",
  );
  return content as ExecutionPlanContent;
}

/**
 * TaskDagPort contract (spec §5.1, plan Task 4 step 1): every Adapter returns
 * the same canonical snapshot of the approved plan and fails closed on an
 * unapproved plan, an expected-digest drift, a missing/extra/reversed
 * DEPENDS_ON edge, Task node semantic drift, persisted waves that differ from
 * a fresh compilation and a legacy plan requested for parallel execution.
 */
export function taskDagPortConformanceCases(factory: TaskDagPortFactory): ConformanceCase[] {
  return [
    {
      name: "returns the canonical snapshot of the approved plan",
      async run() {
        // Built without hooks by the case: the factory only reads the fixture,
        // so the happy path needs no runtime functions here.
        const fixture = currentTaskDagFixture();
        const port = factory.create(fixture);
        const content = fixturePlanContent(fixture);
        const snapshot = await port.readApproved({ operation_id: fixture.operation_id });
        assertEqual(snapshot.operation_id, fixture.operation_id, "operation id");
        assertEqual(snapshot.iteration_id, ITERATION_ID, "iteration id");
        assertEqual(snapshot.plan_id, fixture.plan.id, "plan id");
        assertEqual(snapshot.plan_digest, content.content_digest, "plan digest binds the content");
        assertEqual(
          snapshot.baseline_commit,
          SCHEDULING_CONFORMANCE_BASELINE,
          "baseline commit binds the plan shared context",
        );
        assertDeepEqual(snapshot.tasks, content.tasks, "tasks are the approved specifications");
        assertDeepEqual(
          snapshot.parallel_waves,
          content.parallel_waves ?? null,
          "waves are the persisted deterministic projection",
        );
        assertDeepEqual(
          snapshot.iteration_budget,
          content.iteration_budget ?? null,
          "iteration budget is the plan authority",
        );
        const second = await port.readApproved({ operation_id: fixture.operation_id });
        assertDeepEqual(second, snapshot, "reads are deterministic");
      },
    },
    {
      name: "accepts a matching expected_plan_digest and rejects drift",
      async run() {
        const fixture = currentTaskDagFixture();
        const port = factory.create(fixture);
        const content = fixturePlanContent(fixture);
        const snapshot = await port.readApproved({
          operation_id: fixture.operation_id,
          expected_plan_digest: content.content_digest,
        });
        assertEqual(snapshot.plan_digest, content.content_digest, "matching digest reads through");
        await assertRejects(
          () =>
            port.readApproved({
              operation_id: fixture.operation_id,
              expected_plan_digest: digest("0"),
            }),
          /digest|drift/iu,
          "a drifted expected_plan_digest must be rejected",
        );
      },
    },
    {
      name: "rejects an unapproved plan",
      async run() {
        const fixture = currentTaskDagFixture({ planStatus: "proposed" });
        const port = factory.create(fixture);
        await assertRejects(
          () => port.readApproved({ operation_id: fixture.operation_id }),
          /approv/iu,
          "a plan that was never approved must be rejected",
        );
      },
    },
    {
      name: "rejects missing, extra and reversed DEPENDS_ON edges",
      async run() {
        const missing = currentTaskDagFixture({
          edgeProjection: (edges) => edges.filter((edge) => edge.type !== "DEPENDS_ON"),
        });
        await assertRejects(
          () => factory.create(missing).readApproved({ operation_id: missing.operation_id }),
          /edge|depend|projection|drift|differ/iu,
          "a missing DEPENDS_ON edge must be rejected",
        );
        const reversed = currentTaskDagFixture({
          edgeProjection: (edges) =>
            edges.map((edge) =>
              edge.type === "DEPENDS_ON"
                ? { ...edge, source_id: edge.target_id, target_id: edge.source_id }
                : edge,
            ),
        });
        await assertRejects(
          () => factory.create(reversed).readApproved({ operation_id: reversed.operation_id }),
          /edge|depend|projection|drift|differ/iu,
          "a reversed DEPENDS_ON edge must be rejected",
        );
        const extra = currentTaskDagFixture({
          edgeProjection: (edges) => [
            ...edges,
            {
              ...(edges.find((edge) => edge.type === "DEPENDS_ON") as EdgeRecord),
              id: "edge_extra",
              source_id: "task_alpha",
              target_id: "task_gamma",
            },
          ],
        });
        await assertRejects(
          () => factory.create(extra).readApproved({ operation_id: extra.operation_id }),
          /edge|depend|projection|drift|differ/iu,
          "an extra DEPENDS_ON edge must be rejected",
        );
      },
    },
    {
      name: "rejects Task node semantic digest drift",
      async run() {
        const drifted = currentTaskDagFixture({
          taskExtension: (task, extension) =>
            task.id === "task_alpha" ? { ...extension, semantic_digest: digest("0") } : extension,
        });
        await assertRejects(
          () => factory.create(drifted).readApproved({ operation_id: drifted.operation_id }),
          /semantic|digest|drift|differ/iu,
          "a Task node whose semantic digest drifted must be rejected",
        );
      },
    },
    {
      name: "rejects persisted waves that differ from a fresh compilation",
      async run() {
        const drifted = currentTaskDagFixture({
          persistedWaves: [
            { wave_index: 0, task_ids: ["task_alpha", "task_beta", "task_gamma"] },
            { wave_index: 1, task_ids: [] },
          ],
        });
        await assertRejects(
          () => factory.create(drifted).readApproved({ operation_id: drifted.operation_id }),
          /wave|drift|differ/iu,
          "persisted waves that are not the fresh compilation must be rejected",
        );
      },
    },
    {
      name: "rejects a legacy plan requested for parallel execution",
      async run() {
        const legacy = currentTaskDagFixture({ protocol: "legacy" });
        await assertRejects(
          () => factory.create(legacy).readApproved({ operation_id: legacy.operation_id }),
          /legacy|sequential|1\.3/iu,
          "legacy plans stay sequential-only",
        );
      },
    },
    {
      name: "rejects a plan whose bound baseline drifted from the approved baseline",
      async run() {
        const drifted = currentTaskDagFixture({
          planBaseline: "ffffffffffffffffffffffffffffffffffffffff",
        });
        await assertRejects(
          () => factory.create(drifted).readApproved({ operation_id: drifted.operation_id }),
          /baseline/iu,
          "a plan bound to a stale baseline must be rejected",
        );
      },
    },
  ];
}

/**
 * The cases build fixtures through this hook so the test file — which may
 * import runtime sources — injects the digest/wave functions once.
 */
let fixtureHooks: TaskDagFixtureHooks | undefined;

export function bindTaskDagFixtureHooks(hooks: TaskDagFixtureHooks): void {
  fixtureHooks = hooks;
}

function currentTaskDagFixture(options?: ApprovedTaskDagFixtureOptions): ApprovedTaskDagFixture {
  const hooks = fixtureHooks;
  assert(hooks !== undefined, "bindTaskDagFixtureHooks must run before the cases");
  return buildApprovedTaskDagFixture(hooks, options);
}

// --- Policy decision conformance -----------------------------------------------

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

export const SCHEDULING_CONFORMANCE_APPROVAL = digest("a");
export const SCHEDULING_CONFORMANCE_TASK_DIGEST = digest("t");

/** Policy arrangement one PolicyDecisionPort Adapter decides against. */
export interface SchedulerPolicyFixture {
  readonly layers: readonly PolicyLayerInput[];
  readonly grant?: CapabilityGrant;
  /** Task digest key the grant reader answers to (SchedulerPolicyInput.task_digest). */
  readonly grant_task_digest?: string;
}

export interface PolicyDecisionPortFactory {
  create(fixture: SchedulerPolicyFixture): PolicyDecisionPort;
}

/** Overrides that may explicitly clear an optional binding (set it back to absent). */
type SchedulerPolicyInputOverrides = {
  readonly [K in keyof SchedulerPolicyInput]?: SchedulerPolicyInput[K] | undefined;
};

function schedulerInput(
  layers: readonly PolicyLayerInput[],
  overrides: SchedulerPolicyInputOverrides = {},
): SchedulerPolicyInput {
  const merged: Record<string, unknown> = {
    action: "dispatch_task",
    operation_id: SCHEDULING_CONFORMANCE_OPERATION,
    iteration_id: ITERATION_ID,
    plan_digest: digest("b"),
    task_digest: SCHEDULING_CONFORMANCE_TASK_DIGEST,
    wave_index: 0,
    baseline_commit: SCHEDULING_CONFORMANCE_BASELINE,
    risk: "medium",
    capabilities: ["edit-source"],
    tools: ["apply_patch"],
    write_paths: ["src/alpha"],
    exclusive_resources: [],
    task_remaining_budget: { steps: 10, tokens: 20_000, duration_ms: 600_000 },
    iteration_remaining_budget: { steps: 40, tokens: 80_000, duration_ms: 3_600_000 },
    adapter_manifest_digest: digest("m"),
    adapter_control_profile: {
      control: "managed",
      trajectory_visibility: "full",
      usage_metering: true,
      side_effect_interception: true,
    },
    effective_policy_digest: mergePolicyLayers(layers).effective.digest,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged as unknown as SchedulerPolicyInput;
}

function approvalGrant(
  layers: readonly PolicyLayerInput[],
  approvalDigests: readonly string[],
): CapabilityGrant {
  return issueGrant(
    {
      grant_id: "grant_scheduling_conformance",
      task_id: "task_conformance",
      capabilities: [],
      read_paths: [],
      write_paths: [],
      tools: [],
      phase: "execute",
      budget: { steps: 10, tokens: 20_000 },
      approval_digests: approvalDigests,
    },
    mergePolicyLayers(layers).effective,
  );
}

const SCHEDULER_ACTIONS = ["dispatch_task", "retry_task", "integrate_wave"] as const;

/**
 * PolicyDecisionPort contract (spec §5.2/§11, plan Task 4 step 3): all three
 * scheduler actions cross all four outcomes; an approval satisfies only an
 * exactly matching requires_approval decision and never overrides deny/block
 * or a stale effective policy digest.
 */
export function policyDecisionPortConformanceCases(
  factory: PolicyDecisionPortFactory,
): ConformanceCase[] {
  const retryOverrides = { retry_kind: "executor_retry" as const };
  return [
    {
      name: "allows all three scheduler actions under a permissive policy",
      async run() {
        const fixture: SchedulerPolicyFixture = { layers: [] };
        const port = factory.create(fixture);
        for (const action of SCHEDULER_ACTIONS) {
          const input = schedulerInput(fixture.layers, {
            action,
            ...(action === "retry_task" ? retryOverrides : {}),
          });
          const decision = await port.decide(input);
          assertEqual(decision.outcome, "allow", `${action} outcome`);
          assert(
            HEX_DIGEST.test(decision.action_digest),
            `${action} decision carries a hex action digest`,
          );
          assertEqual(
            decision.effective_policy_digest,
            mergePolicyLayers(fixture.layers).effective.digest,
            `${action} decision binds the effective policy`,
          );
          const repeated = await port.decide(input);
          assertDeepEqual(repeated, decision, `${action} decisions are deterministic`);
        }
      },
    },
    {
      name: "denies all three actions outside the effective phase allow set",
      async run() {
        const fixture: SchedulerPolicyFixture = {
          layers: [layer("project", [field("phases.allow", "allow_intersection", ["plan"])])],
        };
        const port = factory.create(fixture);
        for (const action of SCHEDULER_ACTIONS) {
          const decision = await port.decide(
            schedulerInput(fixture.layers, {
              action,
              ...(action === "retry_task" ? retryOverrides : {}),
            }),
          );
          assertEqual(decision.outcome, "deny", `${action} outcome`);
        }
      },
    },
    {
      name: "requires approval for all three actions when the policy declares them",
      async run() {
        const port = factory.create({ layers: [] });
        for (const action of SCHEDULER_ACTIONS) {
          const layers = [layer("pack", [field("approvals.required", "approval_union", [action])])];
          const decision = await factory.create({ layers }).decide(
            schedulerInput(layers, {
              action,
              ...(action === "retry_task" ? retryOverrides : {}),
            }),
          );
          assertEqual(decision.outcome, "requires_approval", `${action} outcome`);
        }
        void port;
      },
    },
    {
      name: "blocks all three actions on unresolved policy conflicts",
      async run() {
        const layers = [
          layer("installation", [field("scheduler.max_concurrency", "hard_ceiling", 4)]),
          layer("project", [field("scheduler.max_concurrency", "project_default", 4)]),
        ];
        const port = factory.create({ layers });
        for (const action of SCHEDULER_ACTIONS) {
          const decision = await port.decide(
            schedulerInput(layers, {
              action,
              ...(action === "retry_task" ? retryOverrides : {}),
            }),
          );
          assertEqual(decision.outcome, "block", `${action} outcome`);
        }
      },
    },
    {
      name: "satisfies requires_approval only through an exactly matching approval",
      async run() {
        const layers = [
          layer("pack", [field("approvals.required", "approval_union", ["dispatch_task"])]),
        ];
        const fixture: SchedulerPolicyFixture = {
          layers,
          grant: approvalGrant(layers, [SCHEDULING_CONFORMANCE_APPROVAL]),
          grant_task_digest: SCHEDULING_CONFORMANCE_TASK_DIGEST,
        };
        const port = factory.create(fixture);
        const satisfied = await port.decide(
          schedulerInput(layers, { approval_digest: SCHEDULING_CONFORMANCE_APPROVAL }),
        );
        assertEqual(satisfied.outcome, "allow", "the bound approval satisfies the decision");
        assertEqual(
          satisfied.approval_digest,
          SCHEDULING_CONFORMANCE_APPROVAL,
          "the satisfying approval is recorded",
        );
        const mismatched = await port.decide(
          schedulerInput(layers, { approval_digest: digest("9") }),
        );
        assertEqual(
          mismatched.outcome,
          "requires_approval",
          "a different approval never satisfies the decision",
        );
      },
    },
    {
      name: "never lets an approval override deny or block",
      async run() {
        const deniedLayers = [
          layer("project", [field("phases.allow", "allow_intersection", ["plan"])]),
        ];
        const denied = await factory
          .create({ layers: deniedLayers })
          .decide(
            schedulerInput(deniedLayers, { approval_digest: SCHEDULING_CONFORMANCE_APPROVAL }),
          );
        assertEqual(denied.outcome, "deny", "an approval never overrides a deny");
        assertEqual(denied.approval_digest, undefined, "a denied decision records no approval");

        const conflictedLayers = [
          layer("installation", [field("scheduler.max_concurrency", "hard_ceiling", 4)]),
          layer("project", [field("scheduler.max_concurrency", "project_default", 4)]),
        ];
        const blocked = await factory
          .create({ layers: conflictedLayers })
          .decide(
            schedulerInput(conflictedLayers, { approval_digest: SCHEDULING_CONFORMANCE_APPROVAL }),
          );
        assertEqual(blocked.outcome, "block", "an approval never overrides a block");
      },
    },
    {
      name: "fails closed on a stale effective policy digest even with an approval",
      async run() {
        const layers = [
          layer("pack", [field("approvals.required", "approval_union", ["dispatch_task"])]),
        ];
        const port = factory.create({ layers });
        const stale = schedulerInput(layers, {
          approval_digest: SCHEDULING_CONFORMANCE_APPROVAL,
          effective_policy_digest: digest("0"),
        });
        // Fail closed either way: a block decision or a thrown mismatch — the
        // one unacceptable answer is allow.
        try {
          const decision = await port.decide(stale);
          assertEqual(decision.outcome, "block", "a stale policy digest blocks the action");
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          assert(/digest/iu.test(text), `the failure must name the digest drift, got: ${text}`);
        }
      },
    },
    {
      name: "rejects structurally incomplete scheduler requests",
      async run() {
        const port = factory.create({ layers: [] });
        await assertRejects(
          () => port.decide(schedulerInput([], { task_digest: undefined })),
          /task_digest|invalid/iu,
          "dispatch_task without a task digest must be rejected",
        );
        await assertRejects(
          () =>
            port.decide(schedulerInput([], { action: "integrate_wave", wave_index: undefined })),
          /wave_index|invalid/iu,
          "integrate_wave without a wave index must be rejected",
        );
        await assertRejects(
          () => port.decide(schedulerInput([], { action: "retry_task" })),
          /retry_kind|invalid/iu,
          "retry_task without a retry kind must be rejected",
        );
      },
    },
  ];
}

// --- Workspace / live projection / Agent control conformance -----------------

/** One isolated workspace Adapter prepared against a known baseline. */
export interface WorkspaceConformanceFixture {
  readonly port: IsolatedWorkspacePort;
  readonly baseline_commit: string;
  readonly cleanup?: () => void | Promise<void>;
}

export type WorkspaceFactory = () =>
  WorkspaceConformanceFixture | Promise<WorkspaceConformanceFixture>;

async function withWorkspaceFixture(
  factory: WorkspaceFactory,
  run: (fixture: WorkspaceConformanceFixture) => Promise<void>,
): Promise<void> {
  const fixture = await factory();
  try {
    await run(fixture);
  } finally {
    await fixture.cleanup?.();
  }
}

/**
 * Shared IsolatedWorkspacePort cases (M4 plan Task 14 step 1). Both the real
 * Git worktree Adapter and the InMemory Adapter must expose the same public
 * create/apply/diff/reset/destroy behavior for the M4 task_execution purpose.
 */
export function workspaceConformanceCases(factory: WorkspaceFactory): ConformanceCase[] {
  return [
    {
      name: "isolates task_execution changes and reports a stable sorted diff",
      run: () =>
        withWorkspaceFixture(factory, async ({ port, baseline_commit }) => {
          const first = await port.create({ baseline_commit, purpose: "task_execution" });
          const second = await port.create({ baseline_commit, purpose: "task_execution" });
          try {
            await port.applyFiles(first, [
              { path: "zeta.txt", content: "zeta\n" },
              { path: "alpha.txt", content: "alpha\n" },
            ]);
            assertDeepEqual(
              await port.diff(first),
              [
                { path: "alpha.txt", content: "alpha\n" },
                { path: "zeta.txt", content: "zeta\n" },
              ],
              "changed files are normalized and sorted",
            );
            assertDeepEqual(await port.diff(second), [], "a sibling workspace stays isolated");
          } finally {
            await port.destroy(first);
            await port.destroy(second);
          }
        }),
    },
    {
      name: "reset discards task changes without changing the baseline binding",
      run: () =>
        withWorkspaceFixture(factory, async ({ port, baseline_commit }) => {
          const handle = await port.create({ baseline_commit, purpose: "task_execution" });
          try {
            assertEqual(handle.baseline_commit, baseline_commit, "workspace baseline");
            assertEqual(handle.purpose, "task_execution", "workspace purpose");
            await port.applyFiles(handle, [{ path: "change.txt", content: "changed\n" }]);
            assert((await port.diff(handle)).length === 1, "the change is observable before reset");
            await port.reset(handle);
            assertDeepEqual(await port.diff(handle), [], "reset restores the bound baseline");
          } finally {
            await port.destroy(handle);
          }
        }),
    },
    {
      name: "destroy makes a workspace handle unusable",
      run: () =>
        withWorkspaceFixture(factory, async ({ port, baseline_commit }) => {
          const handle = await port.create({ baseline_commit, purpose: "task_execution" });
          await port.destroy(handle);
          await assertRejects(
            () => port.diff(handle),
            /unknown workspace/iu,
            "a destroyed workspace cannot be observed or reused",
          );
        }),
    },
  ];
}

export interface ProjectionConformanceFixture {
  readonly store: SchedulerProjectionStore;
  readonly cleanup?: () => void | Promise<void>;
}

export type SchedulerProjectionFactory = () =>
  ProjectionConformanceFixture | Promise<ProjectionConformanceFixture>;

async function withProjectionFixture(
  factory: SchedulerProjectionFactory,
  run: (fixture: ProjectionConformanceFixture) => Promise<void>,
): Promise<void> {
  const fixture = await factory();
  try {
    await run(fixture);
  } finally {
    await fixture.cleanup?.();
  }
}

function schedulerProjectionFixture(operationId = "operation_projection_a"): SchedulerLiveSnapshot {
  return {
    operation_id: operationId,
    observed_at: NOW,
    slots: [
      { slot_id: "slot_1", state: "running", task_id: "task_alpha", run_id: "run_alpha" },
      { slot_id: "slot_2", state: "idle" },
    ],
    tasks: [
      {
        task_id: "task_alpha",
        pid: null,
        heartbeat_at: NOW,
        output_tail: "compiling <redacted-path>",
        steps: null,
        tokens: null,
        duration_ms: 25,
        worktree_id: "worktree_0123456789ab",
      },
    ],
  };
}

/** Shared disposable SchedulerProjectionStore cases for SQLite and InMemory. */
export function schedulerProjectionConformanceCases(
  factory: SchedulerProjectionFactory,
): ConformanceCase[] {
  return [
    {
      name: "atomically replaces and reads one complete live snapshot",
      run: () =>
        withProjectionFixture(factory, async ({ store }) => {
          const first = schedulerProjectionFixture();
          await store.replace(first);
          assertDeepEqual(await store.read(first.operation_id), first, "first projection read");
          const replacement: SchedulerLiveSnapshot = {
            ...first,
            observed_at: "2026-08-31T00:00:01.000Z",
            slots: [{ slot_id: "slot_1", state: "idle" }],
            tasks: [],
          };
          await store.replace(replacement);
          assertDeepEqual(
            await store.read(first.operation_id),
            replacement,
            "replacement is all-or-nothing",
          );
        }),
    },
    {
      name: "isolates operation snapshots and clears only the requested operation",
      run: () =>
        withProjectionFixture(factory, async ({ store }) => {
          const first = schedulerProjectionFixture("operation_projection_a");
          const second = schedulerProjectionFixture("operation_projection_b");
          await store.replace(first);
          await store.replace(second);
          await store.clear(first.operation_id);
          assertEqual(await store.read(first.operation_id), null, "cleared operation");
          assertDeepEqual(
            await store.read(second.operation_id),
            second,
            "other operation survives",
          );
        }),
    },
    {
      name: "returns null for an unknown operation without inventing authority",
      run: () =>
        withProjectionFixture(factory, async ({ store }) => {
          assertEqual(await store.read("operation_missing"), null, "unknown operation");
        }),
    },
  ];
}

export interface AgentFixtureFactory {
  create(control: AgentControlLevel): { readonly manifest: AgentProviderManifest };
}

/**
 * One control-profile suite is reused for managed/delegated/manual fixtures.
 * It proves the classification boundary the Scheduler consumes; it does not
 * claim a provider is unattended merely because a test fixture can run.
 */
export function agentControlProfileCases(factory: AgentFixtureFactory): ConformanceCase[] {
  const controls = ["managed", "delegated", "manual"] as const;
  return [
    {
      name: "preserves the declared control profile for every Agent fixture",
      run() {
        for (const control of controls) {
          const fixture = factory.create(control);
          assertEqual(fixture.manifest.control, control, `${control} control profile`);
          assert(fixture.manifest.provider.length > 0, `${control} provider identity is present`);
        }
        return Promise.resolve();
      },
    },
    {
      name: "allows only manifests that prove the unattended contract",
      run() {
        const managed = assessUnattendedEligibility(factory.create("managed").manifest);
        const delegated = assessUnattendedEligibility(factory.create("delegated").manifest);
        const manual = assessUnattendedEligibility(factory.create("manual").manifest);
        assertEqual(managed.eligible, true, "managed fixture unattended eligibility");
        assertEqual(delegated.eligible, true, "fully controlled delegated fixture eligibility");
        assertEqual(manual.eligible, false, "manual fixture unattended eligibility");
        assert(
          manual.reasons.some((reason) => /manual/iu.test(reason)),
          "manual rejection explains the control boundary",
        );
        return Promise.resolve();
      },
    },
    {
      name: "keeps provider identities distinct across control profiles",
      run() {
        const providers = controls.map((control) => factory.create(control).manifest.provider);
        assertEqual(new Set(providers).size, controls.length, "provider identities are distinct");
        return Promise.resolve();
      },
    },
  ];
}
