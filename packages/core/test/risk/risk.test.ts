import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPrdCaptureCoordinator } from "../../src/capture/coordinator.js";
import { readProfileRecommendationRecords } from "../../src/profile/store.js";
import {
  createPrdProposalRecord,
  createPrdValidationReportRecord,
} from "../../src/proposal/records.js";
import { runPrdHardGates } from "../../src/proposal/gates.js";
import { createPrdReviewReportRecord } from "../../src/review/records.js";
import { assessCaptureRisk, routeCaptureApproval } from "../../src/risk/engine.js";
import { createCaptureRiskStageHandlers, type CaptureRiskPolicy } from "../../src/risk/stages.js";
import { readCaptureRiskAssessments } from "../../src/risk/store.js";
import type { CaptureSessionRecord } from "../../src/schema/capture.js";
import type { PrdProposalDraft } from "../../src/schema/proposal.js";
import { makeBundle, makeSession, makeValidDraft } from "../proposal/helpers.js";
import {
  REVIEW_RUBRIC,
  makeAcceptDraft,
  makeReviewBundle,
  makeReviewPipelineHandlers,
  startCommandFor,
} from "../review/pipeline.js";

const createdRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-risk-"));
  createdRoots.push(root);
  return root;
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

const STANDARD_POLICY: CaptureRiskPolicy = {
  project_id: "project_demo",
  profile_id: "standard",
  allow_policy_auto_approval: true,
  policy_actor: "policy:capture-standard@1",
};

function intentBinding(session: CaptureSessionRecord) {
  return {
    source_kind: "intent" as const,
    source_id: "intent",
    source_digest: session.intent_digest,
  };
}

function draftWithSecurityConstraint(session: CaptureSessionRecord): PrdProposalDraft {
  const draft = makeValidDraft(session);
  return {
    ...draft,
    constraints: [
      {
        draft_key: "constraint-1",
        lineage: { kind: "new" },
        proposed_source_bindings: [intentBinding(session)],
        statement: "导出文件不得包含其他用户的数据。",
        category: "security",
        verification_intent: "verify exported rows belong to the requesting user",
      },
    ],
  };
}

function draftWithCriticalRisk(session: CaptureSessionRecord): PrdProposalDraft {
  const draft = makeValidDraft(session);
  return {
    ...draft,
    risks: [
      {
        draft_key: "risk-1",
        lineage: { kind: "new" },
        proposed_source_bindings: [intentBinding(session)],
        category: "data_integrity",
        description: "导出可能写坏既有报表数据。",
        likelihood: "medium",
        impact: "critical",
        mitigation: "append-only export log",
      },
    ],
  };
}

function makeRiskPipeline(
  root: string,
  policy: CaptureRiskPolicy,
  proposalDrafts: readonly ((session: CaptureSessionRecord) => PrdProposalDraft)[],
) {
  const { handlers, proposalAdapter, reviewAdapter } = makeReviewPipelineHandlers(root, {
    proposalDrafts,
  });
  const riskStages = createCaptureRiskStageHandlers({
    projectRoot: root,
    policy,
    policy_digest: "9".repeat(64),
  });
  return {
    proposalAdapter,
    reviewAdapter,
    handlers: { ...handlers, assessRisk: riskStages.assessRisk },
  };
}

