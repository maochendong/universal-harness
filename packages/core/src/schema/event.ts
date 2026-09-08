import { Type, type Static } from "@sinclair/typebox";

import {
  DigestSchema,
  ExtensionsSchema,
  IdentifierSchema,
  TimestampSchema,
  enumerated,
  persistedRecordProperties,
  strictObject,
} from "./common.js";
import { APPROVAL_DECISIONS } from "./runtime.js";

export const EVENT_TYPES = [
  "OperationStarted",
  "PlanAccepted",
  "BeforeContextCompile",
  "ContextCompiled",
  "BeforeToolCall",
  "AfterToolCall",
  "ApprovalRequired",
  "CheckpointCommitted",
  "CheckpointInvalidated",
  "GateCompleted",
  "EvaluationCompleted",
  "FindingCreated",
  "FindingAccepted",
  "FindingClosed",
  "FindingSuperseded",
  "OperationCompleted",
  "TddCycleStarted",
  "TddBaselineAccepted",
  "TddTestPatchFrozen",
  "TddRedAccepted",
  "TddImplementationUnlocked",
  "TddGreenAccepted",
  "TddRefactorAccepted",
  "TddCycleCompleted",
  "TddCycleInvalidated",
  // Protocol 1.2 (M3): the only authoritative remote-collaboration events.
  // Lease and candidate Integration state never enter the project Ledger.
  "RemoteConnected",
  "RemoteDisconnected",
  "RemoteApprovalMaterialized",
  "IntegrationAccepted",
  // Protocol 1.3 (M4): the minimal scheduling lifecycle vocabulary. Events are
  // timeline facts only — they never substitute for TaskLeaseRecord or
  // WaveIntegrationRecord authoritative state.
  "TaskLeaseGranted",
  "TaskDispatched",
  "TaskIntegrationQueued",
  "TaskCandidateValidated",
  "TaskRetryScheduled",
  "WaveGateCompleted",
  "WaveIntegrated",
  "SchedulerRecovered",
  // Protocol 1.4 (transparency): the truthful approval-decision event. It is
  // emitted in the same transaction as the ApprovalDecision artifact it binds
  // and never carries a raw actor.
  "ApprovalDecided",
  // Protocol 1.4 (transparency, spec §9.3): announces one committed artifact
  // version that no other event can locate, emitted in the artifact's own
  // atomic commit. Navigation payload only — never the content.
  "ArtifactAvailable",
] as const;

/**
 * The exact six-field payload of an ApprovalDecided event (spec §5.1). The
 * decision_digest is the byte SHA-256 of the committed ApprovalDecision
 * artifact — the same digest the transaction manifest records — never a
 * recomputed semantic digest.
 */
export const ApprovalDecidedPayloadSchema = strictObject({
  request_id: IdentifierSchema,
  approval_id: IdentifierSchema,
  decision: enumerated(APPROVAL_DECISIONS),
  object_digest: DigestSchema,
  decision_digest: DigestSchema,
  decided_at: TimestampSchema,
});

export type ApprovalDecidedPayload = Static<typeof ApprovalDecidedPayloadSchema>;

/**
 * The fixed versioned-artifact kinds (spec §9.2). Registered here — not in the
 * runtime reader — so the ArtifactAvailable payload contract and the read API
 * can never drift apart.
 */
export const ARTIFACT_KINDS = [
  "approval_decision",
  "prd",
  "design_set",
  "plan",
  "context_manifest",
  "run_summary",
  "gate_result",
  "evidence",
  "evaluation",
  "snapshot",
  "tdd_artifact",
  "finding_group",
  "wave_result",
  "integration_record",
  "task_lease",
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * The exact three-field payload of an ArtifactAvailable event (spec §9.3):
 * which kind of artifact became readable, the byte SHA-256 of its root
 * record as recorded in the committing manifest, and a bounded human summary
 * (never raw content). Digest and summary alone must locate the version.
 */
export const ArtifactAvailablePayloadSchema = strictObject({
  artifact_kind: enumerated(ARTIFACT_KINDS),
  record_digest: DigestSchema,
  summary: Type.String({ maxLength: 200 }),
});

export type ArtifactAvailablePayload = Static<typeof ArtifactAvailablePayloadSchema>;

export const EventSchema = strictObject({
  ...persistedRecordProperties("event"),
  event_id: IdentifierSchema,
  event_type: enumerated(EVENT_TYPES),
  project_id: IdentifierSchema,
  iteration_id: IdentifierSchema,
  workflow_operation_id: IdentifierSchema,
  ledger_operation_id: IdentifierSchema,
  sequence: Type.Integer({ minimum: 1 }),
  timestamp: TimestampSchema,
  payload: Type.Record(Type.String(), Type.Unknown()),
  extensions: Type.Optional(ExtensionsSchema),
});

export type LifecycleEvent = Static<typeof EventSchema>;
