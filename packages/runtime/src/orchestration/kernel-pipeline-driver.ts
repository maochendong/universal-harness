/**
 * Production pipeline driver (extracted from kernel-coordinator.ts). Owns the
 * phase drivers — the Protocol 1.1 CapabilityPlan DAG drive and the linear
 * kernel drive — plus the snapshot phase step and pipeline-context
 * construction. All shared pipeline machinery (artifact readers, approvals,
 * checkpoints, kernel phase steps before snapshot) stays in the Kernel
 * Coordinator; this module imports it and the coordinator never imports back,
 * so the layering is one-directional.
 */
import { existsSync, readdirSync } from "node:fs";
import {
  PROTOCOL_1_3_VERSION,
  canonicalizeJson,
  contentDigest,
  readManagedManifest,
  resolveHarnessPath,
  sha256Hex,
  type BindingKindV13,
} from "@universal-harness-internal/core";
import { readDesignSetExtension, readImpactSetContent } from "@universal-harness-internal/graph";
import type { AgentRunResult } from "@universal-harness-internal/plugin-sdk";
import { resumeCommandFor } from "../approval/interaction.js";
import { projectTaskVerdict } from "../evaluation/outcome-projection.js";
import {
  buildKernelTaskVerdict,
  buildTaskVerdict,
  type TaskVerdictRecord,
} from "../evaluation/task-verdict.js";
import { type GateDefinition } from "../gates/provider.js";
import { FileLiveSpool } from "../observability/live-spool.js";
import {
  ObservationPublisher,
  type ObservationStreamIdentity,
} from "../observability/publisher.js";
import { ProjectionError, writeManagedOutput } from "../projection/managed-output.js";
import { buildSnapshot, type SnapshotRecord } from "../snapshot/builder.js";
import { narrateIteration } from "../snapshot/narrative.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { DagNodeResult } from "../workflow/dag.js";
import { LedgerDagCheckpointStore } from "../workflow/ledger-dag-checkpoint-store.js";
import { WorkflowEngine } from "../workflow/operation.js";
import { type RecoverableBlockReason } from "../workflow/state-machine.js";
import { createCapabilityDagRunnerRegistry } from "./capability-dag-runners.js";
import { createCapabilityDagRuntime } from "./capability-dag-runtime.js";
import {
  HARNESS_COMMIT_IDENTITY,
  acceptedPrdForOperation,
  activateModulesFromCapabilityPlan,
  blockWithSnapshot,
  captureProposal,
  commitArtifacts,
  commitEvidenceNodes,
  commitIterationNode,
  commitRunNode,
  commitScannedDocumentation,
  commitTaskVerdict,
  commitVerifiedSourceTree,
  createDefaultGateSuite,
  currentAttemptId,
  ensureInitialCapabilityPlan,
  finalizeCapabilityPlan,
  harnessRoot,
  loadAcceptedDesignSet,
  loadCapabilityPlans,
  loadCompletedRun,
  loadEvaluateArtifacts,
  loadFrozenImpactSet,
  loadPlan,
  loadTaskTddContract,
  loadVerifyArtifact,
  materializeProjectGraph,
  nowOf,
  observe,
  orderedPlanTasks,
  PENDING_REQUIREMENT_BASELINE_DIGEST,
  phaseCapture,
  phaseContext,
  phaseExecute,
  phasePlan,
  phaseVerify,
  readJsonArtifact,
  refreshWorkingState,
  snapshotBaseInput,
  sourceRootOf,
  storedEvidenceMaterials,
  taskTddVerdictInput,
  verifyBindings,
  workflowDeps,
  type AuditCommitOutcome,
  type ModuleContributions,
  type ModulePhaseStep,
  type PhaseStep,
  type PipelineContext,
} from "./kernel-coordinator.js";
import {
  ORCHESTRATION_PHASES,
  PHASE_CHECKPOINT_BOUNDARY,
  phaseRank,
  type OrchestrationPhase,
} from "./phases.js";
import { OrchestrationError } from "./pipeline-types.js";
import type {
  OrchestrationOutcome,
  OrchestratorDependencies,
  PhaseProgressEvent,
  RunIterationInput,
} from "./pipeline-types.js";
import { finalizeSnapshotLedger } from "./snapshot-runtime.js";
import type { ParallelTaskExecutionOutcome } from "./scheduler-runtime.js";

/** Route the completion audit through its contribution; unregistered means zero findings. */
export async function commitAuditContribution(ctx: PipelineContext): Promise<AuditCommitOutcome> {
  if (ctx.modules.audit === undefined) {
    return { blockingFindingIds: [] };
  }
  return ctx.modules.audit.commitFindings(ctx);
}
const TASKS_PROJECTION_OUTPUT = "views/tasks.md";
/** Task ids proven complete by any committed snapshot, sorted for determinism. */
function completedTaskIds(deps: OrchestratorDependencies): string[] {
  const directory = resolveHarnessPath(harnessRoot(deps), "artifacts/snapshots");
  if (!existsSync(directory)) return [];
  const completed = new Set<string>();
  for (const name of readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .sort()) {
    const record = readJsonArtifact<SnapshotRecord>(deps, `artifacts/snapshots/${name}`);
    if (record === undefined) continue;
    const verdicts = record.task_verdicts ?? [];
    for (const verdict of verdicts) {
      if (verdict.verdict === "passed") completed.add(verdict.task_id);
    }
    if (verdicts.length === 0) {
      for (const outcome of record.run_outcomes) {
        if (outcome.id.startsWith("task_") && outcome.outcome === "success") {
          completed.add(outcome.id);
        }
      }
    }
  }
  return [...completed].sort();
}
/**
 * Regenerate the tasks.md projection at the completing snapshot (comparative
 * design direction 1). The graph is the only source of truth and the file a
 * disposable view: a hand edit is drift, so a refused managed write leaves
 * the user's bytes untouched -- the stale projection stays visible through
 * drift detection instead of breaking the iteration.
 */
