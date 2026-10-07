import {
  NodeSchema,
  PROTOCOL_1_1_SCHEMA_REGISTRY,
  canonicalizeJson,
  contentDigest,
  harnessRootFor,
  readCommittedOperations,
  resolveHarnessPath,
  sanitizeContextText,
  sha256Hex,
  validateSchema,
  type ImpactAdvisoryOutput,
  type ModelPortFailure,
  type NodeRecord,
} from "@universal-harness-internal/core";
import { readFileSync } from "node:fs";
import {
  RELATION_RULE_REGISTRY,
  generateImpactSet,
  mergeImpactAdvisory,
  readImpactSetContent,
  freezeImpactSet,
  ImpactError,
  validateImpactAdvisoryMerge,
  type ChangeSeed,
  type ImpactAdvisoryPort,
  type ImpactAdvisoryResult,
} from "@universal-harness-internal/graph";
import { resumeCommandFor } from "../../approval/interaction.js";
import { PromptPreparationFailureError } from "../../model/capture-adapters.js";
import { ManagedRunnerError } from "../../model/managed-runner.js";
import { SourceBoundaryError, wrapUntrustedBundle } from "../../model/source-boundary.js";
import type { RecoverableBlockReason } from "../../workflow/state-machine.js";
import { PHASE_CHECKPOINT_BOUNDARY } from "../phases.js";
import {
  commitArtifacts,
  currentAttemptId,
  ensureApproval,
  loadFrozenImpactSet,
  materializeProjectGraph,
  nowOf,
  refreshWorkingState,
  rejectOperation,
  readJsonArtifact,
} from "../kernel-coordinator.js";
import type { ImpactContribution, PhaseStep, PipelineContext } from "../kernel-coordinator.js";

type LocalDiagnostic = NonNullable<
  Extract<ImpactAdvisoryResult, { status: "proposed" }>["local_diagnostic"]
>;

class ImpactAdvisoryBlockedError extends Error {
  constructor(
    readonly reason: RecoverableBlockReason,
    summary: string,
    readonly questions: readonly string[] = [],
  ) {
    super(summary);
    this.name = "ImpactAdvisoryBlockedError";
  }
}

/** Diagnostic text is display data, never an instruction or a credential dump. */
function safeDetail(text: string): string {
  try {
    wrapUntrustedBundle(
      {
        bundle_id: "impact-diagnostic",
        items: [{ source_id: "impact-diagnostic", source_kind: "diagnostic", text }],
      },
      "source-delimiter.v1",
    );
    return sanitizeContextText(text).slice(0, 512);
  } catch (error) {
    if (error instanceof SourceBoundaryError)
      return "诊断包含敏感或不安全内容，未展示；请通过受控输入流程核查。";
    throw error;
  }
}

function ownedBlockers(ctx: PipelineContext): readonly string[] {
  return ctx.workingState.blockers.filter((value) =>
    value.startsWith(`[impact-advisory:${ctx.workflowOperationId}] `),
  );
}

async function blockImpact(
  ctx: PipelineContext,
  error: ImpactAdvisoryBlockedError,
): Promise<PhaseStep> {
  const detail = `[impact-advisory:${ctx.workflowOperationId}] ${[safeDetail(error.message), ...error.questions.slice(0, 20).map(safeDetail)].join("；")}`;
  await ctx.engine.block(ctx.workflowOperationId, {
    reason: error.reason,
    detail,
    proposal: {
      phase: "impact",
      set_next_action: resumeCommandFor(ctx.workflowOperationId),
      clear_blockers: ownedBlockers(ctx),
    },
  });
  refreshWorkingState(ctx);
  return {
    continue: false,
    outcome: {
      status: "blocked",
      workflowOperationId: ctx.workflowOperationId,
      iterationId: ctx.iterationId,
      reason: error.reason,
      detail,
      resumeCommand: resumeCommandFor(ctx.workflowOperationId),
    },
  };
}

function failureReason(failure: ModelPortFailure): RecoverableBlockReason {
  if (failure.code === "uncertain") return "uncertain_external_action";
  if (failure.code === "budget_exhausted") return "budget_ceiling";
  if (failure.retryable && (failure.code === "timeout" || failure.code === "provider_unavailable"))
    return "transient_environment_failure";
  return "missing_input";
}

