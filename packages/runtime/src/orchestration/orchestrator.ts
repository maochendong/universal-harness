import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  LedgerRepository,
  PROTOCOL_VERSION,
  canonicalizeJson,
  contentDigest,
  harnessRootFor,
  readCommittedOperations,
  readManagedManifest,
  resolveHarnessPath,
  sha256Hex,
  ulid,
  validateSchema,
  type CommitHooks,
  type EdgeRecord,
  type LockTuning,
  type NodeRecord,
} from "@universal-harness-internal/core";
import {
  generateImpactSet,
  materializeLedger,
  pageEdges,
  pageNodes,
  readImpactSetContent,
  freezeImpactSet,
  type ChangeSeed,
  type IterationKind,
} from "@universal-harness-internal/graph";
import type {
  AgentRunResult,
  AgentTaskEnvelope,
  AgentTrajectoryVisibility,
  VcsAdapter,
} from "@universal-harness-internal/plugin-sdk";

import { ApprovalService, type ApprovalIdKind } from "../approval/service.js";
import {
  approvalDecisionArtifact,
  readApprovalDecisions,
  readApprovalRequests,
  type ApprovalDecision,
  type ApprovalDecisionRecord,
  type ApprovalRequestRecord,
  type ApprovalRisk,
} from "../approval/request.js";
import {
  approvalRequiredOutcome,
  promptForApprovalDecision,
  resumeCommandFor,
  type ApprovalPrompter,
  type ApprovalRequiredOutcome,
} from "../approval/interaction.js";
import {
  compileContextBundle,
  type CompiledContextBundle,
  type ContextBundleRecord,
  type ContextCandidate,
} from "../context/compiler.js";
import { normalizeGateDefinition, type GateDefinition } from "../gates/provider.js";
import { findingClosableBy, type CurrentEvidenceState } from "../gates/freshness.js";
import { runGateSuite, type GateSuiteOutcome } from "../gates/runner.js";
import { issueGrant } from "../policy/capability-grant.js";
import { mergePolicyLayers } from "../policy/evaluator.js";
import type { EffectivePolicy } from "../policy/decision.js";
import { buildTaskEnvelope, type TaskEnvelope } from "../loop/task-envelope.js";
import { resolveLoopPolicy } from "../loop/policy.js";
import {
  generateExecutionPlan,
  readExecutionPlanContent,
  type ExecutionPlanContent,
} from "../planning/execution-plan.js";
import type { IntentShape } from "../planning/mode-selector.js";
import type { TaskSpecification } from "../planning/task.js";
import {
  captureRequirements,
  type IntentInput,
  type RequirementProposal,
  type ClarificationQuestion,
  type ConstraintInput,
  type RequirementInput,
} from "../requirements/capture.js";
import {
  baselineDocumentArtifactPath,
  commitRequirementBaseline,
  requirementBaselineDigest,
} from "../requirements/baseline.js";
import {
  buildSnapshot,
  snapshotCompletionBlockers,
  type SnapshotRecord,
} from "../snapshot/builder.js";
import { ToolRegistry } from "../tools/registry.js";
import {
  WorkflowEngine,
  readCurrentOperation,
  readRunStreams,
  streamTerminalRecord,
  type WorkflowDependencies,
  type WorkflowIdKind,
} from "../workflow/operation.js";
import { resumeWorkflowOperation } from "../workflow/resume.js";
import type { AbortReason, RecoverableBlockReason } from "../workflow/state-machine.js";
import type { WorkingState } from "../workflow/working-state.js";
import { phaseLifecycleEvents } from "./lifecycle-events.js";
import {
  ORCHESTRATION_PHASES,
  PHASE_CHECKPOINT_BOUNDARY,
  isOrchestrationPhase,
  phaseRank,
  type OrchestrationPhase,
} from "./phases.js";

/**
 * Phase orchestrator (design sections 2, 10 and 11; plan Task 23). One
 * pipeline drives every entry command -- `new`, `adopt` and `iterate` only
 * differ in how the project and the workflow operation are opened. Each phase
 * commits its outputs atomically and advances the recorded phase, approval
 * points persist their request before any human input and never duplicate a
 * pending request, and resume re-derives or reloads every committed output
 * instead of repeating authority or side effects.
 *
 * Evaluation is a port: the runtime cannot depend on the eval package
 * (dependency direction core <- runtime <- eval), so the CLI wires the full
 * evaluator and tests inject fakes. The built-in default is a deterministic
 * minimal evaluation (completion claim, containment, outcome) so the runtime
 * stays self-sufficient.
 */
export const ORCHESTRATION_ERROR_KINDS = [
  "no_open_operation",
  "operation_already_open",
  "operation_not_found",
  "invalid_phase",
  "configuration",
  "binding_drift",
] as const;

export type OrchestrationErrorKind = (typeof ORCHESTRATION_ERROR_KINDS)[number];

export class OrchestrationError extends Error {
  readonly kind: OrchestrationErrorKind;

  constructor(kind: OrchestrationErrorKind, message: string) {
    super(message);
    this.name = "OrchestrationError";
    this.kind = kind;
  }
}

/** Structured requirements a capture interpreter derives from free-text intent. */
export interface InterpretedIntent {
  readonly requirements: readonly RequirementInput[];
  readonly constraints?: readonly ConstraintInput[];
}

/**
 * Restricted capture port (design 10.1): free-text intent enters the pipeline
 * only through semantic interpretation or a deterministic lossless Pack
 * conversion. Returning `undefined` means the intent cannot be captured and
 * the orchestrator pauses for mandatory input.
 */
export type IntentInterpreter = (
  intent: string,
) => Promise<InterpretedIntent | undefined> | InterpretedIntent | undefined;

/**
 * Executor port for the execute phase: one Task Envelope in, one structured
 * run result out (design 13.2). A thrown error is a process-level crash: the
 * orchestrator deliberately does not catch it, so the run stays unterminated
 * and resume reconciles it with exactly one RunInterrupted plus one successor
 * run. Typed failures belong in the returned result, never in a throw.
 */
export type OrchestrationExecutor = (envelope: AgentTaskEnvelope) => Promise<AgentRunResult>;

export interface EvaluationPortInput {
  readonly taskId: string;
  readonly iterationId: string;
  readonly run: AgentRunResult;
  readonly visibility: AgentTrajectoryVisibility;
  readonly budget: {
    readonly max_steps: number;
    readonly max_tokens: number;
    readonly max_duration_ms: number;
  };
  readonly now: string;
}

export interface EvaluationPortResult {
  readonly evidenceId: string;
  readonly passed: boolean;
  readonly mandatoryFailures: readonly string[];
  readonly findings: readonly { readonly id: string; readonly summary: string }[];
  readonly summary: string;
  /** Schema-valid evaluation evidence record, committed as a ledger artifact. */
  readonly record: Record<string, unknown>;
}

export type EvaluationPort = (
  input: EvaluationPortInput,
) => Promise<EvaluationPortResult> | EvaluationPortResult;

export interface OrchestratorDependencies {
  readonly projectRoot: string;
  /** Current Git baseline (HEAD) the next ledger commit must build on. */
  readonly readBaseline: () => string;
  /** Injectable clock (ISO 8601 UTC) for deterministic tests. */
  readonly now?: () => string;
  /** Injectable id mint for deterministic tests; defaults to ULID-based ids. */
  readonly newId?: (kind: string) => string;
  readonly hooks?: CommitHooks;
  readonly lock?: LockTuning;
  /** When present, completed iterations git-commit the ledger artifacts. */
  readonly vcs?: VcsAdapter;
  /** Interactive approval prompt; absent means non-interactive (never reads stdin). */
  readonly prompter?: ApprovalPrompter;
  /** Actor recorded for interactively resolved decisions. */
  readonly decisionActor?: string;
  readonly interpret?: IntentInterpreter;
  readonly execute?: OrchestrationExecutor;
  /**
   * Gate suite for the verify phase. Defaults to the universal ledger
   * integrity gate; a custom suite must come with its `toolRegistry`.
   */
  readonly gates?: readonly GateDefinition[];
  readonly toolRegistry?: ToolRegistry;
  readonly evaluate?: EvaluationPort;
  readonly trajectoryVisibility?: AgentTrajectoryVisibility;
  readonly tokenBudget?: number;
}

