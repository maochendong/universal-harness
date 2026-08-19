import type { ClarificationOption } from "../schema/capture.js";
import type { ClarificationQuestionDraft } from "../capture/records.js";
import { canonicalizeJson } from "../identity/canonical-json.js";
import { contentDigest } from "../identity/digest.js";
import type { PrdProposalDraft } from "../schema/proposal.js";
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

function mapInterpretedIntent(
  intent: LegacyInterpretedIntent,
  input: PrdProposalInput,
): PrdProposalDraft {
  const binding = {
    source_kind: "intent" as const,
    source_id: "intent",
    source_digest: input.session.intent_digest,
  };
  const requirements = intent.requirements.map((requirement, requirementIndex) => ({
    draft_key: `requirement-${String(requirementIndex + 1)}`,
    lineage: { kind: "new" as const },
    proposed_source_bindings: [binding],
    statement: requirement.statement,
    priority: "must" as const,
    change_kind: "must_change" as const,
    scenario_ids: [],
    acceptance_criterion_ids: requirement.acceptance.map(
      (_criterion, criterionIndex) =>
        `criterion-${String(requirementIndex + 1)}-${String(criterionIndex + 1)}`,
    ),
  }));
  const criteria = intent.requirements.flatMap((requirement, requirementIndex) =>
    requirement.acceptance.map((criterion, criterionIndex) => ({
      draft_key: `criterion-${String(requirementIndex + 1)}-${String(criterionIndex + 1)}`,
      lineage: { kind: "new" as const },
      proposed_source_bindings: [binding],
      requirement_id: `requirement-${String(requirementIndex + 1)}`,
      precondition: "",
      action: criterion.description,
      observable_outcome: criterion.description,
      verification_intent: criterion.verification,
      scenario_kind: "primary" as const,
    })),
  );
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
    requirements,
    constraints,
    acceptance_criteria: criteria,
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