async function regenerateTasksProjection(ctx: PipelineContext): Promise<void> {
  const { deps } = ctx;
  if (deps.tasksProjection === undefined) return;
  const graph = materializeProjectGraph(deps.projectRoot);
  let markdown: string;
  try {
    markdown = deps.tasksProjection(
      { nodes: graph.nodes, edges: graph.edges },
      { completedTasks: completedTaskIds(deps) },
    ).markdown;
  } finally {
    graph.close();
  }
  try {
    writeManagedOutput(
      harnessRoot(deps),
      { name: TASKS_PROJECTION_OUTPUT, content: markdown },
      { rewriteVerifiedProjection: true },
    );
  } catch (error) {
    if (error instanceof ProjectionError && error.kind === "unapproved_overwrite") return;
    throw error;
  }
}
async function phaseSnapshot(ctx: PipelineContext): Promise<PhaseStep> {
  const { deps } = ctx;
  const plan = ctx.plan ?? loadPlan(ctx);
  if (plan === undefined)
    throw new OrchestrationError("binding_drift", "snapshot phase requires a plan");
  ctx.plan = plan;
  const tasks = orderedPlanTasks(plan.content.tasks);
  if (tasks.length === 0) throw new OrchestrationError("configuration", "plan carries no tasks");
  // Every planned task needs its terminated run and its committed evaluation;
  // the snapshot completes only when all of them succeeded.
  const taskRuns: {
    readonly taskId: string;
    readonly runId: string;
    readonly result: AgentRunResult;
  }[] = [];
  for (const task of tasks) {
    const run = loadCompletedRun(ctx, task.id);
    if (run === undefined) {
      throw new OrchestrationError(
        "binding_drift",
        `snapshot phase requires a run for task ${task.id}`,
      );
    }
    taskRuns.push({ taskId: task.id, runId: run.runId, result: run.result });
  }
  // Parallel Scheduler runs are authoritative RunRecord streams rather than
  // generic run-result artifacts. Project their existing ids into the graph
  // before TaskVerdict emits EXECUTES/PRODUCES evidence edges; this is an
  // idempotent graph view, not a second run fact.
  for (const taskRun of taskRuns) {
    await commitRunNode(ctx, taskRun.runId, taskRun.taskId);
  }
  ctx.run = taskRuns.at(-1) as { readonly runId: string; readonly result: AgentRunResult };
  const evaluations = taskRuns.map(
    (taskRun) =>
      loadEvaluateArtifacts(deps, ctx.iterationId).find(
        (artifact) => artifact.run_digest === sha256Hex(canonicalizeJson(taskRun.result)),
      )?.result,
  );
  // Completion is a graph verdict, not merely a successful agent claim.
  // Rescan first, attach the still-fresh gate evidence to newly discovered
  // tests, then audit the resulting graph before creating any completed
  // snapshot or completed Iteration revision.
  await commitIterationNode(ctx, "running");
  await commitScannedDocumentation(ctx);
  const suiteGates = ctx.deps.gates ?? createDefaultGateSuite(sourceRootOf(ctx)).gates;
  const bindings = verifyBindings(ctx);
  const verifyStored = loadVerifyArtifact(deps, ctx.iterationId, bindings);
  if (verifyStored !== undefined) {
    await commitEvidenceNodes(
      ctx,
      storedEvidenceMaterials(deps, suiteGates, verifyStored),
      bindings,
    );
  }
  if (verifyStored === undefined) {
    const driftAudit = ctx.protocol11Dag
      ? { blockingFindingIds: [] }
      : await commitAuditContribution(ctx);
    const detail =
      driftAudit.blockingFindingIds.length > 0
        ? `graph audit blocked completion: ${driftAudit.blockingFindingIds.join(", ")}`
        : "verification bindings changed after gates; current graph requires a fresh gate verdict";
    const outcome = await blockWithSnapshot(ctx, {
      reason: "repairable_gate_failure",
      detail,
      resumePhase: "verify",
      input: {
        ...snapshotBaseInput(
          ctx,
          taskRuns.map((taskRun) => ({
            task_id: taskRun.taskId,
            required: true,
            outcome: taskRun.result.outcome,
          })),
        ),
        runs: taskRuns.map((taskRun) => ({
          run_id: taskRun.runId,
          required: true,
          outcome: taskRun.result.outcome,
        })),
      },
    });
    return { continue: false, outcome };
  }
  const taskVerdicts: TaskVerdictRecord[] = [];
  const evaluateActive = ctx.modules.evaluate !== undefined;
  for (const [index, task] of tasks.entries()) {
    const taskRun = taskRuns[index];
    const evaluation = evaluations[index];
    if (taskRun === undefined || (evaluateActive && evaluation === undefined)) {
      throw new OrchestrationError(
        "binding_drift",
        `task ${task.id} has no committed run evaluation`,
      );
    }
    const verdictId = `verdict_${contentDigest({
      task: task.id,
      run: taskRun.runId,
      gates: verifyStored.results.map((result) => result.evidence_id),
      ...(evaluation === undefined ? {} : { evaluation: evaluation.evidenceId }),
    }).slice(0, 16)}`;
    const tdd = taskTddVerdictInput(
      ctx,
      task,
      verifyStored.results.every((result) => result.passed),
      evaluation?.passed,
    );
    const verdictInput = {
      verdictId,
      iterationId: ctx.iterationId,
      taskId: task.id,
      runIds: [taskRun.runId],
      assertions: task.assertions ?? [],
      gates: verifyStored.results.map((result) => ({
        gate_id: result.gate_id,
        passed: result.passed,
        evidence_id: result.evidence_id,
      })),
      createdAt: nowOf(deps),
      ...(tdd === undefined ? {} : { tdd }),
    };
    const verdict =
      evaluation === undefined
        ? buildKernelTaskVerdict(verdictInput)
        : buildTaskVerdict({
            ...verdictInput,
            evaluations: [{ passed: evaluation.passed, evidence_id: evaluation.evidenceId }],
          });
    await commitTaskVerdict(ctx, verdict);
    taskVerdicts.push(verdict);
  }
  const passedTaskIds = taskVerdicts
    .filter((verdict) => verdict.verdict === "passed")
    .map((verdict) => verdict.task_id);
  if (passedTaskIds.length > 0) {
    await ctx.engine.commitCheckpoint(ctx.workflowOperationId, {
      boundary: PHASE_CHECKPOINT_BOUNDARY.snapshot,
      proposal: {
        phase: "snapshot",
        reconcile_blockers: { passed_task_ids: passedTaskIds },
      },
    });
    refreshWorkingState(ctx);
  }
  if (taskVerdicts.some((verdict) => verdict.verdict !== "passed")) {
    const outcome = await blockWithSnapshot(ctx, {
      reason: "repairable_gate_failure",
      detail: "one or more TaskVerdicts did not pass",
      resumePhase: "verify",
      input: {
        ...snapshotBaseInput(
          ctx,
          taskRuns.map((taskRun) => ({
            task_id: taskRun.taskId,
            required: true,
            outcome: taskRun.result.outcome,
          })),
        ),
        task_verdicts: taskVerdicts.map(projectTaskVerdict),
        runs: taskRuns.map((taskRun) => ({
          run_id: taskRun.runId,
          required: true,
          outcome: taskRun.result.outcome,
        })),
      },
    });
    return { continue: false, outcome };
  }
  const audit = ctx.protocol11Dag ? { blockingFindingIds: [] } : await commitAuditContribution(ctx);
  if (audit.blockingFindingIds.length > 0) {
    const outcome = await blockWithSnapshot(ctx, {
      reason: "repairable_gate_failure",
      detail: `graph audit blocked completion: ${audit.blockingFindingIds.join(", ")}`,
      resumePhase: "verify",
      input: {
        ...snapshotBaseInput(
          ctx,
          taskRuns.map((taskRun) => ({
            task_id: taskRun.taskId,
            required: true,
            outcome: taskRun.result.outcome,
          })),
        ),
        task_verdicts: taskVerdicts.map(projectTaskVerdict),
        runs: taskRuns.map((taskRun) => ({
          run_id: taskRun.runId,
          required: true,
          outcome: taskRun.result.outcome,
        })),
      },
    });
    return { continue: false, outcome };
  }
  const resolvedAuditBlockers = ctx.workingState.blockers.filter((blocker) =>
    blocker.startsWith("graph audit blocked completion:"),
  );
  if (resolvedAuditBlockers.length > 0) {
    await ctx.engine.commitCheckpoint(ctx.workflowOperationId, {
      boundary: PHASE_CHECKPOINT_BOUNDARY.snapshot,
      proposal: { phase: "snapshot", clear_blockers: resolvedAuditBlockers },
    });
    refreshWorkingState(ctx);
  }

  const sourceCommit = await commitVerifiedSourceTree(ctx, plan.content, taskRuns);
  const snapshot = buildSnapshot({
    ...snapshotBaseInput(
      ctx,
      taskRuns.map((taskRun) => ({
        task_id: taskRun.taskId,
        required: true,
        outcome: taskRun.result.outcome,
      })),
    ),
    snapshot_id: `snapshot_${sha256Hex(`${ctx.iterationId}:completed`).slice(0, 16)}`,
    source_commit: sourceCommit,
    created_at: nowOf(deps),
    execution_plan_id: plan.node.id,
    task_verdicts: taskVerdicts.map(projectTaskVerdict),
    runs: taskRuns.map((taskRun) => ({
      run_id: taskRun.runId,
      required: true,
      outcome: taskRun.result.outcome,
    })),
    findings: [
      ...(verifyStored?.findings ?? []).map((finding) => ({
        finding_id: finding.id,
        blocking: true,
        status: "closed" as const,
      })),
      ...evaluations.flatMap((evaluation) =>
        (evaluation?.findings ?? []).map((finding) => ({
          finding_id: finding.id,
          blocking: true,
          status: "proposed" as const,
        })),
      ),
    ],
    evidence: [
      ...(verifyStored?.results ?? []).map((result) => ({
        evidence_id: result.evidence_id,
        mandatory: true,
        passed: result.passed,
        provisional: false,
        stale: false,
      })),
      ...evaluations.flatMap((evaluation) =>
        evaluation === undefined
          ? []
          : [
              {
                evidence_id: evaluation.evidenceId,
                mandatory: true,
                passed: evaluation.passed,
                provisional: false,
                stale: false,
              },
            ],
      ),
    ],
  });
  if (snapshot.status !== "completed") {
    throw new OrchestrationError(
      "binding_drift",
      `snapshot phase reached without a completable iteration: ${(snapshot.blockers ?? []).join("; ")}`,
    );
  }
  await commitArtifacts(deps, ctx.workflowOperationId, currentAttemptId(ctx), [
    {
      path: `artifacts/snapshots/${snapshot.snapshot_id}.json`,
      content: `${canonicalizeJson(snapshot)}\n`,
    },
  ]);
  await commitIterationNode(ctx, "completed");
  await regenerateTasksProjection(ctx);
  await ctx.engine.advance(ctx.workflowOperationId, "completed");
  // PG-7: the narrative is compiled only after the authoritative snapshot
  // commits; a failure produces a recoverable projection finding and never
  // changes the snapshot, the verdicts or this outcome.
  await narrateIteration(ctx, snapshot, contentDigest(snapshot));
  let ledgerCommit: string | null = null;
  if (deps.vcs !== undefined) {
    const committed = await deps.vcs.commit(deps.projectRoot, {
      message: `harness: record iteration ${ctx.iterationId}`,
      paths: [".harness"],
      identity: HARNESS_COMMIT_IDENTITY,
    });
    if (committed.ok) ledgerCommit = committed.value;
  }
  const repositoryHead = deps.readBaseline();
  return {
    continue: false,
    outcome: {
      status: "completed",
      workflowOperationId: ctx.workflowOperationId,
      iterationId: ctx.iterationId,
      snapshotId: snapshot.snapshot_id,
      sourceCommit,
      ledgerCommit,
      repositoryHead,
    },
  };
}
/** Advance the operation into the state a phase runs under. */
async function advanceIntoPhase(ctx: PipelineContext, phase: OrchestrationPhase): Promise<void> {
  const current = ctx.engine.getOperation(ctx.workflowOperationId);
  if (current === undefined) {
    throw new OrchestrationError(
      "operation_not_found",
      `unknown operation ${ctx.workflowOperationId}`,
    );
  }
  const target =
    phase === "capture" || phase === "impact" || phase === "design"
      ? "awaiting_approval"
      : phase === "plan"
        ? "planned"
        : phase === "context" || phase === "execute"
          ? "running"
          : "verifying";
  if (current.state === target) return;
  // Repair re-entry: verifying -> repairing -> running is the only legal way
  // back into execution (design 10 state chain).
  if (target === "running" && current.state === "verifying") {
    await ctx.engine.advance(ctx.workflowOperationId, "repairing");
    await ctx.engine.advance(ctx.workflowOperationId, "running");
    refreshWorkingState(ctx);
    return;
  }
  await ctx.engine.advance(ctx.workflowOperationId, target);
  refreshWorkingState(ctx);
}