export type OrchestrationOutcome =
  | {
      readonly status: "completed";
      readonly workflowOperationId: string;
      readonly iterationId: string;
      readonly snapshotId: string;
      readonly finalCommit: string;
    }
  | { readonly status: "approval_required"; readonly required: ApprovalRequiredOutcome }
  | {
      readonly status: "input_required";
      readonly questions: readonly ClarificationQuestion[];
    }
  | {
      readonly status: "blocked";
      readonly workflowOperationId: string;
      readonly iterationId: string;
      readonly reason: RecoverableBlockReason;
      readonly detail: string;
      readonly resumeCommand: string;
      readonly snapshotId?: string;
    }
  | {
      readonly status: "aborted";
      readonly workflowOperationId: string;
      readonly iterationId: string;
      readonly reason: AbortReason;
      readonly detail: string;
    }
  | {
      readonly status: "advanced";
      readonly workflowOperationId: string;
      readonly iterationId: string;
      readonly completedPhase: OrchestrationPhase;
    };

export interface RunIterationInput {
  readonly intent: string;
  readonly iterationKind?: IterationKind;
  /** How the intent entered capture; defaults to `free-text`. */
  readonly intentShape?: IntentShape;
  /** Whether all planned work is deterministic; defaults to true. */
  readonly deterministicWork?: boolean;
  /** Reuse an existing iteration node (the bootstrap iteration of `new`/`adopt`). */
  readonly iterationId?: string;
  /** Stop after this phase completes (advanced-command drives). */
  readonly untilPhase?: OrchestrationPhase;
}

const HARNESS_COMMIT_IDENTITY = { name: "Universal Harness", email: "harness@localhost" } as const;

const DEFAULT_TOKEN_BUDGET = 8000;

function nowOf(deps: OrchestratorDependencies): string {
  return (deps.now ?? (() => new Date().toISOString()))();
}

function newIdOf(deps: OrchestratorDependencies, kind: string): string {
  return (deps.newId ?? ((idKind) => `${idKind}_${ulid()}`))(kind);
}

function workflowDeps(deps: OrchestratorDependencies): WorkflowDependencies {
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

function approvalService(deps: OrchestratorDependencies): ApprovalService {
  return new ApprovalService({
    projectRoot: deps.projectRoot,
    readBaseline: deps.readBaseline,
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.newId === undefined
      ? {}
      : { newId: (kind: ApprovalIdKind) => (deps.newId as (kind: string) => string)(kind) }),
    ...(deps.hooks === undefined ? {} : { hooks: deps.hooks }),
    ...(deps.lock === undefined ? {} : { lock: deps.lock }),
  });
}

function harnessRoot(deps: OrchestratorDependencies): string {
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

/** Deterministic minimal evaluation used when no evaluation port is injected. */
export function createDefaultEvaluationPort(): EvaluationPort {
  return (input) => {
    const violations: string[] = [];
    if (!input.run.completion_claimed) violations.push("run did not claim completion");
    if (input.run.undeclared_writes.length > 0) {
      violations.push(`undeclared writes: ${input.run.undeclared_writes.join(", ")}`);
    }
    if (input.run.outcome === "failed") violations.push("run outcome is failed");
    const passed = violations.length === 0;
    const extension = {
      case_id: `case_${input.taskId.slice("task_".length)}`,
      visibility: input.visibility,
      checks: ["completion_claim", "containment", "outcome"],
      passed,
    };
    const record = {
      protocol_version: PROTOCOL_VERSION,
      record_kind: "evidence",
      evidence_id: `evidence_evaluation_${input.taskId.slice("task_".length)}`,
      evidence_type: "evaluation_report",
      subject_id: input.taskId,
      digest: contentDigest({
        evidence_type: "evaluation_report",
        subject_id: input.taskId,
        extension,
      }),
      provisional: false,
      created_at: input.now,
      extensions: { "harness.evaluation": extension },
    };
    const validation = validateSchema("runtime", record);
    if (!validation.valid) {
      throw new OrchestrationError(
        "configuration",
        `default evaluation produced an invalid evidence record: ${validation.errors
          .map((issue) => issue.message)
          .join("; ")}`,
      );
    }
    const findings = passed
      ? []
      : [
          {
            id: `finding_evaluation_${input.taskId.slice("task_".length)}`,
            summary: `Mandatory evaluation failed for ${input.taskId}: ${violations.join("; ")}`,
          },
        ];
    return {
      evidenceId: record.evidence_id,
      passed,
      mandatoryFailures: passed ? [] : ["outcome"],
      findings,
      summary: passed ? "minimal deterministic evaluation passed" : violations.join("; "),
      record: record as unknown as Record<string, unknown>,
    };
  };
}

interface ProjectGraph {
  readonly nodes: readonly NodeRecord[];
  readonly edges: readonly EdgeRecord[];
  close(): void;
}

/** Materialize the ledger in memory; the on-disk cache is never trusted here. */
function materializeProjectGraph(projectRoot: string): ProjectGraph {
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

/**
 * Digest of the project code the gates ran against (design 15.3 evidence
 * binding): sorted path/content digests of every worktree file outside the
 * control plane, dependency directories and Git internals. Any human repair
 * changes this digest, which makes prior gate evidence stale and re-runs the
 * verify phase instead of replaying a cached verdict.
 */
export function hashWorktreeCode(projectRoot: string): string {
  const SKIPPED = new Set([".git", ".harness", "node_modules"]);
  const entries: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      if (prefix === "" && SKIPPED.has(entry.name)) continue;
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute, relative);
      else if (entry.isFile()) {
        entries.push(`${relative}:${sha256Hex(readFileSync(absolute, "utf8"))}`);
      }
    }
  };
  walk(projectRoot, "");
  return sha256Hex(entries.join("\n"));
}

function artifactExists(deps: OrchestratorDependencies, ledgerRelativePath: string): boolean {
  return existsSync(resolveHarnessPath(harnessRoot(deps), ledgerRelativePath));
}

function readJsonArtifact<T>(
  deps: OrchestratorDependencies,
  ledgerRelativePath: string,
): T | undefined {
  const absolute = resolveHarnessPath(harnessRoot(deps), ledgerRelativePath);
  if (!existsSync(absolute)) return undefined;
  return JSON.parse(readFileSync(absolute, "utf8")) as T;
}

/** Commit one ledger operation outside the engine helpers (phase artifacts). */
async function commitArtifacts(
  deps: OrchestratorDependencies,
  workflowOperationId: string,
  attemptId: string,
  artifacts: readonly { readonly path: string; readonly content: string }[],
  edges: readonly EdgeRecord[] = [],
): Promise<void> {
  const repository = new LedgerRepository({
    projectRoot: deps.projectRoot,
    readBaseline: deps.readBaseline,
    now: () => nowOf(deps),
    ...(deps.hooks === undefined ? {} : { hooks: deps.hooks }),
    ...(deps.lock === undefined ? {} : { lock: deps.lock }),
  });
  await repository.commit({
    ledger_operation_id: newIdOf(deps, "ledger"),
    workflow_operation_id: workflowOperationId,
    attempt_id: attemptId,
    expected_baseline: deps.readBaseline(),
    artifacts,
    edges,
    events: [],
  });
}

interface PipelineContext {
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
  impactSet?: NodeRecord;
  plan?: { readonly node: NodeRecord; readonly content: ExecutionPlanContent };
  bundle?: ContextBundleRecord;
  envelope?: TaskEnvelope;
  run?: { readonly runId: string; readonly result: AgentRunResult };
  gateOutcome?: GateSuiteOutcome;
  evaluation?: EvaluationPortResult;
}

function currentAttemptId(ctx: PipelineContext): string {
  const operation = ctx.engine.getOperation(ctx.workflowOperationId);
  if (operation === undefined) {
    throw new OrchestrationError(
      "operation_not_found",
      `workflow operation ${ctx.workflowOperationId} disappeared mid-pipeline`,
    );
  }
  return operation.attempt_id;
}

