import type {
  CollaborationConnectionRecord,
  CollaborationPermission,
  CollaborationProvider,
  CollaborationRecord,
  ControlRecord,
  IntegrationRecord,
  LeaseRecord,
  REMOTE_APPROVAL_DECISIONS,
  RemoteApprovalDecisionRecord,
} from "@universal-harness-internal/core";

import type { CollaborationFailure } from "./errors.js";

export type RemoteApprovalDecision = (typeof REMOTE_APPROVAL_DECISIONS)[number];

/**
 * The single external Interface for M3 remote collaboration. CLI, Dashboard
 * and the Local Kernel only ever talk to `CollaborationCoordinatorPort`; OAuth
 * differences, platform roles, Git CAS, fencing and SQLite rebuilds stay
 * behind it. Exactly three internal Adapter seams exist
 * (`PlatformIdentityPort`, `GitControlStorePort`, `CoordinatorProjectionPort`);
 * there are no provider-specific public Interfaces and no separate connection
 * store seam.
 */

export interface CollaborationSession {
  readonly principal_id: string;
  readonly client_instance_id: string;
}

interface CollaborationCommandBase {
  readonly command_id: string;
  readonly project_id: string;
}

export interface ConnectCommand extends CollaborationCommandBase {
  readonly kind: "connect";
  readonly canonical_remote: string;
  readonly target_ref: string;
  readonly coordinator_origin: string;
  readonly policy_digest: string;
}

export interface DisconnectCommand extends CollaborationCommandBase {
  readonly kind: "disconnect";
}

export interface AcquireLeaseCommand extends CollaborationCommandBase {
  readonly kind: "acquire_operation_lease";
  readonly operation_id: string;
}

export interface RenewLeaseCommand extends CollaborationCommandBase {
  readonly kind: "renew_operation_lease";
  readonly lease_id: string;
}

export interface ReleaseLeaseCommand extends CollaborationCommandBase {
  readonly kind: "release_operation_lease";
  readonly lease_id: string;
}

export interface PublishOperationCandidateCommand extends CollaborationCommandBase {
  readonly kind: "publish_operation_candidate";
  readonly operation_id: string;
  readonly candidate_commit: string;
}

export interface SubmitRemoteApprovalCommand extends CollaborationCommandBase {
  readonly kind: "submit_remote_approval";
  readonly request_id: string;
  readonly decision: RemoteApprovalDecision;
}

export interface PrepareIntegrationCommand extends CollaborationCommandBase {
  readonly kind: "prepare_integration";
  readonly operation_id: string;
}

export interface AcceptIntegrationCommand extends CollaborationCommandBase {
  readonly kind: "accept_integration";
  readonly integration_id: string;
  readonly expected_target_commit: string;
}

export interface SyncNowCommand extends CollaborationCommandBase {
  readonly kind: "sync_now";
}

export type CollaborationCommand =
  | ConnectCommand
  | DisconnectCommand
  | AcquireLeaseCommand
  | RenewLeaseCommand
  | ReleaseLeaseCommand
  | PublishOperationCandidateCommand
  | SubmitRemoteApprovalCommand
  | PrepareIntegrationCommand
  | AcceptIntegrationCommand
  | SyncNowCommand;

export interface ConnectionStatusQuery {
  readonly kind: "connection_status";
  readonly project_id: string;
}

export interface OperationsQuery {
  readonly kind: "operations";
  readonly project_id: string;
}

export interface ApprovalInboxQuery {
  readonly kind: "approval_inbox";
  readonly project_id: string;
}

export interface IntegrationConflictsQuery {
  readonly kind: "integration_conflicts";
  readonly project_id: string;
}

export type CollaborationQuery =
  ConnectionStatusQuery | OperationsQuery | ApprovalInboxQuery | IntegrationConflictsQuery;

export interface ConnectionStatusView {
  readonly kind: "connection_status";
  readonly project_id: string;
  readonly status: "active" | "disconnected" | "not_connected";
  readonly connection?: CollaborationConnectionRecord;
}

export interface OperationHeadView {
  readonly operation_id: string;
  readonly head_oid: string;
}

export interface OperationsView {
  readonly kind: "operations";
  readonly project_id: string;
  readonly operations: readonly OperationHeadView[];
}

export interface ApprovalInboxView {
  readonly kind: "approval_inbox";
  readonly project_id: string;
  readonly decisions: readonly RemoteApprovalDecisionRecord[];
}

