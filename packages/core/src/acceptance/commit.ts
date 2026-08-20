import { canonicalizeJson } from "../identity/canonical-json.js";
import { contentDigest } from "../identity/digest.js";
import { domainRecordId } from "../identity/record-id.js";
import { LedgerError, LedgerRepository, type CommitHooks } from "../ledger/index.js";
import { PROTOCOL_1_1_VERSION } from "../protocol.js";
import { findPrdProposalByDigest } from "../proposal/store.js";
import { readPrdValidationReports } from "../proposal/store.js";
import { readPrdReviewReports } from "../review/store.js";
import { readCaptureRiskAssessments } from "../risk/store.js";
import type { CaptureStageHandler } from "../capture/commands.js";
import { sealRecordEnvelope } from "../schema/envelope.js";
import type { PrdProposalRecord } from "../schema/proposal.js";
import type { RequirementBaselineCriterionSeed } from "../schema/acceptance.js";
import { buildAcceptedPrdGraph, acceptedNodeArtifactPath } from "./graph.js";
import {
  createAcceptedPrdRecord,
  createRequirementBaselineRecord,
  deriveAcceptedPrdId,
} from "./records.js";
import { deriveCaptureTestSeedId } from "./test-seed.js";
import { readAcceptedGraphNodes, readAcceptedPrdRecords } from "./store.js";

/**
 * The accepted transaction (intent-to-prd design 7.5): one atomic Ledger
 * commit publishes the accepted proposal status revision, the immutable
 * AcceptedPrdRecord, the RequirementBaseline document, the Intent /
 * Requirement / Constraint / Test node artifacts and the traceability edges.
 * The Ledger manifest is the commit point: a crash before it leaves only
 * invisible staging, and a retry of the same ledger operation id is an
 * idempotent no-op. Every digest is re-verified against the committed records
 * before anything is staged, so a validation failure writes nothing.
 */
export interface CaptureAcceptanceStageDeps {
  readonly projectRoot: string;
  /** Returns the current ledger baseline commit the transaction builds on. */
  readonly readBaseline: () => string;
  /** Digest of the governing Policy bound into the accepted record. */
  readonly policy_digest: string;
  readonly now?: () => string;
  /** Ledger commit hooks; tests use them for deterministic crash injection. */
  readonly hooks?: CommitHooks;
}

function stageFailure(
  code: string,
  summary: string,
  retryable: boolean,
): { kind: "stage_failed"; failure: { code: string; summary: string; retryable: boolean } } {
  return { kind: "stage_failed", failure: { code, summary, retryable } };
}

function artifact(path: string, record: unknown): { path: string; content: string } {
  return { path, content: `${canonicalizeJson(record)}\n` };
}

export function deriveCaptureAcceptanceApprovalDigest(approval: {
  readonly request_id: string;
  readonly decision_id: string;
  readonly actor: string;
  readonly decision_digest?: string;
}): string {
  return (
    approval.decision_digest ??
    contentDigest({
      decision_id: approval.decision_id,
      request_id: approval.request_id,
      actor: approval.actor,
      decision: "approve",
    })
  );
}

