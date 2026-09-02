import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  CapabilityPlanRecordV13Schema,
  PROTOCOL_1_1_SCHEMA_REGISTRY,
  PROTOCOL_1_3_VERSION,
  canonicalizeJson,
  compileSchemaValidator,
  contentDigest,
  harnessRootFor,
  readManagedManifest,
  resolveHarnessPath,
  verifyRecordEnvelope,
  type CapabilityPlanRecord,
  type EdgeRecord,
  type NodeRecord,
} from "@universal-harness-internal/core";
import { assessUnattendedEligibility } from "@universal-harness-internal/plugin-sdk";

import { compileContextBundle, type ContextCandidate } from "../context/compiler.js";
import { buildGateEvidence, type GateEvidenceRecord } from "../gates/evidence.js";
import { runGate } from "../gates/provider.js";
import { resolveLoopPolicy } from "../loop/policy.js";
import { buildTaskEnvelope } from "../loop/task-envelope.js";
import {
  createDefaultGateSuite,
  materializeProjectGraph,
} from "../orchestration/kernel-coordinator.js";
import type { ParallelExecutionBinding } from "../orchestration/pipeline-types.js";
import {
  ParallelTaskExecutionError,
  capabilityPlanActivatesParallel,
  createLedgerSchedulerAuthority,
  driveParallelTaskExecution,
  type ParallelOperationLease,
  type ParallelTaskExecutionPort,
} from "../orchestration/scheduler-runtime.js";
import { readExecutionPlanContent, type ExecutionPlanContent } from "../planning/execution-plan.js";
import { taskSemanticDigest, type Protocol13TaskSpecification } from "../planning/task.js";
import type { AdapterControlProfile } from "../policy/action.js";
import { issueGrant, type CapabilityGrant } from "../policy/capability-grant.js";
import { mergePolicyLayers } from "../policy/evaluator.js";
import { createGitWorktreeWorkspacePort } from "../tdd/git-workspace.js";
import {
  WorkflowEngine,
  readCurrentOperation,
  type WorkflowDependencies,
} from "../workflow/operation.js";

import { createLocalAgentPool, type AgentSlotFactory } from "./agent-pool.js";
import {
  createFileSystemDriverLock,
  type DriverKind,
  type DriverLockHandle,
} from "./driver-lock.js";
import {
  bindSchedulingEvidence,
  createCandidateIntegrationController,
  createGitWaveIntegrationGit,
  type WaveGatePort,
} from "./integration.js";
import {
  createInMemoryPolicyDecisionPort,
  createPolicyDecisionAdapter,
  type SchedulerPolicyResolver,
} from "./policy-adapters.js";
import type { SchedulerProjectionStore } from "./ports.js";
import { readSchedulerModel, type SchedulerReadModel } from "./read-model.js";
import {
  createLocalTaskScheduler,
  type LocalTaskScheduler,
  type SchedulerCancelResult,
  type SchedulerCeilingBounds,
  type SchedulerDispatchCallbacks,
} from "./scheduler.js";
import {
  createInMemorySchedulerProjectionStore,
  createSqliteSchedulerProjectionStore,
} from "./sqlite-projection.js";
import { createWorkflowTaskDagAdapter, type WorkflowTaskDagReads } from "./task-dag-adapters.js";
import { createTaskWorkspaceManager } from "./workspace-manager.js";

/**
 * Project Scheduler Host (M4 plan Task 12 blocker slice). One composition
 * factory assembles every internal scheduling component around a real project
 * — Workflow Task DAG adapter, PolicyDecision adapter, workspace manager,
 * live-projection store, agent pool, local scheduler, candidate integration
 * controller, wave gates and the file-system Driver Lock — and exposes only
 * the four public surfaces the CLI/dashboard drivers consume:
 *
 * - `parallelExecution`: the ParallelExecutionBinding the kernel's parallel
 *   execute node consumes. `driverLock()` returns a deferred handle (the
 *   kernel evaluates it synchronously before `run`); `port.run` acquires the
 *   real file-system lock, drives, and always releases it in `finally`. A
 *   caller-supplied real handle is passed through untouched.
 * - `readSchedulerModel(operationId)`: the API-facing read model; it reports
 *   `inactive_by_profile` when the operation has no parallel-activating
 *   CapabilityPlan instead of fabricating tasks.
 * - `acquireDriverLock(operationId)`: explicit lock acquisition for drivers
 *   that orchestrate steps around a drive.
 * - `cancelOperation(operationId, reason)`: cooperative cancellation through
 *   the same LocalTaskScheduler/Pool stack, under this Operation's Driver
 *   Lock; it never substitutes Workflow abort for Scheduler reconciliation.
 *
 * Approval has no separate host channel: a wave/dispatch approval flows
 * through the PolicyDecision (`approval_digest`) the configured
 * `policyResolver` (or the default production policy adapter) returns, and
 * the CLI resolves approvals between drives through the existing approval
 * runtime. `TaskDagPort`/`PolicyDecisionPort` stay runtime-internal (global
 * constraint 25): only this factory and its input/output types are public.
 */

