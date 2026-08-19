import { describe, expect, it } from "vitest";

import { criterionSemanticDigest } from "../../src/proposal/digest.js";
import { createPrdProposalRecord, ProposalRecordError } from "../../src/proposal/records.js";
import type { PrdProposalDraft } from "../../src/schema/proposal.js";
import {
  ADAPTER_PROFILE_DIGEST,
  PROMPT_VERSION_DIGEST,
  makeBundle,
  makeQuestionAndAnswer,
  makeSession,
  makeValidDraft,
  intentBinding,
} from "./helpers.js";

function createRecord(
  draft: PrdProposalDraft,
  options?: {
    session?: ReturnType<typeof makeSession>;
    revision?: number;
    previous?: ReturnType<typeof createPrdProposalRecord>["record"];
  },
) {
  const session = options?.session ?? makeSession();
  return createPrdProposalRecord({
    session,
    revision: options?.revision ?? 1,
    draft,
    proposal_context_bundle: makeBundle(session),
    answers: [],
    ...(options?.previous === undefined ? {} : { previous_proposal: options.previous }),
    adapter_profile_digest: ADAPTER_PROFILE_DIGEST,
    prompt_version_digest: PROMPT_VERSION_DIGEST,
    producer_identity: "test-producer",
    invocation_id: "capture-invocation_01K1ABCDEFGHIJKLMNO",
    conversation_id: "capture-conversation_01K1ABCDEFGHIJKLMNO",
    evidence_locator: "capture-evidence://capture-invocation_01K1ABCDEFGHIJKLMNO",
  });
}

