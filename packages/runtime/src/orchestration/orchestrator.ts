import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  LedgerRepository,
  PROTOCOL_VERSION,
  canonicalizeJson,
  canonicalizeLocator,
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
import { auditGraph, type AuditFinding, type AuditReport } from "../audit/auditor.js";
import {
  artifactContentForNode,
  artifactPathForNode,
  edgeRecord,
  scannedNodeRecord,
  type RecordContext,
} from "../bootstrap/records.js";
import { scanWorktree } from "../bootstrap/scanner.js";
import {
  approvalDecisionArtifact,
  buildApprovalDecision,
  proposedByOf,
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
import { evidenceBindingsOf, type GateEvidenceRecord } from "../gates/evidence.js";
import { findingClosableBy, type CurrentEvidenceState } from "../gates/freshness.js";
import { runGateSuite, type GateSuiteOutcome } from "../gates/runner.js";
import { ProjectionError, writeManagedOutput } from "../projection/managed-output.js";
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
 * Structured clarification offer (comparative design direction 4, card T4):
 * an interpreter that judges the intent ambiguous returns the questions to
 * ask, each carrying 2-4 explicit options; the harness appends the `other`
 * escape and refuses malformed offers instead of silently completing
 * anything.
 */
export interface ClarificationOffer {
  readonly clarification: readonly ClarificationQuestion[];
}

/**
 * Restricted capture port (design 10.1): free-text intent enters the pipeline
 * only through semantic interpretation or a deterministic lossless Pack
 * conversion. Returning `undefined` means the intent cannot be captured and
 * the orchestrator pauses for mandatory input; returning a ClarificationOffer
 * pauses with structured, optioned questions.
 */
export type IntentInterpreter = (
  intent: string,
) =>
  | Promise<InterpretedIntent | ClarificationOffer | undefined>
  | InterpretedIntent
  | ClarificationOffer
  | undefined;

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

/**
 * Tasks projection port (design 13.7; comparative design direction 1):
 * renders the SpecKit-style task list from the authoritative graph at the
 * completing snapshot. The runtime cannot depend on projection adapters, so
 * the CLI wires the Markdown renderer and tests inject fakes; absent means
 * the snapshot skips regeneration.
 */
export type TasksProjectionPort = (
  graph: { readonly nodes: readonly NodeRecord[]; readonly edges: readonly EdgeRecord[] },
  options: { readonly completedTasks: readonly string[] },
) => { readonly markdown: string };

/** Project-approved repository path scope compiled into each task envelope. */
export type TaskEnvelopeScopePort = (task: TaskSpecification) => {
  readonly allowed_read_paths: readonly string[];
  readonly proposed_write_paths: readonly string[];
};

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
  readonly tasksProjection?: TasksProjectionPort;
  readonly planTasks?: PlanTasksPort;
  readonly taskEnvelopeScope?: TaskEnvelopeScopePort;
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

/**
 * Planner port (comparative design direction 3, card T2): turns the approved
 * intent into the task decomposition of one ExecutionPlan. The port proposes;
 * the harness still validates every specification through
 * `validatePlanProposal` (declarative shape, approved-path coverage,
 * acyclic DEPENDS_ON) before planning, so a bad decomposition is refused,
 * never executed. Absent, the deterministic default decomposes one task per
 * baseline requirement.
 */
export type PlanTasksPort = (input: {
  readonly goal: string;
  readonly requirements: readonly {
    readonly id: string;
    readonly statement: string;
    readonly acceptance: readonly { readonly description: string; readonly verification: string }[];
  }[];
  readonly impactPaths: readonly (readonly string[])[];
  readonly gateIds: readonly string[];
}) => readonly TaskSpecification[];

/**
 * Deterministic default decomposition: one small task per requirement of the
 * approved baseline, each independently verifiable through its own acceptance
 * slice, every task bound to the full approved impact set (the binding check
 * requires must-change coverage; path-level partitioning is the port's job).
 * With a single requirement this degenerates to exactly the historical
 * single-task plan, id and digest included.
 */
function taskSpecificationsFor(
  ctx: PipelineContext,
  impactSet: NodeRecord,
  gateIds: readonly string[],
): readonly TaskSpecification[] {
  const content = readImpactSetContent(impactSet);
  const impactPaths = content.entries.map((entry) => [...entry.path]);
  const requirements = ctx.proposal.requirements.map((requirement) => ({
    id: requirement.id,
    statement: requirement.statement,
    acceptance: requirement.acceptance.map((criterion) => ({ ...criterion })),
  }));
  if (ctx.deps.planTasks !== undefined) {
    return ctx.deps.planTasks({
      goal: ctx.goal,
      requirements,
      impactPaths,
      gateIds: [...gateIds],
    });
  }
  return requirements.map((requirement) => ({
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
    required_gates: [...gateIds],
  }));
}

function byId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Topological order over plan task specifications (Kahn, smallest ready id
 * first for determinism). `validatePlanProposal` already rejected cycles, so
 * every task is always orderable.
 */
function orderedPlanTasks(tasks: readonly TaskSpecification[]): readonly TaskSpecification[] {
  const byTaskId = new Map(tasks.map((task) => [task.id, task]));
  const indegree = new Map<string, number>(tasks.map((task) => [task.id, 0]));
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!byTaskId.has(dependency)) continue;
      indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), task.id]);
    }
  }
  const ready = tasks.map((task) => task.id).filter((id) => (indegree.get(id) ?? 0) === 0);
  ready.sort(byId);
  const ordered: TaskSpecification[] = [];
  while (ready.length > 0) {
    const next = ready.shift() as string;
    ordered.push(byTaskId.get(next) as TaskSpecification);
    for (const dependent of (dependents.get(next) ?? []).sort(byId)) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        const insertAt = ready.findIndex((id) => id > dependent);
        ready.splice(insertAt === -1 ? ready.length : insertAt, 0, dependent);
      }
    }
  }
  return ordered;
}

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
  const specifications = taskSpecificationsFor(ctx, impactSet, gateIds);
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
      proposal: specifications.map(
        (specification) => specification as unknown as Record<string, unknown>,
      ),
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
    [...records.edges, ...implementsEdgesFor(ctx, specifications, records.tasks)],
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