export function createCaptureAcceptanceStageHandler(
  deps: CaptureAcceptanceStageDeps,
): CaptureStageHandler {
  const root = deps.projectRoot;
  const now = deps.now ?? (() => new Date().toISOString());

  return async (request) => {
    const session = request.session;
    const approval = request.approval;
    if (approval === undefined) {
      return stageFailure(
        "approval_missing",
        "the accept stage requires the consumed approval decision",
        false,
      );
    }
    if (session.current_proposal_digest === undefined) {
      return stageFailure("proposal_missing", "no current proposal digest to accept", false);
    }
    const proposal = findPrdProposalByDigest(
      root,
      session.session_id,
      session.current_proposal_digest,
    );
    if (proposal === undefined) {
      return stageFailure(
        "proposal_missing",
        "no committed proposal matches the session's current proposal digest",
        false,
      );
    }
    const validation = readPrdValidationReports(root, session.session_id).find(
      (candidate) => candidate.report_digest === session.current_validation_digest,
    );
    if (validation === undefined || validation.passed !== true) {
      return stageFailure(
        "validation_missing",
        "acceptance requires a passed validation report bound to the session",
        false,
      );
    }
    if (validation.proposal_digest !== proposal.content_digest) {
      return stageFailure(
        "binding_mismatch",
        "the validation report does not bind the accepted proposal",
        false,
      );
    }
    const review = readPrdReviewReports(root, session.session_id).find(
      (candidate) => candidate.report_digest === session.current_review_digest,
    );
    if (review === undefined || review.verdict !== "accept") {
      return stageFailure(
        "review_missing",
        "acceptance requires an accepting review report bound to the session",
        false,
      );
    }
    if (review.proposal_digest !== proposal.content_digest) {
      return stageFailure(
        "binding_mismatch",
        "the review report does not bind the accepted proposal",
        false,
      );
    }
    const risk = readCaptureRiskAssessments(root, session.session_id).find(
      (candidate) => candidate.assessment_digest === session.current_risk_assessment_digest,
    );
    if (risk === undefined) {
      return stageFailure(
        "risk_missing",
        "acceptance requires a committed risk assessment bound to the session",
        false,
      );
    }
    if (
      risk.proposal_content_digest !== proposal.content_digest ||
      risk.validation_report_digest !== validation.report_digest ||
      risk.review_report_digest !== review.report_digest
    ) {
      return stageFailure(
        "binding_mismatch",
        "the risk assessment does not bind the accepted facts",
        false,
      );
    }

    const prdId = deriveAcceptedPrdId(session.session_id);
    const approvalDigest = deriveCaptureAcceptanceApprovalDigest(approval);
    const ledgerOperationId = domainRecordId({
      domain_tag: "capture_accept_commit",
      id_prefix: "capture-accept",
      protocol_version: PROTOCOL_1_1_VERSION,
      canonical_input: {
        session_id: session.session_id,
        proposal_content_digest: proposal.content_digest,
        decision_id: approval.decision_id,
      },
    });
    const repository = new LedgerRepository({
      projectRoot: root,
      readBaseline: deps.readBaseline,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(deps.hooks === undefined ? {} : { hooks: deps.hooks }),
    });

    // Idempotent fast path: the same acceptance already committed.
    if (
      repository.operations().some((op) => op.manifest.ledger_operation_id === ledgerOperationId)
    ) {
      const committed = readAcceptedPrdRecords(root, prdId).find(
        (candidate) => candidate.proposal_content_digest === proposal.content_digest,
      );
      if (committed === undefined) {
        return stageFailure(
          "acceptance_inconsistent",
          "the ledger operation committed but its accepted PRD artifact is unreadable",
          false,
        );
      }
      return {
        kind: "acceptance_committed",
        accepted_prd_digest: committed.record_digest,
        requirement_baseline_digest: committed.requirement_baseline_digest,
      };
    }

    const priorAccepted = readAcceptedPrdRecords(root, prdId);
    const prdRevision = priorAccepted.length + 1;
    const supersedesDigest = priorAccepted.at(-1)?.record_digest;

    const priorNodes = readAcceptedGraphNodes(root);
    const graph = buildAcceptedPrdGraph(
      {
        session_id: session.session_id,
        iteration_id: session.iteration_id,
        actor: approval.actor,
        timestamp: now(),
        priorNodes,
      },
      proposal,
    );
    const testRevisionById = new Map(
      graph.nodes.filter((node) => node.type === "Test").map((node) => [node.id, node.revision]),
    );
    const seeds: RequirementBaselineCriterionSeed[] = proposal.content.acceptance_criteria.map(
      (criterion) => {
        const testId = deriveCaptureTestSeedId(criterion.criterion_id);
        const revision = testRevisionById.get(testId);
        if (revision === undefined) {
          throw new Error(`internal: no test node built for criterion ${criterion.criterion_id}`);
        }
        return {
          criterion_id: criterion.criterion_id,
          requirement_id: criterion.requirement_id,
          criterion_semantic_digest: criterion.criterion_semantic_digest,
          test_id: testId,
          test_revision: revision,
        };
      },
    );
    const baseline = createRequirementBaselineRecord({
      session,
      proposal,
      prd_revision: prdRevision,
      criterion_test_seeds: seeds,
    });
    const accepted = createAcceptedPrdRecord({
      session,
      proposal,
      revision: prdRevision,
      ...(supersedesDigest === undefined ? {} : { supersedes_digest: supersedesDigest }),
      approval_digest: approvalDigest,
      requirement_baseline_digest: baseline.record_digest,
      policy_digest: deps.policy_digest,
    });

    // The accepted proposal status revision (design 7.5 step 1): same content,
    // next revision, status accepted, superseding the reviewed proposal.
    const acceptedProposal: PrdProposalRecord = sealRecordEnvelope({
      protocol_version: proposal.protocol_version,
      record_kind: "prd_proposal" as const,
      proposal_id: proposal.proposal_id,
      session_id: proposal.session_id,
      revision: proposal.revision + 1,
      status: "accepted" as const,
      input_binding: proposal.input_binding,
      content: proposal.content,
      content_digest: proposal.content_digest,
      supersedes_digest: proposal.record_digest,
    });

    const artifacts = [
      artifact(
        `artifacts/capture/proposals/${session.session_id}/${String(acceptedProposal.revision)}.json`,
        acceptedProposal,
      ),
      artifact(`artifacts/capture/accepted/${prdId}/${String(prdRevision)}.json`, accepted),
      artifact(
        `artifacts/capture/accepted/${prdId}/baseline-${String(prdRevision)}.json`,
        baseline,
      ),
      ...graph.nodes.map((node) => artifact(acceptedNodeArtifactPath(node), node)),
    ];

    try {
      await repository.commit({
        ledger_operation_id: ledgerOperationId,
        workflow_operation_id: session.workflow_operation_id,
        attempt_id: approval.decision_id,
        expected_baseline: deps.readBaseline(),
        artifacts,
        edges: [...graph.edges],
        events: [],
      });
    } catch (error) {
      if (error instanceof LedgerError) {
        const retryable = error.kind === "ledger_conflict" || error.kind === "corruption";
        return stageFailure("acceptance_commit_failed", error.message, retryable);
      }
      throw error;
    }
    return {
      kind: "acceptance_committed",
      accepted_prd_digest: accepted.record_digest,
      requirement_baseline_digest: baseline.record_digest,
    };
  };
}
