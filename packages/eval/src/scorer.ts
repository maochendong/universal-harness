import type {
  AgentRunResult,
  AgentTrajectoryVisibility,
} from "@universal-harness-internal/plugin-sdk";

import type { EvaluationCase, EvaluationDimension } from "./case.js";

/**
 * Scorer contract (design 16.1). Deterministic scorers judge what the
 * Harness itself observed: outcome, state change, tool calls, paths,
 * approval, evidence and termination. Semantic scorers are optional, must
 * return a reason and a confidence, and can never satisfy a mandatory
 * threshold unless project policy explicitly allows it.
 */

/** One observed step of a run, visible only to `full`-visibility adapters. */
export interface TrajectoryStep {
  readonly tool: string;
  /** False when the call was malformed or schema-invalid. */
  readonly valid: boolean;
  /** True when the call repeated an earlier call with the same fingerprint. */
  readonly repeated: boolean;
}

/** Everything a scorer may inspect for one run. */
export interface RunEvaluationInput {
  readonly run: AgentRunResult;
  readonly visibility: AgentTrajectoryVisibility;
  /** Envelope loop-policy ceilings the run executed under. */
  readonly budget: {
    readonly max_steps: number;
    readonly max_tokens: number;
    readonly max_duration_ms: number;
  };
  /** Step-level trajectory; only a `full`-visibility adapter can supply it. */
  readonly trajectory?: readonly TrajectoryStep[];
}

export interface DimensionScore {
  readonly dimension: EvaluationDimension;
  /** False when the adapter visibility cannot supply the required fields. */
  readonly available: boolean;
  /** 0..1, or null when unavailable. */
  readonly score: number | null;
  readonly threshold: number;
  readonly passed: boolean;
  readonly mandatory: boolean;
  readonly deterministic: boolean;
  /** Scorer name; deterministic scorers use `deterministic/<dimension>`. */
  readonly scorer: string;
  readonly reason: string;
  /** Semantic scorers must report confidence; deterministic scorers null. */
  readonly confidence: number | null;
}

export interface ScorerContext {
  readonly case: EvaluationCase;
  readonly input: RunEvaluationInput;
}

export interface Scorer {
  readonly name: string;
  readonly dimension: EvaluationDimension;
  readonly deterministic: boolean;
  score(context: ScorerContext): DimensionScore;
}

/** Round to 1e-6 so reports and digests are free of float noise. */
export function clampScore(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1e6) / 1e6;
}

export interface ScoreFields {
  readonly available: boolean;
  readonly score: number | null;
  readonly reason: string;
  readonly scorer?: string;
  readonly deterministic?: boolean;
  readonly confidence?: number;
}

/**
 * Build a dimension score with threshold and mandatory resolution applied.
 * An unavailable dimension fails only when it is mandatory; an advisory
 * dimension without data is disclosed but never blocks.
 */
export function dimensionScore(
  context: ScorerContext,
  dimension: EvaluationDimension,
  fields: ScoreFields,
): DimensionScore {
  const mandatory = context.case.mandatory.includes(dimension);
  const threshold = context.case.thresholds[dimension];
  const passed = fields.available && fields.score !== null && fields.score >= threshold;
  return {
    dimension,
    available: fields.available,
    score: fields.score,
    threshold,
    passed: fields.available ? passed : !mandatory,
    mandatory,
    deterministic: fields.deterministic ?? true,
    scorer: fields.scorer ?? `deterministic/${dimension}`,
    reason: fields.reason,
    confidence: fields.confidence ?? null,
  };
}
