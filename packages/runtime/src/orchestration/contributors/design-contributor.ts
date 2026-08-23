import { existsSync, readFileSync, readdirSync } from "node:fs";

import {
  canonicalizeJson,
  compileDesignProposalBundle,
  compileDesignReviewBundle,
  contentDigest,
  createDesignReviewRecord,
  createDesignSetProposalRecord,
  PROTOCOL_1_1_SCHEMA_REGISTRY,
  readCommittedOperations,
  readManagedManifest,
  resolveHarnessPath,
  validateDesignReviewOutput,
  type DesignProposalPort,
  type DesignReviewDraft,
  type DesignReviewPort,
  type DesignSetContent,
  type DesignSetProposalRecord,
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
import { readApprovalRequests } from "../../approval/request.js";
import { PHASE_CHECKPOINT_BOUNDARY } from "../phases.js";
import {
  artifactExists,
  commitArtifacts,
  currentAttemptId,
  ensureApproval,
  harnessRoot,
  loadAcceptedDesignSet,
  loadFrozenImpactSet,
  materializeProjectGraph,
  nowOf,
  refreshWorkingState,
  testSeedCriterionBinding,
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
      const binding = testSeedCriterionBinding(node);
      return binding === undefined
        ? []
        : [
            {
              requirement_id: binding.verifies,
              acceptance_criterion_id: binding.acceptance_criterion_id,
              test_node_id: node.id,
            },
          ];
    });
  return { mustChange, risks, pairs };
}

const ASSET_DIRECTORY: Readonly<Record<string, string>> = {
  Decision: "artifacts/decisions",
  Component: "artifacts/components",
  DesignArtifact: "artifacts/design-artifacts",
};

/**
 * An approval pause is a replay boundary: proposal/review artifacts already
 * passed their deterministic checks and the ApprovalRequest binds the exact
 * content digest. Resume must load that immutable proposal instead of asking
 * a model to recreate it against a later Ledger HEAD.
 */
function approvalBoundProposal(ctx: PipelineContext): DesignSetProposalRecord | undefined {
  const root = harnessRoot(ctx.deps);
  const requests = readApprovalRequests(
    root,
    readCommittedOperations(root),
    ctx.workflowOperationId,
  ).filter((request) => request.object_type === "DesignSet");
  const request = requests.at(-1);
  if (request === undefined) return undefined;
  const directory = resolveHarnessPath(root, "artifacts/design-set-proposals");
  if (!existsSync(directory)) return undefined;
  for (const name of readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .sort()) {
    const candidate = JSON.parse(readFileSync(resolveHarnessPath(directory, name), "utf8"));
    if (!PROTOCOL_1_1_SCHEMA_REGISTRY.validate("design-set-proposal", candidate).valid) continue;
    const record = candidate as DesignSetProposalRecord;
    if (
      record.workflow_operation_id === ctx.workflowOperationId &&
      record.iteration_id === ctx.iterationId &&
      record.content_digest === request.object_digest
    ) {
      return record;
    }
  }
  throw new Error("DesignSet ApprovalRequest has no matching immutable proposal artifact");
}

async function commitAcceptedDesign(
  ctx: PipelineContext,
  input: {
    readonly projectId: string;
    readonly designSetId: string;
    readonly content: DesignSetContent;
    readonly approvalDigest: string;
    readonly nodes: readonly NodeRecord[];
    readonly edges: Parameters<typeof buildAcceptedDesignSetRecords>[0]["baseEdges"];
  },
): Promise<PhaseStep> {
  const records = buildAcceptedDesignSetRecords({
    content: input.content,
    approvalDigest: input.approvalDigest,
    revision: input.nodes.filter((node) => node.id === input.designSetId).length + 1,
    baseEdges: input.edges,
    context: {
      projectId: input.projectId,
      iterationId: ctx.iterationId,
      actor: "workflow-engine",
      timestamp: nowOf(ctx.deps),
    },
  });
  await commitArtifacts(
    ctx.deps,
    ctx.workflowOperationId,
    currentAttemptId(ctx),
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
}

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

    const persistedProposal = approvalBoundProposal(ctx);
    if (persistedProposal !== undefined) {
      const content = persistedProposal.content;
      if (
        content.requirement_baseline_digest !== bindings.requirement_baseline_digest ||
        content.impact_set_id !== bindings.impact_set_id ||
        content.impact_set_digest !== bindings.impact_set_digest ||
        content.policy_digest !== bindings.policy_digest
      ) {
        throw new Error("approval-bound DesignSet proposal drifted from authoritative inputs");
      }
      const designSetId = designSetIdFor(projectId, ctx.iterationId);
      const approval = await ensureApproval(ctx, {
        objectId: designSetId,
        objectType: "DesignSet",
        objectDigest: persistedProposal.content_digest,
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
        return blockDesign(
          ctx,
          "missing_input",
          "design set rejected; revise the proposal and resume the design phase",
        );
      }
      return commitAcceptedDesign(ctx, {
        projectId,
        designSetId,
        content,
        approvalDigest: approval.approvalDigest,
        nodes,
        edges,
      });
    }

    if (options.proposal === undefined) {
      return blockDesign(
        ctx,
        "missing_input",
        "design_governance is active but no DesignProposalPort is configured",
      );
    }

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
    return commitAcceptedDesign(ctx, {
      projectId,
      designSetId,
      content,
      approvalDigest: approval.approvalDigest,
      nodes,
      edges,
    });
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