export interface IntegrationConflictsView {
  readonly kind: "integration_conflicts";
  readonly project_id: string;
  readonly conflicts: readonly IntegrationRecord[];
}

export type CollaborationView =
  ConnectionStatusView | OperationsView | ApprovalInboxView | IntegrationConflictsView;

/**
 * Command outcomes are typed values. `replayed` marks an idempotent replay of
 * an already-applied command; `projection_rebuild_required` marks a command
 * whose authoritative Git append succeeded while the SQLite projection update
 * failed (Git stays authoritative; never blindly retried).
 */
export interface ConnectedOutcome {
  readonly status: "connected";
  readonly connection: CollaborationConnectionRecord;
  readonly replayed: boolean;
  readonly projection_rebuild_required?: boolean;
}

export interface DisconnectedOutcome {
  readonly status: "disconnected";
  readonly connection: CollaborationConnectionRecord;
  readonly replayed: boolean;
  readonly projection_rebuild_required?: boolean;
}

/** Successful acquire/renew/release; the LeaseRecord carries the state. */
export interface LeaseOutcome {
  readonly status: "lease";
  readonly lease: LeaseRecord;
  readonly replayed: boolean;
  readonly projection_rebuild_required?: boolean;
}

/** Successful candidate publish; `head_oid` is the new Operation Ref head. */
export interface PublishedOperationOutcome {
  readonly status: "published";
  readonly operation_id: string;
  readonly head_oid: string;
  readonly replayed: boolean;
}

export interface CollaborationFailedOutcome {
  readonly status: "failed";
  readonly failure: CollaborationFailure;
}

export type CollaborationOutcome =
  | ConnectedOutcome
  | DisconnectedOutcome
  | LeaseOutcome
  | PublishedOperationOutcome
  | CollaborationFailedOutcome;

export interface CollaborationCoordinatorPort {
  execute(
    command: CollaborationCommand,
    session: CollaborationSession,
  ): Promise<CollaborationOutcome>;
  query(query: CollaborationQuery, session: CollaborationSession): Promise<CollaborationView>;
}

// --- Internal Adapter seams -------------------------------------------------

export interface RemoteIdentity {
  readonly provider: CollaborationProvider;
  readonly host: string;
  readonly repository_id: string;
  readonly canonical_remote: string;
  readonly canonical_remote_digest: string;
}

export type RemoteIdentityResult =
  | { readonly status: "resolved"; readonly identity: RemoteIdentity }
  | { readonly status: "failed"; readonly failure: CollaborationFailure };

export interface OAuthRequest {
  readonly provider: CollaborationProvider;
  readonly host: string;
  readonly repository_id: string;
  readonly principal_id: string;
}

/**
 * Redacted Principal facts returned by a platform Adapter after OAuth. The
 * Coordinator assigns the deterministic `snapshot_id` and the Control Ref
 * chain fields; the access token and the raw platform response never leave
 * the Adapter.
 */
export interface PrincipalSnapshotFacts {
  readonly principal_id: string;
  readonly provider: CollaborationProvider;
  readonly host: string;
  readonly subject_id: string;
  readonly repository_id: string;
  readonly permission: CollaborationPermission;
  readonly observed_at: string;
  readonly expires_at: string;
  readonly source_response_digest: string;
}

export type PrincipalSnapshotDraftResult =
  | { readonly status: "authenticated"; readonly snapshot: PrincipalSnapshotFacts }
  | { readonly status: "failed"; readonly failure: CollaborationFailure };

export interface ControlRefProtectionRequest {
  readonly provider: CollaborationProvider;
  readonly host: string;
  readonly repository_id: string;
  readonly control_ref: string;
}

export type ProtectionResult =
  | { readonly status: "protected" }
  | { readonly status: "unprotected"; readonly failure: CollaborationFailure };

export interface PlatformIdentityPort {
  discover(remote: string): Promise<RemoteIdentityResult>;
  authenticate(input: OAuthRequest): Promise<PrincipalSnapshotDraftResult>;
  inspectControlRefProtection(input: ControlRefProtectionRequest): Promise<ProtectionResult>;
}

export interface ReadControlInput {
  readonly project_id: string;
  readonly control_ref: string;
  /**
   * Target ref the connection is (or will be) frozen to; required when the
   * caller needs Ledger state tied to a specific target, omitted by commands
   * that only inspect the Control Ref and latest connection.
   */
  readonly target_ref?: string;
}

