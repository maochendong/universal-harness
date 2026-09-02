import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";
import {
  DashboardWriteError,
  createDashboardSchedulerApi,
  startDashboardServer,
  type DashboardServer,
} from "@universal-harness-internal/dashboard";
import { renderTasksProjection } from "@universal-harness-internal/adapter-projection-markdown";
import { defineEvaluationCase, evaluateRun } from "@universal-harness-internal/eval";
import {
  FindingGroupError,
  OrchestrationError,
  ApprovalError,
  WorkflowError,
  FileLiveSpool,
  ObservationPublisher,
  createGenericInterpreter,
  createProjectSchedulerHost,
  createRuntimeService,
  driveOpenOperation,
  findOpenWorkflowOperation,
  materializeProjectGraph,
  parseApprovalDecision,
  previewImpactSet,
  projectSchedulerStatus,
  projectSnapshotCommitRefs,
  proposeSemanticImpactEdges,
  provenQualityTaskIds,
  readExecutionPlanContent,
  readLatestExecutionPlan,
  readLatestSnapshot,
  readCurrentOperation,
  readStagedAdoptionPreview,
  resolveApproval,
  resolveFinding,
  resolveFindingGroup,
  resumeIteration,
  runIteration,
  auditGraph,
  readBridgedCaptureApprovalDecision,
  schedulerRecoveryActionFor,
  type ApprovalPrompter,
  type CaptureCoordinatorSeam,
  type EvaluationPort,
  type ExecutionPlanContent,
  type IntentInterpreter,
  type OrchestrationExecutor,
  type OrchestrationOutcome,
  type OrchestratorDependencies,
  type PhaseProgressEvent,
  type ProjectSchedulerHost,
  type SchedulerCeilingBounds,
  type StrictTddExecutionPort,
  type TaskEnvelopeScopePort,
} from "@universal-harness-internal/runtime";
import type { SemanticSeedProvider } from "@universal-harness-internal/plugin-sdk";
import { materializeLedger, pageEdges, pageNodes } from "@universal-harness-internal/graph";
import {
  contentDigest,
  harnessRootFor,
  readLatestProjectProfile,
  readProfileDecisionRecords,
  resolveIterationProfile,
  resolveProfileSelection,
  ulid,
  ProfileSelectionError,
  ProjectLayoutError,
  type CapabilityPlanRecord,
  type EdgeRecord,
  type NodeRecord,
  type ObservationEvent,
  type ProfileId,
  type ProjectProfileRecord,
  type TrustedProviderRegistry,
} from "@universal-harness-internal/core";

import type { GateDefinition, ToolRegistry } from "@universal-harness-internal/runtime";

import type { CliIo, CommandResult } from "./io.js";
import type {
  AbortRequest,
  AdoptProjectRequest,
  ApproveRequest,
  ConnectRequest,
  CoordinatorHostRequest,
  DisconnectRequest,
  FindingGroupRequest,
  FindingRequest,
  ImpactRequest,
  IntegrateRequest,
  IterateRequest,
  NewProjectRequest,
  ProjectRequest,
  ResumeRequest,
  RunRequest,
  SchedulerStatusView,
  ServeRequest,
  SyncRequest,
  RuntimeService,
} from "./router.js";
import {
  createCliCollaborationRuntime,
  type CollaborationRuntimeSeams,
} from "./runtime/collaboration-runtime.js";
import {
  createConfiguredAgentExecutor,
  createProjectAgentSlotFactory,
  supervisedSingleSlotNotice,
} from "./project-agent.js";
import { createProjectCapabilityPlanCompiler } from "./capability-plan-compiler.js";
import { createConfiguredGateSuite } from "./project-gates.js";
import { createManagedIntentInterpreter } from "./managed-interpret.js";
import {
  DEFAULT_CAPTURE_REVIEW_RUBRIC,
  ManagedCaptureCoordinatorError,
  createManagedCaptureCoordinator,
  defaultCaptureRiskPolicy,
} from "./managed-capture-coordinator.js";
import { ManagedPipelinePortsError, createManagedPipelinePorts } from "./managed-pipeline-ports.js";
import {
  ProjectRuntimeConfigError,
  readProjectRuntimeConfig,
  type ProjectRuntimeConfig,
} from "./project-runtime-config.js";
import {
  baselineDigestForProject,
  createRuntimeConfigurationService,
  projectIdForProject,
} from "./runtime/configuration-service.js";
import { createCliApprovalService } from "./runtime/approval-service.js";
import { createCliResumeService } from "./runtime/resume-service.js";

/**
 * Default runtime wiring for the CLI (design 11.1/11.2, plan Task 23): every
 * command delegates to the runtime phase orchestrator or a read-only
 * inspection function; no business logic lives here beyond mapping typed
 * outcomes onto the canonical CommandResult. All ports (clock, id mint,
 * interpreter, executor, evaluator, prompter, VCS) are injectable so E2E
 * tests stay deterministic and hermetic.
 */
export interface OrchestratedServiceOptions {
  readonly cwd: string;
  readonly io: CliIo;
  readonly now?: () => string;
  readonly newId?: (kind: string) => string;
  readonly interpret?: IntentInterpreter;
  readonly execute?: OrchestrationExecutor;
  /** Host-owned strict TDD executor for required TaskTddContracts. */
  readonly strictTdd?: StrictTddExecutionPort;
  /** Explicit task path scope for injected executors and hermetic hosts. */
  readonly taskEnvelopeScope?: TaskEnvelopeScopePort;
  readonly evaluate?: EvaluationPort;
  readonly prompter?: ApprovalPrompter;
  readonly decisionActor?: string;
  readonly vcs?: ReturnType<typeof createGitVcsAdapter>;
  /**
   * Custom verify-phase gate suite (plan Task 26 E2E injection); like the
   * orchestrator port, a custom suite must come with its `toolRegistry`.
   */
  readonly gates?: readonly GateDefinition[];
  readonly toolRegistry?: ToolRegistry;
  /**
   * Streams incremental phase progress (see PhaseProgressEvent) so long-
   * running commands can surface stage transitions instead of buffering all
   * output until the final result.
   */
  readonly onPhaseProgress?: (event: PhaseProgressEvent) => void;
  /** Receives the same disposable observation appended to the live spool. */
  readonly onObservation?: (event: ObservationEvent) => void;
  readonly semanticProvider?: SemanticSeedProvider;
  /** Host-owned provider trust root; managed projects may reference but never define it. */
  readonly providerRegistry?: TrustedProviderRegistry;
  /** Injectable transport and environment for hermetic provider/Judge hosts. */
  readonly providerFetch?: typeof fetch;
  readonly providerEnvironment?: Readonly<Record<string, string | undefined>>;
  /**
   * Interactive profile chooser (protocol 1.1): invoked only when the session
   * is interactive and no explicit --profile was passed. Returning null (EOF,
   * Ctrl-C) is never a silent default; the command returns input_required.
   */
  readonly selectProfile?: (
    options: readonly ProfileId[],
    preview: string,
  ) => Promise<string | null>;
  /**
   * Injectable collaboration seams (Coordinator port, control store, host
   * composition) so tests pin remote routing without real TLS or OAuth.
   */
  readonly collaboration?: CollaborationRuntimeSeams;
  /**
   * Explicit capture seam (M4 Task 12 tests drive the real coordinated-capture
   * pipeline hermetically); takes precedence over the managed-coordinator
   * derivation from runtime.json.
   */
  readonly capture?: CaptureCoordinatorSeam;
  /**
   * Late-bound accepted CapabilityPlan reader (the kernel's embedder
   * compatibility seam). A thunk because the accepted revision can bind an
   * operation id minted after the service was constructed.
   */
  readonly capabilityPlan?: () => CapabilityPlanRecord | undefined;
  /**
   * Scheduler host factory (M4 design 10.2). Absent = the production default:
   * a Project Scheduler Host is composed only when runtime.json declares an
   * `agent` (unconfigured projects keep the exact pre-M4 behavior). Tests
   * inject recording fakes to pin Driver Lock discipline without a real pool.
   */
  readonly schedulerHost?: (request: SchedulerHostRequest) => ProjectSchedulerHost | undefined;
  /** Test seam: receives the started Dashboard server so hosts can close it. */
  readonly onServerReady?: (server: DashboardServer) => void;
}

/** Interactive stdin prompt; only constructed when the CLI runs on a TTY. */
export function createReadlinePrompter(io: CliIo): ApprovalPrompter {
  return {
    prompt: (preview, allowedDecisions) =>
      new Promise<string | null>((resolvePromise) => {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        let settled = false;
        const settle = (answer: string | null): void => {
          if (settled) return;
          settled = true;
          rl.close();
          resolvePromise(answer);
        };
        io.writeStderr(`${preview}\n`);
        rl.question(`decision (${allowedDecisions.join("/")}): `, (answer) => settle(answer));
        // EOF, Ctrl-C and terminal disconnect all collapse to defer.
        rl.on("close", () => settle(null));
      }),
  };
}

/** Interactive profile chooser over stdin; only used on a TTY. */
export function createReadlineProfileChooser(
  io: CliIo,
): (options: readonly ProfileId[], preview: string) => Promise<string | null> {
  return (choices, preview) =>
    new Promise<string | null>((resolvePromise) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      let settled = false;
      const settle = (answer: string | null): void => {
        if (settled) return;
        settled = true;
        rl.close();
        resolvePromise(answer);
      };
      io.writeStderr(`${preview}\n`);
      rl.question(`profile (${choices.join("/")}): `, (answer) => settle(answer));
      rl.on("close", () => settle(null));
    });
}

