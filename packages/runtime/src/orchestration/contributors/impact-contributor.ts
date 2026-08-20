import { canonicalizeJson, sha256Hex, type NodeRecord } from "@universal-harness-internal/core";
import {
  RELATION_RULE_REGISTRY,
  generateImpactSet,
  mergeImpactAdvisory,
  readImpactSetContent,
  freezeImpactSet,
  type ChangeSeed,
  type ImpactAdvisoryPort,
} from "@universal-harness-internal/graph";
import { PHASE_CHECKPOINT_BOUNDARY } from "../phases.js";
import {
  artifactExists,
  commitArtifacts,
  currentAttemptId,
  ensureApproval,
  loadFrozenImpactSet,
  materializeProjectGraph,
  nowOf,
  refreshWorkingState,
  rejectOperation,
} from "../kernel-coordinator.js";
import type { ImpactContribution, PhaseStep, PipelineContext } from "../kernel-coordinator.js";

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
      );
    }
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
 * proposed set and the approval binds to the merged content. A failed or
 * clarification-only advisory changes nothing — the deterministic set
 * proceeds on its own, so removing the model never affects deterministic
 * propagation or its risk floor.
 */
export async function adviseImpactSet(
  ids: ImpactAdvisoryPhaseIds,
  impactSet: NodeRecord,
  nodes: readonly NodeRecord[],
  advisory: ImpactAdvisoryPort,
): Promise<NodeRecord> {
  const content = readImpactSetContent(impactSet);
  const requirementDigests: Record<string, string> = {};
  for (const node of nodes) {
    if (node.type === "Requirement") {
      requirementDigests[node.id] = node.digest;
    }
  }
  const result = await advisory.advise({
    workflow_operation_id: ids.workflow_operation_id,
    iteration_id: ids.iteration_id,
    impact_set_digest: content.content_digest,
    deterministic_entries: content.entries,
    nodes,
    requirement_digests: requirementDigests,
    rule_registry_version: RELATION_RULE_REGISTRY.version,
    rule_registry_digest: RELATION_RULE_REGISTRY.digest,
    conversation_id: `impact-advisory-conversation_${ids.workflow_operation_id.replace(/^[a-z][a-z0-9-]*_/u, "")}`,
    run_id: `impact-advisory-run_${ids.attempt_id}`,
  });
  if (result.status !== "proposed") {
    return impactSet;
  }
  if (result.additions.length === 0 && result.risk_signals.length === 0) {
    return impactSet;
  }
  return mergeImpactAdvisory(impactSet, result);
}