export interface ProjectSchedulerHostOptions {
  readonly projectRoot: string;
  /** Current approved baseline commit reader (e.g. `git rev-parse HEAD`). */
  readonly readBaseline: () => string;
  /** CLI-injected adapter construction seam; one fresh Adapter per run. */
  readonly agentSlotFactory: AgentSlotFactory;
  /**
   * Capability ids the adapter can satisfy (design §10.1 deviation: the
   * manifest declares control/metering/trajectory but no capability list).
   */
  readonly adapterCapabilities: readonly string[];
  /**
   * Policy decision resolver. Absent = the production adapter over the
   * deterministic evaluator with zero policy layers; present = the InMemory
   * adapter tests/conformance use (the decision must still bind the exact
   * action and effective policy digests).
   */
  readonly policyResolver?: SchedulerPolicyResolver;
  /** Connected mode only: the current M3 Operation Lease reader. */
  readonly readOperationLease?: (operationId: string) => ParallelOperationLease | undefined;
  /** Requested upper bound of concurrent task runs; defaults to 1. */
  readonly maxConcurrency?: number;
  readonly ceilings?: SchedulerCeilingBounds;
  /** Live-projection SQLite path; ":memory:" selects the InMemory store. */
  readonly projectionStorePath?: string;
  /** Driver identity recorded in the lock owner metadata; defaults to "cli". */
  readonly driverKind?: DriverKind;
  /** ISO clock; injectable so replays are byte-deterministic. */
  readonly now?: () => string;
  /** Id mint for workflow/ledger records; injectable for determinism. */
  readonly newId?: (kind: string) => string;
}

export interface ProjectSchedulerHost {
  readonly parallelExecution: ParallelExecutionBinding;
  readSchedulerModel(operationId: string): Promise<SchedulerReadModel>;
  acquireDriverLock(operationId: string): Promise<DriverLockHandle>;
  cancelOperation(operationId: string, reason: string): Promise<SchedulerCancelResult>;
}

const DEFAULT_CEILINGS: SchedulerCeilingBounds = {
  profile_limit: 2,
  installation_limit: 8,
  project_limit: 8,
  local_resource_limit: 8,
};

function digestId(prefix: string, parts: unknown): string {
  return `${prefix}_${contentDigest(parts).slice(0, 24)}`;
}

/**
 * Lazily compiled validator for Protocol 1.3 CapabilityPlan revisions, exactly
 * the kernel's dispatch rule (kernel-coordinator.ts): the persisted
 * protocol_version selects the schema, then the record envelope is verified.
 */
