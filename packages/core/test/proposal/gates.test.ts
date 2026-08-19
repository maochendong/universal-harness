import { describe, expect, it } from "vitest";

import { createPrdProposalRecord } from "../../src/proposal/records.js";
import { runPrdHardGates, prdValidationRuleSetDigest } from "../../src/proposal/gates.js";
import type { PrdProposal, PrdProposalDraft } from "../../src/schema/proposal.js";
import {
  ADAPTER_PROFILE_DIGEST,
  PROMPT_VERSION_DIGEST,
  makeBundle,
  makeSession,
  makeValidDraft,
} from "./helpers.js";

function proposalOf(draft: PrdProposalDraft, session = makeSession()): PrdProposal {
  return createPrdProposalRecord({
    session,
    revision: 1,
    draft,
    proposal_context_bundle: makeBundle(session),
    answers: [],
    adapter_profile_digest: ADAPTER_PROFILE_DIGEST,
    prompt_version_digest: PROMPT_VERSION_DIGEST,
    producer_identity: "test-producer",
    invocation_id: "capture-invocation_01K1ABCDEFGHIJKLMNO",
    conversation_id: "capture-conversation_01K1ABCDEFGHIJKLMNO",
    evidence_locator: "capture-evidence://capture-invocation_01K1ABCDEFGHIJKLMNO",
  }).record.content;
}

