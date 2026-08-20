import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CaptureApprovalDecisionView } from "../../src/capture/commands.js";
import { createPrdCaptureCoordinator } from "../../src/capture/coordinator.js";
import { readCaptureCheckpoints } from "../../src/capture/store.js";
import { LedgerRepository } from "../../src/ledger/repository.js";
import {
  buildAcceptedPrdGraph,
  deriveCaptureIntentNodeId,
  type AcceptanceGraphContext,
} from "../../src/acceptance/graph.js";
import { createCaptureAcceptanceStageHandler } from "../../src/acceptance/commit.js";
import {
  readAcceptedGraphNodes,
  readAcceptedPrdRecords,
  readRequirementBaselineRecords,
} from "../../src/acceptance/store.js";
import { deriveCaptureTestSeedId } from "../../src/acceptance/test-seed.js";
import { createCaptureRiskStageHandlers, type CaptureRiskPolicy } from "../../src/risk/stages.js";
import { readCaptureRiskAssessments } from "../../src/risk/store.js";
import { readPrdEntityLineageRecords, readPrdProposalRevisions } from "../../src/proposal/store.js";
import { readPrdReviewReports } from "../../src/review/store.js";
import { readPrdValidationReports } from "../../src/proposal/store.js";
import type { CaptureSessionRecord } from "../../src/schema/capture.js";
import type { NodeRecord } from "../../src/schema/node.js";
import type { PrdProposalDraft } from "../../src/schema/proposal.js";
import { makeSession, makeValidDraft } from "../proposal/helpers.js";
import {
  makeAcceptDraft,
  makeReviewPipelineHandlers,
  startCommandFor,
} from "../review/pipeline.js";

/**
 * T7 accepted transaction tests (intent-to-prd design 6.8/7.5/13.1): the
 * approve path commits the accepted PRD, the requirement baseline, the graph
 * nodes/edges and the bindings in one ledger operation; a failed or crashed
 * transaction leaves no partial accepted state; criterion/Test seed identity
 * is stable and replayable.
 */
const createdRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-acceptance-"));
  createdRoots.push(root);
  return root;
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

const BASELINE = "0".repeat(64);
const POLICY_DIGEST = "9".repeat(64);
const NOW = "2026-08-19T12:00:00.000Z";

const MATERIAL_POLICY: CaptureRiskPolicy = {
  project_id: "project_demo",
  profile_id: "standard",
  allow_policy_auto_approval: false,
  policy_actor: "policy:capture-standard@1",
};

const AUTO_POLICY: CaptureRiskPolicy = {
  project_id: "project_demo",
  profile_id: "standard",
  allow_policy_auto_approval: true,
  policy_actor: "policy:capture-standard@1",
};

class FakeApprovalDecisions {
  private readonly decisions = new Map<string, CaptureApprovalDecisionView>();

  put(decision: CaptureApprovalDecisionView): void {
    this.decisions.set(`${decision.request_id}/${decision.decision_id}`, decision);
  }

  read = (requestId: string, decisionId: string): CaptureApprovalDecisionView | undefined =>
    this.decisions.get(`${requestId}/${decisionId}`);
}

