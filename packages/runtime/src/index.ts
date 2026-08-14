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
  readStagedAdoptionPreview,
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
  CONTEXT_EXTENSION_KEY,
  compileContextBundle,
  type BundleBindings,
  type CompileContextInput,
  type CompiledContextBundle,
  type ContextBundleManifest,
  type ContextBundleRecord,
  type ContextCandidate,
  type ContextSourceEntry,
  type ExcludedSource,
  type Freshness,
  type SourceExclusion,
} from "./context/compiler.js";
export {
  TIER_WEIGHTS,
  allocateTierBudgets,
  estimateTokens,
  type TierAllocation,
} from "./context/budget.js";
export {
  NO_COMPRESSION,
  TRUNCATE_COMPRESSOR_ID,
  assertProtectedFieldsPresent,
  createTruncateCompressor,
  type CompressionResult,
  type Compressor,
} from "./context/compression.js";
export {
  freshnessOf,
  invalidateContextBundle,
  isContextBundleStale,
  stalenessReasons,
  type CurrentContextState,
} from "./context/freshness.js";
export {
  CONTEXT_ERROR_KINDS,
  ContextError,
  DEFAULT_NEIGHBORHOOD_DEPTH,
  KNOWLEDGE_LAYERS,
  MAX_NEIGHBORHOOD_DEPTH,
  SOURCE_TIERS,
  knowledgeLayerFor,
  selectTaskNeighborhood,
  type ContextErrorKind,
  type KnowledgeLayer,
  type KnowledgeLayerTag,
  type NeighborhoodSelection,
  type SourceTier,
} from "./context/selector.js";
export {
  ACTION_ORIGINS,
  ACTOR_KINDS,
  CONTROL_LEVELS,
  ESCALATION_ACTION_KINDS,
  POLICY_ACTION_KINDS,
  POLICY_ERROR_KINDS,
  POLICY_RISKS,
  PolicyError,
  TRAJECTORY_VISIBILITIES,
  actionDigest,
  normalizeAction,
  riskRank,
  type ActionOrigin,
  type ActorKind,
  type AdapterControlProfile,
  type ControlLevel,
  type PolicyAction,
  type PolicyActionKind,
  type PolicyErrorKind,
  type PolicyRisk,
  type TrajectoryVisibility,
} from "./policy/action.js";
export {
  DECISION_OUTCOMES,
  POLICY_LAYERS,
  buildDecision,
  policyNumber,
  policyString,
  policyStrings,
  type DecisionOutcome,
  type DecisionParts,
  type EffectivePolicy,
  type EffectivePolicyField,
  type PolicyDecision,
  type PolicyFieldInput,
  type PolicyLayer,
  type PolicyLayerInput,
  type PolicyLayerRef,
  type PolicyMergeOperator,
} from "./policy/decision.js";
export {
  CONTROL_STRENGTH_ORDERS,
  decideAction,
  mergePolicyLayers,
  type MergedPolicy,
} from "./policy/evaluator.js";
export {
  grantDenialReason,
  issueGrant,
  narrowGrant,
  type CapabilityGrant,
  type GrantBudget,
  type GrantNarrowing,
  type GrantRequest,
  type GrantedTool,
} from "./policy/capability-grant.js";
export {
  assertWithinRepositoryBoundary,
  isPathWithinScopes,
  normalizeRepoRelativePath,
  tryNormalizeRepoRelativePath,
} from "./policy/path-boundary.js";
export {
  RECONCILIATION_MODES,
  RETRY_CLASSES,
  SIDE_EFFECT_CLASSES,
  TOOL_ERROR_KINDS,
  TOOL_NAME_PATTERN,
  ToolError,
  compareToolVersions,
  normalizeToolDefinition,
  resourceMatchesPatterns,
  type ReconciliationMode,
  type RetryClass,
  type SideEffectClass,
  type ToolDefinition,
  type ToolErrorKind,
} from "./tools/definition.js";
export {
  ToolRegistry,
  type RegisteredTool,
  type ToolHandler,
  type ToolHandlerInput,
  type ToolInvocationSummary,
} from "./tools/registry.js";
export {
  ActionIntentJournal,
  isActionIntentRecord,
  requestDigest,
  type ActionIntentRecord,
  type OpenIntentInput,
} from "./tools/action-intent.js";
export {
  invokeTool,
  type ToolInvocationContext,
  type ToolInvocationEvidence,
  type ToolInvocationRequest,
} from "./tools/invocation.js";
export {
  PROBE_OUTCOMES,
  RECONCILIATION_DECISIONS,
  reconcileIntent,
  reconcileJournal,
  type ProbeOutcome,
  type ReconciliationDecision,
  type ReconciliationDecisionKind,
  type ReconciliationProbe,
} from "./tools/reconciliation.js";
export {
  REDACTED_SECRET,
  SECRET_ERROR_KINDS,
  SECRET_NAME_PATTERN,
  SECRET_REFERENCE_KEY,
  SecretError,
  assertNoSecretValues,
  findSecretReferences,
  isSecretReference,
  redactSecretValues,
  resolveSecretParameters,
  type ResolvedSecrets,
  type SecretErrorKind,
} from "./secrets/environment-reference.js";
export {
  BUDGET_CEILING_MODES,
  GENERIC_PACK_LOOP_DEFAULTS,
  LOOP_ERROR_KINDS,
  LoopError,
  assertLoopPolicy,
  isLoopPolicy,
  resolveLoopPolicy,
  type BudgetCeilingMode,
  type LoopErrorKind,
  type LoopPolicy,
  type LoopPolicyOverrides,
  type LoopPolicyRequest,
  type RepeatDetectionPolicy,
  type TerminationPolicy,
} from "./loop/policy.js";
export {
  RepeatDetector,
  actionFingerprint,
  type NormalizedToolCall,
  type RepeatDetectionResult,
  type RepeatObservation,
} from "./loop/repeat-detector.js";
export {
  LOOP_RUN_PHASES,
  LoopPhaseMachine,
  adapterFailureDecision,
  budgetCeilingDecision,
  cancellationDecision,
  completionDecision,
  repeatDetectionDecision,
  timeoutDecision,
  type LoopRunPhase,
  type PartialOutput,
  type RunOutcome,
  type TerminalDecision,
  type TerminationReason,
} from "./loop/outcome.js";
export {
  EXTERNAL_SIDE_EFFECT_POLICIES,
  STALE_INPUT_BEHAVIORS,
  buildTaskEnvelope,
  isTaskEnvelope,
  type ExternalSideEffectPolicy,
  type StaleInputBehavior,
  type TaskEnvelope,
  type TaskEnvelopeSpec,
} from "./loop/task-envelope.js";
export {
  runManagedLoop,
  type LoopProgressEvent,
  type LoopStepInput,
  type LoopStepRemaining,
  type LoopToolCall,
  type ManagedLoopDependencies,
  type ManagedLoopResult,
  type ModelStep,
  type ModelStepOutcome,
  type UsageMeter,
} from "./loop/controller.js";
export {
  GATE_ERROR_KINDS,
  GATE_LAYERS,
  GATE_PHASE,
  GateError,
  normalizeGateDefinition,
  runGate,
  type GateDefinition,
  type GateErrorKind,
  type GateLayer,
  type GateOutcome,
  type GateRunOptions,
} from "./gates/provider.js";
export {
  GATE_EVIDENCE_EXTENSION_KEY,
  GATE_EVIDENCE_TYPE,
  buildGateEvidence,
  evidenceBindingsOf,
  readGateEvidenceExtension,
  type EvidenceBindings,
  type GateEvidenceExtension,
  type GateEvidenceRecord,
  type GateEvidenceSpec,
} from "./gates/evidence.js";
export {
  bindingsStalenessReasons,
  evidenceFreshnessOf,
  evidenceStalenessReasons,
  findingClosableBy,
  isEvidenceStale,
  type CurrentEvidenceState,
} from "./gates/freshness.js";
export {
  completionBlockers,
  orderGates,
  runGateSuite,
  type GateRunResult,
  type GateSuiteOutcome,
  type GateSuiteSpec,
} from "./gates/runner.js";
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
export {
  MANAGED_PROJECTION_DIRECTORY,
  PROJECTION_ERROR_KINDS,
  ProjectionError,
  managedProjectionPath,
  planManagedWrite,
  writeManagedOutput,
  type ManagedOutput,
  type ManagedWriteAction,
  type ManagedWritePlan,
  type ManagedWriteResult,
  type ProjectionErrorKind,
} from "./projection/managed-output.js";
export {
  buildProviderInstructionMirror,
  providerInstructionPath,
  type ProviderInstructionMirror,
  type ProviderInstructionSpec,
} from "./projection/provider-instruction.js";
export {
  PROJECTION_DRIFT_STATUSES,
  detectProjectionDrift,
  detectProjectionDrifts,
  type ProjectionDrift,
  type ProjectionDriftStatus,
  type ProjectionTarget,
} from "./projection/drift.js";
export {
  PACKS_PROJECT_DIRECTORY,
  PACKS_UPGRADES_DIRECTORY,
  PACKS_UPSTREAM_DIRECTORY,
  PACK_ERROR_KINDS,
  PackError,
  installUpstreamPack,
  packStorageKey,
  packUpgradeRelativePath,
  parseProjectPackOverride,
  projectOverrideRelativePath,
  projectPackOverrideDigest,
  readProjectPackOverride,
  readUpstreamPack,
  resolvePackPolicyLayers,
  serializeProjectPackOverride,
  upstreamPackRelativePath,
  writeProjectPackOverride,
  type OverrideWriteOutcome,
  type PackErrorKind,
  type PackInstallOutcome,
  type ProjectPackOverride,
  type ResolvedPackPolicyLayers,
} from "./packs/resolver.js";
export {
  assertLockMatchesPack,
  lockEntryForPack,
  lockedPackEntry,
  upsertLockedPack,
} from "./packs/lockfile.js";
export {
  commitTransactionalWrites,
  comparePackVersions,
  planPackMigration,
  runPackMigration,
  type PackMigrationOutcome,
  type PackMigrationRegistry,
  type PackMigrationStep,
  type TransactionalWrite,
} from "./packs/migration.js";
export {
  applyPackUpgrade,
  previewPackUpgrade,
  type PackGateChanges,
  type PackPolicyChange,
  type PackUpgradeInput,
  type PackUpgradeOutcome,
  type PackUpgradePreview,
  type PackUpgradeRecord,
} from "./packs/upgrade.js";
export {
  AUDIT_FINDING_KINDS,
  HIGH_RISK_IMPROVEMENT_LAYERS,
  auditGraph,
  type AuditFinding,
  type AuditFindingKind,
  type AuditGraph,
  type AuditReport,
} from "./audit/auditor.js";
export {
  DOCTOR_CATEGORIES,
  collectDoctorProbes,
  evaluateDoctorDiagnostics,
  type DoctorCategory,
  type DoctorDiagnostic,
  type DoctorProbes,
  type DoctorProjectProbes,
  type DoctorReport,
  type DoctorVerdict,
} from "./doctor/doctor.js";
export {
  collectProjectStatus,
  deriveProjectStatus,
  type DerivedStatus,
  type ProjectStatus,
  type StatusDerivationInput,
} from "./status/status.js";
export {
  SNAPSHOT_ERROR_KINDS,
  SNAPSHOT_STATUSES,
  SnapshotError,
  buildSnapshot,
  snapshotCompletionBlockers,
  type SnapshotErrorKind,
  type SnapshotEvidenceState,
  type SnapshotFindingState,
  type SnapshotImprovementState,
  type SnapshotInput,
  type SnapshotRecord,
  type SnapshotRunResult,
  type SnapshotStatus,
  type SnapshotTaskResult,
} from "./snapshot/builder.js";
export {
  ORCHESTRATION_ERROR_KINDS,
  OrchestrationError,
  abortIteration,
  createDefaultEvaluationPort,
  createDefaultGateSuite,
  createDirectExecutor,
  createGenericInterpreter,
  driveOpenOperation,
  findOpenWorkflowOperation,
  hashWorktreeCode,
  previewImpactSet,
  readLatestExecutionPlan,
  readLatestSnapshot,
  resolveApproval,
  resumeIteration,
  runIteration,
  type AbortIterationInput,
  type AbortedIteration,
  type EvaluationPort,
  type EvaluationPortInput,
  type EvaluationPortResult,
  type IntentInterpreter,
  type InterpretedIntent,
  type OrchestrationErrorKind,
  type OrchestrationExecutor,
  type OrchestrationOutcome,
  type OrchestratorDependencies,
  type RunIterationInput,
} from "./orchestration/orchestrator.js";
export {
  ORCHESTRATION_PHASES,
  PHASE_CHECKPOINT_BOUNDARY,
  PHASE_OPERATION_STATE,
  isOrchestrationPhase,
  nextPhase,
  phaseRank,
  type OrchestrationPhase,
} from "./orchestration/phases.js";
export {
  assertLifecycleOrder,
  phaseLifecycleEvents,
  type PhaseLifecycleDetails,
  type PhaseLifecycleEventSpec,
} from "./orchestration/lifecycle-events.js";

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
