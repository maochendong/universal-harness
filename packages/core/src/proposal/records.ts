import { canonicalStringSet } from "../identity/canonical-set.js";
import { contentDigest } from "../identity/digest.js";
import { domainRecordId } from "../identity/record-id.js";
import { PROTOCOL_1_1_VERSION } from "../protocol.js";
import type { CaptureSessionRecord, ClarificationAnswerRecord } from "../schema/capture.js";
import type { ProjectContextBundleRecord } from "../schema/context.js";
import { sealRecordEnvelope } from "../schema/envelope.js";
import {
  PRD_ENTITY_KINDS,
  PRD_PROPOSAL_SCHEMA_VERSION,
  type PrdAcceptanceCriterion,
  type PrdEntityKind,
  type PrdEntityLineageRecord,
  type PrdLineageKind,
  type PrdProposal,
  type PrdProposalDraft,
  type PrdProposalRecord,
  type PrdSourceBinding,
  type PrdValidationReportRecord,
  type PrdValidationRuleResult,
} from "../schema/proposal.js";
import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../schema/registry.js";
import { intentDigestOf } from "../capture/records.js";
import { criterionSemanticDigest, prdProposalContentDigest } from "./digest.js";
import { PRD_VALIDATION_RULE_SET } from "./gates.js";

/**
 * Canonicalization from adapter draft to authoritative proposal (intent-to-prd
 * design 6.4/6.5). The Coordinator — never the adapter — mints or reuses
 * entity ids, resolves draft-key references, verifies lineage claims and
 * source bindings against committed facts, recomputes every criterion
 * semantic digest and canonicalizes ordering before sealing the record. An
 * adapter-carried digest that disagrees with recomputation is a deterministic
 * rejection, not a warning.
 */
export class ProposalRecordError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "ProposalRecordError";
    this.kind = kind;
  }
}

const ENTITY_ID_PREFIX: Readonly<Record<PrdEntityKind, string>> = {
  goal: "prd-goal",
  non_goal: "prd-non-goal",
  actor: "prd-actor",
  scenario: "prd-scenario",
  requirement: "prd-requirement",
  constraint: "prd-constraint",
  acceptance_criterion: "prd-criterion",
  assumption: "prd-assumption",
  dependency: "prd-dependency",
  risk: "prd-risk",
  open_question: "prd-open-question",
  glossary_term: "prd-glossary-term",
};

function normalizeText(value: string): string {
  return value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeText(value);
  return normalized.length === 0 ? undefined : normalized;
}