function buildEnvelope(
  ctx: PipelineContext,
  task: TaskSpecification,
): {
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
  const policy = effectivePolicy();
  const loopPolicy = resolveLoopPolicy(policy);
  const scope = ctx.deps.taskEnvelopeScope?.(task) ?? {
    allowed_read_paths: [],
    proposed_write_paths: [],
  };
  const grant = issueGrant(
    {
      grant_id: `grant_${contentDigest({ task: task.id, iteration: ctx.iterationId }).slice(0, 16)}`,
      task_id: task.id,
      capabilities: [],
      read_paths: scope.allowed_read_paths,
      write_paths: scope.proposed_write_paths,
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

/**
 * Mark a finished task accepted (card T2): the task node gains a revision
 * whose status is `accepted`, which is the graph-native signal status
 * derivation uses for task progress. Called after a claimed run and on the
 * re-entry skip path (a crash may have landed between the run and the
 * marking); already-accepted tasks are a no-op.
 */
async function markTaskAccepted(ctx: PipelineContext, taskId: string): Promise<void> {
  const { deps } = ctx;
  const graph = materializeProjectGraph(deps.projectRoot);
  let current: NodeRecord | undefined;
  try {
    current = graph.nodes
      .filter((node) => node.id === taskId && node.type === "Task")
      .sort((left, right) => left.revision - right.revision)
      .at(-1);
  } finally {
    graph.close();
  }
  if (current === undefined || current.status === "accepted") return;
  const revision = current.revision + 1;
  const base: Record<string, unknown> = Object.fromEntries(
    Object.entries(current).filter(([key]) => key !== "digest"),
  );
  base.revision = revision;
  base.status = "accepted";
  base.provenance = {
    iteration_id: ctx.iterationId,
    actor: "workflow-engine",
    timestamp: nowOf(deps),
  };
  const node = { ...base, digest: contentDigest(base) };
  const validation = validateSchema("node", node);
  if (!validation.valid) {
    throw new OrchestrationError(
      "configuration",
      `invalid accepted task node: ${validation.errors.map((issue) => issue.message).join("; ")}`,
    );
  }
  await commitArtifacts(deps, ctx.workflowOperationId, currentAttemptId(ctx), [
    {
      path: `artifacts/tasks/${taskId}/${String(revision)}.json`,
      content: `${canonicalizeJson(node)}\n`,
    },
  ]);
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
  const tasks = orderedPlanTasks(plan.content.tasks);
  if (tasks.length === 0) throw new OrchestrationError("configuration", "plan carries no tasks");

  // One run per task, in dependency order. A claimed run is final (unless its
  // committed evaluation failed), so a resume re-executes only the tasks that
  // never finished; the phase checkpoint lands once every task has one.
  const executor = deps.execute ?? createDirectExecutor();
  const grantDigests: string[] = [];
  let lastRun: { readonly runId: string; readonly result: AgentRunResult } | undefined;
  for (const task of tasks) {
    const completed = loadCompletedRun(ctx, task.id);
    if (completed !== undefined && completed.result.completion_claimed) {
      // A claimed run whose committed evaluation failed must be re-executed
      // (the evaluation phase blocked back into execute); any other claimed
      // run is final and the task is a no-op on re-entry.
      const completedDigest = sha256Hex(canonicalizeJson(completed.result));
      const failedEvaluation = loadEvaluateArtifacts(deps, ctx.iterationId).some(
        (artifact) => artifact.run_digest === completedDigest && !artifact.result.passed,
      );
      if (!failedEvaluation) {
        await markTaskAccepted(ctx, task.id);
        lastRun = completed;
        continue;
      }
    }

    const built = buildEnvelope(ctx, task);
    const envelope = built.envelope;
    ctx.envelope = envelope;
    grantDigests.push(built.grantDigest);
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
    lastRun = { runId: activeRunId, result };

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
    await markTaskAccepted(ctx, task.id);
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
      gates: summary.results.map((result) => ({ gateId: result.gate_id, passed: result.passed })),
    }),
  });
  refreshWorkingState(ctx);
  return { continue: true };
}

