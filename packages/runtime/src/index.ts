import {
  commitAdoption,
  prepareAdoption,
  type AdoptCommitOutcome,
  type AdoptCommitRequest,
  type AdoptPreviewOutcome,
  type AdoptPreviewRequest,
} from "./bootstrap/adopt-project.js";
import {
  createNewProject,
  type NewProjectOutcome,
  type NewProjectRequest,
} from "./bootstrap/new-project.js";
import type { BootstrapDependencies, BootstrapResult } from "./bootstrap/staging.js";

export {
  STACK_PROFILES,
  extractReferences,
  scanWorktree,
  type FileClassification,
  type ScanConflict,
  type ScanResult,
  type ScannedComponent,
  type ScannedFile,
  type StackProfile,
  type UnknownItem,
} from "./bootstrap/scanner.js";
export {
  discardStagedDocuments,
  readStagedDocument,
  stagedPreviewDigest,
  writeStagedDocuments,
  type BootstrapDependencies,
  type BootstrapError,
  type BootstrapErrorKind,
  type BootstrapIdKind,
  type BootstrapResult,
} from "./bootstrap/staging.js";
export {
  artifactPathForNode,
  edgeRecord,
  iterationNodeRecord,
  lifecycleEvent,
  scannedEdgeId,
  scannedNodeRecord,
  type RecordContext,
} from "./bootstrap/records.js";
export {
  createNewProject,
  type NewProjectOutcome,
  type NewProjectRequest,
} from "./bootstrap/new-project.js";
export {
  commitAdoption,
  prepareAdoption,
  projectNameForPath,
  type AdoptCommitOutcome,
  type AdoptCommitRequest,
  type AdoptPreviewOutcome,
  type AdoptPreviewRequest,
  type AdoptionApproval,
  type AdoptionPreview,
  type SemanticInputEntry,
} from "./bootstrap/adopt-project.js";
export {
  CHECKPOINT_BOUNDARIES,
  CheckpointError,
  buildCheckpointArtifacts,
  latestValidCheckpoint,
  listValidCheckpoints,
  type CheckpointArtifacts,
  type CheckpointBoundary,
  type CheckpointErrorKind,
  type CheckpointRecord,
  type CommittedCheckpoint,
} from "./workflow/checkpoint.js";
export {
  WorkflowEngine,
  WorkflowError,
  buildRunInterruptedRecord,
  buildRunStartedRecord,
  nextEventSequence,
  operationRecordArtifactPath,
  readCurrentOperation,
  readOperationHistory,
  readRunStreams,
  runRecordArtifactPath,
  streamTerminalRecord,
  type AbortOperationInput,
  type BlockOperationInput,
  type BlockOutcome,
  type CommitCheckpointInput,
  type OperationSnapshot,
  type RunStream,
  type StartOperationInput,
  type WorkflowDependencies,
  type WorkflowErrorKind,
  type WorkflowIdKind,
} from "./workflow/operation.js";
export { resumeWorkflowOperation, type ResumeOutcome, type ResumedRun } from "./workflow/resume.js";
export {
  captureRequirements,
  type AcceptanceCriterionInput,
  type CaptureContext,
  type CaptureIdKind,
  type CaptureOutcome,
  type CapturedAcceptanceCriterion,
  type CapturedConstraint,
  type CapturedRequirement,
  type ClarificationQuestion,
  type ConstraintInput,
  type IntentInput,
  type RequirementInput,
  type RequirementProposal,
} from "./requirements/capture.js";
export {
  REQUIREMENTS_EXTENSION_KEY,
  baselineDocument,
  baselineDocumentArtifactPath,
  baselineNodeArtifactPath,
  buildBaselineRecords,
  commitRequirementBaseline,
  requirementBaselineDigest,
  type BaselineCommitBinding,
  type BaselineContext,
  type BaselineIdKind,
  type BaselineRecords,
  type CommittedRequirementBaseline,
} from "./requirements/baseline.js";
export {
  APPROVAL_EXTENSION_KEY,
  APPROVAL_RISKS,
  ApprovalError,
  approvalDecisionArtifact,
  approvalDecisionArtifactPath,
  approvalRequestArtifact,
  approvalRequestArtifactPath,
  buildApprovalDecision,
  buildApprovalRequest,
  previewDigestMatches,
  proposedByOf,
  readApprovalDecisions,
  readApprovalRequests,
  renderApprovalPreview,
  supersededRequestId,
  type ApprovalDecision,
  type ApprovalDecisionRecord,
  type ApprovalErrorKind,
  type ApprovalRequestRecord,
  type ApprovalRequestSpec,
  type ApprovalRisk,
} from "./approval/request.js";
export {
  APPROVAL_REQUIRED_CATEGORY,
  approvalRequiredOutcome,
  parseApprovalDecision,
  promptForApprovalDecision,
  resumeCommandFor,
  type ApprovalPrompter,
  type ApprovalRequiredOutcome,
} from "./approval/interaction.js";
export {
  bindingDrift,
  reissueRequestSpec,
  type ApprovalBindingSnapshot,
} from "./approval/invalidation.js";
export {
  ApprovalService,
  type ApprovalDependencies,
  type ApprovalIdKind,
  type AwaitDecisionOutcome,
  type RequestApprovalInput,
  type ResolveDecisionInput,
} from "./approval/service.js";
export {
  PLAN_EXTENSION_KEY,
  generateExecutionPlan,
  readExecutionPlanContent,
  type ExecutionPlanContent,
  type ExecutionPlanRecords,
  type PlanContext,
  type PlanGenerationInput,
  type PlanSharedContext,
} from "./planning/execution-plan.js";
export {
  EXECUTION_MODES,
  ModeSelectionError,
  selectExecutionMode,
  type ExecutionMode,
  type IntentShape,
  type ModeSelection,
  type ModeSelectionInput,
} from "./planning/mode-selector.js";
export {
  TASK_RISKS,
  hasIndependentValue,
  independentValueSignature,
  type TaskAcceptanceCriterion,
  type TaskBudget,
  type TaskRisk,
  type TaskSpecification,
} from "./planning/task.js";
export {
  FORBIDDEN_PROPOSAL_KEYS,
  PLANNING_ERROR_KINDS,
  PlanningError,
  validatePlanProposal,
  type PlannerConstraints,
  type PlanningErrorKind,
} from "./planning/validator.js";
export {
  ABORT_REASONS,
  InvalidStateTransition,
  RECOVERABLE_BLOCK_REASONS,
  UNRECOVERABLE_ABORT_REASONS,
  abortTargetFor,
  aggregateIterationState,
  assertIterationTransition,
  assertOperationTransition,
  blockTargetFor,
  canTransitionIteration,
  canTransitionOperation,
  isResumableOperationState,
  isTerminalIterationState,
  isTerminalOperationState,
  iterationStateForOperationState,
  resumeTargetFor,
  type AbortReason,
  type BlockedOperationTarget,
  type RecoverableBlockReason,
  type ResumableOperationState,
} from "./workflow/state-machine.js";
export {
  EXTERNAL_ACTION_STATUSES,
  WorkingStateError,
  applyWorkingStateProposal,
  isWorkingState,
  workingStateDigest,
  type BudgetUse,
  type ConfirmedFact,
  type ExternalActionIntent,
  type ExternalActionStatus,
  type RejectedHypothesis,
  type WorkingState,
  type WorkingStateErrorKind,
  type WorkingStateProposal,
  type WorkingStateWriter,
} from "./workflow/working-state.js";

/**
 * Runtime orchestration service (design section 11.1). The CLI shell injects
 * this facade behind its typed port; orchestration logic lives here, never in
 * command handlers. M1 Task 9 covers project bootstrap only: `new`, and the
 * adopt scan/preview plus its approval-bound baseline commit.
 */
export interface RuntimeService {
  newProject(request: NewProjectRequest): Promise<BootstrapResult<NewProjectOutcome>>;
  prepareAdoption(request: AdoptPreviewRequest): Promise<BootstrapResult<AdoptPreviewOutcome>>;
  commitAdoption(request: AdoptCommitRequest): Promise<BootstrapResult<AdoptCommitOutcome>>;
}

export function createRuntimeService(deps: BootstrapDependencies): RuntimeService {
  return {
    newProject: (request) => createNewProject(request, deps),
    prepareAdoption: (request) => prepareAdoption(request, deps),
    commitAdoption: (request) => commitAdoption(request, deps),
  };
}

export const workspacePackageName = "@universal-harness-internal/runtime" as const;
