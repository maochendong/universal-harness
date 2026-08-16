import {
  PROTOCOL_VERSION,
  contentDigest,
  validateSchema,
  type FeedbackRecord,
} from "@universal-harness-internal/core";
import type {
  AgentRunOutcome,
  AgentRunResult,
} from "@universal-harness-internal/plugin-sdk";

import {
  EVALUATION_DIMENSIONS,
  EvaluationError,
  type EvaluationCase,
  type EvaluationDimension,
} from "./case.js";
import { trajectoryCoverage, type TrajectoryCoverage } from "./coverage.js";
import { scoreCorrectFailure } from "./deterministic/correct-failure.js";
import { scoreEfficiency } from "./deterministic/efficiency.js";
import { scoreOutcome } from "./deterministic/outcome.js";
import { scoreSafety } from "./deterministic/safety.js";
import { scoreTrajectory } from "./deterministic/trajectory.js";
import type { DimensionScore, RunEvaluationInput, Scorer, ScorerContext } from "./scorer.js";

/**
 * Run evaluator (design 16.1, plan Task 20). Deterministic scorers always
 * run and decide every mandatory threshold; semantic scorers are optional,
 * must carry a reason and a confidence, and can never satisfy a mandatory
 * dimension unless project policy explicitly allows calibrated judges
 * (`allowSemanticForMandatory`). Every report discloses its trajectory
 * coverage, every mandatory threshold failure creates a proposed Finding
 * (acceptance 16), and the whole report is sealed in a schema-valid,
 * content-digested Evidence record.
 */

export const EVALUATION_EVIDENCE_TYPE = "evaluation_report" as const;

export const EVALUATION_EVIDENCE_EXTENSION_KEY = "harness.evaluation";

/** Deterministic scorers in fixed dimension order. */
const DETERMINISTIC_SCORERS: Readonly<
  Record<EvaluationDimension, (context: ScorerContext) => DimensionScore>
> = {
  outcome: scoreOutcome,
  safety: scoreSafety,
  trajectory: scoreTrajectory,
  correct_failure: scoreCorrectFailure,
  efficiency: scoreEfficiency,
};

/** Matches `EvidenceRecordSchema` in core; validated on build. */
export interface EvaluationEvidenceRecord {
  readonly protocol_version: string;
  readonly record_kind: "evidence";
  readonly evidence_id: string;
  readonly evidence_type: string;
  readonly subject_id: string;
  readonly digest: string;
  readonly provisional: boolean;
  readonly created_at: string;
  readonly extensions?: Record<string, unknown>;
}

export interface EvaluationEvidenceExtension {
  readonly case_id: string;
  readonly case_digest: string;
  readonly visibility: string;
  readonly coverage: TrajectoryCoverage;
  readonly dimensions: readonly DimensionScore[];
  readonly mandatory_failures: readonly EvaluationDimension[];
  readonly passed: boolean;
  readonly adapter_profile_digest?: string;
  readonly budget_observations?: AgentRunResult["budget_observations"];
}

export interface EvaluationSpec {
  readonly case: EvaluationCase;
  readonly input: RunEvaluationInput;
  readonly iterationId: string;
  /** ISO timestamp clock; fake in tests. */
  readonly clock: () => string;
  /** Optional semantic scorers; each must return a confidence. */
  readonly semanticScorers?: readonly Scorer[];
  /**
   * Policy escape hatch: allow a semantic score to satisfy a mandatory
   * dimension. Defaults to false -- a semantic score never gates (design 16.1).
   */
  readonly allowSemanticForMandatory?: boolean;
  /** Mark the produced evidence provisional (design 10.3 stale-input rule). */
  readonly provisional?: boolean;
}

export interface RunEvaluationReport {
  readonly case_id: string;
  readonly subject_id: string;
  readonly outcome: AgentRunOutcome;
  readonly dimensions: readonly DimensionScore[];
  readonly coverage: TrajectoryCoverage;
  readonly mandatory_failures: readonly EvaluationDimension[];
  /** True only when every mandatory dimension passed. */
  readonly passed: boolean;
  readonly evidence: EvaluationEvidenceRecord;
  /** One proposed Finding per failed mandatory dimension, in dimension order. */
  readonly findings: readonly FeedbackRecord[];
}

const FINDING_SUMMARY_LIMIT = 10_000;

function findingId(caseId: string, dimension: EvaluationDimension): string {
  return `finding_${caseId.slice(caseId.indexOf("_") + 1)}-${dimension}`;
}

function buildFinding(
  spec: EvaluationSpec,
  dimension: EvaluationDimension,
  score: DimensionScore,
): FeedbackRecord {
  const summary =
    `Mandatory evaluation dimension ${dimension} failed for case ${spec.case.case_id} ` +
    `(subject ${spec.case.subject_id}): ${score.reason}`.slice(0, FINDING_SUMMARY_LIMIT);
  const content = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "feedback",
    id: findingId(spec.case.case_id, dimension),
    type: "Finding",
    iteration_id: spec.iterationId,
    status: "proposed",
    summary,
    created_at: spec.clock(),
  };
  const record = { ...content, digest: contentDigest(content) };
  const validation = validateSchema("feedback", record);
  if (!validation.valid) {
    const detail = validation.errors
      .map((issue) => `${issue.instancePath}: ${issue.message}`)
      .join("; ");
    throw new EvaluationError("invalid_report", `invalid evaluation finding record: ${detail}`);
  }
  return record as unknown as FeedbackRecord;
}