function gateSuiteFor(ctx: PipelineContext): {
  readonly gates: readonly GateDefinition[];
  readonly registry: ToolRegistry;
} {
  if (ctx.sourceView !== undefined) {
    if (ctx.deps.gateSuiteForWorkspace !== undefined) {
      return ctx.deps.gateSuiteForWorkspace(sourceRootOf(ctx));
    }
    if (ctx.deps.gates !== undefined) {
      throw new OrchestrationError(
        "configuration",
        "configured gates cannot verify a parallel operation source without gateSuiteForWorkspace",
      );
    }
    return createDefaultGateSuite(sourceRootOf(ctx));
  }
  return ctx.deps.gates === undefined
    ? createDefaultGateSuite(sourceRootOf(ctx))
    : {
        gates: ctx.deps.gates,
        registry:
          ctx.deps.toolRegistry ??
          (() => {
            throw new OrchestrationError(
              "configuration",
              "custom gates require an explicit tool registry",
            );
          })(),
      };
}

function approvalNotice(outcome: OrchestrationOutcome): DagNodeResult {
  if (outcome.status === "approval_required") {
    return {
      status: "awaiting_approval",
      approval: {
        object_id: outcome.required.object_id,
        object_kind: outcome.required.object_type,
        object_digest: outcome.required.object_digest,
      },
    };
  }
  return {
    status: "blocked",
    reason: outcome.status,
    detail:
      "detail" in outcome
        ? outcome.detail
        : `operation paused with orchestration outcome ${outcome.status}`,
  };
}