export async function phaseImpact(
  ctx: PipelineContext,
  advisory?: ImpactAdvisoryPort,
): Promise<PhaseStep> {
  const { deps } = ctx;
  const frozen = loadFrozenImpactSet(ctx);
  if (frozen !== undefined) {
    ctx.impactSet = frozen;
    await ctx.engine.commitCheckpoint(ctx.workflowOperationId, {
      boundary: PHASE_CHECKPOINT_BOUNDARY.impact,
      proposal: { phase: "design" },
    });
    refreshWorkingState(ctx);
    return { continue: true };
  }
  const graph = materializeProjectGraph(deps.projectRoot);
  let impactSet: NodeRecord;
  let diagnostic: LocalDiagnostic | undefined;
  try {
    const nodes = [...graph.nodes];
    const seed: ChangeSeed = {
      id: `seed_${sha256Hex(`${ctx.proposal.intent.id}:${ctx.iterationKind}`).slice(0, 16)}`,
      nodeId: ctx.proposal.intent.id,
      kind: "content-change",
      iterationKind: ctx.iterationKind,
      reason: `requirement baseline intent ${ctx.proposal.intent.id} drives this iteration`,
    };
    impactSet = generateImpactSet([seed], nodes, [...graph.edges], {
      iterationId: ctx.iterationId,
      actor: "workflow-engine",
      timestamp: nowOf(deps),
    });
    if (advisory !== undefined) {
      impactSet = await adviseImpactSet(
        {
          workflow_operation_id: ctx.workflowOperationId,
          iteration_id: ctx.iterationId,
          attempt_id: currentAttemptId(ctx),
        },
        impactSet,
        nodes,
        advisory,
        (value) => {
          diagnostic = value;
        },
      );
    }
  } catch (error) {
    if (error instanceof ImpactAdvisoryBlockedError) return blockImpact(ctx, error);
    throw error;
  } finally {
    graph.close();
  }
  // Persist the proposed revision before any approval is awaited; the frozen
  // revision lands only after the approval decision (revisions must stay
  // contiguous for graph integrity, and ledger artifacts are immutable files,
  // so each revision gets its own path).
  const impactSetPath = `artifacts/impact-sets/${impactSet.id}/1.json`;
  const artifacts: { path: string; content: string }[] = [];
  const root = harnessRootFor(deps.projectRoot);
  const committedDigests = new Set(
    readCommittedOperations(root).flatMap((operation) => operation.manifest.artifact_digests),
  );
  const existingProposed = readJsonArtifact<NodeRecord>(deps, impactSetPath);
  if (existingProposed === undefined) {
    artifacts.push({ path: impactSetPath, content: `${canonicalizeJson(impactSet)}\n` });
  } else {
    const { digest, ...record } = existingProposed;
    if (
      !validateSchema("node", existingProposed).valid ||
      existingProposed.id !== impactSet.id ||
      existingProposed.status !== "proposed" ||
      digest !== contentDigest(record) ||
      canonicalizeJson(readImpactSetContent(existingProposed)) !==
        canonicalizeJson(readImpactSetContent(impactSet))
    ) {
      return blockImpact(
        ctx,
        new ImpactAdvisoryBlockedError(
          "stale_evidence",
          "既有 Impact 提议与当前输入冲突，保留原文件；请核查后恢复。",
        ),
      );
    }
    // Reuse original provenance bytes, including when the clock advanced after a crash.
    impactSet = existingProposed;
    const content = readFileSync(resolveHarnessPath(root, impactSetPath), "utf8");
    if (!committedDigests.has(sha256Hex(content))) artifacts.push({ path: impactSetPath, content });
  }
  if (diagnostic !== undefined) {
    const attemptId = currentAttemptId(ctx);
    const identifier = NodeSchema.properties.id;
    if (
      attemptId.length < identifier.minLength! ||
      attemptId.length > identifier.maxLength! ||
      !new RegExp(identifier.pattern!, "u").test(attemptId)
    ) {
      return blockImpact(
        ctx,
        new ImpactAdvisoryBlockedError("missing_input", "Impact 诊断的 attempt 标识无效。"),
      );
    }
    const path = `diagnostics/impact-advisory/${attemptId}.json`;
    const content = {
      format_version: 1,
      workflow_operation_id: ctx.workflowOperationId,
      attempt_id: attemptId,
      provider: safeDetail(advisory!.name),
      impact_set_digest: readImpactSetContent(impactSet).content_digest,
      ...diagnostic,
    };
    const existing = readJsonArtifact<unknown>(deps, path);
    if (existing !== undefined && canonicalizeJson(existing) !== canonicalizeJson(content)) {
      return blockImpact(
        ctx,
        new ImpactAdvisoryBlockedError(
          "stale_evidence",
          "既有 Impact 本地诊断与当前结果冲突，保留原记录；请核查并显式恢复。",
        ),
      );
    }
    const bytes =
      existing === undefined
        ? `${canonicalizeJson(content)}\n`
        : readFileSync(resolveHarnessPath(root, path), "utf8");
    if (!committedDigests.has(sha256Hex(bytes))) artifacts.push({ path, content: bytes });
  }
  if (artifacts.length > 0) {
    await commitArtifacts(deps, ctx.workflowOperationId, currentAttemptId(ctx), artifacts);
  }
  const stale = ownedBlockers(ctx);
  if (stale.length > 0) {
    await ctx.engine.commitCheckpoint(ctx.workflowOperationId, {
      boundary: PHASE_CHECKPOINT_BOUNDARY.impact,
      proposal: { phase: "impact", clear_blockers: stale },
    });
    refreshWorkingState(ctx);
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
    proposal: { phase: "design" },
  });
  refreshWorkingState(ctx);
  return { continue: true };
}

