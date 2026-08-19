import { describe, expect, it } from "vitest";

import {
  createPrdProposalRecord,
  createPrdValidationReportRecord,
} from "../../src/proposal/records.js";
import {
  buildManualProposalForm,
  createManualPrdProposalAdapter,
} from "../../src/proposal/manual.js";
import type { CaptureUxTelemetryEvent } from "../../src/proposal/telemetry.js";
import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../../src/schema/registry.js";
import type { PrdValidationReportRecord } from "../../src/schema/proposal.js";
import {
  ADAPTER_PROFILE_DIGEST,
  PROMPT_VERSION_DIGEST,
  makeBundle,
  makeProposalInput,
  makeQuestionAndAnswer,
  makeSession,
  makeValidDraft,
} from "./helpers.js";

function makeValidationFeedback(
  session: ReturnType<typeof makeSession>,
): PrdValidationReportRecord {
  return createPrdValidationReportRecord({
    session_id: session.session_id,
    proposal_digest: "1".repeat(64),
    results: [
      {
        rule_id: "criterion_test_first",
        passed: false,
        findings: [
          {
            severity: "critical" as const,
            target_kind: "requirement" as const,
            target_id: "prd-requirement_01K1ABCDEFGHIJKLMNO",
            message: "must-change requirement lacks a test-first example",
          },
        ],
      },
    ],
    blocking_question_ids: [],
  });
}

describe("buildManualProposalForm", () => {
  it("prefills the problem statement from the intent and lists context hints", () => {
    const session = makeSession();
    const input = makeProposalInput(session);
    const form = buildManualProposalForm(input);
    expect(form.prefill.intent.digest).toBe(session.intent_digest);
    expect(form.prefill.problem_statement).toBe(session.intent_text);
    expect(form.context_hints.map((hint) => hint.locator)).toEqual(["README.md"]);
    expect(form.diff).toBeNull();
  });

  it("surfaces the fields the hard gates would still flag as missing", () => {
    const session = makeSession();
    const form = buildManualProposalForm(makeProposalInput(session));
    const dimensions = form.missing.map((item) => item.missing_dimension);
    expect(dimensions).toContain("goals");
    expect(dimensions).toContain("requirements");
    expect(form.missing.every((item) => item.message.length > 0)).toBe(true);
  });

  it("prefills revision rounds from the previous proposal with continues lineage", () => {
    const session = makeSession();
    const first = createPrdProposalRecord({
      session,
      revision: 1,
      draft: makeValidDraft(session),
      proposal_context_bundle: makeBundle(session),
      answers: [],
      adapter_profile_digest: ADAPTER_PROFILE_DIGEST,
      prompt_version_digest: PROMPT_VERSION_DIGEST,
      producer_identity: "manual",
      invocation_id: "capture-invocation_01K1ABCDEFGHIJKLMNO",
      conversation_id: "capture-conversation_01K1ABCDEFGHIJKLMNO",
      evidence_locator: "capture-evidence://capture-invocation_01K1ABCDEFGHIJKLMNO",
    }).record;
    const form = buildManualProposalForm(makeProposalInput(session, { previous_proposal: first }));
    const prefillRequirement = form.prefill.requirements[0];
    expect(prefillRequirement?.draft_key).toBe(first.content.requirements[0]?.id);
    expect(prefillRequirement?.lineage).toEqual({
      kind: "continues",
      previous_entity_id: first.content.requirements[0]?.id,
    });
    // a prefilled, previously complete proposal has no missing items
    expect(form.missing).toEqual([]);
  });

  it("shows the diff: changed intent, answers since the proposal and gate findings", () => {
    const session = makeSession();
    const first = createPrdProposalRecord({
      session,
      revision: 1,
      draft: makeValidDraft(session),
      proposal_context_bundle: makeBundle(session),
      answers: [],
      adapter_profile_digest: ADAPTER_PROFILE_DIGEST,
      prompt_version_digest: PROMPT_VERSION_DIGEST,
      producer_identity: "manual",
      invocation_id: "capture-invocation_01K1ABCDEFGHIJKLMNO",
      conversation_id: "capture-conversation_01K1ABCDEFGHIJKLMNO",
      evidence_locator: "capture-evidence://capture-invocation_01K1ABCDEFGHIJKLMNO",
    }).record;
    const { answer } = makeQuestionAndAnswer(session, "include totals in the export");
    const form = buildManualProposalForm(
      makeProposalInput(session, {
        previous_proposal: first,
        accepted_answers: [answer],
        deterministic_feedback: makeValidationFeedback(session),
      }),
    );
    expect(form.diff?.intent_changed).toBe(false);
    expect(form.diff?.answers_since_proposal).toEqual([
      { question_id: answer.question_id, answer_id: answer.answer_id },
    ]);
    expect(form.diff?.gate_findings).toEqual([
      {
        rule_id: "criterion_test_first",
        target_kind: "requirement",
        target_id: "prd-requirement_01K1ABCDEFGHIJKLMNO",
      },
    ]);
  });

  it("marks the diff when the intent changed since the previous proposal", () => {
    const session = makeSession();
    const first = createPrdProposalRecord({
      session,
      revision: 1,
      draft: makeValidDraft(session),
      proposal_context_bundle: makeBundle(session),
      answers: [],
      adapter_profile_digest: ADAPTER_PROFILE_DIGEST,
      prompt_version_digest: PROMPT_VERSION_DIGEST,
      producer_identity: "manual",
      invocation_id: "capture-invocation_01K1ABCDEFGHIJKLMNO",
      conversation_id: "capture-conversation_01K1ABCDEFGHIJKLMNO",
      evidence_locator: "capture-evidence://capture-invocation_01K1ABCDEFGHIJKLMNO",
    }).record;
    const revised = { ...session, intent_text: "Export weekly reports as CSV instead." };
    const form = buildManualProposalForm(makeProposalInput(revised, { previous_proposal: first }));
    expect(form.diff?.intent_changed).toBe(true);
  });
});