/**
 * Protocol 1.1 production driver. Capture remains the bootstrap that makes
 * the accepted PRD available; after that boundary the accepted
 * CapabilityPlan operation_dag is the sole router and every durable node is
 * journaled through WorkflowDagEngine.
 */
async function driveCapabilityPipeline(
  ctx: PipelineContext,
  fromPhase: OrchestrationPhase,
  untilPhase: OrchestrationPhase | undefined,
): Promise<OrchestrationOutcome> {
  const suite = gateSuiteFor(ctx);
  let terminal: OrchestrationOutcome | undefined;
  /** Outcome of the parallel execute drive, consumed by the produces closure. */
  let parallelOutcome: ParallelTaskExecutionOutcome | undefined;

  // Capture is the only legal bootstrap before the plan exists. It remains
  // idempotent on resume; the DAG capture runner below imports its accepted
  // RequirementBaseline as the first protocol checkpoint.
  if (ctx.capabilityPlan === undefined && loadCapabilityPlans(ctx).length === 0) {
    await advanceIntoPhase(ctx, "capture");
    emitPhaseProgress(ctx, { type: "phase_started", phase: "capture" });
    const capture = await phaseCapture(ctx);
    if (!capture.continue) {
      emitPhaseProgress(ctx, {
        type: "phase_paused",
        phase: "capture",
        paused_status: capture.outcome.status,
      });
      return capture.outcome;
    }
    emitPhaseProgress(ctx, { type: "phase_completed", phase: "capture" });
  }

  let plan = await ensureInitialCapabilityPlan(ctx);
  const availableModules = ctx.modules;
  ctx.modules = activateModulesFromCapabilityPlan(availableModules, plan);
  ctx.protocol11Dag = true;

  const shouldPause = (phase: OrchestrationPhase): boolean =>
    untilPhase === phase && phase !== "snapshot";

  const runPhaseNode = async (
    phase: OrchestrationPhase,
    stepFn: (step: PipelineContext) => Promise<PhaseStep>,
    produces: () => readonly { readonly kind: BindingKindV13; readonly digest: string }[],
  ): Promise<DagNodeResult> => {
    await advanceIntoPhase(ctx, phase);
    emitPhaseProgress(ctx, { type: "phase_started", phase });
    const step = await stepFn(ctx);
    if (!step.continue) {
      terminal = step.outcome;
      const completed = step.outcome.status === "completed";
      emitPhaseProgress(ctx, {
        type: completed ? "phase_completed" : "phase_paused",
        phase,
        ...(completed ? {} : { paused_status: step.outcome.status }),
      });
      if (step.outcome.status === "approval_required") {
        const required = step.outcome.required;
        observe(ctx, () =>
          ctx.observations.approvalRequired({
            request_id: required.request_id,
            object_id: required.object_id,
            object_type: required.object_type,
            object_digest: required.object_digest,
            allowed_decisions: [...required.allowed_decisions],
            resume_phase: required.resume_phase,
          }),
        );
      }
      return completed
        ? { status: "committed", produces: produces() }
        : approvalNotice(step.outcome);
    }
    emitPhaseProgress(ctx, { type: "phase_completed", phase });
    return shouldPause(phase)
      ? { status: "paused", reason: "until_phase", produces: produces() }
      : { status: "committed", produces: produces() };
  };

  const captureRunner = (): DagNodeResult => {
    const accepted = acceptedPrdForOperation(ctx);
    if (accepted === undefined || accepted.requirement_baseline_digest !== ctx.baselineDigest) {
      return {
        status: "blocked",
        reason: "capture_checkpoint_binding_drift",
        detail: "accepted Capture baseline no longer matches the operation",
      };
    }
    return shouldPause("capture")
      ? {
          status: "paused",
          reason: "until_phase",
          produces: [{ kind: "requirement_baseline", digest: ctx.baselineDigest }],
        }
      : {
          status: "committed",
          produces: [{ kind: "requirement_baseline", digest: ctx.baselineDigest }],
        };
  };

  const runners = createCapabilityDagRunnerRegistry({
    kernel: {
      capture: captureRunner,
      capability_decision: () => ({ status: "committed" }),
      plan: () =>
        runPhaseNode(
          "plan",
          (step) =>
            phasePlan(
              step,
              suite.gates.map((gate) => gate.gate_id),
            ),
          () => {
            const executionPlan = ctx.plan ?? loadPlan(ctx);
            if (executionPlan === undefined) {
              throw new OrchestrationError("binding_drift", "Plan runner committed no plan");
            }
            return [{ kind: "execution_plan", digest: executionPlan.content.content_digest }];
          },
        ),
      context: () =>
        runPhaseNode("context", phaseContext, () => [
          {
            kind: "context_bundle",
            digest: contentDigest(
              [...ctx.bundles.values()]
                .map((bundle) => ({ task_id: bundle.task_id, digest: bundle.digest }))
                .sort((left, right) => left.task_id.localeCompare(right.task_id)),
            ),
          },
        ]),
      execute: (dagContext) =>
        runPhaseNode(
          "execute",
          async (step) => {
            if (dagContext.node.subgraph === "parallel_task_execution") {
              const parallel = step.deps.parallelExecution;
              if (parallel === undefined) {
                await commitIterationNode(step, "blocked");
                await step.engine.block(step.workflowOperationId, {
                  reason: "missing_input",
                  detail:
                    "parallel_task_execution execute node has no ParallelExecutionBinding; production execution remains locked",
                  proposal: {
                    phase: "execute",
                    set_next_action: resumeCommandFor(step.workflowOperationId),
                  },
                });
                refreshWorkingState(step);
                return {
                  continue: false,
                  outcome: {
                    status: "blocked",
                    workflowOperationId: step.workflowOperationId,
                    iterationId: step.iterationId,
                    reason: "missing_input",
                    detail:
                      "parallel_task_execution execute node has no ParallelExecutionBinding; production execution remains locked",
                    resumeCommand: resumeCommandFor(step.workflowOperationId),
                  },
                };
              }
              const executionPlan = step.plan ?? loadPlan(step);
              if (executionPlan === undefined) {
                throw new OrchestrationError(
                  "binding_drift",
                  "parallel execute node has no accepted ExecutionPlan",
                );
              }
              const operationLease = parallel.operationLease?.();
              const outcome = await parallel.port.run({
                operation_id: step.workflowOperationId,
                iteration_id: step.iterationId,
                capability_plan_digest: dagContext.plan_digest,
                expected_plan_digest: executionPlan.content.content_digest,
                driver_lock: parallel.driverLock(),
                ...(operationLease === undefined ? {} : { operation_lease: operationLease }),
              });
              parallelOutcome = outcome;
              if (outcome.status === "completed") {
                const sourceView = await parallel.openSourceView?.(step.workflowOperationId);
                if (sourceView !== undefined) ctx.sourceView = sourceView;
                return { continue: true };
              }
              if (outcome.status === "cancelled") {
                const cancelDetail = `parallel execution cancelled for ${outcome.operation_id}`;
                await commitIterationNode(step, "aborted");
                await step.engine.abort(step.workflowOperationId, {
                  reason: "user_cancellation",
                  detail: cancelDetail,
                });
                refreshWorkingState(step);
                return {
                  continue: false,
                  outcome: {
                    status: "aborted",
                    workflowOperationId: step.workflowOperationId,
                    iterationId: step.iterationId,
                    reason: "user_cancellation",
                    detail: cancelDetail,
                  },
                };
              }
              // A paused drive awaits a scheduler Approval; a blocked drive is
              // recoverable through the typed recovery actions (design 21).
              const blockReason: RecoverableBlockReason =
                outcome.status === "paused" ? "awaiting_approval" : "repairable_gate_failure";
              const blockDetail =
                outcome.status === "paused"
                  ? `parallel execution paused for approval on ${outcome.operation_id}`
                  : `parallel execution blocked for ${outcome.operation_id} (scheduler state ${outcome.scheduler_state_digest})`;
              await commitIterationNode(step, "blocked");
              await step.engine.block(step.workflowOperationId, {
                reason: blockReason,
                detail: blockDetail,
                proposal: {
                  phase: "execute",
                  set_next_action: resumeCommandFor(step.workflowOperationId),
                },
              });
              refreshWorkingState(step);
              return {
                continue: false,
                outcome: {
                  status: "blocked",
                  workflowOperationId: step.workflowOperationId,
                  iterationId: step.iterationId,
                  reason: blockReason,
                  detail: blockDetail,
                  resumeCommand: resumeCommandFor(step.workflowOperationId),
                },
              };
            }
            if (dagContext.node.subgraph === "strict_tdd") {
              const tasks = step.plan?.content.tasks ?? loadPlan(step)?.content.tasks ?? [];
              const contracts = tasks.map((task) => loadTaskTddContract(step, task.id));
              if (contracts.some((contract) => contract === undefined)) {
                throw new OrchestrationError(
                  "binding_drift",
                  "strict_tdd execute node has a Task without an accepted TaskTddContract",
                );
              }
              if (
                contracts.some((contract) => contract?.contract_mode === "required") &&
                step.deps.strictTdd === undefined
              ) {
                await commitIterationNode(step, "blocked");
                await step.engine.block(step.workflowOperationId, {
                  reason: "missing_input",
                  detail:
                    "strict_tdd required Task has no StrictTddExecutionPort; production execution remains locked",
                  proposal: {
                    phase: "execute",
                    set_next_action: resumeCommandFor(step.workflowOperationId),
                  },
                });
                refreshWorkingState(step);
                return {
                  continue: false,
                  outcome: {
                    status: "blocked",
                    workflowOperationId: step.workflowOperationId,
                    iterationId: step.iterationId,
                    reason: "missing_input",
                    detail:
                      "strict_tdd required Task has no StrictTddExecutionPort; production execution remains locked",
                    resumeCommand: resumeCommandFor(step.workflowOperationId),
                  },
                };
              }
            }
            return phaseExecute(step);
          },
          () => {
            if (dagContext.node.subgraph === "parallel_task_execution") {
              if (parallelOutcome === undefined) {
                throw new OrchestrationError(
                  "binding_drift",
                  "parallel execute committed without a driver outcome",
                );
              }
              return [
                {
                  kind: "wave_integration",
                  digest: contentDigest({
                    operation_id: parallelOutcome.operation_id,
                    wave_integration_digests: parallelOutcome.wave_integration_digests,
                    scheduler_state_digest: parallelOutcome.scheduler_state_digest,
                  }),
                },
              ];
            }
            return dagContext.node.subgraph === "strict_tdd"
              ? [
                  {
                    kind: "tdd_contract",
                    digest: contentDigest(
                      (ctx.plan?.content.tasks ?? []).map((task) => {
                        const contract = loadTaskTddContract(ctx, task.id);
                        if (contract === undefined) {
                          throw new OrchestrationError(
                            "binding_drift",
                            `strict_tdd execute committed without contract for ${task.id}`,
                          );
                        }
                        return {
                          task_id: task.id,
                          contract_digest: contract.contract_digest,
                        };
                      }),
                    ),
                  },
                ]
              : [];
          },
        ),
      verify: () => {
        const verifySuite = gateSuiteFor(ctx);
        return runPhaseNode(
          "verify",
          (step) => phaseVerify(step, verifySuite.gates, verifySuite.registry),
          () => {
            const stored = loadVerifyArtifact(ctx.deps, ctx.iterationId, verifyBindings(ctx));
            if (stored === undefined) {
              throw new OrchestrationError(
                "binding_drift",
                "Verify runner committed no gate result",
              );
            }
            return [{ kind: "gate_evidence", digest: contentDigest(stored) }];
          },
        );
      },
      snapshot: () =>
        runPhaseNode("snapshot", phaseSnapshot, () => {
          if (terminal?.status !== "completed") {
            throw new OrchestrationError("binding_drift", "Snapshot runner committed no snapshot");
          }
          const snapshot = readJsonArtifact<SnapshotRecord>(
            ctx.deps,
            `artifacts/snapshots/${terminal.snapshotId}.json`,
          );
          if (snapshot === undefined) {
            throw new OrchestrationError("binding_drift", "completed Snapshot artifact is missing");
          }
          return [{ kind: "snapshot", digest: snapshot.digest }];
        }),
    },
    modules: {
      ...(ctx.modules.impact === undefined
        ? {}
        : {
            impact_analysis: () =>
              runPhaseNode("impact", ctx.modules.impact!.runPhase, () => {
                const impactSet = ctx.impactSet ?? loadFrozenImpactSet(ctx);
                if (impactSet === undefined) {
                  throw new OrchestrationError("binding_drift", "Impact runner committed no set");
                }
                return [
                  { kind: "impact_set", digest: readImpactSetContent(impactSet).content_digest },
                ];
              }),
          }),
      ...(ctx.modules.design === undefined
        ? {}
        : {
            design_governance: async () => {
              const result = await runPhaseNode("design", ctx.modules.design!.runPhase, () => {
                const designSet = ctx.designSet ?? loadAcceptedDesignSet(ctx);
                if (designSet === undefined) {
                  throw new OrchestrationError("binding_drift", "Design runner committed no set");
                }
                return [
                  { kind: "design_set", digest: readDesignSetExtension(designSet).content_digest },
                ];
              });
              if (result.status !== "committed" && result.status !== "paused") return result;
              const designSet = ctx.designSet ?? loadAcceptedDesignSet(ctx);
              if (designSet === undefined) {
                throw new OrchestrationError("binding_drift", "accepted DesignSet disappeared");
              }
              const finalPlan = await finalizeCapabilityPlan(ctx, plan, designSet);
              if (finalPlan.record_digest === plan.record_digest) return result;
              plan = finalPlan;
              ctx.modules = activateModulesFromCapabilityPlan(availableModules, finalPlan);
              return {
                status: "plan_superseded",
                next_plan_digest: finalPlan.record_digest,
                produces: result.produces ?? [],
              };
            },
          }),
      ...(ctx.modules.evaluate === undefined
        ? {}
        : {
            independent_evaluation: () =>
              runPhaseNode("evaluate", ctx.modules.evaluate!.runPhase, () => [
                {
                  kind: "evaluation_report",
                  digest: contentDigest(loadEvaluateArtifacts(ctx.deps, ctx.iterationId)),
                },
              ]),
          }),
      ...(ctx.modules.audit === undefined
        ? {}
        : {
            advanced_audit: async () => {
              const report = await commitAuditContribution(ctx);
              const completedSnapshot =
                terminal?.status === "completed"
                  ? readJsonArtifact<SnapshotRecord>(
                      ctx.deps,
                      `artifacts/snapshots/${terminal.snapshotId}.json`,
                    )
                  : undefined;
              const artifact = {
                operation_id: ctx.workflowOperationId,
                iteration_id: ctx.iterationId,
                capability_plan_digest: plan.record_digest,
                ...(completedSnapshot === undefined
                  ? {}
                  : { snapshot_digest: completedSnapshot.digest }),
                blocking_finding_ids: [...report.blockingFindingIds],
                created_at: nowOf(ctx.deps),
              };
              const digest = contentDigest(artifact);
              await commitArtifacts(ctx.deps, ctx.workflowOperationId, currentAttemptId(ctx), [
                {
                  path: `artifacts/audit-reports/${digest}.json`,
                  content: `${canonicalizeJson({ ...artifact, digest })}\n`,
                },
              ]);
              if (ctx.deps.vcs !== undefined) {
                await ctx.deps.vcs.commit(ctx.deps.projectRoot, {
                  message: `harness: record advanced audit ${ctx.iterationId}`,
                  paths: [".harness"],
                  identity: HARNESS_COMMIT_IDENTITY,
                });
              }
              return { status: "committed", produces: [{ kind: "audit_report", digest }] };
            },
          }),
    },
  });

  const operation = ctx.engine.getOperation(ctx.workflowOperationId);
  if (operation === undefined) {
    throw new OrchestrationError("operation_not_found", "operation disappeared before DAG run");
  }
  const runtime = createCapabilityDagRuntime({
    store: new LedgerDagCheckpointStore({
      projectRoot: ctx.deps.projectRoot,
      project_id: `project_${readManagedManifest(ctx.deps.projectRoot).name}`,
      iteration_id: ctx.iterationId,
      attempt_id: operation.attempt_id,
      readBaseline: ctx.deps.readBaseline,
      ...(ctx.deps.now === undefined ? {} : { now: ctx.deps.now }),
    }),
    runners,
  });
  const result = await runtime.run({ operation_id: ctx.workflowOperationId, plan });
  if (result.status === "replan_required") {
    if (untilPhase === "design") {
      return {
        status: "advanced",
        workflowOperationId: ctx.workflowOperationId,
        iterationId: ctx.iterationId,
        completedPhase: "design",
      };
    }
    return driveCapabilityPipeline(ctx, fromPhase, untilPhase);
  }
  if (result.status === "paused") {
    const completedPhase = result.node_id as OrchestrationPhase;
    return {
      status: "advanced",
      workflowOperationId: ctx.workflowOperationId,
      iterationId: ctx.iterationId,
      completedPhase,
    };
  }
  if (terminal !== undefined) {
    if (terminal.status !== "completed") return terminal;
    const finalized = await finalizeSnapshotLedger({
      project_root: ctx.deps.projectRoot,
      iteration_id: ctx.iterationId,
      ...(ctx.deps.vcs === undefined ? {} : { vcs: ctx.deps.vcs }),
      read_baseline: ctx.deps.readBaseline,
      prior_ledger_commit: terminal.ledgerCommit,
    });
    return {
      ...terminal,
      ledgerCommit: finalized.ledger_commit,
      repositoryHead: finalized.repository_head,
    };
  }
  if (result.status === "completed") {
    throw new OrchestrationError(
      "binding_drift",
      "CapabilityPlan DAG completed without an authoritative Snapshot outcome",
    );
  }
  if (result.status === "failed") {
    if (result.message.includes("executor_required")) {
      await commitIterationNode(ctx, "blocked");
      await ctx.engine.block(ctx.workflowOperationId, {
        reason: "missing_input",
        detail: result.message,
        proposal: {
          phase: "plan",
          set_next_action: resumeCommandFor(ctx.workflowOperationId),
        },
      });
      refreshWorkingState(ctx);
      return {
        status: "blocked",
        workflowOperationId: ctx.workflowOperationId,
        iterationId: ctx.iterationId,
        reason: "missing_input",
        detail: result.message,
        resumeCommand: resumeCommandFor(ctx.workflowOperationId),
      };
    }
    throw new OrchestrationError(
      "configuration",
      `CapabilityPlan node ${result.node_id} failed: ${result.message}`,
    );
  }
  if (result.status === "awaiting_approval") {
    throw new OrchestrationError(
      "binding_drift",
      `CapabilityPlan node ${result.node_id} paused without its orchestration approval outcome`,
    );
  }
  throw new OrchestrationError(
    "configuration",
    `CapabilityPlan node ${result.node_id} blocked: ${result.detail}`,
  );
}

