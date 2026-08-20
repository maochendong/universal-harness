import { canonicalizeJson, sha256Hex, type NodeRecord } from "@universal-harness-internal/core";
import {
  generateImpactSet,
  readImpactSetContent,
  freezeImpactSet,
  type ChangeSeed,
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

export async function phaseImpact(ctx: PipelineContext): Promise<PhaseStep> {
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
 * The impact_analysis module contribution (plan Task 8-A): the coordinator
 * dispatches the `impact` phase through this registration only.
 */
export function createImpactContribution(): ImpactContribution {
  return { capability_id: "impact_analysis", runPhase: phaseImpact };
}