function refreshWorkingState(ctx: PipelineContext): WorkingState {
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

async function captureProposal(
  deps: OrchestratorDependencies,
  intent: string,
): Promise<
  | { readonly status: "captured"; readonly proposal: RequirementProposal }
  | {
      readonly status: "clarification_required";
      readonly questions: readonly ClarificationQuestion[];
    }
> {
  const interpreted = deps.interpret === undefined ? undefined : await deps.interpret(intent);
  const input: IntentInput = {
    text: intent,
    requirements: interpreted?.requirements ?? [],
    ...(interpreted?.constraints === undefined ? {} : { constraints: interpreted.constraints }),
  };
  return captureRequirements(input, { newId: captureIdMint(input) });
}

type ApprovalStep =
  | { readonly status: "approved"; readonly approvalDigest: string }
  | { readonly status: "rejected" }
  | { readonly status: "required"; readonly required: ApprovalRequiredOutcome };

function approvalDigestOf(record: ApprovalDecisionRecord): string {
  return sha256Hex(approvalDecisionArtifact(record).content);
}

/**
 * Resolve one approval point without ever duplicating a pending request: an
 * existing request for the same object and digest is reused (resume only
 * re-blocks the operation), a terminal approve decision is replayed into its
 * digest, and only a genuinely new object mints a new request.
 */
async function ensureApproval(
  ctx: PipelineContext,
  spec: {
    readonly objectId: string;
    readonly objectType: string;
    readonly objectDigest: string;
    readonly risk: ApprovalRisk;
    readonly reason: string;
    readonly resumePhase: OrchestrationPhase;
  },
): Promise<ApprovalStep> {
  const { deps } = ctx;
  const service = approvalService(deps);
  const operations = readCommittedOperations(harnessRoot(deps));
  const requests = readApprovalRequests(
    harnessRoot(deps),
    operations,
    ctx.workflowOperationId,
  ).filter(
    (request) => request.object_id === spec.objectId && request.object_digest === spec.objectDigest,
  );
  const decisions = readApprovalDecisions(harnessRoot(deps), operations, ctx.workflowOperationId);

  const blockAndReport = async (request: ApprovalRequestRecord): Promise<ApprovalStep> => {
    const current = ctx.engine.getOperation(ctx.workflowOperationId);
    if (current !== undefined && current.state !== "blocked") {
      await ctx.engine.block(ctx.workflowOperationId, {
        reason: "awaiting_approval",
        detail: `approval request ${request.request_id} awaiting a decision`,
        proposal: {
          phase: spec.resumePhase,
          set_next_action: resumeCommandFor(ctx.workflowOperationId),
        },
      });
    }
    refreshWorkingState(ctx);
    return { status: "required", required: approvalRequiredOutcome(request) };
  };

  const resolveInteractive = async (request: ApprovalRequestRecord): Promise<ApprovalStep> => {
    const prompter = deps.prompter;
    if (prompter === undefined) return blockAndReport(request);
    const decision: ApprovalDecision = await promptForApprovalDecision(request, prompter);
    if (decision === "defer") return blockAndReport(request);
    const record = await service.resolveDecision({
      requestId: request.request_id,
      decision,
      objectDigest: request.object_digest,
      actor: deps.decisionActor ?? "human:interactive",
    });
    refreshWorkingState(ctx);
    if (decision === "reject") return { status: "rejected" };
    return { status: "approved", approvalDigest: approvalDigestOf(record) };
  };

  const existing = requests.at(-1);
  if (existing !== undefined) {
    const terminal = decisions.find(
      (decision) => decision.request_id === existing.request_id && decision.decision !== "defer",
    );
    if (terminal !== undefined) {
      if (terminal.decision === "reject") return { status: "rejected" };
      return { status: "approved", approvalDigest: approvalDigestOf(terminal) };
    }
    return resolveInteractive(existing);
  }

  const input = {
    workflowOperationId: ctx.workflowOperationId,
    objectId: spec.objectId,
    objectType: spec.objectType,
    objectDigest: spec.objectDigest,
    baselineDigest: ctx.baselineDigest,
    policyDigest: ctx.workingState.policy_digest,
    impactPath: [],
    risk: spec.risk,
    reason: spec.reason,
    resumePhase: spec.resumePhase,
    proposedBy: "orchestrator",
  };
  if (deps.prompter === undefined) {
    const required = await service.requestApproval(input);
    refreshWorkingState(ctx);
    return { status: "required", required };
  }
  const awaited = await service.requestApprovalInteractively(
    input,
    deps.prompter,
    deps.decisionActor ?? "human:interactive",
  );
  refreshWorkingState(ctx);
  if (awaited.status === "deferred") return { status: "required", required: awaited.required };
  if (awaited.decision.decision === "reject") return { status: "rejected" };
  return { status: "approved", approvalDigest: approvalDigestOf(awaited.decision) };
}

/** Abort the operation after an explicit rejection; the audit history stays. */
async function rejectOperation(
  ctx: PipelineContext,
  detail: string,
): Promise<OrchestrationOutcome> {
  await ctx.engine.abort(ctx.workflowOperationId, { reason: "user_cancellation", detail });
  return {
    status: "aborted",
    workflowOperationId: ctx.workflowOperationId,
    iterationId: ctx.iterationId,
    reason: "user_cancellation",
    detail,
  };
}

function loadFrozenImpactSet(ctx: PipelineContext): NodeRecord | undefined {
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

function loadPlan(
  ctx: PipelineContext,
): { readonly node: NodeRecord; readonly content: ExecutionPlanContent } | undefined {
  const graph = materializeProjectGraph(ctx.deps.projectRoot);
  try {
    const node = graph.nodes.find(
      (candidate) =>
        candidate.type === "ExecutionPlan" && candidate.provenance.iteration_id === ctx.iterationId,
    );
    if (node === undefined) return undefined;
    return { node, content: readExecutionPlanContent(node) };
  } finally {
    graph.close();
  }
}

function loadBundleRecord(ctx: PipelineContext): ContextBundleRecord | undefined {
  const digest = ctx.workingState.context_bundle_digest;
  if (digest === undefined) return undefined;
  const directory = resolveHarnessPath(harnessRoot(ctx.deps), "artifacts/context-bundles");
  if (!existsSync(directory)) return undefined;
  for (const name of readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .sort()) {
    const record = readJsonArtifact<ContextBundleRecord>(
      ctx.deps,
      `artifacts/context-bundles/${name}`,
    );
    if (record?.digest === digest) return record;
  }
  return undefined;
}

function runResultArtifactPath(runId: string): string {
  return `artifacts/run-results/${runId}.json`;
}

function runNodeArtifactPath(runId: string): string {
  return `artifacts/run-nodes/${runId}.json`;
}

/**
 * Commit the Execution-Graph Run node for a run id (idempotent). RESUMES
 * edges bind run ids, so every run must exist as a graph node before the
 * integrity check materializes the ledger.
 */
async function commitRunNode(ctx: PipelineContext, runId: string): Promise<void> {
  const path = runNodeArtifactPath(runId);
  if (artifactExists(ctx.deps, path)) return;
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
  await commitArtifacts(ctx.deps, ctx.workflowOperationId, currentAttemptId(ctx), [
    { path, content: `${canonicalizeJson(node)}\n` },
  ]);
}

function loadCompletedRun(
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

interface VerifyPhaseArtifact {
  readonly record_kind: "orchestration_verify_result";
  readonly iteration_id: string;
  readonly bindings: {
    readonly artifact_digests: readonly string[];
    readonly code_digests: readonly string[];
    readonly context_bundle_digest?: string;
    readonly evaluation_case_digests: readonly string[];
    readonly policy_digest: string;
  };
  readonly results: readonly {
    readonly gate_id: string;
    readonly passed: boolean;
    readonly evidence_id: string;
    readonly summary: string;
  }[];
  readonly findings: readonly { readonly id: string; readonly summary: string }[];
  readonly completed_allowed: boolean;
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
    if (artifact !== undefined && bindingsEqual(artifact.bindings, bindings)) return artifact;
  }
  return undefined;
}

function bindingsEqual(
  left: VerifyPhaseArtifact["bindings"],
  right: VerifyPhaseArtifact["bindings"],
): boolean {
  return (
    JSON.stringify(left.artifact_digests) === JSON.stringify(right.artifact_digests) &&
    JSON.stringify(left.code_digests) === JSON.stringify(right.code_digests) &&
    left.context_bundle_digest === right.context_bundle_digest &&
    JSON.stringify(left.evaluation_case_digests) ===
      JSON.stringify(right.evaluation_case_digests) &&
    left.policy_digest === right.policy_digest
  );
}

interface EvaluatePhaseArtifact {
  readonly record_kind: "orchestration_evaluate_result";
  readonly iteration_id: string;
  readonly run_digest: string;
  readonly result: EvaluationPortResult;
}

function evaluateArtifactPath(iterationId: string, runDigest: string): string {
  return `artifacts/evaluate/${iterationId}/${runDigest}.json`;
}

/** Committed evaluations of an iteration, oldest path first. */
function loadEvaluateArtifacts(
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

function effectivePolicy(): EffectivePolicy {
  const merged = mergePolicyLayers([]);
  if (merged.conflicts.length > 0) {
    throw new OrchestrationError("configuration", merged.conflicts.join("; "));
  }
  return merged.effective;
}

async function commitIterationNode(
  ctx: PipelineContext,
  iterationState: "completed" | "blocked" | "aborted",
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
async function blockWithSnapshot(
  ctx: PipelineContext,
  spec: {
    readonly reason: RecoverableBlockReason;
    readonly detail: string;
    readonly resumePhase: OrchestrationPhase;
    readonly input: Omit<
      Parameters<typeof buildSnapshot>[0],
      "snapshot_id" | "created_at" | "block_reason" | "resume_phase" | "final_commit"
    >;
  },
): Promise<OrchestrationOutcome> {
  const partial = {
    ...spec.input,
    snapshot_id: "snapshot_pending",
    final_commit: ctx.deps.readBaseline(),
    created_at: nowOf(ctx.deps),
    block_reason: spec.reason,
    resume_phase: spec.resumePhase,
  };
  const blockerSeed = snapshotCompletionBlockers(partial).join(";");
  const snapshot = buildSnapshot({
    ...spec.input,
    snapshot_id: `snapshot_${sha256Hex(`${ctx.iterationId}:${spec.reason}:${spec.detail}:${blockerSeed}`).slice(0, 16)}`,
    final_commit: ctx.deps.readBaseline(),
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

type PhaseStep =
  | { readonly continue: true }
  | { readonly continue: false; readonly outcome: OrchestrationOutcome };

async function phaseCapture(ctx: PipelineContext): Promise<PhaseStep> {
  const { deps } = ctx;
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

async function phaseImpact(ctx: PipelineContext): Promise<PhaseStep> {
  const { deps } = ctx;
  const frozen = loadFrozenImpactSet(ctx);
  if (frozen !== undefined) {
    ctx.impactSet = frozen;
    await ctx.engine.commitCheckpoint(ctx.workflowOperationId, {
      boundary: PHASE_CHECKPOINT_BOUNDARY.impact,
      proposal: { phase: "plan" },
    });
    refreshWorkingState(ctx);
    return { continue: true };
  }
  const graph = materializeProjectGraph(deps.projectRoot);
  let impactSet: NodeRecord;
  try {
    const seed: ChangeSeed = {
      id: `seed_${sha256Hex(`${ctx.proposal.intent.id}:${ctx.iterationKind}`).slice(0, 16)}`,
      nodeId: ctx.proposal.intent.id,
      kind: "content-change",
      iterationKind: ctx.iterationKind,
      reason: `requirement baseline intent ${ctx.proposal.intent.id} drives this iteration`,
    };
    impactSet = generateImpactSet([seed], [...graph.nodes], [...graph.edges], {
      iterationId: ctx.iterationId,
      actor: "workflow-engine",
      timestamp: nowOf(deps),
    });
  } finally {
    graph.close();
  }
  // Persist the proposed revision before any approval is awaited; the frozen
  // revision lands only after the approval decision (revisions must stay
  // contiguous for graph integrity, and ledger artifacts are immutable files,
  // so each revision gets its own path).
  const impactSetPath = `artifacts/impact-sets/${impactSet.id}/1.json`;
  if (!artifactExists(deps, impactSetPath)) {
    await commitArtifacts(deps, ctx.workflowOperationId, currentAttemptId(ctx), [
      { path: impactSetPath, content: `${canonicalizeJson(impactSet)}\n` },
    ]);
  }
  const proposedContent = readImpactSetContent(impactSet);
  const approval = await ensureApproval(ctx, {
    objectId: impactSet.id,
    objectType: "ImpactSet",
    objectDigest: proposedContent.content_digest,
    risk: "medium",
    reason: "freeze the impact set before declarative planning",
    resumePhase: "impact",
  });
  if (approval.status === "required")
    return {
      continue: false,
      outcome: { status: "approval_required", required: approval.required },
    };
  if (approval.status === "rejected") {
    return { continue: false, outcome: await rejectOperation(ctx, "impact set rejected") };
  }
  const frozenSet = freezeImpactSet(impactSet, approval.approvalDigest);
  await commitArtifacts(deps, ctx.workflowOperationId, currentAttemptId(ctx), [
    {
      path: `artifacts/impact-sets/${frozenSet.id}/${String(frozenSet.revision)}.json`,
      content: `${canonicalizeJson(frozenSet)}\n`,
    },
  ]);
  ctx.impactSet = frozenSet;
  await ctx.engine.commitCheckpoint(ctx.workflowOperationId, {
    boundary: PHASE_CHECKPOINT_BOUNDARY.impact,
    proposal: { phase: "plan" },
  });
  refreshWorkingState(ctx);
  return { continue: true };
}

function taskSpecificationFor(
  ctx: PipelineContext,
  impactSet: NodeRecord,
  gateIds: readonly string[],
): TaskSpecification {
  const content = readImpactSetContent(impactSet);
  const outputs = ctx.proposal.requirements.map((requirement) => requirement.id);
  const specification: TaskSpecification = {
    id: `task_${contentDigest({ goal: ctx.goal, outputs: [...outputs].sort() }).slice(0, 16)}`,
    objective: ctx.goal,
    impact_paths: content.entries.map((entry) => [...entry.path]),
    expected_outputs: outputs,
    capabilities: [],
    tools: [],
    dependencies: [],
    risk: "low",
    budget: { steps: 30, tokens: 120000 },
    acceptance: ctx.proposal.requirements.flatMap((requirement) =>
      requirement.acceptance.map((criterion) => ({ ...criterion })),
    ),
    required_gates: [...gateIds],
  };
  return specification;
}

async function phasePlan(ctx: PipelineContext, gateIds: readonly string[]): Promise<PhaseStep> {
  const { deps } = ctx;
  const existing = loadPlan(ctx);
  if (existing !== undefined) {
    ctx.plan = existing;
    await ctx.engine.commitCheckpoint(ctx.workflowOperationId, {
      boundary: PHASE_CHECKPOINT_BOUNDARY.plan,
      proposal: { phase: "context" },
    });
    refreshWorkingState(ctx);
    return { continue: true };
  }
  const impactSet = ctx.impactSet ?? loadFrozenImpactSet(ctx);
  if (impactSet === undefined) {
    throw new OrchestrationError("binding_drift", "plan phase requires a frozen impact set");
  }
  ctx.impactSet = impactSet;
  const approvedDigest = readImpactSetContent(impactSet).content_digest;
  const specification = taskSpecificationFor(ctx, impactSet, gateIds);
  const records = generateExecutionPlan(
    impactSet,
    approvedDigest,
    {
      intentShape: ctx.intentShape,
      hasExistingGraph: true,
      deterministicWork: ctx.deterministicWork,
      shared: {
        goal: ctx.goal,
        requirement_baseline_digest: ctx.baselineDigest,
        policy_digest: ctx.workingState.policy_digest,
      },
      proposal: [specification as unknown as Record<string, unknown>],
      constraints: { allowedCapabilities: [], knownTools: [], knownGates: gateIds },
    },
    { iterationId: ctx.iterationId, actor: "workflow-engine", timestamp: nowOf(deps) },
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
    [...records.edges],
  );
  ctx.plan = { node: records.plan, content: readExecutionPlanContent(records.plan) };
  await ctx.engine.commitCheckpoint(ctx.workflowOperationId, {
    boundary: PHASE_CHECKPOINT_BOUNDARY.plan,
    proposal: { phase: "context" },
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
  const stored = loadBundleRecord(ctx);
  if (stored !== undefined) {
    ctx.bundle = stored;
    await ctx.engine.commitCheckpoint(ctx.workflowOperationId, {
      boundary: PHASE_CHECKPOINT_BOUNDARY.context,
      proposal: { phase: "execute" },
    });
    refreshWorkingState(ctx);
    return { continue: true };
  }
  const graph = materializeProjectGraph(deps.projectRoot);
  let compiled: CompiledContextBundle;
  try {
    const candidates: ContextCandidate[] = [];
    const wanted = new Set([
      ctx.proposal.intent.id,
      ...ctx.proposal.requirements.map((requirement) => requirement.id),
      plan.node.id,
    ]);
    for (const node of graph.nodes) {
      if (!wanted.has(node.id)) continue;
      candidates.push({
        node,
        content: canonicalizeJson(node),
        tier: node.type === "ExecutionPlan" ? 2 : 1,
        reason: `${node.type} ${node.id} binds this iteration`,
      });
    }
    compiled = compileContextBundle({
      taskId: plan.content.tasks[0]?.id ?? "task_unknown",
      goal: ctx.goal,
      bindings: {
        requirement_baseline_digest: ctx.baselineDigest,
        policy_digest: ctx.workingState.policy_digest,
        plan_digest: plan.content.content_digest,
        approval_digests: ctx.workingState.approval_digests,
      },
      tokenBudget: deps.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
      candidates,
    });
  } finally {
    graph.close();
  }
  await commitArtifacts(deps, ctx.workflowOperationId, currentAttemptId(ctx), [
    {
      path: `artifacts/context-bundles/${compiled.record.context_bundle_id}.json`,
      content: `${canonicalizeJson(compiled.record)}\n`,
    },
  ]);
  ctx.bundle = compiled.record;
  await ctx.engine.commitCheckpoint(ctx.workflowOperationId, {
    boundary: PHASE_CHECKPOINT_BOUNDARY.context,
    proposal: { phase: "execute", set_context_bundle_digest: compiled.record.digest },
    events: phaseLifecycleEvents({
      phase: "context",
      contextBundleId: compiled.record.context_bundle_id,
      contextBundleDigest: compiled.record.digest,
      includedTokens: compiled.manifest.included_tokens,
    }),
  });
  refreshWorkingState(ctx);
  return { continue: true };
}

function buildEnvelope(ctx: PipelineContext): {
  readonly envelope: TaskEnvelope;
  readonly grantDigest: string;
} {
  const plan = ctx.plan;
  const bundle = ctx.bundle;
  if (plan === undefined || bundle === undefined) {
    throw new OrchestrationError(
      "binding_drift",
      "execute phase requires a plan and a context bundle",
    );
  }
  const task = plan.content.tasks[0];
  if (task === undefined) {
    throw new OrchestrationError("configuration", "execution plan carries no tasks");
  }
  const policy = effectivePolicy();
  const loopPolicy = resolveLoopPolicy(policy);
  const grant = issueGrant(
    {
      grant_id: `grant_${contentDigest({ task: task.id, iteration: ctx.iterationId }).slice(0, 16)}`,
      task_id: task.id,
      capabilities: [],
      read_paths: [],
      write_paths: [],
      phase: "execute",
      budget: { steps: loopPolicy.max_steps, tokens: loopPolicy.max_tokens },
      approval_digests: ctx.workingState.approval_digests,
    },
    policy,
  );
  const envelope = buildTaskEnvelope({
    task_id: task.id,
    plan_id: plan.node.id,
    iteration_id: ctx.iterationId,
    repository_id: readManagedManifest(ctx.deps.projectRoot).repository_id,
    baseline_id: `baseline_${ctx.workingState.baseline_commit.slice(0, 12)}`,
    objective: task.objective,
    expected_output: task.expected_outputs.join(", "),
    acceptance_criteria: task.acceptance.map((criterion) => criterion.description),
    dependency_task_ids: [],
    required_gate_ids: [...task.required_gates],
    input_node_revisions: { [ctx.proposal.intent.id]: 1 },
    context_bundle_id: bundle.context_bundle_id,
    context_bundle_digest: bundle.digest,
    protected_context_fields: [],
    allowed_read_paths: [],
    proposed_write_paths: [],
    state_read_fields: [],
    state_proposal_fields: [],
    tools: [],
    risk: "low",
    required_approval_digests: ctx.workingState.approval_digests,
    external_side_effect: "forbidden",
    idempotency_scope: `iteration/${ctx.iterationId}/task/${task.id}`,
    loop_policy: loopPolicy,
    baseline_commit: ctx.workingState.baseline_commit,
    input_digest: bundle.digest,
    stale_input_behavior: "recompile",
  });
  return { envelope, grantDigest: grant.digest };
}

function mapRunFailure(
  result: AgentRunResult,
):
  | { readonly reason: RecoverableBlockReason; readonly resumePhase: OrchestrationPhase }
  | { readonly abort: AbortReason } {
  switch (result.outcome) {
    case "correct_block":
      return { abort: "policy_violation" };
    case "partial":
      return { reason: "budget_ceiling", resumePhase: "execute" };
    case "clarification_required":
      return { reason: "missing_input", resumePhase: "capture" };
    case "handoff":
      return { reason: "missing_input", resumePhase: "execute" };
    default:
      return { reason: "transient_environment_failure", resumePhase: "execute" };
  }
}

async function phaseExecute(ctx: PipelineContext): Promise<PhaseStep> {
  const { deps } = ctx;
  const plan = ctx.plan ?? loadPlan(ctx);
  if (plan === undefined)
    throw new OrchestrationError("binding_drift", "execute phase requires a plan");
  ctx.plan = plan;
  const storedBundle = ctx.bundle ?? loadBundleRecord(ctx);
  if (storedBundle !== undefined) ctx.bundle = storedBundle;
  const task = plan.content.tasks[0];
  if (task === undefined) throw new OrchestrationError("configuration", "plan carries no tasks");

  const completed = loadCompletedRun(ctx, task.id);
  if (completed !== undefined && completed.result.completion_claimed) {
    // A claimed run whose committed evaluation failed must be re-executed
    // (the evaluation phase blocked back into execute); any other claimed
    // run is final and the phase is a no-op on re-entry.
    const completedDigest = sha256Hex(canonicalizeJson(completed.result));
    const failedEvaluation = loadEvaluateArtifacts(deps, ctx.iterationId).some(
      (artifact) => artifact.run_digest === completedDigest && !artifact.result.passed,
    );
    if (!failedEvaluation) {
      ctx.run = completed;
      await ctx.engine.commitCheckpoint(ctx.workflowOperationId, {
        boundary: PHASE_CHECKPOINT_BOUNDARY.execute,
        proposal: { phase: "verify" },
      });
      refreshWorkingState(ctx);
      return { continue: true };
    }
  }

  const executor = deps.execute ?? createDirectExecutor();
  const built = buildEnvelope(ctx);
  const envelope = built.envelope;
  ctx.envelope = envelope;
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
    });
    activeRunId = started.run_id;
    await commitRunNode(ctx, activeRunId);
  }
  // A throw here is a process-level crash: no terminal record is written and
  // resume reconciles the open run. Typed failures come back as results.
  const result = await executor(envelope as AgentTaskEnvelope);
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
  await commitArtifacts(deps, ctx.workflowOperationId, currentAttemptId(ctx), [
    {
      path: runResultArtifactPath(activeRunId),
      content: `${canonicalizeJson(result)}\n`,
    },
  ]);
  ctx.run = { runId: activeRunId, result };

  if (!(result.outcome === "handoff" && result.completion_claimed)) {
    const failure = mapRunFailure(result);
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

  await ctx.engine.commitCheckpoint(ctx.workflowOperationId, {
    boundary: PHASE_CHECKPOINT_BOUNDARY.execute,
    proposal: { phase: "verify", add_capability_grants: [built.grantDigest] },
    events: phaseLifecycleEvents({
      phase: "execute",
      taskId: task.id,
      runId: activeRunId,
      outcome: result.outcome,
    }),
  });
  refreshWorkingState(ctx);
  return { continue: true };
}

function verifyBindings(ctx: PipelineContext): VerifyPhaseArtifact["bindings"] {
  // Resolve bindings from the ledger, not from in-memory phase state, so a
  // resumed drive computes the exact same binding set as the original one.
  const impactSet = ctx.impactSet ?? loadFrozenImpactSet(ctx);
  if (impactSet !== undefined) ctx.impactSet = impactSet;
  const plan = ctx.plan ?? loadPlan(ctx);
  if (plan !== undefined) ctx.plan = plan;
  const bundle = ctx.bundle ?? loadBundleRecord(ctx);
  if (bundle !== undefined) ctx.bundle = bundle;
  const planDigest = plan?.content.content_digest;
  return {
    artifact_digests: [
      ctx.baselineDigest,
      ...(planDigest === undefined ? [] : [planDigest]),
      ...(impactSet === undefined ? [] : [readImpactSetContent(impactSet).content_digest]),
    ].sort(),
    code_digests: [hashWorktreeCode(ctx.deps.projectRoot)],
    ...(bundle === undefined ? {} : { context_bundle_digest: bundle.digest }),
    evaluation_case_digests: [],
    policy_digest: ctx.workingState.policy_digest,
  };
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
    // instead of re-running gates and duplicating evidence.
    summary = stored;
  } else {
    outcome = await runGateSuite(registry, {
      iterationId: ctx.iterationId,
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
    await commitArtifacts(deps, ctx.workflowOperationId, currentAttemptId(ctx), [
      ...outcome.results.map((result) => ({
        path: `artifacts/evidence/${result.evidence.evidence_id}/${result.evidence.digest}.json`,
        content: `${canonicalizeJson(result.evidence)}\n`,
      })),
      ...outcome.findings.map((finding) => ({
        path: `artifacts/findings/${finding.id}/proposed.json`,
        content: `${canonicalizeJson(finding)}\n`,
      })),
      {
        path: verifyArtifactPath(ctx.iterationId, bindings),
        content: `${canonicalizeJson(summary)}\n`,
      },
    ]);
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
      gates: summary.results.map((result) => ({ gateId: result.gate_id, passed: result.passed })),
    }),
  });
  refreshWorkingState(ctx);
  return { continue: true };
}

async function phaseEvaluate(ctx: PipelineContext): Promise<PhaseStep> {
  const { deps } = ctx;
  const plan = ctx.plan ?? loadPlan(ctx);
  if (plan === undefined)
    throw new OrchestrationError("binding_drift", "evaluate phase requires a plan");
  ctx.plan = plan;
  const task = plan.content.tasks[0];
  if (task === undefined) throw new OrchestrationError("configuration", "plan carries no tasks");
  const run = ctx.run ?? loadCompletedRun(ctx, task.id);
  if (run === undefined) {
    throw new OrchestrationError("binding_drift", "evaluate phase requires a terminated run");
  }
  ctx.run = run;
  const runDigest = sha256Hex(canonicalizeJson(run.result));
  const stored = loadEvaluateArtifacts(deps, ctx.iterationId).find(
    (artifact) => artifact.run_digest === runDigest,
  );
  let result: EvaluationPortResult;
  if (stored !== undefined) {
    // Same run, same verdict: replay the committed evaluation.
    result = stored.result;
  } else {
    const port = deps.evaluate ?? createDefaultEvaluationPort();
    result = await port({
      taskId: task.id,
      iterationId: ctx.iterationId,
      run: run.result,
      visibility: deps.trajectoryVisibility ?? "external-only",
      budget: {
        max_steps: ctx.envelope?.loop_policy.max_steps ?? 30,
        max_tokens: ctx.envelope?.loop_policy.max_tokens ?? 120000,
        max_duration_ms: ctx.envelope?.loop_policy.max_duration_ms ?? 2700000,
      },
      now: nowOf(deps),
    });
    await commitArtifacts(deps, ctx.workflowOperationId, currentAttemptId(ctx), [
      {
        path: `artifacts/evaluations/${result.evidenceId}/${String(result.record["digest"])}.json`,
        content: `${canonicalizeJson(result.record)}\n`,
      },
      ...result.findings.map((finding) => {
        const content = {
          protocol_version: PROTOCOL_VERSION,
          record_kind: "feedback",
          id: finding.id,
          type: "Finding",
          iteration_id: ctx.iterationId,
          status: "proposed",
          summary: finding.summary,
          created_at: nowOf(deps),
        };
        const record = { ...content, digest: contentDigest(content) };
        const validation = validateSchema("feedback", record);
        if (!validation.valid) {
          throw new OrchestrationError(
            "configuration",
            `invalid evaluation finding record: ${validation.errors
              .map((issue) => issue.message)
              .join("; ")}`,
          );
        }
        return {
          path: `artifacts/findings/${finding.id}/proposed.json`,
          content: `${canonicalizeJson(record)}\n`,
        };
      }),
      {
        path: evaluateArtifactPath(ctx.iterationId, runDigest),
        content: `${canonicalizeJson({
          record_kind: "orchestration_evaluate_result",
          iteration_id: ctx.iterationId,
          run_digest: runDigest,
          result,
        } satisfies EvaluatePhaseArtifact)}\n`,
      },
    ]);
  }
  ctx.evaluation = result;

  if (!result.passed) {
    const outcome = await blockWithSnapshot(ctx, {
      reason: "repairable_gate_failure",
      detail: `evaluation failed: ${result.summary}`,
      resumePhase: "execute",
      input: snapshotBaseInput(ctx, [
        { task_id: task.id, required: true, outcome: run.result.outcome },
      ]),
    });
    return { continue: false, outcome };
  }

  await ctx.engine.commitCheckpoint(ctx.workflowOperationId, {
    boundary: PHASE_CHECKPOINT_BOUNDARY.evaluate,
    proposal: { phase: "snapshot" },
    events: phaseLifecycleEvents({
      phase: "evaluate",
      caseId: result.evidenceId,
      passed: result.passed,
      findingIds: result.findings.map((finding) => finding.id),
    }),
  });
  refreshWorkingState(ctx);
  return { continue: true };
}

function snapshotBaseInput(
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
  "snapshot_id" | "created_at" | "block_reason" | "resume_phase" | "final_commit"
> {
  return {
    iteration_id: ctx.iterationId,
    workflow_operation_id: ctx.workflowOperationId,
    tasks,
    approvals: ctx.workingState.approval_digests,
    budget: ctx.workingState.budget,
  };
}

async function phaseSnapshot(ctx: PipelineContext): Promise<PhaseStep> {
  const { deps } = ctx;
  const plan = ctx.plan ?? loadPlan(ctx);
  if (plan === undefined)
    throw new OrchestrationError("binding_drift", "snapshot phase requires a plan");
  ctx.plan = plan;
  const task = plan.content.tasks[0];
  if (task === undefined) throw new OrchestrationError("configuration", "plan carries no tasks");
  const run = ctx.run ?? loadCompletedRun(ctx, task.id);
  if (run === undefined)
    throw new OrchestrationError("binding_drift", "snapshot phase requires a run");
  ctx.run = run;
  const gates = ctx.gateOutcome;
  const evaluation = ctx.evaluation;
  const success =
    run.result.completion_claimed &&
    (gates === undefined || gates.completed_allowed) &&
    (evaluation?.passed ?? false);

  const verifyStored = loadVerifyArtifact(deps, ctx.iterationId, verifyBindings(ctx));
  const snapshot = buildSnapshot({
    ...snapshotBaseInput(ctx, [
      { task_id: task.id, required: true, outcome: success ? "success" : run.result.outcome },
    ]),
    snapshot_id: `snapshot_${sha256Hex(`${ctx.iterationId}:completed`).slice(0, 16)}`,
    final_commit: deps.readBaseline(),
    created_at: nowOf(deps),
    ...(plan === undefined ? {} : { execution_plan_id: plan.node.id }),
    runs: [
      { run_id: run.runId, required: true, outcome: success ? "success" : run.result.outcome },
    ],
    findings: [
      ...(verifyStored?.findings ?? []).map((finding) => ({
        finding_id: finding.id,
        blocking: true,
        status: "closed" as const,
      })),
      ...(evaluation?.findings ?? []).map((finding) => ({
        finding_id: finding.id,
        blocking: true,
        status: "proposed" as const,
      })),
    ],
    evidence: [
      ...(verifyStored?.results ?? []).map((result) => ({
        evidence_id: result.evidence_id,
        mandatory: true,
        passed: result.passed,
        provisional: false,
        stale: false,
      })),
      ...(evaluation === undefined
        ? []
        : [
            {
              evidence_id: evaluation.evidenceId,
              mandatory: true,
              passed: evaluation.passed,
              provisional: false,
              stale: false,
            },
          ]),
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
  await ctx.engine.advance(ctx.workflowOperationId, "completed");
  let finalCommit = deps.readBaseline();
  if (deps.vcs !== undefined) {
    const committed = await deps.vcs.commit(deps.projectRoot, {
      message: `harness: record iteration ${ctx.iterationId}`,
      paths: [".harness"],
      identity: HARNESS_COMMIT_IDENTITY,
    });
    if (committed.ok) finalCommit = committed.value;
  }
  return {
    continue: false,
    outcome: {
      status: "completed",
      workflowOperationId: ctx.workflowOperationId,
      iterationId: ctx.iterationId,
      snapshotId: snapshot.snapshot_id,
      finalCommit,
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
    phase === "capture" || phase === "impact"
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

async function drivePipeline(
  ctx: PipelineContext,
  fromPhase: OrchestrationPhase,
  untilPhase: OrchestrationPhase | undefined,
): Promise<OrchestrationOutcome> {
  const suite =
    ctx.deps.gates === undefined
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
  let completedPhase: OrchestrationPhase | undefined;
  for (const phase of ORCHESTRATION_PHASES.slice(phaseRank(fromPhase))) {
    if (untilPhase !== undefined && phaseRank(phase) > phaseRank(untilPhase)) {
      return {
        status: "advanced",
        workflowOperationId: ctx.workflowOperationId,
        iterationId: ctx.iterationId,
        completedPhase: completedPhase ?? fromPhase,
      };
    }
    await advanceIntoPhase(ctx, phase);
    let step: PhaseStep;
    switch (phase) {
      case "capture":
        step = await phaseCapture(ctx);
        break;
      case "impact":
        step = await phaseImpact(ctx);
        break;
      case "plan":
        step = await phasePlan(
          ctx,
          suite.gates.map((gate) => gate.gate_id),
        );
        break;
      case "context":
        step = await phaseContext(ctx);
        break;
      case "execute":
        step = await phaseExecute(ctx);
        break;
      case "verify":
        step = await phaseVerify(ctx, suite.gates, suite.registry);
        break;
      case "evaluate":
        step = await phaseEvaluate(ctx);
        break;
      case "snapshot":
        step = await phaseSnapshot(ctx);
        break;
    }
    if (!step.continue) return step.outcome;
    completedPhase = phase;
  }
  throw new OrchestrationError("configuration", "pipeline ended without a snapshot");
}

async function buildPipelineContext(
  deps: OrchestratorDependencies,
  workflowOperationId: string,
  iterationId: string,
  input: RunIterationInput,
): Promise<PipelineContext | { readonly outcome: OrchestrationOutcome }> {
  const engine = new WorkflowEngine(workflowDeps(deps));
  const workingState = engine.getWorkingState(workflowOperationId);
  if (workingState === undefined) {
    throw new OrchestrationError(
      "operation_not_found",
      `workflow operation ${workflowOperationId} has no working state`,
    );
  }
  const captured = await captureProposal(deps, workingState.goal);
  if (captured.status === "clarification_required") {
    return { outcome: { status: "input_required", questions: captured.questions } };
  }
  const baselineDigest = requirementBaselineDigest(captured.proposal);
  if (baselineDigest !== workingState.requirement_baseline_digest) {
    throw new OrchestrationError(
      "binding_drift",
      "re-derived requirement baseline digest no longer matches the approved checkpoint binding",
    );
  }
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
  };
}

/**
 * Open a new workflow operation for one intent and drive the phase pipeline
 * until completion, a phase limit, or a mandatory pause (input, approval or
 * external authorization).
 */
export async function runIteration(
  deps: OrchestratorDependencies,
  input: RunIterationInput,
): Promise<OrchestrationOutcome> {
  const open = findOpenWorkflowOperation(deps.projectRoot, deps.readBaseline);
  if (open !== undefined) {
    throw new OrchestrationError(
      "operation_already_open",
      `workflow operation ${open} is still open; resume or abort it before starting a new iteration`,
    );
  }
  const captured = await captureProposal(deps, input.intent);
  if (captured.status === "clarification_required") {
    return { status: "input_required", questions: captured.questions };
  }
  const policy = effectivePolicy();
  const engine = new WorkflowEngine(workflowDeps(deps));
  const started = await engine.startOperation({
    projectId: `project_${readManagedManifest(deps.projectRoot).name}`,
    iterationId:
      input.iterationId ??
      `iteration_${sha256Hex(`${input.intent}:${String(readCommittedOperations(harnessRoot(deps)).length)}`).slice(0, 16)}`,
    goal: input.intent,
    baselineCommit: deps.readBaseline(),
    requirementBaselineDigest: requirementBaselineDigest(captured.proposal),
    policyDigest: policy.digest,
    phase: "capture",
    budgetCeiling: { steps: 30, tokens: 120000 },
  });
  const context = await buildPipelineContext(
    deps,
    started.operation.workflow_operation_id,
    started.operation.iteration_id,
    input,
  );
  if ("outcome" in context) return context.outcome;
  return drivePipeline(context, "capture", input.untilPhase);
}

/**
 * Resume a paused or interrupted workflow operation from its last committed
 * checkpoint. Bindings are re-verified by the resume protocol first; every
 * phase output is then reloaded or deterministically re-derived, never
 * duplicated. An operation left in a resumable state by a process crash is
 * first blocked as a typed recovery, then reopened, so interrupted runs get
 * exactly one RunInterrupted record and one successor run.
 */
export async function resumeIteration(
  deps: OrchestratorDependencies,
  workflowOperationId: string,
  input: RunIterationInput | undefined,
): Promise<OrchestrationOutcome> {
  const engine = new WorkflowEngine(workflowDeps(deps));
  const current = engine.getOperation(workflowOperationId);
  if (current === undefined) {
    throw new OrchestrationError(
      "operation_not_found",
      `unknown workflow operation: ${workflowOperationId}`,
    );
  }
  if (current.state === "completed" || current.state === "aborted") {
    throw new OrchestrationError(
      "operation_not_found",
      `workflow operation ${workflowOperationId} is terminal (${current.state}) and cannot resume`,
    );
  }
  const intent = input?.intent ?? engine.getWorkingState(workflowOperationId)?.goal;
  if (intent === undefined) {
    throw new OrchestrationError(
      "operation_not_found",
      `workflow operation ${workflowOperationId} has no working state goal`,
    );
  }
  let resumedRuns: readonly {
    readonly interruptedRunId: string;
    readonly successorRunId: string;
  }[] = [];
  if (current.state === "blocked") {
    const resumed = await resumeWorkflowOperation(workflowDeps(deps), workflowOperationId);
    resumedRuns = resumed.resumedRuns;
  } else {
    // The operation is live but not blocked: either a decision was committed
    // while it was paused (nothing to reconcile -- drive on), or a process
    // died mid-attempt. A crash is first blocked with the typed recovery
    // reason, then reopened so interrupted runs get exactly one
    // RunInterrupted record and one successor run.
    const openRuns = readRunStreams(workflowDeps(deps), workflowOperationId).filter(
      (stream) => streamTerminalRecord(stream) === undefined,
    );
    if (openRuns.length > 0) {
      const state = engine.getWorkingState(workflowOperationId);
      await engine.block(workflowOperationId, {
        reason: "transient_environment_failure",
        detail:
          "recovered from an interrupted process; resuming from the last committed checkpoint",
        proposal: {
          ...(state === undefined ? {} : { phase: state.phase }),
          set_next_action: resumeCommandFor(workflowOperationId),
        },
      });
      const resumed = await resumeWorkflowOperation(workflowDeps(deps), workflowOperationId);
      resumedRuns = resumed.resumedRuns;
    }
  }
  const context = await buildPipelineContext(deps, workflowOperationId, current.iteration_id, {
    intent,
    ...(input?.iterationKind === undefined ? {} : { iterationKind: input.iterationKind }),
    ...(input?.intentShape === undefined ? {} : { intentShape: input.intentShape }),
    ...(input?.deterministicWork === undefined
      ? {}
      : { deterministicWork: input.deterministicWork }),
    ...(input?.untilPhase === undefined ? {} : { untilPhase: input.untilPhase }),
  });
  if ("outcome" in context) return context.outcome;
  // RESUMES edges bind run ids; both the interrupted run and its successor
  // must exist as Execution-Graph nodes before anything materializes.
  for (const resumed of resumedRuns) {
    await commitRunNode(context, resumed.interruptedRunId);
    await commitRunNode(context, resumed.successorRunId);
  }
  const phase = context.workingState.phase;
  if (!isOrchestrationPhase(phase)) {
    throw new OrchestrationError("invalid_phase", `checkpoint recorded unknown phase ${phase}`);
  }
  return drivePipeline(context, phase, input?.untilPhase);
}

/** The newest non-terminal workflow operation of a project, if any. */
export function findOpenWorkflowOperation(
  projectRoot: string,
  readBaseline: () => string,
): string | undefined {
  const operations = readCommittedOperations(harnessRootFor(projectRoot));
  const ids = [...new Set(operations.map((operation) => operation.manifest.workflow_operation_id))];
  for (const id of [...ids].reverse()) {
    const current = readCurrentOperation({ projectRoot, readBaseline }, id);
    if (current === undefined) continue;
    if (current.state !== "completed" && current.state !== "aborted") return id;
  }
  return undefined;
}

/** Drive the open workflow operation forward; the automation form of resume. */
export async function driveOpenOperation(
  deps: OrchestratorDependencies,
  untilPhase?: OrchestrationPhase,
): Promise<OrchestrationOutcome> {
  const workflowOperationId = findOpenWorkflowOperation(deps.projectRoot, deps.readBaseline);
  if (workflowOperationId === undefined) {
    throw new OrchestrationError(
      "no_open_operation",
      "no open workflow operation; start one with harness iterate",
    );
  }
  return resumeIteration(deps, workflowOperationId, {
    intent: "",
    ...(untilPhase === undefined ? {} : { untilPhase }),
  });
}

/** Resolve one pending approval request (design 11.3; never batch, never wildcard). */
export async function resolveApproval(
  deps: OrchestratorDependencies,
  input: {
    readonly requestId: string;
    readonly decision: ApprovalDecision;
    readonly actor: string;
  },
): Promise<{
  readonly requestId: string;
  readonly decision: ApprovalDecision;
  readonly approvalDigest: string;
  readonly workflowOperationId: string;
}> {
  const operations = readCommittedOperations(harnessRoot(deps));
  const workflowIds = [
    ...new Set(operations.map((operation) => operation.manifest.workflow_operation_id)),
  ].sort();
  let request: ApprovalRequestRecord | undefined;
  for (const workflowId of workflowIds) {
    const found = readApprovalRequests(harnessRoot(deps), operations, workflowId).find(
      (candidate) => candidate.request_id === input.requestId,
    );
    if (found !== undefined) request = found;
  }
  if (request === undefined) {
    throw new OrchestrationError(
      "operation_not_found",
      `unknown approval request: ${input.requestId}`,
    );
  }
  // A paused operation cannot accept the decision checkpoint; reopen it
  // first (the resume protocol re-verifies every binding) and leave it live
  // for the follow-up `resume` that continues the pipeline.
  const engine = new WorkflowEngine(workflowDeps(deps));
  const current = engine.getOperation(request.workflow_operation_id);
  if (current !== undefined && current.state === "blocked") {
    await resumeWorkflowOperation(workflowDeps(deps), request.workflow_operation_id);
  }
  const record = await approvalService(deps).resolveDecision({
    requestId: request.request_id,
    decision: input.decision,
    objectDigest: request.object_digest,
    actor: input.actor,
  });
  return {
    requestId: record.request_id,
    decision: record.decision,
    approvalDigest: approvalDigestOf(record),
    workflowOperationId: request.workflow_operation_id,
  };
}

/** Read-only impact preview over the current materialized graph. */
export function previewImpactSet(
  projectRoot: string,
  target?: string,
): {
  readonly impactSetId: string;
  readonly contentDigest: string;
  readonly seedNodeId: string;
  readonly entries: readonly {
    readonly node_id: string;
    readonly classification: string;
    readonly risk: string;
  }[];
} {
  const graph = materializeProjectGraph(projectRoot);
  try {
    let seedNodeId = target;
    if (seedNodeId === undefined) {
      const candidate = [...graph.nodes]
        .filter((node) => node.type === "Requirement" || node.type === "Intent")
        .sort((left, right) => (left.id < right.id ? -1 : 1))
        .at(-1);
      if (candidate === undefined) {
        throw new OrchestrationError(
          "operation_not_found",
          "no Intent or Requirement node to seed an impact preview",
        );
      }
      seedNodeId = candidate.id;
    }
    if (!graph.nodes.some((node) => node.id === seedNodeId)) {
      throw new OrchestrationError(
        "operation_not_found",
        `unknown impact seed node: ${seedNodeId}`,
      );
    }
    const seed: ChangeSeed = {
      id: `seed_${sha256Hex(`${seedNodeId}:preview`).slice(0, 16)}`,
      nodeId: seedNodeId,
      kind: "content-change",
      iterationKind: "feature",
      reason: "impact preview seed",
    };
    const impactSet = generateImpactSet([seed], [...graph.nodes], [...graph.edges], {
      iterationId: "iteration_preview",
      actor: "workflow-engine",
      timestamp: "1970-01-01T00:00:00.000Z",
    });
    const content = readImpactSetContent(impactSet);
    return {
      impactSetId: impactSet.id,
      contentDigest: content.content_digest,
      seedNodeId,
      entries: content.entries.map((entry) => ({
        node_id: entry.node_id,
        classification: entry.classification,
        risk: entry.risk,
      })),
    };
  } finally {
    graph.close();
  }
}

/** The latest committed ExecutionPlan of the project, if any. */
export function readLatestExecutionPlan(projectRoot: string):
  | {
      readonly planId: string;
      readonly mode: string;
      readonly impactSetId: string;
      readonly iterationId: string;
      readonly tasks: readonly {
        readonly id: string;
        readonly objective: string;
        readonly required_gates: readonly string[];
      }[];
    }
  | undefined {
  const graph = materializeProjectGraph(projectRoot);
  try {
    const node = [...graph.nodes]
      .filter((candidate) => candidate.type === "ExecutionPlan")
      .sort((left, right) => (left.id < right.id ? -1 : 1))
      .at(-1);
    if (node === undefined) return undefined;
    const content = readExecutionPlanContent(node);
    return {
      planId: node.id,
      mode: content.mode,
      impactSetId: content.impact_set_id,
      iterationId: node.provenance.iteration_id,
      tasks: content.tasks.map((task) => ({
        id: task.id,
        objective: task.objective,
        required_gates: task.required_gates,
      })),
    };
  } finally {
    graph.close();
  }
}

/** The latest committed snapshot record of the project, if any. */
export function readLatestSnapshot(projectRoot: string): SnapshotRecord | undefined {
  const directory = resolveHarnessPath(harnessRootFor(projectRoot), "artifacts/snapshots");
  if (!existsSync(directory)) return undefined;
  let latest: SnapshotRecord | undefined;
  for (const name of readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .sort()) {
    const parsed = JSON.parse(
      readFileSync(
        resolveHarnessPath(harnessRootFor(projectRoot), `artifacts/snapshots/${name}`),
        "utf8",
      ),
    ) as SnapshotRecord;
    if (latest === undefined || parsed.created_at > latest.created_at) latest = parsed;
  }
  return latest;
}
