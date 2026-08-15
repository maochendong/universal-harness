import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";
import { renderTasksProjection } from "@universal-harness-internal/adapter-projection-markdown";
import { defineEvaluationCase, evaluateRun } from "@universal-harness-internal/eval";
import {
  OrchestrationError,
  abortIteration,
  createDirectExecutor,
  createGenericInterpreter,
  createRuntimeService,
  driveOpenOperation,
  parseApprovalDecision,
  previewImpactSet,
  provenQualityTaskIds,
  readLatestExecutionPlan,
  readLatestSnapshot,
  resolveSnapshotSourceCommit,
  readStagedAdoptionPreview,
  resolveApproval,
  resolveFinding,
  resumeIteration,
  runIteration,
  auditGraph,
  type ApprovalPrompter,
  type EvaluationPort,
  type IntentInterpreter,
  type OrchestrationExecutor,
  type OrchestrationOutcome,
  type OrchestratorDependencies,
  type PhaseProgressEvent,
  type TaskEnvelopeScopePort,
} from "@universal-harness-internal/runtime";
import { materializeLedger, pageEdges, pageNodes } from "@universal-harness-internal/graph";
import type { EdgeRecord, NodeRecord } from "@universal-harness-internal/core";

import type { GateDefinition, ToolRegistry } from "@universal-harness-internal/runtime";

import type { CliIo, CommandResult } from "./io.js";
import type {
  AbortRequest,
  AdoptProjectRequest,
  ApproveRequest,
  FindingRequest,
  ImpactRequest,
  IterateRequest,
  NewProjectRequest,
  ProjectRequest,
  ResumeRequest,
  RunRequest,
  RuntimeService,
} from "./router.js";
import { createConfiguredAgentExecutor } from "./project-agent.js";
import { createConfiguredGateSuite } from "./project-gates.js";
import { ProjectRuntimeConfigError, readProjectRuntimeConfig } from "./project-runtime-config.js";

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
      input: { run: input.run, visibility: input.visibility, budget: input.budget },
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
        message: `iteration ${outcome.iterationId} completed; snapshot ${outcome.snapshotId} at ${outcome.finalCommit.slice(0, 12)}`,
        data: {
          ...extra,
          workflow_operation_id: outcome.workflowOperationId,
          iteration_id: outcome.iterationId,
          snapshot_id: outcome.snapshotId,
          source_commit: outcome.sourceCommit,
          final_commit: outcome.finalCommit,
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
        status: "failed",
        message: `mandatory input missing: ${outcome.questions.map((question) => question.question).join("; ")}`,
        data: { ...extra, questions: outcome.questions.map((question) => ({ ...question })) },
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
        ? createConfiguredGateSuite(projectRoot, runtimeConfig)
        : undefined;
    return {
      projectRoot,
      readBaseline: () => gitHead(projectRoot),
      vcs,
      interpret: options.interpret ?? createGenericInterpreter(),
      execute: options.execute ?? configuredAgent?.execute ?? createDirectExecutor(),
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
      throw error;
    }
  };

  const iterateImpl = async (request: IterateRequest): Promise<CommandResult> =>
    guard("iterate", async () => {
      const outcome = await runIteration(orchestratorDeps(request.projectRoot), {
        intent: request.text,
        intentShape: "pack-converted",
      });
      return outcomeToResult("iterate", outcome);
    });

  const resumeImpl = async (request: ResumeRequest): Promise<CommandResult> =>
    guard("resume", async () => {
      const outcome = await resumeIteration(
        orchestratorDeps(request.projectRoot),
        request.workflowOperationId,
        { intent: "", intentShape: "pack-converted" },
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
    });
  };

  return {
    newProject: async (request: NewProjectRequest): Promise<CommandResult> =>
      guard("new", async () => {
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
        });
      }),

    adoptProject: async (request: AdoptProjectRequest): Promise<CommandResult> =>
      guard("adopt", async () => {
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
          return adoptCommitAndIterate(request, request.approveStaging, staged.previewDigest);
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
        const resumeCommand = `harness adopt ${request.path} --intent ${JSON.stringify(request.intent)} --approve ${preview.value.stagingOperationId}`;
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
        return {
          command: "impact",
          status: "ok",
          message: `impact preview from ${preview.seedNodeId}: ${String(preview.entries.length)} impacted nodes`,
          data: {
            impact_set_id: preview.impactSetId,
            content_digest: preview.contentDigest,
            seed_node_id: preview.seedNodeId,
            entries: preview.entries.map((entry) => ({ ...entry })),
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
              return {
                command: "snapshot",
                status: "ok",
                message: `latest snapshot ${snapshot.snapshot_id} (${snapshot.status})`,
                data: {
                  snapshot_id: snapshot.snapshot_id,
                  status: snapshot.status,
                  iteration_id: snapshot.iteration_id,
                  workflow_operation_id: snapshot.workflow_operation_id,
                  source_commit: resolveSnapshotSourceCommit(request.projectRoot, snapshot),
                  final_commit: snapshot.final_commit,
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