let capabilityPlanV13Validator: ReturnType<typeof compileSchemaValidator> | undefined;
function assertCapabilityPlanRecord(value: unknown, path: string): CapabilityPlanRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ParallelTaskExecutionError(
      "capability_plan_binding_drift",
      `CapabilityPlan artifact is not an object: ${path}`,
    );
  }
  const record = value as Record<string, unknown>;
  const validation =
    record["protocol_version"] === PROTOCOL_1_3_VERSION
      ? (capabilityPlanV13Validator ??= compileSchemaValidator(CapabilityPlanRecordV13Schema))(
          record,
        )
      : PROTOCOL_1_1_SCHEMA_REGISTRY.validate("capability-plan", record);
  if (!validation.valid || !verifyRecordEnvelope(record)) {
    throw new ParallelTaskExecutionError(
      "capability_plan_binding_drift",
      `CapabilityPlan artifact failed validation: ${path}: ${validation.errors
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }
  return record as unknown as CapabilityPlanRecord;
}

/** Latest revision per node id. */
function latestRevisions(nodes: readonly NodeRecord[]): NodeRecord[] {
  const byId = new Map<string, NodeRecord>();
  for (const node of nodes) {
    const current = byId.get(node.id);
    if (current === undefined || node.revision > current.revision) byId.set(node.id, node);
  }
  return [...byId.values()];
}

export function createProjectSchedulerHost(
  options: ProjectSchedulerHostOptions,
): ProjectSchedulerHost {
  const now = options.now ?? (() => new Date().toISOString());
  const harnessRoot = harnessRootFor(options.projectRoot);
  const managedRoot = join(harnessRoot, "managed");
  const workspaceRoot = join(managedRoot, "worktrees");
  const driverKind = options.driverKind ?? "cli";
  const requestedMaxConcurrency = Math.max(1, Math.floor(options.maxConcurrency ?? 1));
  const ceilings = options.ceilings ?? DEFAULT_CEILINGS;
  const capacity = Math.max(
    1,
    Math.min(
      requestedMaxConcurrency,
      ceilings.profile_limit,
      ceilings.installation_limit,
      ceilings.project_limit,
      ceilings.local_resource_limit,
    ),
  );
  const effectivePolicy = mergePolicyLayers([]).effective;
  const effectivePolicyDigest = effectivePolicy.digest;
  const adapterControlProfile: AdapterControlProfile = {
    control: options.agentSlotFactory.manifest.control,
    trajectory_visibility: options.agentSlotFactory.manifest.trajectory_visibility,
    usage_metering: options.agentSlotFactory.manifest.usage_metering,
    side_effect_interception: options.agentSlotFactory.manifest.side_effect_interception,
  };
  const unattendedEligible = assessUnattendedEligibility(
    options.agentSlotFactory.manifest,
  ).eligible;

  const deps: WorkflowDependencies = {
    projectRoot: options.projectRoot,
    readBaseline: options.readBaseline,
    now,
    ...(options.newId === undefined ? {} : { newId: options.newId }),
  };

  // --- Shared graph reads (WorkflowTaskDagAdapter + dispatch callbacks) ------

  interface PlanGraphContext {
    readonly plan: NodeRecord;
    readonly taskNodes: readonly NodeRecord[];
    readonly edges: readonly EdgeRecord[];
    readonly content: ExecutionPlanContent;
  }

  /** The latest accepted ExecutionPlan of the operation's iteration. */
  const acceptedPlanForOperation = (operationId: string): NodeRecord | undefined => {
    const operation = readCurrentOperation(deps, operationId);
    if (operation === undefined) return undefined;
    const graph = materializeProjectGraph(options.projectRoot);
    try {
      return graph.nodes
        .filter(
          (node) =>
            node.type === "ExecutionPlan" &&
            node.provenance.iteration_id === operation.iteration_id &&
            node.status === "accepted",
        )
        .sort((left, right) => left.revision - right.revision)
        .at(-1);
    } finally {
      graph.close();
    }
  };

  /** The exact Task/edge projection of one plan, derived from the graph. */
  const planGraphContext = (plan: NodeRecord): PlanGraphContext => {
    const graph = materializeProjectGraph(options.projectRoot);
    try {
      const contained = new Set(
        graph.edges
          .filter((edge) => edge.type === "CONTAINS" && edge.source_id === plan.id)
          .map((edge) => edge.target_id),
      );
      const taskNodes = latestRevisions(graph.nodes.filter((node) => contained.has(node.id)));
      const edges = graph.edges.filter(
        (edge) =>
          (edge.type === "CONTAINS" &&
            edge.source_id === plan.id &&
            contained.has(edge.target_id)) ||
          (edge.type === "DEPENDS_ON" &&
            contained.has(edge.source_id) &&
            contained.has(edge.target_id)),
      );
      const content = readExecutionPlanContent(plan, { tasks: taskNodes, edges });
      return { plan, taskNodes, edges, content };
    } finally {
      graph.close();
    }
  };

  const planContextForOperation = (operationId: string): PlanGraphContext => {
    const plan = acceptedPlanForOperation(operationId);
    if (plan === undefined) {
      throw new ParallelTaskExecutionError(
        "operation_not_found",
        `operation ${operationId} has no accepted execution plan`,
      );
    }
    return planGraphContext(plan);
  };

  const dagReads: WorkflowTaskDagReads = {
    readPlan: (operationId) => acceptedPlanForOperation(operationId),
    readTaskNodes: (planId) => {
      const graph = materializeProjectGraph(options.projectRoot);
      try {
        const plan = latestRevisions(graph.nodes.filter((node) => node.id === planId)).at(-1);
        return plan === undefined ? [] : planGraphContext(plan).taskNodes;
      } finally {
        graph.close();
      }
    },
    readEdgeRecords: (planId) => {
      const graph = materializeProjectGraph(options.projectRoot);
      try {
        const plan = latestRevisions(graph.nodes.filter((node) => node.id === planId)).at(-1);
        return plan === undefined ? [] : planGraphContext(plan).edges;
      } finally {
        graph.close();
      }
    },
    readApprovedBaseline: (operationId) =>
      new WorkflowEngine(deps).getWorkingState(operationId)?.baseline_commit,
  };
  const dagPort = createWorkflowTaskDagAdapter(dagReads);

  // --- Shared authority, workspaces, integration, gates, lock ---------------

  const authority = createLedgerSchedulerAuthority({ deps });
  const workspaces = createTaskWorkspaceManager({
    repositoryRoot: options.projectRoot,
    managedRoot,
    workspace: createGitWorktreeWorkspacePort({
      repositoryRoot: options.projectRoot,
      workspaceRoot,
    }),
  });
  const integrationGit = createGitWaveIntegrationGit({
    repositoryRoot: options.projectRoot,
    managedRoot,
    commitIdentity: { name: "universal-harness", email: "harness@localhost" },
  });
  const gateSuite = createDefaultGateSuite(options.projectRoot);

  const runSchedulingGate = async (input: {
    readonly gateId: string;
    readonly layer: "candidate" | "wave";
    readonly subjectId: string;
    readonly candidateCommit: string;
    readonly uniqueness: unknown;
  }): Promise<GateEvidenceRecord> => {
    const gate = gateSuite.gates.find((definition) => definition.gate_id === input.gateId);
    if (gate === undefined) {
      throw new ParallelTaskExecutionError(
        "capability_plan_binding_drift",
        `gate ${input.gateId} has no definition in the host gate suite`,
      );
    }
    const outcome = await runGate(gateSuite.registry, gate, {
      intentId: digestId("gate-intent", {
        gate_id: input.gateId,
        layer: input.layer,
        subject_id: input.subjectId,
        commit: input.candidateCommit,
        uniqueness: input.uniqueness,
      }),
    });
    return buildGateEvidence({
      evidenceId: digestId("evidence", {
        gate_id: input.gateId,
        layer: input.layer,
        subject_id: input.subjectId,
        commit: input.candidateCommit,
        uniqueness: input.uniqueness,
      }),
      createdAt: now(),
      // The candidate/wave verdict addresses the Task/wave it gates, never the
      // suite-wide default subject.
      outcome: { ...outcome, subject_id: input.subjectId },
      bindings: {
        artifact_digests: [],
        code_digests: [input.candidateCommit],
        gate_digest: gate.digest,
        evaluation_case_digests: [],
        policy_digest: effectivePolicyDigest,
      },
    });
  };

  const waveGates: WaveGatePort = {
    definitions: () => gateSuite.gates,
    async runCandidateGates({ task, candidate_commit, lease }) {
      // A task with no required_gates selects the full suite; otherwise
      // exactly the gates the approved plan names (design §13.3 layer 2).
      const selected =
        task.required_gates.length === 0
          ? gateSuite.gates
          : gateSuite.gates.filter((definition) =>
              task.required_gates.includes(definition.gate_id),
            );
      const records: GateEvidenceRecord[] = [];
      for (const gate of selected) {
        const record = await runSchedulingGate({
          gateId: gate.gate_id,
          layer: "candidate",
          subjectId: task.id,
          candidateCommit: candidate_commit,
          uniqueness: { run_id: lease.run_id, fencing_token: lease.fencing_token },
        });
        records.push(
          bindSchedulingEvidence(record, {
            plan_digest: lease.plan_digest,
            task_digest: taskSemanticDigest(task),
            task_id: task.id,
            run_id: lease.run_id,
            lease_id: lease.lease_id,
            fencing_token: lease.fencing_token,
            commit: candidate_commit,
            layer: "candidate",
          }),
        );
      }
      return records;
    },
    async runWaveGates({ dag, wave_index, candidate_commit, tasks, leases }) {
      const anchorTask = tasks[0];
      const anchorLease = leases[0];
      const records: GateEvidenceRecord[] = [];
      for (const gate of gateSuite.gates) {
        const record = await runSchedulingGate({
          gateId: gate.gate_id,
          layer: "wave",
          subjectId: `wave_${String(wave_index)}`,
          candidateCommit: candidate_commit,
          uniqueness: { wave_index },
        });
        records.push(
          bindSchedulingEvidence(record, {
            plan_digest: dag.plan_digest,
            ...(anchorTask === undefined || anchorLease === undefined
              ? {}
              : {
                  task_digest: taskSemanticDigest(anchorTask),
                  task_id: anchorTask.id,
                  run_id: anchorLease.run_id,
                  lease_id: anchorLease.lease_id,
                  fencing_token: anchorLease.fencing_token,
                }),
            commit: candidate_commit,
            layer: "wave",
          }),
        );
      }
      return records;
    },
  };

  const driverLock = createFileSystemDriverLock({
    harness_root: harnessRoot,
    host: driverKind,
    pid: process.pid,
  });

  const projectionStore: SchedulerProjectionStore =
    options.projectionStorePath === ":memory:"
      ? createInMemorySchedulerProjectionStore()
      : createSqliteSchedulerProjectionStore({
          path: options.projectionStorePath ?? join(harnessRoot, "scheduler-projection.sqlite"),
        });

  // --- Policy ----------------------------------------------------------------

  /** Grants this host issued, keyed by Task semantic digest (adapter readGrant). */
  const issuedGrants = new Map<string, CapabilityGrant>();
  const policy = options.policyResolver
    ? createInMemoryPolicyDecisionPort({ resolve: options.policyResolver })
    : createPolicyDecisionAdapter({
        readLayers: () => [],
        readGrant: (taskDigest) =>
          taskDigest === undefined ? undefined : issuedGrants.get(taskDigest),
      });

  // --- CapabilityPlan loading (kernel-equivalent scan) ------------------------

  const loadLatestCapabilityPlan = (operationId: string): CapabilityPlanRecord | undefined => {
    const root = resolveHarnessPath(harnessRoot, "artifacts/capability-plans");
    if (!existsSync(root)) return undefined;
    const plans: CapabilityPlanRecord[] = [];
    for (const directory of readdirSync(root, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      const absoluteDirectory = join(root, directory.name);
      for (const name of readdirSync(absoluteDirectory)
        .filter((entry) => /^[0-9]+\.json$/u.test(entry))
        .sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10))) {
        const path = join(absoluteDirectory, name);
        const plan = assertCapabilityPlanRecord(
          JSON.parse(readFileSync(path, "utf8")) as unknown,
          path,
        );
        if (plan.operation_id === operationId) plans.push(plan);
      }
    }
    return plans.sort((left, right) => left.revision - right.revision).at(-1);
  };

  // --- Per-operation stacks ---------------------------------------------------

  const assembleTaskContext = (
    operationId: string,
    task: Protocol13TaskSpecification,
  ): { readonly context_bundle_id: string; readonly context_bundle_digest: string } => {
    const context = planContextForOperation(operationId);
    const taskNode = context.taskNodes.find((node) => node.id === task.id);
    if (taskNode === undefined) {
      throw new ParallelTaskExecutionError(
        "operation_not_found",
        `task ${task.id} is not a graph node of the accepted plan`,
      );
    }
    const dependencyNodes = context.taskNodes.filter((node) => task.dependencies.includes(node.id));
    const candidates: ContextCandidate[] = [
      { node: taskNode, content: canonicalizeJson(taskNode), tier: 1, reason: "task" },
      ...dependencyNodes.map((node): ContextCandidate => ({
        node,
        content: canonicalizeJson(node),
        tier: 1,
        reason: "dependency",
      })),
      {
        node: context.plan,
        content: canonicalizeJson(context.plan),
        tier: 2,
        reason: "plan",
      },
    ];
    const bundle = compileContextBundle({
      taskId: task.id,
      goal: context.content.shared_context.goal,
      bindings: {
        requirement_baseline_digest: context.content.shared_context.requirement_baseline_digest,
        policy_digest: context.content.shared_context.policy_digest,
        plan_digest: context.content.content_digest,
        impact_coverage_digest: context.content.impact_coverage.digest,
        task_digest: taskSemanticDigest(task),
        approval_digests: [],
      },
      tokenBudget: task.budget.tokens,
      candidates,
    });
    return {
      context_bundle_id: bundle.record.context_bundle_id,
      context_bundle_digest: bundle.record.digest,
    };
  };

  interface OperationStack {
    readonly port: ParallelTaskExecutionPort;
    readonly scheduler: LocalTaskScheduler;
  }
  const stacks = new Map<string, OperationStack>();

  const stackFor = (operationId: string): OperationStack => {
    const existing = stacks.get(operationId);
    if (existing !== undefined) return existing;
    const capabilityPlan = loadLatestCapabilityPlan(operationId);
    if (capabilityPlan === undefined) {
      throw new ParallelTaskExecutionError(
        "capability_not_active",
        `operation ${operationId} has no accepted CapabilityPlan revision`,
      );
    }
    const pool = createLocalAgentPool({
      factory: options.agentSlotFactory,
      capacity,
      operation_id: operationId,
      projection: projectionStore,
      now,
    });
    const callbacks: SchedulerDispatchCallbacks = {
      assembleContext: ({ task }) => Promise.resolve(assembleTaskContext(operationId, task)),
      issueTaskGrant: ({ task, decision, lease, reservation }) => {
        const grant = issueGrant(
          {
            grant_id: digestId("grant", {
              operation_id: operationId,
              task_id: task.id,
              run_id: lease.run_id,
              fencing_token: lease.fencing_token,
            }),
            task_id: task.id,
            capabilities: task.capabilities,
            read_paths: [...task.write_paths],
            write_paths: task.write_paths,
            tools: task.tools.map((name) => ({ name })),
            phase: "execute",
            budget: { steps: reservation.steps, tokens: reservation.tokens },
            approval_digests:
              decision.approval_digest === undefined ? [] : [decision.approval_digest],
          },
          effectivePolicy,
        );
        issuedGrants.set(taskSemanticDigest(task), grant);
        return grant;
      },
      buildEnvelope: ({ task, grant, context, lease }) =>
        buildTaskEnvelope({
          task_id: task.id,
          plan_id: planContextForOperation(operationId).plan.id,
          iteration_id: lease.iteration_id,
          repository_id: readManagedManifest(options.projectRoot).repository_id,
          baseline_id: `baseline_${lease.baseline_commit.slice(0, 12)}`,
          objective: task.objective,
          expected_output: task.expected_outputs.join(", "),
          acceptance_criteria: task.acceptance.map((criterion) => criterion.description),
          dependency_task_ids: [...task.dependencies],
          required_gate_ids: [...task.required_gates],
          input_node_revisions: {},
          context_bundle_id: context.context_bundle_id,
          context_bundle_digest: context.context_bundle_digest,
          protected_context_fields: [],
          allowed_read_paths: grant.read_paths,
          proposed_write_paths: grant.write_paths,
          state_read_fields: [],
          state_proposal_fields: [],
          tools: grant.tools,
          risk: task.risk,
          required_approval_digests: [...grant.approval_digests].sort(),
          external_side_effect: "forbidden",
          idempotency_scope: `iteration/${lease.iteration_id}/task/${task.id}`,
          loop_policy: resolveLoopPolicy(effectivePolicy),
          baseline_commit: lease.baseline_commit,
          input_digest: context.context_bundle_digest,
          stale_input_behavior: "recompile",
        }),
      evidenceDir: ({ task_id, run_id }) => join(harnessRoot, "evidence", task_id, run_id),
    };
    const scheduler = createLocalTaskScheduler({
      dag_port: dagPort,
      policy,
      authority,
      pool,
      workspaces,
      adapter_manifest_digest: options.agentSlotFactory.adapter_manifest_digest,
      adapter_control_profile: adapterControlProfile,
      adapter_capabilities: options.adapterCapabilities,
      unattended_eligible: unattendedEligible,
      ceilings,
      effective_policy_digest: effectivePolicyDigest,
      callbacks,
      now,
    });
    const integration = createCandidateIntegrationController({
      authority,
      git: integrationGit,
      gates: waveGates,
      effective_policy_digest: effectivePolicyDigest,
      adapter_manifest_digest: options.agentSlotFactory.adapter_manifest_digest,
      adapter_control_profile: adapterControlProfile,
      now,
    });
    const port = driveParallelTaskExecution({
      scheduler,
      integration,
      authority,
      dag_port: dagPort,
      policy,
      capability_plan: capabilityPlan,
      requested_max_concurrency: requestedMaxConcurrency,
      adapter_manifest_digest: options.agentSlotFactory.adapter_manifest_digest,
      adapter_control_profile: adapterControlProfile,
      effective_policy_digest: effectivePolicyDigest,
      now,
    });
    const stack: OperationStack = { port, scheduler };
    stacks.set(operationId, stack);
    return stack;
  };

  // --- Deferred Driver Lock facade ---------------------------------------------

  /**
   * The kernel evaluates `binding.driverLock()` synchronously before `run`
   * (kernel-coordinator.ts), but the file-system lock acquisition is async.
   * The facade is a placeholder the run wrapper swaps for the real handle; its
   * fields never reach the inner driver's validation.
   */
  interface FacadeBinding {
    handle: DriverLockHandle | undefined;
  }
  const facadeBindings = new WeakMap<DriverLockHandle, FacadeBinding>();
  const activeDriverLocks = new Map<string, DriverLockHandle>();
  const deferredDriverLock = (): DriverLockHandle => {
    const binding: FacadeBinding = { handle: undefined };
    const facade: DriverLockHandle = {
      operation_id: "",
      owner_token: "deferred",
      path: "",
      release: async () => {
        await binding.handle?.release();
      },
    };
    facadeBindings.set(facade, binding);
    return facade;
  };

  const parallelPort: ParallelTaskExecutionPort = {
    async run(input) {
      // Connected mode: resolve the current M3 Operation Lease for this
      // operation when the caller did not pass one explicitly.
      const lease = input.operation_lease ?? options.readOperationLease?.(input.operation_id);
      const resolved = lease === undefined ? input : { ...input, operation_lease: lease };
      const facade = facadeBindings.get(resolved.driver_lock);
      if (facade === undefined) {
        // Caller-supplied real handle: the caller owns its lifecycle.
        activeDriverLocks.set(resolved.operation_id, resolved.driver_lock);
        try {
          return await stackFor(resolved.operation_id).port.run(resolved);
        } finally {
          if (activeDriverLocks.get(resolved.operation_id) === resolved.driver_lock) {
            activeDriverLocks.delete(resolved.operation_id);
          }
        }
      }
      const handle = await driverLock.acquire({
        operation_id: resolved.operation_id,
        driver_kind: driverKind,
      });
      facade.handle = handle;
      activeDriverLocks.set(resolved.operation_id, handle);
      try {
        return await stackFor(resolved.operation_id).port.run({ ...resolved, driver_lock: handle });
      } finally {
        if (activeDriverLocks.get(resolved.operation_id) === handle) {
          activeDriverLocks.delete(resolved.operation_id);
        }
        facade.handle = undefined;
        await handle.release();
      }
    },
  };

  const parallelExecution: ParallelExecutionBinding = {
    port: parallelPort,
    driverLock: deferredDriverLock,
  };

  return {
    parallelExecution,
    readSchedulerModel: async (operationId) => {
      const capabilityPlan = loadLatestCapabilityPlan(operationId);
      const active =
        capabilityPlan !== undefined && capabilityPlanActivatesParallel(capabilityPlan);
      return readSchedulerModel({
        capability: active ? "active" : "inactive_by_profile",
        operation_id: operationId,
        dag_port: dagPort,
        authority,
        live: projectionStore,
        now,
      });
    },
    acquireDriverLock: (operationId) =>
      driverLock.acquire({ operation_id: operationId, driver_kind: driverKind }),
    cancelOperation: async (operationId, reason) => {
      const activeHandle = activeDriverLocks.get(operationId);
      const handle =
        activeHandle ??
        (await driverLock.acquire({ operation_id: operationId, driver_kind: driverKind }));
      try {
        return await stackFor(operationId).scheduler.cancel({
          operation_id: operationId,
          command_id: digestId("command", {
            purpose: "cancel-operation",
            operation_id: operationId,
            reason,
          }),
          reason,
          driver_lock: handle,
        });
      } finally {
        if (activeHandle === undefined) await handle.release();
      }
    },
  };
}
