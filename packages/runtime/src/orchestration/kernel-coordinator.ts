import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  LedgerRepository,
  PROTOCOL_VERSION,
  PROTOCOL_1_1_SCHEMA_REGISTRY,
  canonicalizeJson,
  canonicalizeLocator,
  assertCapabilityPlanFinal,
  compileCriterionAssertions,
  contentDigest,
  criterionSemanticDigest,
  deriveAcceptedPrdId,
  expectedCaptureAcceptanceBaseline,
  findPrdProposalByDigest,
  harnessRootFor,
  readAcceptedPrdRecords,
  readManagedManifest,
  resolveHarnessPath,
  sha256Hex,
  ulid,
  validateCriterionAssertionCoverage,
  validateSchema,
  verifyRecordEnvelope,
  type CapabilityPlanRecord,
  type CaptureAnswerInput,
  type BindingKind,
  type CaptureOutcome,
  type CaptureSessionRecord,
  type EdgeRecord,
  type LifecycleEvent,
  type NodeRecord,
  type TaskTddContract,
  type TddCycleRecord,
} from "@universal-harness-internal/core";
import {
  generateImpactSet,
  materializeLedger,
  pageEdges,
  pageNodes,
  readDesignSetExtension,
  readImpactSetContent,
  type ChangeSeed,
  type IterationKind,
} from "@universal-harness-internal/graph";
import {
  type AgentRunResult,
  type AgentTaskEnvelope,
  type DiffSummary,
} from "@universal-harness-internal/plugin-sdk";
import { observeAgentBudget } from "@universal-harness-internal/plugin-sdk";
import {
  artifactContentForNode,
  artifactPathForNode,
  edgeRecord,
  scannedNodeRecord,
  type RecordContext,
} from "../bootstrap/records.js";
import { scanWorktree } from "../bootstrap/scanner.js";
import { resumeCommandFor, type ApprovalRequiredOutcome } from "../approval/interaction.js";
import {
  compileContextBundle,
  type CompiledContextBundle,
  type ContextBundleRecord,
  type ContextCandidate,
} from "../context/compiler.js";
import { selectTaskNeighborhood } from "../context/selector.js";
import { narrateIteration } from "../snapshot/narrative.js";
import { enrichContextBundle } from "../context/enrichment.js";
import {
  TaskBundleBindingError,
  assertTaskBundleBinding,
  readContextBundleManifest,
} from "../context/task-bundles.js";
import { normalizeGateDefinition, type GateDefinition } from "../gates/provider.js";
import { evidenceBindingsOf, type GateEvidenceRecord } from "../gates/evidence.js";
import { findingClosableBy, type CurrentEvidenceState } from "../gates/freshness.js";
import { runGateSuite, type GateSuiteOutcome } from "../gates/runner.js";
import { ProjectionError, writeManagedOutput } from "../projection/managed-output.js";
import { FileLiveSpool } from "../observability/live-spool.js";
import {
  ObservationPublisher,
  gateCompletionObservationKey,
  type ObservationPublisherPort,
  type ObservationStreamIdentity,
} from "../observability/publisher.js";
import {
  bindCapabilityGrantAuthorization,
  createCapabilityGrantSpec,
  type CapabilityGrantRecord,
} from "../policy/capability-grant.js";
import {
  buildExecutionAuthorizationRecord,
  type ExecutionAuthorizationRecord,
} from "../policy/execution-authorization.js";
import {
  ExecutionPreflightError,
  prepareExecutionPreflight,
} from "../policy/execution-preflight.js";
import { mergePolicyLayers } from "../policy/evaluator.js";
import { isPathWithinScopes, normalizeRepoRelativePath } from "../policy/path-boundary.js";
import { explainCodeDigestMismatch, hashCommitCode, hashWorktreeCode } from "../snapshot/anchor.js";
import { type EffectivePolicy } from "../policy/decision.js";
import { buildTaskEnvelope, type TaskEnvelope } from "../loop/task-envelope.js";
import { resolveLoopPolicy } from "../loop/policy.js";
import {
  generateExecutionPlan,
  generateKernelExecutionPlan,
  readExecutionPlanContent,
  type ExecutionPlanContent,
} from "../planning/execution-plan.js";
import { type IntentShape } from "../planning/mode-selector.js";
import { materializePlanTasks, type PlanProposalInput } from "../planning/plan-proposal.js";
import { PlanningError } from "../planning/validator.js";
import { type TaskSpecification } from "../planning/task.js";
import { deriveActualRunChanges } from "../planning/scope-drift.js";
import {
  buildKernelTaskVerdict,
  buildTaskVerdict,
  type TaskVerdictRecord,
} from "../evaluation/task-verdict.js";
import { projectTaskVerdict } from "../evaluation/outcome-projection.js";
import type { TaskTddVerdictInput } from "../tdd/verdict.js";
import {
  assessOpenIterationMigration,
  buildOpenIterationMigrationRecord,
  type OpenIterationMigrationRecord,
} from "../compatibility/open-iteration.js";
import {
  captureRequirements,
  type IntentInput,
  type RequirementProposal,
  type ClarificationQuestion,
} from "../requirements/capture.js";
import {
  baselineDocumentArtifactPath,
  commitRequirementBaseline,
  requirementBaselineDigest,
} from "../requirements/baseline.js";
import {
  CAPTURE_APPROVAL_OBJECT_TYPE,
  captureSessionIdFor,
  clarificationQuestionViewOf,
  findBridgedCaptureApprovalDecision,
  requirementProposalViewOf,
  startCaptureCommandFor,
  type CaptureCoordinatorSeam,
} from "./capture-coordinator.js";
import {
  buildSnapshot,
  snapshotCompletionBlockers,
  type SnapshotRecord,
} from "../snapshot/builder.js";
import { ToolRegistry } from "../tools/registry.js";
import {
  WorkflowEngine,
  readRunStreams,
  streamTerminalRecord,
  type WorkflowDependencies,
  type WorkflowIdKind,
} from "../workflow/operation.js";
import { type RecoverableBlockReason } from "../workflow/state-machine.js";
import { type WorkingState } from "../workflow/working-state.js";
import { phaseLifecycleEvents } from "./lifecycle-events.js";
import { ensureApproval, rejectOperation } from "./approval-runtime.js";
export {
  approvalDigestOf,
  approvalService,
  ensureApproval,
  rejectOperation,
} from "./approval-runtime.js";
import { createCapabilityDagRuntime } from "./capability-dag-runtime.js";
import { createCapabilityDagRunnerRegistry } from "./capability-dag-runners.js";
import { LedgerDagCheckpointStore } from "../workflow/ledger-dag-checkpoint-store.js";
import type { DagNodeResult } from "../workflow/dag.js";
import {
  ORCHESTRATION_PHASES,
  PHASE_CHECKPOINT_BOUNDARY,
  phaseRank,
  type OrchestrationPhase,
} from "./phases.js";
import {
  ExecutionBindingError,
  assertExecutionBindingCompatible,
  type ExecutionBinding,
  type OrchestrationExecutor,
} from "./execution-binding.js";
import {
  classifyRunFailure,
  executeRequiredTddTask,
  orderExecutionTasks,
  resolveExecutionBinding,
} from "./execution-runtime.js";
import { verificationBindingsEqual, type VerifyPhaseArtifact } from "./verification-runtime.js";
import { finalizeSnapshotLedger } from "./snapshot-runtime.js";
export {
  classifyRunFailure,
  executeRequiredTddTask,
  orderExecutionTasks,
  resolveExecutionBinding,
} from "./execution-runtime.js";
import { OrchestrationError } from "./pipeline-types.js";
import type {
  ClarificationOffer,
  EvaluationPortResult,
  IntentInterpreter,
  OrchestrationOutcome,
  OrchestratorDependencies,
  PhaseProgressEvent,
  RunIterationInput,
} from "./pipeline-types.js";

const HARNESS_COMMIT_IDENTITY = { name: "Universal Harness", email: "harness@localhost" } as const;

/**
 * Kernel Coordinator (plan Task 8-A; slim-profiles design 9.5). Owns the
 * shared pipeline machinery — pipeline context, artifact readers, approvals,
 * checkpoints, the kernel phase steps (capture → plan → context → execute →
 * verify → snapshot) and the phase driver. Capability modules (impact,
 * evaluation, audit) are reached only through the registered contributions on
 * the pipeline context; the coordinator never imports a contributor module
 * and never branches on a profile name.
 */
const DEFAULT_TOKEN_BUDGET = 8000;
export function nowOf(deps: OrchestratorDependencies): string {
  return (deps.now ?? (() => new Date().toISOString()))();
}
export function newIdOf(deps: OrchestratorDependencies, kind: string): string {
  return (deps.newId ?? ((idKind) => `${idKind}_${ulid()}`))(kind);
}
export function workflowDeps(deps: OrchestratorDependencies): WorkflowDependencies {
  return {
    projectRoot: deps.projectRoot,
    readBaseline: deps.readBaseline,
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.newId === undefined
      ? {}
      : { newId: (kind: WorkflowIdKind) => (deps.newId as (kind: string) => string)(kind) }),
    ...(deps.hooks === undefined ? {} : { hooks: deps.hooks }),
    ...(deps.lock === undefined ? {} : { lock: deps.lock }),
  };
}
export function harnessRoot(deps: OrchestratorDependencies): string {
  return harnessRootFor(deps.projectRoot);
}
/** Deterministic generic-Pack conversion: the intent text becomes one lossless requirement. */
export function createGenericInterpreter(): IntentInterpreter {
  return (intent) => ({
    requirements: [
      {
        statement: intent,
        acceptance: [{ description: intent, verification: "mandatory gate suite passes" }],
      },
    ],
  });
}
/**
 * Built-in direct executor (design 10.1 `direct` mode): no agent semantics,
 * no tool calls; the run claims completion and attaches a deterministic
 * attestation over the envelope. The claim only becomes a success when the
 * mandatory gates and the evaluation accept it.
 */
export function createDirectExecutor(): OrchestrationExecutor {
  return (envelope) =>
    Promise.resolve({
      outcome: "handoff",
      termination_reason: "completion",
      completion_claimed: true,
      summary: `direct execution of ${envelope.task_id}: no agent semantics required`,
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
          locator: `envelope://${envelope.task_id}`,
          digest: sha256Hex(envelope.digest),
        },
      ],
      undeclared_writes: [],
    });
}
export const executionBindingFor = resolveExecutionBinding;
/**
 * Default verify phase: the universal ledger-integrity gate replays and
 * materializes the authoritative ledger through the Tool Registry and checks
 * graph integrity. It never runs as a bare subprocess.
 */
export function createDefaultGateSuite(projectRoot: string): {
  readonly gates: readonly GateDefinition[];
  readonly registry: ToolRegistry;
} {
  const registry = new ToolRegistry();
  registry.register(
    {
      name: "harness_ledger_integrity",
      version: "1.0.0",
      description: "replay the ledger, materialize the graph and check integrity",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      output_schema: {
        type: "object",
        properties: {
          exit_code: { type: "integer" },
          summary: { type: "string" },
          log_summary: { type: "string" },
          artifacts: { type: "object", additionalProperties: { type: "string" } },
        },
        required: ["exit_code"],
        additionalProperties: false,
      },
      allowed_phases: ["verification"],
      resource_patterns: [],
      risk: "low",
      side_effect_class: "none",
      requires_approval: false,
      timeout_ms: 30000,
      retry_class: "none",
      max_retries: 0,
      max_invocations_per_run: 10,
      idempotent: true,
      reconciliation: "provider",
    },
    () => {
      try {
        // materializeLedger asserts graph integrity internally over every
        // committed revision; a violating ledger throws and fails the gate.
        const graph = materializeProjectGraph(projectRoot);
        try {
          return {
            exit_code: 0,
            summary: "ledger replay and graph integrity checks passed",
            log_summary: `${String(graph.nodes.length)} nodes, ${String(graph.edges.length)} edges checked`,
            artifacts: {},
          };
        } finally {
          graph.close();
        }
      } catch (error) {
        return {
          exit_code: 1,
          summary: `ledger integrity check failed: ${error instanceof Error ? error.message : String(error)}`,
          log_summary: "materialization error",
          artifacts: {},
        };
      }
    },
  );
  return {
    gates: [
      normalizeGateDefinition({
        gate_id: "gate_ledger_integrity",
        layer: "universal",
        name: "ledger integrity",
        mandatory: true,
        subject_id: "ledger_integrity",
        tool: "harness_ledger_integrity",
      }),
    ],
    registry,
  };
}
interface ProjectGraph {
  readonly nodes: readonly NodeRecord[];
  readonly edges: readonly EdgeRecord[];
  close(): void;
}
/** Materialize the ledger in memory; the on-disk cache is never trusted here. */
export function materializeProjectGraph(projectRoot: string): ProjectGraph {
  const { database } = materializeLedger({ projectRoot, databasePath: ":memory:" });
  try {
    const nodes: NodeRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = pageNodes(database, { limit: 500, ...(cursor === undefined ? {} : { cursor }) });
      nodes.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    const edges: EdgeRecord[] = [];
    let edgeCursor: string | undefined;
    do {
      const page = pageEdges(database, {
        limit: 500,
        ...(edgeCursor === undefined ? {} : { cursor: edgeCursor }),
      });
      edges.push(...page.items);
      edgeCursor = page.nextCursor;
    } while (edgeCursor !== undefined);
    return { nodes, edges, close: () => database.close() };
  } catch (error) {
    database.close();
    throw error;
  }
}
export function artifactExists(
  deps: OrchestratorDependencies,
  ledgerRelativePath: string,
): boolean {
  return existsSync(resolveHarnessPath(harnessRoot(deps), ledgerRelativePath));
}
async function commitVerifiedSourceTree(
  ctx: PipelineContext,
  plan: ExecutionPlanContent,
  taskRuns: readonly {
    readonly taskId: string;
    readonly result: AgentRunResult;
  }[],
): Promise<string> {
  const taskById = new Map(plan.tasks.map((task) => [task.id, task]));
  const governedWriteScopes = plan.tasks.flatMap(
    (task) =>
      ctx.deps.taskEnvelopeScope?.(task).proposed_write_paths.map(normalizeRepoRelativePath) ?? [],
  );
  const paths = new Set<string>();
  for (const taskRun of taskRuns) {
    const task = taskById.get(taskRun.taskId);
    if (task === undefined) {
      throw new OrchestrationError(
        "binding_drift",
        `run result references task ${taskRun.taskId}, which is absent from the accepted plan`,
      );
    }
    const declaredScope =
      ctx.deps.taskEnvelopeScope?.(task).proposed_write_paths.map(normalizeRepoRelativePath) ?? [];
    for (const candidate of taskRun.result.change_summary.paths) {
      const path = normalizeRepoRelativePath(candidate);
      if (
        path === ".harness" ||
        path.startsWith(".harness/") ||
        !isPathWithinScopes(declaredScope, path)
      ) {
        throw new OrchestrationError(
          "binding_drift",
          `task ${task.id} reported source path ${path} outside its governed write scope`,
        );
      }
      paths.add(path);
    }
  }

  // Verification can deliberately pause for a human repair. Re-read the VCS
  // truth after the repaired gates pass so an authorized repair is anchored
  // in the same source commit as Agent-produced changes. This observation is
  // authoritative over the earlier run report, but never broadens authority:
  // every current source delta (including both sides of a rename) must still
  // fall inside a task's approved write scope.
  if (ctx.deps.vcs !== undefined) {
    const observed = await ctx.deps.vcs.diffSummary(
      ctx.deps.projectRoot,
      ctx.workingState.baseline_commit,
    );
    if (!observed.ok) {
      throw new OrchestrationError(
        "configuration",
        `final VCS inspection failed: ${observed.error.message}`,
      );
    }
    for (const file of observed.value.files) {
      for (const candidate of [
        file.path,
        ...(file.previousPath === undefined ? [] : [file.previousPath]),
      ]) {
        const path = normalizeRepoRelativePath(candidate);
        if (path === ".harness" || path.startsWith(".harness/")) continue;
        if (!isPathWithinScopes(governedWriteScopes, path)) {
          throw new OrchestrationError(
            "binding_drift",
            `verified source path ${path} is outside every governed write scope`,
          );
        }
        paths.add(path);
      }
    }
  }

  let sourceCommit = ctx.deps.readBaseline();
  if (paths.size > 0) {
    if (ctx.deps.vcs === undefined) {
      throw new OrchestrationError(
        "configuration",
        "source changes passed verification but no VCS adapter is configured to anchor them",
      );
    }
    const committed = await ctx.deps.vcs.commit(ctx.deps.projectRoot, {
      message: `harness: apply iteration ${ctx.iterationId}`,
      paths: [...paths].sort(),
      identity: HARNESS_COMMIT_IDENTITY,
    });
    if (committed.ok) {
      sourceCommit = committed.value;
    } else if (committed.error.kind !== "nothing_to_commit") {
      throw new OrchestrationError(
        "binding_drift",
        `could not commit verified source paths: ${committed.error.message}`,
      );
    } else {
      sourceCommit = ctx.deps.readBaseline();
    }
  }

  const worktreeDigest = hashWorktreeCode(ctx.deps.projectRoot);
  const commitDigest = hashCommitCode(ctx.deps.projectRoot, sourceCommit);
  if (worktreeDigest !== commitDigest) {
    throw new OrchestrationError(
      "binding_drift",
      `the verified worktree contains source changes that are not present in the source commit: ${explainCodeDigestMismatch(ctx.deps.projectRoot, sourceCommit)}`,
    );
  }
  return sourceCommit;
}
export function readJsonArtifact<T>(
  deps: OrchestratorDependencies,
  ledgerRelativePath: string,
): T | undefined {
  const absolute = resolveHarnessPath(harnessRoot(deps), ledgerRelativePath);
  if (!existsSync(absolute)) return undefined;
  return JSON.parse(readFileSync(absolute, "utf8")) as T;
}
/** Commit one ledger operation outside the engine helpers (phase artifacts). */
export async function commitArtifacts(
  deps: OrchestratorDependencies,
  workflowOperationId: string,
  attemptId: string,
  artifacts: readonly { readonly path: string; readonly content: string }[],
  edges: readonly EdgeRecord[] = [],
  lifecycleEvents: readonly {
    readonly eventType: LifecycleEvent["event_type"];
    readonly iterationId: string;
    readonly payload: Record<string, unknown>;
  }[] = [],
): Promise<void> {
  const ledgerOperationId = newIdOf(deps, "ledger");
  const repository = new LedgerRepository({
    projectRoot: deps.projectRoot,
    readBaseline: deps.readBaseline,
    now: () => nowOf(deps),
    ...(deps.hooks === undefined ? {} : { hooks: deps.hooks }),
    ...(deps.lock === undefined ? {} : { lock: deps.lock }),
  });
  const projectId = `project_${readManagedManifest(deps.projectRoot).name}`;
  const timestamp = nowOf(deps);
  const firstEventSequence =
    repository
      .replay()
      .events.filter((event) => event.workflow_operation_id === workflowOperationId)
      .reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1;
  const events = lifecycleEvents.map((spec, index) => {
    const draft = {
      protocol_version: PROTOCOL_VERSION,
      record_kind: "event",
      event_id: newIdOf(deps, "event"),
      event_type: spec.eventType,
      project_id: projectId,
      iteration_id: spec.iterationId,
      workflow_operation_id: workflowOperationId,
      ledger_operation_id: ledgerOperationId,
      sequence: firstEventSequence + index,
      timestamp,
      payload: spec.payload,
    };
    const validation = validateSchema("event", draft);
    if (!validation.valid) {
      throw new OrchestrationError(
        "configuration",
        `invalid lifecycle event: ${validation.errors.map((issue) => issue.message).join("; ")}`,
      );
    }
    return draft as LifecycleEvent;
  });
  await repository.commit({
    ledger_operation_id: ledgerOperationId,
    workflow_operation_id: workflowOperationId,
    attempt_id: attemptId,
    expected_baseline: deps.readBaseline(),
    artifacts,
    edges,
    events,
  });
}
export interface PipelineContext {
  readonly deps: OrchestratorDependencies;
  readonly engine: WorkflowEngine;
  readonly workflowOperationId: string;
  readonly iterationId: string;
  readonly iterationKind: IterationKind;
  readonly intentShape: IntentShape;
  readonly deterministicWork: boolean;
  readonly goal: string;
  workingState: WorkingState;
  readonly proposal: RequirementProposal;
  readonly baselineDigest: string;
  readonly observations: ObservationPublisherPort;
  /** Module contributors registered for this operation; empty means Kernel-only. */
  modules: ModuleContributions;
  /** Accepted routing authority for this Protocol 1.1 operation. */
  capabilityPlan?: CapabilityPlanRecord;
  /** True only while the CapabilityPlan DAG owns phase ordering. */
  protocol11Dag?: boolean;
  impactSet?: NodeRecord;
  designSet?: NodeRecord;
  plan?: { readonly node: NodeRecord; readonly content: ExecutionPlanContent };
  bundles: Map<string, ContextBundleRecord>;
  envelope?: TaskEnvelope;
  run?: { readonly runId: string; readonly result: AgentRunResult };
  gateOutcome?: GateSuiteOutcome;
  evaluation?: EvaluationPortResult;
}
export function currentAttemptId(ctx: PipelineContext): string {
  const operation = ctx.engine.getOperation(ctx.workflowOperationId);
  if (operation === undefined) {
    throw new OrchestrationError(
      "operation_not_found",
      `workflow operation ${ctx.workflowOperationId} disappeared mid-pipeline`,
    );
  }
  return operation.attempt_id;
}
export function refreshWorkingState(ctx: PipelineContext): WorkingState {
  const state = ctx.engine.getWorkingState(ctx.workflowOperationId);
  if (state === undefined) {
    throw new OrchestrationError(
      "operation_not_found",
      `workflow operation ${ctx.workflowOperationId} has no working state`,
    );
  }
  ctx.workingState = state;
  return state;
}
/**
 * Content-derived id mint for capture: the same intent always derives the
 * same proposal ids, so a resume re-derives exactly the proposal an approval
 * bound to -- regardless of process or counter state.
 */
