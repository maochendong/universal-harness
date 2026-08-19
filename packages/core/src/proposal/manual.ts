import { intentDigestOf } from "../capture/records.js";
import type { ClarificationQuestionDraft } from "../capture/records.js";
import { canonicalizeJson } from "../identity/canonical-json.js";
import type { CaptureQuestionTargetKind } from "../schema/capture.js";
import type { PrdProposalDraft } from "../schema/proposal.js";
import type { PrdProposalInput, PrdProposalPort } from "./port.js";
import { noopCaptureUxTelemetry, type CaptureUxTelemetrySink } from "./telemetry.js";

/**
 * ManualPrdProposalAdapter (intent-to-prd design 9.3): the default proposal
 * path when no model is configured. It owns no semantics — it builds a form
 * model that puts context prefill first, then the diff against the previous
 * proposal (changed intent, answers since the proposal, gate findings), then
 * the items the hard gates would still flag, and hands it to the injected
 * completion seam (CLI/Dashboard). The human's completed draft goes through
 * the same Coordinator validation as any model output.
 */
export interface ManualContextHint {
  readonly locator: string;
  readonly summary: string;
}

export interface ManualMissingItem {
  readonly target_kind: CaptureQuestionTargetKind;
  readonly target_id?: string;
  readonly missing_dimension: string;
  readonly message: string;
}

export interface ManualProposalDiff {
  readonly previous_proposal_digest: string;
  readonly intent_changed: boolean;
  readonly answers_since_proposal: readonly {
    readonly question_id: string;
    readonly answer_id: string;
  }[];
  readonly gate_findings: readonly {
    readonly rule_id: string;
    readonly target_kind: string;
    readonly target_id?: string;
  }[];
}

export interface ManualProposalForm {
  readonly session_id: string;
  readonly round: number;
  readonly intent_text: string;
  readonly context_hints: readonly ManualContextHint[];
  readonly prefill: PrdProposalDraft;
  readonly diff: ManualProposalDiff | null;
  readonly missing: readonly ManualMissingItem[];
}

const DRAFT_SECTIONS = [
  "goals",
  "non_goals",
  "actors",
  "scenarios",
  "requirements",
  "constraints",
  "acceptance_criteria",
  "assumptions",
  "dependencies",
  "risks",
  "open_questions",
  "glossary",
] as const;

