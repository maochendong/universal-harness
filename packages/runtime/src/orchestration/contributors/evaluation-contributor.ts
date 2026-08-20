import {
  PROTOCOL_VERSION,
  canonicalizeJson,
  contentDigest,
  readManagedManifest,
  sha256Hex,
  validateSchema,
  type EdgeRecord,
  type NodeRecord,
} from "@universal-harness-internal/core";
import { type AgentRunResult } from "@universal-harness-internal/plugin-sdk";
import { buildFindingGovernanceMetadata } from "../../finding/governance.js";
import { phaseLifecycleEvents } from "../lifecycle-events.js";
import { PHASE_CHECKPOINT_BOUNDARY } from "../phases.js";
import { type ExecutionBinding } from "../execution-binding.js";
import {
  blockWithSnapshot,
  commitArtifacts,
  currentAttemptId,
  evaluateArtifactPath,
  executionBindingFor,
  loadCompletedRun,
  loadEvaluateArtifacts,
  loadPlan,
  materializeProjectGraph,
  nowOf,
  orderedPlanTasks,
  refreshWorkingState,
  snapshotBaseInput,
} from "../kernel-coordinator.js";
import type {
  EvaluateContribution,
  EvaluatePhaseArtifact,
  PhaseStep,
  PipelineContext,
} from "../kernel-coordinator.js";
import { OrchestrationError } from "../pipeline-types.js";
import type { EvaluationPort, EvaluationPortResult } from "../pipeline-types.js";

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
      ...(input.adapterProfileDigest === undefined
        ? {}
        : { adapter_profile_digest: input.adapterProfileDigest }),
      ...(input.run.budget_observations === undefined
        ? {}
        : { budget_observations: input.run.budget_observations }),
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
/**
 * Promote a committed evaluation report into the graph-native verdict chain:
 * Run EXECUTES Task, Run PRODUCES Evidence, Evidence SUPPORTS EvaluationCase,
 * and the accepted EvaluationCase EVALUATES both the Task and concrete Run.
 * The report remains the immutable detail record; nodes bind its digest.
 */