async function drivePipelineInner(
  ctx: PipelineContext,
  fromPhase: OrchestrationPhase,
  untilPhase: OrchestrationPhase | undefined,
): Promise<OrchestrationOutcome> {
  if (ctx.deps.capabilityPlan !== undefined || ctx.deps.capabilityPlanCompiler !== undefined) {
    return driveCapabilityPipeline(ctx, fromPhase, untilPhase);
  }
  const suite = gateSuiteFor(ctx);
  let completedPhase: OrchestrationPhase | undefined;
  // Kernel steps are built in; module phases dispatch to registered
  // contributors only. A module with no registered step is skipped entirely:
  // no invocation, no checkpoint, no lifecycle or progress events.
  const kernelSteps: Readonly<Record<string, (step: PipelineContext) => Promise<PhaseStep>>> = {
    capture: phaseCapture,
    plan: (step) =>
      phasePlan(
        step,
        suite.gates.map((gate) => gate.gate_id),
      ),
    context: phaseContext,
    execute: phaseExecute,
    verify: (step) => phaseVerify(step, suite.gates, suite.registry),
    snapshot: phaseSnapshot,
  };
  const moduleSteps: Readonly<Record<string, ModulePhaseStep | undefined>> = {
    impact: ctx.modules.impact?.runPhase,
    design: ctx.modules.design?.runPhase,
    evaluate: ctx.modules.evaluate?.runPhase,
  };
  for (const phase of ORCHESTRATION_PHASES.slice(phaseRank(fromPhase))) {
    if (untilPhase !== undefined && phaseRank(phase) > phaseRank(untilPhase)) {
      return {
        status: "advanced",
        workflowOperationId: ctx.workflowOperationId,
        iterationId: ctx.iterationId,
        completedPhase: completedPhase ?? fromPhase,
      };
    }
    const stepFn = kernelSteps[phase] ?? moduleSteps[phase];
    if (stepFn === undefined) continue;
    await advanceIntoPhase(ctx, phase);
    emitPhaseProgress(ctx, { type: "phase_started", phase });
    const step: PhaseStep = await stepFn(ctx);
    if (!step.continue) {
      // A terminal outcome that completes the pipeline (e.g. snapshot) still
      // settles as phase_completed; only genuine pauses emit phase_paused.
      const completedByStep = step.outcome.status === "completed";
      emitPhaseProgress(ctx, {
        type: completedByStep ? "phase_completed" : "phase_paused",
        phase,
        ...(completedByStep ? {} : { paused_status: step.outcome.status }),
      });
      if (step.outcome.status === "approval_required") {
        const required = step.outcome.required;
        observe(ctx, () =>
          ctx.observations.approvalRequired({
            request_id: required.request_id,
            object_id: required.object_id,
            object_type: required.object_type,
            object_digest: required.object_digest,
            allowed_decisions: [...required.allowed_decisions],
            resume_phase: required.resume_phase,
          }),
        );
      }
      return step.outcome;
    }
    completedPhase = phase;
    emitPhaseProgress(ctx, { type: "phase_completed", phase });
  }
  throw new OrchestrationError("configuration", "pipeline ended without a snapshot");
}
export async function drivePipeline(
  ctx: PipelineContext,
  fromPhase: OrchestrationPhase,
  untilPhase: OrchestrationPhase | undefined,
): Promise<OrchestrationOutcome> {
  // A pipeline resumed at verify (or the verify→snapshot tail) has no
  // in-memory CapabilityPlan; fall back to the latest persisted plan, the
  // same source the plan phase trusts on resume, so a parallel operation
  // still verifies against its accepted source view.
  const capabilityPlan = ctx.capabilityPlan ?? loadCapabilityPlans(ctx).at(-1);
  const parallelPlan =
    capabilityPlan !== undefined &&
    (capabilityPlan as { readonly protocol_version?: string }).protocol_version ===
      PROTOCOL_1_3_VERSION &&
    capabilityPlan.operation_dag.nodes.some(
      (node) =>
        node.node_id === "execute" &&
        (node.subgraph as string | undefined) === "parallel_task_execution",
    );
  if (
    ctx.sourceView === undefined &&
    phaseRank(fromPhase) >= phaseRank("verify") &&
    parallelPlan &&
    ctx.deps.parallelExecution?.openSourceView !== undefined
  ) {
    ctx.sourceView = await ctx.deps.parallelExecution.openSourceView(ctx.workflowOperationId);
  }
  try {
    return await drivePipelineInner(ctx, fromPhase, untilPhase);
  } finally {
    const sourceView = ctx.sourceView;
    delete ctx.sourceView;
    await sourceView?.release();
  }
}
function emitPhaseProgress(
  ctx: PipelineContext,
  event: Omit<PhaseProgressEvent, "workflow_operation_id" | "iteration_id" | "timestamp">,
): void {
  switch (event.type) {
    case "phase_started":
      observe(ctx, () => ctx.observations.phaseStarted(event.phase));
      break;
    case "phase_completed":
      observe(ctx, () => ctx.observations.phaseCompleted(event.phase));
      break;
    case "phase_paused":
      observe(ctx, () =>
        ctx.observations.phasePaused(event.phase, event.paused_status ?? "paused"),
      );
      break;
  }
  const observer = ctx.deps.onPhaseProgress;
  if (observer === undefined) return;
  observer({
    ...event,
    workflow_operation_id: ctx.workflowOperationId,
    iteration_id: ctx.iterationId,
    timestamp: ctx.deps.now?.() ?? new Date().toISOString(),
  });
}
export async function buildPipelineContext(
  deps: OrchestratorDependencies,
  workflowOperationId: string,
  iterationId: string,
  input: RunIterationInput,
  modules: ModuleContributions,
): Promise<PipelineContext | { readonly outcome: OrchestrationOutcome }> {
  const engine = new WorkflowEngine(workflowDeps(deps));
  const workingState = engine.getWorkingState(workflowOperationId);
  if (workingState === undefined) {
    throw new OrchestrationError(
      "operation_not_found",
      `workflow operation ${workflowOperationId} has no working state`,
    );
  }
  const captured = await captureProposal(deps, workingState.goal, iterationId, workflowOperationId);
  if (captured.status === "clarification_required") {
    // Capture cannot advance without the answers: block the operation as a
    // typed, resumable pause (resume phase capture) and surface the full
    // answer-submission payload (intent-to-prd design 16.1).
    const current = engine.getOperation(workflowOperationId);
    if (current !== undefined && current.state !== "blocked") {
      await engine.block(workflowOperationId, {
        reason: "missing_input",
        detail: "capture requires clarification answers before the pipeline can continue",
        proposal: { phase: "capture", set_next_action: resumeCommandFor(workflowOperationId) },
      });
    }
    return {
      outcome: {
        status: "input_required",
        questions: captured.questions,
        ...(captured.session === undefined
          ? {}
          : {
              workflowOperationId,
              captureSessionId: captured.session.session_id,
              sessionRevision: captured.session.revision,
              expectedDigest: captured.session.record_digest,
              resumeCommand: resumeCommandFor(workflowOperationId),
            }),
      },
    };
  }
  const baselineDigest = captured.baselineDigest;
  // The pending sentinel means capture has not sealed its baseline into a
  // checkpoint yet (operation opened before capture ran); the capture phase
  // binds it below. Anything else must match the approved checkpoint binding.
  if (
    baselineDigest !== workingState.requirement_baseline_digest &&
    workingState.requirement_baseline_digest !== PENDING_REQUIREMENT_BASELINE_DIGEST
  ) {
    throw new OrchestrationError(
      "binding_drift",
      "re-derived requirement baseline digest no longer matches the approved checkpoint binding",
    );
  }
  const operation = engine.getOperation(workflowOperationId);
  if (operation === undefined) {
    throw new OrchestrationError(
      "operation_not_found",
      `workflow operation ${workflowOperationId} disappeared before observation binding`,
    );
  }
  const identity: ObservationStreamIdentity = {
    projectId: readManagedManifest(deps.projectRoot).repository_id,
    iterationId,
    workflowOperationId,
    attemptId: operation.attempt_id,
  };
  return {
    deps,
    engine,
    workflowOperationId,
    iterationId,
    iterationKind: input.iterationKind ?? "feature",
    intentShape: input.intentShape ?? "free-text",
    deterministicWork: input.deterministicWork ?? true,
    goal: workingState.goal,
    workingState,
    proposal: captured.proposal,
    baselineDigest,
    modules,
    bundles: new Map(),
    observations:
      deps.createObservationPublisher?.(identity) ??
      new ObservationPublisher(new FileLiveSpool(deps.projectRoot), identity),
  };
}