function captureIdMint(
  input: IntentInput,
): (kind: "intent" | "requirement" | "constraint") => string {
  const requirementIds = (input.requirements ?? []).map(
    (requirement) => `requirement_${sha256Hex(requirement.statement).slice(0, 16)}`,
  );
  const constraintIds = (input.constraints ?? []).map(
    (constraint) => `constraint_${sha256Hex(constraint.statement).slice(0, 16)}`,
  );
  const queues: Record<string, string[]> = {
    intent: [`intent_${sha256Hex(input.text).slice(0, 16)}`],
    requirement: [...requirementIds],
    constraint: [...constraintIds],
  };
  return (kind) => {
    const queue = queues[kind];
    const next = queue?.shift();
    if (next === undefined) {
      throw new OrchestrationError("configuration", `capture mint exhausted for kind ${kind}`);
    }
    return next;
  };
}
/** Escape entry appended to every optioned clarification question (card T4). */
const CLARIFICATION_OTHER_OPTION = "other";
/**
 * Validate and normalize an interpreter's clarification offer: every offered
 * question must carry 2-4 distinct non-blank options, and the harness
 * appends the `other` escape itself. A malformed offer is a port error, never
 * something to complete silently.
 */
function normalizeClarificationOffer(offer: ClarificationOffer): readonly ClarificationQuestion[] {
  if (offer.clarification.length === 0) {
    throw new OrchestrationError(
      "configuration",
      "clarification offer carries no questions; return undefined for the plain input form",
    );
  }
  return offer.clarification.map((question) => {
    const choices = [
      ...new Set(
        (question.options ?? [])
          .map((option) => option.trim())
          .filter((option) => option.length > 0 && option !== CLARIFICATION_OTHER_OPTION),
      ),
    ];
    if (choices.length < 2 || choices.length > 4) {
      throw new OrchestrationError(
        "configuration",
        `clarification question ${JSON.stringify(question.question)} must offer 2-4 options, got ${String(
          (question.options ?? []).length,
        )}`,
      );
    }
    return { ...question, options: [...choices, CLARIFICATION_OTHER_OPTION] };
  });
}
/**
 * Sentinel bound as `requirement_baseline_digest` when the operation opens
 * before capture runs (coordinated path, intent-to-prd design 16.1): the
 * requirement baseline only materializes once the capture session produces
 * its proposal, so the capture phase seals the real digest into the
 * checkpoint that closes the phase. The sentinel is a plain digest, never a
 * valid baseline.
 */
export const PENDING_REQUIREMENT_BASELINE_DIGEST = contentDigest({
  requirement_baseline: "pending_capture",
});
export async function captureProposal(
  deps: OrchestratorDependencies,
  intent: string,
  iterationId?: string,
  workflowOperationId?: string,
): Promise<
  | {
      readonly status: "captured";
      readonly proposal: RequirementProposal;
      readonly baselineDigest: string;
    }
  | {
      readonly status: "clarification_required";
      readonly questions: readonly ClarificationQuestion[];
      /** The coordinated session awaiting the answers; absent on the legacy interpreter path. */
      readonly session?: CaptureSessionRecord;
    }
> {
  if (deps.capture !== undefined) {
    if (iterationId === undefined || workflowOperationId === undefined) {
      throw new OrchestrationError(
        "configuration",
        "coordinated capture requires the iteration and workflow operation ids the session binds to",
      );
    }
    return captureProposalCoordinated(deps, deps.capture, intent, iterationId, workflowOperationId);
  }
  const interpreted = deps.interpret === undefined ? undefined : await deps.interpret(intent);
  if (typeof interpreted === "object" && interpreted !== null && "clarification" in interpreted) {
    // The interpreter judged the intent ambiguous and offered structured,
    // optioned questions; they surface verbatim (plus the `other` escape).
    return {
      status: "clarification_required",
      questions: normalizeClarificationOffer(interpreted),
    };
  }
  const input: IntentInput = {
    text: intent,
    requirements: interpreted?.requirements ?? [],
    ...(interpreted?.constraints === undefined ? {} : { constraints: interpreted.constraints }),
  };
  const captured = captureRequirements(input, { newId: captureIdMint(input) });
  if (captured.status === "clarification_required") return captured;
  return {
    status: "captured",
    proposal: captured.proposal,
    baselineDigest: requirementBaselineDigest(captured.proposal),
  };
}
/**
 * Coordinated capture drive (protocol-1.1 slice 2): start or resume the
 * deterministic session for this intent and advance it to its first waiting
 * point. An accepted session yields the committed acceptance view; a session
 * awaiting approval yields the proposal view plus exactly the baseline digest
 * the accepted transaction will seal, so the operation binding is final
 * before the human decides. Everything else — failure, conflict, blocker or
 * a waiting point this seam cannot resolve — fails closed as a typed error.
 */
async function captureProposalCoordinated(
  deps: OrchestratorDependencies,
  seam: CaptureCoordinatorSeam,
  intent: string,
  iterationId: string,
  workflowOperationId: string,
): Promise<
  | {
      readonly status: "captured";
      readonly proposal: RequirementProposal;
      readonly baselineDigest: string;
    }
  | {
      readonly status: "clarification_required";
      readonly questions: readonly ClarificationQuestion[];
      readonly session?: CaptureSessionRecord;
    }
> {
  const sessionId = captureSessionIdFor(intent, workflowOperationId);
  const existing = seam.coordinator.current(sessionId);
  const outcome = await seam.coordinator.advance(
    existing === undefined
      ? startCaptureCommandFor(seam, intent, iterationId, workflowOperationId)
      : { command: "resume_capture", session_id: sessionId },
  );
  return coordinatedCaptureOutcome(deps, sessionId, outcome);
}
function coordinatedCaptureOutcome(
  deps: OrchestratorDependencies,
  sessionId: string,
  outcome: CaptureOutcome,
):
  | {
      readonly status: "captured";
      readonly proposal: RequirementProposal;
      readonly baselineDigest: string;
    }
  | {
      readonly status: "clarification_required";
      readonly questions: readonly ClarificationQuestion[];
      readonly session?: CaptureSessionRecord;
    } {
  switch (outcome.status) {
    case "accepted":
    case "awaiting_approval": {
      const session = outcome.session;
      const proposalDigest = session.current_proposal_digest;
      const proposal =
        proposalDigest === undefined
          ? undefined
          : findPrdProposalByDigest(deps.projectRoot, sessionId, proposalDigest);
      const baselineDigest =
        outcome.status === "accepted"
          ? readAcceptedPrdRecords(deps.projectRoot, deriveAcceptedPrdId(sessionId)).at(-1)
              ?.requirement_baseline_digest
          : expectedCaptureAcceptanceBaseline(deps.projectRoot, session)?.record_digest;
      if (proposal === undefined || baselineDigest === undefined) {
        throw new OrchestrationError(
          "configuration",
          `coordinated capture session ${sessionId} is missing its committed proposal or acceptance baseline`,
        );
      }
      return {
        status: "captured",
        proposal: requirementProposalViewOf(session, proposal),
        baselineDigest,
      };
    }
    case "awaiting_answers":
      return {
        status: "clarification_required",
        questions: outcome.questions.map(clarificationQuestionViewOf),
        session: outcome.session,
      };
    case "failed":
      throw new OrchestrationError(
        outcome.kind === "binding_drift" ? "binding_drift" : "configuration",
        `coordinated capture failed (${outcome.kind}): ${outcome.message}`,
      );
    case "blocked":
      throw new OrchestrationError(
        "configuration",
        `coordinated capture is blocked (${outcome.blocker.reason}): ${outcome.blocker.detail}`,
      );
    default:
      throw new OrchestrationError(
        "configuration",
        `coordinated capture rests at ${outcome.status}, which this seam cannot drive`,
      );
  }
}
/**
 * Answer submission for a session awaiting clarification (intent-to-prd
 * design 16.1): the only write path is the coordinator's
 * `submit_clarification_answers` command, bound to the session digest read at
 * submission time. Replay is idempotent (already-applied answers are a
 * no-op); an unknown question, a conflicting answer or a session that moved
 * on fails closed as a typed error, and a digest conflict is binding drift.
 * Returns the outcome so the caller can keep driving the resumed pipeline.
 */
export async function submitCaptureAnswers(
  deps: OrchestratorDependencies,
  seam: CaptureCoordinatorSeam,
  intent: string,
  workflowOperationId: string,
  answers: readonly CaptureAnswerInput[],
): Promise<CaptureOutcome> {
  const sessionId = captureSessionIdFor(intent, workflowOperationId);
  const session = seam.coordinator.current(sessionId);
  if (session === undefined) {
    throw new OrchestrationError(
      "operation_not_found",
      `workflow operation ${workflowOperationId} has no capture session to answer`,
    );
  }
  const outcome = await seam.coordinator.advance({
    command: "submit_clarification_answers",
    session_id: sessionId,
    expected_session_digest: session.record_digest,
    actor: deps.decisionActor ?? "human:local",
    answers,
  });
  if (outcome.status === "conflict") {
    throw new OrchestrationError(
      "binding_drift",
      `capture session ${sessionId} advanced while the answers were being submitted; re-read the session and retry`,
    );
  }
  if (outcome.status === "failed") {
    throw new OrchestrationError(
      outcome.kind === "binding_drift"
        ? "binding_drift"
        : outcome.kind === "session_not_found"
          ? "operation_not_found"
          : "configuration",
      `capture answer submission failed (${outcome.kind}): ${outcome.message}`,
    );
  }
  return outcome;
}
export function loadFrozenImpactSet(ctx: PipelineContext): NodeRecord | undefined {
  const graph = materializeProjectGraph(ctx.deps.projectRoot);
  try {
    return graph.nodes.find(
      (node) =>
        node.type === "ImpactSet" &&
        node.provenance.iteration_id === ctx.iterationId &&
        node.status === "accepted",
    );
  } finally {
    graph.close();
  }
}
export function loadAcceptedDesignSet(ctx: PipelineContext): NodeRecord | undefined {
  const graph = materializeProjectGraph(ctx.deps.projectRoot);
  try {
    return graph.nodes.find(
      (node) =>
        node.type === "DesignSet" &&
        node.provenance.iteration_id === ctx.iterationId &&
        node.status === "accepted",
    );
  } finally {
    graph.close();
  }
}

function capabilityPlanArtifactPath(plan: CapabilityPlanRecord): string {
  return `artifacts/capability-plans/${plan.capability_plan_id}/${String(plan.revision)}.json`;
}