describe("capture risk stage", () => {
  it("routes low/non-material/high-confidence captures to policy auto approval", async () => {
    const root = makeRoot();
    const session = makeSession();
    const { handlers } = makeRiskPipeline(root, STANDARD_POLICY, [makeValidDraft]);
    // No accept handler wired: auto approval must fail closed rather than
    // silently skipping the accepted transaction.
    const coordinator = createPrdCaptureCoordinator({ projectRoot: root, handlers });
    const outcome = await coordinator.advance(startCommandFor(session));
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("expected failure");
    expect(outcome.kind).toBe("stage_unavailable");

    const assessments = readCaptureRiskAssessments(root, session.session_id);
    expect(assessments).toHaveLength(1);
    expect(assessments[0]?.level).toBe("low");
    expect(assessments[0]?.materiality).toBe("non_material");
    expect(assessments[0]?.confidence).toBe("high");
  });

  it("routes material changes to human approval even when auto approval is allowed", async () => {
    const root = makeRoot();
    const session = makeSession();
    const { handlers } = makeRiskPipeline(root, STANDARD_POLICY, [draftWithSecurityConstraint]);
    const coordinator = createPrdCaptureCoordinator({ projectRoot: root, handlers });
    const outcome = await coordinator.advance(startCommandFor(session));
    expect(outcome.status).toBe("awaiting_approval");
    const assessments = readCaptureRiskAssessments(root, session.session_id);
    expect(assessments[0]?.materiality).toBe("material");
  });

  it("denies levels the policy forbids with a typed blocker", async () => {
    const root = makeRoot();
    const session = makeSession();
    const { handlers } = makeRiskPipeline(root, { ...STANDARD_POLICY, deny_levels: ["critical"] }, [
      draftWithCriticalRisk,
    ]);
    const coordinator = createPrdCaptureCoordinator({ projectRoot: root, handlers });
    const outcome = await coordinator.advance(startCommandFor(session));
    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") throw new Error("expected blocked");
    expect(outcome.blocker.reason).toBe("risk_policy_denied");
    const assessments = readCaptureRiskAssessments(root, session.session_id);
    expect(assessments[0]?.level).toBe("critical");
  });

  it("emits a profile recommendation and pauses when risk exceeds the current profile", async () => {
    const root = makeRoot();
    const session = makeSession();
    const litePolicy: CaptureRiskPolicy = {
      project_id: "project_demo",
      profile_id: "lite",
      allow_policy_auto_approval: true,
      policy_actor: "policy:capture-lite@1",
    };
    const { handlers } = makeRiskPipeline(root, litePolicy, [draftWithSecurityConstraint]);
    const coordinator = createPrdCaptureCoordinator({ projectRoot: root, handlers });
    const outcome = await coordinator.advance(startCommandFor(session));
    expect(outcome.status).toBe("awaiting_profile_decision");
    const recommendations = readProfileRecommendationRecords(root);
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]?.current_profile_id).toBe("lite");
    expect(recommendations[0]?.recommended_profile_id).toBe("standard");
    expect(recommendations[0]?.triggers).toContain("security_or_supply_chain_surface");
    const assessments = readCaptureRiskAssessments(root, session.session_id);
    expect(recommendations[0]?.risk_object_digest).toBe(assessments[0]?.assessment_digest);
  });
});

describe("capture risk engine", () => {
  function assessedFacts(session: CaptureSessionRecord, draft: PrdProposalDraft) {
    const bundle = makeBundle(session);
    const { record: proposal } = createPrdProposalRecord({
      session,
      revision: 1,
      draft,
      proposal_context_bundle: bundle,
      answers: [],
      adapter_profile_digest: "e".repeat(64),
      prompt_version_digest: "f".repeat(64),
      producer_identity: "test",
      invocation_id: "capture-invocation_01K1PROPOSAL00000000",
      conversation_id: "capture-conversation_01K1PROPOSAL00000",
      evidence_locator: "capture-evidence://proposal",
    });
    const validation = createPrdValidationReportRecord({
      session_id: session.session_id,
      proposal_digest: proposal.content_digest,
      results: runPrdHardGates(proposal.content).results,
      blocking_question_ids: [],
    });
    const review = createPrdReviewReportRecord({
      session,
      proposal,
      review_context_bundle: makeReviewBundle(session),
      validation_report: validation,
      draft: makeAcceptDraft(),
      rubric: REVIEW_RUBRIC,
      reviewer_adapter_profile_digest: "7".repeat(64),
      prompt_version_digest: "8".repeat(64),
      reviewer_identity: "reviewer:test",
      invocation_id: "capture-invocation_01K1REVIEW0000000000",
      conversation_id: "capture-conversation_01K1REVIEW0000000",
      evidence_locator: "capture-evidence://review",
    });
    return { proposal, validation_report: validation, review_report: review };
  }

  it("reduces deterministically and degrades confidence on unknown classifications", () => {
    const session = makeSession();
    const draft = makeValidDraft(session);
    const unknownRiskDraft: PrdProposalDraft = {
      ...draft,
      risks: [
        {
          draft_key: "risk-1",
          lineage: { kind: "new" },
          proposed_source_bindings: [intentBinding(session)],
          category: "operational",
          description: "运维影响未知。",
          likelihood: "unknown",
          impact: "unknown",
          mitigation: "observe",
        },
      ],
    };
    const facts = assessedFacts(session, unknownRiskDraft);
    const first = assessCaptureRisk(facts);
    const second = assessCaptureRisk(facts);
    expect(first).toEqual(second);
    expect(first.confidence).toBe("low");
    expect(first.level).toBe("medium");
    expect(first.materiality).toBe("non_material");
    expect(first.triggers.every((trigger) => trigger.source_digest.length === 64)).toBe(true);
  });

  it("never auto-approves under a governed profile", () => {
    const session = makeSession();
    const facts = assessedFacts(session, makeValidDraft(session));
    const assessment = assessCaptureRisk(facts);
    expect(assessment.level).toBe("low");
    const route = routeCaptureApproval(assessment, facts, {
      project_id: "project_demo",
      profile_id: "governed",
      allow_policy_auto_approval: true,
      policy_actor: "policy:capture-governed@1",
    });
    expect(route.kind).toBe("human");
  });
});