function prefillFromPrevious(input: PrdProposalInput): PrdProposalDraft {
  const previous = input.previous_proposal;
  if (previous === undefined) {
    return {
      schema_version: "1.1.0",
      intent: { text: input.session.intent_text, digest: input.session.intent_digest },
      // The human's own words are the honest starting point, not a guess.
      problem_statement: input.session.intent_text,
      goals: [],
      non_goals: [],
      actors: [],
      scenarios: [],
      requirements: [],
      constraints: [],
      acceptance_criteria: [],
      assumptions: [],
      dependencies: [],
      risks: [],
      open_questions: [],
      glossary: [],
      context_source_refs: [],
    };
  }
  const content = previous.content;
  const lineage = (id: string) => ({ kind: "continues" as const, previous_entity_id: id });
  return {
    schema_version: "1.1.0",
    intent: { text: input.session.intent_text, digest: input.session.intent_digest },
    problem_statement: content.problem_statement,
    goals: content.goals.map((entity) => ({
      draft_key: entity.id,
      lineage: lineage(entity.id),
      proposed_source_bindings: entity.source_bindings,
      statement: entity.statement,
    })),
    non_goals: content.non_goals.map((entity) => ({
      draft_key: entity.id,
      lineage: lineage(entity.id),
      proposed_source_bindings: entity.source_bindings,
      statement: entity.statement,
    })),
    actors: content.actors.map((entity) => ({
      draft_key: entity.id,
      lineage: lineage(entity.id),
      proposed_source_bindings: entity.source_bindings,
      name: entity.name,
      description: entity.description,
    })),
    scenarios: content.scenarios.map((entity) => ({
      draft_key: entity.id,
      lineage: lineage(entity.id),
      proposed_source_bindings: entity.source_bindings,
      actor_id: entity.actor_id,
      precondition: entity.precondition,
      action: entity.action,
      observable_outcome: entity.observable_outcome,
      scenario_kind: entity.scenario_kind,
    })),
    requirements: content.requirements.map((entity) => ({
      draft_key: entity.id,
      lineage: lineage(entity.id),
      proposed_source_bindings: entity.source_bindings,
      statement: entity.statement,
      priority: entity.priority,
      change_kind: entity.change_kind,
      scenario_ids: entity.scenario_ids,
      acceptance_criterion_ids: entity.acceptance_criterion_ids,
    })),
    constraints: content.constraints.map((entity) => ({
      draft_key: entity.id,
      lineage: lineage(entity.id),
      proposed_source_bindings: entity.source_bindings,
      statement: entity.statement,
      category: entity.category,
      verification_intent: entity.verification_intent,
    })),
    acceptance_criteria: content.acceptance_criteria.map((entity) => ({
      draft_key: entity.criterion_id,
      lineage: lineage(entity.criterion_id),
      proposed_source_bindings: entity.source_bindings,
      requirement_id: entity.requirement_id,
      precondition: entity.precondition,
      action: entity.action,
      observable_outcome: entity.observable_outcome,
      verification_intent: entity.verification_intent,
      ...(entity.test_first_example === undefined
        ? {}
        : { test_first_example: entity.test_first_example }),
      scenario_kind: entity.scenario_kind,
    })),
    assumptions: content.assumptions.map((entity) => ({
      draft_key: entity.id,
      lineage: lineage(entity.id),
      proposed_source_bindings: entity.source_bindings,
      statement: entity.statement,
    })),
    dependencies: content.dependencies.map((entity) => ({
      draft_key: entity.id,
      lineage: lineage(entity.id),
      proposed_source_bindings: entity.source_bindings,
      dependency_kind: entity.dependency_kind,
      description: entity.description,
      required_by_ids: entity.required_by_ids,
    })),
    risks: content.risks.map((entity) => ({
      draft_key: entity.id,
      lineage: lineage(entity.id),
      proposed_source_bindings: entity.source_bindings,
      category: entity.category,
      description: entity.description,
      likelihood: entity.likelihood,
      impact: entity.impact,
      mitigation: entity.mitigation,
    })),
    open_questions: content.open_questions.map((entity) => ({
      draft_key: entity.id,
      lineage: lineage(entity.id),
      proposed_source_bindings: entity.source_bindings,
      question: entity.question,
      blocking: entity.blocking,
      owner: entity.owner,
    })),
    glossary: content.glossary.map((entity) => ({
      draft_key: entity.id,
      lineage: lineage(entity.id),
      proposed_source_bindings: entity.source_bindings,
      term: entity.term,
      definition: entity.definition,
    })),
    context_source_refs: content.context_source_refs,
  };
}

function missingItems(prefill: PrdProposalDraft): ManualMissingItem[] {
  const items: ManualMissingItem[] = [];
  if (prefill.problem_statement.trim().length === 0) {
    items.push({
      target_kind: "prd_section",
      missing_dimension: "problem_statement",
      message: "the problem statement is missing",
    });
  }
  if (prefill.goals.length === 0) {
    items.push({
      target_kind: "prd_section",
      missing_dimension: "goals",
      message: "at least one goal is required",
    });
  }
  if (prefill.requirements.length === 0) {
    items.push({
      target_kind: "prd_section",
      missing_dimension: "requirements",
      message: "at least one requirement is required",
    });
  }
  for (const requirement of prefill.requirements) {
    const criteria = prefill.acceptance_criteria.filter(
      (criterion) => criterion.requirement_id === requirement.draft_key,
    );
    if (criteria.length === 0) {
      items.push({
        target_kind: "requirement",
        target_id: requirement.draft_key,
        missing_dimension: "acceptance_criteria",
        message: "this requirement has no acceptance criterion yet",
      });
    } else if (
      requirement.change_kind === "must_change" &&
      !criteria.some((criterion) => (criterion.test_first_example ?? "").trim().length > 0)
    ) {
      items.push({
        target_kind: "requirement",
        target_id: requirement.draft_key,
        missing_dimension: "test_first_example",
        message: "this must-change requirement has no test-first example yet",
      });
    }
  }
  for (const constraint of prefill.constraints) {
    if (constraint.verification_intent.trim().length === 0) {
      items.push({
        target_kind: "constraint",
        target_id: constraint.draft_key,
        missing_dimension: "verification_intent",
        message: "this constraint has no verification intent yet",
      });
    }
  }
  return items;
}