function assertCapabilityPlanRecord(value: unknown, path: string): CapabilityPlanRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OrchestrationError(
      "binding_drift",
      `CapabilityPlan artifact is not an object: ${path}`,
    );
  }
  const record = value as Record<string, unknown>;
  const validation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate("capability-plan", record);
  if (!validation.valid || !verifyRecordEnvelope(record)) {
    throw new OrchestrationError(
      "binding_drift",
      `CapabilityPlan artifact failed validation: ${path}: ${validation.errors
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }
  return record as unknown as CapabilityPlanRecord;
}

/** Schema-verified revisions for exactly one operation, oldest first. */
export function loadCapabilityPlans(ctx: PipelineContext): CapabilityPlanRecord[] {
  const directory = resolveHarnessPath(harnessRoot(ctx.deps), "artifacts/capability-plans");
  if (!existsSync(directory)) return [];
  const plans: CapabilityPlanRecord[] = [];
  for (const planDirectory of readdirSync(directory, { withFileTypes: true })) {
    if (!planDirectory.isDirectory()) continue;
    const relativeDirectory = `artifacts/capability-plans/${planDirectory.name}`;
    const absoluteDirectory = resolveHarnessPath(harnessRoot(ctx.deps), relativeDirectory);
    for (const name of readdirSync(absoluteDirectory)
      .filter((entry) => /^[0-9]+\.json$/u.test(entry))
      .sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10))) {
      const path = `${relativeDirectory}/${name}`;
      const parsed = readJsonArtifact<unknown>(ctx.deps, path);
      const plan = assertCapabilityPlanRecord(parsed, path);
      if (plan.operation_id === ctx.workflowOperationId) plans.push(plan);
    }
  }
  return plans.sort((left, right) => left.revision - right.revision);
}

async function persistCapabilityPlan(
  ctx: PipelineContext,
  plan: CapabilityPlanRecord,
): Promise<void> {
  if (plan.operation_id !== ctx.workflowOperationId) {
    throw new OrchestrationError("binding_drift", "CapabilityPlan belongs to another operation");
  }
  assertCapabilityPlanRecord(plan, capabilityPlanArtifactPath(plan));
  const path = capabilityPlanArtifactPath(plan);
  const existing = readJsonArtifact<unknown>(ctx.deps, path);
  if (existing !== undefined) {
    const persisted = assertCapabilityPlanRecord(existing, path);
    if (persisted.record_digest !== plan.record_digest) {
      throw new OrchestrationError(
        "binding_drift",
        `CapabilityPlan revision ${String(plan.revision)} already exists with another digest`,
      );
    }
    return;
  }
  await commitArtifacts(ctx.deps, ctx.workflowOperationId, currentAttemptId(ctx), [
    { path, content: `${canonicalizeJson(plan)}\n` },
  ]);
}

function acceptedPrdForOperation(ctx: PipelineContext) {
  return readAcceptedPrdRecords(ctx.deps.projectRoot)
    .filter((record) => record.workflow_operation_id === ctx.workflowOperationId)
    .at(-1);
}

function acceptedDesignBinding(designSet: NodeRecord): {
  readonly design_set_digest: string;
  readonly test_strategy_digest: string;
} {
  const extension = readDesignSetExtension(designSet);
  const primaryStrategyIds = new Set(
    extension.content.coverage.flatMap((coverage) =>
      coverage.test_strategy_coverage.map((entry) => entry.primary_test_strategy_id),
    ),
  );
  const strategyBindings = extension.bindings.nodes
    .filter((binding) => primaryStrategyIds.has(binding.node_id))
    .map((binding) => ({
      node_id: binding.node_id,
      revision: binding.revision,
      digest: binding.digest,
    }));
  if (strategyBindings.length !== primaryStrategyIds.size) {
    throw new OrchestrationError(
      "binding_drift",
      "accepted DesignSet does not bind every primary test strategy",
    );
  }
  return {
    design_set_digest: extension.content_digest,
    test_strategy_digest: contentDigest(strategyBindings),
  };
}

async function ensureInitialCapabilityPlan(ctx: PipelineContext): Promise<CapabilityPlanRecord> {
  const supplied = ctx.deps.capabilityPlan;
  if (supplied !== undefined) {
    ctx.capabilityPlan = supplied;
    return supplied;
  }
  const existing = loadCapabilityPlans(ctx).at(-1);
  if (existing !== undefined) {
    ctx.capabilityPlan = existing;
    return existing;
  }
  const compiler = ctx.deps.capabilityPlanCompiler;
  if (compiler === undefined) {
    throw new OrchestrationError(
      "configuration",
      "Protocol 1.1 operation has no CapabilityPlan compiler",
    );
  }
  const accepted = acceptedPrdForOperation(ctx);
  if (accepted === undefined || accepted.requirement_baseline_digest !== ctx.baselineDigest) {
    throw new OrchestrationError(
      "binding_drift",
      "CapabilityPlan compilation requires the accepted PRD bound to this operation",
    );
  }
  const plan = compiler({
    operation_id: ctx.workflowOperationId,
    stage: "initial",
    requirement_digest: accepted.record_digest,
    risk_digest: accepted.risk_assessment_digest,
    policy_digest: ctx.workingState.policy_digest,
    baseline_digest: contentDigest({ repository_head: ctx.workingState.baseline_commit }),
  });
  await persistCapabilityPlan(ctx, plan);
  ctx.capabilityPlan = plan;
  return plan;
}

function activateModulesFromCapabilityPlan(
  available: ModuleContributions,
  plan: CapabilityPlanRecord,
): ModuleContributions {
  const active = new Set(
    plan.capabilities
      .filter((entry) => entry.resolution === "active")
      .map((entry) => entry.capability_id),
  );
  return {
    ...(active.has("impact_analysis") && available.impact !== undefined
      ? { impact: available.impact }
      : {}),
    ...(active.has("design_governance") && available.design !== undefined
      ? { design: available.design }
      : {}),
    ...(active.has("independent_evaluation") && available.evaluate !== undefined
      ? { evaluate: available.evaluate }
      : {}),
    ...(active.has("advanced_audit") && available.audit !== undefined
      ? { audit: available.audit }
      : {}),
  };
}

async function finalizeCapabilityPlan(
  ctx: PipelineContext,
  provisional: CapabilityPlanRecord,
  designSet: NodeRecord,
): Promise<CapabilityPlanRecord> {
  if (provisional.compilation_stage === "final") return provisional;
  const compiler = ctx.deps.capabilityPlanCompiler;
  const accepted = acceptedPrdForOperation(ctx);
  if (compiler === undefined || accepted === undefined) {
    throw new OrchestrationError(
      "configuration",
      "CapabilityPlan finalization requires compiler and accepted PRD bindings",
    );
  }
  const finalPlan = compiler({
    operation_id: ctx.workflowOperationId,
    stage: "final",
    requirement_digest: accepted.record_digest,
    risk_digest: accepted.risk_assessment_digest,
    policy_digest: ctx.workingState.policy_digest,
    baseline_digest: provisional.baseline_digest,
    accepted_design_set: acceptedDesignBinding(designSet),
    supersedes: provisional,
  });
  if (finalPlan.supersedes_digest !== provisional.record_digest) {
    throw new OrchestrationError(
      "binding_drift",
      "final CapabilityPlan does not supersede the active provisional revision",
    );
  }
  await persistCapabilityPlan(ctx, finalPlan);
  ctx.capabilityPlan = finalPlan;
  return finalPlan;
}
export function loadPlan(
  ctx: PipelineContext,
): { readonly node: NodeRecord; readonly content: ExecutionPlanContent } | undefined {
  const graph = materializeProjectGraph(ctx.deps.projectRoot);
  try {
    const migration = readJsonArtifact<OpenIterationMigrationRecord>(
      ctx.deps,
      migrationArtifactPath(ctx.workflowOperationId),
    );
    const invalidated = migration?.invalidated.plan_digest;
    const candidates = graph.nodes
      .filter(
        (candidate) =>
          candidate.type === "ExecutionPlan" &&
          candidate.provenance.iteration_id === ctx.iterationId,
      )
      .sort((left, right) => right.revision - left.revision);
    for (const node of candidates) {
      const content = readExecutionPlanContent(node);
      if (content.content_digest !== invalidated) return { node, content };
    }
    return undefined;
  } finally {
    graph.close();
  }
}
function loadBundleRecords(ctx: PipelineContext): Map<string, ContextBundleRecord> {
  const migration = readJsonArtifact<OpenIterationMigrationRecord>(
    ctx.deps,
    migrationArtifactPath(ctx.workflowOperationId),
  );
  const invalidated = new Set(migration?.invalidated.context_digests ?? []);
  const digests = new Set([
    ...Object.values(ctx.workingState.context_bundle_digests ?? {}),
    ...(ctx.workingState.context_bundle_digest === undefined
      ? []
      : [ctx.workingState.context_bundle_digest]),
  ]);
  const records = new Map<string, ContextBundleRecord>();
  if (digests.size === 0) return records;
  const directory = resolveHarnessPath(harnessRoot(ctx.deps), "artifacts/context-bundles");
  if (!existsSync(directory)) return records;
  for (const name of readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .sort()) {
    const record = readJsonArtifact<ContextBundleRecord>(
      ctx.deps,
      `artifacts/context-bundles/${name}`,
    );
    if (record !== undefined && digests.has(record.digest) && !invalidated.has(record.digest)) {
      records.set(record.task_id, record);
    }
  }
  return records;
}
function migrationArtifactPath(workflowOperationId: string): string {
  return `artifacts/migrations/${workflowOperationId}.json`;
}
function readJsonDirectory(deps: OrchestratorDependencies, relative: string): unknown[] {
  const directory = resolveHarnessPath(harnessRoot(deps), relative);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => readJsonArtifact<unknown>(deps, `${relative}/${entry}`))
    .filter((record): record is unknown => record !== undefined);
}
function runResultArtifactPath(runId: string): string {
  return `artifacts/run-results/${runId}.json`;
}
export function runNodeArtifactPath(runId: string): string {
  return `artifacts/run-nodes/${runId}.json`;
}
export function runNodeRecord(ctx: PipelineContext, runId: string): NodeRecord {
  const draft: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "node",
    id: runId,
    type: "Run",
    revision: 1,
    status: "accepted",
    source: "workflow",
    provenance: {
      iteration_id: ctx.iterationId,
      actor: "workflow-engine",
      timestamp: nowOf(ctx.deps),
    },
    confidence: 1,
  };
  const node = { ...draft, digest: contentDigest(draft) };
  const validation = validateSchema("node", node);
  if (!validation.valid) {
    throw new OrchestrationError(
      "configuration",
      `invalid run node: ${validation.errors.map((issue) => issue.message).join("; ")}`,
    );
  }
  return node as unknown as NodeRecord;
}
/**
 * Commit the Execution-Graph Run node for a run id (idempotent). RESUMES
 * edges bind run ids, so every run must exist as a graph node before the
 * integrity check materializes the ledger.
 */
export async function commitRunNode(
  ctx: PipelineContext,
  runId: string,
  taskId: string,
): Promise<void> {
  const path = runNodeArtifactPath(runId);
  const artifacts: { readonly path: string; readonly content: string }[] = [];
  const node = runNodeRecord(ctx, runId);
  if (!artifactExists(ctx.deps, path)) {
    artifacts.push({ path, content: `${canonicalizeJson(node)}\n` });
  }
  const graph = materializeProjectGraph(ctx.deps.projectRoot);
  let executesExists: boolean;
  try {
    executesExists = graph.edges.some(
      (edge) => edge.type === "EXECUTES" && edge.source_id === runId && edge.target_id === taskId,
    );
  } finally {
    graph.close();
  }
  const edges: EdgeRecord[] = [];
  if (!executesExists) {
    const content: Record<string, unknown> = {
      protocol_version: PROTOCOL_VERSION,
      record_kind: "edge",
      id: `edge_${contentDigest({ type: "EXECUTES", source: runId, target: taskId }).slice(0, 16)}`,
      type: "EXECUTES",
      source_id: runId,
      target_id: taskId,
      status: "accepted",
      source: "workflow",
      provenance: {
        iteration_id: ctx.iterationId,
        run_id: runId,
        actor: "workflow-engine",
        timestamp: nowOf(ctx.deps),
      },
      confidence: 1,
    };
    const edge = { ...content, digest: contentDigest(content) };
    const edgeValidation = validateSchema("edge", edge);
    if (!edgeValidation.valid) {
      throw new OrchestrationError(
        "configuration",
        `invalid Run EXECUTES edge: ${edgeValidation.errors.map((issue) => issue.message).join("; ")}`,
      );
    }
    edges.push(edge as unknown as EdgeRecord);
  }
  if (artifacts.length > 0 || edges.length > 0) {
    await commitArtifacts(
      ctx.deps,
      ctx.workflowOperationId,
      currentAttemptId(ctx),
      artifacts,
      edges,
    );
  }
}
/** Project the immutable terminal Run fact into the graph without changing its outcome. */
async function commitRunFact(
  ctx: PipelineContext,
  runId: string,
  result: AgentRunResult,
): Promise<void> {
  const graph = materializeProjectGraph(ctx.deps.projectRoot);
  let current: NodeRecord | undefined;
  try {
    current = graph.nodes.find((node) => node.id === runId && node.type === "Run");
  } finally {
    graph.close();
  }
  if (current === undefined) {
    throw new OrchestrationError("binding_drift", `terminal result targets unknown run ${runId}`);
  }
  const resultDigest = sha256Hex(canonicalizeJson(result));
  const prior = current.extensions?.["harness.run-fact"];
  if (
    typeof prior === "object" &&
    prior !== null &&
    (prior as Record<string, unknown>)["result_digest"] === resultDigest
  ) {
    return;
  }
  const revision = current.revision + 1;
  const base: Record<string, unknown> = Object.fromEntries(
    Object.entries(current).filter(([key]) => key !== "digest"),
  );
  base.revision = revision;
  base.provenance = {
    iteration_id: ctx.iterationId,
    run_id: runId,
    actor: "workflow-engine",
    timestamp: nowOf(ctx.deps),
  };
  base.extensions = {
    ...(current.extensions ?? {}),
    "harness.run-fact": {
      outcome: result.outcome,
      termination_reason: result.termination_reason,
      completion_claimed: result.completion_claimed,
      result_digest: resultDigest,
      change_summary: result.change_summary,
      budget_observations: result.budget_observations ?? [],
    },
  };
  const node = { ...base, digest: contentDigest(base) };
  const validation = validateSchema("node", node);
  if (!validation.valid) {
    throw new OrchestrationError(
      "configuration",
      `invalid terminal Run fact node: ${validation.errors
        .map((issue) => `${issue.instancePath}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  await commitArtifacts(ctx.deps, ctx.workflowOperationId, currentAttemptId(ctx), [
    {
      path: `artifacts/run-nodes/${runId}-${String(revision)}.json`,
      content: `${canonicalizeJson(node)}\n`,
    },
  ]);
}
export function loadCompletedRun(
  ctx: PipelineContext,
  taskId: string,
): { readonly runId: string; readonly result: AgentRunResult } | undefined {
  const streams = readRunStreams(workflowDeps(ctx.deps), ctx.workflowOperationId);
  // Latest matching run wins: earlier runs may carry a failed evaluation that
  // a repair re-execution already superseded.
  for (const stream of [...streams].reverse()) {
    const started = stream.records[0];
    if (started === undefined || started.record_kind !== "run_started") continue;
    if (started.task_id !== taskId) continue;
    if (streamTerminalRecord(stream) === undefined) continue;
    const result = readJsonArtifact<AgentRunResult>(ctx.deps, runResultArtifactPath(stream.runId));
    if (result !== undefined) return { runId: stream.runId, result };
  }
  return undefined;
}
function loadOpenRunId(ctx: PipelineContext, taskId: string): string | undefined {
  const streams = readRunStreams(workflowDeps(ctx.deps), ctx.workflowOperationId);
  for (const stream of streams) {
    const started = stream.records[0];
    if (started === undefined || started.record_kind !== "run_started") continue;
    if (started.task_id !== taskId) continue;
    if (streamTerminalRecord(stream) === undefined) return stream.runId;
  }
  return undefined;
}
function verifyArtifactPath(
  iterationId: string,
  bindings: VerifyPhaseArtifact["bindings"],
): string {
  return `artifacts/verify/${iterationId}/${sha256Hex(canonicalizeJson(bindings))}.json`;
}
/** Load a committed verify verdict whose bindings still match, if any. */
function loadVerifyArtifact(
  deps: OrchestratorDependencies,
  iterationId: string,
  bindings: VerifyPhaseArtifact["bindings"],
): VerifyPhaseArtifact | undefined {
  const directory = resolveHarnessPath(harnessRoot(deps), `artifacts/verify/${iterationId}`);
  if (!existsSync(directory)) return undefined;
  for (const name of readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .sort()) {
    const artifact = readJsonArtifact<VerifyPhaseArtifact>(
      deps,
      `artifacts/verify/${iterationId}/${name}`,
    );
    if (artifact !== undefined && verificationBindingsEqual(artifact.bindings, bindings)) {
      return artifact;
    }
  }
  return undefined;
}
/**
 * Task-level quality record (comparative design direction 5, card T5): one
 * digest-sealed ledger artifact per (iteration, task, bindings), holding the
 * gate-suite verdict plus one machine-checkable row per acceptance assertion
 * of the task. The record binds exactly the digests gate evidence binds, so
 * it goes stale under the same freshness semantics -- a changed worktree
 * produces a new record at a new digest-versioned path instead of reusing
 * the stale one.
 */
interface TaskQualityAssertion {
  readonly description: string;
  readonly verification: string;
  readonly passed: boolean;
  readonly evidence_ids: readonly string[];
}
interface TaskQualityRecord {
  readonly protocol_version: string;
  readonly record_kind: "task_quality_record";
  readonly iteration_id: string;
  readonly task_id: string;
  readonly bindings: VerifyPhaseArtifact["bindings"];
  readonly verdict: "passed" | "failed";
  readonly metrics: {
    readonly gates_total: number;
    readonly gates_passed: number;
    readonly mandatory_gates_failed: number;
    readonly coverage: number | null;
    readonly lint_passed: boolean | null;
  };
  readonly gates: readonly {
    readonly gate_id: string;
    readonly mandatory: boolean;
    readonly passed: boolean;
    readonly evidence_id: string;
    readonly summary: string;
  }[];
  readonly assertions: readonly TaskQualityAssertion[];
  readonly created_at: string;
  readonly digest: string;
}
function qualityRecordPath(
  iterationId: string,
  taskId: string,
  bindings: VerifyPhaseArtifact["bindings"],
): string {
  return `artifacts/quality/${iterationId}/${taskId}/${sha256Hex(canonicalizeJson(bindings))}.json`;
}
/**
 * Build one quality record per planned task. An assertion whose verification
 * text names a gate binds to that gate; every other assertion binds to the
 * whole mandatory suite. A row passes only when every bound gate passed with
 * non-provisional evidence. Thresholds stay a Pack/Policy concern (the gate
 * `mandatory` flag); M1 packs expose no coverage or lint tool, so those
 * fields are explicit nulls instead of fabricated numbers.
 */
function buildTaskQualityRecords(
  ctx: PipelineContext,
  outcome: GateSuiteOutcome,
  bindings: VerifyPhaseArtifact["bindings"],
): { readonly path: string; readonly content: string }[] {
  const plan = ctx.plan;
  if (plan === undefined) return [];
  const mandatoryResults = outcome.results.filter((result) => result.gate.mandatory);
  return plan.content.tasks.map((task) => {
    const assertions: TaskQualityAssertion[] = task.acceptance.map((criterion) => {
      const named = outcome.results.filter((result) =>
        criterion.verification.includes(result.gate.gate_id),
      );
      const bound = named.length > 0 ? named : mandatoryResults;
      return {
        description: criterion.description,
        verification: criterion.verification,
        passed: bound.every((result) => result.outcome.passed && !result.evidence.provisional),
        evidence_ids: bound.map((result) => result.evidence.evidence_id),
      };
    });
    const content: Omit<TaskQualityRecord, "digest"> = {
      protocol_version: PROTOCOL_VERSION,
      record_kind: "task_quality_record",
      iteration_id: ctx.iterationId,
      task_id: task.id,
      bindings,
      verdict: outcome.completed_allowed ? "passed" : "failed",
      metrics: {
        gates_total: outcome.results.length,
        gates_passed: outcome.results.filter((result) => result.outcome.passed).length,
        mandatory_gates_failed: mandatoryResults.filter(
          (result) => !result.outcome.passed || result.evidence.provisional,
        ).length,
        coverage: null,
        lint_passed: null,
      },
      gates: outcome.results.map((result) => ({
        gate_id: result.gate.gate_id,
        mandatory: result.gate.mandatory,
        passed: result.outcome.passed,
        evidence_id: result.evidence.evidence_id,
        summary: result.outcome.summary,
      })),
      assertions,
      created_at: nowOf(ctx.deps),
    };
    const record: TaskQualityRecord = { ...content, digest: contentDigest(content) };
    return {
      path: qualityRecordPath(ctx.iterationId, task.id, bindings),
      content: `${canonicalizeJson(record)}\n`,
    };
  });
}
export interface EvaluatePhaseArtifact {
  readonly record_kind: "orchestration_evaluate_result";
  readonly iteration_id: string;
  readonly run_digest: string;
  readonly result: EvaluationPortResult;
}
export function evaluateArtifactPath(iterationId: string, runDigest: string): string {
  return `artifacts/evaluate/${iterationId}/${runDigest}.json`;
}
/** Committed evaluations of an iteration, oldest path first. */
export function loadEvaluateArtifacts(
  deps: OrchestratorDependencies,
  iterationId: string,
): EvaluatePhaseArtifact[] {
  const directory = resolveHarnessPath(harnessRoot(deps), `artifacts/evaluate/${iterationId}`);
  if (!existsSync(directory)) return [];
  const artifacts: EvaluatePhaseArtifact[] = [];
  for (const name of readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .sort()) {
    const artifact = readJsonArtifact<EvaluatePhaseArtifact>(
      deps,
      `artifacts/evaluate/${iterationId}/${name}`,
    );
    if (artifact !== undefined) artifacts.push(artifact);
  }
  return artifacts;
}
export function effectivePolicy(): EffectivePolicy {
  const merged = mergePolicyLayers([]);
  if (merged.conflicts.length > 0) {
    throw new OrchestrationError("configuration", merged.conflicts.join("; "));
  }
  return merged.effective;
}
async function commitIterationNode(
  ctx: PipelineContext,
  iterationState: "running" | "completed" | "blocked" | "aborted",
): Promise<void> {
  const graph = materializeProjectGraph(ctx.deps.projectRoot);
  let existing: NodeRecord | undefined;
  try {
    existing = graph.nodes.find((node) => node.id === ctx.iterationId && node.type === "Iteration");
  } finally {
    graph.close();
  }
  const timestamp = nowOf(ctx.deps);
  const base: Record<string, unknown> =
    existing === undefined
      ? {
          protocol_version: PROTOCOL_VERSION,
          record_kind: "node",
          id: ctx.iterationId,
          type: "Iteration",
          revision: 1,
          status: "accepted",
          source: "workflow",
          provenance: {
            iteration_id: ctx.iterationId,
            actor: "workflow-engine",
            timestamp,
          },
          confidence: 1,
          extensions: { "harness.orchestration": { goal: ctx.goal } },
        }
      : Object.fromEntries(Object.entries(existing).filter(([key]) => key !== "digest"));
  if (existing !== undefined) {
    base.revision = existing.revision + 1;
    base.provenance = {
      iteration_id: ctx.iterationId,
      actor: "workflow-engine",
      timestamp,
    };
  }
  base.iteration_state = iterationState;
  const node = { ...base, digest: contentDigest(base) };
  const validation = validateSchema("node", node);
  if (!validation.valid) {
    throw new OrchestrationError(
      "configuration",
      `invalid iteration node: ${validation.errors.map((issue) => issue.message).join("; ")}`,
    );
  }
  const revision = typeof base.revision === "number" ? base.revision : 1;
  await commitArtifacts(ctx.deps, ctx.workflowOperationId, currentAttemptId(ctx), [
    {
      path: `artifacts/iterations/${ctx.iterationId}/${String(revision)}.json`,
      content: `${canonicalizeJson(node)}\n`,
    },
  ]);
}
/** Commit a blocked snapshot, then block the operation with its typed reason. */
export async function blockWithSnapshot(
  ctx: PipelineContext,
  spec: {
    readonly reason: RecoverableBlockReason;
    readonly detail: string;
    readonly resumePhase: OrchestrationPhase;
    readonly input: Omit<
      Parameters<typeof buildSnapshot>[0],
      "snapshot_id" | "created_at" | "block_reason" | "resume_phase" | "source_commit"
    >;
  },
): Promise<OrchestrationOutcome> {
  const partial = {
    ...spec.input,
    snapshot_id: "snapshot_pending",
    source_commit: ctx.deps.readBaseline(),
    created_at: nowOf(ctx.deps),
    block_reason: spec.reason,
    resume_phase: spec.resumePhase,
  };
  const blockerSeed = snapshotCompletionBlockers(partial).join(";");
  const snapshot = buildSnapshot({
    ...spec.input,
    snapshot_id: `snapshot_${sha256Hex(`${ctx.iterationId}:${spec.reason}:${spec.detail}:${blockerSeed}`).slice(0, 16)}`,
    source_commit: ctx.deps.readBaseline(),
    created_at: nowOf(ctx.deps),
    block_reason: spec.reason,
    resume_phase: spec.resumePhase,
  });
  await commitArtifacts(ctx.deps, ctx.workflowOperationId, currentAttemptId(ctx), [
    {
      path: `artifacts/snapshots/${snapshot.snapshot_id}.json`,
      content: `${canonicalizeJson(snapshot)}\n`,
    },
  ]);
  await commitIterationNode(ctx, "blocked");
  await ctx.engine.block(ctx.workflowOperationId, {
    reason: spec.reason,
    detail: spec.detail,
    proposal: {
      phase: spec.resumePhase,
      set_next_action: resumeCommandFor(ctx.workflowOperationId),
    },
  });
  refreshWorkingState(ctx);
  return {
    status: "blocked",
    workflowOperationId: ctx.workflowOperationId,
    iterationId: ctx.iterationId,
    reason: spec.reason,
    detail: spec.detail,
    resumeCommand: resumeCommandFor(ctx.workflowOperationId),
    snapshotId: snapshot.snapshot_id,
  };
}
export type PhaseStep =
  | { readonly continue: true }
  | { readonly continue: false; readonly outcome: OrchestrationOutcome };
async function phaseCapture(ctx: PipelineContext): Promise<PhaseStep> {
  const { deps } = ctx;
  if (deps.capture !== undefined) return phaseCaptureCoordinated(ctx, deps.capture);
  const baselinePath = baselineDocumentArtifactPath(ctx.baselineDigest);
  if (!artifactExists(deps, baselinePath)) {
    const approval = await ensureApproval(ctx, {
      objectId: ctx.proposal.intent.id,
      objectType: "RequirementBaseline",
      objectDigest: ctx.baselineDigest,
      risk: "medium",
      reason: "approve the requirement baseline before planning",
      resumePhase: "capture",
    });
    if (approval.status === "required")
      return {
        continue: false,
        outcome: { status: "approval_required", required: approval.required },
      };
    if (approval.status === "rejected") {
      return {
        continue: false,
        outcome: await rejectOperation(ctx, "requirement baseline rejected"),
      };
    }
    const operation = ctx.engine.getOperation(ctx.workflowOperationId);
    if (operation === undefined)
      throw new OrchestrationError("operation_not_found", "operation lost");
    await commitRequirementBaseline(
      workflowDeps(deps),
      {
        projectId: `project_${readManagedManifest(deps.projectRoot).name}`,
        iterationId: ctx.iterationId,
        actor: "workflow-engine",
        timestamp: nowOf(deps),
        newId: (kind) => newIdOf(deps, kind),
      },
      ctx.proposal,
      {
        workflowOperationId: ctx.workflowOperationId,
        attemptId: currentAttemptId(ctx),
        approvalDigest: approval.approvalDigest,
      },
    );
  }
  await ctx.engine.commitCheckpoint(ctx.workflowOperationId, {
    boundary: PHASE_CHECKPOINT_BOUNDARY.capture,
    proposal: { phase: "impact" },
  });
  refreshWorkingState(ctx);
  return { continue: true };
}
/**
 * Consume the bridged human decision into the coordinator (single decision
 * surface): the engine ledger holds the one committed request/decision pair;
 * the coordinator consumes it through `apply_approval_decision`, which runs
 * the atomic accepted transaction on approve. Replay is idempotent on both
 * sides — the engine replays its terminal decision, the coordinator replays
 * an already-consumed decision id as a no-op.
 */
async function applyBridgedCaptureDecision(
  ctx: PipelineContext,
  seam: CaptureCoordinatorSeam,
  sessionId: string,
): Promise<void> {
  const session = seam.coordinator.current(sessionId);
  const requestId = session?.current_approval_request_id;
  const objectDigest = session?.current_proposal_digest;
  if (session === undefined || requestId === undefined || objectDigest === undefined) {
    throw new OrchestrationError(
      "configuration",
      "the capture session lost its approval binding before the decision could be consumed",
    );
  }
  const view = findBridgedCaptureApprovalDecision(
    ctx.deps.projectRoot,
    ctx.workflowOperationId,
    requestId,
    objectDigest,
  );
  if (view === undefined) {
    throw new OrchestrationError(
      "configuration",
      "the approval surface resolved without a committed decision the capture session can consume",
    );
  }
  const outcome = await seam.coordinator.advance({
    command: "apply_approval_decision",
    session_id: sessionId,
    expected_session_digest: session.record_digest,
    request_id: requestId,
    decision_id: view.decision_id,
  });
  if (outcome.status === "failed") {
    throw new OrchestrationError(
      outcome.kind === "binding_drift" ? "binding_drift" : "configuration",
      `consuming the bridged approval decision failed (${outcome.kind}): ${outcome.message}`,
    );
  }
  if (outcome.status === "conflict") {
    throw new OrchestrationError(
      "binding_drift",
      "the capture session advanced while the approval decision was being consumed",
    );
  }
}
/**
 * The coordinated capture phase: approval and the baseline commit already
 * happened inside the coordinator (risk policy routes to the human route; the
 * accepted transaction commits the baseline and the graph atomically), so the
 * legacy ensureApproval/commitRequirementBaseline pair must not run here —
 * this branch only bridges the human decision and verifies the committed
 * baseline still matches the checkpoint binding.
 */
async function phaseCaptureCoordinated(
  ctx: PipelineContext,
  seam: CaptureCoordinatorSeam,
): Promise<PhaseStep> {
  const sessionId = captureSessionIdFor(ctx.goal, ctx.workflowOperationId);
  const session = seam.coordinator.current(sessionId);
  if (session === undefined) {
    throw new OrchestrationError(
      "configuration",
      "coordinated capture session missing at the capture phase",
    );
  }
  if (session.state === "approval_required") {
    const requestId = session.current_approval_request_id;
    const objectDigest = session.current_proposal_digest;
    if (requestId === undefined || objectDigest === undefined) {
      throw new OrchestrationError(
        "configuration",
        "approval_required capture session without a bound request or proposal",
      );
    }
    const approval = await ensureApproval(ctx, {
      objectId: requestId,
      objectType: CAPTURE_APPROVAL_OBJECT_TYPE,
      objectDigest,
      risk: "medium",
      reason: "approve the captured PRD before planning",
      resumePhase: "capture",
    });
    if (approval.status === "required") {
      return {
        continue: false,
        outcome: { status: "approval_required", required: approval.required },
      };
    }
    await applyBridgedCaptureDecision(ctx, seam, sessionId);
    if (approval.status === "rejected") {
      return { continue: false, outcome: await rejectOperation(ctx, "captured PRD rejected") };
    }
  }
  const current = seam.coordinator.current(sessionId);
  if (current === undefined || current.state !== "accepted") {
    throw new OrchestrationError(
      "configuration",
      `coordinated capture session rests at ${current?.state ?? "missing"}, expected accepted`,
    );
  }
  const baseline = readAcceptedPrdRecords(ctx.deps.projectRoot, deriveAcceptedPrdId(sessionId)).at(
    -1,
  );
  if (baseline === undefined || baseline.requirement_baseline_digest !== ctx.baselineDigest) {
    throw new OrchestrationError(
      "binding_drift",
      "the accepted capture baseline no longer matches the approved checkpoint binding",
    );
  }
  await ctx.engine.commitCheckpoint(ctx.workflowOperationId, {
    boundary: PHASE_CHECKPOINT_BOUNDARY.capture,
    proposal: { phase: "impact", set_requirement_baseline_digest: ctx.baselineDigest },
  });
  refreshWorkingState(ctx);
  return { continue: true };
}
/**
 * Deterministic default decomposition: one small task per requirement of the
 * approved baseline, each independently verifiable through its own acceptance
 * slice, every task bound to the full approved impact set (the binding check
 * requires must-change coverage; path-level partitioning is the port's job).
 * Every accepted criterion compiles to its canonical criterion_assertion —
 * the kernel invariant of provable TDD design 7.1 holds for the default
 * planner exactly as for the proposal channel — and the coverage validator
 * fails closed on any gap. With a single requirement this degenerates to
 * exactly the historical single-task plan, id and digest included.
 */
async function taskSpecificationsFor(
  ctx: PipelineContext,
  impactSet: NodeRecord,
  gateIds: readonly string[],
): Promise<readonly TaskSpecification[]> {
  const content = readImpactSetContent(impactSet);
  const impactPaths = content.entries.map((entry) => [...entry.path]);
  const acceptedTestIds = content.entries
    .filter((entry) => entry.node_type === "Test")
    .map((entry) => entry.node_id)
    .sort(byId);
  const acceptedTests = new Set(acceptedTestIds);
  const testIdsByRequirement = new Map<string, string[]>();
  // Canonical criterion lineage of the accepted baseline (provable TDD design
  // 7.1 — a kernel invariant of every Protocol 1.1 plan, independent of
  // strict_tdd): managed-capture Test seeds carry the criterion binding the
  // assertion identity compiles from; legacy baseline seeds only carry the
  // description/verification pair, matched back to their criterion below.
  const boundCriteria: {
    readonly criterion_id: string;
    readonly criterion_semantic_digest: string;
    readonly requirement_id: string;
    readonly test_node_id: string;
  }[] = [];
  const legacySeedsByVerifies = new Map<
    string,
    { readonly id: string; readonly description: string; readonly verification: string }[]
  >();
  const graph = materializeProjectGraph(ctx.deps.projectRoot);
  try {
    for (const edge of graph.edges) {
      if (edge.type !== "VERIFIES" || !acceptedTests.has(edge.source_id)) continue;
      const existing = testIdsByRequirement.get(edge.target_id) ?? [];
      existing.push(edge.source_id);
      testIdsByRequirement.set(edge.target_id, existing);
    }
    for (const node of graph.nodes) {
      if (node.type !== "Test" || node.status !== "accepted" || !acceptedTests.has(node.id))
        continue;
      const binding = testSeedCriterionBinding(node);
      if (binding !== undefined && binding.criterion_semantic_digest !== undefined) {
        boundCriteria.push({
          criterion_id: binding.acceptance_criterion_id,
          criterion_semantic_digest: binding.criterion_semantic_digest,
          requirement_id: binding.verifies,
          test_node_id: node.id,
        });
        continue;
      }
      const seed = legacyTestSeedContent(node);
      if (seed === undefined) continue;
      const seeds = legacySeedsByVerifies.get(seed.verifies) ?? [];
      seeds.push({ id: node.id, description: seed.description, verification: seed.verification });
      legacySeedsByVerifies.set(seed.verifies, seeds);
    }
  } finally {
    graph.close();
  }
  const requirements = ctx.proposal.requirements
    .map((requirement) => ({
      id: requirement.id,
      statement: requirement.statement,
      acceptance: requirement.acceptance.map((criterion) => ({ ...criterion })),
      testIds: [...(testIdsByRequirement.get(requirement.id) ?? [])].sort(byId),
    }))
    .sort((left, right) => byId(left.id, right.id));
  const assignedTestIds = new Set(requirements.flatMap((requirement) => requirement.testIds));
  const unassignedTestIds = acceptedTestIds.filter((testId) => !assignedTestIds.has(testId));
  const clusteredRequirements = requirements.map((requirement, index) => ({
    ...requirement,
    testIds:
      index === 0 ? [...requirement.testIds, ...unassignedTestIds].sort(byId) : requirement.testIds,
  }));
  if (ctx.deps.planTasks !== undefined && ctx.deps.planProposal !== undefined) {
    throw new OrchestrationError(
      "configuration",
      "planTasks and planProposal are mutually exclusive; configure PlanProposalPort (the legacy adapter keeps one major)",
    );
  }
  if (ctx.deps.planProposal !== undefined) {
    return planProposalSpecificationsFor(ctx, impactSet, gateIds, impactPaths);
  }
  if (ctx.deps.planTasks !== undefined) {
    return ctx.deps.planTasks({
      goal: ctx.goal,
      requirements: clusteredRequirements,
      impactPaths,
      acceptedTestIds,
      gateIds: [...gateIds],
    });
  }
  // Every accepted criterion compiles to exactly one canonical
  // criterion_assertion whose identity follows the harness:criterion-assertion
  // formula (criterion id + semantic digest + schema version) — never a
  // positional or whole-object digest, so an unrelated insertion or a
  // non-semantic change never rotates an unchanged criterion's assertion.
  const criterionInputsFor = (
    requirement: (typeof clusteredRequirements)[number],
  ): {
    criterion_id: string;
    criterion_semantic_digest: string;
    requirement_id: string;
    test_node_id: string;
  }[] => {
    const bound = boundCriteria
      .filter((criterion) => criterion.requirement_id === requirement.id)
      .sort((left, right) => byId(left.criterion_id, right.criterion_id));
    if (bound.length > 0) return bound.map((criterion) => ({ ...criterion }));
    // Legacy baselines carry no criterion bindings on their Test seeds; the
    // canonical identity derives from the acceptance pair itself through the
    // same semantic mapping the legacy proposal adapter establishes
    // (precondition-free, action and observable outcome equal the
    // description), paired with the seed that verifies it.
    const seeds = [...(legacySeedsByVerifies.get(requirement.id) ?? [])];
    return requirement.acceptance.map((criterion) => {
      const semanticDigest = criterionSemanticDigest({
        requirement_id: requirement.id,
        precondition: "",
        action: criterion.description,
        observable_outcome: criterion.description,
        verification_intent: criterion.verification,
        scenario_kind: "primary",
      });
      const seedIndex = seeds.findIndex(
        (seed) =>
          seed.description === criterion.description &&
          seed.verification === criterion.verification,
      );
      if (seedIndex === -1) {
        throw new PlanningError(
          "invalid_specification",
          `accepted criterion of requirement ${requirement.id} has no Test seed in the requirement baseline`,
        );
      }
      const seed = seeds.splice(seedIndex, 1)[0] as (typeof seeds)[number];
      return {
        criterion_id: `criterion_${contentDigest({ requirement: requirement.id, criterion_semantic_digest: semanticDigest }).slice(0, 16)}`,
        criterion_semantic_digest: semanticDigest,
        requirement_id: requirement.id,
        test_node_id: seed.id,
      };
    });
  };
  const descriptorsByRequirement = new Map(
    clusteredRequirements.map(
      (requirement) =>
        [requirement.id, compileCriterionAssertions(criterionInputsFor(requirement))] as const,
    ),
  );
  // A bound criterion whose requirement left the proposal view is baseline
  // drift; it compiles but finds no owning task, and coverage fails closed.
  const knownRequirementIds = new Set(clusteredRequirements.map((requirement) => requirement.id));
  const descriptors = [
    ...[...descriptorsByRequirement.values()].flat(),
    ...compileCriterionAssertions(
      boundCriteria.filter((criterion) => !knownRequirementIds.has(criterion.requirement_id)),
    ),
  ];
  const specifications: TaskSpecification[] = clusteredRequirements.map((requirement) => ({
    id: `task_${contentDigest({ goal: ctx.goal, outputs: [requirement.id] }).slice(0, 16)}`,
    objective: ctx.goal,
    impact_paths: impactPaths.map((path) => [...path]),
    expected_outputs: [requirement.id],
    capabilities: [],
    tools: [],
    dependencies: [],
    risk: "low",
    budget: { steps: 30, tokens: 120000 },
    acceptance: requirement.acceptance.map((criterion) => ({ ...criterion })),
    assertions: (descriptorsByRequirement.get(requirement.id) ?? []).map((descriptor) => ({
      assertion_id: descriptor.assertion_id,
      assertion_kind: "criterion_assertion" as const,
      acceptance_criterion_id: descriptor.acceptance_criterion_id,
      criterion_semantic_digest: descriptor.criterion_semantic_digest,
      test_ids: [descriptor.test_node_id],
      required_gate_ids: [...gateIds],
      evidence_requirements: ["gate_evidence"],
    })),
    required_gates: [...gateIds],
  }));
  const coverage = validateCriterionAssertionCoverage({
    descriptors,
    accepted_criteria: descriptors.map((descriptor) => ({
      criterion_id: descriptor.acceptance_criterion_id,
      criterion_semantic_digest: descriptor.criterion_semantic_digest,
    })),
    task_assertion_assignments: Object.fromEntries(
      specifications.map((specification) => [
        specification.id,
        (specification.assertions ?? []).map((assertion) => assertion.assertion_id),
      ]),
    ),
  });
  if (coverage.length > 0) {
    throw new PlanningError(
      "invalid_specification",
      `default decomposition failed criterion assertion coverage: ${coverage
        .map(
          (issue) => `${issue.code}${issue.target_id === undefined ? "" : ` (${issue.target_id})`}`,
        )
        .join(", ")}`,
    );
  }
  return specifications;
}
function byId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
/**
 * The criterion binding of one accepted Test seed node. The protocol-1.1
 * accepted transaction namespaces its extensions under `harness.requirements`
 * while older writers stored them flat, so both shapes resolve; a node
 * without a criterion id (e.g. a legacy baseline Test) yields no binding.
 */
export function testSeedCriterionBinding(node: NodeRecord):
  | {
      readonly acceptance_criterion_id: string;
      readonly criterion_semantic_digest?: string;
      readonly verifies: string;
    }
  | undefined {
  const extension = node.extensions ?? {};
  const namespaced = extension["harness.requirements"] as Record<string, unknown> | undefined;
  const field = (key: string): unknown => extension[key] ?? namespaced?.[key];
  const criterion = field("acceptance_criterion_id");
  const verifies = field("verifies");
  if (typeof criterion !== "string" || typeof verifies !== "string") return undefined;
  const semanticDigest = field("criterion_semantic_digest");
  return {
    acceptance_criterion_id: criterion,
    verifies,
    ...(typeof semanticDigest === "string" ? { criterion_semantic_digest: semanticDigest } : {}),
  };
}
/**
 * The acceptance pair of one legacy baseline Test seed (design 12 baseline
 * commit): description/verification/verifies, flat or namespaced like the
 * criterion binding above. A node without the full pair — a managed-capture
 * seed, for instance — is not a legacy acceptance seed.
 */
function legacyTestSeedContent(
  node: NodeRecord,
):
  | { readonly description: string; readonly verification: string; readonly verifies: string }
  | undefined {
  const extension = node.extensions ?? {};
  const namespaced = extension["harness.requirements"] as Record<string, unknown> | undefined;
  const field = (key: string): unknown => extension[key] ?? namespaced?.[key];
  const description = field("description");
  const verification = field("verification");
  const verifies = field("verifies");
  if (
    typeof description !== "string" ||
    typeof verification !== "string" ||
    typeof verifies !== "string"
  ) {
    return undefined;
  }
  return { description, verification, verifies };
}
/**
 * The T13 plan proposal channel: canonical criterion assertions compile from
 * accepted Test seeds (with primary strategy bindings when an accepted
 * DesignSet exists), the port only allocates them, and every authoritative
 * field — task ids, dependencies, gates, assertion bindings — is compiled by
 * the Harness when the candidates materialize. A failed or
 * clarification-only proposal is a typed planning error; nothing reaches the
 * ledger.
 */
async function planProposalSpecificationsFor(
  ctx: PipelineContext,
  impactSet: NodeRecord,
  gateIds: readonly string[],
  impactPaths: readonly (readonly string[])[],
): Promise<readonly TaskSpecification[]> {
  const port = ctx.deps.planProposal;
  if (port === undefined) {
    throw new OrchestrationError("configuration", "plan proposal channel missing");
  }
  const graph = materializeProjectGraph(ctx.deps.projectRoot);
  try {
    const nodes = [...graph.nodes];
    const acceptedTestIds = readImpactSetContent(impactSet)
      .entries.filter((entry) => entry.node_type === "Test")
      .map((entry) => entry.node_id)
      .sort(byId);
    const acceptedTests = new Set(acceptedTestIds);
    const criteria = nodes
      .filter(
        (node) => node.type === "Test" && node.status === "accepted" && acceptedTests.has(node.id),
      )
      .flatMap((node) => {
        const binding = testSeedCriterionBinding(node);
        return binding === undefined || binding.criterion_semantic_digest === undefined
          ? []
          : [
              {
                criterion_id: binding.acceptance_criterion_id,
                criterion_semantic_digest: binding.criterion_semantic_digest,
                requirement_id: binding.verifies,
                test_node_id: node.id,
              },
            ];
      });
    const strategies: Record<string, string> = {};
    let designSetDigest: string | undefined;
    if (ctx.designSet !== undefined) {
      const extension = readDesignSetExtension(ctx.designSet);
      designSetDigest = extension.content_digest;
      for (const entry of extension.content.coverage) {
        for (const binding of entry.test_strategy_coverage) {
          strategies[`${binding.acceptance_criterion_id}#${binding.test_node_id}`] =
            binding.primary_test_strategy_id;
        }
      }
    }
    const canonical = compileCriterionAssertions(criteria, { primary_strategies: strategies });
    const knownIds = (type: NodeRecord["type"]) =>
      nodes
        .filter((node) => node.type === type && node.status === "accepted")
        .map((node) => node.id)
        .sort(byId);
    const proposalInput: PlanProposalInput = {
      workflow_operation_id: ctx.workflowOperationId,
      iteration_id: ctx.iterationId,
      requirement_baseline_digest: ctx.baselineDigest,
      impact_set_digest: readImpactSetContent(impactSet).content_digest,
      policy_digest: ctx.workingState.policy_digest,
      ...(designSetDigest === undefined ? {} : { design_set_digest: designSetDigest }),
      ...(ctx.capabilityPlan === undefined
        ? {}
        : { capability_plan_digest: ctx.capabilityPlan.record_digest }),
      canonical_assertions: canonical,
      known_requirement_ids: knownIds("Requirement"),
      known_decision_ids: knownIds("Decision"),
      known_design_artifact_ids: knownIds("DesignArtifact"),
      known_gate_ids: [...gateIds].sort(byId),
      // Suggested paths are advisory until the envelope work (T15) owns the
      // authorized set; unconstrained here, never widened into the plan.
      allowed_write_paths: ["**"],
      max_tasks: 24,
      bundle_digest: contentDigest({
        canonical_assertions: canonical,
        impact_set_digest: readImpactSetContent(impactSet).content_digest,
      }),
      conversation_id: `plan-proposal-conversation_${ctx.workflowOperationId.replace(/^[a-z][a-z0-9-]*_/u, "")}`,
      run_id: `plan-proposal-run_${currentAttemptId(ctx)}`,
    };
    const result = await port.propose(proposalInput);
    if (result.status === "failed") {
      throw new PlanningError(
        "invalid_specification",
        `plan proposal failed: ${result.failure.summary}`,
      );
    }
    if (result.status === "clarification_required") {
      throw new PlanningError(
        "invalid_specification",
        `plan proposal requires clarification: ${result.questions
          .map((question) => question.question)
          .join("; ")}`,
      );
    }
    // Mirror the default decomposition's test assignment: accepted Test
    // entries verify their requirements through VERIFIES edges, and
    // unassigned tests attach to the first requirement.
    const testsByRequirement = new Map<string, string[]>();
    for (const edge of graph.edges) {
      if (edge.type !== "VERIFIES" || !acceptedTests.has(edge.source_id)) continue;
      const existing = testsByRequirement.get(edge.target_id) ?? [];
      existing.push(edge.source_id);
      testsByRequirement.set(edge.target_id, existing);
    }
    const sortedRequirements = [...ctx.proposal.requirements].sort((left, right) =>
      byId(left.id, right.id),
    );
    const assigned = new Set([...testsByRequirement.values()].flat());
    const unassigned = acceptedTestIds.filter((testId) => !assigned.has(testId));
    const legacyTestSeeds = Object.fromEntries(
      sortedRequirements.map((requirement, index) => {
        const testIds = [
          ...(testsByRequirement.get(requirement.id) ?? []),
          ...(index === 0 ? unassigned : []),
        ];
        const seeds = testIds.flatMap((testId) => {
          const node = nodes.find((candidate) => candidate.id === testId);
          if (node === undefined) return [];
          const content = legacyTestSeedContent(node);
          return content === undefined
            ? []
            : [
                {
                  description: content.description,
                  verification: content.verification,
                  test_node_id: testId,
                },
              ];
        });
        return [requirement.id, seeds] as const;
      }),
    );
    return materializePlanTasks(result.tasks, {
      canonical_assertions: canonical,
      impactPaths,
      gateIds,
      requirement_acceptance: Object.fromEntries(
        ctx.proposal.requirements.map((requirement) => [
          requirement.id,
          requirement.acceptance.map((criterion) => ({ ...criterion })),
        ]),
      ),
      legacy_test_seeds: legacyTestSeeds,
    });
  } finally {
    graph.close();
  }
}
export const orderedPlanTasks = orderExecutionTasks;
/**
 * IMPLEMENTS edges wiring each planned task to the requirements it delivers
 * (card T2/T3): the graph-native traceability link `traceability_gap` and
 * `task_orphan` audit against. Expected outputs that name no current
 * Requirement node are skipped (a dangling edge would fail integrity); the
 * task_orphan rule reports those tasks instead.
 */
