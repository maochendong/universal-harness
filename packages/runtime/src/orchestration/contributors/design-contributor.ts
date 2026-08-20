import {
  canonicalizeJson,
  compileDesignProposalBundle,
  compileDesignReviewBundle,
  contentDigest,
  createDesignReviewRecord,
  createDesignSetProposalRecord,
  readManagedManifest,
  validateDesignReviewOutput,
  type DesignProposalPort,
  type DesignReviewDraft,
  type DesignReviewPort,
  type DesignSetContent,
  type NodeRecord,
} from "@universal-harness-internal/core";
import {
  buildAcceptedDesignSetRecords,
  designSetIdFor,
  readImpactSetContent,
  validateDesignSetProposal,
  type CriterionTestPair,
} from "@universal-harness-internal/graph";

import { resumeCommandFor } from "../../approval/interaction.js";
import { PHASE_CHECKPOINT_BOUNDARY } from "../phases.js";
import {
  artifactExists,
  commitArtifacts,
  currentAttemptId,
  ensureApproval,
  loadAcceptedDesignSet,
  loadFrozenImpactSet,
  materializeProjectGraph,
  nowOf,
  refreshWorkingState,
} from "../kernel-coordinator.js";
import type { DesignContribution, PhaseStep, PipelineContext } from "../kernel-coordinator.js";

/**
 * The design_governance module contribution (designset lifecycle design 5/6,
 * plan T12). The design phase runs the fixed chain
 * `propose → validate → review → approve → atomic commit`: the proposal port
 * only ever returns untrusted content, the deterministic validator checks it
 * against committed graph facts, the independent review port may recommend
 * but never decide, and only an explicit human approval lets the committer
 * land the accepted DesignSet, its asset revisions and all edges in one
 * ledger operation. A missing port, a validation failure, a review critical
 * finding or a reject all stop the phase without an ApprovalRequest — design
 * never fails open.
 */
export interface DesignContributionOptions {
  readonly proposal?: DesignProposalPort;
  readonly review?: DesignReviewPort;
}

const DEFAULT_REVIEW_RUBRIC = {
  rubric_id: "design-review-default",
  categories: [
    "coverage_gap",
    "contract_conflict",
    "traceability_gap",
    "risk_omission",
    "oracle_gap",
    "feasibility_risk",
  ],
} as const;

async function blockDesign(
  ctx: PipelineContext,
  reason: "missing_input" | "transient_environment_failure",
  detail: string,
): Promise<PhaseStep> {
  await ctx.engine.block(ctx.workflowOperationId, {
    reason,
    detail,
    proposal: {
      phase: "design",
      set_next_action: resumeCommandFor(ctx.workflowOperationId),
    },
  });
  refreshWorkingState(ctx);
  return {
    continue: false,
    outcome: {
      status: "blocked",
      workflowOperationId: ctx.workflowOperationId,
      iterationId: ctx.iterationId,
      reason,
      detail,
      resumeCommand: resumeCommandFor(ctx.workflowOperationId),
    },
  };
}

/** The graph facts the deterministic validator and the ports bind to. */
function designFacts(ctx: PipelineContext, impactSet: NodeRecord, nodes: readonly NodeRecord[]) {
  const content = readImpactSetContent(impactSet);
  const typeById = new Map(nodes.map((node) => [node.id, node.type]));
  const mustChange = content.entries
    .filter(
      (entry) =>
        entry.classification === "must-change" && typeById.get(entry.node_id) === "Requirement",
    )
    .map((entry) => entry.node_id)
    .sort();
  const risks: Record<string, "low" | "medium" | "high"> = {};
  for (const entry of content.entries) {
    if (typeById.get(entry.node_id) === "Requirement") risks[entry.node_id] = entry.risk;
  }
  const pairs: CriterionTestPair[] = nodes
    .filter((node) => node.type === "Test" && node.status === "accepted")
    .flatMap((node) => {
      const extension = node.extensions ?? {};
      const criterion = extension["acceptance_criterion_id"];
      const verifies = extension["verifies"];
      return typeof criterion === "string" && typeof verifies === "string"
        ? [
            {
              requirement_id: verifies,
              acceptance_criterion_id: criterion,
              test_node_id: node.id,
            },
          ]
        : [];
    });
  return { mustChange, risks, pairs };
}

const ASSET_DIRECTORY: Readonly<Record<string, string>> = {
  Decision: "artifacts/decisions",
  Component: "artifacts/components",
  DesignArtifact: "artifacts/design-artifacts",
};