function buildEvidence(
  spec: EvaluationSpec,
  extension: EvaluationEvidenceExtension,
): EvaluationEvidenceRecord {
  const record: EvaluationEvidenceRecord = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "evidence",
    evidence_id: `evidence_${spec.case.case_id.slice(spec.case.case_id.indexOf("_") + 1)}`,
    evidence_type: EVALUATION_EVIDENCE_TYPE,
    subject_id: spec.case.subject_id,
    digest: contentDigest({
      evidence_type: EVALUATION_EVIDENCE_TYPE,
      subject_id: spec.case.subject_id,
      extension,
    }),
    provisional: spec.provisional === true,
    created_at: spec.clock(),
    extensions: {
      [EVALUATION_EVIDENCE_EXTENSION_KEY]: extension,
    },
  };
  const validation = validateSchema("runtime", record);
  if (!validation.valid) {
    const detail = validation.errors
      .map((issue) => `${issue.instancePath}: ${issue.message}`)
      .join("; ");
    throw new EvaluationError("invalid_report", `invalid evaluation evidence record: ${detail}`);
  }
  return record;
}

function assertSemanticScore(score: DimensionScore): void {
  if (score.confidence === null || score.confidence < 0 || score.confidence > 1) {
    throw new EvaluationError(
      "invalid_report",
      `semantic scorer ${score.scorer} must return a confidence between 0 and 1`,
    );
  }
}

/**
 * Evaluate one run against one case. Deterministic scorers run for every
 * dimension in fixed order; semantic scorers append supplementary results.
 * A mandatory dimension fails when no eligible score meets its threshold,
 * where eligible means deterministic unless `allowSemanticForMandatory`
 * is set -- an unavailable mandatory dimension fails as well.
 */
export function evaluateRun(spec: EvaluationSpec): RunEvaluationReport {
  const context: ScorerContext = { case: spec.case, input: spec.input };
  const dimensions: DimensionScore[] = EVALUATION_DIMENSIONS.map((dimension) =>
    DETERMINISTIC_SCORERS[dimension](context),
  );
  for (const scorer of spec.semanticScorers ?? []) {
    if (scorer.deterministic) {
      throw new EvaluationError(
        "invalid_report",
        `scorer ${scorer.name} must not be registered as both semantic and deterministic`,
      );
    }
    const score = scorer.score(context);
    if (score.deterministic) {
      throw new EvaluationError(
        "invalid_report",
        `semantic scorer ${scorer.name} returned a result marked deterministic`,
      );
    }
    assertSemanticScore(score);
    dimensions.push(score);
  }

  const allowSemantic = spec.allowSemanticForMandatory === true;
  const mandatoryFailures = spec.case.mandatory.filter((dimension) => {
    return !dimensions.some((score) => {
      if (score.dimension !== dimension || !score.passed) return false;
      return score.deterministic || allowSemantic;
    });
  });

  const extension: EvaluationEvidenceExtension = {
    case_id: spec.case.case_id,
    case_digest: spec.case.digest,
    visibility: spec.input.visibility,
    coverage: trajectoryCoverage(spec.input.visibility),
    dimensions,
    mandatory_failures: mandatoryFailures,
    passed: mandatoryFailures.length === 0,
    ...(spec.input.adapter_profile_digest === undefined
      ? {}
      : { adapter_profile_digest: spec.input.adapter_profile_digest }),
    ...(spec.input.run.budget_observations === undefined
      ? {}
      : { budget_observations: spec.input.run.budget_observations }),
  };
  const findings = mandatoryFailures.map((dimension) => {
    const deciding = dimensions.find((score) => score.dimension === dimension);
    return buildFinding(
      spec,
      dimension,
      deciding ??
        ({
          dimension,
          available: false,
          score: null,
          threshold: spec.case.thresholds[dimension],
          passed: false,
          mandatory: true,
          deterministic: true,
          scorer: `deterministic/${dimension}`,
          reason: "no scorer produced a result for this dimension",
          confidence: null,
        } satisfies DimensionScore),
    );
  });
  return {
    case_id: spec.case.case_id,
    subject_id: spec.case.subject_id,
    outcome: spec.input.run.outcome,
    dimensions,
    coverage: extension.coverage,
    mandatory_failures: mandatoryFailures,
    passed: extension.passed,
    evidence: buildEvidence(spec, extension),
    findings,
  };
}

/** The evaluation extension payload of an evidence record, or undefined. */
export function readEvaluationEvidenceExtension(
  record: EvaluationEvidenceRecord,
): EvaluationEvidenceExtension | undefined {
  const extension = record.extensions?.[EVALUATION_EVIDENCE_EXTENSION_KEY];
  if (typeof extension !== "object" || extension === null) return undefined;
  return extension as EvaluationEvidenceExtension;
}