/** Evaluation port backed by the eval package's deterministic scorers. */
export function createEvalPackagePort(now: () => string): EvaluationPort {
  return (input) => {
    const evaluationCase = defineEvaluationCase({
      case_id: `case_${input.taskId.slice("task_".length)}`,
      subject_id: input.taskId,
      expected_outcomes: ["handoff"],
    });
    const report = evaluateRun({
      case: evaluationCase,
      input: {
        run: input.run,
        visibility: input.visibility,
        budget: input.budget,
        ...(input.adapterProfileDigest === undefined
          ? {}
          : { adapter_profile_digest: input.adapterProfileDigest }),
      },
      iterationId: input.iterationId,
      clock: now,
    });
    return {
      evidenceId: report.evidence.evidence_id,
      passed: report.passed,
      mandatoryFailures: [...report.mandatory_failures],
      findings: report.findings.map((finding) => ({ id: finding.id, summary: finding.summary })),
      summary: report.passed
        ? "all mandatory evaluation dimensions passed"
        : `mandatory evaluation dimensions failed: ${report.mandatory_failures.join(", ")}`,
      record: report.evidence as unknown as Record<string, unknown>,
    };
  };
}

function gitHead(projectRoot: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
}

/**
 * The ceilings the CLI declares for local parallel drives (M4 design 10.2).
 * They mirror the runtime host defaults — the profile default of 2 local
 * slots and the installation/project/local-resource bounds — and are passed
 * to the host explicitly so the concurrency the CLI reports is exactly the
 * concurrency the drive enforces.
 */
export const CLI_SCHEDULER_CEILINGS: SchedulerCeilingBounds = {
  profile_limit: 2,
  installation_limit: 8,
  project_limit: 8,
  local_resource_limit: 8,
} as const;

/** How one local concurrency request resolves against the ceilings. */
export interface SchedulerConcurrencyDecision {
  /** What the operator asked for (--max-concurrency or agent_pool.slots). */
  readonly requested: number;
  /** What the drive will actually use: the minimum of request and ceilings. */
  readonly effective: number;
  /** The binding ceiling, or "request" when the request itself is lowest. */
  readonly limited_by: "request" | keyof SchedulerCeilingBounds;
  /**
   * True when the request exceeds a ceiling: the drive proceeds at the
   * clamped value (a decrease never needs approval) and raising the ceiling
   * itself must go through a Policy Proposal — never a silent expansion.
   */
  readonly policy_proposal_required: boolean;
}

/** Resolve a local concurrency request against the fixed ceilings (design 20). */
export function resolveSchedulerConcurrency(input: {
  readonly requested: number;
  readonly ceilings: SchedulerCeilingBounds;
}): SchedulerConcurrencyDecision {
  const requested = Math.max(1, Math.floor(input.requested));
  const bounds: readonly (readonly [keyof SchedulerCeilingBounds, number])[] = [
    ["profile_limit", input.ceilings.profile_limit],
    ["installation_limit", input.ceilings.installation_limit],
    ["project_limit", input.ceilings.project_limit],
    ["local_resource_limit", input.ceilings.local_resource_limit],
  ];
  let effective = requested;
  let limitedBy: SchedulerConcurrencyDecision["limited_by"] = "request";
  for (const [name, value] of bounds) {
    if (value < effective) {
      effective = value;
      limitedBy = name;
    }
  }
  effective = Math.max(1, effective);
  return {
    requested,
    effective,
    limited_by: limitedBy,
    policy_proposal_required: requested > effective,
  };
}

/**
 * What a command asks the scheduler host factory for (M4 Task 12). "read"
 * inspects (status/abort) and never takes the Driver Lock or materializes the
 * projection store; "write" drives (run/resume/iterate and dashboard resume).
 */
export interface SchedulerHostRequest {
  readonly projectRoot: string;
  readonly driverKind: "cli" | "dashboard";
  /** Effective concurrency after ceiling clamping; omitted on read paths. */
  readonly maxConcurrency?: number;
  readonly live: "read" | "write";
}

/** Structural alias: DriverLockHandle stays runtime-internal (constraint 25). */
type AcquiredDriverLock = Awaited<ReturnType<ProjectSchedulerHost["acquireDriverLock"]>>;

/** Latest revision per node id (mirrors the runtime host's plan projection). */
function latestNodeRevisions(nodes: readonly NodeRecord[]): NodeRecord[] {
  const byId = new Map<string, NodeRecord>();
  for (const node of nodes) {
    const current = byId.get(node.id);
    if (current === undefined || node.revision > current.revision) byId.set(node.id, node);
  }
  return [...byId.values()];
}

/**
 * Human presentation of an ExecutionPlan (M4 design 19.3): waves, per-task
 * dependencies/resource claims/budgets, and the pairwise conflicts that keep
 * two Tasks out of the same wave (overlapping write paths or exclusive
 * resource claims). Pure: derived only from the canonical plan content, so
 * the human and JSON views of `harness plan` can never drift apart.
 */