describe("createPrdProposalRecord", () => {
  it("mints Coordinator-owned entity ids and never trusts adapter ids", () => {
    const session = makeSession();
    const { record } = createRecord(makeValidDraft(session), { session });
    const requirement = record.content.requirements[0];
    const criterion = record.content.acceptance_criteria[0];
    expect(requirement?.id).toMatch(/^prd-requirement_[A-Za-z0-9_-]+$/u);
    expect(criterion?.criterion_id).toMatch(/^prd-criterion_[A-Za-z0-9_-]+$/u);
    // draft keys never leak through as canonical ids
    expect(requirement?.id).not.toBe("req-1");
    expect(criterion?.criterion_id).not.toBe("criterion-1");
    // references resolve to canonical ids
    expect(criterion?.requirement_id).toBe(requirement?.id);
    expect(requirement?.acceptance_criterion_ids).toEqual([criterion?.criterion_id]);
  });

  it("binds the session, bundle, answers and invocation in the input binding", () => {
    const session = makeSession();
    const bundle = makeBundle(session);
    const { answer } = makeQuestionAndAnswer(session, "the export must include totals");
    const { record } = createPrdProposalRecord({
      session,
      revision: 1,
      draft: makeValidDraft(session),
      proposal_context_bundle: bundle,
      answers: [answer],
      adapter_profile_digest: ADAPTER_PROFILE_DIGEST,
      prompt_version_digest: PROMPT_VERSION_DIGEST,
      producer_identity: "test-producer",
      invocation_id: "capture-invocation_01K1ABCDEFGHIJKLMNO",
      conversation_id: "capture-conversation_01K1ABCDEFGHIJKLMNO",
      evidence_locator: "capture-evidence://capture-invocation_01K1ABCDEFGHIJKLMNO",
    });
    expect(record.input_binding.session_digest).toBe(session.record_digest);
    expect(record.input_binding.proposal_context_bundle_digest).toBe(bundle.content_digest);
    expect(record.input_binding.answers_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(record.input_binding.invocation_id).toBe("capture-invocation_01K1ABCDEFGHIJKLMNO");
    expect(record.status).toBe("proposed");
  });

  it("is deterministic: the same draft yields the same record and stable revision", () => {
    const session = makeSession();
    const first = createRecord(makeValidDraft(session), { session });
    const second = createRecord(makeValidDraft(session), { session });
    expect(second.record).toEqual(first.record);
    expect(first.record.revision).toBe(1);
    expect(first.record.proposal_id).toMatch(/^prd-proposal_[A-Za-z0-9_-]+$/u);
    const third = createRecord(makeValidDraft(session), { session, revision: 2 });
    expect(third.record.proposal_id).toBe(first.record.proposal_id);
    expect(third.record.revision).toBe(2);
    expect(third.record.record_digest).not.toBe(first.record.record_digest);
  });

  it("canonically orders collections so draft ordering never changes the digest", () => {
    const session = makeSession();
    const draft = makeValidDraft(session);
    const scrambled: PrdProposalDraft = {
      ...draft,
      goals: [...draft.goals].reverse(),
      requirements: [...draft.requirements].reverse(),
      acceptance_criteria: [...draft.acceptance_criteria].reverse(),
    };
    expect(createRecord(scrambled, { session }).record.content_digest).toBe(
      createRecord(draft, { session }).record.content_digest,
    );
  });

  it("recomputes the criterion semantic digest and records it on the criterion", () => {
    const session = makeSession();
    const { record } = createRecord(makeValidDraft(session), { session });
    const criterion = record.content.acceptance_criteria[0];
    expect(criterion?.criterion_semantic_digest).toBe(
      criterionSemanticDigest({
        requirement_id: criterion?.requirement_id ?? "",
        precondition: criterion?.precondition ?? "",
        action: criterion?.action ?? "",
        observable_outcome: criterion?.observable_outcome ?? "",
        verification_intent: criterion?.verification_intent ?? "",
        test_first_example: criterion?.test_first_example ?? "",
        scenario_kind: criterion?.scenario_kind ?? "primary",
      }),
    );
  });

  it("rejects an adapter-carried criterion digest that does not match recomputation", () => {
    const session = makeSession();
    const draft = makeValidDraft(session);
    const tampered: PrdProposalDraft = {
      ...draft,
      acceptance_criteria: draft.acceptance_criteria.map((criterion) => ({
        ...criterion,
        criterion_semantic_digest: "0".repeat(64),
      })),
    };
    expect(() => createRecord(tampered, { session })).toThrowError(ProposalRecordError);
    try {
      createRecord(tampered, { session });
      expect.unreachable();
    } catch (error) {
      expect((error as ProposalRecordError).kind).toBe("digest_mismatch");
    }
  });

  it("accepts an adapter-carried criterion digest that matches recomputation", () => {
    const session = makeSession();
    const draft = makeValidDraft(session);
    // The adapter cannot know the minted requirement id; the digest it may
    // carry is over the draft-side reference, so the honest path is to omit
    // it. A matching recomputed value must still be accepted.
    const probe = createRecord(draft, { session });
    const criterion = probe.record.content.acceptance_criteria[0];
    const carried: PrdProposalDraft = {
      ...draft,
      acceptance_criteria: draft.acceptance_criteria.map((candidate) => ({
        ...candidate,
        criterion_semantic_digest: criterionSemanticDigest({
          requirement_id: criterion?.requirement_id ?? "",
          precondition: candidate.precondition,
          action: candidate.action,
          observable_outcome: candidate.observable_outcome,
          verification_intent: candidate.verification_intent,
          ...(candidate.test_first_example === undefined
            ? {}
            : { test_first_example: candidate.test_first_example }),
          scenario_kind: candidate.scenario_kind,
        }),
      })),
    };
    expect(createRecord(carried, { session }).record.content_digest).toBe(
      probe.record.content_digest,
    );
  });

  it("reuses the previous entity id for continues lineage and emits lineage records", () => {
    const session = makeSession();
    const first = createRecord(makeValidDraft(session), { session });
    const previousRequirement = first.record.content.requirements[0];
    const previousCriterion = first.record.content.acceptance_criteria[0];
    const round2: PrdProposalDraft = {
      ...makeValidDraft(session),
      requirements: [
        {
          ...makeValidDraft(session).requirements[0]!,
          lineage: { kind: "continues", previous_entity_id: previousRequirement!.id },
          acceptance_criterion_ids: [previousCriterion!.criterion_id],
        },
      ],
      acceptance_criteria: [
        {
          ...makeValidDraft(session).acceptance_criteria[0]!,
          lineage: { kind: "continues", previous_entity_id: previousCriterion!.criterion_id },
          requirement_id: previousRequirement!.id,
        },
      ],
    };
    const second = createRecord(round2, {
      session,
      revision: 2,
      previous: first.record,
    });
    expect(second.record.content.requirements[0]?.id).toBe(previousRequirement?.id);
    expect(second.record.content.acceptance_criteria[0]?.criterion_id).toBe(
      previousCriterion?.criterion_id,
    );
    expect(second.record.supersedes_digest).toBe(first.record.record_digest);
    // stable semantic digest across the source-only revision
    expect(second.record.content.acceptance_criteria[0]?.criterion_semantic_digest).toBe(
      previousCriterion?.criterion_semantic_digest,
    );
    const lineage = second.lineage.map((entry) => `${entry.entity_kind}:${entry.lineage_kind}`);
    expect(lineage).toContain("requirement:continues");
    expect(lineage).toContain("acceptance_criterion:continues");
    expect(lineage).toContain("goal:new");
  });

  it("rejects continues lineage for an unknown previous entity", () => {
    const session = makeSession();
    const draft = makeValidDraft(session);
    const bad: PrdProposalDraft = {
      ...draft,
      goals: draft.goals.map((goal) => ({
        ...goal,
        lineage: { kind: "continues", previous_entity_id: "prd-goal_01K1UNKNOWN" },
      })),
    };
    expect(() => createRecord(bad, { session })).toThrowError(ProposalRecordError);
    expect(() => createRecord(bad, { session })).toThrowError(/unknown previous entity/iu);
  });

  it("rejects continues lineage across kinds and double claims", () => {
    const session = makeSession();
    const first = createRecord(makeValidDraft(session), { session });
    const previousRequirement = first.record.content.requirements[0]!;
    const crossKind: PrdProposalDraft = {
      ...makeValidDraft(session),
      goals: [
        {
          ...makeValidDraft(session).goals[0]!,
          lineage: { kind: "continues", previous_entity_id: previousRequirement.id },
        },
      ],
    };
    expect(() =>
      createRecord(crossKind, { session, revision: 2, previous: first.record }),
    ).toThrowError(/kind/iu);

    const base = makeValidDraft(session);
    const doubleClaim: PrdProposalDraft = {
      ...base,
      goals: [
        {
          ...base.goals[0]!,
          lineage: { kind: "continues", previous_entity_id: previousRequirement.id },
        },
      ],
      requirements: base.requirements.map((requirement) => ({
        ...requirement,
        lineage: { kind: "continues" as const, previous_entity_id: previousRequirement.id },
      })),
    };
    expect(() =>
      createRecord(doubleClaim, { session, revision: 2, previous: first.record }),
    ).toThrowError(ProposalRecordError);
  });

  it("rejects dangling and cross-kind references inside the draft", () => {
    const session = makeSession();
    const draft = makeValidDraft(session);
    const dangling: PrdProposalDraft = {
      ...draft,
      requirements: draft.requirements.map((requirement) => ({
        ...requirement,
        acceptance_criterion_ids: ["criterion-missing"],
      })),
    };
    expect(() => createRecord(dangling, { session })).toThrowError(/dangling/iu);

    const crossKind: PrdProposalDraft = {
      ...draft,
      requirements: draft.requirements.map((requirement) => ({
        ...requirement,
        acceptance_criterion_ids: ["goal-1"],
      })),
    };
    expect(() => createRecord(crossKind, { session })).toThrowError(/kind/iu);
  });

  it("rejects drafts whose intent does not match the session intent", () => {
    const session = makeSession();
    const draft = makeValidDraft(session);
    const other = makeSession("A different intent entirely.");
    const mismatched: PrdProposalDraft = {
      ...draft,
      intent: { text: other.intent_text, digest: other.intent_digest },
    };
    expect(() => createRecord(mismatched, { session })).toThrowError(/intent/iu);
  });

  it("verifies answer source bindings against the committed answers", () => {
    const session = makeSession();
    const { answer } = makeQuestionAndAnswer(session, "the export must include totals");
    const draft = makeValidDraft(session);
    const bound: PrdProposalDraft = {
      ...draft,
      goals: draft.goals.map((goal) => ({
        ...goal,
        proposed_source_bindings: [
          intentBinding(session),
          {
            source_kind: "clarification_answer" as const,
            source_id: answer.answer_id,
            source_digest: answer.record_digest,
          },
        ],
      })),
    };
    expect(
      createPrdProposalRecord({
        session,
        revision: 1,
        draft: bound,
        proposal_context_bundle: makeBundle(session),
        answers: [answer],
        adapter_profile_digest: ADAPTER_PROFILE_DIGEST,
        prompt_version_digest: PROMPT_VERSION_DIGEST,
        producer_identity: "test-producer",
        invocation_id: "capture-invocation_01K1ABCDEFGHIJKLMNO",
        conversation_id: "capture-conversation_01K1ABCDEFGHIJKLMNO",
        evidence_locator: "capture-evidence://capture-invocation_01K1ABCDEFGHIJKLMNO",
      }).record.content.goals[0]?.source_bindings.map((binding) => binding.source_kind),
    ).toEqual(["clarification_answer", "intent"]);

    const forged: PrdProposalDraft = {
      ...draft,
      goals: draft.goals.map((goal) => ({
        ...goal,
        proposed_source_bindings: [
          {
            source_kind: "clarification_answer" as const,
            source_id: answer.answer_id,
            source_digest: "0".repeat(64),
          },
        ],
      })),
    };
    expect(() =>
      createPrdProposalRecord({
        session,
        revision: 1,
        draft: forged,
        proposal_context_bundle: makeBundle(session),
        answers: [answer],
        adapter_profile_digest: ADAPTER_PROFILE_DIGEST,
        prompt_version_digest: PROMPT_VERSION_DIGEST,
        producer_identity: "test-producer",
        invocation_id: "capture-invocation_01K1ABCDEFGHIJKLMNO",
        conversation_id: "capture-conversation_01K1ABCDEFGHIJKLMNO",
        evidence_locator: "capture-evidence://capture-invocation_01K1ABCDEFGHIJKLMNO",
      }),
    ).toThrowError(/source binding/iu);
  });

  it("requires at least one source binding per entity", () => {
    const session = makeSession();
    const draft = makeValidDraft(session);
    const unbound: PrdProposalDraft = {
      ...draft,
      goals: draft.goals.map((goal) => ({ ...goal, proposed_source_bindings: [] })),
    };
    expect(() => createRecord(unbound, { session })).toThrowError(ProposalRecordError);
  });

  it("rejects drafts carrying canonical-looking ids instead of draft keys", () => {
    const session = makeSession();
    const draft = makeValidDraft(session) as unknown as Record<string, unknown>;
    const forged = {
      ...draft,
      goals: draft.goals?.map((goal) => ({ ...(goal as object), id: "prd-goal_forged" })),
    };
    expect(() => createRecord(forged as PrdProposalDraft, { session })).toThrowError(
      ProposalRecordError,
    );
  });

  it("rejects duplicate draft keys", () => {
    const session = makeSession();
    const draft = makeValidDraft(session);
    const duplicated: PrdProposalDraft = {
      ...draft,
      non_goals: draft.goals.map((goal) => ({ ...goal })),
    };
    expect(() => createRecord(duplicated, { session })).toThrowError(/draft_key/iu);
  });
});
