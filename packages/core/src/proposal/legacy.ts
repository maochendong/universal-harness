import type { ClarificationOption } from "../schema/capture.js";
import type { ClarificationQuestionDraft } from "../capture/records.js";
import { canonicalizeJson } from "../identity/canonical-json.js";
import { contentDigest } from "../identity/digest.js";
import type { PrdProposalDraft, PrdProposalRecord, PrdScenarioKind } from "../schema/proposal.js";
import type { PrdProposalInput, PrdProposalPort } from "./port.js";
import { noopCaptureUxTelemetry, type CaptureUxTelemetrySink } from "./telemetry.js";

/**
 * LegacyIntentInterpreterAdapter (intent-to-prd design 17): keeps the
 * Protocol 1.0 `IntentInterpreter` usable for one major compatibility period
 * by mapping its output onto the PrdProposalPort contract. The mapping is
 * deterministic: requirements/constraints/acceptance carry over verbatim,
 * Protocol 1.1 fields the legacy interface cannot express are never guessed
 * (the hard gates turn them into typed questions), a ClarificationOffer
 * becomes typed question drafts, and `undefined` becomes the typed
 * `legacy_no_proposal` failure — never a generic wrapped requirement. The
 * legacy output still flows through the Proposal schema, the hard gates,
 * independent Review and approval; it cannot reach a RequirementBaseline
 * directly.
 */
export interface LegacyAcceptanceInput {
  readonly description: string;
  readonly verification: string;
}

export interface LegacyRequirementInput {
  readonly statement: string;
  readonly acceptance: readonly LegacyAcceptanceInput[];
}

export interface LegacyConstraintInput {
  readonly statement: string;
  readonly verification: string;
}

export interface LegacyInterpretedIntent {
  readonly requirements: readonly LegacyRequirementInput[];
  readonly constraints?: readonly LegacyConstraintInput[];
}

export interface LegacyClarificationQuestion {
  readonly subject: "intent" | "requirement" | "constraint" | "acceptance";
  readonly index?: number;
  readonly question: string;
  readonly options?: readonly string[];
}

export interface LegacyClarificationOffer {
  readonly clarification: readonly LegacyClarificationQuestion[];
}

export type LegacyIntentInterpreterResult =
  LegacyInterpretedIntent | LegacyClarificationOffer | undefined;

export type LegacyIntentInterpreter = (
  intent: string,
) => Promise<LegacyIntentInterpreterResult> | LegacyIntentInterpreterResult;

/** Typed failure code for `undefined` legacy results (design 17.2). */
export const LEGACY_NO_PROPOSAL = "legacy_no_proposal" as const;

const LEGACY_SUBJECT_TARGET_KIND = {
  intent: "intent",
  requirement: "requirement",
  constraint: "constraint",
  acceptance: "acceptance_criterion",
} as const;

function isClarificationOffer(
  result: LegacyInterpretedIntent | LegacyClarificationOffer,
): result is LegacyClarificationOffer {
  return "clarification" in result;
}

/**
 * The fixed multi-round template (design 17.2): original intent, accepted
 * answers, the controlled context summary and the previous deterministic
 * feedback, in a stable section order. Its digest goes to the invocation
 * evidence sink, never into the proposal content.
 */
export function buildLegacyTemplateInput(input: PrdProposalInput): string {
  const answers = [...input.accepted_answers]
    .sort((left, right) => (left.answer_id < right.answer_id ? -1 : 1))
    .map(
      (answer) =>
        `- (${answer.question_id}) ${canonicalizeJson(answer.value ?? null)} [${answer.answer_id}]`,
    );
  const context = input.proposal_context_bundle.sources.map(
    (source) => `- ${source.locator} (${source.source_kind}): ${source.summary}`,
  );
  const feedback = (input.deterministic_feedback?.results ?? [])
    .filter((result) => !result.passed)
    .map(
      (result) =>
        `- ${result.rule_id}: ${result.findings.map((finding) => finding.message).join("; ")}`,
    );
  return [
    "[intent]",
    input.session.intent_text,
    "",
    "[answers]",
    ...(answers.length > 0 ? answers : ["(none)"]),
    "",
    "[context]",
    ...(context.length > 0 ? context : ["(none)"]),
    "",
    "[feedback]",
    ...(feedback.length > 0 ? feedback : ["(none)"]),
    "",
  ].join("\n");
}

function mapOffer(offer: LegacyClarificationOffer): ClarificationQuestionDraft[] | undefined {
  if (offer.clarification.length === 0) return undefined;
  const drafts: ClarificationQuestionDraft[] = [];
  for (const question of offer.clarification) {
    if (question.question.trim().length === 0) return undefined;
    let options: ClarificationOption[] | undefined;
    if (question.options !== undefined) {
      if (question.options.length < 2 || question.options.length > 4) return undefined;
      options = [
        ...question.options.map((label, index) => ({
          option_id: `option-${String(index + 1)}`,
          label,
        })),
        { option_id: "other", label: "other" },
      ];
    }
    drafts.push({
      source: "proposal",
      target_kind: LEGACY_SUBJECT_TARGET_KIND[question.subject],
      ...(question.index === undefined
        ? {}
        : { target_id: `legacy-${question.subject}-${String(question.index)}` }),
      missing_dimension: "legacy_clarification",
      question: question.question,
      ...(options === undefined ? {} : { options }),
      required: true,
    });
  }
  return drafts;
}