const AUDIT_FINDING_NODE_DIRECTORY = "artifacts/finding-nodes";

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

/**
 * Deterministic Finding identity for audit gaps: rule kind plus the summary
 * text (which carries the rule's target key, e.g. the subject node id or the
 * missing document domain). The same gap always derives the same id, so an
 * iterate re-run dedupes against the committed record instead of duplicating
 * it.
 */
function auditFindingId(finding: AuditFinding): string {
  const key = sha256Hex(`${finding.kind}\n${finding.summary}`).slice(0, 16);
  return `finding_audit-${finding.kind.replaceAll("_", "-")}-${key}`;
}

function invalidAuditRecord(
  kind: string,
  record: string,
  errors: readonly { message?: string }[],
): OrchestrationError {
  return new OrchestrationError(
    "configuration",
    `invalid audit ${kind} record ${record}: ${errors.map((issue) => issue.message ?? "?").join("; ")}`,
  );
}

interface AuditFindingArtifacts {
  readonly feedbackPath: string;
  readonly feedback: Record<string, unknown>;
  readonly nodePath: string;
  readonly node: Record<string, unknown>;
}

/**
 * Build the feedback record and Finding node for one audit gap. Both follow
 * the shared Finding/ImpactSet feedback protocol shapes (design 9.1), so the
 * gap enters the same cascade as gate and evaluation findings and ends as a
 * human-reviewed ImprovementCandidate -- the harness never writes the missing
 * document on its own authority.
 */
function buildAuditFindingArtifacts(
  ctx: PipelineContext,
  finding: AuditFinding,
  id: string,
): AuditFindingArtifacts {
  const { deps } = ctx;
  const feedbackPath = `artifacts/findings/${id}/proposed.json`;
  const auditExtension = { kind: finding.kind, subjects: [...finding.subjects] };
  // A non-blocking finding blocks nothing: no BLOCKS edge, empty subject.
  const blocks = finding.blocking ? [ctx.iterationId] : [];
  // The committed feedback record wins: a later iteration must reuse its
  // digest instead of resealing the same gap under a new timestamp.
  const committed = readJsonArtifact<Record<string, unknown>>(deps, feedbackPath);
  let feedback = committed;
  if (feedback === undefined) {
    const content: Record<string, unknown> = {
      protocol_version: PROTOCOL_VERSION,
      record_kind: "feedback",
      id,
      type: "Finding",
      iteration_id: ctx.iterationId,
      status: "proposed",
      summary: finding.summary,
      created_at: nowOf(deps),
      extensions: {
        "harness.finding": {
          origin: "audit",
          blocking: finding.blocking,
          violates: [],
          blocks,
          evidence: [],
        },
        "harness.audit": auditExtension,
      },
    };
    feedback = { ...content, digest: contentDigest(content) };
    const validation = validateSchema("feedback", feedback);
    if (!validation.valid) throw invalidAuditRecord("feedback", id, validation.errors);
  }
  const nodeContent: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "node",
    id,
    type: "Finding",
    revision: 1,
    status: "proposed",
    source: "audit",
    provenance: {
      iteration_id: ctx.iterationId,
      actor: "workflow-engine",
      timestamp: nowOf(deps),
    },
    confidence: 1,
    extensions: {
      "harness.finding": {
        feedback_digest: feedback["digest"],
        origin: "audit",
        blocking: finding.blocking,
        violates: [],
        blocks,
        evidence: [],
      },
      "harness.audit": auditExtension,
    },
  };
  const node = { ...nodeContent, digest: contentDigest(nodeContent) };
  const validation = validateSchema("node", node);
  if (!validation.valid) throw invalidAuditRecord("finding node", id, validation.errors);
  return {
    feedbackPath,
    feedback,
    nodePath: `${AUDIT_FINDING_NODE_DIRECTORY}/${id}/1.json`,
    node,
  };
}

/**
 * Task ids whose task-level quality record (card T5) is fresh and passing
 * (card T3): a record is fresh when its bound code digest still matches the
 * current worktree. The iterate audit hook and `harness audit` both feed
 * this set to the auditor, so `task_stale` never fires for a task whose
 * proof is current.
 */