describe("runPrdHardGates", () => {
  it("exposes a versioned rule set with a stable digest", () => {
    expect(prdValidationRuleSetDigest()).toMatch(/^[a-f0-9]{64}$/u);
    expect(prdValidationRuleSetDigest()).toBe(prdValidationRuleSetDigest());
  });

  it("passes a complete proposal with zero critical findings", () => {
    const outcome = runPrdHardGates(proposalOf(makeValidDraft(makeSession())));
    expect(outcome.passed).toBe(true);
    expect(outcome.questions).toEqual([]);
    expect(outcome.results.every((result) => result.passed)).toBe(true);
  });

  it("requires a problem statement, at least one goal and one requirement", () => {
    const session = makeSession();
    const draft: PrdProposalDraft = {
      ...makeValidDraft(session),
      problem_statement: "   ",
      goals: [],
      requirements: [],
      acceptance_criteria: [],
    };
    const outcome = runPrdHardGates(proposalOf(draft, session));
    expect(outcome.passed).toBe(false);
    const rule = outcome.results.find((result) => result.rule_id === "required_sections");
    expect(rule?.passed).toBe(false);
    const targets = outcome.questions.map((question) => question.missing_dimension);
    expect(targets).toContain("problem_statement");
    expect(targets).toContain("goals");
    expect(targets).toContain("requirements");
    for (const question of outcome.questions) {
      expect(question.source).toBe("deterministic_gate");
      expect(question.required).toBe(true);
    }
  });

  it("requires every requirement to have at least one acceptance criterion", () => {
    const session = makeSession();
    const draft = makeValidDraft(session);
    const outcome = runPrdHardGates(
      proposalOf(
        {
          ...draft,
          requirements: draft.requirements.map((requirement) => ({
            ...requirement,
            acceptance_criterion_ids: [],
          })),
          acceptance_criteria: [],
        },
        session,
      ),
    );
    expect(outcome.passed).toBe(false);
    const rule = outcome.results.find((result) => result.rule_id === "requirement_criteria");
    expect(rule?.passed).toBe(false);
    const question = outcome.questions.find(
      (candidate) => candidate.missing_dimension === "acceptance_criteria",
    );
    expect(question?.target_kind).toBe("requirement");
    expect(question?.target_id).toBeTruthy();
  });

  it("requires a test-first example on every must-change requirement", () => {
    const session = makeSession();
    const draft = makeValidDraft(session);
    const outcome = runPrdHardGates(
      proposalOf(
        {
          ...draft,
          acceptance_criteria: draft.acceptance_criteria.map((criterion) => {
            const copy = { ...criterion };
            Reflect.deleteProperty(copy, "test_first_example");
            return copy;
          }),
        },
        session,
      ),
    );
    expect(outcome.passed).toBe(false);
    const rule = outcome.results.find((result) => result.rule_id === "criterion_test_first");
    expect(rule?.passed).toBe(false);
    expect(
      outcome.questions.some((question) => question.missing_dimension === "test_first_example"),
    ).toBe(true);
  });

  it("requires a verification intent on every constraint", () => {
    const session = makeSession();
    const draft = makeValidDraft(session);
    const outcome = runPrdHardGates(
      proposalOf(
        {
          ...draft,
          constraints: [
            {
              draft_key: "constraint-1",
              lineage: { kind: "new" },
              proposed_source_bindings: [
                {
                  source_kind: "intent" as const,
                  source_id: "intent",
                  source_digest: session.intent_digest,
                },
              ],
              statement: "Exports must complete within the monthly batch window.",
              category: "operational" as const,
              verification_intent: "  ",
            },
          ],
        },
        session,
      ),
    );
    expect(outcome.passed).toBe(false);
    expect(
      outcome.results.find((result) => result.rule_id === "constraint_verification")?.passed,
    ).toBe(false);
  });

  it("flags structured conflicts between requirements and non-goals", () => {
    const session = makeSession();
    const draft = makeValidDraft(session);
    const requirement = draft.requirements[0]!;
    const outcome = runPrdHardGates(
      proposalOf(
        {
          ...draft,
          non_goals: [
            {
              draft_key: "non-goal-1",
              lineage: { kind: "new" },
              proposed_source_bindings: requirement.proposed_source_bindings,
              statement: requirement.statement,
            },
          ],
        },
        session,
      ),
    );
    expect(outcome.passed).toBe(false);
    const rule = outcome.results.find((result) => result.rule_id === "structural_conflict");
    expect(rule?.passed).toBe(false);
    expect(
      outcome.questions.some((question) => question.missing_dimension === "requirement_conflict"),
    ).toBe(true);
  });

  it("flags glossary terms with conflicting definitions", () => {
    const session = makeSession();
    const draft = makeValidDraft(session);
    const binding = draft.goals[0]!.proposed_source_bindings;
    const outcome = runPrdHardGates(
      proposalOf(
        {
          ...draft,
          glossary: [
            {
              draft_key: "term-1",
              lineage: { kind: "new" },
              proposed_source_bindings: binding,
              term: "report",
              definition: "a monthly summary",
            },
            {
              draft_key: "term-2",
              lineage: { kind: "new" },
              proposed_source_bindings: binding,
              term: "Report",
              definition: "an annual statement",
            },
          ],
        },
        session,
      ),
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.questions.some((question) => question.target_kind === "glossary")).toBe(true);
  });

  it("rejects blocking open questions", () => {
    const session = makeSession();
    const draft = makeValidDraft(session);
    const outcome = runPrdHardGates(
      proposalOf(
        {
          ...draft,
          open_questions: [
            {
              draft_key: "open-1",
              lineage: { kind: "new" },
              proposed_source_bindings: draft.goals[0]!.proposed_source_bindings,
              question: "Which column separator must the CSV use?",
              blocking: true,
              owner: "product",
            },
          ],
        },
        session,
      ),
    );
    expect(outcome.passed).toBe(false);
    expect(
      outcome.results.find((result) => result.rule_id === "open_question_blocking")?.passed,
    ).toBe(false);
    expect(
      outcome.questions.some((question) => question.missing_dimension === "blocking_open_question"),
    ).toBe(true);
  });

  it("flags vague outcomes and test-pass-only verification as not test-first-ready", () => {
    const session = makeSession();
    const draft = makeValidDraft(session);
    const outcome = runPrdHardGates(
      proposalOf(
        {
          ...draft,
          requirements: draft.requirements.map((requirement) => ({
            ...requirement,
            statement: "The export should be faster and more user-friendly.",
          })),
          acceptance_criteria: draft.acceptance_criteria.map((criterion) => ({
            ...criterion,
            observable_outcome: "the export feels faster",
            verification_intent: "tests pass",
          })),
        },
        session,
      ),
    );
    expect(outcome.passed).toBe(false);
    expect(
      outcome.results.find((result) => result.rule_id === "test_first_readiness")?.passed,
    ).toBe(false);
    const dimensions = outcome.questions.map((question) => question.missing_dimension);
    expect(dimensions).toContain("observable_outcome");
    expect(dimensions).toContain("verification_intent");
  });

  it("requires non-atomic criteria to be split instead of left to Planner 1:N mapping", () => {
    const session = makeSession();
    const draft = makeValidDraft(session);
    const outcome = runPrdHardGates(
      proposalOf(
        {
          ...draft,
          acceptance_criteria: draft.acceptance_criteria.map((criterion) => ({
            ...criterion,
            observable_outcome:
              "a CSV file containing the report rows is produced; the user receives a download notification",
          })),
        },
        session,
      ),
    );
    expect(outcome.passed).toBe(false);
    const rule = outcome.results.find((result) => result.rule_id === "atomic_criterion");
    expect(rule?.passed).toBe(false);
    const question = outcome.questions.find(
      (candidate) => candidate.missing_dimension === "atomicity",
    );
    expect(question?.target_kind).toBe("acceptance_criterion");
    expect(question?.question).toMatch(/split/iu);
  });

  it("flags duplicate criteria that cannot be distinguished", () => {
    const session = makeSession();
    const draft = makeValidDraft(session);
    const criterion = draft.acceptance_criteria[0]!;
    const outcome = runPrdHardGates(
      proposalOf(
        {
          ...draft,
          requirements: draft.requirements.map((requirement) => ({
            ...requirement,
            acceptance_criterion_ids: ["criterion-1", "criterion-2"],
          })),
          acceptance_criteria: [criterion, { ...criterion, draft_key: "criterion-2" }],
        },
        session,
      ),
    );
    expect(outcome.passed).toBe(false);
    expect(
      outcome.questions.some((question) => question.missing_dimension === "duplicate_criteria"),
    ).toBe(true);
  });

  it("requires a non-primary scenario for high-risk requirements", () => {
    const session = makeSession();
    const draft = makeValidDraft(session);
    const outcome = runPrdHardGates(
      proposalOf(
        {
          ...draft,
          requirements: draft.requirements.map((requirement) => ({
            ...requirement,
            statement: "The user can delete a stored payment method.",
          })),
        },
        session,
      ),
    );
    expect(outcome.passed).toBe(false);
    expect(
      outcome.results.find((result) => result.rule_id === "risk_scenario_coverage")?.passed,
    ).toBe(false);
    expect(
      outcome.questions.some((question) => question.missing_dimension === "failure_scenario"),
    ).toBe(true);
  });

  it("produces deterministic, canonically ordered results and questions", () => {
    const session = makeSession();
    const draft = makeValidDraft(session);
    const messy = proposalOf(
      {
        ...draft,
        problem_statement: " ",
        open_questions: [
          {
            draft_key: "open-1",
            lineage: { kind: "new" },
            proposed_source_bindings: draft.goals[0]!.proposed_source_bindings,
            question: "Separator?",
            blocking: true,
            owner: "product",
          },
        ],
      },
      session,
    );
    const first = runPrdHardGates(messy);
    const second = runPrdHardGates(messy);
    expect(second).toEqual(first);
    const ruleIds = first.results.map((result) => result.rule_id);
    expect(ruleIds).toEqual([...ruleIds].sort());
  });
});