function implementsEdgesFor(
  ctx: PipelineContext,
  specifications: readonly TaskSpecification[],
  tasks: readonly NodeRecord[],
): EdgeRecord[] {
  const graph = materializeProjectGraph(ctx.deps.projectRoot);
  let requirementIds: ReadonlySet<string>;
  try {
    const latest = new Map<string, NodeRecord>();
    for (const node of graph.nodes) {
      const current = latest.get(node.id);
      if (current === undefined || node.revision > current.revision) latest.set(node.id, node);
    }
    requirementIds = new Set(
      [...latest.values()]
        .filter((node) => node.type === "Requirement" && node.status !== "tombstoned")
        .map((node) => node.id),
    );
  } finally {
    graph.close();
  }
  const edges: EdgeRecord[] = [];
  for (const task of tasks) {
    const specification = specifications.find((candidate) => candidate.id === task.id);
    for (const output of [...(specification?.expected_outputs ?? [])].sort()) {
      if (!requirementIds.has(output)) continue;
      const content: Record<string, unknown> = {
        protocol_version: PROTOCOL_VERSION,
        record_kind: "edge",
        id: `edge_${contentDigest({ type: "IMPLEMENTS", source: task.id, target: output }).slice(0, 16)}`,
        type: "IMPLEMENTS",
        source_id: task.id,
        target_id: output,
        status: "proposed",
        source: "workflow",
        provenance: {
          iteration_id: ctx.iterationId,
          actor: "workflow-engine",
          timestamp: nowOf(ctx.deps),
        },
        confidence: 1,
      };
      const edge = { ...content, digest: contentDigest(content) };
      const validation = validateSchema("edge", edge);
      if (!validation.valid) {
        throw new OrchestrationError(
          "configuration",
          `invalid IMPLEMENTS edge: ${validation.errors.map((issue) => issue.message).join("; ")}`,
        );
      }
      edges.push(edge as unknown as EdgeRecord);
    }
  }
  return edges;
}
/**
 * T9 kernel-only planning input: when no module produced and froze an impact
 * set, plan from the deterministic propagation of the iteration seed without
 * persisting anything — no artifact, no approval, no event. The derivation is
 * the same pure propagation the impact module uses, so resume replays it
 * byte-identically.
 */