export function provenQualityTaskIds(projectRoot: string): string[] {
  const root = resolveHarnessPath(harnessRootFor(projectRoot), "artifacts/quality");
  if (!existsSync(root)) return [];
  const codeHash = hashWorktreeCode(projectRoot);
  const proven = new Set<string>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const record = JSON.parse(readFileSync(absolute, "utf8")) as {
        task_id?: unknown;
        verdict?: unknown;
        bindings?: { code_digests?: unknown };
      };
      if (record.verdict !== "passed" || typeof record.task_id !== "string") continue;
      const codeDigests = record.bindings?.code_digests;
      if (Array.isArray(codeDigests) && codeDigests.includes(codeHash)) {
        proven.add(record.task_id);
      }
    }
  };
  walk(root);
  return [...proven].sort();
}

/**
 * Post-verify/evaluate graph audit (design 8.7 wired into the pipeline). The
 * completing snapshot re-runs the deterministic audit -- the same checks
 * `harness audit` reports -- and commits every gap as a proposed Finding
 * node; blocking gaps also get a BLOCKS edge to the just-completed Iteration
 * node, so they show up in `harness status` blockers and next_action without
 * a manual audit (non-blocking gaps surface as warnings). Finding ids are
 * content-derived (rule kind plus summary), so re-runs dedupe instead of
 * duplicating; a gap that no longer reproduces supersedes its committed
 * Finding instead of lingering as a phantom blocker.
 */
async function commitAuditFindings(ctx: PipelineContext): Promise<void> {
  const { deps } = ctx;
  const graph = materializeProjectGraph(deps.projectRoot);
  let report: AuditReport;
  let openAuditFindings: NodeRecord[];
  let committedEdgeIds: ReadonlySet<string>;
  let activeBlocksEdges: readonly EdgeRecord[];
  try {
    report = auditGraph(
      { nodes: graph.nodes, edges: graph.edges },
      { provenTaskIds: provenQualityTaskIds(deps.projectRoot) },
    );
    const latestFinding = new Map<string, NodeRecord>();
    for (const node of graph.nodes) {
      if (node.type !== "Finding" || node.source !== "audit") continue;
      const current = latestFinding.get(node.id);
      if (current === undefined || node.revision > current.revision) {
        latestFinding.set(node.id, node);
      }
    }
    openAuditFindings = [...latestFinding.values()].filter(
      (node) => node.status === "proposed" || node.status === "accepted",
    );
    committedEdgeIds = new Set(graph.edges.map((edge) => edge.id));
    activeBlocksEdges = graph.edges.filter(
      (edge) =>
        edge.type === "BLOCKS" && (edge.status === "proposed" || edge.status === "accepted"),
    );
  } finally {
    graph.close();
  }

  const artifacts: { readonly path: string; readonly content: string }[] = [];
  const edges: EdgeRecord[] = [];
  const liveFindingIds = new Set<string>();
  for (const finding of report.findings) {
    const id = auditFindingId(finding);
    liveFindingIds.add(id);
    const built = buildAuditFindingArtifacts(ctx, finding, id);
    if (!artifactExists(deps, built.feedbackPath)) {
      artifacts.push({
        path: built.feedbackPath,
        content: `${canonicalizeJson(built.feedback)}\n`,
      });
    }
    if (!artifactExists(deps, built.nodePath)) {
      artifacts.push({ path: built.nodePath, content: `${canonicalizeJson(built.node)}\n` });
    }
    if (!finding.blocking) continue;
    const edgeId = `edge_${sha256Hex(`BLOCKS:${id}:${ctx.iterationId}`).slice(0, 16)}`;
    if (committedEdgeIds.has(edgeId)) continue;
    const edgeContent: Record<string, unknown> = {
      protocol_version: PROTOCOL_VERSION,
      record_kind: "edge",
      id: edgeId,
      type: "BLOCKS",
      source_id: id,
      target_id: ctx.iterationId,
      status: "accepted",
      source: "audit",
      provenance: {
        iteration_id: ctx.iterationId,
        actor: "workflow-engine",
        timestamp: nowOf(deps),
      },
      confidence: 1,
    };
    const edge = { ...edgeContent, digest: contentDigest(edgeContent) };
    const validation = validateSchema("edge", edge);
    if (!validation.valid) throw invalidAuditRecord("edge", edgeId, validation.errors);
    edges.push(edge as unknown as EdgeRecord);
  }

  // A gap that no longer reproduces supersedes its committed Finding: the
  // deterministic re-check is the repair verdict for audit findings. The
  // finding's active BLOCKS edges retire with it -- a superseded node held by
  // a live edge is exactly what the stale_knowledge rule (correctly) flags.
  for (const existing of openAuditFindings) {
    if (liveFindingIds.has(existing.id)) continue;
    const revision = existing.revision + 1;
    const path = `${AUDIT_FINDING_NODE_DIRECTORY}/${existing.id}/${String(revision)}.json`;
    if (artifactExists(deps, path)) continue;
    const base: Record<string, unknown> = Object.fromEntries(
      Object.entries(existing).filter(([key]) => key !== "digest"),
    );
    base.revision = revision;
    base.status = "superseded";
    base.provenance = {
      iteration_id: ctx.iterationId,
      actor: "workflow-engine",
      timestamp: nowOf(deps),
    };
    const node = { ...base, digest: contentDigest(base) };
    const validation = validateSchema("node", node);
    if (!validation.valid) throw invalidAuditRecord("finding node", existing.id, validation.errors);
    artifacts.push({ path, content: `${canonicalizeJson(node)}\n` });
    for (const active of activeBlocksEdges) {
      if (active.source_id !== existing.id) continue;
      const retiredContent: Record<string, unknown> = Object.fromEntries(
        Object.entries(active).filter(([key]) => key !== "digest"),
      );
      retiredContent.status = "superseded";
      retiredContent.provenance = {
        iteration_id: ctx.iterationId,
        actor: "workflow-engine",
        timestamp: nowOf(deps),
      };
      const retired = { ...retiredContent, digest: contentDigest(retiredContent) };
      const edgeValidation = validateSchema("edge", retired);
      if (!edgeValidation.valid) {
        throw invalidAuditRecord("edge", active.id, edgeValidation.errors);
      }
      edges.push(retired as unknown as EdgeRecord);
    }
  }

  if (artifacts.length === 0 && edges.length === 0) return;
  await commitArtifacts(deps, ctx.workflowOperationId, currentAttemptId(ctx), artifacts, edges);
}