function canonicalBindings(bindings: readonly PrdSourceBinding[]): PrdSourceBinding[] {
  const unique = new Map<string, PrdSourceBinding>();
  for (const binding of bindings) {
    unique.set(
      `${binding.source_kind}\u001f${binding.source_id}\u001f${binding.source_digest}`,
      binding,
    );
  }
  return [...unique.values()].sort((left, right) => {
    const leftKey = `${left.source_kind}\u001f${left.source_id}`;
    const rightKey = `${right.source_kind}\u001f${right.source_id}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function byId<T extends { readonly id: string }>(entities: readonly T[]): T[] {
  return [...entities].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}

function byCriterionId(entities: readonly PrdAcceptanceCriterion[]): PrdAcceptanceCriterion[] {
  return [...entities].sort((left, right) =>
    left.criterion_id < right.criterion_id ? -1 : left.criterion_id > right.criterion_id ? 1 : 0,
  );
}

interface DraftEntityRef {
  readonly kind: PrdEntityKind;
  readonly draft_key: string;
  readonly lineage: PrdProposalDraft["goals"][number]["lineage"];
  readonly proposed_source_bindings: readonly PrdSourceBinding[];
}

function draftEntities(draft: PrdProposalDraft): DraftEntityRef[] {
  return [
    ...draft.goals.map((entity) => ({ kind: "goal" as const, ...entity })),
    ...draft.non_goals.map((entity) => ({ kind: "non_goal" as const, ...entity })),
    ...draft.actors.map((entity) => ({ kind: "actor" as const, ...entity })),
    ...draft.scenarios.map((entity) => ({ kind: "scenario" as const, ...entity })),
    ...draft.requirements.map((entity) => ({ kind: "requirement" as const, ...entity })),
    ...draft.constraints.map((entity) => ({ kind: "constraint" as const, ...entity })),
    ...draft.acceptance_criteria.map((entity) => ({
      kind: "acceptance_criterion" as const,
      ...entity,
    })),
    ...draft.assumptions.map((entity) => ({ kind: "assumption" as const, ...entity })),
    ...draft.dependencies.map((entity) => ({ kind: "dependency" as const, ...entity })),
    ...draft.risks.map((entity) => ({ kind: "risk" as const, ...entity })),
    ...draft.open_questions.map((entity) => ({ kind: "open_question" as const, ...entity })),
    ...draft.glossary.map((entity) => ({ kind: "glossary_term" as const, ...entity })),
  ];
}

/** kind → canonical entity ids of a previous proposal. */
function previousEntityIndex(
  previous: PrdProposalRecord | undefined,
): Map<PrdEntityKind, Set<string>> {
  const index = new Map<PrdEntityKind, Set<string>>();
  for (const kind of PRD_ENTITY_KINDS) index.set(kind, new Set());
  if (previous === undefined) return index;
  const content = previous.content;
  const add = (kind: PrdEntityKind, ids: readonly string[]) => {
    const set = index.get(kind);
    for (const id of ids) set?.add(id);
  };
  add(
    "goal",
    content.goals.map((entity) => entity.id),
  );
  add(
    "non_goal",
    content.non_goals.map((entity) => entity.id),
  );
  add(
    "actor",
    content.actors.map((entity) => entity.id),
  );
  add(
    "scenario",
    content.scenarios.map((entity) => entity.id),
  );
  add(
    "requirement",
    content.requirements.map((entity) => entity.id),
  );
  add(
    "constraint",
    content.constraints.map((entity) => entity.id),
  );
  add(
    "acceptance_criterion",
    content.acceptance_criteria.map((entity) => entity.criterion_id),
  );
  add(
    "assumption",
    content.assumptions.map((entity) => entity.id),
  );
  add(
    "dependency",
    content.dependencies.map((entity) => entity.id),
  );
  add(
    "risk",
    content.risks.map((entity) => entity.id),
  );
  add(
    "open_question",
    content.open_questions.map((entity) => entity.id),
  );
  add(
    "glossary_term",
    content.glossary.map((entity) => entity.id),
  );
  return index;
}

export interface CreatePrdProposalInput {
  readonly session: CaptureSessionRecord;
  /** 1-based proposal round of the session; drives identity minting. */
  readonly revision: number;
  readonly draft: PrdProposalDraft;
  readonly proposal_context_bundle: ProjectContextBundleRecord;
  readonly answers: readonly ClarificationAnswerRecord[];
  readonly previous_proposal?: PrdProposalRecord;
  readonly adapter_profile_digest: string;
  readonly prompt_version_digest: string;
  readonly producer_identity: string;
  readonly invocation_id: string;
  readonly conversation_id: string;
  readonly evidence_locator: string;
}

function verifySourceBinding(binding: PrdSourceBinding, input: CreatePrdProposalInput): void {
  const invalid = (detail: string): never => {
    throw new ProposalRecordError(
      "invalid_source_binding",
      `source binding ${binding.source_kind}:${binding.source_id} is not verifiable: ${detail}`,
    );
  };
  switch (binding.source_kind) {
    case "intent":
      if (binding.source_id !== "intent" || binding.source_digest !== input.session.intent_digest) {
        invalid("the binding must reference the session intent digest");
      }
      return;
    case "clarification_answer": {
      const answer = input.answers.find(
        (candidate) =>
          candidate.answer_id === binding.source_id &&
          candidate.record_digest === binding.source_digest,
      );
      if (answer === undefined) {
        invalid("no committed answer matches the id and digest");
      }
      return;
    }
    case "project_context": {
      const source = input.proposal_context_bundle.sources.find(
        (candidate) =>
          candidate.locator === binding.source_id &&
          candidate.source_digest === binding.source_digest,
      );
      if (source === undefined) {
        invalid("no source in the proposal context bundle matches the locator and digest");
      }
      return;
    }
    case "accepted_prd": {
      const previous = input.previous_proposal;
      if (
        previous === undefined ||
        binding.source_id !== previous.proposal_id ||
        binding.source_digest !== previous.content_digest
      ) {
        invalid("the binding must reference the previous proposal of this session");
      }
      return;
    }
    case "validation_finding":
    case "review_finding":
      // Finding id/digest registries arrive with Review (T7); the schema
      // already pins the digest format.
      return;
  }
}

/**
 * Resolve one draft-side reference: a draft key of the expected kind in this
 * draft, or a canonical id of the same kind in the previous proposal.
 * Dangling and cross-kind references are deterministic rejections.
 */
function resolveReference(
  value: string,
  expectedKind: PrdEntityKind,
  draftIds: Map<string, { kind: PrdEntityKind; id: string }>,
  previous: Map<PrdEntityKind, Set<string>>,
): string {
  const inDraft = draftIds.get(value);
  if (inDraft !== undefined) {
    if (inDraft.kind !== expectedKind) {
      throw new ProposalRecordError(
        "cross_kind_reference",
        `reference ${value} has kind ${inDraft.kind}, not ${expectedKind}`,
      );
    }
    return inDraft.id;
  }
  if (previous.get(expectedKind)?.has(value) === true) return value;
  if ([...previous.values()].some((ids) => ids.has(value))) {
    throw new ProposalRecordError(
      "cross_kind_reference",
      `reference ${value} exists but is not a ${expectedKind}`,
    );
  }
  throw new ProposalRecordError(
    "dangling_reference",
    `dangling reference ${value} resolves to neither a draft key nor a known ${expectedKind}`,
  );
}

function resolveReferenceSet(
  values: readonly string[],
  expectedKind: PrdEntityKind,
  draftIds: Map<string, { kind: PrdEntityKind; id: string }>,
  previous: Map<PrdEntityKind, Set<string>>,
): string[] {
  return canonicalStringSet(
    values.map((value) => resolveReference(value, expectedKind, draftIds, previous)),
  );
}

export function createPrdProposalRecord(input: CreatePrdProposalInput): {
  readonly record: PrdProposalRecord;
  readonly lineage: PrdEntityLineageRecord[];
} {
  const validation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate("prd-proposal-draft", input.draft);
  if (!validation.valid) {
    throw new ProposalRecordError(
      "invalid_draft",
      `draft failed schema validation: ${validation.errors
        .map((error) => `${error.instancePath}: ${error.message}`)
        .join("; ")}`,
    );
  }
  const draft = input.draft;
  if (
    draft.intent.digest !== input.session.intent_digest ||
    intentDigestOf(draft.intent.text) !== input.session.intent_digest
  ) {
    throw new ProposalRecordError(
      "intent_mismatch",
      "draft intent does not match the session intent",
    );
  }

  // --- identity: mint new ids, verify and reuse continued ids --------------
  const entities = draftEntities(draft);
  const seenKeys = new Set<string>();
  for (const entity of entities) {
    if (seenKeys.has(entity.draft_key)) {
      throw new ProposalRecordError(
        "duplicate_draft_key",
        `draft_key must be unique within one proposal call: ${entity.draft_key}`,
      );
    }
    seenKeys.add(entity.draft_key);
  }
  const previous = previousEntityIndex(input.previous_proposal);
  const claimed = new Set<string>();
  const draftIds = new Map<string, { kind: PrdEntityKind; id: string }>();
  for (const entity of entities) {
    let id: string;
    if (entity.lineage.kind === "continues") {
      const previousId = entity.lineage.previous_entity_id;
      if (previous.get(entity.kind)?.has(previousId) !== true) {
        if ([...previous.values()].some((ids) => ids.has(previousId))) {
          throw new ProposalRecordError(
            "lineage_kind_mismatch",
            `continues lineage kind mismatch: ${entity.kind} cannot continue ${previousId}`,
          );
        }
        throw new ProposalRecordError(
          "unknown_lineage",
          `continues lineage references unknown previous entity ${previousId}`,
        );
      }
      if (claimed.has(previousId)) {
        throw new ProposalRecordError(
          "duplicate_lineage_claim",
          `previous entity ${previousId} is claimed more than once in this draft`,
        );
      }
      claimed.add(previousId);
      id = previousId;
    } else {
      id = domainRecordId({
        domain_tag: `prd_${entity.kind}`,
        id_prefix: ENTITY_ID_PREFIX[entity.kind] ?? "prd-entity",
        protocol_version: PROTOCOL_1_1_VERSION,
        canonical_input: {
          session_id: input.session.session_id,
          proposal_revision: input.revision,
          draft_key: entity.draft_key,
        },
      });
    }
    for (const binding of entity.proposed_source_bindings) {
      verifySourceBinding(binding, input);
    }
    draftIds.set(entity.draft_key, { kind: entity.kind, id });
  }

  // --- canonical content -----------------------------------------------------
  const bindingsOf = (entity: DraftEntityRef): PrdSourceBinding[] =>
    canonicalBindings(entity.proposed_source_bindings);
  const byKey = (key: string): DraftEntityRef => {
    const entity = entities.find((candidate) => candidate.draft_key === key);
    if (entity === undefined) {
      throw new ProposalRecordError("invalid_draft", `missing draft entity ${key}`);
    }
    return entity;
  };

  const content: PrdProposal = {
    schema_version: PRD_PROPOSAL_SCHEMA_VERSION,
    intent: {
      text: input.session.intent_text,
      digest: input.session.intent_digest,
    },
    problem_statement: normalizeText(draft.problem_statement),
    goals: byId(
      draft.goals.map((entity) => ({
        id: draftIds.get(entity.draft_key)?.id ?? "",
        statement: normalizeText(entity.statement),
        source_bindings: bindingsOf(byKey(entity.draft_key)),
      })),
    ),
    non_goals: byId(
      draft.non_goals.map((entity) => ({
        id: draftIds.get(entity.draft_key)?.id ?? "",
        statement: normalizeText(entity.statement),
        source_bindings: bindingsOf(byKey(entity.draft_key)),
      })),
    ),
    actors: byId(
      draft.actors.map((entity) => ({
        id: draftIds.get(entity.draft_key)?.id ?? "",
        name: normalizeText(entity.name),
        description: normalizeText(entity.description),
        source_bindings: bindingsOf(byKey(entity.draft_key)),
      })),
    ),
    scenarios: byId(
      draft.scenarios.map((entity) => ({
        id: draftIds.get(entity.draft_key)?.id ?? "",
        actor_id: resolveReference(entity.actor_id, "actor", draftIds, previous),
        precondition: normalizeText(entity.precondition),
        action: normalizeText(entity.action),
        observable_outcome: normalizeText(entity.observable_outcome),
        scenario_kind: entity.scenario_kind,
        source_bindings: bindingsOf(byKey(entity.draft_key)),
      })),
    ),
    requirements: byId(
      draft.requirements.map((entity) => ({
        id: draftIds.get(entity.draft_key)?.id ?? "",
        statement: normalizeText(entity.statement),
        priority: entity.priority,
        change_kind: entity.change_kind,
        scenario_ids: resolveReferenceSet(entity.scenario_ids, "scenario", draftIds, previous),
        acceptance_criterion_ids: resolveReferenceSet(
          entity.acceptance_criterion_ids,
          "acceptance_criterion",
          draftIds,
          previous,
        ),
        source_bindings: bindingsOf(byKey(entity.draft_key)),
      })),
    ),
    constraints: byId(
      draft.constraints.map((entity) => ({
        id: draftIds.get(entity.draft_key)?.id ?? "",
        statement: normalizeText(entity.statement),
        category: entity.category,
        verification_intent: normalizeText(entity.verification_intent),
        source_bindings: bindingsOf(byKey(entity.draft_key)),
      })),
    ),
    acceptance_criteria: byCriterionId(
      draft.acceptance_criteria.map((entity) => {
        const requirementId = resolveReference(
          entity.requirement_id,
          "requirement",
          draftIds,
          previous,
        );
        const testFirstExample = normalizeOptionalText(entity.test_first_example);
        const recomputed = criterionSemanticDigest({
          requirement_id: requirementId,
          precondition: entity.precondition,
          action: entity.action,
          observable_outcome: entity.observable_outcome,
          verification_intent: entity.verification_intent,
          ...(testFirstExample === undefined ? {} : { test_first_example: testFirstExample }),
          scenario_kind: entity.scenario_kind,
        });
        if (
          entity.criterion_semantic_digest !== undefined &&
          entity.criterion_semantic_digest !== recomputed
        ) {
          throw new ProposalRecordError(
            "digest_mismatch",
            `adapter-carried criterion semantic digest for ${entity.draft_key} does not match the Coordinator recomputation`,
          );
        }
        return {
          criterion_id: draftIds.get(entity.draft_key)?.id ?? "",
          requirement_id: requirementId,
          precondition: normalizeText(entity.precondition),
          action: normalizeText(entity.action),
          observable_outcome: normalizeText(entity.observable_outcome),
          verification_intent: normalizeText(entity.verification_intent),
          ...(testFirstExample === undefined ? {} : { test_first_example: testFirstExample }),
          scenario_kind: entity.scenario_kind,
          criterion_semantic_digest: recomputed,
          source_bindings: bindingsOf(byKey(entity.draft_key)),
        };
      }),
    ),
    assumptions: byId(
      draft.assumptions.map((entity) => ({
        id: draftIds.get(entity.draft_key)?.id ?? "",
        statement: normalizeText(entity.statement),
        source_bindings: bindingsOf(byKey(entity.draft_key)),
      })),
    ),
    dependencies: byId(
      draft.dependencies.map((entity) => ({
        id: draftIds.get(entity.draft_key)?.id ?? "",
        dependency_kind: entity.dependency_kind,
        description: normalizeText(entity.description),
        required_by_ids: resolveReferenceSet(
          entity.required_by_ids,
          "requirement",
          draftIds,
          previous,
        ),
        source_bindings: bindingsOf(byKey(entity.draft_key)),
      })),
    ),
    risks: byId(
      draft.risks.map((entity) => ({
        id: draftIds.get(entity.draft_key)?.id ?? "",
        category: entity.category,
        description: normalizeText(entity.description),
        likelihood: entity.likelihood,
        impact: entity.impact,
        mitigation: normalizeText(entity.mitigation),
        source_bindings: bindingsOf(byKey(entity.draft_key)),
      })),
    ),
    open_questions: byId(
      draft.open_questions.map((entity) => ({
        id: draftIds.get(entity.draft_key)?.id ?? "",
        question: normalizeText(entity.question),
        blocking: entity.blocking,
        owner: normalizeText(entity.owner),
        source_bindings: bindingsOf(byKey(entity.draft_key)),
      })),
    ),
    glossary: byId(
      draft.glossary.map((entity) => ({
        id: draftIds.get(entity.draft_key)?.id ?? "",
        term: normalizeText(entity.term),
        definition: normalizeText(entity.definition),
        source_bindings: bindingsOf(byKey(entity.draft_key)),
      })),
    ),
    context_source_refs: canonicalStringSet([...draft.context_source_refs]),
  };
  const proposalContentDigest = prdProposalContentDigest(content);
  const answersDigest = contentDigest(
    canonicalStringSet(input.answers.map((answer) => answer.record_digest)),
  );

  const record = sealRecordEnvelope({
    protocol_version: PROTOCOL_1_1_VERSION,
    record_kind: "prd_proposal" as const,
    proposal_id: domainRecordId({
      domain_tag: "prd_proposal",
      id_prefix: "prd-proposal",
      protocol_version: PROTOCOL_1_1_VERSION,
      canonical_input: { session_id: input.session.session_id },
    }),
    session_id: input.session.session_id,
    revision: input.revision,
    status: "proposed" as const,
    input_binding: {
      session_digest: input.session.record_digest,
      proposal_context_bundle_digest: input.proposal_context_bundle.content_digest,
      answers_digest: answersDigest,
      adapter_profile_digest: input.adapter_profile_digest,
      prompt_version_digest: input.prompt_version_digest,
      producer_identity: input.producer_identity,
      invocation_id: input.invocation_id,
      conversation_id: input.conversation_id,
      evidence_locator: input.evidence_locator,
    },
    content,
    content_digest: proposalContentDigest,
    ...(input.previous_proposal === undefined
      ? {}
      : { supersedes_digest: input.previous_proposal.record_digest }),
  });

  // --- lineage index ---------------------------------------------------------
  const lineageKindOf = (entity: DraftEntityRef): PrdLineageKind => entity.lineage.kind;
  const lineageEntities: { kind: PrdEntityKind; id: string; entity: DraftEntityRef }[] = [
    ...content.goals.map((entity) => ({ kind: "goal" as const, id: entity.id })),
    ...content.non_goals.map((entity) => ({ kind: "non_goal" as const, id: entity.id })),
    ...content.actors.map((entity) => ({ kind: "actor" as const, id: entity.id })),
    ...content.scenarios.map((entity) => ({ kind: "scenario" as const, id: entity.id })),
    ...content.requirements.map((entity) => ({ kind: "requirement" as const, id: entity.id })),
    ...content.constraints.map((entity) => ({ kind: "constraint" as const, id: entity.id })),
    ...content.acceptance_criteria.map((entity) => ({
      kind: "acceptance_criterion" as const,
      id: entity.criterion_id,
    })),
    ...content.assumptions.map((entity) => ({ kind: "assumption" as const, id: entity.id })),
    ...content.dependencies.map((entity) => ({ kind: "dependency" as const, id: entity.id })),
    ...content.risks.map((entity) => ({ kind: "risk" as const, id: entity.id })),
    ...content.open_questions.map((entity) => ({ kind: "open_question" as const, id: entity.id })),
    ...content.glossary.map((entity) => ({ kind: "glossary_term" as const, id: entity.id })),
  ].map((entry) => {
    const draftEntity = entities.find(
      (candidate) => draftIds.get(candidate.draft_key)?.id === entry.id,
    );
    if (draftEntity === undefined) {
      throw new ProposalRecordError("invalid_draft", `no draft entity for id ${entry.id}`);
    }
    return { ...entry, entity: draftEntity };
  });
  const lineage: PrdEntityLineageRecord[] = lineageEntities.map((entry) =>
    sealRecordEnvelope({
      protocol_version: PROTOCOL_1_1_VERSION,
      record_kind: "prd_entity_lineage" as const,
      lineage_record_id: domainRecordId({
        domain_tag: "prd_entity_lineage",
        id_prefix: "prd-lineage",
        protocol_version: PROTOCOL_1_1_VERSION,
        canonical_input: {
          proposal_content_digest: proposalContentDigest,
          entity_kind: entry.kind,
          entity_id: entry.id,
        },
      }),
      session_id: input.session.session_id,
      proposal_content_digest: proposalContentDigest,
      entity_kind: entry.kind,
      entity_id: entry.id,
      lineage_kind: lineageKindOf(entry.entity),
      source_bindings: bindingsOf(entry.entity),
      ...(input.previous_proposal === undefined
        ? {}
        : { previous_proposal_content_digest: input.previous_proposal.content_digest }),
    }),
  );

  return { record, lineage };
}

/** Versioned rule set digest is owned by the gates module; re-exported for the report. */
export function prdValidationRuleSetDigestValue(): string {
  return contentDigest(PRD_VALIDATION_RULE_SET);
}

export function createPrdValidationReportRecord(input: {
  readonly session_id: string;
  readonly proposal_digest: string;
  readonly results: readonly PrdValidationRuleResult[];
  readonly blocking_question_ids: readonly string[];
}): PrdValidationReportRecord {
  const ruleSetDigest = prdValidationRuleSetDigestValue();
  const results = [...input.results].sort((left, right) =>
    left.rule_id < right.rule_id ? -1 : left.rule_id > right.rule_id ? 1 : 0,
  );
  const passed =
    results.every((result) => result.passed) &&
    results.every((result) => result.findings.every((finding) => finding.severity !== "critical"));
  const blockingQuestionIds = canonicalStringSet([...input.blocking_question_ids]);
  const reportDigest = contentDigest({
    session_id: input.session_id,
    proposal_digest: input.proposal_digest,
    rule_set_digest: ruleSetDigest,
    passed,
    results,
    blocking_question_ids: blockingQuestionIds,
  });
  return sealRecordEnvelope({
    protocol_version: PROTOCOL_1_1_VERSION,
    record_kind: "prd_validation_report" as const,
    validation_report_id: domainRecordId({
      domain_tag: "prd_validation_report",
      id_prefix: "prd-validation-report",
      protocol_version: PROTOCOL_1_1_VERSION,
      canonical_input: { report_digest: reportDigest },
    }),
    session_id: input.session_id,
    proposal_digest: input.proposal_digest,
    rule_set_digest: ruleSetDigest,
    passed,
    results,
    blocking_question_ids: blockingQuestionIds,
    report_digest: reportDigest,
  });
}
