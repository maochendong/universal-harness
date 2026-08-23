import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";
import { DashboardWriteError, startDashboardServer } from "@universal-harness-internal/dashboard";
import { renderTasksProjection } from "@universal-harness-internal/adapter-projection-markdown";
import { defineEvaluationCase, evaluateRun } from "@universal-harness-internal/eval";
import {
  FindingGroupError,
  OrchestrationError,
  ApprovalError,
  WorkflowError,
  FileLiveSpool,
  ObservationPublisher,
  abortIteration,
  createGenericInterpreter,
  createRuntimeService,
  driveOpenOperation,
  parseApprovalDecision,
  previewImpactSet,
  projectSnapshotCommitRefs,
  proposeSemanticImpactEdges,
  provenQualityTaskIds,
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
  type ApprovalPrompter,
  type CaptureCoordinatorSeam,
  type EvaluationPort,
  type IntentInterpreter,
  type OrchestrationExecutor,
  type OrchestrationOutcome,
  type OrchestratorDependencies,
  type PhaseProgressEvent,
  type TaskEnvelopeScopePort,
} from "@universal-harness-internal/runtime";
import type { SemanticSeedProvider } from "@universal-harness-internal/plugin-sdk";
import { materializeLedger, pageEdges, pageNodes } from "@universal-harness-internal/graph";
import {
  contentDigest,
  appendProfileDecisionRecord,
  appendProjectProfileRecord,
  createProfileDecisionRecord,
  createProjectProfileRecord,
  readLatestProjectProfile,
  readProfileDecisionRecords,
  readManagedManifest,
  resolveIterationProfile,
  resolveProfileSelection,
  ulid,
  ProfileSelectionError,
  ProjectLayoutError,
  DEFAULT_PROFILE_POLICY_DIGEST,
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
  FindingGroupRequest,
  FindingRequest,
  ImpactRequest,
  IterateRequest,
  NewProjectRequest,
  ProjectRequest,
  ResumeRequest,
  RunRequest,
  ServeRequest,
  RuntimeService,
} from "./router.js";
import { createConfiguredAgentExecutor } from "./project-agent.js";
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

function projectIdForProject(projectRoot: string): string {
  return `project_${readManagedManifest(projectRoot).name}`;
}

/** HEAD-bound baseline digest; an unborn or unreadable HEAD degrades to a stable constant. */
function baselineDigestForProject(projectRoot: string): string {
  try {
    return contentDigest({ repository_head: gitHead(projectRoot) });
  } catch {
    return contentDigest({ repository_head: "unborn" });
  }
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
    const captureSeam = managedCaptureSeamForProject(projectRoot, runtimeConfig, {
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

  const clock = options.now ?? (() => new Date().toISOString());

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

  const projectIdFor = (projectRoot: string): string => projectIdForProject(projectRoot);

  /** HEAD-bound baseline digest; an unborn or unreadable HEAD degrades to a stable constant. */
  const baselineDigestFor = (projectRoot: string): string => baselineDigestForProject(projectRoot);

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

  /** Persist the initial profile baseline and its decision (append-only). */
  const persistInitialProfile = (
    projectRoot: string,
    profileId: ProfileId,
  ): ProjectProfileRecord => {
    const projectId = projectIdFor(projectRoot);
    const record = createProjectProfileRecord({
      project_id: projectId,
      revision: 1,
      profile_id: profileId,
      policy_digest: DEFAULT_PROFILE_POLICY_DIGEST,
      actor,
      effective_from: clock(),
    });
    appendProjectProfileRecord(projectRoot, record);
    appendProfileDecisionRecord(
      projectRoot,
      createProfileDecisionRecord({
        decision_kind: "project_profile_change",
        project_id: projectId,
        actor,
        idempotency_key: `profile-select:${projectId}:revision:1`,
        current_profile_id: profileId,
        decided_profile_id: profileId,
        policy_digest: DEFAULT_PROFILE_POLICY_DIGEST,
        decided_at: clock(),
      }),
    );
    return record;
  };

  /**
   * An explicit project profile change appends a new revision bound to the
   * previous one; historical revisions and decisions stay untouched, so the
   * change only ever affects future operations (design 10.4).
   */
  const changeProjectProfile = (
    projectRoot: string,
    latest: ProjectProfileRecord,
    profileId: ProfileId,
  ): ProjectProfileRecord => {
    const record = createProjectProfileRecord({
      project_id: latest.project_id,
      revision: latest.revision + 1,
      profile_id: profileId,
      policy_digest: latest.policy_digest,
      actor,
      effective_from: clock(),
      supersedes_digest: latest.record_digest,
    });
    appendProjectProfileRecord(projectRoot, record);
    appendProfileDecisionRecord(
      projectRoot,
      createProfileDecisionRecord({
        decision_kind: "project_profile_change",
        project_id: latest.project_id,
        actor,
        idempotency_key: `profile-change:${latest.project_id}:revision:${String(latest.revision + 1)}`,
        current_profile_id: latest.profile_id,
        decided_profile_id: profileId,
        policy_digest: latest.policy_digest,
        decided_at: clock(),
      }),
    );
    return record;
  };

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
      const outcome = await runIteration(orchestratorDeps(request.projectRoot), {
        intent: request.text,
        intentShape: "pack-converted",
      });
      return outcomeToResult("iterate", outcome, profileResultExtra(active));
    });

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
      const outcome = await resumeIteration(
        orchestratorDeps(request.projectRoot),
        request.workflowOperationId,
        {
          intent: "",
          intentShape: "pack-converted",
          ...(request.answers === undefined ? {} : { answers: request.answers }),
        },
      );
      return outcomeToResult("resume", outcome);
    });

  const abortImpl = async (request: AbortRequest): Promise<CommandResult> =>
    guard("abort", async () => {
      const aborted = await abortIteration(orchestratorDeps(request.projectRoot), {
        workflowOperationId: request.workflowOperationId,
        actor: request.actor ?? actor,
      });
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
              const outcome = await resumeIteration(deps, input.workflowOperationId, {
                intent: "",
                intentShape: "pack-converted",
              });
              return {
                ...outcomeToResult("resume", outcome).data,
                status: outcome.status,
                expected_digest: input.expectedDigest,
                actor: input.actor,
              };
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
        },
      });
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

    approve: async (request: ApproveRequest): Promise<CommandResult> =>
      guard("approve", async () => {
        const resolved = await resolveApproval(orchestratorDeps(request.projectRoot), {
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
        const plan = readLatestExecutionPlan(request.projectRoot);
        if (plan === undefined) {
          return {
            command: "plan",
            status: "failed",
            message: "no committed execution plan; run an iteration first",
            data: {},
          };
        }
        return {
          command: "plan",
          status: "ok",
          message: `plan ${plan.planId} (${plan.mode}) with ${String(plan.tasks.length)} task(s)`,
          data: {
            plan_id: plan.planId,
            mode: plan.mode,
            impact_set_id: plan.impactSetId,
            iteration_id: plan.iterationId,
            tasks: plan.tasks.map((task) => ({
              ...task,
              required_gates: [...task.required_gates],
            })),
          },
        };
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
        const outcome = await driveOpenOperation(orchestratorDeps(request.projectRoot), "execute");
        return outcomeToResult("run", outcome);
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