function deriveKernelImpactSet(ctx: PipelineContext): NodeRecord {
  const graph = materializeProjectGraph(ctx.deps.projectRoot);
  try {
    const seed: ChangeSeed = {
      id: `seed_${sha256Hex(`${ctx.proposal.intent.id}:${ctx.iterationKind}`).slice(0, 16)}`,
      nodeId: ctx.proposal.intent.id,
      kind: "content-change",
      iterationKind: ctx.iterationKind,
      reason: `requirement baseline intent ${ctx.proposal.intent.id} drives this iteration`,
    };
    return generateImpactSet([seed], [...graph.nodes], [...graph.edges], {
      iterationId: ctx.iterationId,
      actor: "workflow-engine",
      timestamp: nowOf(ctx.deps),
    });
  } finally {
    graph.close();
  }
}

const taskTddContractArtifactPath = (taskId: string): string =>
  `artifacts/tdd-contracts/${taskId}.json`;

function loadTaskTddContract(ctx: PipelineContext, taskId: string): TaskTddContract | undefined {
  const value = readJsonArtifact<unknown>(ctx.deps, taskTddContractArtifactPath(taskId));
  if (value === undefined) return undefined;
  const validation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate(
    "task-tdd-contract",
    value as Record<string, unknown>,
  );
  if (!validation.valid) {
    throw new OrchestrationError(
      "binding_drift",
      `TaskTddContract for ${taskId} failed validation: ${validation.errors
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }
  return value as TaskTddContract;
}

function taskTddVerdictInput(
  ctx: PipelineContext,
  task: TaskSpecification,
  gatesPassed: boolean,
  evaluationPassed: boolean | undefined,
): TaskTddVerdictInput | undefined {
  const capabilityEnabled = ctx.capabilityPlan?.operation_dag.nodes.some(
    (node) => node.node_id === "execute" && node.subgraph === "strict_tdd",
  );
  if (capabilityEnabled !== true) return undefined;
  const contract = loadTaskTddContract(ctx, task.id);
  if (contract === undefined) {
    throw new OrchestrationError(
      "binding_drift",
      `strict_tdd Task ${task.id} has no accepted TaskTddContract`,
    );
  }
  const cycles = readJsonDirectory(ctx.deps, "artifacts/tdd-cycles").filter(
    (cycle): cycle is TddCycleRecord =>
      typeof cycle === "object" &&
      cycle !== null &&
      (cycle as { readonly task_id?: unknown }).task_id === task.id,
  );
  return {
    capability_enabled: true,
    contract_mode: contract.contract_mode,
    required_assertion_ids: (task.assertions ?? []).map((entry) => entry.assertion_id),
    cycles,
    current_contract_digest: contract.contract_digest,
    gates_passed: gatesPassed,
    ...(evaluationPassed === undefined ? {} : { evaluation_passed: evaluationPassed }),
    ...(contract.not_applicable_binding === undefined
      ? {}
      : { not_applicable_binding: contract.not_applicable_binding }),
    ...(contract.assertion_clusters[0]?.refactor_policy === undefined
      ? {}
      : { refactor_policy: contract.assertion_clusters[0].refactor_policy }),
  };
}

/**
 * Compile the accepted DesignSet test strategy into one immutable contract
 * per Task. The planner never invents TDD applicability: every field below
 * is traced through Task Assertion -> accepted Test seed -> Criterion ->
 * Requirement -> primary accepted test_strategy asset.
 */
async function compileTaskTddContracts(ctx: PipelineContext): Promise<void> {
  const capabilityPlan = ctx.capabilityPlan;
  if (
    capabilityPlan === undefined ||
    !capabilityPlan.operation_dag.nodes.some(
      (node) => node.node_id === "execute" && node.subgraph === "strict_tdd",
    )
  ) {
    return;
  }
  const plan = ctx.plan ?? loadPlan(ctx);
  const designSet = ctx.designSet ?? loadAcceptedDesignSet(ctx);
  const acceptedPrd = acceptedPrdForOperation(ctx);
  if (plan === undefined || designSet === undefined || acceptedPrd === undefined) {
    throw new OrchestrationError(
      "binding_drift",
      "strict_tdd contract compilation requires accepted PRD, DesignSet and final Plan",
    );
  }
  ctx.plan = plan;
  ctx.designSet = designSet;
  const design = readDesignSetExtension(designSet);
  const graph = materializeProjectGraph(ctx.deps.projectRoot);
  try {
    const latestNode = new Map<string, NodeRecord>();
    for (const node of graph.nodes) {
      const current = latestNode.get(node.id);
      if (current === undefined || current.revision < node.revision) latestNode.set(node.id, node);
    }
    for (const task of plan.content.tasks) {
      const existing = loadTaskTddContract(ctx, task.id);
      if (existing !== undefined) {
        if (
          existing.capability_plan_digest !== capabilityPlan.record_digest ||
          existing.plan_digest !== plan.content.content_digest
        ) {
          throw new OrchestrationError(
            "binding_drift",
            `TaskTddContract for ${task.id} binds a superseded plan`,
          );
        }
        continue;
      }
      const testBindings = (task.assertions ?? []).flatMap((assertion) =>
        assertion.test_ids.map((testId) => {
          const test = latestNode.get(testId);
          const binding = test === undefined ? undefined : testSeedCriterionBinding(test);
          if (binding === undefined) {
            throw new OrchestrationError(
              "binding_drift",
              `strict_tdd assertion ${assertion.assertion_id} references Test ${testId} without accepted Criterion lineage`,
            );
          }
          return { assertion, testId, binding };
        }),
      );
      if (testBindings.length === 0) {
        throw new OrchestrationError(
          "binding_drift",
          `strict_tdd task ${task.id} has no accepted Test binding`,
        );
      }
      const strategyIds = new Set<string>();
      for (const entry of testBindings) {
        const coverage = design.content.coverage.find(
          (candidate) => candidate.requirement_id === entry.binding.verifies,
        );
        const strategy = coverage?.test_strategy_coverage.find(
          (candidate) =>
            candidate.acceptance_criterion_id === entry.binding.acceptance_criterion_id &&
            candidate.test_node_id === entry.testId,
        );
        if (strategy === undefined) {
          throw new OrchestrationError(
            "binding_drift",
            `accepted DesignSet does not assign a primary test strategy to ${entry.binding.acceptance_criterion_id}/${entry.testId}`,
          );
        }
        strategyIds.add(strategy.primary_test_strategy_id);
      }
      if (strategyIds.size !== 1) {
        throw new OrchestrationError(
          "binding_drift",
          `strict_tdd task ${task.id} spans ${String(strategyIds.size)} primary test strategies; Planner must keep one strategy per Task`,
        );
      }
      const strategyId = [...strategyIds][0] as string;
      const strategy = latestNode.get(strategyId);
      const artifact = strategy?.extensions?.["harness.design.artifact"] as
        | {
            readonly artifact_kind?: string;
            readonly body?: {
              readonly tdd?: readonly {
                readonly requirement_id: string;
                readonly applicability:
                  | {
                      readonly status: "required";
                      readonly baseline_guard_gates: readonly string[];
                      readonly target_gate: string;
                      readonly test_selectors: readonly string[];
                      readonly failure_oracle: string;
                      readonly path_policy: {
                        readonly test: readonly string[];
                        readonly test_config: readonly string[];
                        readonly production: readonly string[];
                        readonly immutable: readonly string[];
                      };
                      readonly framework_profile_digest: string;
                      readonly refactor_policy: string;
                    }
                  | {
                      readonly status: "not_applicable";
                      readonly category:
                        "documentation_only" | "research_only" | "non_executable_projection";
                      readonly reason: string;
                    };
              }[];
            };
          }
        | undefined;
      if (strategy === undefined || artifact?.artifact_kind !== "test_strategy") {
        throw new OrchestrationError(
          "binding_drift",
          `primary strategy ${strategyId} is not an accepted test_strategy asset`,
        );
      }
      const requirementIds = [...new Set(testBindings.map((entry) => entry.binding.verifies))];
      const applicability = artifact.body?.tdd?.find(
        (entry) => requirementIds.length === 1 && entry.requirement_id === requirementIds[0],
      )?.applicability;
      if (applicability === undefined) {
        throw new OrchestrationError(
          "binding_drift",
          `test strategy ${strategyId} has no unambiguous TDD applicability for task ${task.id}`,
        );
      }
      const base = {
        contract_id: `tdd-contract_${contentDigest({ task: task.id, plan: plan.content.content_digest }).slice(0, 16)}`,
        task_id: task.id,
        contract_mode: applicability.status,
        accepted_prd_digest: acceptedPrd.record_digest,
        requirement_baseline_digest: ctx.baselineDigest,
        impact_set_digest: plan.content.impact_set_digest,
        design_set_digest: design.content_digest,
        capability_plan_digest: capabilityPlan.record_digest,
        test_strategy_asset_id: strategyId,
        test_strategy_digest: strategy.digest,
        plan_digest: plan.content.content_digest,
        assertion_clusters:
          applicability.status === "required"
            ? [
                {
                  cluster_id: `tdd-cluster_${contentDigest({ task: task.id, strategy: strategyId }).slice(0, 16)}`,
                  logical_cycle_id: `tdd-cycle_${contentDigest({ task: task.id, assertions: testBindings.map((entry) => entry.assertion.assertion_id) }).slice(0, 16)}`,
                  requirement_ids: requirementIds,
                  acceptance_criterion_ids: [
                    ...new Set(testBindings.map((entry) => entry.binding.acceptance_criterion_id)),
                  ].sort(),
                  assertion_ids: [
                    ...new Set(testBindings.map((entry) => entry.assertion.assertion_id)),
                  ].sort(),
                  test_node_ids: [...new Set(testBindings.map((entry) => entry.testId))].sort(),
                  target_gate_id: applicability.target_gate,
                  target_test_selectors: [...applicability.test_selectors],
                  baseline_guard_gate_ids: [...applicability.baseline_guard_gates],
                  failure_oracle: {
                    selector_ids: [...applicability.test_selectors],
                    allowed_failure_kinds: ["assertion_failure" as const],
                    assertion_ids: [
                      ...new Set(testBindings.map((entry) => entry.assertion.assertion_id)),
                    ].sort(),
                    normalized_message_patterns: [applicability.failure_oracle],
                  },
                  path_policy: {
                    test: [...applicability.path_policy.test],
                    test_config: [...applicability.path_policy.test_config],
                    production: [...applicability.path_policy.production],
                    immutable: [...applicability.path_policy.immutable],
                  },
                  framework_profile_digest: applicability.framework_profile_digest,
                  refactor_policy:
                    applicability.refactor_policy === "planned" ? "planned" : "not_planned",
                },
              ]
            : [],
        ...(applicability.status === "not_applicable"
          ? {
              not_applicable_binding: {
                category: applicability.category,
                reason: applicability.reason,
              },
            }
          : {}),
        phase_budgets: {
          test_authoring: {
            max_runs: Math.max(1, task.budget.steps),
            max_duration_ms: 300_000,
            max_steps: Math.max(1, task.budget.steps),
            max_tokens: Math.max(1, task.budget.tokens),
          },
          implementation: {
            max_runs: Math.max(1, task.budget.steps),
            max_duration_ms: 300_000,
            max_steps: Math.max(1, task.budget.steps),
            max_tokens: Math.max(1, task.budget.tokens),
          },
        },
      } satisfies Omit<TaskTddContract, "contract_digest">;
      const contract: TaskTddContract = { ...base, contract_digest: contentDigest(base) };
      const validation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate(
        "task-tdd-contract",
        contract as unknown as Record<string, unknown>,
      );
      if (!validation.valid) {
        throw new OrchestrationError(
          "configuration",
          `compiled TaskTddContract for ${task.id} is invalid: ${validation.errors
            .map((issue) => issue.message)
            .join("; ")}`,
        );
      }
      await commitArtifacts(ctx.deps, ctx.workflowOperationId, currentAttemptId(ctx), [
        {
          path: taskTddContractArtifactPath(task.id),
          content: `${canonicalizeJson(contract)}\n`,
        },
      ]);
    }
  } finally {
    graph.close();
  }
}

async function phasePlan(ctx: PipelineContext, gateIds: readonly string[]): Promise<PhaseStep> {
  const { deps } = ctx;
  const capabilityPlan = ctx.capabilityPlan ?? deps.capabilityPlan;
  if (capabilityPlan !== undefined) {
    try {
      assertCapabilityPlanFinal(capabilityPlan);
    } catch (error) {
      throw new OrchestrationError(
        "binding_drift",
        error instanceof Error ? error.message : "CapabilityPlan is not final",
      );
    }
  }
  const existing = loadPlan(ctx);
  const migrationBlockers = ctx.workingState.blockers.filter((blocker) =>
    blocker.startsWith("migration required:"),
  );
  if (existing !== undefined) {
    ctx.plan = existing;
    await compileTaskTddContracts(ctx);
    await ctx.engine.commitCheckpoint(ctx.workflowOperationId, {
      boundary: PHASE_CHECKPOINT_BOUNDARY.plan,
      proposal: {
        phase: "context",
        ...(migrationBlockers.length === 0 ? {} : { clear_blockers: migrationBlockers }),
      },
    });
    refreshWorkingState(ctx);
    return { continue: true };
  }
  const frozenImpactSet = ctx.impactSet ?? loadFrozenImpactSet(ctx);
  if (ctx.modules.design !== undefined) {
    // design_governance is active for this operation: plan compiles only from
    // an accepted DesignSet, never from a proposal or a wish (designset
    // lifecycle design 5.2 — no accepted DesignSet, no Plan).
    const designSet = ctx.designSet ?? loadAcceptedDesignSet(ctx);
    if (designSet === undefined) {
      throw new OrchestrationError(
        "binding_drift",
        "plan phase requires an accepted DesignSet while design_governance is active",
      );
    }
    ctx.designSet = designSet;
  }
  const kernelDerived = frozenImpactSet === undefined;
  const impactSet = frozenImpactSet ?? deriveKernelImpactSet(ctx);
  ctx.impactSet = impactSet;
  const specifications = await taskSpecificationsFor(ctx, impactSet, gateIds);
  const executionBinding = executionBindingFor(deps);
  const forecastPaths = [
    ...new Set(
      specifications.flatMap((task) => deps.taskEnvelopeScope?.(task).proposed_write_paths ?? []),
    ),
  ]
    .map(normalizeRepoRelativePath)
    .sort()
    .map((pattern) => ({ pattern, scope: "bounded" as const, approved: true }));
  const planInput = {
    executionKind: executionBinding.kind,
    intentShape: ctx.intentShape,
    hasExistingGraph: true,
    deterministicWork: ctx.deterministicWork,
    shared: {
      goal: ctx.goal,
      requirement_baseline_digest: ctx.baselineDigest,
      policy_digest: ctx.workingState.policy_digest,
    },
    proposal: specifications.map(
      (specification) => specification as unknown as Record<string, unknown>,
    ),
    constraints: { allowedCapabilities: [], knownTools: [], knownGates: gateIds },
    ...(executionBinding.adapter_profile === undefined && forecastPaths.length === 0
      ? {}
      : {
          governance: {
            forecastPaths,
            ...(executionBinding.adapter_profile === undefined
              ? {}
              : { adapterProfile: executionBinding.adapter_profile }),
          },
        }),
  };
  const planContext = {
    iterationId: ctx.iterationId,
    actor: "workflow-engine",
    timestamp: nowOf(deps),
  };
  const records = kernelDerived
    ? generateKernelExecutionPlan(impactSet, planInput, planContext)
    : generateExecutionPlan(
        impactSet,
        readImpactSetContent(impactSet).content_digest,
        planInput,
        planContext,
      );
  await commitArtifacts(
    deps,
    ctx.workflowOperationId,
    currentAttemptId(ctx),
    [
      {
        path: `artifacts/plans/${records.plan.id}.json`,
        content: `${canonicalizeJson(records.plan)}\n`,
      },
      ...records.tasks.map((task) => ({
        path: `artifacts/tasks/${task.id}.json`,
        content: `${canonicalizeJson(task)}\n`,
      })),
    ],
    [...records.edges, ...implementsEdgesFor(ctx, specifications, records.tasks)],
  );
  ctx.plan = { node: records.plan, content: readExecutionPlanContent(records.plan) };
  await compileTaskTddContracts(ctx);
  await ctx.engine.commitCheckpoint(ctx.workflowOperationId, {
    boundary: PHASE_CHECKPOINT_BOUNDARY.plan,
    proposal: {
      phase: "context",
      ...(migrationBlockers.length === 0 ? {} : { clear_blockers: migrationBlockers }),
    },
    events: phaseLifecycleEvents({
      phase: "plan",
      planId: records.plan.id,
      mode: ctx.plan.content.mode,
      tasks: records.tasks.length,
    }),
  });
  refreshWorkingState(ctx);
  return { continue: true };
}
async function phaseContext(ctx: PipelineContext): Promise<PhaseStep> {
  const { deps } = ctx;
  const plan = ctx.plan ?? loadPlan(ctx);
  if (plan === undefined) {
    throw new OrchestrationError("binding_drift", "context phase requires a committed plan");
  }
  ctx.plan = plan;
  const stored = loadBundleRecords(ctx);
  if (plan.content.tasks.every((task) => stored.has(task.id))) {
    ctx.bundles = stored;
    await ctx.engine.commitCheckpoint(ctx.workflowOperationId, {
      boundary: PHASE_CHECKPOINT_BOUNDARY.context,
      proposal: { phase: "execute" },
    });
    refreshWorkingState(ctx);
    return { continue: true };
  }
  const graph = materializeProjectGraph(deps.projectRoot);
  const compiled = new Map<string, CompiledContextBundle>();
  try {
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const task of plan.content.tasks) {
      const candidatesById = new Map<string, ContextCandidate>();
      const addCandidate = (
        nodeId: string,
        tier: ContextCandidate["tier"],
        reason: string,
      ): void => {
        const node = nodeById.get(nodeId);
        if (node === undefined) return;
        const existing = candidatesById.get(nodeId);
        if (existing !== undefined && existing.tier <= tier) return;
        candidatesById.set(nodeId, {
          node,
          content: canonicalizeJson(node),
          tier,
          reason,
        });
      };
      addCandidate(ctx.proposal.intent.id, 1, "approved intent for this iteration");
      for (const output of task.expected_outputs) {
        addCandidate(output, 1, `expected output of ${task.id}`);
      }
      for (const assertion of task.assertions ?? []) {
        for (const testId of assertion.test_ids) {
          addCandidate(testId, 1, `accepted test for ${assertion.assertion_id}`);
        }
      }
      addCandidate(plan.node.id, 2, "owning execution plan");
      addCandidate(task.id, 2, "owning task specification");
      // design_governance active: the accepted DesignSet and its assets join
      // the bundle as digest-bound candidates (designset design 13.2).
      let designSetDigest: string | undefined;
      if (ctx.modules.design !== undefined) {
        const designSet = ctx.designSet ?? loadAcceptedDesignSet(ctx);
        if (designSet === undefined) {
          throw new OrchestrationError(
            "binding_drift",
            "context phase requires an accepted DesignSet while design_governance is active",
          );
        }
        ctx.designSet = designSet;
        const extension = readDesignSetExtension(designSet);
        designSetDigest = extension.content_digest;
        addCandidate(designSet.id, 2, "accepted design set");
        for (const binding of extension.bindings.nodes) {
          addCandidate(binding.node_id, 3, `asset of accepted design set ${designSet.id}`);
        }
      }
      for (const selection of selectTaskNeighborhood(task, graph.nodes, graph.edges)) {
        addCandidate(selection.nodeId, 3, selection.reason);
      }
      compiled.set(
        task.id,
        compileContextBundle({
          taskId: task.id,
          goal: ctx.goal,
          bindings: {
            requirement_baseline_digest: ctx.baselineDigest,
            policy_digest: ctx.workingState.policy_digest,
            plan_digest: plan.content.content_digest,
            impact_coverage_digest: plan.content.impact_coverage.digest,
            task_digest: contentDigest(task),
            approval_digests: ctx.workingState.approval_digests,
            ...(designSetDigest === undefined ? {} : { design_set_digest: designSetDigest }),
          },
          tokenBudget: deps.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
          candidates: [...candidatesById.values()],
        }),
      );
    }
  } finally {
    graph.close();
  }
  const orderedCompiled = [...compiled.values()].sort((left, right) =>
    left.record.task_id.localeCompare(right.record.task_id),
  );
  await commitArtifacts(
    deps,
    ctx.workflowOperationId,
    currentAttemptId(ctx),
    orderedCompiled.map((bundle) => ({
      path: `artifacts/context-bundles/${bundle.record.context_bundle_id}.json`,
      content: `${canonicalizeJson(bundle.record)}\n`,
    })),
  );
  ctx.bundles = new Map(orderedCompiled.map((bundle) => [bundle.record.task_id, bundle.record]));
  // PG-6: with an enrichment port configured, every committed bundle is
  // interpreted once — cited, digest-bound and persisted beside it. The
  // bundle itself never changes; a failed enrichment blocks the phase
  // without touching the committed bundles.
  if (deps.contextEnrichment !== undefined) {
    const enrichments: { readonly path: string; readonly content: string }[] = [];
    for (const bundle of orderedCompiled) {
      const outcome = await enrichContextBundle({
        port: deps.contextEnrichment,
        bundleRecord: bundle.record,
        conversation_id: `context-enrichment-conversation_${ctx.workflowOperationId.replace(/^[a-z][a-z0-9-]*_/u, "")}_${bundle.record.task_id.replace(/^[a-z][a-z0-9-]*_/u, "")}`,
        run_id: `context-enrichment-run_${currentAttemptId(ctx)}_${bundle.record.task_id.replace(/^[a-z][a-z0-9-]*_/u, "")}`,
      });
      if (outcome.status === "failed") {
        await ctx.engine.block(ctx.workflowOperationId, {
          reason: outcome.failure.retryable ? "transient_environment_failure" : "missing_input",
          detail: `context enrichment failed for ${bundle.record.context_bundle_id}: ${outcome.failure.summary}`,
          proposal: {
            phase: "context",
            set_next_action: resumeCommandFor(ctx.workflowOperationId),
          },
        });
        refreshWorkingState(ctx);
        return {
          continue: false,
          outcome: {
            status: "blocked",
            workflowOperationId: ctx.workflowOperationId,
            iterationId: ctx.iterationId,
            reason: outcome.failure.retryable ? "transient_environment_failure" : "missing_input",
            detail: `context enrichment failed for ${bundle.record.context_bundle_id}: ${outcome.failure.summary}`,
            resumeCommand: resumeCommandFor(ctx.workflowOperationId),
          },
        };
      }
      const path = `artifacts/context-enrichments/${outcome.record.grounded_synthesis_id}.json`;
      if (!artifactExists(deps, path)) {
        enrichments.push({ path, content: `${canonicalizeJson(outcome.record)}\n` });
      }
    }
    if (enrichments.length > 0) {
      await commitArtifacts(deps, ctx.workflowOperationId, currentAttemptId(ctx), enrichments);
    }
  }
  const digestByTask = Object.fromEntries(
    orderedCompiled.map((bundle) => [bundle.record.task_id, bundle.record.digest]),
  );
  const lastBundle = orderedCompiled.at(-1);
  await ctx.engine.commitCheckpoint(ctx.workflowOperationId, {
    boundary: PHASE_CHECKPOINT_BOUNDARY.context,
    proposal: {
      phase: "execute",
      set_context_bundle_digests: digestByTask,
      ...(lastBundle === undefined ? {} : { set_context_bundle_digest: lastBundle.record.digest }),
    },
    events: orderedCompiled.flatMap((bundle) =>
      phaseLifecycleEvents({
        phase: "context",
        contextBundleId: bundle.record.context_bundle_id,
        contextBundleDigest: bundle.record.digest,
        includedTokens: bundle.manifest.included_tokens,
      }),
    ),
  });
  refreshWorkingState(ctx);
  return { continue: true };
}
interface PlanExecutionAuthority {
  readonly authorization: ExecutionAuthorizationRecord;
  readonly grants: ReadonlyMap<string, CapabilityGrantRecord>;
}
function authorizationArtifactPath(authorizationId: string): string {
  return `artifacts/execution-authorizations/${authorizationId}.json`;
}
function grantRecordArtifactPath(grantRecordId: string): string {
  return `artifacts/capability-grants/${grantRecordId}.json`;
}
async function authorizePlanExecution(
  ctx: PipelineContext,
  plan: { readonly node: NodeRecord; readonly content: ExecutionPlanContent },
  tasks: readonly TaskSpecification[],
  binding: ExecutionBinding,
): Promise<
  | { readonly status: "authorized"; readonly authority: PlanExecutionAuthority }
  | { readonly status: "required"; readonly required: ApprovalRequiredOutcome }
  | { readonly status: "rejected" }
> {
  const profile = binding.adapter_profile;
  const adapterProfileDigest = profile === undefined ? undefined : contentDigest(profile);
  const policy = effectivePolicy();
  const grants = tasks.map((task) => {
    const bundle = ctx.bundles.get(task.id);
    if (bundle === undefined) {
      throw new ExecutionPreflightError(
        "missing_binding",
        `task ${task.id} has no committed context bundle`,
      );
    }
    const scope = ctx.deps.taskEnvelopeScope?.(task) ?? {
      allowed_read_paths: [],
      proposed_write_paths: [],
    };
    const approvalDigests = readContextBundleManifest(bundle).bindings.approval_digests;
    const spec = createCapabilityGrantSpec(
      {
        grant_id: `grant_${contentDigest({ task: task.id, iteration: ctx.iterationId }).slice(0, 16)}`,
        task_id: task.id,
        capabilities: task.capabilities,
        read_paths: scope.allowed_read_paths,
        write_paths: scope.proposed_write_paths,
        tools: task.tools.map((name) => ({ name })),
        phase: "execute",
        budget: task.budget,
        approval_digests: approvalDigests,
      },
      policy,
      {
        planDigest: plan.content.content_digest,
        contextBundleDigest: bundle.digest,
        ...(adapterProfileDigest === undefined ? {} : { adapterProfileDigest }),
        baselineCommit: ctx.workingState.baseline_commit,
      },
    );
    return { task, bundle, scope, spec };
  });
  const opaqueDelegated =
    binding.kind === "agent" &&
    (profile === undefined ||
      profile.control === "manual" ||
      (profile.control === "delegated" &&
        (!profile.usage_metering ||
          !profile.side_effect_interception ||
          profile.trajectory_visibility === "external-only")));
  const authorizationId = `authorization_${plan.content.content_digest.slice(0, 16)}`;
  // design_governance active: the accepted DesignSet digest joins the
  // execution authorization and every bundle binding check (T14).
  let designSetDigest: string | undefined;
  if (ctx.modules.design !== undefined) {
    const designSet = ctx.designSet ?? loadAcceptedDesignSet(ctx);
    if (designSet === undefined) {
      throw new OrchestrationError(
        "binding_drift",
        "execution preflight requires an accepted DesignSet while design_governance is active",
      );
    }
    ctx.designSet = designSet;
    designSetDigest = readDesignSetExtension(designSet).content_digest;
  }
  const prepared = prepareExecutionPreflight({
    authorizationId,
    iterationId: ctx.iterationId,
    planDigest: plan.content.content_digest,
    tasks: grants.map(({ task }) => ({
      taskId: task.id,
      taskDigest: contentDigest(task),
      risk: task.risk,
    })),
    // The plan pins the impact-set digest at mint time; later phases read the
    // pin instead of re-deriving from a graph the iteration itself has grown.
    impactSetDigest: plan.content.impact_set_digest,
    impactCoverageDigest: plan.content.impact_coverage.digest,
    impactCoverageStatus: plan.content.impact_coverage.status,
    bundles: grants.map(({ bundle }) => bundle),
    grantSpecs: grants.map(({ spec }) => spec),
    policyDigest: policy.digest,
    ...(adapterProfileDigest === undefined ? {} : { adapterProfileDigest }),
    ...(designSetDigest === undefined ? {} : { designSetDigest }),
    baselineCommit: ctx.workingState.baseline_commit,
    requiresWrite: grants.some(({ scope }) => scope.proposed_write_paths.length > 0),
    opaqueDelegated,
  });

  const authorizationPath = authorizationArtifactPath(authorizationId);
  const storedAuthorization = readJsonArtifact<ExecutionAuthorizationRecord>(
    ctx.deps,
    authorizationPath,
  );
  if (
    storedAuthorization !== undefined &&
    storedAuthorization.extensions["harness.authorization"].spec_digest ===
      prepared.authorizationSpec.spec_digest
  ) {
    const storedGrants = new Map<string, CapabilityGrantRecord>();
    for (const { task, spec } of grants) {
      const recordId = `grantrecord_${spec.spec_digest.slice(0, 16)}`;
      const record = readJsonArtifact<CapabilityGrantRecord>(
        ctx.deps,
        grantRecordArtifactPath(recordId),
      );
      if (
        record === undefined ||
        record.spec.spec_digest !== spec.spec_digest ||
        record.authorization_digest !== storedAuthorization.digest
      ) {
        throw new ExecutionPreflightError(
          "binding_drift",
          `stored grant record for ${task.id} does not match its authorization`,
        );
      }
      storedGrants.set(task.id, record);
    }
    return {
      status: "authorized",
      authority: { authorization: storedAuthorization, grants: storedGrants },
    };
  }

  let approvalDigest: string;
  if (binding.kind === "agent") {
    const approval = await ensureApproval(ctx, {
      objectId: authorizationId,
      objectType: "ExecutionAuthorizationSpec",
      objectDigest: prepared.authorizationSpec.spec_digest,
      risk: prepared.authorizationSpec.effective_risk,
      reason: `authorize ${String(tasks.length)} task(s) for ${binding.name}`,
      resumePhase: "execute",
    });
    if (approval.status !== "approved") return approval;
    approvalDigest = approval.approvalDigest;
  } else {
    approvalDigest = contentDigest({
      authority: "harness-control-plane",
      authorization_spec_digest: prepared.authorizationSpec.spec_digest,
    });
  }
  const authorization = buildExecutionAuthorizationRecord(
    prepared.authorizationSpec,
    approvalDigest,
    prepared.supervised,
  );
  const grantRecords = new Map<string, CapabilityGrantRecord>();
  for (const { task, spec } of grants) {
    const record = bindCapabilityGrantAuthorization(spec, {
      grantRecordId: `grantrecord_${spec.spec_digest.slice(0, 16)}`,
      iterationId: ctx.iterationId,
      authorizationDigest: authorization.digest,
      issuedAt: nowOf(ctx.deps),
    });
    grantRecords.set(task.id, record);
  }
  await commitArtifacts(ctx.deps, ctx.workflowOperationId, currentAttemptId(ctx), [
    { path: authorizationPath, content: `${canonicalizeJson(authorization)}\n` },
    ...[...grantRecords.values()].map((record) => ({
      path: grantRecordArtifactPath(record.grant_record_id),
      content: `${canonicalizeJson(record)}\n`,
    })),
  ]);
  return {
    status: "authorized",
    authority: { authorization, grants: grantRecords },
  };
}
function buildEnvelope(
  ctx: PipelineContext,
  task: TaskSpecification,
  grantRecord: CapabilityGrantRecord,
  authorization: ExecutionAuthorizationRecord,
): {
  readonly envelope: TaskEnvelope;
  readonly grantDigest: string;
} {
  const plan = ctx.plan;
  const bundle = ctx.bundles.get(task.id);
  if (plan === undefined || bundle === undefined) {
    throw new OrchestrationError(
      "binding_drift",
      "execute phase requires a plan and a context bundle",
    );
  }
  try {
    assertTaskBundleBinding(bundle, {
      taskId: task.id,
      taskDigest: contentDigest(task),
      planDigest: plan.content.content_digest,
      impactCoverageDigest: plan.content.impact_coverage.digest,
      ...(ctx.modules.design === undefined || ctx.designSet === undefined
        ? {}
        : { designSetDigest: readDesignSetExtension(ctx.designSet).content_digest }),
    });
  } catch (error) {
    if (error instanceof TaskBundleBindingError) {
      throw new OrchestrationError("binding_drift", error.message);
    }
    throw error;
  }
  const policy = effectivePolicy();
  const loopPolicy = resolveLoopPolicy(policy);
  const grant = grantRecord.spec;
  const envelope = buildTaskEnvelope({
    task_id: task.id,
    plan_id: plan.node.id,
    iteration_id: ctx.iterationId,
    repository_id: readManagedManifest(ctx.deps.projectRoot).repository_id,
    baseline_id: `baseline_${ctx.workingState.baseline_commit.slice(0, 12)}`,
    objective: task.objective,
    expected_output: task.expected_outputs.join(", "),
    acceptance_criteria: task.acceptance.map((criterion) => criterion.description),
    dependency_task_ids: [...task.dependencies],
    required_gate_ids: [...task.required_gates],
    input_node_revisions: { [ctx.proposal.intent.id]: 1 },
    context_bundle_id: bundle.context_bundle_id,
    context_bundle_digest: bundle.digest,
    protected_context_fields: [],
    allowed_read_paths: grant.read_paths,
    proposed_write_paths: grant.write_paths,
    state_read_fields: [],
    state_proposal_fields: [],
    tools: grant.tools,
    risk: task.risk,
    required_approval_digests: [
      ...new Set([...grant.approval_digests, authorization.approval_digest]),
    ].sort(),
    external_side_effect: "forbidden",
    idempotency_scope: `iteration/${ctx.iterationId}/task/${task.id}`,
    loop_policy: loopPolicy,
    baseline_commit: ctx.workingState.baseline_commit,
    input_digest: bundle.digest,
    stale_input_behavior: "recompile",
  });
  return { envelope, grantDigest: grantRecord.digest };
}
/**
 * Persist a strict TaskVerdict and project it onto the Task node. Only a
 * passed verdict promotes the Task to accepted; a Run completion claim alone
 * never does. Run-to-gate Evidence edges complete the machine-checkable proof
 * path without rewriting the immutable Run fact.
 */
async function commitTaskVerdict(ctx: PipelineContext, verdict: TaskVerdictRecord): Promise<void> {
  const { deps } = ctx;
  const taskId = verdict.task_id;
  const graph = materializeProjectGraph(deps.projectRoot);
  let current: NodeRecord | undefined;
  let activeEdgeIds: Set<string>;
  try {
    current = graph.nodes
      .filter((node) => node.id === taskId && node.type === "Task")
      .sort((left, right) => left.revision - right.revision)
      .at(-1);
    activeEdgeIds = new Set(
      graph.edges
        .filter((edge) => edge.status === "proposed" || edge.status === "accepted")
        .map((edge) => edge.id),
    );
  } finally {
    graph.close();
  }
  if (current === undefined) {
    throw new OrchestrationError("binding_drift", `TaskVerdict targets unknown task ${taskId}`);
  }
  const currentVerdict = current.extensions?.["harness.task-verdict"];
  const targetStatus = verdict.verdict === "passed" ? "accepted" : "proposed";
  const alreadyProjected =
    current.status === targetStatus &&
    typeof currentVerdict === "object" &&
    currentVerdict !== null &&
    (currentVerdict as Record<string, unknown>)["digest"] === verdict.digest;
  const revision = current.revision + 1;
  const base: Record<string, unknown> = Object.fromEntries(
    Object.entries(current).filter(([key]) => key !== "digest"),
  );
  base.revision = revision;
  base.status = targetStatus;
  base.provenance = {
    iteration_id: ctx.iterationId,
    actor: "workflow-engine",
    timestamp: nowOf(deps),
  };
  base.extensions = {
    ...(current.extensions ?? {}),
    "harness.task-verdict": {
      verdict_id: verdict.verdict_id,
      digest: verdict.digest,
      verdict: verdict.verdict,
      run_ids: verdict.run_ids,
      assertion_verdicts: verdict.assertion_verdicts,
      gate_evidence_ids: verdict.gate_evidence_ids,
      evaluation_evidence_ids: verdict.evaluation_evidence_ids,
    },
  };
  const node = { ...base, digest: contentDigest(base) };
  const validation = validateSchema("node", node);
  if (!validation.valid) {
    throw new OrchestrationError(
      "configuration",
      `invalid accepted task node: ${validation.errors
        .map((issue) => `${issue.instancePath}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const artifacts: { readonly path: string; readonly content: string }[] = [];
  if (!artifactExists(deps, `artifacts/task-verdicts/${verdict.verdict_id}.json`)) {
    artifacts.push({
      path: `artifacts/task-verdicts/${verdict.verdict_id}.json`,
      content: `${canonicalizeJson(verdict)}\n`,
    });
  }
  if (!alreadyProjected) {
    artifacts.push({
      path: `artifacts/tasks/${taskId}/${String(revision)}.json`,
      content: `${canonicalizeJson(node)}\n`,
    });
  }
  const edges: EdgeRecord[] = [];
  for (const runId of verdict.run_ids) {
    for (const evidenceId of verdict.gate_evidence_ids) {
      const id = `edge_${contentDigest({ type: "PRODUCES", source: runId, target: evidenceId }).slice(0, 16)}`;
      if (activeEdgeIds.has(id)) continue;
      const content: Record<string, unknown> = {
        protocol_version: PROTOCOL_VERSION,
        record_kind: "edge",
        id,
        type: "PRODUCES",
        source_id: runId,
        target_id: evidenceId,
        status: "accepted",
        source: "workflow",
        provenance: {
          iteration_id: ctx.iterationId,
          run_id: runId,
          actor: "workflow-engine",
          timestamp: nowOf(deps),
        },
        confidence: 1,
      };
      const edge = { ...content, digest: contentDigest(content) };
      const validation = validateSchema("edge", edge);
      if (!validation.valid) {
        throw new OrchestrationError(
          "configuration",
          `invalid TaskVerdict evidence edge: ${validation.errors.map((issue) => issue.message).join("; ")}`,
        );
      }
      edges.push(edge as unknown as EdgeRecord);
      activeEdgeIds.add(id);
    }
  }
  if (artifacts.length > 0 || edges.length > 0) {
    await commitArtifacts(deps, ctx.workflowOperationId, currentAttemptId(ctx), artifacts, edges);
  }
}
async function phaseExecute(ctx: PipelineContext): Promise<PhaseStep> {
  const { deps } = ctx;
  const plan = ctx.plan ?? loadPlan(ctx);
  if (plan === undefined)
    throw new OrchestrationError("binding_drift", "execute phase requires a plan");
  ctx.plan = plan;
  if (ctx.bundles.size === 0) ctx.bundles = loadBundleRecords(ctx);
  const tasks = orderedPlanTasks(plan.content.tasks);
  if (tasks.length === 0) throw new OrchestrationError("configuration", "plan carries no tasks");

  const migrationInput = {
    workflow_operation_id: ctx.workflowOperationId,
    iteration_id: ctx.iterationId,
    plan: plan.content,
    contexts: [...ctx.bundles.values()],
    authorization_records: readJsonDirectory(deps, "artifacts/execution-authorizations"),
    grant_records: readJsonDirectory(deps, "artifacts/capability-grants"),
    relied_grant_digests: ctx.workingState.capability_grants,
  };
  const migration = assessOpenIterationMigration(migrationInput);
  if (migration.required) {
    const path = migrationArtifactPath(ctx.workflowOperationId);
    const migrationArtifacts = artifactExists(deps, path)
      ? []
      : [
          {
            path,
            content: `${canonicalizeJson(
              buildOpenIterationMigrationRecord(migrationInput, migration, nowOf(deps)),
            )}\n`,
          },
        ];
    const detail = `migration required: ${migration.reasons.join(", ")}`;
    await ctx.engine.block(ctx.workflowOperationId, {
      reason: "missing_input",
      detail,
      artifacts: migrationArtifacts,
      proposal: {
        phase: migration.resume_phase,
        set_next_action: resumeCommandFor(ctx.workflowOperationId),
      },
    });
    refreshWorkingState(ctx);
    return {
      continue: false,
      outcome: {
        status: "migration_required",
        workflowOperationId: ctx.workflowOperationId,
        iterationId: ctx.iterationId,
        reasons: migration.reasons,
        resumePhase: migration.resume_phase,
        resumeCommand: resumeCommandFor(ctx.workflowOperationId),
      },
    };
  }

  // One run per task, in dependency order. A claimed run is final (unless its
  // committed evaluation failed), so a resume re-executes only the tasks that
  // never finished; the phase checkpoint lands once every task has one.
  const binding = executionBindingFor(deps);
  try {
    assertExecutionBindingCompatible(plan.content, binding);
  } catch (error) {
    if (error instanceof ExecutionBindingError) {
      throw new OrchestrationError("binding_drift", error.message);
    }
    throw error;
  }
  const executor = binding.execute;
  let authority: PlanExecutionAuthority;
  try {
    const authorization = await authorizePlanExecution(ctx, plan, tasks, binding);
    if (authorization.status === "required") {
      return {
        continue: false,
        outcome: { status: "approval_required", required: authorization.required },
      };
    }
    if (authorization.status === "rejected") {
      return {
        continue: false,
        outcome: await rejectOperation(ctx, "execution authorization rejected"),
      };
    }
    authority = authorization.authority;
  } catch (error) {
    if (error instanceof ExecutionPreflightError && error.kind === "impact_coverage_incomplete") {
      await ctx.engine.block(ctx.workflowOperationId, {
        reason: "missing_input",
        detail: error.message,
        proposal: { phase: "impact", set_next_action: resumeCommandFor(ctx.workflowOperationId) },
      });
      refreshWorkingState(ctx);
      return {
        continue: false,
        outcome: {
          status: "blocked",
          workflowOperationId: ctx.workflowOperationId,
          iterationId: ctx.iterationId,
          reason: "missing_input",
          detail: error.message,
          resumeCommand: resumeCommandFor(ctx.workflowOperationId),
        },
      };
    }
    if (error instanceof ExecutionPreflightError) {
      throw new OrchestrationError("binding_drift", error.message);
    }
    throw error;
  }
  const grantDigests = [...authority.grants.values()].map((grant) => grant.digest).sort();
  const strictTddEnabled = ctx.capabilityPlan?.operation_dag.nodes.some(
    (node) => node.node_id === "execute" && node.subgraph === "strict_tdd",
  );
  let lastRun: { readonly runId: string; readonly result: AgentRunResult } | undefined;
  for (const task of tasks) {
    const tddContract = strictTddEnabled === true ? loadTaskTddContract(ctx, task.id) : undefined;
    if (strictTddEnabled === true && tddContract === undefined) {
      throw new OrchestrationError(
        "binding_drift",
        `strict_tdd Task ${task.id} has no accepted TaskTddContract`,
      );
    }
    const requiredTdd = tddContract?.contract_mode === "required";
    const currentTddCycleCompleted =
      requiredTdd !== true ||
      readJsonDirectory(ctx.deps, "artifacts/tdd-cycles").some(
        (candidate) =>
          typeof candidate === "object" &&
          candidate !== null &&
          (candidate as Partial<TddCycleRecord>).task_id === task.id &&
          (candidate as Partial<TddCycleRecord>).contract_digest === tddContract.contract_digest &&
          (candidate as Partial<TddCycleRecord>).status === "completed",
      );
    const completed = loadCompletedRun(ctx, task.id);
    if (completed !== undefined && completed.result.completion_claimed) {
      // A claimed run whose committed evaluation failed must be re-executed
      // (the evaluation phase blocked back into execute); any other claimed
      // run is final and the task is a no-op on re-entry.
      const completedDigest = sha256Hex(canonicalizeJson(completed.result));
      const failedEvaluation = loadEvaluateArtifacts(deps, ctx.iterationId).some(
        (artifact) => artifact.run_digest === completedDigest && !artifact.result.passed,
      );
      if (!failedEvaluation && currentTddCycleCompleted) {
        await commitRunFact(ctx, completed.runId, completed.result);
        lastRun = completed;
        continue;
      }
    }

    const grantRecord = authority.grants.get(task.id);
    if (grantRecord === undefined) {
      throw new OrchestrationError("binding_drift", `task ${task.id} has no authorized grant`);
    }
    const built = buildEnvelope(ctx, task, grantRecord, authority.authorization);
    const envelope = built.envelope;
    ctx.envelope = envelope;
    let beforeDiff: DiffSummary | undefined;
    // A run left open by an interrupted process was reconciled by resume into
    // exactly one successor run; attach to it instead of opening a duplicate.
    const runId = loadOpenRunId(ctx, task.id);
    let activeRunId: string;
    if (runId !== undefined) {
      activeRunId = runId;
    } else {
      const started = await ctx.engine.startRun(ctx.workflowOperationId, {
        taskId: task.id,
        contextBundleId: envelope.context_bundle_id,
        contextBundleDigest: envelope.context_bundle_digest,
        grantRecordDigest: grantRecord.digest,
        authorizationDigest: authority.authorization.digest,
        ...(authority.authorization.adapter_profile_digest === undefined
          ? {}
          : { adapterProfileDigest: authority.authorization.adapter_profile_digest }),
      });
      activeRunId = started.run_id;
    }
    await commitRunNode(ctx, activeRunId, task.id);
    if (deps.vcs !== undefined) {
      const observed = await deps.vcs.diffSummary(
        deps.projectRoot,
        ctx.workingState.baseline_commit,
      );
      if (!observed.ok) {
        throw new OrchestrationError(
          "configuration",
          `pre-run VCS inspection failed: ${observed.error.message}`,
        );
      }
      beforeDiff = observed.value;
    }
    observe(ctx, () =>
      ctx.observations.runStarted(activeRunId, {
        task_id: task.id,
        executor: requiredTdd ? "strict-tdd-controller" : binding.name,
        ...(binding.adapter_profile === undefined
          ? {}
          : { adapter_control_profile: binding.adapter_profile }),
        ...(authority.authorization.adapter_profile_digest === undefined
          ? {}
          : { adapter_profile_digest: authority.authorization.adapter_profile_digest }),
        budget_observations: [
          {
            dimension: "steps",
            availability: "unavailable",
            used: null,
            limit: envelope.loop_policy.max_steps,
            enforcement: "none",
          },
          {
            dimension: "tokens",
            availability: "unavailable",
            used: null,
            limit: envelope.loop_policy.max_tokens,
            enforcement: "none",
          },
          {
            dimension: "duration_ms",
            availability: "measured",
            used: 0,
            limit: envelope.loop_policy.max_duration_ms,
            enforcement: "harness",
          },
        ],
      }),
    );
    observe(ctx, () => ctx.observations.runHeartbeat(activeRunId, { task_id: task.id }));
    const heartbeat = setInterval(() => {
      observe(ctx, () => ctx.observations.runHeartbeat(activeRunId, { task_id: task.id }));
    }, 5_000);
    heartbeat.unref();
    // A throw here is a process-level crash: no terminal record is written and
    // resume reconciles the open run. Typed failures come back as results.
    let result: AgentRunResult;
    let strictTddBlockedReason: string | undefined;
    let observedOutput = false;
    try {
      if (requiredTdd) {
        if (deps.strictTdd === undefined || ctx.capabilityPlan === undefined) {
          throw new OrchestrationError(
            "configuration",
            "strict_tdd required Task has no StrictTddExecutionPort",
          );
        }
        const executed = await executeRequiredTddTask({
          port: deps.strictTdd,
          task,
          contract: tddContract,
          capabilityPlanDigest: ctx.capabilityPlan.record_digest,
        });
        const newArtifacts = executed.artifacts.filter(
          (artifact) => !artifactExists(deps, artifact.path),
        );
        if (newArtifacts.length > 0) {
          await commitArtifacts(deps, ctx.workflowOperationId, currentAttemptId(ctx), newArtifacts);
          // TDD cycle/evidence/grant files are Harness-owned control-plane
          // writes. Refresh the VCS observation after their Ledger commit so
          // the Agent write-set attestation compares only work performed by
          // the task, never the authority records that unlocked it.
          if (deps.vcs !== undefined && beforeDiff !== undefined) {
            const observed = await deps.vcs.diffSummary(
              deps.projectRoot,
              ctx.workingState.baseline_commit,
            );
            if (!observed.ok) {
              throw new OrchestrationError(
                "configuration",
                `post-TDD-evidence VCS inspection failed: ${observed.error.message}`,
              );
            }
            beforeDiff = observed.value;
          }
        }
        result = executed.result;
        if (executed.outcome.status === "blocked") {
          strictTddBlockedReason = executed.outcome.reason;
        }
      } else {
        result = await executor(envelope as AgentTaskEnvelope, {
          onOutput: (output) => {
            observedOutput = true;
            observe(ctx, () =>
              ctx.observations.runOutput(activeRunId, output.chunk, { stream: output.stream }),
            );
          },
        });
      }
    } finally {
      clearInterval(heartbeat);
    }
    result = {
      ...result,
      budget_observations: observeAgentBudget({
        budget: envelope.loop_policy,
        usage: result.usage,
        ...(binding.adapter_profile === undefined ? {} : { profile: binding.adapter_profile }),
      }),
    };
    let actualChanges: ReturnType<typeof deriveActualRunChanges> | undefined;
    if (deps.vcs !== undefined && beforeDiff !== undefined) {
      const observed = await deps.vcs.diffSummary(
        deps.projectRoot,
        ctx.workingState.baseline_commit,
      );
      if (!observed.ok) {
        throw new OrchestrationError(
          "configuration",
          `post-run VCS inspection failed: ${observed.error.message}`,
        );
      }
      actualChanges = deriveActualRunChanges(
        beforeDiff,
        observed.value,
        grantRecord.spec.write_paths,
      );
      const undeclaredWrites = [
        ...new Set([...result.undeclared_writes, ...actualChanges.undeclared_writes]),
      ].sort();
      const diffDigest = contentDigest({
        before: beforeDiff,
        after: observed.value,
        actual: actualChanges,
      });
      result = {
        ...result,
        ...(undeclaredWrites.length === 0
          ? {}
          : {
              outcome: "failed" as const,
              termination_reason: "policy_denial" as const,
              completion_claimed: false,
              summary: `Harness detected writes outside the authorized scope: ${undeclaredWrites.join(", ")}`,
            }),
        change_summary: actualChanges.change_summary,
        undeclared_writes: undeclaredWrites,
        evidence: [
          ...result.evidence,
          {
            kind: "harness_diff",
            locator: `repository://${envelope.repository_id}/run/${activeRunId}`,
            digest: diffDigest,
          },
        ],
      };
    }
    observe(ctx, () =>
      ctx.observations.runOutput(activeRunId, observedOutput ? "" : result.summary, {
        flush: true,
        final: true,
      }),
    );
    observe(ctx, () =>
      ctx.observations.budgetUpdated({
        run_id: activeRunId,
        task_id: task.id,
        ...(binding.adapter_profile === undefined
          ? {}
          : { provider: binding.adapter_profile.provider }),
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        total_tokens: result.usage.total_tokens,
        duration_ms: result.usage.duration_ms,
        metering: result.usage.metering,
        budget_observations: result.budget_observations,
      }),
    );
    await ctx.engine.terminateRun(ctx.workflowOperationId, {
      runId: activeRunId,
      outcome: result.outcome,
      // `process_interruption` is reserved for harness-written RunInterrupted
      // records; an adapter-reported reason always maps onto a terminal reason.
      terminationReason:
        result.termination_reason === "process_interruption"
          ? "adapter_failure"
          : result.termination_reason,
    });
    observe(ctx, () =>
      ctx.observations.runTerminated(activeRunId, {
        task_id: task.id,
        outcome: result.outcome,
        termination_reason: result.termination_reason,
        ...(actualChanges === undefined ? {} : { diff_stat: actualChanges.change_summary }),
      }),
    );
    await commitArtifacts(deps, ctx.workflowOperationId, currentAttemptId(ctx), [
      {
        path: runResultArtifactPath(activeRunId),
        content: `${canonicalizeJson(result)}\n`,
      },
      ...(actualChanges === undefined || actualChanges.undeclared_writes.length === 0
        ? []
        : [
            {
              path: `artifacts/scope-drift/${activeRunId}.json`,
              content: `${canonicalizeJson(actualChanges)}\n`,
            },
          ]),
    ]);
    await commitRunFact(ctx, activeRunId, result);
    lastRun = { runId: activeRunId, result };
    ctx.run = lastRun;

    if (!(result.outcome === "handoff" && result.completion_claimed)) {
      await ctx.modules.evaluate?.evaluateTaskRun(ctx, task.id, { runId: activeRunId, result });
      if (strictTddBlockedReason !== undefined) {
        const outcome = await blockWithSnapshot(ctx, {
          reason: "repairable_gate_failure",
          detail: `task ${task.id} did not produce accepted TDD evidence: ${strictTddBlockedReason}`,
          resumePhase: "execute",
          input: snapshotBaseInput(ctx, [{ task_id: task.id, required: true, outcome: "failed" }]),
        });
        return { continue: false, outcome };
      }
      const failure = classifyRunFailure(result);
      if ("abort" in failure) {
        await ctx.engine.abort(ctx.workflowOperationId, {
          reason: failure.abort,
          detail: `task ${task.id} ended in correct_block: ${result.summary}`,
        });
        return {
          continue: false,
          outcome: {
            status: "aborted",
            workflowOperationId: ctx.workflowOperationId,
            iterationId: ctx.iterationId,
            reason: failure.abort,
            detail: result.summary,
          },
        };
      }
      const outcome = await blockWithSnapshot(ctx, {
        reason: failure.reason,
        detail: `task ${task.id} did not complete: ${result.summary}`,
        resumePhase: failure.resumePhase,
        input: snapshotBaseInput(ctx, [
          { task_id: task.id, required: true, outcome: result.outcome },
        ]),
      });
      return { continue: false, outcome };
    }
  }
  if (lastRun === undefined) {
    throw new OrchestrationError("configuration", "execute phase produced no run");
  }
  ctx.run = lastRun;

  await ctx.engine.commitCheckpoint(ctx.workflowOperationId, {
    boundary: PHASE_CHECKPOINT_BOUNDARY.execute,
    proposal: {
      phase: "verify",
      ...(grantDigests.length > 0 ? { add_capability_grants: grantDigests } : {}),
    },
    events: phaseLifecycleEvents({
      phase: "execute",
      taskId: tasks.at(-1)?.id ?? "task_unknown",
      runId: lastRun.runId,
      outcome: lastRun.result.outcome,
    }),
  });
  refreshWorkingState(ctx);
  return { continue: true };
}
function verifyBindings(ctx: PipelineContext): VerifyPhaseArtifact["bindings"] {
  // Resolve bindings from the ledger, not from in-memory phase state, so a
  // resumed drive computes the exact same binding set as the original one.
  // The impact-set digest comes from the plan's pin, never a re-derivation.
  const plan = ctx.plan ?? loadPlan(ctx);
  if (plan !== undefined) ctx.plan = plan;
  if (ctx.bundles.size === 0) ctx.bundles = loadBundleRecords(ctx);
  const bundle = [...ctx.bundles.values()]
    .sort((left, right) => left.task_id.localeCompare(right.task_id))
    .at(-1);
  const planDigest = plan?.content.content_digest;
  const impactSetDigest = plan?.content.impact_set_digest;
  return {
    artifact_digests: [
      ctx.baselineDigest,
      ...(planDigest === undefined ? [] : [planDigest]),
      ...(impactSetDigest === undefined ? [] : [impactSetDigest]),
    ].sort(),
    code_digests: [hashWorktreeCode(ctx.deps.projectRoot)],
    ...(bundle === undefined ? {} : { context_bundle_digest: bundle.digest }),
    evaluation_case_digests: [],
    policy_digest: ctx.workingState.policy_digest,
  };
}
/**
 * Evidence materialization (design 8.5/15.3): a passed, non-provisional gate
 * verdict becomes an Evidence graph node with a SUPPORTS edge to every
 * accepted Test it vouches for -- without this, the `missing_verification`
 * audit rule could never stop reproducing. Binding rule mirrors the quality
 * record: a Test whose verification text names a gate binds that gate's
 * evidence; every other Test binds the whole mandatory suite. Nodes carry
 * the evidence artifact digest and the bindings, so freshness follows the
 * existing digest semantics: a re-run under changed bindings commits the
 * next revision; an unchanged verdict is a no-op. The materials shape is
 * deliberately minimal so both a fresh gate run and a replayed verify
 * verdict (tests scanned into the graph after the original run) can
 * materialize the same nodes and edges.
 */