async function commitEvaluationGraph(
  ctx: PipelineContext,
  taskId: string,
  runId: string,
  result: EvaluationPortResult,
): Promise<void> {
  const record = result.record;
  const extensionValue =
    typeof record["extensions"] === "object" && record["extensions"] !== null
      ? (record["extensions"] as Record<string, unknown>)["harness.evaluation"]
      : undefined;
  const extension =
    typeof extensionValue === "object" && extensionValue !== null
      ? (extensionValue as Record<string, unknown>)
      : {};
  const caseId = extension["case_id"];
  const evidenceId = record["evidence_id"];
  const evidenceDigest = record["digest"];
  const provisional = record["provisional"];
  const createdAt = record["created_at"];
  if (
    typeof caseId !== "string" ||
    typeof evidenceId !== "string" ||
    typeof evidenceDigest !== "string" ||
    typeof provisional !== "boolean" ||
    typeof createdAt !== "string"
  ) {
    throw new OrchestrationError(
      "configuration",
      `evaluation ${result.evidenceId} lacks graph materialization fields`,
    );
  }

  const graph = materializeProjectGraph(ctx.deps.projectRoot);
  const currentNodes = new Map<string, NodeRecord>();
  let activeEdgeIds: Set<string>;
  try {
    for (const node of graph.nodes) {
      const current = currentNodes.get(node.id);
      if (current === undefined || node.revision > current.revision)
        currentNodes.set(node.id, node);
    }
    activeEdgeIds = new Set(
      graph.edges
        .filter((edge) => edge.status === "proposed" || edge.status === "accepted")
        .map((edge) => edge.id),
    );
  } finally {
    graph.close();
  }

  const artifacts: { readonly path: string; readonly content: string }[] = [];
  const edges: EdgeRecord[] = [];
  const appendNode = (
    id: string,
    type: "Evidence" | "EvaluationCase",
    status: "proposed" | "accepted",
    nodeExtension: Record<string, unknown>,
    directory: string,
  ): void => {
    const current = currentNodes.get(id);
    const currentEvaluation = current?.extensions?.["harness.evaluation"];
    const sameBinding =
      current?.status === status &&
      typeof currentEvaluation === "object" &&
      currentEvaluation !== null &&
      (currentEvaluation as Record<string, unknown>)["evidence_digest"] === evidenceDigest;
    if (sameBinding) return;
    const revision = (current?.revision ?? 0) + 1;
    const content: Record<string, unknown> = {
      protocol_version: PROTOCOL_VERSION,
      record_kind: "node",
      id,
      type,
      revision,
      status,
      source: "evaluation",
      provenance: {
        iteration_id: ctx.iterationId,
        run_id: runId,
        actor: "workflow-engine",
        timestamp: createdAt,
      },
      confidence: 1,
      extensions: { "harness.evaluation": nodeExtension },
    };
    const node = { ...content, digest: contentDigest(content) };
    const validation = validateSchema("node", node);
    if (!validation.valid) {
      throw new OrchestrationError(
        "configuration",
        `invalid ${type} evaluation node: ${validation.errors.map((issue) => issue.message).join("; ")}`,
      );
    }
    artifacts.push({
      path: `artifacts/${directory}/${id}/${String(revision)}.json`,
      content: `${canonicalizeJson(node)}\n`,
    });
    currentNodes.set(id, node as unknown as NodeRecord);
  };

  // Finality and verdict are separate dimensions: a conclusive failed
  // evaluation is accepted evidence with `passed: false`; only an explicitly
  // provisional evaluator result remains proposed.
  const graphStatus = provisional ? "proposed" : "accepted";
  const verdictDetails = {
    ...(Array.isArray(extension["dimensions"]) ? { dimensions: extension["dimensions"] } : {}),
    ...(Array.isArray(extension["mandatory_failures"])
      ? { mandatory_failures: extension["mandatory_failures"] }
      : {}),
    ...(typeof extension["coverage"] === "object" && extension["coverage"] !== null
      ? { coverage: extension["coverage"] }
      : {}),
    ...(typeof extension["adapter_profile_digest"] === "string"
      ? { adapter_profile_digest: extension["adapter_profile_digest"] }
      : {}),
    ...(Array.isArray(extension["budget_observations"])
      ? { budget_observations: extension["budget_observations"] }
      : {}),
  };
  appendNode(
    evidenceId,
    "Evidence",
    graphStatus,
    {
      evidence_digest: evidenceDigest,
      ...(record["evidence_type"] === undefined ? {} : { evidence_type: record["evidence_type"] }),
      subject_id: taskId,
      provisional,
      passed: result.passed,
      ...verdictDetails,
    },
    "evaluation-evidence-nodes",
  );
  appendNode(
    caseId,
    "EvaluationCase",
    graphStatus,
    {
      evidence_id: evidenceId,
      evidence_digest: evidenceDigest,
      ...(extension["case_digest"] === undefined ? {} : { case_digest: extension["case_digest"] }),
      subject_id: taskId,
      ...(extension["visibility"] === undefined ? {} : { visibility: extension["visibility"] }),
      passed: result.passed,
      ...verdictDetails,
    },
    "evaluation-case-nodes",
  );

  const appendEdge = (type: EdgeRecord["type"], sourceId: string, targetId: string): void => {
    const id = `edge_${contentDigest({ type, source: sourceId, target: targetId }).slice(0, 16)}`;
    if (activeEdgeIds.has(id)) return;
    const content: Record<string, unknown> = {
      protocol_version: PROTOCOL_VERSION,
      record_kind: "edge",
      id,
      type,
      source_id: sourceId,
      target_id: targetId,
      status: "accepted",
      source: "evaluation",
      provenance: {
        iteration_id: ctx.iterationId,
        run_id: runId,
        actor: "workflow-engine",
        timestamp: createdAt,
      },
      confidence: 1,
    };
    const edge = { ...content, digest: contentDigest(content) };
    const validation = validateSchema("edge", edge);
    if (!validation.valid) {
      throw new OrchestrationError(
        "configuration",
        `invalid evaluation ${type} edge: ${validation.errors.map((issue) => issue.message).join("; ")}`,
      );
    }
    edges.push(edge as unknown as EdgeRecord);
    activeEdgeIds.add(id);
  };

  appendEdge("EXECUTES", runId, taskId);
  appendEdge("PRODUCES", runId, evidenceId);
  appendEdge("SUPPORTS", evidenceId, caseId);
  appendEdge("EVALUATES", caseId, taskId);
  appendEdge("EVALUATES", caseId, runId);
  if (artifacts.length === 0 && edges.length === 0) return;
  await commitArtifacts(ctx.deps, ctx.workflowOperationId, currentAttemptId(ctx), artifacts, edges);
}
export async function evaluateTaskRun(
  ctx: PipelineContext,
  taskId: string,
  run: { readonly runId: string; readonly result: AgentRunResult },
): Promise<EvaluationPortResult> {
  const { deps } = ctx;
  const runDigest = sha256Hex(canonicalizeJson(run.result));
  const stored = loadEvaluateArtifacts(deps, ctx.iterationId).find(
    (artifact) => artifact.run_digest === runDigest,
  );
  let result: EvaluationPortResult;
  if (stored !== undefined) {
    result = stored.result;
  } else {
    const port = deps.evaluate ?? createDefaultEvaluationPort();
    result = await port({
      taskId,
      iterationId: ctx.iterationId,
      run: run.result,
      visibility: deps.trajectoryVisibility ?? "external-only",
      budget: {
        max_steps: ctx.envelope?.loop_policy.max_steps ?? 30,
        max_tokens: ctx.envelope?.loop_policy.max_tokens ?? 120000,
        max_duration_ms: ctx.envelope?.loop_policy.max_duration_ms ?? 2700000,
      },
      ...(executionBindingFor(deps).adapter_profile === undefined
        ? {}
        : {
            adapterProfileDigest: contentDigest(
              executionBindingFor(deps).adapter_profile as NonNullable<
                ExecutionBinding["adapter_profile"]
              >,
            ),
          }),
      now: nowOf(deps),
    });
    await commitArtifacts(deps, ctx.workflowOperationId, currentAttemptId(ctx), [
      {
        path: `artifacts/evaluations/${result.evidenceId}/${String(result.record["digest"])}.json`,
        content: `${canonicalizeJson(result.record)}\n`,
      },
      ...result.findings.map((finding) => {
        const evaluationExtensionValue =
          typeof result.record["extensions"] === "object" && result.record["extensions"] !== null
            ? (result.record["extensions"] as Record<string, unknown>)["harness.evaluation"]
            : undefined;
        const evaluationExtension =
          typeof evaluationExtensionValue === "object" && evaluationExtensionValue !== null
            ? (evaluationExtensionValue as Record<string, unknown>)
            : {};
        const caseId =
          typeof evaluationExtension["case_id"] === "string"
            ? evaluationExtension["case_id"]
            : `case_${taskId.slice("task_".length)}`;
        const evidenceDigest = result.record["digest"];
        const governance = buildFindingGovernanceMetadata({
          rule: "evaluation/failure",
          scopePrefix: `project/${readManagedManifest(deps.projectRoot).repository_id}/evaluation/${caseId}`,
          severity: "blocker",
          actionability: "human_review",
          subjectIds: [taskId],
          subjectDigests:
            typeof evidenceDigest === "string" && /^[a-f0-9]{64}$/u.test(evidenceDigest)
              ? [evidenceDigest]
              : [],
        });
        const content = {
          protocol_version: PROTOCOL_VERSION,
          record_kind: "feedback",
          id: finding.id,
          type: "Finding",
          iteration_id: ctx.iterationId,
          status: "proposed",
          summary: finding.summary,
          created_at: nowOf(deps),
          extensions: {
            "harness.finding": {
              origin: "evaluation",
              blocking: true,
              violates: [taskId],
              blocks: [ctx.iterationId],
              evidence: [result.evidenceId],
              ...governance,
            },
          },
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
  await commitEvaluationGraph(ctx, taskId, run.runId, result);
  return result;
}
export async function phaseEvaluate(ctx: PipelineContext): Promise<PhaseStep> {
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
    const result = await evaluateTaskRun(ctx, task.id, run);
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

/**
 * The independent_evaluation module contribution (plan Task 8-A): the
 * coordinator dispatches the `evaluate` phase and per-run evaluation through
 * this registration only.
 */
export function createEvaluationContribution(): EvaluateContribution {
  return {
    capability_id: "independent_evaluation",
    runPhase: phaseEvaluate,
    evaluateTaskRun,
  };
}