/**
 * Authoritative Git state for one coordinator decision: the Control Ref head
 * and records plus the project Ledger's latest connection record. The
 * projection is never consulted for authoritative state.
 */
export interface ControlSnapshot {
  readonly control_head_oid?: string;
  readonly control_records: readonly ControlRecord[];
  readonly latest_connection?: CollaborationConnectionRecord;
}

export type ControlSnapshotResult =
  | { readonly status: "ok"; readonly snapshot: ControlSnapshot }
  | { readonly status: "failed"; readonly failure: CollaborationFailure };

export interface AppendControlInput {
  readonly project_id: string;
  readonly control_ref: string;
  readonly expected_head_oid?: string;
  readonly record: ControlRecord;
}

export type ControlAppendResult =
  | { readonly status: "appended"; readonly head_oid: string }
  | { readonly status: "failed"; readonly failure: CollaborationFailure };

export interface AppendProjectRecordInput {
  readonly project_id: string;
  readonly target_ref: string;
  readonly record: CollaborationConnectionRecord | IntegrationRecord;
}

export type ProjectRecordCommitResult =
  | { readonly status: "committed"; readonly commit: string }
  | { readonly status: "failed"; readonly failure: CollaborationFailure };

export interface ListOperationHeadsInput {
  readonly project_id: string;
}

export interface OperationHead {
  readonly operation_id: string;
  readonly head_oid: string;
}

export type OperationHeadsResult =
  | { readonly status: "ok"; readonly heads: readonly OperationHead[] }
  | { readonly status: "failed"; readonly failure: CollaborationFailure };

export interface OperationCasInput {
  readonly project_id: string;
  readonly operation_id: string;
  readonly expected_head_oid?: string;
  readonly candidate_commit: string;
  readonly fencing_token: number;
}

export type OperationCasResult =
  | { readonly status: "swapped"; readonly head_oid: string }
  | { readonly status: "failed"; readonly failure: CollaborationFailure };

export interface PrepareGitCandidateInput {
  readonly project_id: string;
  readonly operation_id: string;
  readonly target_ref: string;
}

export type PreparedGitCandidateResult =
  | { readonly status: "prepared"; readonly merge_commit: string }
  | { readonly status: "failed"; readonly failure: CollaborationFailure };

export interface TargetCasInput {
  readonly project_id: string;
  readonly target_ref: string;
  readonly expected_commit: string;
  readonly new_commit: string;
}

export type TargetCasResult =
  | { readonly status: "swapped"; readonly commit: string }
  | { readonly status: "failed"; readonly failure: CollaborationFailure };

export interface GitControlStorePort {
  /**
   * Read the authoritative coordinator state. The implementation owns
   * read-time verification (spec §17.3): Control Ref fast-forward ancestry,
   * Schema, sequence and digest are validated on every read, and any illegal
   * chain fails closed with `control_ref_invalid`.
   */
  readControl(input: ReadControlInput): Promise<ControlSnapshotResult>;
  appendControl(input: AppendControlInput): Promise<ControlAppendResult>;
  appendProjectRecord(input: AppendProjectRecordInput): Promise<ProjectRecordCommitResult>;
  listOperationHeads(input: ListOperationHeadsInput): Promise<OperationHeadsResult>;
  compareAndSwapOperation(input: OperationCasInput): Promise<OperationCasResult>;
  prepareCandidate(input: PrepareGitCandidateInput): Promise<PreparedGitCandidateResult>;
  compareAndSwapTarget(input: TargetCasInput): Promise<TargetCasResult>;
}

export type CollaborationProjectionRecord = CollaborationRecord;

export interface ProjectionRebuildInput {
  readonly project_id: string;
  readonly latest_connection?: CollaborationConnectionRecord;
  readonly control_records: readonly ControlRecord[];
}

/**
 * The SQLite projection is deletable and rebuildable and must never overwrite
 * Git. `rebuild`/`apply` signal failure by rejecting; the Coordinator maps
 * that to `projection_rebuild_required` on the authoritative outcome.
 */
export interface CoordinatorProjectionPort {
  rebuild(input: ProjectionRebuildInput): Promise<void>;
  apply(record: CollaborationProjectionRecord): Promise<void>;
  query(query: CollaborationQuery): Promise<CollaborationView>;
}
