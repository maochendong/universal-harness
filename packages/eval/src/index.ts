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

export {
  FEEDBACK_ERROR_KINDS,
  FINDING_EXTENSION_KEY,
  FINDING_ORIGINS,
  FeedbackError,
  acceptFinding,
  buildFindingRecord,
  closeFinding,
  findingEdgeRecords,
  findingNodeRecord,
  readFindingSubject,
  supersedeFinding,
  type FeedbackDerivationContext,
  type FeedbackErrorKind,
  type FindingOrigin,
  type FindingSpec,
  type FindingSubject,
} from "./feedback/finding.js";
export {
  HUMAN_REVIEW_CONFIDENCE,
  RCA_EXTENSION_KEY,
  ROOT_CAUSE_CATEGORIES,
  analyzeRootCause,
  diagnosisEdgeRecord,
  readRootCauseContent,
  type FailureSignal,
  type RootCauseCategory,
  type RootCauseContent,
  type RootCauseSpec,
} from "./feedback/rca.js";
export {
  DELIVERY_PHASES,
  OWNING_NODE_TYPES,
  OWNER_PHASE,
  TARGET_LAYERS,
  assertWriteAllowed,
  ownerPhaseForLayer,
  routeRevisionTask,
  type DeliveryPhase,
  type RepairRouting,
  type RevisionTaskRequest,
  type TargetLayer,
} from "./feedback/router.js";
export {
  IMPROVEMENT_EXTENSION_KEY,
  IMPROVEMENT_TARGET_KINDS,
  buildImprovementCandidate,
  improvementEdgeRecord,
  readImprovementContent,
  type ImprovementCandidateContent,
  type ImprovementCandidateSpec,
  type ImprovementTargetKind,
} from "./feedback/improvement.js";
export {
  promoteImprovementCandidate,
  type PromotionInput,
  type PromotionOutcome,
} from "./feedback/promotion.js";

export const workspacePackageName = "@universal-harness-internal/eval" as const;