interface EvidenceMaterial {
  readonly gateId: string;
  readonly mandatory: boolean;
  readonly passed: boolean;
  readonly provisional: boolean;
  readonly evidenceId: string;
  readonly evidenceDigest: string;
}
/** Evidence materials of a fresh gate suite run. */
function freshEvidenceMaterials(outcome: GateSuiteOutcome): EvidenceMaterial[] {
  return outcome.results.map((result) => ({
    gateId: result.gate.gate_id,
    mandatory: result.gate.mandatory,
    passed: result.outcome.passed,
    provisional: result.evidence.provisional,
    evidenceId: result.evidence.evidence_id,
    evidenceDigest: result.evidence.digest,
  }));
}
/**
 * Evidence materials reconstructed from a replayed verify verdict: the
 * committed evidence artifact whose bindings still match the current ones
 * supplies the digest and provisional flag. A verdict whose evidence cannot
 * be matched contributes nothing instead of guessing.
 */
function storedEvidenceMaterials(
  deps: OrchestratorDependencies,
  gates: readonly GateDefinition[],
  stored: VerifyPhaseArtifact,
): EvidenceMaterial[] {
  const materials: EvidenceMaterial[] = [];
  for (const result of stored.results) {
    const gate = gates.find((candidate) => candidate.gate_id === result.gate_id);
    if (gate === undefined) continue;
    const directory = resolveHarnessPath(
      harnessRoot(deps),
      `artifacts/evidence/${result.evidence_id}`,
    );
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)
      .filter((entry) => entry.endsWith(".json"))
      .sort()) {
      const record = readJsonArtifact<GateEvidenceRecord>(
        deps,
        `artifacts/evidence/${result.evidence_id}/${name}`,
      );
      if (record === undefined) continue;
      const bound = evidenceBindingsOf(record);
      if (bound === undefined) continue;
      if (
        JSON.stringify(bound.artifact_digests) !==
          JSON.stringify(stored.bindings.artifact_digests) ||
        JSON.stringify(bound.code_digests) !== JSON.stringify(stored.bindings.code_digests) ||
        bound.policy_digest !== stored.bindings.policy_digest
      ) {
        continue;
      }
      materials.push({
        gateId: gate.gate_id,
        mandatory: gate.mandatory,
        passed: result.passed,
        provisional: record.provisional,
        evidenceId: result.evidence_id,
        evidenceDigest: record.digest,
      });
      break;
    }
  }
  return materials;
}
async function commitEvidenceNodes(
  ctx: PipelineContext,
  materials: readonly EvidenceMaterial[],
  bindings: VerifyPhaseArtifact["bindings"],
): Promise<void> {
  const { deps } = ctx;
  const graph = materializeProjectGraph(deps.projectRoot);
  let latest: ReadonlyMap<string, NodeRecord>;
  let committedEdgeIds: ReadonlySet<string>;
  try {
    const byNodeId = new Map<string, NodeRecord>();
    for (const node of graph.nodes) {
      const current = byNodeId.get(node.id);
      if (current === undefined || node.revision > current.revision) byNodeId.set(node.id, node);
    }
    latest = new Map([...byNodeId.entries()].filter(([, node]) => node.status !== "tombstoned"));
    committedEdgeIds = new Set(graph.edges.map((edge) => edge.id));
  } finally {
    graph.close();
  }
  const tests = [...latest.values()].filter(
    (node) => node.type === "Test" && node.status === "accepted",
  );
  if (tests.length === 0) return;
  const verificationOf = (test: NodeRecord): string | undefined => {
    const extension = test.extensions?.["harness.requirements"];
    if (typeof extension !== "object" || extension === null) return undefined;
    const verification = (extension as Record<string, unknown>).verification;
    return typeof verification === "string" ? verification : undefined;
  };

  const artifacts: { readonly path: string; readonly content: string }[] = [];
  const edges: EdgeRecord[] = [];
  for (const material of materials) {
    if (!material.passed || material.provisional) continue;
    const evidenceId = material.evidenceId;
    const current = latest.get(evidenceId);
    const currentBinding =
      current?.extensions?.["harness.evidence"] !== undefined &&
      typeof current.extensions["harness.evidence"] === "object"
        ? (current.extensions["harness.evidence"] as Record<string, unknown>).artifact_digest
        : undefined;
    if (current === undefined || currentBinding !== material.evidenceDigest) {
      const revision = (current?.revision ?? 0) + 1;
      const content: Record<string, unknown> = {
        protocol_version: PROTOCOL_VERSION,
        record_kind: "node",
        id: evidenceId,
        type: "Evidence",
        revision,
        status: "accepted",
        source: "gate",
        provenance: {
          iteration_id: ctx.iterationId,
          actor: "workflow-engine",
          timestamp: nowOf(deps),
        },
        confidence: 1,
        extensions: {
          "harness.evidence": {
            artifact_digest: material.evidenceDigest,
            gate_id: material.gateId,
            passed: true,
            bindings,
          },
        },
      };
      const node = { ...content, digest: contentDigest(content) };
      const validation = validateSchema("node", node);
      if (!validation.valid) {
        throw new OrchestrationError(
          "configuration",
          `invalid evidence node: ${validation.errors.map((issue) => issue.message).join("; ")}`,
        );
      }
      artifacts.push({
        path: `artifacts/evidence-nodes/${evidenceId}/${String(revision)}.json`,
        content: `${canonicalizeJson(node)}\n`,
      });
    }
    for (const test of tests) {
      const verification = verificationOf(test);
      const namesGate = verification !== undefined && verification.includes(material.gateId);
      const namesNoGate =
        verification === undefined ||
        !materials.some((candidate) => verification.includes(candidate.gateId));
      // A Test naming this gate binds its evidence; a Test naming no gate at
      // all binds every mandatory gate's evidence (the suite verdict).
      if (!namesGate && !(namesNoGate && material.mandatory)) continue;
      const edgeId = `edge_${contentDigest({ type: "SUPPORTS", source: evidenceId, target: test.id }).slice(0, 16)}`;
      if (committedEdgeIds.has(edgeId)) continue;
      const content: Record<string, unknown> = {
        protocol_version: PROTOCOL_VERSION,
        record_kind: "edge",
        id: edgeId,
        type: "SUPPORTS",
        source_id: evidenceId,
        target_id: test.id,
        status: "accepted",
        source: "gate",
        provenance: {
          iteration_id: ctx.iterationId,
          actor: "workflow-engine",
          timestamp: nowOf(deps),
        },
        confidence: 1,
      };
      const edge = { ...content, digest: contentDigest(content) };
      const validation = validateSchema("edge", edge);
      if (!validation.valid) {
        throw new OrchestrationError(
          "configuration",
          `invalid SUPPORTS edge: ${validation.errors.map((issue) => issue.message).join("; ")}`,
        );
      }
      edges.push(edge as unknown as EdgeRecord);
      committedEdgeIds = new Set([...committedEdgeIds, edgeId]);
    }
  }
  if (artifacts.length === 0 && edges.length === 0) return;
  await commitArtifacts(deps, ctx.workflowOperationId, currentAttemptId(ctx), artifacts, edges);
}
async function phaseVerify(
  ctx: PipelineContext,
  gates: readonly GateDefinition[],
  registry: ToolRegistry,
): Promise<PhaseStep> {
  const { deps } = ctx;
  const bindings = verifyBindings(ctx);
  const stored = loadVerifyArtifact(deps, ctx.iterationId, bindings);
  let outcome: GateSuiteOutcome | undefined;
  let summary: VerifyPhaseArtifact;
  if (stored !== undefined) {
    // Idempotent resume: the same bindings replay the committed verdict
    // instead of re-running gates and duplicating evidence. Evidence
    // materialization still runs: tests scanned into the graph after the
    // original gate run get their nodes and edges from the replayed verdict.
    summary = stored;
    await commitEvidenceNodes(ctx, storedEvidenceMaterials(deps, gates, stored), bindings);
  } else {
    outcome = await runGateSuite(registry, {
      iterationId: ctx.iterationId,
      repositoryId: readManagedManifest(deps.projectRoot).repository_id,
      gates,
      bindings: {
        artifact_digests: bindings.artifact_digests,
        code_digests: bindings.code_digests,
        ...(bindings.context_bundle_digest === undefined
          ? {}
          : { context_bundle_digest: bindings.context_bundle_digest }),
        evaluation_case_digests: bindings.evaluation_case_digests,
        policy_digest: bindings.policy_digest,
      },
      clock: () => nowOf(deps),
      observations: ctx.observations,
    });
    ctx.gateOutcome = outcome;
    summary = {
      record_kind: "orchestration_verify_result",
      iteration_id: ctx.iterationId,
      bindings,
      results: outcome.results.map((result) => ({
        gate_id: result.gate.gate_id,
        passed: result.outcome.passed,
        evidence_id: result.evidence.evidence_id,
        summary: result.outcome.summary,
      })),
      findings: outcome.findings.map((finding) => ({ id: finding.id, summary: finding.summary })),
      completed_allowed: outcome.completed_allowed,
    };
    // Ledger artifacts are immutable files: evidence and verdicts land in
    // digest-versioned paths so a re-run after a repair never overwrites.
    // The per-task quality records commit alongside, passed or failed, so a
    // human always reviews exactly what was verified (card T5).
    await commitArtifacts(deps, ctx.workflowOperationId, currentAttemptId(ctx), [
      ...outcome.results.map((result) => ({
        path: `artifacts/evidence/${result.evidence.evidence_id}/${result.evidence.digest}.json`,
        content: `${canonicalizeJson(result.evidence)}\n`,
      })),
      ...outcome.findings.map((finding) => ({
        path: `artifacts/findings/${finding.id}/proposed.json`,
        content: `${canonicalizeJson(finding)}\n`,
      })),
      ...buildTaskQualityRecords(ctx, outcome, bindings),
      {
        path: verifyArtifactPath(ctx.iterationId, bindings),
        content: `${canonicalizeJson(summary)}\n`,
      },
    ]);
    await commitEvidenceNodes(ctx, freshEvidenceMaterials(outcome), bindings);
  }

  if (!summary.completed_allowed) {
    const task = ctx.plan?.content.tasks[0];
    const outcome2 = await blockWithSnapshot(ctx, {
      reason: "repairable_gate_failure",
      detail: summary.findings.map((finding) => finding.summary).join("; "),
      resumePhase: "verify",
      input: snapshotBaseInput(ctx, [
        {
          task_id: task?.id ?? "task_unknown",
          required: true,
          outcome: ctx.run?.result.outcome ?? "pending",
        },
      ]),
    });
    return { continue: false, outcome: outcome2 };
  }

  // Close previously failed findings whose gate now passes with current
  // evidence; stale repair evidence can never close a finding.
  if (outcome !== undefined) {
    for (const result of outcome.results) {
      const suffix = result.gate.gate_id.slice("gate_".length);
      const proposedPath = `artifacts/findings/finding_${suffix}/proposed.json`;
      const closedPath = `artifacts/findings/finding_${suffix}/closed.json`;
      const finding = readJsonArtifact<Record<string, unknown> & { status?: string }>(
        deps,
        proposedPath,
      );
      if (finding === undefined || artifactExists(deps, closedPath)) continue;
      const current: CurrentEvidenceState = {
        artifact_digests: bindings.artifact_digests,
        code_digests: bindings.code_digests,
        ...(bindings.context_bundle_digest === undefined
          ? {}
          : { context_bundle_digest: bindings.context_bundle_digest }),
        gate_digest: result.gate.digest,
        evaluation_case_digests: bindings.evaluation_case_digests,
        policy_digest: bindings.policy_digest,
      };
      if (!findingClosableBy(result.evidence, current)) continue;
      const closed: Record<string, unknown> = { ...finding, status: "closed" };
      delete closed["digest"];
      const sealed = { ...closed, digest: contentDigest(closed) };
      await commitArtifacts(deps, ctx.workflowOperationId, currentAttemptId(ctx), [
        {
          path: closedPath,
          content: `${canonicalizeJson(sealed)}\n`,
        },
      ]);
    }
  }

  await ctx.engine.commitCheckpoint(ctx.workflowOperationId, {
    boundary: PHASE_CHECKPOINT_BOUNDARY.verify,
    proposal: { phase: "evaluate" },
    events: phaseLifecycleEvents({
      phase: "verify",
      gates: summary.results.map((result) => ({
        gateId: result.gate_id,
        passed: result.passed,
        observationKey: gateCompletionObservationKey(
          ctx.workflowOperationId,
          currentAttemptId(ctx),
          result.gate_id,
        ),
      })),
    }),
  });
  refreshWorkingState(ctx);
  return { continue: true };
}
/**
 * Incremental worktree rescan (design 12.2 reuse). Adoption scans the
 * worktree once, but files written afterwards never enter the graph, so the
 * audit cannot see them. Before the post-iteration audit runs, the
 * completing snapshot re-scans the worktree with the same deterministic
 * scanner and commits nodes (plus the Repository CONTAINS edge) for
 * documentation and test files that have no node yet -- docs feed the
 * design-artifact audit, tests feed evidence materialization at the next
 * verify. Node and edge ids are content-derived from the locator, so re-runs
 * are no-ops; changed or deleted files are out of scope (their nodes keep
 * their adopted revisions).
 */