export function presentExecutionPlan(content: ExecutionPlanContent): string {
  const lines: string[] = [];
  const waves = content.parallel_waves ?? [];
  const header =
    waves.length === 0
      ? `plan mode ${content.mode} (${content.execution_kind}), ${String(content.tasks.length)} task(s), sequential`
      : `plan mode ${content.mode} (${content.execution_kind}), ${String(content.tasks.length)} task(s), ${String(waves.length)} wave(s)`;
  lines.push(
    content.iteration_budget === undefined
      ? header
      : `${header}, iteration budget ${String(content.iteration_budget.steps)} steps / ${String(content.iteration_budget.tokens)} tokens`,
  );
  for (const wave of waves) {
    lines.push(`wave ${String(wave.wave_index)}: ${wave.task_ids.join(", ")}`);
  }
  for (const task of content.tasks) {
    const parts: string[] = [];
    if (task.dependencies.length > 0) parts.push(`deps [${task.dependencies.join(", ")}]`);
    if (task.write_paths !== undefined) parts.push(`writes [${task.write_paths.join(", ")}]`);
    if (task.exclusive_resources !== undefined && task.exclusive_resources.length > 0) {
      parts.push(`exclusive [${task.exclusive_resources.join(", ")}]`);
    }
    parts.push(`budget ${String(task.budget.steps)} steps / ${String(task.budget.tokens)} tokens`);
    lines.push(`task ${task.id} "${task.objective}": ${parts.join(", ")}`);
  }
  for (let left = 0; left < content.tasks.length; left += 1) {
    for (let right = left + 1; right < content.tasks.length; right += 1) {
      const former = content.tasks[left];
      const latter = content.tasks[right];
      if (former === undefined || latter === undefined) continue;
      const sharedWrites = (former.write_paths ?? []).filter((path) =>
        (latter.write_paths ?? []).includes(path),
      );
      const sharedResources = (former.exclusive_resources ?? []).filter((resource) =>
        (latter.exclusive_resources ?? []).includes(resource),
      );
      if (sharedWrites.length === 0 && sharedResources.length === 0) continue;
      lines.push(
        `conflict: ${former.id} <-> ${latter.id}: write_paths [${sharedWrites.join(", ")}]; exclusive_resources [${sharedResources.join(", ")}]`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * Protocol-1.1 slice 2 capture gating: a pre-1.1 legacy project without a
 * committed profile record keeps its exact current behavior. With a profile
 * record, capture runs through the assembled PrdCaptureCoordinator; provider
 * closure is re-verified deterministically at preflight (design 11.2), so a
 * Standard/Governed profile missing `model_providers` coverage for any
 * capture slot fails closed as a configuration error rather than degrading —
 * only Lite keeps the no-config legacy fallback. The ProfileDecision identity
 * derives deterministically from the stable decision inputs (core has no
 * profile-decision reader yet), the approval bridge reads the same engine
 * ledger the legacy surface writes, and the risk policy routes every capture
 * to human approval.
 */
export function managedCaptureSeamForProject(
  projectRoot: string,
  runtimeConfig: ProjectRuntimeConfig,
  options: {
    readonly now?: () => string;
    readonly fetch?: typeof fetch;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly providerRegistry?: TrustedProviderRegistry;
  } = {},
): CaptureCoordinatorSeam | undefined {
  let profile: ProjectProfileRecord | undefined;
  try {
    profile = readLatestProjectProfile(projectRoot, projectIdForProject(projectRoot));
  } catch (error) {
    if (error instanceof ProjectLayoutError) return undefined;
    throw error;
  }
  if (profile === undefined) return undefined;
  const decision = readProfileDecisionRecords(projectRoot)
    .filter(
      (candidate) =>
        candidate.project_id === profile.project_id &&
        candidate.decided_profile_id === profile.profile_id,
    )
    .at(-1);
  if (decision === undefined) {
    throw new OrchestrationError(
      "configuration",
      `ProjectProfile ${profile.record_digest} has no persisted ProfileDecision`,
    );
  }
  const baselineDigest = baselineDigestForProject(projectRoot);
  let assembled: ReturnType<typeof createManagedCaptureCoordinator>;
  try {
    assembled = createManagedCaptureCoordinator({
      projectRoot,
      runtimeConfig,
      profile,
      profile_decision_id: decision.profile_decision_id,
      profile_decision_digest: decision.record_digest,
      project_baseline_digest: baselineDigest,
      policy: defaultCaptureRiskPolicy(profile.project_id, profile.profile_id),
      rubric: DEFAULT_CAPTURE_REVIEW_RUBRIC,
      readBaseline: () => gitHead(projectRoot),
      ...(options.now === undefined ? {} : { now: options.now }),
      readApprovalDecision: (requestId, decisionId) =>
        readBridgedCaptureApprovalDecision(projectRoot, requestId, decisionId),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.providerRegistry === undefined
        ? {}
        : { providerRegistry: options.providerRegistry }),
    });
  } catch (error) {
    if (error instanceof ManagedCaptureCoordinatorError) {
      throw new OrchestrationError(
        error.code === "binding_drift" ? "binding_drift" : "configuration",
        error.message,
      );
    }
    throw error;
  }
  if (assembled === undefined) return undefined;
  return {
    coordinator: assembled.coordinator,
    session_context: {
      project_profile_digest: profile.record_digest,
      profile_decision_digest: decision.record_digest,
      capture_policy_digest: profile.policy_digest,
      project_baseline_digest: baselineDigest,
    },
  };
}

/** Map one orchestration outcome onto the canonical command result. */
function outcomeToResult(
  command: string,
  outcome: OrchestrationOutcome,
  extra: Record<string, unknown> = {},
): CommandResult {
  switch (outcome.status) {
    case "completed":
      return {
        command,
        status: "ok",
        message: `iteration ${outcome.iterationId} completed; snapshot ${outcome.snapshotId} at ${outcome.sourceCommit.slice(0, 12)}`,
        data: {
          ...extra,
          workflow_operation_id: outcome.workflowOperationId,
          iteration_id: outcome.iterationId,
          snapshot_id: outcome.snapshotId,
          source_commit: outcome.sourceCommit,
          ledger_commit: outcome.ledgerCommit,
          repository_head: outcome.repositoryHead,
        },
      };
    case "advanced":
      return {
        command,
        status: "ok",
        message: `workflow operation ${outcome.workflowOperationId} advanced through phase ${outcome.completedPhase}`,
        data: {
          ...extra,
          workflow_operation_id: outcome.workflowOperationId,
          iteration_id: outcome.iterationId,
          completed_phase: outcome.completedPhase,
        },
      };
    case "approval_required":
      return {
        command,
        status: "approval_required",
        message:
          `approval ${outcome.required.request_id} required for ${outcome.required.object_type} ` +
          `${outcome.required.object_id}; then run: ${outcome.required.resume_command}`,
        data: { ...extra, ...outcome.required },
      };
    case "input_required":
      return {
        command,
        status: "input_required",
        message: `mandatory input missing: ${outcome.questions.map((question) => question.question).join("; ")}`,
        data: {
          ...extra,
          questions: outcome.questions.map((question) => ({ ...question })),
          ...(outcome.workflowOperationId === undefined
            ? {}
            : { workflow_operation_id: outcome.workflowOperationId }),
          ...(outcome.captureSessionId === undefined
            ? {}
            : { capture_session_id: outcome.captureSessionId }),
          ...(outcome.sessionRevision === undefined
            ? {}
            : { session_revision: outcome.sessionRevision }),
          ...(outcome.expectedDigest === undefined
            ? {}
            : { expected_digest: outcome.expectedDigest }),
          ...(outcome.resumeCommand === undefined ? {} : { resume_command: outcome.resumeCommand }),
        },
      };
    case "blocked":
      return {
        command,
        status: "blocked",
        message: `iteration ${outcome.iterationId} blocked (${outcome.reason}): ${outcome.detail}; resume with: ${outcome.resumeCommand}`,
        data: {
          ...extra,
          workflow_operation_id: outcome.workflowOperationId,
          iteration_id: outcome.iterationId,
          reason: outcome.reason,
          detail: outcome.detail,
          resume_command: outcome.resumeCommand,
          ...(outcome.snapshotId === undefined ? {} : { snapshot_id: outcome.snapshotId }),
        },
      };
    case "aborted":
      return {
        command,
        status: "failed",
        message: `iteration ${outcome.iterationId} aborted (${outcome.reason}): ${outcome.detail}`,
        data: {
          ...extra,
          workflow_operation_id: outcome.workflowOperationId,
          iteration_id: outcome.iterationId,
          reason: outcome.reason,
          detail: outcome.detail,
        },
      };
    case "migration_required":
      return {
        command,
        status: "blocked",
        message: `legacy open iteration requires migration from ${outcome.resumePhase}; resume with: ${outcome.resumeCommand}`,
        data: {
          ...extra,
          kind: "migration_required",
          workflow_operation_id: outcome.workflowOperationId,
          iteration_id: outcome.iterationId,
          reasons: outcome.reasons,
          resume_phase: outcome.resumePhase,
          resume_command: outcome.resumeCommand,
        },
      };
  }
}

export function createOrchestratedRuntimeService(
  options: OrchestratedServiceOptions,
): RuntimeService {
  const vcs = options.vcs ?? createGitVcsAdapter();
  const bootstrap = createRuntimeService({
    vcs,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.newId === undefined ? {} : { newId: options.newId }),
  });
  const prompter =
    options.prompter ?? (options.io.isInteractive ? createReadlinePrompter(options.io) : undefined);
  const actor = options.decisionActor ?? "human:local";
  const clock = options.now ?? (() => new Date().toISOString());
  const configuration = createRuntimeConfigurationService({ actor, clock });

  const orchestratorDeps = (projectRoot: string): OrchestratorDependencies => {
    let runtimeConfig;
    try {
      runtimeConfig = readProjectRuntimeConfig(projectRoot);
    } catch (error) {
      if (error instanceof ProjectRuntimeConfigError) {
        throw new OrchestrationError("configuration", error.message);
      }
      throw error;
    }
    const configuredAgent =
      options.execute === undefined && runtimeConfig.agent !== undefined
        ? createConfiguredAgentExecutor(projectRoot, runtimeConfig.agent)
        : undefined;
    const configuredGateSuite =
      options.gates === undefined && options.toolRegistry === undefined
        ? createConfiguredGateSuite(projectRoot, runtimeConfig, {
            ...(options.providerRegistry === undefined
              ? {}
              : { providerRegistry: options.providerRegistry }),
            ...(options.providerEnvironment === undefined
              ? {}
              : { ambientEnvironment: options.providerEnvironment }),
            ...(options.providerFetch === undefined
              ? {}
              : { judgeTransport: { fetch: options.providerFetch } }),
          })
        : undefined;
    const injectedExecutor = options.execute;
    const createObservationPublisher =
      options.onObservation === undefined
        ? undefined
        : (
            identity: Parameters<
              NonNullable<OrchestratorDependencies["createObservationPublisher"]>
            >[0],
          ) => {
            const spool = new FileLiveSpool(projectRoot);
            return new ObservationPublisher(
              {
                append: (input) => {
                  const event = spool.append(input);
                  options.onObservation?.(event);
                  return event;
                },
              },
              identity,
            );
          };
    const captureSeam =
      options.capture ??
      managedCaptureSeamForProject(projectRoot, runtimeConfig, {
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.providerRegistry === undefined
          ? {}
          : { providerRegistry: options.providerRegistry }),
        ...(options.providerFetch === undefined ? {} : { fetch: options.providerFetch }),
        ...(options.providerEnvironment === undefined
          ? {}
          : { environment: options.providerEnvironment }),
      });
    const capabilityPlanCompiler =
      captureSeam === undefined
        ? undefined
        : createProjectCapabilityPlanCompiler({
            projectRoot,
            runtimeConfig,
            ...(options.providerRegistry === undefined
              ? {}
              : { providerRegistry: options.providerRegistry }),
            ...(options.providerFetch === undefined ? {} : { fetch: options.providerFetch }),
            ...(options.providerEnvironment === undefined
              ? {}
              : { environment: options.providerEnvironment }),
          });
    const injectedCapabilityPlan = options.capabilityPlan?.();
    return {
      projectRoot,
      readBaseline: () => gitHead(projectRoot),
      vcs,
      interpret:
        options.interpret ??
        (runtimeConfig.model_providers === undefined
          ? createGenericInterpreter()
          : managedCaptureInterpreter(projectRoot, runtimeConfig)),
      ...managedPipelinePortsFor(projectRoot, runtimeConfig),
      ...(captureSeam === undefined ? {} : { capture: captureSeam }),
      ...(capabilityPlanCompiler === undefined ? {} : { capabilityPlanCompiler }),
      ...(injectedCapabilityPlan === undefined ? {} : { capabilityPlan: injectedCapabilityPlan }),
      ...(options.strictTdd === undefined ? {} : { strictTdd: options.strictTdd }),
      ...(injectedExecutor === undefined
        ? configuredAgent === undefined
          ? {}
          : {
              execution: {
                kind: "agent" as const,
                name: configuredAgent.name,
                deterministic: false,
                adapter_profile: configuredAgent.adapterProfile,
                execute: configuredAgent.execute,
              },
            }
        : { execute: injectedExecutor }),
      evaluate:
        options.evaluate ?? createEvalPackagePort(options.now ?? (() => new Date().toISOString())),
      tasksProjection: renderTasksProjection,
      ...(options.taskEnvelopeScope === undefined
        ? configuredAgent === undefined
          ? {}
          : { taskEnvelopeScope: () => configuredAgent.scope }
        : { taskEnvelopeScope: options.taskEnvelopeScope }),
      ...(configuredAgent === undefined
        ? {}
        : { trajectoryVisibility: configuredAgent.trajectoryVisibility }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.newId === undefined ? {} : { newId: options.newId }),
      ...(options.gates === undefined
        ? configuredGateSuite === undefined
          ? {}
          : { gates: configuredGateSuite.gates }
        : { gates: options.gates }),
      ...(options.toolRegistry === undefined
        ? configuredGateSuite === undefined
          ? {}
          : { toolRegistry: configuredGateSuite.registry }
        : { toolRegistry: options.toolRegistry }),
      ...(prompter === undefined ? {} : { prompter }),
      ...(options.onPhaseProgress === undefined
        ? {}
        : { onPhaseProgress: options.onPhaseProgress }),
      ...(createObservationPublisher === undefined ? {} : { createObservationPublisher }),
      decisionActor: actor,
    };
  };
  const approvalRuntime = createCliApprovalService({
    dependencies: orchestratorDeps,
    defaultActor: actor,
  });
  const resumeRuntime = createCliResumeService({ dependencies: orchestratorDeps });

  const guard = async (
    command: string,
    run: () => Promise<CommandResult>,
  ): Promise<CommandResult> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof OrchestrationError) {
        return {
          command,
          status: "failed",
          message: error.message,
          data: { kind: error.kind },
        };
      }
      if (error instanceof FindingGroupError) {
        return {
          command,
          status: "failed",
          message: error.message,
          data: { kind: error.kind },
        };
      }
      throw error;
    }
  };

  /**
   * Protocol 1.1 profile selection (slim-profiles design 10): explicit flag,
   * interactive confirmation, or a typed input_required — never a default.
   */
  const resolveProjectProfile = async (
    command: string,
    explicit: string | undefined,
    migration?: string,
  ): Promise<
    | { readonly ok: true; readonly profileId: ProfileId; readonly source: string }
    | { readonly ok: false; readonly result: CommandResult }
  > => {
    const chooser = options.io.isInteractive
      ? (options.selectProfile ?? createReadlineProfileChooser(options.io))
      : undefined;
    try {
      const outcome = await resolveProfileSelection({
        ...(explicit === undefined ? {} : { explicit }),
        interactive: chooser !== undefined,
        ...(chooser === undefined ? {} : { choose: chooser }),
      });
      if (outcome.status === "input_required") {
        return {
          ok: false,
          result: {
            command,
            status: "input_required",
            message:
              "project profile required: pass --profile lite|standard|governed " +
              "(interactive sessions choose and confirm a tier explicitly)",
            data: {
              reason: outcome.reason,
              options: [...outcome.options],
              ...(migration === undefined ? {} : { migration }),
            },
          },
        };
      }
      return { ok: true, profileId: outcome.profile_id, source: outcome.source };
    } catch (error) {
      if (error instanceof ProfileSelectionError) {
        return {
          ok: false,
          result: { command, status: "failed", message: error.message, data: { kind: error.kind } },
        };
      }
      throw error;
    }
  };

  const projectIdFor = (projectRoot: string): string => configuration.projectId(projectRoot);

  /** HEAD-bound baseline digest; an unborn or unreadable HEAD degrades to a stable constant. */
  const baselineDigestFor = (projectRoot: string): string =>
    configuration.baselineDigest(projectRoot);

  /**
   * Remote collaboration wiring (plan M3 Task 7): the lease-gated iterate /
   * resume and remote approve/sync/integrate flows all share this runtime;
   * never-connected projects never touch it (zero materialization).
   */
  const collaboration = createCliCollaborationRuntime({
    io: options.io,
    now: clock,
    newId: options.newId ?? ((kind: string) => `${kind}_${ulid()}`),
    projectIdFor,
    readBaseline: (projectRoot) => gitHead(projectRoot),
    ...(options.collaboration === undefined ? {} : { seams: options.collaboration }),
  });

  /**
   * Orchestrator dependencies with the workflow operation id pre-minted, so a
   * connected iterate can acquire the Operation Lease before any local work.
   */
  const orchestratorDepsForWorkflow = (
    projectRoot: string,
    workflowOperationId: string,
  ): OrchestratorDependencies => {
    const base = orchestratorDeps(projectRoot);
    const mint = base.newId ?? ((kind: string) => `${kind}_${ulid()}`);
    let consumed = false;
    return {
      ...base,
      newId: (kind: string) => {
        if (!consumed && kind === "workflow") {
          consumed = true;
          return workflowOperationId;
        }
        return mint(kind);
      },
    };
  };

  // --- M4 scheduler wiring (design 10.2/19/20, plan Task 12) ------------------

  const readRuntimeConfig = (projectRoot: string): ProjectRuntimeConfig => {
    try {
      return readProjectRuntimeConfig(projectRoot);
    } catch (error) {
      if (error instanceof ProjectRuntimeConfigError) {
        throw new OrchestrationError("configuration", error.message);
      }
      throw error;
    }
  };

  /** The effective local concurrency: the request (--max-concurrency), then the
   * configured pool size, then 1 — always clamped by the fixed ceilings. */
  const concurrencyDecisionFor = (
    projectRoot: string,
    requested: number | undefined,
  ): SchedulerConcurrencyDecision =>
    resolveSchedulerConcurrency({
      requested: requested ?? readRuntimeConfig(projectRoot).agent_pool?.slots ?? 1,
      ceilings: CLI_SCHEDULER_CEILINGS,
    });

  /**
   * Default host composition: only projects whose committed runtime config
   * declares an `agent` get a Project Scheduler Host; anything else returns
   * undefined so pre-M4 projects keep their exact behavior. The dsh manifest
   * is never unattended-eligible, so the pool degrades to supervised
   * single-slot mode and says so on stderr before a drive.
   */
  const schedulerHostFor = (request: SchedulerHostRequest): ProjectSchedulerHost | undefined => {
    if (options.schedulerHost !== undefined) return options.schedulerHost(request);
    const runtimeConfig = readRuntimeConfig(request.projectRoot);
    if (runtimeConfig.agent === undefined) return undefined;
    const slotFactory = createProjectAgentSlotFactory({
      projectRoot: request.projectRoot,
      config: runtimeConfig.agent,
    });
    if (request.live === "write") {
      const notice = supervisedSingleSlotNotice(slotFactory.manifest);
      if (notice !== undefined) options.io.writeStderr(`${notice}\n`);
    }
    const projectionPath = join(harnessRootFor(request.projectRoot), "scheduler-projection.sqlite");
    return createProjectSchedulerHost({
      projectRoot: request.projectRoot,
      readBaseline: () => gitHead(request.projectRoot),
      agentSlotFactory: slotFactory,
      // Design §10.1 deviation (host.ts): the manifest declares no capability
      // list, matching the kernel's production compile with allowedCapabilities [].
      adapterCapabilities: [],
      ...(request.maxConcurrency === undefined ? {} : { maxConcurrency: request.maxConcurrency }),
      ceilings: CLI_SCHEDULER_CEILINGS,
      driverKind: request.driverKind,
      // A read against a project that never drove must not create the store.
      projectionStorePath:
        request.live === "read" && !existsSync(projectionPath) ? ":memory:" : projectionPath,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.newId === undefined ? {} : { newId: options.newId }),
    });
  };

  /** DriverLockError stays runtime-internal; recognize it structurally. */
  const isDriverLockError = (error: unknown): boolean =>
    error instanceof Error && error.name === "DriverLockError";

  const driverLockFailure = (
    command: string,
    operationId: string,
    error: unknown,
  ): CommandResult => ({
    command,
    status: "failed",
    message:
      `driver lock for ${operationId} is held by another driver: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    data: { kind: "driver_lock_unavailable", workflow_operation_id: operationId, retryable: true },
  });

  /**
   * The status/abort/run view over the host read model (design 19.2/19.3):
   * the runtime SchedulerStatusProjection plus the operation binding and
   * exactly one recovery action per blocking Finding (design 21; rules without
   * a typed action degrade to inspect_blocking_finding, never a silent ignore).
   */
  const schedulerViewFor = async (
    host: ProjectSchedulerHost,
    operationId: string,
  ): Promise<SchedulerStatusView> => {
    const model = await host.readSchedulerModel(operationId);
    const projection = projectSchedulerStatus(model);
    const blockers = model.findings.map((finding) => {
      const extension = finding.extensions?.["harness.finding"];
      const rule =
        typeof extension === "object" && extension !== null
          ? (extension as { rule?: unknown }).rule
          : undefined;
      const action = typeof rule === "string" ? schedulerRecoveryActionFor(rule) : undefined;
      return {
        finding_id: finding.id,
        ...(typeof rule === "string" ? { rule } : {}),
        recovery_action: action ?? "inspect_blocking_finding",
      };
    });
    return { operation_id: operationId, ...projection, blockers, digest: model.digest };
  };

  /** Post-drive wave progress on stderr; stdout keeps only the CommandResult. */
  const reportWaveProgress = (view: SchedulerStatusView): void => {
    if (view.waves === undefined) return;
    options.io.writeStderr(
      `scheduler: wave ${String(view.waves.integrated)}/${String(view.waves.total)} integrated; ` +
        `live projection ${view.live_state ?? "unknown"}\n`,
    );
  };

  /**
   * One local drive under an explicit Driver Lock (design 10.2/20): acquire
   * before the kernel runs, pass the real handle through the binding (the host
   * port passes caller-supplied handles through untouched), release in
   * `finally`. Lock contention fails closed with driver_lock_unavailable —
   * the port is never invoked. Without a configured/injected host the legacy
   * path runs untouched.
   */
  const driveWithScheduler = async (input: {
    readonly command: string;
    readonly projectRoot: string;
    readonly operationId: string;
    readonly driverKind: "cli" | "dashboard";
    readonly maxConcurrency?: number;
    readonly drive: (deps: OrchestratorDependencies) => Promise<OrchestrationOutcome>;
  }): Promise<CommandResult> => {
    const decision = concurrencyDecisionFor(input.projectRoot, input.maxConcurrency);
    const host = schedulerHostFor({
      projectRoot: input.projectRoot,
      driverKind: input.driverKind,
      maxConcurrency: decision.effective,
      live: "write",
    });
    if (host === undefined) {
      return outcomeToResult(input.command, await input.drive(orchestratorDeps(input.projectRoot)));
    }
    let handle: AcquiredDriverLock;
    try {
      handle = await host.acquireDriverLock(input.operationId);
    } catch (error) {
      if (isDriverLockError(error)) {
        return driverLockFailure(input.command, input.operationId, error);
      }
      throw error;
    }
    try {
      const acquired = handle;
      const deps: OrchestratorDependencies = {
        ...orchestratorDeps(input.projectRoot),
        parallelExecution: {
          port: host.parallelExecution.port,
          driverLock: () => acquired,
        },
      };
      const outcome = await input.drive(deps);
      const scheduler = await schedulerViewFor(host, input.operationId);
      reportWaveProgress(scheduler);
      return outcomeToResult(input.command, outcome, {
        concurrency: { ...decision },
        scheduler,
      });
    } finally {
      await handle.release();
    }
  };

  /**
   * T20 slice 1 capture routing: when the committed runtime config declares a
   * provider covering the prd_proposal slot, intent is interpreted through the
   * managed model layer; anything else keeps the generic interpreter, so
   * unconfigured projects behave exactly as before. The managed interpreter is
   * constructed at capture time — after profile selection persisted the
   * project profile record — so the session binds real profile digests.
   */
  const managedCaptureInterpreter = (
    projectRoot: string,
    runtimeConfig: ProjectRuntimeConfig,
  ): IntentInterpreter => {
    const generic = createGenericInterpreter();
    return (intent: string) => {
      let profile: ProjectProfileRecord | undefined;
      try {
        profile = readLatestProjectProfile(projectRoot, projectIdFor(projectRoot));
      } catch (error) {
        if (error instanceof ProjectLayoutError) return generic(intent);
        throw error;
      }
      const managed =
        profile === undefined
          ? undefined
          : (() => {
              const decision = readProfileDecisionRecords(projectRoot)
                .filter(
                  (candidate) =>
                    candidate.project_id === profile.project_id &&
                    candidate.decided_profile_id === profile.profile_id,
                )
                .at(-1);
              if (decision === undefined) {
                throw new OrchestrationError(
                  "configuration",
                  `ProjectProfile ${profile.record_digest} has no persisted ProfileDecision`,
                );
              }
              return createManagedIntentInterpreter({
                projectRoot,
                runtimeConfig,
                profile_id: profile.profile_id,
                session_context: {
                  project_profile_digest: profile.record_digest,
                  profile_decision_digest: decision.record_digest,
                  capture_policy_digest: profile.policy_digest,
                  // No requirement baseline exists before capture; the digest
                  // binds the git baseline (HEAD) the intent is read against.
                  project_baseline_digest: baselineDigestFor(projectRoot),
                },
                newId: options.newId ?? ((kind: string) => `${kind}_${ulid()}`),
                ...(options.providerRegistry === undefined
                  ? {}
                  : { providerRegistry: options.providerRegistry }),
                ...(options.providerFetch === undefined ? {} : { fetch: options.providerFetch }),
                ...(options.providerEnvironment === undefined
                  ? {}
                  : { environment: options.providerEnvironment }),
              });
            })();
      return managed === undefined ? generic(intent) : managed(intent);
    };
  };

  /**
   * T20 slice 2 design/impact/context routing: when the committed runtime
   * config declares providers covering the pipeline slots, the orchestrator
   * dependencies carry the model-backed ports (design proposal/review, impact
   * advisory, plan proposal, context enrichment, feedback analysis and
   * iteration narrative). Provider closure is
   * re-verified at this preflight point (design 11.2): a Standard/Governed
   * profile missing `model_providers` — or coverage for any required blocking
   * slot — fails closed as a configuration error; Lite and pre-1.1 legacy
   * projects (no profile record) keep the exact current
   * deterministic/blocked behavior.
   */
  const managedPipelinePortsFor = (
    projectRoot: string,
    runtimeConfig: ProjectRuntimeConfig,
  ): ReturnType<typeof createManagedPipelinePorts> => {
    let profile: ProjectProfileRecord | undefined;
    try {
      profile = readLatestProjectProfile(projectRoot, projectIdFor(projectRoot));
    } catch (error) {
      if (error instanceof ProjectLayoutError) return {};
      throw error;
    }
    if (profile === undefined) return {};
    try {
      return createManagedPipelinePorts({
        projectRoot,
        runtimeConfig,
        profile_id: profile.profile_id,
        ...(options.providerRegistry === undefined
          ? {}
          : { providerRegistry: options.providerRegistry }),
        ...(options.providerFetch === undefined ? {} : { fetch: options.providerFetch }),
        ...(options.providerEnvironment === undefined
          ? {}
          : { environment: options.providerEnvironment }),
      });
    } catch (error) {
      if (error instanceof ManagedPipelinePortsError) {
        throw new OrchestrationError("configuration", error.message);
      }
      throw error;
    }
  };

  const persistInitialProfile = configuration.persistInitialProfile;
  const changeProjectProfile = configuration.changeProjectProfile;

  const profileResultExtra = (profile: ProjectProfileRecord): Record<string, unknown> => ({
    profile_id: profile.profile_id,
    profile_revision: profile.revision,
    profile_record_digest: profile.record_digest,
  });

  const iterateImpl = async (request: IterateRequest): Promise<CommandResult> =>
    guard("iterate", async () => {
      // `iterate` always binds the current project profile revision; a legacy
      // project without any record must be migrated by an explicit selection.
      const projectId = projectIdFor(request.projectRoot);
      const resolution = resolveIterationProfile(
        readLatestProjectProfile(request.projectRoot, projectId),
      );
      let active: ProjectProfileRecord;
      if (resolution.status === "input_required") {
        const selection = await resolveProjectProfile(
          "iterate",
          request.profile,
          resolution.migration,
        );
        if (!selection.ok) return selection.result;
        active = persistInitialProfile(request.projectRoot, selection.profileId);
      } else {
        active = resolution.profile;
        if (request.profile !== undefined) {
          const selection = await resolveProjectProfile("iterate", request.profile);
          if (!selection.ok) return selection.result;
          if (selection.profileId !== active.profile_id) {
            active = changeProjectProfile(request.projectRoot, active, selection.profileId);
          }
        }
      }
      const remote = await iterateRemoteImpl(request, active);
      if (remote !== undefined) return remote;
      // M4: when a scheduler host is configured the parallel binding rides the
      // deferred facade — the host acquires and releases the Driver Lock inside
      // `port.run`, only if the execute node actually dispatches waves.
      const decision = concurrencyDecisionFor(request.projectRoot, undefined);
      const host = schedulerHostFor({
        projectRoot: request.projectRoot,
        driverKind: "cli",
        maxConcurrency: decision.effective,
        live: "write",
      });
      const base = orchestratorDeps(request.projectRoot);
      const outcome = await runIteration(
        host === undefined ? base : { ...base, parallelExecution: host.parallelExecution },
        {
          intent: request.text,
          intentShape: "pack-converted",
        },
      );
      return outcomeToResult("iterate", outcome, profileResultExtra(active));
    });

  /**
   * Connected iterate (design section 18.1): the Operation Lease is acquired
   * before any local work; local candidate commits are pushed to the staging
   * ref and published with the live fencing token instead of pushing the
   * managed Operation Ref directly.
   */
  const iterateRemoteImpl = async (
    request: IterateRequest,
    active: ProjectProfileRecord,
  ): Promise<CommandResult | undefined> => {
    const context = collaboration.remoteContext(request.projectRoot);
    if (context === undefined) return undefined;
    const operationId = (options.newId ?? ((kind: string) => `${kind}_${ulid()}`))("workflow");
    const lease = await collaboration.acquireLease(context, operationId);
    if (lease.status === "failed") {
      return {
        command: "iterate",
        status: "failed",
        message: lease.failure.summary,
        data: { kind: lease.failure.code, retryable: lease.failure.retryable },
      };
    }
    const baselineBefore = gitHead(request.projectRoot);
    let outcome: OrchestrationOutcome;
    try {
      const decision = concurrencyDecisionFor(request.projectRoot, undefined);
      const host = schedulerHostFor({
        projectRoot: request.projectRoot,
        driverKind: "cli",
        maxConcurrency: decision.effective,
        live: "write",
      });
      const base = orchestratorDepsForWorkflow(request.projectRoot, operationId);
      // Connected mode: the deferred Driver Lock facade plus the live M3
      // Operation Lease accessor, so the drive validates the fencing token.
      const deps =
        host === undefined
          ? base
          : {
              ...base,
              parallelExecution: {
                port: host.parallelExecution.port,
                driverLock: host.parallelExecution.driverLock,
                operationLease: () => lease.lease,
              },
            };
      outcome = await runIteration(deps, {
        intent: request.text,
        intentShape: "pack-converted",
      });
    } catch (error) {
      // A crashed iteration must not strand the Operation Lease.
      await collaboration.releaseLease(context, operationId);
      throw error;
    }
    const publishFailure = await collaboration.publishCandidate(
      context,
      operationId,
      baselineBefore,
    );
    if (publishFailure !== undefined) {
      await collaboration.releaseLease(context, operationId);
      return {
        command: "iterate",
        status: "failed",
        message: publishFailure.failure.summary,
        data: { kind: publishFailure.failure.code, retryable: publishFailure.failure.retryable },
      };
    }
    // A finished run (completed, input_required or the terminal aborted)
    // releases the lease; an approval pause or a blocked/migration resumable
    // run keeps it so the same client resumes with the fencing token.
    if (
      outcome.status === "input_required" ||
      outcome.status === "completed" ||
      outcome.status === "aborted"
    ) {
      await collaboration.releaseLease(context, operationId);
    }
    return outcomeToResult("iterate", outcome, profileResultExtra(active));
  };

  /** Connected resume: renew (or re-acquire) the lease, resume locally, publish. */
  const resumeRemoteImpl = async (request: ResumeRequest): Promise<CommandResult | undefined> => {
    const context = collaboration.remoteContext(request.projectRoot);
    if (context === undefined) return undefined;
    const lease = await collaboration.renewOrAcquireLease(context, request.workflowOperationId);
    if (lease.status === "failed") {
      return {
        command: "resume",
        status: "failed",
        message: lease.failure.summary,
        data: { kind: lease.failure.code, retryable: lease.failure.retryable },
      };
    }
    const baselineBefore = gitHead(request.projectRoot);
    // Connected resume drives under the same explicit Driver Lock as the local
    // path; the binding also carries the live M3 Operation Lease accessor.
    const decision = concurrencyDecisionFor(request.projectRoot, request.maxConcurrency);
    const host = schedulerHostFor({
      projectRoot: request.projectRoot,
      driverKind: "cli",
      maxConcurrency: decision.effective,
      live: "write",
    });
    let handle: AcquiredDriverLock | undefined;
    if (host !== undefined) {
      try {
        handle = await host.acquireDriverLock(request.workflowOperationId);
      } catch (error) {
        await collaboration.releaseLease(context, request.workflowOperationId);
        if (isDriverLockError(error)) {
          return driverLockFailure("resume", request.workflowOperationId, error);
        }
        throw error;
      }
    }
    let outcome: OrchestrationOutcome;
    try {
      outcome = await createCliResumeService({
        dependencies: (projectRoot) => {
          const base = orchestratorDeps(projectRoot);
          if (host === undefined || handle === undefined) return base;
          const acquired = handle;
          return {
            ...base,
            parallelExecution: {
              port: host.parallelExecution.port,
              driverLock: () => acquired,
              operationLease: () => lease.lease,
            },
          };
        },
      }).resume({
        projectRoot: request.projectRoot,
        workflowOperationId: request.workflowOperationId,
        ...(request.answers === undefined ? {} : { answers: request.answers }),
      });
    } catch (error) {
      // A crashed resume must not strand the Operation Lease.
      await collaboration.releaseLease(context, request.workflowOperationId);
      throw error;
    } finally {
      await handle?.release();
    }
    const publishFailure = await collaboration.publishCandidate(
      context,
      request.workflowOperationId,
      baselineBefore,
    );
    if (publishFailure !== undefined) {
      await collaboration.releaseLease(context, request.workflowOperationId);
      return {
        command: "resume",
        status: "failed",
        message: publishFailure.failure.summary,
        data: { kind: publishFailure.failure.code, retryable: publishFailure.failure.retryable },
      };
    }
    if (
      outcome.status === "input_required" ||
      outcome.status === "completed" ||
      outcome.status === "aborted"
    ) {
      await collaboration.releaseLease(context, request.workflowOperationId);
    }
    return outcomeToResult("resume", outcome);
  };

  const resumeImpl = async (request: ResumeRequest): Promise<CommandResult> =>
    guard("resume", async () => {
      const projectId = projectIdFor(request.projectRoot);
      const resolution = resolveIterationProfile(
        readLatestProjectProfile(request.projectRoot, projectId),
      );
      if (resolution.status === "input_required") {
        const selection = await resolveProjectProfile(
          "resume",
          request.profile,
          resolution.migration,
        );
        if (!selection.ok) return selection.result;
        persistInitialProfile(request.projectRoot, selection.profileId);
      }
      const remote = await resumeRemoteImpl(request);
      if (remote !== undefined) return remote;
      return driveWithScheduler({
        command: "resume",
        projectRoot: request.projectRoot,
        operationId: request.workflowOperationId,
        driverKind: "cli",
        ...(request.maxConcurrency === undefined ? {} : { maxConcurrency: request.maxConcurrency }),
        drive: (deps) =>
          createCliResumeService({ dependencies: () => deps }).resume({
            projectRoot: request.projectRoot,
            workflowOperationId: request.workflowOperationId,
            ...(request.answers === undefined ? {} : { answers: request.answers }),
          }),
      });
    });

  const abortImpl = async (request: AbortRequest): Promise<CommandResult> =>
    guard("abort", async () => {
      const aborted = await resumeRuntime.abort({
        projectRoot: request.projectRoot,
        workflowOperationId: request.workflowOperationId,
        actor: request.actor ?? actor,
      });
      // Post-abort scheduler reconciliation (design 19.2): a read-only view —
      // abort never takes the Driver Lock.
      const host = schedulerHostFor({
        projectRoot: request.projectRoot,
        driverKind: "cli",
        live: "read",
      });
      const scheduler =
        host === undefined ? undefined : await schedulerViewFor(host, request.workflowOperationId);
      return {
        command: "abort",
        status: "ok",
        message:
          `workflow operation ${aborted.workflowOperationId} aborted; ` +
          `${String(aborted.rejectedRequests.length)} pending approval request(s) rejected`,
        data: {
          workflow_operation_id: aborted.workflowOperationId,
          iteration_id: aborted.iterationId,
          rejected_requests: [...aborted.rejectedRequests],
          ...(scheduler === undefined ? {} : { scheduler }),
        },
      };
    });

  const adoptCommitAndIterate = async (
    request: AdoptProjectRequest,
    stagingOperationId: string,
    previewDigest: string,
    profileId: ProfileId,
  ): Promise<CommandResult> => {
    const projectRoot = resolve(options.cwd, request.path);
    const committed = await bootstrap.commitAdoption({
      projectRoot,
      stagingOperationId,
      approval: { decision: "approve", previewDigest, actor },
    });
    if (!committed.ok) {
      return {
        command: "adopt",
        status: "failed",
        message: committed.error.message,
        data: { kind: committed.error.kind },
      };
    }
    if (!committed.value.committed) {
      return {
        command: "adopt",
        status: "failed",
        message: "adoption baseline was not committed",
        data: { staging_operation_id: stagingOperationId },
      };
    }
    const profile = persistInitialProfile(projectRoot, profileId);
    const outcome = await runIteration(orchestratorDeps(projectRoot), {
      intent: request.intent,
      intentShape: "pack-converted",
      ...(committed.value.iterationId === undefined
        ? {}
        : { iterationId: committed.value.iterationId }),
    });
    return outcomeToResult("adopt", outcome, {
      project_root: projectRoot,
      baseline_commit: committed.value.baselineCommit,
      ...profileResultExtra(profile),
    });
  };

  return {
    newProject: async (request: NewProjectRequest): Promise<CommandResult> =>
      guard("new", async () => {
        const selection = await resolveProjectProfile("new", request.profile);
        if (!selection.ok) return selection.result;
        const outcome = await bootstrap.newProject({
          parentDirectory: options.cwd,
          name: request.name,
          intent: request.intent,
        });
        if (!outcome.ok) {
          return {
            command: "new",
            status: "failed",
            message: outcome.error.message,
            data: { kind: outcome.error.kind },
          };
        }
        // The chosen tier is an auditable fact committed before any capture.
        const profile = persistInitialProfile(outcome.value.projectRoot, selection.profileId);
        const iteration = await runIteration(orchestratorDeps(outcome.value.projectRoot), {
          intent: request.intent,
          intentShape: "pack-converted",
          iterationId: outcome.value.iterationId,
        });
        return outcomeToResult("new", iteration, {
          project_root: outcome.value.projectRoot,
          name: outcome.value.name,
          baseline_commit: outcome.value.baselineCommit,
          branch: outcome.value.branch,
          ...profileResultExtra(profile),
        });
      }),

    adoptProject: async (request: AdoptProjectRequest): Promise<CommandResult> =>
      guard("adopt", async () => {
        const selection = await resolveProjectProfile("adopt", request.profile);
        if (!selection.ok) return selection.result;
        const projectRoot = resolve(options.cwd, request.path);
        if (request.approveStaging !== undefined) {
          const staged = readStagedAdoptionPreview(projectRoot, request.approveStaging);
          if (staged === undefined) {
            return {
              command: "adopt",
              status: "failed",
              message: `no staged adoption preview: ${request.approveStaging}`,
              data: { staging_operation_id: request.approveStaging },
            };
          }
          return adoptCommitAndIterate(
            request,
            request.approveStaging,
            staged.previewDigest,
            selection.profileId,
          );
        }
        const preview = await bootstrap.prepareAdoption({ projectRoot, intent: request.intent });
        if (!preview.ok) {
          return {
            command: "adopt",
            status: "failed",
            message: preview.error.message,
            data: { kind: preview.error.kind },
          };
        }
        const resumeCommand = `harness adopt ${request.path} --intent ${JSON.stringify(request.intent)} --profile ${selection.profileId} --approve ${preview.value.stagingOperationId}`;
        if (prompter !== undefined) {
          const raw = await prompter.prompt(
            `Adoption preview for ${preview.value.name}: stack ${preview.value.preview.stack.primary}, ` +
              `${String(preview.value.preview.files.length)} files, ` +
              `${String(preview.value.preview.components.length)} components, ` +
              `${String(preview.value.preview.conflicts.length)} conflicts ` +
              `(preview digest ${preview.value.previewDigest.slice(0, 16)}...)`,
            ["approve", "reject", "defer"],
          );
          const decision = parseApprovalDecision(raw, ["approve", "reject", "defer"]);
          if (decision === "approve") {
            return adoptCommitAndIterate(
              request,
              preview.value.stagingOperationId,
              preview.value.previewDigest,
              selection.profileId,
            );
          }
          if (decision === "reject") {
            await bootstrap.commitAdoption({
              projectRoot,
              stagingOperationId: preview.value.stagingOperationId,
              approval: { decision: "reject", previewDigest: preview.value.previewDigest, actor },
            });
            return {
              command: "adopt",
              status: "ok",
              message: `adoption of ${preview.value.name} rejected; staging preserved for revision`,
              data: { staging_operation_id: preview.value.stagingOperationId },
            };
          }
        }
        return {
          command: "adopt",
          status: "approval_required",
          message: `adoption preview ${preview.value.stagingOperationId} awaits approval; then run: ${resumeCommand}`,
          data: {
            request_id: preview.value.stagingOperationId,
            object_id: preview.value.repositoryId,
            object_type: "AdoptionBaseline",
            object_digest: preview.value.previewDigest,
            staging_operation_id: preview.value.stagingOperationId,
            preview_digest: preview.value.previewDigest,
            resume_command: resumeCommand,
            allowed_decisions: ["approve", "reject", "defer"],
            stack: preview.value.preview.stack.primary,
            files: preview.value.preview.files.length,
            components: preview.value.preview.components.length,
            conflicts: preview.value.preview.conflicts.length,
          },
        };
      }),

    iterate: iterateImpl,
    resume: resumeImpl,
    abort: abortImpl,
    finding: async (request: FindingRequest): Promise<CommandResult> =>
      guard("finding", async () => {
        const resolved = await resolveFinding(orchestratorDeps(request.projectRoot), {
          findingId: request.findingId,
          action: request.action,
          actor: request.actor ?? actor,
          ...(request.evidenceId === undefined ? {} : { evidenceId: request.evidenceId }),
        });
        return {
          command: "finding",
          status: "ok",
          message: `finding ${resolved.findingId} is now ${resolved.status}`,
          data: {
            finding_id: resolved.findingId,
            action: resolved.action,
            status: resolved.status,
          },
        };
      }),

    findingGroup: async (request: FindingGroupRequest): Promise<CommandResult> =>
      guard("finding", async () => {
        const resolved = await resolveFindingGroup(orchestratorDeps(request.projectRoot), {
          groupId: request.groupId,
          membershipDigest: request.membershipDigest,
          action: request.action,
          actor: request.actor ?? actor,
          ...(request.evidenceId === undefined ? {} : { evidenceId: request.evidenceId }),
        });
        return {
          command: "finding",
          status: "ok",
          message: `finding group ${resolved.groupId} is now ${resolved.status}`,
          data: {
            group_id: resolved.groupId,
            membership_digest: resolved.membershipDigest,
            action: resolved.action,
            status: resolved.status,
            members: [...resolved.members],
          },
        };
      }),

    serve: async (request: ServeRequest): Promise<CommandResult> => {
      const deps = orchestratorDeps(request.projectRoot);
      // M4 Task 13 composition seam: reads remain lock-free and delegate to
      // the same project Scheduler Host used by status/run/resume. The host
      // is absent for projects without an activated/configured Scheduler, in
      // which case Dashboard keeps its explicit unavailable projection.
      const dashboardSchedulerReadHost = schedulerHostFor({
        projectRoot: request.projectRoot,
        driverKind: "dashboard",
        live: "read",
      });
      let dashboardSchedulerControlHost: ProjectSchedulerHost | undefined;
      let dashboardSchedulerControlHostResolved = false;
      const controlHost = (): ProjectSchedulerHost | undefined => {
        if (dashboardSchedulerControlHostResolved) return dashboardSchedulerControlHost;
        dashboardSchedulerControlHostResolved = true;
        const decision = concurrencyDecisionFor(request.projectRoot, undefined);
        dashboardSchedulerControlHost = schedulerHostFor({
          projectRoot: request.projectRoot,
          driverKind: "dashboard",
          maxConcurrency: decision.effective,
          live: "write",
        });
        return dashboardSchedulerControlHost;
      };
      const writeFailure = (error: unknown): never => {
        if (
          (error instanceof OrchestrationError && error.kind === "binding_drift") ||
          (error instanceof ApprovalError && error.kind === "approval_binding_drift") ||
          (error instanceof FindingGroupError && error.kind === "finding_group_digest_mismatch")
        ) {
          throw new DashboardWriteError("conflict", "the target changed; refresh before retrying");
        }
        if (
          (error instanceof OrchestrationError && error.kind === "operation_not_found") ||
          (error instanceof ApprovalError && error.kind === "approval_request_not_found") ||
          (error instanceof FindingGroupError && error.kind === "finding_group_not_found") ||
          (error instanceof WorkflowError && error.kind === "operation_not_found")
        ) {
          throw new DashboardWriteError("not_found", "the requested target no longer exists");
        }
        if (
          error instanceof OrchestrationError ||
          error instanceof ApprovalError ||
          error instanceof FindingGroupError ||
          error instanceof WorkflowError
        ) {
          throw new DashboardWriteError("invalid", "the governed operation was refused");
        }
        throw error;
      };
      const server = await startDashboardServer({
        projectRoot: request.projectRoot,
        port: request.port,
        ...(dashboardSchedulerReadHost === undefined
          ? {}
          : {
              schedulerApi: createDashboardSchedulerApi({
                readSchedulerModel: (operationId) =>
                  (dashboardSchedulerControlHost ?? dashboardSchedulerReadHost).readSchedulerModel(
                    operationId,
                  ),
                controlCapabilities: { cancel: true, policyProposal: false },
              }),
            }),
        schedulerOperationId: () =>
          findOpenWorkflowOperation(request.projectRoot, deps.readBaseline),
        writeApi: {
          decideApproval: async (input) => {
            try {
              const resolved = await resolveApproval(deps, {
                requestId: input.requestId,
                decision: input.decision,
                actor: input.actor,
                expectedObjectDigest: input.expectedDigest,
              });
              const workflow = readCurrentOperation(
                { projectRoot: request.projectRoot, readBaseline: deps.readBaseline },
                resolved.workflowOperationId,
              );
              return {
                request_id: resolved.requestId,
                decision: resolved.decision,
                approval_digest: resolved.approvalDigest,
                workflow_operation_id: resolved.workflowOperationId,
                ...(workflow === undefined ? {} : { workflow_digest: contentDigest(workflow) }),
                expected_digest: input.expectedDigest,
                actor: input.actor,
                scheduler_driver_state: "exited",
                resume_command: `harness resume ${resolved.workflowOperationId}`,
              };
            } catch (error) {
              return writeFailure(error);
            }
          },
          resumeWorkflow: async (input) => {
            try {
              const current = readCurrentOperation(
                { projectRoot: request.projectRoot, readBaseline: deps.readBaseline },
                input.workflowOperationId,
              );
              if (current === undefined) {
                throw new DashboardWriteError("not_found", "the workflow no longer exists");
              }
              if (contentDigest(current) !== input.expectedDigest) {
                throw new DashboardWriteError(
                  "conflict",
                  "the workflow changed; refresh before retrying",
                );
              }
              // M4 design 19.5: the dashboard resume is the "dashboard" driver
              // — it takes the same Driver Lock a CLI run/resume would, so a
              // local drive and a browser drive can never overlap.
              const host = controlHost();
              let driveDeps = deps;
              let handle: AcquiredDriverLock | undefined;
              if (host !== undefined) {
                try {
                  handle = await host.acquireDriverLock(input.workflowOperationId);
                } catch (error) {
                  if (isDriverLockError(error)) {
                    throw new DashboardWriteError(
                      "conflict",
                      "the driver lock is held by another driver; retry once it is released",
                    );
                  }
                  throw error;
                }
                const acquired = handle;
                driveDeps = {
                  ...deps,
                  parallelExecution: {
                    port: host.parallelExecution.port,
                    driverLock: () => acquired,
                  },
                };
              }
              try {
                const outcome = await resumeIteration(driveDeps, input.workflowOperationId, {
                  intent: "",
                  intentShape: "pack-converted",
                });
                return {
                  ...outcomeToResult("resume", outcome).data,
                  status: outcome.status,
                  expected_digest: input.expectedDigest,
                  actor: input.actor,
                };
              } finally {
                await handle?.release();
              }
            } catch (error) {
              if (error instanceof DashboardWriteError) throw error;
              return writeFailure(error);
            }
          },
          resolveFindingGroup: async (input) => {
            try {
              const resolved = await resolveFindingGroup(deps, {
                groupId: input.groupId,
                membershipDigest: input.expectedDigest,
                action: input.action,
                actor: input.actor,
                ...(input.evidenceId === undefined ? {} : { evidenceId: input.evidenceId }),
              });
              return {
                group_id: resolved.groupId,
                membership_digest: resolved.membershipDigest,
                action: resolved.action,
                status: resolved.status,
                members: [...resolved.members],
                actor: input.actor,
              };
            } catch (error) {
              return writeFailure(error);
            }
          },
          cancelSchedulerOperation: async (input) => {
            try {
              const host = controlHost();
              if (host === undefined) {
                throw new DashboardWriteError(
                  "unavailable",
                  "this project has no active Scheduler control Provider",
                );
              }
              const activeOperationId = findOpenWorkflowOperation(
                request.projectRoot,
                deps.readBaseline,
              );
              if (activeOperationId !== input.operationId) {
                throw new DashboardWriteError(
                  "conflict",
                  "the active operation changed; refresh before cancelling",
                );
              }
              const model = await host.readSchedulerModel(input.operationId);
              if (model.digest !== input.expectedDigest) {
                throw new DashboardWriteError(
                  "conflict",
                  "the Scheduler read branch changed; refresh before cancelling",
                );
              }
              await host.cancelOperation(
                input.operationId,
                `dashboard cancellation requested by ${input.actor}`,
              );
              const aborted = await resumeRuntime.abort({
                projectRoot: request.projectRoot,
                workflowOperationId: input.operationId,
                actor: input.actor,
              });
              const current = readCurrentOperation(
                { projectRoot: request.projectRoot, readBaseline: deps.readBaseline },
                input.operationId,
              );
              return {
                status: "cancelled",
                workflow_operation_id: aborted.workflowOperationId,
                iteration_id: aborted.iterationId,
                rejected_requests: [...aborted.rejectedRequests],
                evidence_digest: contentDigest(current),
              };
            } catch (error) {
              if (error instanceof DashboardWriteError) throw error;
              if (isDriverLockError(error)) {
                throw new DashboardWriteError(
                  "conflict",
                  "the driver lock is held by another driver; retry once it is released",
                );
              }
              return writeFailure(error);
            }
          },
          proposeSchedulerPolicy: () =>
            Promise.reject(
              new DashboardWriteError(
                "unavailable",
                "the Scheduler Policy Proposal Provider is not configured; no proposal was written",
              ),
            ),
        },
      });
      options.onServerReady?.(server);
      const shutdown = (): void => {
        void server.close().then(
          () => {
            process.exitCode = 0;
          },
          () => {
            process.exitCode = 1;
          },
        );
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      return {
        command: "serve",
        status: "ok",
        message: `Dashboard listening at ${server.bootstrapUrl}`,
        data: {
          host: server.host,
          port: server.port,
          origin: server.origin,
          bootstrap_url: server.bootstrapUrl,
        },
      };
    },

    connect: async (request: ConnectRequest): Promise<CommandResult> =>
      guard("connect", () => collaboration.connect(request)),

    disconnect: async (request: DisconnectRequest): Promise<CommandResult> =>
      guard("disconnect", () => collaboration.disconnect(request)),

    sync: async (request: SyncRequest): Promise<CommandResult> =>
      guard("sync", () => collaboration.sync(request)),

    integrate: async (request: IntegrateRequest): Promise<CommandResult> =>
      guard("integrate", () => collaboration.integrate(request)),

    coordinator: async (request: CoordinatorHostRequest): Promise<CommandResult> =>
      guard("coordinator", () => collaboration.coordinator(request)),

    remoteSummary: (request: ProjectRequest): Promise<Record<string, unknown> | undefined> =>
      collaboration.remoteSummary(request),

    schedulerStatus: async (request: ProjectRequest): Promise<SchedulerStatusView | undefined> => {
      const openOperation = findOpenWorkflowOperation(request.projectRoot, () =>
        gitHead(request.projectRoot),
      );
      if (openOperation === undefined) return undefined;
      const host = schedulerHostFor({
        projectRoot: request.projectRoot,
        driverKind: "cli",
        live: "read",
      });
      if (host === undefined) return undefined;
      return schedulerViewFor(host, openOperation);
    },

    approve: async (request: ApproveRequest): Promise<CommandResult> =>
      guard("approve", async () => {
        // An active collaboration connection routes the decision through the
        // Coordinator (design section 18.1); otherwise the local ledger path
        // is untouched.
        const remote = await collaboration.submitRemoteApproval(request);
        if (remote !== undefined) return remote;
        const resolved = await approvalRuntime.resolve({
          projectRoot: request.projectRoot,
          requestId: request.requestId,
          decision: request.decision,
          actor: request.actor ?? actor,
        });
        return {
          command: "approve",
          status: "ok",
          message: `approval request ${resolved.requestId} resolved as ${resolved.decision}; resume with: harness resume ${resolved.workflowOperationId}`,
          data: {
            request_id: resolved.requestId,
            decision: resolved.decision,
            approval_digest: resolved.approvalDigest,
            workflow_operation_id: resolved.workflowOperationId,
            resume_command: `harness resume ${resolved.workflowOperationId}`,
          },
        };
      }),

    impact: async (request: ImpactRequest): Promise<CommandResult> =>
      guard("impact", async () => {
        const preview = previewImpactSet(request.projectRoot, request.target);
        let semantic: Record<string, unknown> = {};
        if (request.semantic) {
          try {
            const batch = await proposeSemanticImpactEdges(
              {
                projectRoot: request.projectRoot,
                readBaseline: () => gitHead(request.projectRoot),
                ...(options.now === undefined ? {} : { now: options.now }),
                ...(options.semanticProvider === undefined
                  ? {}
                  : { semanticProvider: options.semanticProvider }),
              },
              { sourceNodeIds: [preview.seedNodeId], actor },
            );
            semantic = {
              semantic_descriptor: { ...batch.descriptor },
              semantic_proposals: batch.proposals.map((proposal) => ({
                edge_id: proposal.edgeId,
                source_node_id: proposal.sourceNodeId,
                candidate_node_id: proposal.candidateNodeId,
                score: proposal.score,
                reason: proposal.reason,
                preview_digest: proposal.previewDigest,
                approve_command: `harness graph approve-edge ${proposal.edgeId} --digest ${proposal.previewDigest}`,
              })),
            };
          } catch (error) {
            semantic = {
              semantic_proposals: [],
              semantic_diagnostic:
                error instanceof Error ? error.message : "semantic provider failed",
            };
          }
        }
        return {
          command: "impact",
          status: "ok",
          message: `impact preview from ${preview.seedNodeId}: ${String(preview.entries.length)} impacted nodes`,
          data: {
            impact_set_id: preview.impactSetId,
            content_digest: preview.contentDigest,
            seed_node_id: preview.seedNodeId,
            entries: preview.entries.map((entry) => ({ ...entry })),
            ...semantic,
          },
        };
      }),

    plan: async (request: ProjectRequest): Promise<CommandResult> =>
      guard("plan", async () => {
        // Full canonical content read (M4 design 19.3): the latest plan node
        // plus its exact Task/CONTAINS/DEPENDS_ON projection, so protocol 1.3
        // waves, resource claims and budgets surface alongside the legacy view.
        const graph = materializeProjectGraph(request.projectRoot);
        try {
          const node = [...graph.nodes]
            .filter((candidate) => candidate.type === "ExecutionPlan")
            .sort((left, right) => (left.id < right.id ? -1 : 1))
            .at(-1);
          if (node === undefined) {
            return {
              command: "plan",
              status: "failed",
              message: "no committed execution plan; run an iteration first",
              data: {},
            };
          }
          const contained = new Set(
            graph.edges
              .filter((edge) => edge.type === "CONTAINS" && edge.source_id === node.id)
              .map((edge) => edge.target_id),
          );
          const taskNodes = latestNodeRevisions(
            graph.nodes.filter((candidate) => contained.has(candidate.id)),
          );
          const edges = graph.edges.filter(
            (edge) =>
              (edge.type === "CONTAINS" &&
                edge.source_id === node.id &&
                contained.has(edge.target_id)) ||
              (edge.type === "DEPENDS_ON" &&
                contained.has(edge.source_id) &&
                contained.has(edge.target_id)),
          );
          const content = readExecutionPlanContent(node, { tasks: taskNodes, edges });
          return {
            command: "plan",
            status: "ok",
            message:
              `plan ${node.id} (${content.mode}) with ${String(content.tasks.length)} task(s)` +
              (content.parallel_waves === undefined
                ? ""
                : ` in ${String(content.parallel_waves.length)} wave(s)`),
            data: {
              plan_id: node.id,
              mode: content.mode,
              impact_set_id: content.impact_set_id,
              iteration_id: node.provenance.iteration_id,
              tasks: content.tasks.map((task) => ({
                id: task.id,
                objective: task.objective,
                required_gates: [...task.required_gates],
                dependencies: [...task.dependencies],
                budget: { ...task.budget },
                ...(task.write_paths === undefined ? {} : { write_paths: [...task.write_paths] }),
                ...(task.exclusive_resources === undefined
                  ? {}
                  : { exclusive_resources: [...task.exclusive_resources] }),
              })),
              ...(content.parallel_waves === undefined
                ? {}
                : {
                    waves: content.parallel_waves.map((wave) => ({
                      wave_index: wave.wave_index,
                      task_ids: [...wave.task_ids],
                    })),
                    presentation: presentExecutionPlan(content),
                  }),
              ...(content.iteration_budget === undefined
                ? {}
                : { iteration_budget: { ...content.iteration_budget } }),
            },
          };
        } finally {
          graph.close();
        }
      }),

    run: async (request: RunRequest): Promise<CommandResult> =>
      guard("run", async () => {
        if (request.dryRun) {
          const plan = readLatestExecutionPlan(request.projectRoot);
          if (plan === undefined) {
            return {
              command: "run",
              status: "failed",
              message: "no committed execution plan; run an iteration first",
              data: {},
            };
          }
          return {
            command: "run",
            status: "ok",
            message: `dry run: ${String(plan.tasks.length)} planned task(s), no adapter executed`,
            data: {
              dry_run: true,
              plan_id: plan.planId,
              tasks: plan.tasks.map((task) => ({
                id: task.id,
                objective: task.objective,
                required_gates: [...task.required_gates],
              })),
            },
          };
        }
        const openOperation = findOpenWorkflowOperation(request.projectRoot, () =>
          gitHead(request.projectRoot),
        );
        if (openOperation === undefined) {
          // Preserve the exact no-open-operation failure of the legacy path.
          const outcome = await driveOpenOperation(
            orchestratorDeps(request.projectRoot),
            "execute",
          );
          return outcomeToResult("run", outcome);
        }
        return driveWithScheduler({
          command: "run",
          projectRoot: request.projectRoot,
          operationId: openOperation,
          driverKind: "cli",
          ...(request.maxConcurrency === undefined
            ? {}
            : { maxConcurrency: request.maxConcurrency }),
          drive: (deps) => driveOpenOperation(deps, "execute"),
        });
      }),

    verify: async (request: ProjectRequest): Promise<CommandResult> =>
      guard("verify", async () => {
        const outcome = await driveOpenOperation(orchestratorDeps(request.projectRoot), "verify");
        return outcomeToResult("verify", outcome);
      }),

    evaluate: async (request: ProjectRequest): Promise<CommandResult> =>
      guard("evaluate", async () => {
        const outcome = await driveOpenOperation(orchestratorDeps(request.projectRoot), "evaluate");
        return outcomeToResult("eval", outcome);
      }),

    snapshot: async (request: ProjectRequest): Promise<CommandResult> =>
      guard("snapshot", async () => {
        try {
          const outcome = await driveOpenOperation(
            orchestratorDeps(request.projectRoot),
            "snapshot",
          );
          return outcomeToResult("snapshot", outcome);
        } catch (error) {
          if (error instanceof OrchestrationError && error.kind === "no_open_operation") {
            const snapshot = readLatestSnapshot(request.projectRoot);
            if (snapshot !== undefined) {
              const commits = projectSnapshotCommitRefs(request.projectRoot, snapshot);
              return {
                command: "snapshot",
                status: "ok",
                message: `latest snapshot ${snapshot.snapshot_id} (${snapshot.status})`,
                data: {
                  snapshot_id: snapshot.snapshot_id,
                  status: snapshot.status,
                  iteration_id: snapshot.iteration_id,
                  workflow_operation_id: snapshot.workflow_operation_id,
                  source_commit: commits.source_commit,
                  ledger_commit: commits.ledger_commit,
                  repository_head: commits.repository_head,
                  evidence: [...snapshot.evidence],
                  closed_findings: [...snapshot.closed_findings],
                },
              };
            }
          }
          throw error;
        }
      }),

    audit: async (request: ProjectRequest): Promise<CommandResult> =>
      guard("audit", async () => {
        const { database } = materializeLedger({
          projectRoot: request.projectRoot,
          databasePath: ":memory:",
        });
        try {
          const nodes: NodeRecord[] = [];
          let cursor: string | undefined;
          do {
            const page = pageNodes(database, {
              limit: 500,
              ...(cursor === undefined ? {} : { cursor }),
            });
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
          const report = auditGraph(
            { nodes, edges },
            { provenTaskIds: provenQualityTaskIds(request.projectRoot) },
          );
          return {
            command: "audit",
            status: report.findings.some((finding) => finding.blocking) ? "failed" : "ok",
            message: `audit checked ${String(report.checked_nodes)} nodes and ${String(report.checked_edges)} edges: ${String(report.findings.length)} finding(s)`,
            data: {
              checked_nodes: report.checked_nodes,
              checked_edges: report.checked_edges,
              findings: report.findings.map((finding) => ({
                ...finding,
                subjects: [...finding.subjects],
              })),
            },
          };
        } finally {
          database.close();
        }
      }),
  };
}