async function phaseEvaluate(ctx: PipelineContext): Promise<PhaseStep> {
  const { deps } = ctx;
  const plan = ctx.plan ?? loadPlan(ctx);
  if (plan === undefined)
    throw new OrchestrationError("binding_drift", "evaluate phase requires a plan");
  ctx.plan = plan;
  const tasks = orderedPlanTasks(plan.content.tasks);
  if (tasks.length === 0) throw new OrchestrationError("configuration", "plan carries no tasks");
  // One evaluation per task run, in dependency order; a failed evaluation
  // blocks the iteration back into execute for exactly that task.
  const evaluations: EvaluationPortResult[] = [];
  for (const task of tasks) {
    const run = loadCompletedRun(ctx, task.id);
    if (run === undefined) {
      throw new OrchestrationError(
        "binding_drift",
        `evaluate phase requires a terminated run for task ${task.id}`,
      );
    }
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
    evaluations.push(result);

    if (!result.passed) {
      const outcome = await blockWithSnapshot(ctx, {
        reason: "repairable_gate_failure",
        detail: `evaluation failed for task ${task.id}: ${result.summary}`,
        resumePhase: "execute",
        input: snapshotBaseInput(ctx, [
          { task_id: task.id, required: true, outcome: run.result.outcome },
        ]),
      });
      return { continue: false, outcome };
    }
  }

  const lastEvaluation = evaluations.at(-1);
  await ctx.engine.commitCheckpoint(ctx.workflowOperationId, {
    boundary: PHASE_CHECKPOINT_BOUNDARY.evaluate,
    proposal: { phase: "snapshot" },
    events: phaseLifecycleEvents({
      phase: "evaluate",
      caseId: lastEvaluation?.evidenceId ?? "case_none",
      passed: evaluations.every((evaluation) => evaluation.passed),
      findingIds: evaluations.flatMap((evaluation) =>
        evaluation.findings.map((finding) => finding.id),
      ),
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
    for (const outcome of record.run_outcomes) {
      if (outcome.outcome === "success" && outcome.id.startsWith("task_")) {
        completed.add(outcome.id);
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
    writeManagedOutput(harnessRoot(deps), { name: TASKS_PROJECTION_OUTPUT, content: markdown });
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
  const gates = ctx.gateOutcome;
  const evaluations = taskRuns.map(
    (taskRun) =>
      loadEvaluateArtifacts(deps, ctx.iterationId).find(
        (artifact) => artifact.run_digest === sha256Hex(canonicalizeJson(taskRun.result)),
      )?.result,
  );
  const success =
    taskRuns.every((taskRun) => taskRun.result.completion_claimed) &&
    (gates === undefined || gates.completed_allowed) &&
    evaluations.every((evaluation) => evaluation?.passed === true);

  const verifyStored = loadVerifyArtifact(deps, ctx.iterationId, verifyBindings(ctx));
  const snapshot = buildSnapshot({
    ...snapshotBaseInput(
      ctx,
      taskRuns.map((taskRun) => ({
        task_id: taskRun.taskId,
        required: true,
        outcome: success ? ("success" as const) : taskRun.result.outcome,
      })),
    ),
    snapshot_id: `snapshot_${sha256Hex(`${ctx.iterationId}:completed`).slice(0, 16)}`,
    final_commit: deps.readBaseline(),
    created_at: nowOf(deps),
    execution_plan_id: plan.node.id,
    runs: taskRuns.map((taskRun) => ({
      run_id: taskRun.runId,
      required: true,
      outcome: success ? ("success" as const) : taskRun.result.outcome,
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
  // Pick up documents and tests written since adoption so the audit sees
  // them, then run the post-verify/evaluate audit at the completing snapshot:
  // the Iteration node exists only now, so blocking findings can bind it.
  // Committed gaps surface in `harness status` without a manual `harness
  // audit`; idempotent re-runs dedupe by finding id.
  await commitScannedDocumentation(ctx);
  // Wire evidence for tests the rescan just brought into the graph, replaying
  // the stored verify verdict -- the gates ran over a worktree that already
  // contained those files, so the suite evidence vouches for them. Without
  // this, a test added between iterations would be flagged by
  // missing_verification for one full iteration until the next verify ran.
  const suiteGates = ctx.deps.gates ?? createDefaultGateSuite(deps.projectRoot).gates;
  const bindings = verifyBindings(ctx);
  const storedVerify = loadVerifyArtifact(deps, ctx.iterationId, bindings);
  if (storedVerify !== undefined) {
    await commitEvidenceNodes(
      ctx,
      storedEvidenceMaterials(deps, suiteGates, storedVerify),
      bindings,
    );
  }
  await commitAuditFindings(ctx);
  await regenerateTasksProjection(ctx);
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
  const engine = new WorkflowEngine(workflowDeps(deps));
  const current = engine.getOperation(request.workflow_operation_id);
  if (input.decision === "reject") {
    // A reject never applies the proposal, so baseline or binding drift must
    // not block it (drift only matters for an approve that would bind stale
    // digests). The decision commits directly, without reopening the paused
    // operation -- this stays the escape hatch when resume can no longer run.
    if (!request.allowed_decisions.includes("reject")) {
      throw new OrchestrationError(
        "invalid_phase",
        `decision reject is not allowed for request ${request.request_id}`,
      );
    }
    if (input.actor === proposedByOf(request)) {
      throw new OrchestrationError(
        "invalid_phase",
        `actor ${input.actor} may not resolve its own approval request ${request.request_id}`,
      );
    }
    const stillPending = approvalService(deps)
      .pendingRequests(request.workflow_operation_id)
      .some((candidate) => candidate.request_id === request.request_id);
    if (!stillPending) {
      throw new OrchestrationError(
        "operation_not_found",
        `approval request ${request.request_id} is already decided or superseded`,
      );
    }
    const rejected = buildApprovalDecision({
      approvalId: newIdOf(deps, "approval_decision"),
      requestId: request.request_id,
      actor: input.actor,
      decision: "reject",
      objectDigest: request.object_digest,
      decidedAt: nowOf(deps),
    });
    await commitArtifacts(
      deps,
      request.workflow_operation_id,
      current?.attempt_id ?? "attempt_abort",
      [approvalDecisionArtifact(rejected)],
    );
    return {
      requestId: rejected.request_id,
      decision: rejected.decision,
      approvalDigest: approvalDigestOf(rejected),
      workflowOperationId: request.workflow_operation_id,
    };
  }
  // A paused operation cannot accept the decision checkpoint; reopen it
  // first (the resume protocol re-verifies every binding) and leave it live
  // for the follow-up `resume` that continues the pipeline.
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

export interface AbortIterationInput {
  readonly workflowOperationId: string;
  /** Actor recorded for the abort and its rejection decisions. */
  readonly actor: string;
  readonly reason?: string;
}

export const FINDING_ACTIONS = ["accept", "close", "supersede"] as const;

export type FindingAction = (typeof FINDING_ACTIONS)[number];

export interface ResolveFindingInput {
  readonly findingId: string;
  readonly action: FindingAction;
  readonly actor: string;
  /** Required for close: the repair evidence vouching for the fix. */
  readonly evidenceId?: string;
}

export interface ResolvedFinding {
  readonly findingId: string;
  readonly action: FindingAction;
  /** Feedback status after the transition. */
  readonly status: "accepted" | "closed" | "superseded";
}

/**
 * Drive one Finding through its lifecycle (design 9.1). The transition
 * reseals the feedback record at `<action-status>.json` and, when the
 * finding has a graph node, commits the matching revision; closing or
 * superseding also retires the finding's active BLOCKS edges so resolved
 * findings drop out of status blockers and warnings. Close requires repair
 * evidence that exists, passed, is non-provisional and is still bound to the
 * current worktree -- the full digest-binding check stays with the phase
 * machinery. The graph vocabulary has no `closed` node status, so a closed
 * finding's node reads `superseded`; the exact resolution (including the
 * evidence id) lives in the feedback record.
 */
export async function resolveFinding(
  deps: OrchestratorDependencies,
  input: ResolveFindingInput,
): Promise<ResolvedFinding> {
  const feedbackPath = `artifacts/findings/${input.findingId}/proposed.json`;
  const feedback = readJsonArtifact<Record<string, unknown>>(deps, feedbackPath);
  if (feedback === undefined) {
    throw new OrchestrationError("operation_not_found", `unknown finding: ${input.findingId}`);
  }
  const existing = (status: string): boolean =>
    artifactExists(deps, `artifacts/findings/${input.findingId}/${status}.json`);
  if (existing("superseded") || existing("closed")) {
    throw new OrchestrationError(
      "operation_not_found",
      `finding ${input.findingId} is already resolved`,
    );
  }

  const targetStatus =
    input.action === "accept" ? "accepted" : input.action === "close" ? "closed" : "superseded";
  if (input.action === "close") {
    if (input.evidenceId === undefined) {
      throw new OrchestrationError(
        "configuration",
        `closing finding ${input.findingId} requires --evidence <evidence-id>`,
      );
    }
    const evidence = readEvidenceArtifact(deps, input.evidenceId);
    if (evidence === undefined) {
      throw new OrchestrationError(
        "operation_not_found",
        `unknown or unusable repair evidence: ${input.evidenceId}`,
      );
    }
  }

  const content: Record<string, unknown> = { ...feedback, status: targetStatus };
  delete content["digest"];
  if (input.action === "close") {
    content.extensions = {
      ...(typeof feedback.extensions === "object" && feedback.extensions !== null
        ? (feedback.extensions as Record<string, unknown>)
        : {}),
      "harness.closure": {
        evidence_id: input.evidenceId,
        actor: input.actor,
        closed_at: nowOf(deps),
      },
    };
  }
  const record = { ...content, digest: contentDigest(content) };
  const validation = validateSchema("feedback", record);
  if (!validation.valid) {
    throw new OrchestrationError(
      "configuration",
      `invalid finding transition record: ${validation.errors
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }

  const operations = readCommittedOperations(harnessRoot(deps));
  const lastOperation = operations.at(-1);
  if (lastOperation === undefined) {
    throw new OrchestrationError("operation_not_found", "no committed ledger operation");
  }
  const commitContext = {
    workflowOperationId: lastOperation.manifest.workflow_operation_id,
    attemptId: lastOperation.manifest.attempt_id,
  };

  const artifacts: { readonly path: string; readonly content: string }[] = [
    {
      path: `artifacts/findings/${input.findingId}/${targetStatus}.json`,
      content: `${canonicalizeJson(record)}\n`,
    },
  ];
  const edges: EdgeRecord[] = [];

  const graph = materializeProjectGraph(deps.projectRoot);
  let findingNode: NodeRecord | undefined;
  let activeBlocksEdges: readonly EdgeRecord[];
  try {
    findingNode = graph.nodes
      .filter((node) => node.id === input.findingId && node.type === "Finding")
      .sort((left, right) => left.revision - right.revision)
      .at(-1);
    activeBlocksEdges = graph.edges.filter(
      (edge) =>
        edge.type === "BLOCKS" &&
        edge.source_id === input.findingId &&
        (edge.status === "proposed" || edge.status === "accepted"),
    );
  } finally {
    graph.close();
  }
  if (findingNode !== undefined) {
    const nodeStatus = input.action === "accept" ? "accepted" : "superseded";
    if (findingNode.status !== nodeStatus) {
      const revision = findingNode.revision + 1;
      const base: Record<string, unknown> = Object.fromEntries(
        Object.entries(findingNode).filter(([key]) => key !== "digest"),
      );
      base.revision = revision;
      base.status = nodeStatus;
      base.provenance = {
        iteration_id: findingNode.provenance.iteration_id,
        actor: input.actor,
        timestamp: nowOf(deps),
      };
      const node = { ...base, digest: contentDigest(base) };
      const nodeValidation = validateSchema("node", node);
      if (!nodeValidation.valid) {
        throw new OrchestrationError(
          "configuration",
          `invalid finding node revision: ${nodeValidation.errors
            .map((issue) => issue.message)
            .join("; ")}`,
        );
      }
      artifacts.push({
        path: `artifacts/finding-nodes/${input.findingId}/${String(revision)}.json`,
        content: `${canonicalizeJson(node)}\n`,
      });
    }
  }
  if (input.action !== "accept") {
    for (const edge of activeBlocksEdges) {
      const retiredContent: Record<string, unknown> = Object.fromEntries(
        Object.entries(edge).filter(([key]) => key !== "digest"),
      );
      retiredContent.status = "superseded";
      retiredContent.provenance = {
        iteration_id: edge.provenance.iteration_id,
        actor: input.actor,
        timestamp: nowOf(deps),
      };
      const retired = { ...retiredContent, digest: contentDigest(retiredContent) };
      const edgeValidation = validateSchema("edge", retired);
      if (!edgeValidation.valid) {
        throw new OrchestrationError(
          "configuration",
          `invalid retired edge: ${edgeValidation.errors.map((issue) => issue.message).join("; ")}`,
        );
      }
      edges.push(retired as unknown as EdgeRecord);
    }
  }
  await commitArtifacts(
    deps,
    commitContext.workflowOperationId,
    commitContext.attemptId,
    artifacts,
    edges,
  );
  return { findingId: input.findingId, action: input.action, status: targetStatus };
}

/** Passed, non-provisional evidence bound to the current worktree, if any. */
function readEvidenceArtifact(
  deps: OrchestratorDependencies,
  evidenceId: string,
): GateEvidenceRecord | undefined {
  const directory = resolveHarnessPath(harnessRoot(deps), `artifacts/evidence/${evidenceId}`);
  if (!existsSync(directory)) return undefined;
  const codeHash = hashWorktreeCode(deps.projectRoot);
  for (const name of readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .sort()) {
    const record = readJsonArtifact<GateEvidenceRecord>(
      deps,
      `artifacts/evidence/${evidenceId}/${name}`,
    );
    if (record === undefined || record.provisional) continue;
    const extension = record.extensions?.["harness.gate"];
    if (typeof extension !== "object" || extension === null) continue;
    const passed = (extension as Record<string, unknown>).passed === true;
    const bindings = evidenceBindingsOf(record);
    if (!passed || bindings === undefined) continue;
    if (!bindings.code_digests.includes(codeHash)) continue;
    return record;
  }
  return undefined;
}

export interface AbortedIteration {
  readonly workflowOperationId: string;
  readonly iterationId: string;
  /** Pending approval requests closed by the abort, in request order. */
  readonly rejectedRequests: readonly string[];
}

/**
 * Abort an open workflow operation (design 10: explicit cancellation is the
 * only user-driven path to `aborted`). This is the escape hatch when every
 * recovery path is sealed -- for example when the Git baseline drifted after
 * the checkpoint, so resume and approve both refuse to run. The abort never
 * re-verifies checkpoint bindings: it closes every pending approval request
 * with an explicit reject decision by the aborting actor (a reject applies
 * nothing, so drift cannot make it unsafe), commits the terminal `aborted`
 * operation record with its OperationCompleted event, and marks a committed
 * Iteration node aborted so status stops treating it as open. Everything is
 * ledger-backed; nothing is deleted.
 */
export async function abortIteration(
  deps: OrchestratorDependencies,
  input: AbortIterationInput,
): Promise<AbortedIteration> {
  const engine = new WorkflowEngine(workflowDeps(deps));
  const current = engine.getOperation(input.workflowOperationId);
  if (current === undefined) {
    throw new OrchestrationError(
      "operation_not_found",
      `unknown workflow operation: ${input.workflowOperationId}`,
    );
  }
  if (current.state === "completed" || current.state === "aborted") {
    throw new OrchestrationError(
      "operation_not_found",
      `workflow operation ${input.workflowOperationId} is terminal (${current.state}) and cannot abort`,
    );
  }

  const pending = approvalService(deps).pendingRequests(input.workflowOperationId);
  if (pending.length > 0) {
    await commitArtifacts(
      deps,
      input.workflowOperationId,
      current.attempt_id,
      pending.map((request) => {
        const record = buildApprovalDecision({
          approvalId: newIdOf(deps, "approval_decision"),
          requestId: request.request_id,
          actor: input.actor,
          decision: "reject",
          objectDigest: request.object_digest,
          decidedAt: nowOf(deps),
        });
        return approvalDecisionArtifact(record);
      }),
    );
  }

  await engine.abort(input.workflowOperationId, {
    reason: "user_cancellation",
    detail: input.reason ?? `aborted by ${input.actor}`,
  });

  const graph = materializeProjectGraph(deps.projectRoot);
  let iterationNode: NodeRecord | undefined;
  try {
    iterationNode = graph.nodes
      .filter((node) => node.id === current.iteration_id && node.type === "Iteration")
      .sort((left, right) => left.revision - right.revision)
      .at(-1);
  } finally {
    graph.close();
  }
  if (
    iterationNode !== undefined &&
    iterationNode.iteration_state !== "completed" &&
    iterationNode.iteration_state !== "aborted"
  ) {
    const revision = iterationNode.revision + 1;
    const base: Record<string, unknown> = Object.fromEntries(
      Object.entries(iterationNode).filter(([key]) => key !== "digest"),
    );
    base.revision = revision;
    base.iteration_state = "aborted";
    base.provenance = {
      iteration_id: current.iteration_id,
      actor: input.actor,
      timestamp: nowOf(deps),
    };
    const node = { ...base, digest: contentDigest(base) };
    const validation = validateSchema("node", node);
    if (!validation.valid) {
      throw new OrchestrationError(
        "configuration",
        `invalid aborted iteration node: ${validation.errors
          .map((issue) => issue.message)
          .join("; ")}`,
      );
    }
    await commitArtifacts(deps, input.workflowOperationId, current.attempt_id, [
      {
        path: `artifacts/iterations/${current.iteration_id}/${String(revision)}.json`,
        content: `${canonicalizeJson(node)}\n`,
      },
    ]);
  }

  return {
    workflowOperationId: input.workflowOperationId,
    iterationId: current.iteration_id,
    rejectedRequests: pending.map((request) => request.request_id),
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
