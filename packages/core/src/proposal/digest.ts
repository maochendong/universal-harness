import { contentDigest } from "../identity/digest.js";
import type { PrdProposal, PrdScenarioKind } from "../schema/proposal.js";

/**
 * Criterion semantic digest (intent-to-prd design 6.5): derived from the
 * business fields of an acceptance criterion only — `requirement_id`,
 * `precondition`, `action`, `observable_outcome`, `verification_intent`, the
 * normalized `test_first_example` and `scenario_kind`. The criterion id,
 * source bindings, timestamps and the digest field itself never participate,
 * so a pure source-binding revision keeps the digest stable while any
 * business-semantics change rotates it (and with it the downstream
 * criterion_assertion identity).
 */
export interface CriterionSemanticInput {
  readonly requirement_id: string;
  readonly precondition: string;
  readonly action: string;
  readonly observable_outcome: string;
  readonly verification_intent: string;
  readonly test_first_example?: string;
  readonly scenario_kind: PrdScenarioKind;
}

/** NFC, unified newlines, trimmed; an empty example canonicalizes to null. */
function normalizeSemanticText(value: string): string {
  return value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
}

function normalizeExample(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = normalizeSemanticText(value);
  return normalized.length === 0 ? null : normalized;
}

export function criterionSemanticDigest(criterion: CriterionSemanticInput): string {
  return contentDigest({
    requirement_id: criterion.requirement_id,
    precondition: normalizeSemanticText(criterion.precondition),
    action: normalizeSemanticText(criterion.action),
    observable_outcome: normalizeSemanticText(criterion.observable_outcome),
    verification_intent: normalizeSemanticText(criterion.verification_intent),
    test_first_example: normalizeExample(criterion.test_first_example),
    scenario_kind: criterion.scenario_kind,
  });
}

/**
 * The proposal content digest. The Coordinator stores content in canonical
 * form already (sorted collections, deduplicated reference sets), so the
 * digest is a plain canonical-JSON hash over the content object.
 */
export function prdProposalContentDigest(content: PrdProposal): string {
  return contentDigest(content);
}