async function commitScannedDocumentation(ctx: PipelineContext): Promise<void> {
  const { deps } = ctx;
  const graph = materializeProjectGraph(deps.projectRoot);
  let repository: NodeRecord | undefined;
  let knownLocators: ReadonlySet<string>;
  try {
    const latest = new Map<string, NodeRecord>();
    for (const node of graph.nodes) {
      const current = latest.get(node.id);
      if (current === undefined || node.revision > current.revision) latest.set(node.id, node);
    }
    repository = [...latest.values()].find(
      (node) => node.type === "Repository" && node.status === "accepted",
    );
    knownLocators = new Set(
      [...latest.values()]
        .filter(
          (node) =>
            (node.type === "CodeArtifact" || node.type === "Test") && node.locator !== undefined,
        )
        .map((node) => node.locator as string),
    );
  } finally {
    graph.close();
  }
  if (repository === undefined) return;
  const scan = scanWorktree(deps.projectRoot);
  const manifest = readManagedManifest(deps.projectRoot);
  const context: RecordContext = {
    projectId: `project_${manifest.name}`,
    repositoryId: manifest.repository_id,
    iterationId: ctx.iterationId,
    actor: "harness-scanner",
    timestamp: nowOf(deps),
  };
  const artifacts: { readonly path: string; readonly content: string }[] = [];
  const edges: EdgeRecord[] = [];
  for (const file of scan.files) {
    if (file.classification !== "documentation" && file.classification !== "test") continue;
    const locator = canonicalizeLocator(`repo://${manifest.repository_id}/${file.path}`);
    if (knownLocators.has(locator)) continue;
    const node = scannedNodeRecord(context, {
      type: file.classification === "test" ? "Test" : "CodeArtifact",
      locator,
      extensions: {
        "harness.scan": {
          classification: file.classification,
          sha256: file.sha256,
          size: file.size,
          ...(file.apiEntries === undefined ? {} : { api_entries: [...file.apiEntries] }),
        },
      },
    });
    const path = artifactPathForNode(node);
    if (artifactExists(deps, path)) continue;
    artifacts.push({ path, content: artifactContentForNode(node) });
    edges.push(
      edgeRecord(context, {
        type: "CONTAINS",
        sourceId: repository.id,
        targetId: node.id,
        source: "scanner",
      }),
    );
  }
  if (artifacts.length === 0 && edges.length === 0) return;
  await commitArtifacts(deps, ctx.workflowOperationId, currentAttemptId(ctx), artifacts, edges);
}
/** Outcome of the advanced_audit contribution the snapshot phase consumes. */
export interface AuditCommitOutcome {
  readonly blockingFindingIds: readonly string[];
}

