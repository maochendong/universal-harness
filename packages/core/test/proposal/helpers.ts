import { createCaptureSessionRecord } from "../../src/capture/records.js";
import type {
  CaptureSessionRecord,
  ClarificationAnswerRecord,
  ClarificationQuestionRecord,
} from "../../src/schema/capture.js";
import {
  createClarificationAnswerRecord,
  createClarificationQuestionRecords,
} from "../../src/capture/records.js";
import { contentDigest } from "../../src/identity/digest.js";
import { createProjectContextBundleRecord } from "../../src/context/records.js";
import type { ProjectContextBundleRecord, ProjectContextSource } from "../../src/schema/context.js";
import type { PrdProposalDraft } from "../../src/schema/proposal.js";
import type { PrdProposalInput } from "../../src/proposal/port.js";

export const DIGEST_A = "a".repeat(64);
export const DIGEST_B = "b".repeat(64);
export const DIGEST_C = "c".repeat(64);
export const DIGEST_D = "d".repeat(64);
export const ADAPTER_PROFILE_DIGEST = "e".repeat(64);
export const PROMPT_VERSION_DIGEST = "f".repeat(64);

export const INTENT_TEXT = "Let users export the monthly report as a CSV file.";

export function makeSession(intentText: string = INTENT_TEXT): CaptureSessionRecord {
  return createCaptureSessionRecord({
    workflow_operation_id: "operation_01K1ABCDEFGHIJKLMNO",
    iteration_id: "iteration_01K1ABCDEFGHIJKLMNO",
    intent_text: intentText,
    project_profile_digest: DIGEST_A,
    profile_decision_digest: DIGEST_B,
    capture_policy_digest: DIGEST_C,
    project_baseline_digest: DIGEST_D,
  });
}

export function makeBundle(
  session: CaptureSessionRecord,
  sources?: readonly ProjectContextSource[],
): ProjectContextBundleRecord {
  return createProjectContextBundleRecord({
    session_id: session.session_id,
    purpose: "proposal",
    project_baseline_digest: session.project_baseline_digest,
    profile_digest: session.project_profile_digest,
    policy_digest: session.capture_policy_digest,
    budget: {
      max_files: 10,
      max_bytes_per_source: 4096,
      max_total_bytes: 16384,
      max_summary_chars: 500,
    },
    sources: sources ?? [
      {
        locator: "README.md",
        source_kind: "readme",
        source_digest: contentDigest("demo readme"),
        selection_reason: "project overview",
        classification: "public_project",
        summary: "Demo reporting application.",
        truncated: false,
      },
    ],
    exclusions: [],
  });
}

export function makeQuestionAndAnswer(
  session: CaptureSessionRecord,
  answerValue: string,
): { question: ClarificationQuestionRecord; answer: ClarificationAnswerRecord } {
  const [question] = createClarificationQuestionRecords({
    session_id: session.session_id,
    round: 1,
    drafts: [
      {
        source: "deterministic_gate",
        target_kind: "requirement",
        missing_dimension: "acceptance_criteria",
        question: "Which observable behavior proves the export works?",
        required: true,
      },
    ],
  });
  if (question === undefined) throw new Error("expected one question");
  const answer = createClarificationAnswerRecord({
    session_id: session.session_id,
    question,
    answer_kind: "free_text",
    value: answerValue,
    actor: "human:tester",
    expected_session_digest: session.record_digest,
  });
  return { question, answer };
}

export function intentBinding(session: CaptureSessionRecord) {
  return {
    source_kind: "intent" as const,
    source_id: "intent",
    source_digest: session.intent_digest,
  };
}

/**
 * A draft that passes every hard gate: one must-change requirement with one
 * atomic criterion carrying a test-first example and meaningful verification.
 */
export function makeValidDraft(session: CaptureSessionRecord): PrdProposalDraft {
  const binding = intentBinding(session);
  return {
    schema_version: "1.1.0",
    intent: { text: session.intent_text, digest: session.intent_digest },
    problem_statement: "Users cannot archive monthly reports outside the application.",
    goals: [
      {
        draft_key: "goal-1",
        lineage: { kind: "new" },
        proposed_source_bindings: [binding],
        statement: "Users can export the monthly report as a CSV file.",
      },
    ],
    non_goals: [],
    actors: [],
    scenarios: [],
    requirements: [
      {
        draft_key: "req-1",
        lineage: { kind: "new" },
        proposed_source_bindings: [binding],
        statement: "The user can export the monthly report as a CSV file.",
        priority: "must",
        change_kind: "must_change",
        scenario_ids: [],
        acceptance_criterion_ids: ["criterion-1"],
      },
    ],
    constraints: [],
    acceptance_criteria: [
      {
        draft_key: "criterion-1",
        lineage: { kind: "new" },
        proposed_source_bindings: [binding],
        requirement_id: "req-1",
        precondition: "a monthly report exists for the user",
        action: "the user exports the report as CSV",
        observable_outcome: "a CSV file containing the report rows is produced",
        verification_intent: "compare the exported CSV rows with the report data",
        test_first_example:
          "given an existing report, exporting produces a CSV whose rows match the report",
        scenario_kind: "primary",
      },
    ],
    assumptions: [],
    dependencies: [],
    risks: [],
    open_questions: [],
    glossary: [],
    context_source_refs: [],
  };
}

export function makeProposalInput(
  session: CaptureSessionRecord,
  overrides?: Partial<PrdProposalInput>,
): PrdProposalInput {
  return {
    session,
    proposal_context_bundle: makeBundle(session),
    accepted_answers: [],
    profile: {
      adapter_profile_digest: ADAPTER_PROFILE_DIGEST,
      prompt_version_digest: PROMPT_VERSION_DIGEST,
      producer_identity: "test-producer",
    },
    invocation: {
      invocation_id: "capture-invocation_01K1ABCDEFGHIJKLMNO",
      conversation_id: "capture-conversation_01K1ABCDEFGHIJKLMNO",
      evidence_locator: "capture-evidence://capture-invocation_01K1ABCDEFGHIJKLMNO",
    },
    ...overrides,
  };
}