/**
 * The impact_analysis module contribution (plan Task 8-A): the coordinator
 * dispatches the `impact` phase through this registration only. The advisory
 * port is optional (model advisory design 6, PG-3): with no port wired the
 * phase is exactly the deterministic propagate → approve path.
 */
export interface ImpactContributionOptions {
  readonly advisory?: ImpactAdvisoryPort;
}

export function createImpactContribution(options?: ImpactContributionOptions): ImpactContribution {
  const advisory = options?.advisory;
  return {
    capability_id: "impact_analysis",
    runPhase: (ctx) => phaseImpact(ctx, advisory),
  };
}

/** The identity facts an advisory invocation binds to. */
export interface ImpactAdvisoryPhaseIds {
  readonly workflow_operation_id: string;
  readonly iteration_id: string;
  readonly attempt_id: string;
}

/**
 * Run the optional advisory between propagation and approval (PG-3:
 * `propagate → advise → validate → approve`). The port validates its own
 * output before returning `proposed`, so a clean result folds into the
 * proposed set and the approval binds to the merged content. Once enabled,
 * failures and unresolved questions block instead of silently falling back.
 * The unconfigured path remains entirely deterministic.
 */
export async function adviseImpactSet(
  ids: ImpactAdvisoryPhaseIds,
  impactSet: NodeRecord,
  nodes: readonly NodeRecord[],
  advisory: ImpactAdvisoryPort,
  onDiagnostic?: (diagnostic: LocalDiagnostic) => void,
): Promise<NodeRecord> {
  const content = readImpactSetContent(impactSet);
  const requirementDigests: Record<string, string> = {};
  for (const node of nodes) {
    if (node.type === "Requirement") {
      requirementDigests[node.id] = node.digest;
    }
  }
  const input = {
    workflow_operation_id: ids.workflow_operation_id,
    iteration_id: ids.iteration_id,
    impact_set_digest: content.content_digest,
    deterministic_entries: content.entries,
    nodes,
    requirement_digests: requirementDigests,
    rule_registry_version: RELATION_RULE_REGISTRY.version,
    rule_registry_digest: RELATION_RULE_REGISTRY.digest,
    conversation_id: `impact-advisory-conversation_${contentDigest({ workflow_operation_id: ids.workflow_operation_id, attempt_id: ids.attempt_id }).slice(0, 32)}`,
    run_id: `impact-advisory-run_${ids.attempt_id}`,
  };
  let result: ImpactAdvisoryResult;
  try {
    result = await advisory.advise(input);
  } catch (error) {
    if (error instanceof PromptPreparationFailureError)
      throw new ImpactAdvisoryBlockedError(
        error.failure.code === "prompt_size_exceeded" ? "budget_ceiling" : "missing_input",
        `影响辅助判断准备失败（${error.failure.code}）：${safeDetail(error.failure.summary)}`,
      );
    if (
      error instanceof ManagedRunnerError &&
      ["identity_conflict", "binding_drift"].includes(error.kind)
    )
      throw new ImpactAdvisoryBlockedError(
        "missing_input",
        "模型调用身份或绑定冲突；保留原记录，请核查后显式恢复。",
      );
    throw error;
  }
  if (result.status === "failed") {
    const guidance =
      result.failure.code === "policy_denied"
        ? safeDetail(result.failure.summary)
        : "请核查调用记录与配置，修正后显式恢复；不会自动切换模型。";
    throw new ImpactAdvisoryBlockedError(
      failureReason(result.failure),
      `影响辅助判断失败（${result.failure.code}）。${guidance}`,
    );
  }
  if (result.status === "clarification_required")
    throw new ImpactAdvisoryBlockedError(
      "missing_input",
      "影响分析需要补充事实；请通过需求/图谱流程补证后恢复。",
      result.questions.map((question) => question.question),
    );
  if (result.missing_facts.length > 0 || result.questions.length > 0) {
    throw new ImpactAdvisoryBlockedError(
      "missing_input",
      "影响分析仍有未解决的问题，不能部分合并或进入审批。",
      [
        ...result.questions.map((question) => question.question),
        ...result.missing_facts.map((fact) => fact.fact),
      ],
    );
  }
  const output: ImpactAdvisoryOutput = {
    purpose: "impact_advisory",
    schema_version: "impact-advisory.v1",
    impact_set_digest: content.content_digest,
    additions: [...result.additions],
    edge_candidates: [...result.edge_candidates],
    risk_signals: [...result.risk_signals],
    missing_facts: [],
    questions: [],
  };
  if (
    !PROTOCOL_1_1_SCHEMA_REGISTRY.validate("impact-advisory-output", output).valid ||
    validateImpactAdvisoryMerge({ ...input, output }).length > 0
  ) {
    throw new ImpactAdvisoryBlockedError(
      "missing_input",
      "影响辅助建议未通过 Schema 或确定性合并规则校验。",
    );
  }
  if (result.local_diagnostic !== undefined) {
    const value = result.local_diagnostic;
    const counts = value.excluded_by_reason;
    if (
      counts === undefined ||
      [
        value.candidate_count,
        value.excluded_count,
        counts.already_deterministic,
        counts.not_accepted,
        counts.unsupported_type,
      ].some((count) => !Number.isSafeInteger(count) || count < 0) ||
      counts.already_deterministic + counts.not_accepted + counts.unsupported_type !==
        value.excluded_count ||
      value.candidate_count + value.excluded_count !== nodes.length ||
      (value.code !== "no_candidates" && value.code !== "candidate_scope") ||
      (value.code === "candidate_scope" && value.candidate_count === 0) ||
      (value.code === "no_candidates" &&
        (value.candidate_count !== 0 ||
          result.additions.length > 0 ||
          result.edge_candidates.length > 0 ||
          result.risk_signals.length > 0))
    )
      throw new ImpactAdvisoryBlockedError("missing_input", "Impact 本地诊断与建议内容不一致。");
    onDiagnostic?.({
      code: value.code,
      candidate_count: value.candidate_count,
      excluded_count: value.excluded_count,
      excluded_by_reason: {
        already_deterministic: counts.already_deterministic,
        not_accepted: counts.not_accepted,
        unsupported_type: counts.unsupported_type,
      },
    });
  }
  if (result.additions.length === 0 && result.risk_signals.length === 0) {
    return impactSet;
  }
  try {
    return mergeImpactAdvisory(impactSet, result);
  } catch (error) {
    if (error instanceof ImpactError)
      throw new ImpactAdvisoryBlockedError(
        "missing_input",
        "影响辅助建议无法与当前确定性结果合并。",
      );
    throw error;
  }
}