export async function phaseDesign(
  ctx: PipelineContext,
  options: DesignContributionOptions,
): Promise<PhaseStep> {
  const { deps } = ctx;
  const accepted = loadAcceptedDesignSet(ctx);
  if (accepted !== undefined) {
    ctx.designSet = accepted;
    await ctx.engine.commitCheckpoint(ctx.workflowOperationId, {
      boundary: PHASE_CHECKPOINT_BOUNDARY.design,
      proposal: { phase: "plan" },
    });
    refreshWorkingState(ctx);
    return { continue: true };
  }

  if (options.proposal === undefined) {
    return blockDesign(
      ctx,
      "missing_input",
      "design_governance is active but no DesignProposalPort is configured",
    );
  }
  const impactSet = ctx.impactSet ?? loadFrozenImpactSet(ctx);
  if (impactSet === undefined) {
    throw new Error("design phase requires a frozen ImpactSet");
  }
  const impactContent = readImpactSetContent(impactSet);
  const projectId = `project_${readManagedManifest(deps.projectRoot).name}`;
  const graph = materializeProjectGraph(deps.projectRoot);
  try {
    const nodes = [...graph.nodes];
    const edges = [...graph.edges];
    const facts = designFacts(ctx, impactSet, nodes);
    const bindings = {
      requirement_baseline_digest: ctx.baselineDigest,
      impact_set_id: impactSet.id,
      impact_set_digest: impactContent.content_digest,
      policy_digest: ctx.workingState.policy_digest,
      repository_baseline: deps.readBaseline(),
    };

    // 1. Propose.
    const proposalBundle = compileDesignProposalBundle({
      ...bindings,
      must_change_requirement_ids: facts.mustChange,
      requirement_impact_risks: facts.risks,
      criterion_test_pairs: facts.pairs,
      neighborhood: [],
    });
    const attemptId = currentAttemptId(ctx);
    const proposalResult = await options.proposal.propose({
      workflow_operation_id: ctx.workflowOperationId,
      iteration_id: ctx.iterationId,
      ...bindings,
      must_change_requirement_ids: facts.mustChange,
      requirement_impact_risks: facts.risks,
      criterion_test_pairs: facts.pairs,
      sources: proposalBundle.sources,
      bundle_digest: proposalBundle.bundle_digest,
      conversation_id: `design-proposal-conversation_${ctx.workflowOperationId.replace(/^[a-z][a-z0-9-]*_/u, "")}`,
      run_id: `design-proposal-run_${attemptId}`,
    });
    if (proposalResult.status === "failed") {
      return blockDesign(
        ctx,
        proposalResult.failure.retryable ? "transient_environment_failure" : "missing_input",
        `design proposal failed: ${proposalResult.failure.summary}`,
      );
    }
    if (proposalResult.status === "clarification_required") {
      return blockDesign(
        ctx,
        "missing_input",
        `design proposal requires clarification: ${proposalResult.questions.map((question) => question.question).join("; ")}`,
      );
    }

    // 2. Deterministic validation; the proposal record is persisted either
    // way so a reject or a retry never loses the audit trail.
    const content: DesignSetContent = proposalResult.proposal;
    const validationIssues = validateDesignSetProposal({
      content,
      bindings,
      nodes,
      edges,
      must_change_requirement_ids: facts.mustChange,
      requirement_impact_risks: facts.risks,
      criterion_test_pairs: facts.pairs,
    });
    const proposalRecord = createDesignSetProposalRecord({
      workflow_operation_id: ctx.workflowOperationId,
      iteration_id: ctx.iterationId,
      created_at: nowOf(deps),
      generator: { port: options.proposal.name },
      content,
    });
    const proposalPath = `artifacts/design-set-proposals/${proposalRecord.proposal_id}.json`;
    if (!artifactExists(deps, proposalPath)) {
      await commitArtifacts(deps, ctx.workflowOperationId, attemptId, [
        { path: proposalPath, content: `${canonicalizeJson(proposalRecord)}\n` },
      ]);
    }
    const validationDigest = contentDigest({ issues: validationIssues });
    if (validationIssues.length > 0) {
      return blockDesign(
        ctx,
        "missing_input",
        `design proposal failed deterministic validation: ${validationIssues.map((issue) => issue.code).join(", ")}`,
      );
    }

    // 3. Independent review; a critical finding never reaches approval.
    if (options.review === undefined) {
      return blockDesign(
        ctx,
        "missing_input",
        "design_governance is active but no DesignReviewPort is configured",
      );
    }
    const reviewBundle = compileDesignReviewBundle({
      proposal_content: content,
      validation_digest: validationDigest,
      policy_digest: bindings.policy_digest,
      rubric: DEFAULT_REVIEW_RUBRIC,
    });
    const reviewResult = await options.review.review({
      workflow_operation_id: ctx.workflowOperationId,
      iteration_id: ctx.iterationId,
      proposal_content: content,
      proposal_digest: proposalRecord.record_digest,
      validation_digest: validationDigest,
      bundle_sources: reviewBundle.sources.map((source) => ({
        ref: source.locator,
        digest: source.source_digest,
      })),
      bundle_digest: reviewBundle.bundle_digest,
      rubric: DEFAULT_REVIEW_RUBRIC,
      must_change_requirement_ids: facts.mustChange,
      conversation_id: `design-review-conversation_${ctx.workflowOperationId.replace(/^[a-z][a-z0-9-]*_/u, "")}`,
      run_id: `design-review-run_${attemptId}`,
    });
    if (reviewResult.status === "failed") {
      return blockDesign(
        ctx,
        reviewResult.failure.retryable ? "transient_environment_failure" : "missing_input",
        `design review failed: ${reviewResult.failure.summary}`,
      );
    }
    const reviewDraft: DesignReviewDraft = {
      verdict: reviewResult.status,
      findings: [...reviewResult.findings],
      coverage_assessment: [...reviewResult.coverage_assessment],
      residual_risks: [...reviewResult.residual_risks],
      summary: reviewResult.summary,
    };
    const reviewIssues = validateDesignReviewOutput({
      output: reviewDraft,
      bundle_sources: reviewBundle.sources.map((source) => ({
        ref: source.locator,
        digest: source.source_digest,
      })),
      proposal_content: content,
      must_change_requirement_ids: facts.mustChange,
    });
    const reviewRecord = createDesignReviewRecord({
      workflow_operation_id: ctx.workflowOperationId,
      iteration_id: ctx.iterationId,
      proposal_digest: proposalRecord.record_digest,
      proposal_content_digest: proposalRecord.content_digest,
      validation_digest: validationDigest,
      review_bundle_digest: reviewBundle.bundle_digest,
      reviewer_port: options.review.name,
      conversation_id: `design-review-conversation_${ctx.workflowOperationId.replace(/^[a-z][a-z0-9-]*_/u, "")}`,
      run_id: `design-review-run_${attemptId}`,
      output: reviewDraft,
    });
    const reviewPath = `artifacts/design-reviews/${reviewRecord.review_id}.json`;
    if (!artifactExists(deps, reviewPath)) {
      await commitArtifacts(deps, ctx.workflowOperationId, attemptId, [
        { path: reviewPath, content: `${canonicalizeJson(reviewRecord)}\n` },
      ]);
    }
    if (reviewIssues.length > 0) {
      return blockDesign(
        ctx,
        "missing_input",
        `design review failed result validation: ${reviewIssues.map((issue) => issue.code).join(", ")}`,
      );
    }
    if (reviewResult.status === "blocked") {
      return blockDesign(
        ctx,
        "missing_input",
        `design review blocked the proposal: ${reviewResult.findings.map((finding) => finding.finding_id).join(", ")}`,
      );
    }
    if (reviewResult.status === "revision_required") {
      return blockDesign(
        ctx,
        "missing_input",
        `design review requires revision: ${reviewResult.summary}`,
      );
    }

    // 4. Human approval of the whole DesignSet, bound to the content digest.
    const designSetId = designSetIdFor(projectId, ctx.iterationId);
    const approval = await ensureApproval(ctx, {
      objectId: designSetId,
      objectType: "DesignSet",
      objectDigest: proposalRecord.content_digest,
      risk: content.risk_summary.level,
      reason: "approve the design set before declarative planning",
      resumePhase: "design",
    });
    if (approval.status === "required") {
      return {
        continue: false,
        outcome: { status: "approval_required", required: approval.required },
      };
    }
    if (approval.status === "rejected") {
      // DesignSet reject never terminates the iteration (design 11.4): the
      // proposal stays on record and a resumed design phase re-proposes.
      return blockDesign(
        ctx,
        "missing_input",
        "design set rejected; revise the proposal and resume the design phase",
      );
    }

    // 5. Atomic commit: accepted DesignSet + asset revisions + all edges.
    const priorRevisions = nodes.filter((node) => node.id === designSetId).length;
    const records = buildAcceptedDesignSetRecords({
      content,
      approvalDigest: approval.approvalDigest,
      revision: priorRevisions + 1,
      baseEdges: edges,
      context: {
        projectId,
        iterationId: ctx.iterationId,
        actor: "workflow-engine",
        timestamp: nowOf(deps),
      },
    });
    await commitArtifacts(
      deps,
      ctx.workflowOperationId,
      attemptId,
      [
        {
          path: `artifacts/design-sets/${records.designSet.id}/${String(records.designSet.revision)}.json`,
          content: `${canonicalizeJson(records.designSet)}\n`,
        },
        ...records.assets.map((asset) => ({
          path: `${ASSET_DIRECTORY[asset.type] ?? "artifacts/design-artifacts"}/${asset.id}/${String(asset.revision)}.json`,
          content: `${canonicalizeJson(asset)}\n`,
        })),
      ],
      [...records.edges],
    );
    ctx.designSet = records.designSet;
    await ctx.engine.commitCheckpoint(ctx.workflowOperationId, {
      boundary: PHASE_CHECKPOINT_BOUNDARY.design,
      proposal: { phase: "plan" },
    });
    refreshWorkingState(ctx);
    return { continue: true };
  } finally {
    graph.close();
  }
}

export function createDesignContribution(options?: DesignContributionOptions): DesignContribution {
  return {
    capability_id: "design_governance",
    runPhase: (ctx) => phaseDesign(ctx, options ?? {}),
  };
}
