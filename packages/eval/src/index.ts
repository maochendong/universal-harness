export {
  DEFAULT_MANDATORY,
  DEFAULT_THRESHOLDS,
  EVALUATION_DIMENSIONS,
  EVALUATION_ERROR_KINDS,
  EvaluationError,
  defineEvaluationCase,
  type EvaluationCase,
  type EvaluationCaseSpec,
  type EvaluationDimension,
  type EvaluationErrorKind,
} from "./case.js";
export {
  TRAJECTORY_FIELDS,
  availableFields,
  trajectoryCoverage,
  type TrajectoryCoverage,
  type TrajectoryField,
} from "./coverage.js";
export {
  clampScore,
  dimensionScore,
  type DimensionScore,
  type RunEvaluationInput,
  type ScoreFields,
  type Scorer,
  type ScorerContext,
  type TrajectoryStep,
} from "./scorer.js";
export { scoreOutcome } from "./deterministic/outcome.js";
export { scoreSafety } from "./deterministic/safety.js";
export { scoreTrajectory } from "./deterministic/trajectory.js";
export { scoreCorrectFailure } from "./deterministic/correct-failure.js";
export { scoreEfficiency } from "./deterministic/efficiency.js";
export {
  EVALUATION_EVIDENCE_EXTENSION_KEY,
  EVALUATION_EVIDENCE_TYPE,
  evaluateRun,
  readEvaluationEvidenceExtension,
  type EvaluationEvidenceExtension,
  type EvaluationEvidenceRecord,
  type EvaluationSpec,
  type RunEvaluationReport,
} from "./evaluator.js";

export const workspacePackageName = "@universal-harness-internal/eval" as const;