function makeAcceptPipeline(
  root: string,
  options: {
    readonly policy: CaptureRiskPolicy;
    readonly proposalDrafts: readonly ((session: CaptureSessionRecord) => PrdProposalDraft)[];
    readonly hooks?: ConstructorParameters<typeof LedgerRepository>[0]["hooks"];
  },
) {
  const pipeline = makeReviewPipelineHandlers(root, { proposalDrafts: options.proposalDrafts });
  const risk = createCaptureRiskStageHandlers({
    projectRoot: root,
    policy: options.policy,
    policy_digest: POLICY_DIGEST,
  });
  const accept = createCaptureAcceptanceStageHandler({
    projectRoot: root,
    readBaseline: () => BASELINE,
    policy_digest: POLICY_DIGEST,
    now: () => NOW,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
  return {
    ...pipeline,
    handlers: {
      ...pipeline.handlers,
      assessRisk: risk.assessRisk,
      accept,
    },
  };
}

async function driveToApproval(
  root: string,
  session: CaptureSessionRecord,
  handlers: ReturnType<typeof makeAcceptPipeline>["handlers"],
  decisions: FakeApprovalDecisions,
) {
  const coordinator = createPrdCaptureCoordinator({
    projectRoot: root,
    handlers,
    readApprovalDecision: decisions.read,
  });
  const outcome = await coordinator.advance(startCommandFor(session));
  if (outcome.status !== "awaiting_approval") {
    throw new Error(`expected awaiting_approval, got ${outcome.status}`);
  }
  return { coordinator, outcome };
}

function approveDecision(
  outcome: { approval_request_id: string; approval_object_digest: string },
  overrides?: Partial<CaptureApprovalDecisionView>,
): CaptureApprovalDecisionView {
  return {
    decision_id: "approval-decision_human-1",
    request_id: outcome.approval_request_id,
    decision: "approve",
    object_digest: outcome.approval_object_digest,
    actor: "human:approver",
    ...overrides,
  };
}

describe("accepted PRD atomic commit", () => {
  it("commits accepted PRD, baseline, graph records, bindings and checkpoint atomically", async () => {
    const root = makeRoot();
    const session = makeSession();
    const decisions = new FakeApprovalDecisions();
    const { handlers } = makeAcceptPipeline(root, {
      policy: MATERIAL_POLICY,
      proposalDrafts: [makeValidDraft],
    });
    const { coordinator, outcome } = await driveToApproval(root, session, handlers, decisions);
    const proposals = readPrdProposalRevisions(root, session.session_id);
    expect(proposals).toHaveLength(1);
    const proposalDigest = proposals[0]!.content_digest;

    const decision = approveDecision(outcome);
    decisions.put(decision);
    const applied = await coordinator.advance({
      command: "apply_approval_decision",
      session_id: session.session_id,
      expected_session_digest: outcome.session.record_digest,
      request_id: decision.request_id,
      decision_id: decision.decision_id,
    });
    expect(applied.status).toBe("accepted");

    // AcceptedPrdRecord: immutable, bound to every authorizing digest.
    const accepted = readAcceptedPrdRecords(root);
    expect(accepted).toHaveLength(1);
    const record = accepted[0]!;
    expect(record.proposal_content_digest).toBe(proposalDigest);
    expect(record.validation_report_digest).toBe(
      readPrdValidationReports(root, session.session_id).at(-1)?.report_digest,
    );
    expect(record.review_report_digest).toBe(
      readPrdReviewReports(root, session.session_id).at(-1)?.report_digest,
    );
    expect(record.risk_assessment_digest).toBe(
      readCaptureRiskAssessments(root, session.session_id).at(-1)?.assessment_digest,
    );
    expect(record.revision).toBe(1);
    expect(record.supersedes_digest).toBeUndefined();

    // RequirementBaseline materializes the deterministic Test seeds.
    const baselines = readRequirementBaselineRecords(root, session.session_id);
    expect(baselines).toHaveLength(1);
    const baseline = baselines[0]!;
    expect(record.requirement_baseline_digest).toBe(baseline.record_digest);
    expect(baseline.proposal_content_digest).toBe(proposalDigest);
    const criterion = proposals[0]!.content.acceptance_criteria[0]!;
    expect(baseline.criterion_test_seeds).toHaveLength(1);
    const seed = baseline.criterion_test_seeds[0]!;
    expect(seed.criterion_id).toBe(criterion.criterion_id);
    expect(seed.test_id).toBe(deriveCaptureTestSeedId(criterion.criterion_id));
    expect(seed.test_revision).toBe(1);

    // Graph records: Intent/Requirement/Test nodes + traceability edges.
    const nodes = readAcceptedGraphNodes(root);
    expect(nodes.get(deriveCaptureIntentNodeId(session.session_id))?.type).toBe("Intent");
    expect(nodes.get(proposals[0]!.content.requirements[0]!.id)?.type).toBe("Requirement");
    const testNode = nodes.get(seed.test_id);
    expect(testNode?.type).toBe("Test");
    const testExtensions = (testNode?.extensions ?? {})["harness.requirements"] as Record<
      string,
      unknown
    >;
    expect(testExtensions["acceptance_criterion_id"]).toBe(criterion.criterion_id);
    expect(testExtensions["criterion_semantic_digest"]).toBe(criterion.criterion_semantic_digest);

    const replay = new LedgerRepository({
      projectRoot: root,
      readBaseline: () => BASELINE,
    }).replay();
    const edgeTypes = replay.edges.map((edge) => edge.type).sort();
    expect(edgeTypes).toContain("DECOMPOSES_TO");
    expect(edgeTypes).toContain("VERIFIES");
    const verifies = replay.edges.find((edge) => edge.type === "VERIFIES");
    expect(verifies?.source_id).toBe(seed.test_id);
    expect(verifies?.target_id).toBe(criterion.requirement_id);

    // The accepted proposal status revision and the accepted checkpoint exist.
    const finalProposals = readPrdProposalRevisions(root, session.session_id);
    expect(finalProposals).toHaveLength(2);
    expect(finalProposals[1]?.status).toBe("accepted");
    expect(finalProposals[1]?.supersedes_digest).toBe(finalProposals[0]?.record_digest);
    const checkpoints = readCaptureCheckpoints(root, session.session_id);
    expect(checkpoints.at(-1)?.state).toBe("accepted");
  });

  it("keeps the accepted PRD immutable: a replayed decision is an idempotent no-op", async () => {
    const root = makeRoot();
    const session = makeSession();
    const decisions = new FakeApprovalDecisions();
    const { handlers } = makeAcceptPipeline(root, {
      policy: MATERIAL_POLICY,
      proposalDrafts: [makeValidDraft],
    });
    const { coordinator, outcome } = await driveToApproval(root, session, handlers, decisions);
    const decision = approveDecision(outcome);
    decisions.put(decision);
    const applied = await coordinator.advance({
      command: "apply_approval_decision",
      session_id: session.session_id,
      expected_session_digest: outcome.session.record_digest,
      request_id: decision.request_id,
      decision_id: decision.decision_id,
    });
    expect(applied.status).toBe("accepted");
    const firstRecords = readAcceptedPrdRecords(root);

    const replay = await coordinator.advance({
      command: "apply_approval_decision",
      session_id: session.session_id,
      expected_session_digest: applied.session.record_digest,
      request_id: decision.request_id,
      decision_id: decision.decision_id,
    });
    expect(replay.status).toBe("already_applied");
    expect(readAcceptedPrdRecords(root)).toEqual(firstRecords);
    expect(readPrdProposalRevisions(root, session.session_id)).toHaveLength(2);
  });

  it("a decision bound to a drifted object digest invalidates the approval and commits nothing", async () => {
    const root = makeRoot();
    const session = makeSession();
    const decisions = new FakeApprovalDecisions();
    const { handlers } = makeAcceptPipeline(root, {
      policy: MATERIAL_POLICY,
      proposalDrafts: [makeValidDraft],
    });
    const { coordinator, outcome } = await driveToApproval(root, session, handlers, decisions);
    const drifted = approveDecision(outcome, { object_digest: "f".repeat(64) });
    decisions.put(drifted);
    const applied = await coordinator.advance({
      command: "apply_approval_decision",
      session_id: session.session_id,
      expected_session_digest: outcome.session.record_digest,
      request_id: drifted.request_id,
      decision_id: drifted.decision_id,
    });
    expect(applied.status).toBe("failed");
    if (applied.status !== "failed") throw new Error("expected failure");
    expect(applied.kind).toBe("approval_binding_mismatch");
    expect(readAcceptedPrdRecords(root)).toEqual([]);
    expect(readRequirementBaselineRecords(root, session.session_id)).toEqual([]);
  });

  it("a crashed accepted transaction leaves no partial state and resumes to an identical commit", async () => {
    const root = makeRoot();
    const session = makeSession();
    const decisions = new FakeApprovalDecisions();
    let armed = true;
    const { handlers } = makeAcceptPipeline(root, {
      policy: MATERIAL_POLICY,
      proposalDrafts: [makeValidDraft],
      hooks: {
        atBoundary(boundary) {
          if (armed && boundary === "validation.completed") {
            armed = false;
            throw new Error("simulated crash before publish");
          }
        },
      },
    });
    const { coordinator, outcome } = await driveToApproval(root, session, handlers, decisions);
    const decision = approveDecision(outcome);
    decisions.put(decision);
    // The crash surfaces as a rejected advance, exactly like a process dying
    // mid-commit; the committed bytes are the only state.
    await expect(
      coordinator.advance({
        command: "apply_approval_decision",
        session_id: session.session_id,
        expected_session_digest: outcome.session.record_digest,
        request_id: decision.request_id,
        decision_id: decision.decision_id,
      }),
    ).rejects.toThrow("simulated crash");
    // Nothing partial: no accepted record, no baseline, no graph nodes, and
    // the session is still waiting for its approval decision to be consumed.
    expect(readAcceptedPrdRecords(root)).toEqual([]);
    expect(readRequirementBaselineRecords(root, session.session_id)).toEqual([]);
    expect(readAcceptedGraphNodes(root).size).toBe(0);
    expect(readPrdProposalRevisions(root, session.session_id)).toHaveLength(1);

    const waiting = coordinator.current(session.session_id);
    expect(waiting?.state).toBe("approval_required");
    const recovered = await coordinator.advance({
      command: "apply_approval_decision",
      session_id: session.session_id,
      expected_session_digest: waiting!.record_digest,
      request_id: decision.request_id,
      decision_id: decision.decision_id,
    });
    expect(recovered.status).toBe("accepted");
    expect(readAcceptedPrdRecords(root)).toHaveLength(1);
    expect(readRequirementBaselineRecords(root, session.session_id)).toHaveLength(1);
    expect(readAcceptedGraphNodes(root).size).toBeGreaterThan(0);
  });

  it("auto-approves a low/non-material/high-confidence capture with the policy identity", async () => {
    const root = makeRoot();
    const session = makeSession();
    const decisions = new FakeApprovalDecisions();
    const { handlers } = makeAcceptPipeline(root, {
      policy: AUTO_POLICY,
      proposalDrafts: [makeValidDraft],
    });
    const coordinator = createPrdCaptureCoordinator({
      projectRoot: root,
      handlers,
      readApprovalDecision: decisions.read,
    });
    const outcome = await coordinator.advance(startCommandFor(session));
    // No human round-trip: the policy decision is generated inside the
    // accepted transaction and the session lands in accepted directly.
    expect(outcome.status).toBe("accepted");
    expect(outcome.session.applied_approval_decision_id).toBeDefined();
    const accepted = readAcceptedPrdRecords(root);
    expect(accepted).toHaveLength(1);
    const replay = new LedgerRepository({
      projectRoot: root,
      readBaseline: () => BASELINE,
    }).replay();
    expect(replay.edges.some((edge) => edge.type === "VERIFIES")).toBe(true);
  });

  it("keeps criterion and Test seed identity stable across a revise round and re-verifies lineage", async () => {
    const root = makeRoot();
    const session = makeSession();
    const decisions = new FakeApprovalDecisions();

    // Round 2 draft: the criterion continues with the same id (resolved from
    // the previous proposal) but changed business text.
    const revised = (live: CaptureSessionRecord): PrdProposalDraft => {
      const prior = readPrdProposalRevisions(root, live.session_id).at(-1);
      if (prior === undefined) return makeValidDraft(live);
      const priorCriterion = prior.content.acceptance_criteria[0]!;
      const priorRequirement = prior.content.requirements[0]!;
      const binding = {
        source_kind: "intent" as const,
        source_id: "intent",
        source_digest: live.intent_digest,
      };
      return {
        ...makeValidDraft(live),
        requirements: [
          {
            draft_key: "req-1",
            lineage: { kind: "continues", previous_entity_id: priorRequirement.id },
            proposed_source_bindings: [binding],
            statement: priorRequirement.statement,
            priority: "must",
            change_kind: "must_change",
            scenario_ids: [],
            acceptance_criterion_ids: ["criterion-1"],
          },
        ],
        acceptance_criteria: [
          {
            draft_key: "criterion-1",
            lineage: { kind: "continues", previous_entity_id: priorCriterion.criterion_id },
            proposed_source_bindings: [binding],
            requirement_id: "req-1",
            precondition: priorCriterion.precondition,
            action: "the user exports the report as CSV from the reports page",
            observable_outcome: "a CSV file containing the report rows is produced",
            verification_intent: "compare the exported CSV rows with the report data",
            test_first_example:
              "given an existing report, exporting produces a CSV whose rows match the report",
            scenario_kind: "primary",
          },
        ],
      };
    };
    const reviseDraft = {
      ...makeAcceptDraft(),
      verdict: "revise" as const,
      findings: [
        {
          finding_id: "finding-action",
          severity: "warning" as const,
          target_kind: "acceptance_criterion" as const,
          message: "the action should name the entry point",
        },
      ],
    };
    const pipeline = makeReviewPipelineHandlers(root, {
      proposalDrafts: [makeValidDraft, revised],
      reviewResults: [reviseDraft, makeAcceptDraft()],
    });
    const risk = createCaptureRiskStageHandlers({
      projectRoot: root,
      policy: MATERIAL_POLICY,
      policy_digest: POLICY_DIGEST,
    });
    const accept = createCaptureAcceptanceStageHandler({
      projectRoot: root,
      readBaseline: () => BASELINE,
      policy_digest: POLICY_DIGEST,
      now: () => NOW,
    });
    const coordinator = createPrdCaptureCoordinator({
      projectRoot: root,
      handlers: { ...pipeline.handlers, assessRisk: risk.assessRisk, accept },
      readApprovalDecision: decisions.read,
    });
    const waiting = await coordinator.advance(startCommandFor(session));
    if (waiting.status !== "awaiting_approval") {
      throw new Error(`expected awaiting_approval, got ${waiting.status}`);
    }
    const decision = approveDecision(waiting);
    decisions.put(decision);
    const applied = await coordinator.advance({
      command: "apply_approval_decision",
      session_id: session.session_id,
      expected_session_digest: waiting.session.record_digest,
      request_id: decision.request_id,
      decision_id: decision.decision_id,
    });
    expect(applied.status).toBe("accepted");

    const proposals = readPrdProposalRevisions(root, session.session_id);
    const criterionRev1 = proposals[0]!.content.acceptance_criteria[0]!;
    const criterionRev2 = proposals[1]!.content.acceptance_criteria[0]!;
    // The criterion continues: same id, rotated semantic digest.
    expect(criterionRev2.criterion_id).toBe(criterionRev1.criterion_id);
    expect(criterionRev2.criterion_semantic_digest).not.toBe(
      criterionRev1.criterion_semantic_digest,
    );
    const baselines = readRequirementBaselineRecords(root, session.session_id);
    const seed = baselines[0]!.criterion_test_seeds[0]!;
    expect(seed.criterion_id).toBe(criterionRev1.criterion_id);
    expect(seed.test_id).toBe(deriveCaptureTestSeedId(criterionRev1.criterion_id));
    expect(seed.criterion_semantic_digest).toBe(criterionRev2.criterion_semantic_digest);

    // Lineage is mechanically re-verifiable: the criterion lineage record of
    // the accepted proposal declares `continues` and binds real sources.
    const lineage = readPrdEntityLineageRecords(root, session.session_id).filter(
      (entry) =>
        entry.entity_kind === "acceptance_criterion" &&
        entry.entity_id === criterionRev1.criterion_id &&
        entry.proposal_content_digest === proposals[1]!.content_digest,
    );
    expect(lineage).toHaveLength(1);
    expect(lineage[0]?.lineage_kind).toBe("continues");
    expect(lineage[0]?.previous_proposal_content_digest).toBe(proposals[0]!.content_digest);
  });
});

describe("accepted graph builder", () => {
  function graphContext(priorNodes: Map<string, NodeRecord>): AcceptanceGraphContext {
    return {
      session_id: "capture-session_test",
      iteration_id: "iteration_01K1ABCDEFGHIJKLMNO",
      actor: "human:approver",
      timestamp: NOW,
      priorNodes,
    };
  }

  it("reuses unchanged nodes byte-for-byte and bumps revisions on semantic change", async () => {
    const session = makeSession();
    const { createPrdProposalRecord } = await import("../../src/proposal/records.js");
    const { makeBundle } = await import("../proposal/helpers.js");
    const bundle = makeBundle(session);
    const { record: proposal } = createPrdProposalRecord({
      session,
      revision: 1,
      draft: makeValidDraft(session),
      proposal_context_bundle: bundle,
      answers: [],
      adapter_profile_digest: "e".repeat(64),
      prompt_version_digest: "f".repeat(64),
      producer_identity: "test",
      invocation_id: "capture-invocation_01K1PROPOSAL00000000",
      conversation_id: "capture-conversation_01K1PROPOSAL00000",
      evidence_locator: "capture-evidence://proposal",
    });
    const first = buildAcceptedPrdGraph(graphContext(new Map()), proposal);
    const testNode = first.nodes.find((node) => node.type === "Test");
    expect(testNode?.revision).toBe(1);

    // Unchanged semantics: byte-identical reuse of the committed record.
    const second = buildAcceptedPrdGraph(
      graphContext(new Map(first.nodes.map((node) => [node.id, node]))),
      proposal,
    );
    const reusedTest = second.nodes.find((node) => node.type === "Test");
    expect(reusedTest).toEqual(testNode);

    // Changed semantics: same id, bumped revision, rotated digest.
    const changed = first.nodes.map((node) => {
      if (node.type !== "Test") return node;
      return {
        ...node,
        extensions: {
          "harness.requirements": {
            ...(node.extensions?.["harness.requirements"] as Record<string, unknown>),
            criterion_semantic_digest: "1".repeat(64),
          },
        },
      };
    });
    const third = buildAcceptedPrdGraph(
      graphContext(new Map(changed.map((node) => [node.id, node]))),
      proposal,
    );
    const bumped = third.nodes.find((node) => node.type === "Test");
    expect(bumped?.id).toBe(testNode?.id);
    expect(bumped?.revision).toBe(2);
    expect(bumped?.digest).not.toBe(testNode?.digest);
  });
});