/** NFC, unified newlines, trimmed — the Coordinator canonical text form. */
function normalizeLegacyText(value: string): string {
  return value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
}

/**
 * Criterion draft identity (intent-to-prd design 6.4/6.5, provable TDD
 * design 7.1): a criterion's draft key is derived from its semantic content
 * — the same business fields `criterionSemanticDigest` covers, with the
 * parent requirement statement standing in for the canonical requirement id
 * the adapter cannot know — never from its position, so inserting,
 * removing or reordering unrelated criteria never rotates an unchanged
 * criterion's identity.
 */
interface LegacyCriterionSemantics {
  readonly requirement_statement: string;
  readonly precondition: string;
  readonly action: string;
  readonly observable_outcome: string;
  readonly verification_intent: string;
  readonly test_first_example: string | null;
  readonly scenario_kind: PrdScenarioKind;
}

function legacyCriterionSignature(semantics: LegacyCriterionSemantics): string {
  return contentDigest({
    requirement_statement: semantics.requirement_statement,
    precondition: semantics.precondition,
    action: semantics.action,
    observable_outcome: semantics.observable_outcome,
    verification_intent: semantics.verification_intent,
    test_first_example: semantics.test_first_example,
    scenario_kind: semantics.scenario_kind,
  });
}

/**
 * Prior-revision criteria indexed by legacy semantic signature, for
 * `continues` lineage: an unchanged criterion reclaims its canonical id, so
 * a new proposal revision never re-mints it. Exact semantic twins are
 * claimed one per prior criterion; a prior criterion whose semantics the
 * legacy interface cannot express (non-empty precondition, distinct
 * outcome, a test-first example) simply never matches.
 */
function previousCriterionClaims(previous: PrdProposalRecord | undefined): Map<string, string[]> {
  const claims = new Map<string, string[]>();
  if (previous === undefined) return claims;
  const requirementStatements = new Map(
    previous.content.requirements.map((requirement) => [requirement.id, requirement.statement]),
  );
  for (const criterion of previous.content.acceptance_criteria) {
    const requirementStatement = requirementStatements.get(criterion.requirement_id);
    if (requirementStatement === undefined) continue;
    const signature = legacyCriterionSignature({
      requirement_statement: requirementStatement,
      precondition: criterion.precondition,
      action: criterion.action,
      observable_outcome: criterion.observable_outcome,
      verification_intent: criterion.verification_intent,
      test_first_example: criterion.test_first_example ?? null,
      scenario_kind: criterion.scenario_kind,
    });
    claims.set(signature, [...(claims.get(signature) ?? []), criterion.criterion_id]);
  }
  return claims;
}

function mapInterpretedIntent(
  intent: LegacyInterpretedIntent,
  input: PrdProposalInput,
): PrdProposalDraft {
  const binding = {
    source_kind: "intent" as const,
    source_id: "intent",
    source_digest: input.session.intent_digest,
  };
  const claims = previousCriterionClaims(input.previous_proposal);
  const usedSignatures = new Map<string, number>();
  const mapped = intent.requirements.map((requirement, requirementIndex) => {
    const requirementKey = `requirement-${String(requirementIndex + 1)}`;
    const requirementSemantics = {
      requirement_statement: normalizeLegacyText(requirement.statement),
      precondition: "",
      test_first_example: null,
      scenario_kind: "primary" as const,
    };
    const criteria = requirement.acceptance.map((criterion) => {
      const signature = legacyCriterionSignature({
        ...requirementSemantics,
        action: normalizeLegacyText(criterion.description),
        observable_outcome: normalizeLegacyText(criterion.description),
        verification_intent: normalizeLegacyText(criterion.verification),
      });
      // Exact semantic twins are indistinguishable, so only the occurrence
      // order among twins disambiguates their draft keys (design 6.4).
      const occurrence = (usedSignatures.get(signature) ?? 0) + 1;
      usedSignatures.set(signature, occurrence);
      const draftKey =
        occurrence === 1
          ? `criterion-${signature}`
          : `criterion-${signature}-${String(occurrence)}`;
      const continued = claims.get(signature)?.shift();
      return {
        draft_key: draftKey,
        lineage:
          continued === undefined
            ? { kind: "new" as const }
            : { kind: "continues" as const, previous_entity_id: continued },
        proposed_source_bindings: [binding],
        requirement_id: requirementKey,
        precondition: "",
        action: criterion.description,
        observable_outcome: criterion.description,
        verification_intent: criterion.verification,
        scenario_kind: "primary" as const,
      };
    });
    return {
      requirement: {
        draft_key: requirementKey,
        lineage: { kind: "new" as const },
        proposed_source_bindings: [binding],
        statement: requirement.statement,
        priority: "must" as const,
        change_kind: "must_change" as const,
        scenario_ids: [],
        acceptance_criterion_ids: criteria.map((criterion) => criterion.draft_key),
      },
      criteria,
    };
  });
  const constraints = (intent.constraints ?? []).map((constraint, constraintIndex) => ({
    draft_key: `constraint-${String(constraintIndex + 1)}`,
    lineage: { kind: "new" as const },
    proposed_source_bindings: [binding],
    statement: constraint.statement,
    category: "technical" as const,
    verification_intent: constraint.verification,
  }));
  return {
    schema_version: "1.1.0",
    intent: { text: input.session.intent_text, digest: input.session.intent_digest },
    problem_statement: "",
    goals: [],
    non_goals: [],
    actors: [],
    scenarios: [],
    requirements: mapped.map((entry) => entry.requirement),
    constraints,
    acceptance_criteria: mapped.flatMap((entry) => entry.criteria),
    assumptions: [],
    dependencies: [],
    risks: [],
    open_questions: [],
    glossary: [],
    context_source_refs: [],
  };
}