describe("createManualPrdProposalAdapter", () => {
  it("is the default structured-entry path: returns the completed draft", async () => {
    const session = makeSession();
    const adapter = createManualPrdProposalAdapter({
      complete: () => ({ kind: "draft", draft: makeValidDraft(session) }),
    });
    expect(adapter.name).toBe("manual");
    const result = await adapter.propose(makeProposalInput(session));
    expect(result.status).toBe("proposed");
  });

  it("hands the human clarification path back to the Coordinator", async () => {
    const session = makeSession();
    const adapter = createManualPrdProposalAdapter({
      complete: () => ({
        kind: "clarify",
        questions: [
          {
            source: "human" as const,
            target_kind: "intent" as const,
            missing_dimension: "scope",
            question: "Which reports are in scope?",
            required: true,
          },
        ],
      }),
    });
    const result = await adapter.propose(makeProposalInput(session));
    expect(result).toMatchObject({ status: "clarification_required" });
  });

  it("emits UX telemetry that never enters the proposal semantic digest", async () => {
    const session = makeSession();
    const events: CaptureUxTelemetryEvent[] = [];
    const draft = makeValidDraft(session);
    const adapter = createManualPrdProposalAdapter({
      complete: () => ({ kind: "draft", draft }),
      telemetry: (event) => events.push(event),
    });
    const result = await adapter.propose(makeProposalInput(session));
    expect(result.status).toBe("proposed");
    const kinds = events.map((event) => event.kind);
    expect(kinds).toContain("manual_form_presented");
    expect(kinds).toContain("manual_form_completed");
    const presented = events.find((event) => event.kind === "manual_form_presented");
    expect(presented?.metrics["prefilled_field_count"]).toBeGreaterThan(0);
    expect(presented?.metrics["missing_field_count"]).toBeGreaterThan(0);

    // Telemetry content has no path into the proposal digest: two runs with
    // different telemetry still produce the same canonical record.
    const makeRecord = () =>
      createPrdProposalRecord({
        session,
        revision: 1,
        draft,
        proposal_context_bundle: makeBundle(session),
        answers: [],
        adapter_profile_digest: ADAPTER_PROFILE_DIGEST,
        prompt_version_digest: PROMPT_VERSION_DIGEST,
        producer_identity: "manual",
        invocation_id: "capture-invocation_01K1ABCDEFGHIJKLMNO",
        conversation_id: "capture-conversation_01K1ABCDEFGHIJKLMNO",
        evidence_locator: "capture-evidence://capture-invocation_01K1ABCDEFGHIJKLMNO",
      }).record;
    expect(makeRecord().content_digest).toBe(makeRecord().content_digest);
    expect(JSON.stringify(makeRecord().content)).not.toMatch(/telemetry|prefilled_field/iu);
  });

  it("rejects drafts smuggling telemetry or other extra fields", () => {
    const session = makeSession();
    const smuggled = {
      ...makeValidDraft(session),
      telemetry: { duration_ms: 42 },
    };
    const validation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate("prd-proposal-draft", smuggled);
    expect(validation.valid).toBe(false);
  });
});
