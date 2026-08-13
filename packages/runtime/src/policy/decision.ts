import { contentDigest } from "@universal-harness-internal/core";
import type { POLICY_MERGE_OPERATORS } from "@universal-harness-internal/core";

/**
 * Policy decision records and the effective-policy model (design 14.1). Every
 * decision is a pure, side-effect-free record with stable, ordered reasons
 * and the digests of every input layer: a denied action leaves its trace here
 * and produces no change anywhere else.
 */
export type PolicyMergeOperator = (typeof POLICY_MERGE_OPERATORS)[number];

export const POLICY_LAYERS = ["installation", "pack", "project"] as const;

export type PolicyLayer = (typeof POLICY_LAYERS)[number];

/** One policy field as declared by a Policy node (schema PolicyFieldSchema). */
export interface PolicyFieldInput {
  readonly path: string;
  readonly merge_operator: PolicyMergeOperator;
  readonly value: unknown;
}

/** One policy layer with the revision/digest it was read at. */
export interface PolicyLayerInput {
  readonly layer: PolicyLayer;
  readonly revision: number;
  readonly digest: string;
  readonly fields: readonly PolicyFieldInput[];
}

export interface PolicyLayerRef {
  readonly layer: PolicyLayer;
  readonly revision: number;
  readonly digest: string;
}

/** One merged field with its per-field merge reason and contributing layers. */
export interface EffectivePolicyField {
  readonly path: string;
  readonly merge_operator: PolicyMergeOperator;
  readonly value: unknown;
  readonly reason: string;
  readonly sources: readonly PolicyLayerRef[];
}

/**
 * Field-wise merged view of the Installation, Pack and Project policy layers.
 * Never a whole-object override: every field carries the merge operator the
 * schema declared for it and the reason its value won.
 */
export interface EffectivePolicy {
  readonly fields: readonly EffectivePolicyField[];
  readonly layers: readonly PolicyLayerRef[];
  readonly digest: string;
}

export const DECISION_OUTCOMES = ["allow", "deny", "requires_approval", "block"] as const;

export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export interface PolicyDecision {
  readonly outcome: DecisionOutcome;
  /** Stable, evaluation-ordered human-readable reasons. */
  readonly reasons: readonly string[];
  readonly action_digest: string;
  readonly effective_policy_digest: string;
  readonly layers: readonly PolicyLayerRef[];
  readonly field_traces: readonly EffectivePolicyField[];
  /** The approval digest that satisfied a requires-approval rule, if any. */
  readonly approval_digest?: string;
  readonly digest: string;
}

export interface DecisionParts {
  readonly outcome: DecisionOutcome;
  readonly reasons: readonly string[];
  readonly action_digest: string;
  readonly effective: EffectivePolicy;
  readonly approval_digest?: string;
}

/** Build the immutable, content-digested decision record. */
export function buildDecision(parts: DecisionParts): PolicyDecision {
  const projection = {
    outcome: parts.outcome,
    reasons: parts.reasons,
    action_digest: parts.action_digest,
    effective_policy_digest: parts.effective.digest,
    layers: parts.effective.layers,
    field_traces: parts.effective.fields,
    approval_digest: parts.approval_digest ?? null,
  };
  return {
    outcome: parts.outcome,
    reasons: parts.reasons,
    action_digest: parts.action_digest,
    effective_policy_digest: parts.effective.digest,
    layers: parts.effective.layers,
    field_traces: parts.effective.fields,
    ...(parts.approval_digest === undefined ? {} : { approval_digest: parts.approval_digest }),
    digest: contentDigest(projection),
  };
}

function fieldAt(effective: EffectivePolicy, path: string): EffectivePolicyField | undefined {
  return effective.fields.find((field) => field.path === path);
}

/** String-array value of a merged field, or undefined when undeclared. */
export function policyStrings(
  effective: EffectivePolicy,
  path: string,
): readonly string[] | undefined {
  const field = fieldAt(effective, path);
  if (field === undefined) return undefined;
  if (!Array.isArray(field.value) || field.value.some((entry) => typeof entry !== "string")) {
    return undefined;
  }
  return field.value as readonly string[];
}

/** Numeric value of a merged field, or undefined when undeclared. */
export function policyNumber(effective: EffectivePolicy, path: string): number | undefined {
  const field = fieldAt(effective, path);
  if (field === undefined || typeof field.value !== "number") return undefined;
  return field.value;
}

/** String value of a merged field, or undefined when undeclared. */
export function policyString(effective: EffectivePolicy, path: string): string | undefined {
  const field = fieldAt(effective, path);
  if (field === undefined || typeof field.value !== "string") return undefined;
  return field.value;
}