export function createLegacyIntentInterpreterAdapter(options: {
  readonly interpreter: LegacyIntentInterpreter;
  readonly telemetry?: CaptureUxTelemetrySink;
  /** Receives the fixed template input digest (design 17.2 invocation Evidence). */
  readonly onTemplateInput?: (templateDigest: string) => void;
}): PrdProposalPort {
  const telemetry = options.telemetry ?? noopCaptureUxTelemetry;
  return {
    name: "legacy-intent-interpreter",
    async propose(input) {
      telemetry({
        kind: "legacy_interpreter_invoked",
        session_id: input.session.session_id,
        round: input.session.round,
        metrics: { deprecated: 1 },
      });
      const template = buildLegacyTemplateInput(input);
      options.onTemplateInput?.(contentDigest(template));
      let result: LegacyIntentInterpreterResult;
      try {
        result = await options.interpreter(template);
      } catch {
        return {
          status: "failed",
          failure: {
            code: "provider_unavailable",
            retryable: true,
            summary: "legacy interpreter invocation failed",
          },
        };
      }
      if (result === undefined) {
        return {
          status: "failed",
          failure: {
            code: LEGACY_NO_PROPOSAL,
            retryable: false,
            summary:
              "legacy interpreter returned no proposal; switch to the Manual adapter or configure capture.proposal",
          },
        };
      }
      if (isClarificationOffer(result)) {
        const questions = mapOffer(result);
        if (questions === undefined) {
          return {
            status: "failed",
            failure: {
              code: "invalid_output",
              retryable: false,
              summary: "legacy clarification offer is malformed",
            },
          };
        }
        return { status: "clarification_required", questions };
      }
      if (!Array.isArray(result.requirements)) {
        return {
          status: "failed",
          failure: {
            code: "invalid_output",
            retryable: false,
            summary: "legacy interpreted intent is malformed",
          },
        };
      }
      return { status: "proposed", draft: mapInterpretedIntent(result, input) };
    },
  };
}

/** Configuration error: the new and legacy proposal slots are exclusive. */
export class CaptureConfigurationError extends Error {
  readonly kind = "configuration_error" as const;

  constructor(message: string) {
    super(message);
    this.name = "CaptureConfigurationError";
  }
}

/**
 * Compatibility resolution (design 17.1): `capture.proposal` and the legacy
 * `interpret` option must never be configured together — there is no implicit
 * priority. With only the legacy interpreter, the adapter bridge is returned
 * and marked deprecated; with neither, no model adapter is returned and the
 * Manual path is the default.
 */
export function resolveCaptureProposalAdapter(config: {
  readonly proposal?: PrdProposalPort;
  readonly interpret?: LegacyIntentInterpreter;
  readonly telemetry?: CaptureUxTelemetrySink;
}): { readonly adapter?: PrdProposalPort; readonly deprecated_legacy: boolean } {
  if (config.proposal !== undefined && config.interpret !== undefined) {
    throw new CaptureConfigurationError(
      "capture.proposal and the legacy interpret option cannot be configured together; remove one (no implicit priority is applied)",
    );
  }
  if (config.interpret !== undefined) {
    return {
      adapter: createLegacyIntentInterpreterAdapter({
        interpreter: config.interpret,
        ...(config.telemetry === undefined ? {} : { telemetry: config.telemetry }),
      }),
      deprecated_legacy: true,
    };
  }
  return {
    ...(config.proposal === undefined ? {} : { adapter: config.proposal }),
    deprecated_legacy: false,
  };
}