function buildDiff(input: PrdProposalInput): ManualProposalDiff | null {
  const previous = input.previous_proposal;
  if (previous === undefined) return null;
  const referencedAnswers = new Set(
    [
      ...previous.content.goals,
      ...previous.content.non_goals,
      ...previous.content.actors,
      ...previous.content.scenarios,
      ...previous.content.requirements,
      ...previous.content.constraints,
      ...previous.content.assumptions,
      ...previous.content.dependencies,
      ...previous.content.risks,
      ...previous.content.open_questions,
      ...previous.content.glossary,
      ...previous.content.acceptance_criteria,
    ].flatMap((entity) =>
      entity.source_bindings
        .filter((binding) => binding.source_kind === "clarification_answer")
        .map((binding) => binding.source_id),
    ),
  );
  const answersSince = input.accepted_answers
    .filter((answer) => !referencedAnswers.has(answer.answer_id))
    .map((answer) => ({ question_id: answer.question_id, answer_id: answer.answer_id }))
    .sort((left, right) => (left.answer_id < right.answer_id ? -1 : 1));
  const gateFindings = (input.deterministic_feedback?.results ?? [])
    .flatMap((result) =>
      result.findings.map((finding) => ({
        rule_id: result.rule_id,
        target_kind: finding.target_kind,
        ...(finding.target_id === undefined ? {} : { target_id: finding.target_id }),
      })),
    )
    .sort((left, right) =>
      `${left.rule_id}${left.target_id ?? ""}` < `${right.rule_id}${right.target_id ?? ""}`
        ? -1
        : 1,
    );
  return {
    previous_proposal_digest: previous.content_digest,
    intent_changed: intentDigestOf(input.session.intent_text) !== previous.content.intent.digest,
    answers_since_proposal: answersSince,
    gate_findings: gateFindings,
  };
}

export function buildManualProposalForm(input: PrdProposalInput): ManualProposalForm {
  const prefill = prefillFromPrevious(input);
  return {
    session_id: input.session.session_id,
    round: input.session.round,
    intent_text: input.session.intent_text,
    context_hints: input.proposal_context_bundle.sources.map((source) => ({
      locator: source.locator,
      summary: source.summary,
    })),
    prefill,
    diff: buildDiff(input),
    missing: missingItems(prefill),
  };
}

export type ManualProposalCompletion =
  | { readonly kind: "draft"; readonly draft: PrdProposalDraft }
  | { readonly kind: "clarify"; readonly questions: readonly ClarificationQuestionDraft[] };

function prefilledFieldCount(prefill: PrdProposalDraft): number {
  let count = prefill.problem_statement.trim().length > 0 ? 1 : 0;
  for (const section of DRAFT_SECTIONS) {
    if (prefill[section].length > 0) count += 1;
  }
  return count;
}

function editedFieldCount(prefill: PrdProposalDraft, draft: PrdProposalDraft): number {
  let count = prefill.problem_statement === draft.problem_statement ? 0 : 1;
  for (const section of DRAFT_SECTIONS) {
    if (canonicalizeJson(prefill[section]) !== canonicalizeJson(draft[section])) count += 1;
  }
  return count;
}

export function createManualPrdProposalAdapter(options: {
  readonly complete: (
    form: ManualProposalForm,
  ) => ManualProposalCompletion | Promise<ManualProposalCompletion>;
  readonly telemetry?: CaptureUxTelemetrySink;
}): PrdProposalPort {
  const telemetry = options.telemetry ?? noopCaptureUxTelemetry;
  return {
    name: "manual",
    async propose(input) {
      const form = buildManualProposalForm(input);
      telemetry({
        kind: "manual_form_presented",
        session_id: input.session.session_id,
        round: input.session.round,
        metrics: {
          prefilled_field_count: prefilledFieldCount(form.prefill),
          missing_field_count: form.missing.length,
          context_hint_count: form.context_hints.length,
        },
      });
      let completion: ManualProposalCompletion;
      try {
        completion = await options.complete(form);
      } catch {
        // The completion seam is UI; a throw is sanitized into the typed
        // failure contract, never propagated with raw UI internals.
        return {
          status: "failed",
          failure: {
            code: "uncertain",
            retryable: true,
            summary: "manual form completion failed",
          },
        };
      }
      if (completion.kind === "clarify") {
        return { status: "clarification_required", questions: completion.questions };
      }
      telemetry({
        kind: "manual_form_completed",
        session_id: input.session.session_id,
        round: input.session.round,
        metrics: { edited_field_count: editedFieldCount(form.prefill, completion.draft) },
      });
      return { status: "proposed", draft: completion.draft };
    },
  };
}
