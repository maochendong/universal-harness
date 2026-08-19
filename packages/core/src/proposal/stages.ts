import { createClarificationQuestionRecords } from "../capture/records.js";
import type { CaptureStageHandler } from "../capture/commands.js";
import { readProjectContextBundles } from "../context/store.js";
import { domainRecordId } from "../identity/record-id.js";
import { PROTOCOL_1_1_VERSION } from "../protocol.js";
import type { PrdProposalPort } from "./port.js";
import { runPrdHardGates } from "./gates.js";
import {
  ProposalRecordError,
  createPrdProposalRecord,
  createPrdValidationReportRecord,
} from "./records.js";
import {
  appendPrdEntityLineageRecord,
  appendPrdProposalRecord,
  appendPrdValidationReportRecord,
  findPrdProposalByDigest,
  readPrdProposalRevisions,
  readPrdValidationReports,
} from "./store.js";

/**
 * Coordinator stage wiring (intent-to-prd design 9, 12): wraps a
 * PrdProposalPort into the `proposing` and `validating` stage handlers. The
 * propose handler builds the port input from committed facts only, runs the
 * adapter, then canonicalizes the draft — Coordinator-issued ids, lineage
 * verification, source binding checks and criterion digest recomputation —
 * before persisting the proposal and its lineage records. The validate
 * handler runs the deterministic hard gates and persists the versioned
 * validation report; gates always run before any reviewer is called.
 */
export interface CaptureProposalStageDeps {
  readonly projectRoot: string;
  readonly proposal: PrdProposalPort;
  readonly adapter_profile: {
    readonly adapter_profile_digest: string;
    readonly prompt_version_digest: string;
    readonly producer_identity: string;
  };
}

function stageFailure(
  code: string,
  summary: string,
  retryable: boolean,
): { kind: "stage_failed"; failure: { code: string; summary: string; retryable: boolean } } {
  return { kind: "stage_failed", failure: { code, summary, retryable } };
}

export function createCaptureProposalStageHandlers(deps: CaptureProposalStageDeps): {
  readonly propose: CaptureStageHandler;
  readonly validate: CaptureStageHandler;
} {
  const root = deps.projectRoot;

  const propose: CaptureStageHandler = async (request) => {
    const session = request.session;
    const invocation = request.invocation;
    if (invocation === undefined) {
      return stageFailure(
        "invocation_missing",
        "the proposing stage requires a committed invocation record",
        false,
      );
    }
    const bundle = readProjectContextBundles(root).find(
      (candidate) =>
        candidate.session_id === session.session_id &&
        candidate.purpose === "proposal" &&
        candidate.content_digest === session.proposal_context_bundle_digest,
    );
    if (bundle === undefined) {
      return stageFailure(
        "context_bundle_missing",
        "no committed proposal-purpose context bundle matches the session binding",
        false,
      );
    }
    const priorProposals = readPrdProposalRevisions(root, session.session_id);
    const previousProposal = priorProposals.at(-1);
    const feedback = readPrdValidationReports(root, session.session_id).at(-1);
    const result = await deps.proposal.propose({
      session,
      proposal_context_bundle: bundle,
      accepted_answers: request.answers ?? [],
      ...(previousProposal === undefined ? {} : { previous_proposal: previousProposal }),
      ...(feedback === undefined ? {} : { deterministic_feedback: feedback }),
      profile: deps.adapter_profile,
      invocation: {
        invocation_id: invocation.invocation_id,
        conversation_id: domainRecordId({
          domain_tag: "capture_conversation",
          id_prefix: "capture-conversation",
          protocol_version: PROTOCOL_1_1_VERSION,
          canonical_input: { invocation_id: invocation.invocation_id },
        }),
        evidence_locator: `capture-evidence://${invocation.invocation_id}`,
      },
    });
    if (result.status === "failed") {
      return stageFailure(result.failure.code, result.failure.summary, result.failure.retryable);
    }
    if (result.status === "clarification_required") {
      return { kind: "clarification_required", questions: result.questions };
    }
    try {
      const { record, lineage } = createPrdProposalRecord({
        session,
        revision: priorProposals.length + 1,
        draft: result.draft,
        proposal_context_bundle: bundle,
        answers: request.answers ?? [],
        ...(previousProposal === undefined ? {} : { previous_proposal: previousProposal }),
        adapter_profile_digest: deps.adapter_profile.adapter_profile_digest,
        prompt_version_digest: deps.adapter_profile.prompt_version_digest,
        producer_identity: deps.adapter_profile.producer_identity,
        invocation_id: invocation.invocation_id,
        conversation_id: domainRecordId({
          domain_tag: "capture_conversation",
          id_prefix: "capture-conversation",
          protocol_version: PROTOCOL_1_1_VERSION,
          canonical_input: { invocation_id: invocation.invocation_id },
        }),
        evidence_locator: `capture-evidence://${invocation.invocation_id}`,
      });
      appendPrdProposalRecord(root, record);
      for (const entry of lineage) {
        appendPrdEntityLineageRecord(root, entry);
      }
      return { kind: "proposal_ready", proposal_digest: record.content_digest };
    } catch (error) {
      if (error instanceof ProposalRecordError) {
        return stageFailure("proposal_invalid", error.message, true);
      }
      throw error;
    }
  };

  const validate: CaptureStageHandler = (request) => {
    const session = request.session;
    if (session.current_proposal_digest === undefined) {
      return stageFailure(
        "proposal_missing",
        "the validating stage requires a current proposal digest",
        false,
      );
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
    const outcome = runPrdHardGates(proposal.content);
    // Question identity is deterministic given (session, round, drafts), so
    // the report can name exactly the questions the Coordinator will issue.
    const questionRecords =
      outcome.questions.length === 0
        ? []
        : createClarificationQuestionRecords({
            session_id: session.session_id,
            round: session.round + 1,
            drafts: outcome.questions,
          });
    const report = createPrdValidationReportRecord({
      session_id: session.session_id,
      proposal_digest: proposal.content_digest,
      results: outcome.results,
      blocking_question_ids: questionRecords.map((question) => question.question_id),
    });
    appendPrdValidationReportRecord(root, report);
    if (outcome.passed) {
      return { kind: "validation_passed", validation_digest: report.report_digest };
    }
    return { kind: "clarification_required", questions: outcome.questions };
  };

  return { propose, validate };
}