/**
 * Module contributor contract (plan Task 8-A; slim-profiles design 6.2, 9.5).
 * The Kernel Coordinator reaches module behavior only through these
 * registrations — it never imports a contributor module. An unregistered
 * module contributes no phase step, no checkpoint and no events, so deleting
 * an unenabled module cannot affect the Kernel happy path.
 */
export type ModulePhaseStep = (ctx: PipelineContext) => Promise<PhaseStep>;

/** impact_analysis module: the `impact` phase between capture and plan. */
export interface ImpactContribution {
  readonly capability_id: "impact_analysis";
  readonly runPhase: ModulePhaseStep;
}

/** design_governance module: the `design` phase between impact and plan. */
export interface DesignContribution {
  readonly capability_id: "design_governance";
  readonly runPhase: ModulePhaseStep;
}

/** independent_evaluation module: per-run evaluation plus the `evaluate` phase. */
export interface EvaluateContribution {
  readonly capability_id: "independent_evaluation";
  readonly runPhase: ModulePhaseStep;
  readonly evaluateTaskRun: (
    ctx: PipelineContext,
    taskId: string,
    run: { readonly runId: string; readonly result: AgentRunResult },
  ) => Promise<EvaluationPortResult>;
}

/** advanced_audit module: the post-verify graph audit the snapshot consumes. */
export interface AuditContribution {
  readonly capability_id: "advanced_audit";
  readonly commitFindings: (ctx: PipelineContext) => Promise<AuditCommitOutcome>;
}

export interface ModuleContributions {
  readonly impact?: ImpactContribution;
  readonly design?: DesignContribution;
  readonly evaluate?: EvaluateContribution;
  readonly audit?: AuditContribution;
}

/** Route the completion audit through its contribution; unregistered means zero findings. */
export async function commitAuditContribution(ctx: PipelineContext): Promise<AuditCommitOutcome> {
  if (ctx.modules.audit === undefined) {
    return { blockingFindingIds: [] };
  }
  return ctx.modules.audit.commitFindings(ctx);
}
export function snapshotBaseInput(
  ctx: PipelineContext,
  tasks: readonly {
    readonly task_id: string;
    readonly required: boolean;
    readonly outcome:
      | "success"
      | "correct_block"
      | "clarification_required"
      | "handoff"
      | "partial"
      | "failed"
      | "pending";
  }[],
): Omit<
  Parameters<typeof buildSnapshot>[0],
  "snapshot_id" | "created_at" | "block_reason" | "resume_phase" | "source_commit"
> {
  const profile = executionBindingFor(ctx.deps).adapter_profile;
  return {
    iteration_id: ctx.iterationId,
    workflow_operation_id: ctx.workflowOperationId,
    tasks,
    approvals: ctx.workingState.approval_digests,
    budget: ctx.workingState.budget,
    ...(profile === undefined
      ? {}
      : {
          adapter_control_profile: profile,
          adapter_profile_digest: contentDigest(profile),
        }),
    ...(ctx.run?.result.budget_observations === undefined
      ? {}
      : { budget_observations: ctx.run.result.budget_observations }),
  };
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
  const suiteGates = ctx.deps.gates ?? createDefaultGateSuite(deps.projectRoot).gates;
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
  return ctx.deps.gates === undefined
    ? createDefaultGateSuite(ctx.deps.projectRoot)
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
    produces: () => readonly { readonly kind: BindingKind; readonly digest: string }[],
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
          () =>
            dagContext.node.subgraph === "strict_tdd"
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
              : [],
        ),
      verify: () =>
        runPhaseNode(
          "verify",
          (step) => phaseVerify(step, suite.gates, suite.registry),
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
        ),
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

export async function drivePipeline(
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
function observe(_ctx: PipelineContext, action: () => unknown): void {
  try {
    action();
  } catch {
    // Live observations are explicitly disposable and never affect outcomes.
  }
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
