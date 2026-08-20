import {
  type CommitHooks,
  type EdgeRecord,
  type LockTuning,
  type NodeRecord,
} from "@universal-harness-internal/core";
import { type IterationKind } from "@universal-harness-internal/graph";
import {
  type AgentRunResult,
  type AgentTrajectoryVisibility,
  type VcsAdapter,
} from "@universal-harness-internal/plugin-sdk";
import { type ApprovalPrompter, type ApprovalRequiredOutcome } from "../approval/interaction.js";
import { type GateDefinition } from "../gates/provider.js";
import {
  type ObservationPublisherPort,
  type ObservationStreamIdentity,
} from "../observability/publisher.js";
import { type IntentShape } from "../planning/mode-selector.js";
import { type TaskSpecification } from "../planning/task.js";
import {
  type ClarificationQuestion,
  type ConstraintInput,
  type RequirementInput,
} from "../requirements/capture.js";
import type { ToolRegistry } from "../tools/registry.js";
import { type AbortReason, type RecoverableBlockReason } from "../workflow/state-machine.js";
import { type OrchestrationPhase } from "./phases.js";
import { type ExecutionBinding, type OrchestrationExecutor } from "./execution-binding.js";

/**
 * Shared orchestration contracts (plan Task 8-A): the error vocabulary,
 * dependency and outcome types used by the Kernel Coordinator, the Module
 * contributors and the compatibility facade alike. Pure declarations — no
 * pipeline behavior lives here.
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
  readonly adapterProfileDigest?: string;
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
/**
 * Incremental phase progress streamed to observers while a pipeline runs.
 * Pure side-channel: never written to the ledger; lets long-running hosts
 * (e.g. the CLI) surface progress on stderr instead of buffering everything
 * until the final outcome.
 */
export interface PhaseProgressEvent {
  readonly type: "phase_started" | "phase_completed" | "phase_paused";
  readonly workflow_operation_id: string;
  readonly iteration_id: string;
  readonly phase: OrchestrationPhase;
  /** ISO 8601 timestamp from the orchestrator clock. */
  readonly timestamp: string;
  /** `phase_paused` only: outcome status that paused the pipeline. */
  readonly paused_status?: string;
}
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
  readonly execution?: ExecutionBinding;
  /** Legacy host seam; treated as an unproven delegated Agent binding. */
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
  /** Override the default file-spool publisher (primarily for hosts and tests). */
  readonly createObservationPublisher?: (
    identity: ObservationStreamIdentity,
  ) => ObservationPublisherPort;
  /**
   * Optional side-channel observer invoked at each phase boundary so hosts
   * can stream progress for long-running pipelines (never affects outcomes).
   */
  readonly onPhaseProgress?: (event: PhaseProgressEvent) => void;
}
export type OrchestrationOutcome =
  | {
      readonly status: "completed";
      readonly workflowOperationId: string;
      readonly iterationId: string;
      readonly snapshotId: string;
      /** Commit containing the exact source tree proved by gate evidence. */
      readonly sourceCommit: string;
      /** Commit containing the completed Harness ledger and projections. */
      readonly ledgerCommit: string | null;
      /** Repository HEAD after source and Ledger commits complete. */
      readonly repositoryHead: string;
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
    }
  | {
      readonly status: "migration_required";
      readonly workflowOperationId: string;
      readonly iterationId: string;
      readonly reasons: readonly string[];
      readonly resumePhase: "impact" | "plan";
      readonly resumeCommand: string;
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
    readonly testIds: readonly string[];
  }[];
  readonly impactPaths: readonly (readonly string[])[];
  readonly acceptedTestIds: readonly string[];
  readonly gateIds: readonly string[];
}) => readonly TaskSpecification[];
