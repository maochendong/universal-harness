import { RUN_OUTCOMES, contentDigest } from "@universal-harness-internal/core";
import type { AgentRunOutcome } from "@universal-harness-internal/plugin-sdk";

/**
 * EvaluationCase (design 16.1, plan Task 20). A case pins the acceptable
 * terminal outcomes for one run subject, the per-dimension pass thresholds
 * and which dimensions are mandatory. The case digest covers the normalized
 * definition, so Evidence binding the case digest is invalidated by any
 * change to expectations, thresholds or mandatory dimensions (design 15.3).
 */

export const EVALUATION_DIMENSIONS = [
  "outcome",
  "safety",
  "trajectory",
  "correct_failure",
  "efficiency",
] as const;

export type EvaluationDimension = (typeof EVALUATION_DIMENSIONS)[number];

export const EVALUATION_ERROR_KINDS = ["invalid_case", "invalid_report"] as const;

export type EvaluationErrorKind = (typeof EVALUATION_ERROR_KINDS)[number];

export class EvaluationError extends Error {
  readonly kind: EvaluationErrorKind;

  constructor(kind: EvaluationErrorKind, message: string) {
    super(message);
    this.name = "EvaluationError";
    this.kind = kind;
  }
}

/**
 * Default thresholds. P0/P1 dimensions are all-or-nothing; efficiency is
 * advisory until a project policy sets a real threshold.
 */
export const DEFAULT_THRESHOLDS: Readonly<Record<EvaluationDimension, number>> = {
  outcome: 1,
  safety: 1,
  trajectory: 1,
  correct_failure: 1,
  efficiency: 0,
};

/** P0 dimensions gate by default; P1/P2 must be opted in as mandatory. */
export const DEFAULT_MANDATORY: readonly EvaluationDimension[] = ["outcome", "safety"];

export interface EvaluationCaseSpec {
  readonly case_id: string;
  /** Subject the case evaluates, e.g. the task or run identifier. */
  readonly subject_id: string;
  /** Terminal outcomes the run may legitimately end in. */
  readonly expected_outcomes: readonly AgentRunOutcome[];
  readonly mandatory?: readonly EvaluationDimension[];
  /** Per-dimension overrides on top of {@link DEFAULT_THRESHOLDS}. */
  readonly thresholds?: Partial<Readonly<Record<EvaluationDimension, number>>>;
}

export interface EvaluationCase {
  readonly case_id: string;
  readonly subject_id: string;
  readonly expected_outcomes: readonly AgentRunOutcome[];
  readonly mandatory: readonly EvaluationDimension[];
  readonly thresholds: Readonly<Record<EvaluationDimension, number>>;
  readonly digest: string;
}

const CASE_ID_PATTERN = /^case_[A-Za-z0-9_-]{1,150}$/u;

const SUBJECT_ID_PATTERN = /^[a-z][a-z0-9-]*_[A-Za-z0-9_-]{1,150}$/u;

function assertIdentifier(kind: string, pattern: RegExp, value: string): void {
  if (!pattern.test(value)) {
    throw new EvaluationError("invalid_case", `${kind} ${value} must match ${pattern.source}`);
  }
}

/**
 * Normalize and seal a case definition. Structural problems throw a typed
 * `invalid_case` error; the returned case is immutable and content-digested.
 */
export function defineEvaluationCase(spec: EvaluationCaseSpec): EvaluationCase {
  assertIdentifier("case id", CASE_ID_PATTERN, spec.case_id);
  assertIdentifier("subject id", SUBJECT_ID_PATTERN, spec.subject_id);
  if (spec.expected_outcomes.length === 0) {
    throw new EvaluationError("invalid_case", "a case must declare at least one expected outcome");
  }
  const outcomes = [...new Set(spec.expected_outcomes)];
  for (const outcome of outcomes) {
    if (!RUN_OUTCOMES.includes(outcome)) {
      throw new EvaluationError("invalid_case", `unknown expected outcome ${outcome}`);
    }
  }
  const mandatory = [...new Set(spec.mandatory ?? DEFAULT_MANDATORY)];
  for (const dimension of mandatory) {
    if (!EVALUATION_DIMENSIONS.includes(dimension)) {
      throw new EvaluationError("invalid_case", `unknown mandatory dimension ${dimension}`);
    }
  }
  const thresholds: Record<EvaluationDimension, number> = { ...DEFAULT_THRESHOLDS };
  for (const dimension of EVALUATION_DIMENSIONS) {
    const override = spec.thresholds?.[dimension];
    if (override === undefined) continue;
    if (!Number.isFinite(override) || override < 0 || override > 1) {
      throw new EvaluationError(
        "invalid_case",
        `threshold for ${dimension} must be a number between 0 and 1`,
      );
    }
    thresholds[dimension] = override;
  }
  const normalized = {
    case_id: spec.case_id,
    subject_id: spec.subject_id,
    expected_outcomes: outcomes,
    mandatory,
    thresholds,
  };
  return { ...normalized, digest: contentDigest(normalized) };
}
