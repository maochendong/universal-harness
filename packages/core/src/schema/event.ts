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
