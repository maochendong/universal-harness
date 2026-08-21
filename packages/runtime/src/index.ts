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
  ExecutionBindingError,
  assertExecutionBindingCompatible,
  type ExecutionBinding,
  type ExecutionBindingErrorKind,
  type OrchestrationExecutor,
} from "./orchestration/execution-binding.js";
export {
  governanceMigrationReasons,
  projectLegacySnapshotTruth,
  type GovernanceMigrationInput,
  type LegacySnapshotTruthProjection,
} from "./compatibility/governance-records.js";
export {
  assessOpenIterationMigration,
  buildOpenIterationMigrationRecord,
  type OpenIterationMigrationAssessment,
  type OpenIterationMigrationInput,
  type OpenIterationMigrationRecord,
} from "./compatibility/open-iteration.js";

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
  FINDING_ACTIONABILITIES,
  FINDING_SEVERITIES,
  FindingGovernanceError,
  buildFindingGovernanceMetadata,
  findingGovernanceForAudit,
  readFindingGovernance,
  type FindingActionability,
  type FindingGovernanceInput,
  type FindingGovernanceMetadata,
  type FindingSeverity,
} from "./finding/governance.js";
export { projectFindingGroups, type FindingGroupProjection } from "./finding/groups.js";
export {
  FINDING_GROUP_ACTIONS,
  FindingGroupError,
  resolveFindingGroup,
  type FindingGroupAction,
  type FindingGroupDependencies,
  type FindingGroupErrorKind,
  type ResolveFindingGroupInput,
  type ResolvedFindingGroup,
} from "./finding/group-service.js";
export {
  planFindingDecay,
  type FindingDecayInput,
  type FindingDecayPlan,
} from "./finding/decay.js";
export {
  buildFindingLifecycleEvent,
  findingLifecycleEventType,
  findingLifecyclePayload,
  type FindingLifecycleAction,
  type FindingLifecyclePayloadInput,
} from "./finding/lifecycle.js";
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
  liveBlockerMessages,
  reconcileLiveBlockers,
  type LiveBlocker,
  type LiveBlockerKind,
  type LiveBlockerReconciliationInput,
} from "./workflow/blockers.js";
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
  InMemoryDagCheckpointStore,
  type DagApprovalNotice,
  type DagCheckpointEntry,
  type DagCheckpointStore,
  type DagEngineEvent,
  type DagNodeContext,
  type DagNodeResult,
  type DagNodeRunner,
  type DagProducedBinding,
  type DagRunnerRegistry,
} from "./workflow/dag.js";
export {
  DAG_ENGINE_ERROR_KINDS,
  DagEngineError,
  WorkflowDagEngine,
  type DagEngineErrorKind,
  type DagRunOutcome,
  type DagRunRequest,
  type WorkflowDagEngineConfig,
} from "./workflow/dag-engine.js";
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
  readPendingApprovalRequests,
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
  type ExecutionKind,
  type IntentShape,
  type ModeSelection,
  type ModeSelectionInput,
} from "./planning/mode-selector.js";
export {
  assessImpactCoverage,
  type ImpactCoverageAssessment,
  type ImpactCoverageEntry,
  type ImpactCoverageInput,
  type ImpactCoverageLayer,
  type PathForecast,
} from "./planning/impact-coverage.js";
export {
  GOVERNANCE_RISKS,
  deriveEffectiveRisk,
  type EffectiveRiskInput,
  type GovernanceRisk,
  type PathScope,
  type TaskComplexity,
} from "./planning/effective-risk.js";
export {
  TASK_RISKS,
  hasIndependentValue,
  independentValueSignature,
  type TaskAcceptanceCriterion,
  type TaskAcceptanceAssertion,
  type TaskBudget,
  type TaskRisk,
  type TaskSpecification,
} from "./planning/task.js";
export {
  MAX_AGENT_DAG_TASKS,
  assessTaskSize,
  assertAgentPlanSize,
  type TaskSizeAssessment,
} from "./planning/task-sizing.js";
export { deriveActualRunChanges, type ActualRunChanges } from "./planning/scope-drift.js";
export {
  FORBIDDEN_PROPOSAL_KEYS,
  PLANNING_ERROR_KINDS,
  PlanningError,
  validatePlanProposal,
  type PlannerConstraints,
  type PlanningErrorKind,
} from "./planning/validator.js";
export {
  LEGACY_PLAN_TASKS_DEPRECATION,
  PLAN_PROPOSAL_ALLOCATION_ISSUE_CODES,
  createInMemoryPlanProposalPort,
  createLegacyPlanTasksAdapter,
  mapLegacyTaskSpecifications,
  materializePlanTasks,
  parsePlanProposalOutput,
  validatePlanProposalAllocation,
  type PlanProposalAllocationIssue,
  type PlanProposalInput,
  type PlanProposalPort,
  type PlanProposalResult,
} from "./planning/plan-proposal.js";
export {
  PLAN_PROPOSAL_PROMPT_CONTRACT,
  PLAN_PROPOSAL_PROMPT_PORT_ID,
  PLAN_PROPOSAL_PROMPT_REGISTRATION,
  PLAN_PROPOSAL_PROMPT_VERSION,
} from "./planning/plan-prompt-contract.js";
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
  TaskBundleBindingError,
  assertTaskBundleBinding,
  readContextBundleManifest,
  type ExpectedTaskBundleBinding,
  type TaskBundleBindingErrorKind,
} from "./context/task-bundles.js";
export {
  enrichContextBundle,
  enrichmentBundleView,
  type ContextEnrichmentOutcome,
} from "./context/enrichment.js";
export {
  TDD_PATCH_ISSUE_CODES,
  attestWriteSet,
  canonicalTestPatch,
  classifyPath,
  validateTestAuthoringPatch,
  type CanonicalPatch,
  type PatchFile,
  type TddPatchIssue,
  type TddPathScope,
} from "./tdd/patch.js";
export {
  createInMemoryWorkspacePort,
  type IsolatedWorkspacePort,
  type TddWorkspacePurpose,
  type WorkspaceHandle,
} from "./tdd/workspace.js";
export { createGitWorktreeWorkspacePort } from "./tdd/git-workspace.js";
export {
  TddGrantError,
  assertTddPhaseGrantCurrent,
  issueTddPhaseGrant,
  tddPhaseWriteScopes,
  type TddPhaseGrantState,
} from "./tdd/phase-grants.js";
export {
  TDD_CYCLE_STATES,
  TDD_EVIDENCE_ISSUE_CODES,
  acceptBaselineEvidence,
  acceptGreenEvidence,
  acceptRedEvidence,
  buildTddCycleRecord,
  createTddCycle,
  freezeTestPatch,
  matchFailureOracle,
  type StructuredTestResult,
  type TddCycleState,
  type TddCycleView,
  type TddEvidenceIssue,
} from "./tdd/controller.js";
export {
  computeTaskTddVerdict,
  type TaskTddVerdict,
  type TaskTddVerdictInput,
} from "./tdd/verdict.js";
export {
  DOWNSTREAM_ARTIFACT_KINDS,
  INVALIDATION_MATRIX,
  UPSTREAM_DRIFT_KINDS,
  planDownstreamInvalidation,
  survivesDrift,
  type DownstreamArtifactKind,
  type DownstreamInvalidation,
  type InvalidationResumePhase,
  type UpstreamDriftKind,
} from "./orchestration/invalidation.js";
export { narrateIteration } from "./snapshot/narrative.js";
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
  bindCapabilityGrantAuthorization,
  createCapabilityGrantSpec,
  grantDenialReason,
  issueGrant,
  narrowGrant,
  type CapabilityGrant,
  type CapabilityGrantBinding,
  type CapabilityGrantRecord,
  type CapabilityGrantSpec,
  type GrantBudget,
  type GrantNarrowing,
  type GrantRequest,
  type GrantedTool,
} from "./policy/capability-grant.js";
export {
  authorizationSpecDigest,
  buildExecutionAuthorizationRecord,
  type ExecutionAuthorizationRecord,
  type ExecutionAuthorizationSpec,
} from "./policy/execution-authorization.js";
export {
  ExecutionPreflightError,
  prepareExecutionPreflight,
  type ExecutionPreflightErrorKind,
  type ExecutionPreflightInput,
  type PreparedExecutionPreflight,
} from "./policy/execution-preflight.js";
export { resolveLlmJudgeMandatory, type LlmJudgeMandatoryResolution } from "./policy/llm-judge.js";
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
  isVerifiedHarnessProjection,
  managedProjectionPath,
  planManagedWrite,
  writeManagedOutput,
  type ManagedOutput,
  type ManagedWriteAction,
  type ManagedWriteOptions,
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
  type CoverageCount,
  type EvaluationCoverage,
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
  type SnapshotTaskVerdict,
} from "./snapshot/builder.js";
export {
  buildTaskVerdict,
  type BuildTaskVerdictInput,
  type TaskVerdictAssertion,
  type TaskVerdictEvidenceInput,
  type TaskVerdictGateInput,
  type TaskVerdictRecord,
} from "./evaluation/task-verdict.js";
export { projectRunFact, projectTaskVerdict } from "./evaluation/outcome-projection.js";
export {
  SNAPSHOT_ANCHOR_ERROR_KINDS,
  SnapshotAnchorError,
  anchorSnapshot,
  explainCodeDigestMismatch,
  hashCommitCode,
  hashWorktreeCode,
  resolveSnapshotSourceCommit,
  type AnchorSnapshotInput,
  type AnchorSnapshotResult,
  type SnapshotAnchorCorrection,
  type SnapshotAnchorErrorKind,
} from "./snapshot/anchor.js";
export {
  locateSnapshotLedgerCommit,
  projectSnapshotCommitRefs,
  type SnapshotCommitRefs,
} from "./snapshot/commit-projection.js";
export {
  GRAPH_EDIT_ERROR_KINDS,
  GraphEditError,
  approveGraphEdge,
  buildSemanticIndexInput,
  graphEdgeId,
  proposeGraphEdge,
  proposeSemanticImpactEdges,
  type ApprovedGraphEdge,
  type GraphEditDependencies,
  type ProposedGraphEdge,
  type SemanticGraphEdgeProposal,
  type SemanticGraphProposalBatch,
  type SemanticSuggestionMetadata,
} from "./graph/edits.js";
export {
  backfillEvaluationGraph,
  type EvaluationBackfillDependencies,
  type EvaluationBackfillResult,
} from "./evaluation/backfill.js";
export {
  reconcileProjectGraph,
  type GraphReconcileDependencies,
  type GraphReconcileResult,
} from "./graph/reconcile.js";
export {
  FINDING_ACTIONS,
  ORCHESTRATION_ERROR_KINDS,
  OrchestrationError,
  abortIteration,
  createDefaultEvaluationPort,
  createDefaultGateSuite,
  createDirectExecutor,
  createGenericInterpreter,
  driveOpenOperation,
  findOpenWorkflowOperation,
  previewImpactSet,
  provenQualityTaskIds,
  readLatestExecutionPlan,
  readLatestSnapshot,
  resolveApproval,
  resolveFinding,
  resumeIteration,
  runIteration,
  type AbortIterationInput,
  type AbortedIteration,
  type ClarificationOffer,
  type EvaluationPort,
  type EvaluationPortInput,
  type EvaluationPortResult,
  type FindingAction,
  type IntentInterpreter,
  type InterpretedIntent,
  type OrchestrationErrorKind,
  type OrchestrationOutcome,
  type OrchestratorDependencies,
  type PhaseProgressEvent,
  type PlanTasksPort,
  type ResolveFindingInput,
  type ResolvedFinding,
  type RunIterationInput,
  type TaskEnvelopeScopePort,
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
export {
  MODULE_STATUS_MAPPINGS,
  deriveModuleDomainStatus,
  isModuleStatusCapability,
  type ModuleStatusCapabilityId,
} from "./orchestration/module-status.js";
export {
  createDesignContribution,
  phaseDesign,
  type DesignContributionOptions,
} from "./orchestration/contributors/design-contributor.js";
export {
  moduleContributionsForProfile,
  projectProfileModuleStatus,
  resolveProfileModules,
  type ModuleStatusEvidence,
  type ProfileModuleResolution,
  type ProfileModuleStatusEntry,
} from "./orchestration/profile-modules.js";
export {
  FileEventStream,
  EventStreamError,
  type EventStreamErrorKind,
  type EventStreamItem,
  type EventStreamPage,
  type EventStreamPort,
  type EventStreamQuery,
  type FileEventStreamOptions,
} from "./observability/event-stream.js";
export {
  FileLiveSpool,
  LiveSpoolError,
  readLiveObservations,
  type LiveSpoolOptions,
  type ObservationInput,
} from "./observability/live-spool.js";
export {
  ObservationPublisher,
  gateCompletionObservationKey,
  type ObservationPublisherOptions,
  type ObservationPublisherPort,
  type ObservationSink,
  type ObservationStreamIdentity,
  type RunOutputOptions,
} from "./observability/publisher.js";
export { projectActiveRun, type ActiveRunProjection } from "./observability/active-run.js";

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

export * from "./model/index.js";

export const workspacePackageName = "@universal-harness-internal/runtime" as const;
